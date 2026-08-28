import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  HookRegistry,
  IdentityManager,
  StorageManager,
  TaskBroker,
  VaultManager,
  loadPlugin,
} from "@p2p-hub/core";
import {
  createDocument,
  resolveRef,
  rootObject,
  type PBXDocument,
  type PBXReference,
} from "@p2p-hub/sdk";
import type { MutationResult, TasksPlugin } from "./index";
import {
  calculateCriticalPath,
  calculateProjectCapacity,
  type TaskLike,
  type TimeEntryLike,
} from "./computations";
import { COMPLETION_PROOF_DOMAIN_PREFIX } from "./types";

interface ContactsApi {
  addContact(input: {
    peerId: string;
    publicKeyHex: string;
    displayName: string;
  }): Promise<unknown>;
}

const pluginDir = path.resolve(__dirname, "..");
const contactsPluginDir = path.resolve(__dirname, "../../contacts");

const PEER_ID = "a".repeat(64);

function taskIds(doc: PBXDocument): string[] {
  const root = rootObject(doc)!;
  const refs = root.tasks as PBXReference[];
  return refs.map((ref) => resolveRef(doc, ref)!.$id);
}

function membersOf(doc: PBXDocument): string[] {
  const root = rootObject(doc)!;
  return (root.members as string[]) ?? [];
}

function lastTaskId(doc: PBXDocument): string {
  const root = rootObject(doc)!;
  const refs = root.tasks as PBXReference[];
  return resolveRef(doc, refs[refs.length - 1])!.$id;
}

/** The v1.1 task fields the tests assert on (PBXObject is loosely typed). */
interface TaskRecord {
  status?: string;
  dependencies?: string[];
  delegation?: { assignedTo: string; status: string; declinedReason?: string };
  completionProof?: { signedBy: string; timestamp: string; signatureHex: string };
}

function taskRecord(doc: PBXDocument, taskId: string): TaskRecord {
  return resolveRef(doc, { $ref: taskId }) as unknown as TaskRecord;
}

async function loadTasks(storageManager?: StorageManager): Promise<{
  tasks: TasksPlugin;
  storageManager: StorageManager;
  hooks: HookRegistry;
  broker: TaskBroker;
  dataDir: string;
}> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tasks-data-"));
  const manager = storageManager ?? new StorageManager(dataDir);
  const hooks = new HookRegistry();
  const broker = new TaskBroker();
  const tasks = (await loadPlugin(
    pluginDir,
    manager,
    hooks,
    broker,
  )) as TasksPlugin;
  return { tasks, storageManager: manager, hooks, broker, dataDir };
}

test("createProject + addTask build P2P.Project/P2P.Task and round-trip", async () => {
  const { tasks, dataDir } = await loadTasks();

  const project = await tasks.createProject({ name: "Launch" });
  const projectId = rootObject(project)!.$id;
  assert.equal(rootObject(project)!.$class, "P2P.Project");
  assert.equal(rootObject(project)!.name, "Launch");

  const doc = await tasks.addTask({
    projectId,
    name: "Write spec",
    start: "2026-08-01",
    finish: "2026-08-05",
    durationDays: 4,
    percentComplete: 20,
  });

  const [taskId] = taskIds(doc);
  const task = resolveRef(doc, { $ref: taskId })!;
  assert.equal(task.$class, "P2P.Task");
  assert.equal(task.name, "Write spec");
  assert.equal(task.start, "2026-08-01");
  assert.equal(task.finish, "2026-08-05");
  assert.equal(task.durationDays, 4);
  assert.equal(task.percentComplete, 20);
  assert.deepEqual(task.predecessors, []);
  assert.deepEqual(task.resourceAssignments, []);

  const fetched = await tasks.getTask(projectId, taskId);
  assert.equal(fetched?.name, "Write spec");

  const listed = await tasks.listTasks(projectId);
  assert.equal(listed.length, 1);

  const projects = await tasks.listProjects();
  assert.equal(projects.length, 1);

  // Persistence: the plugin stores only its own `project:<id>` key.
  const raw = await fs.readFile(path.join(dataDir, "tasks.json"), "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), [`project:${projectId}`]);
});

test("addTask requires a non-empty name and a known project", async () => {
  const { tasks } = await loadTasks();

  const project = await tasks.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;

  await assert.rejects(
    tasks.addTask({ projectId, name: "   " }),
    /non-empty/,
  );
  await assert.rejects(
    tasks.addTask({ projectId: "missing", name: "T" }),
    /not found/,
  );
});

test("updateTask applies fields and validates percentComplete and chronology", async () => {
  const { tasks, hooks } = await loadTasks();

  const updated: unknown[] = [];
  hooks.on("tasks:taskUpdated", (p) => {
    updated.push(p);
  });

  const project = await tasks.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;
  const doc = await tasks.addTask({ projectId, name: "T", start: "2026-08-01" });
  const [taskId] = taskIds(doc);

  const result = await tasks.updateTask({
    projectId,
    taskId,
    percentComplete: 50,
    finish: "2026-08-10",
  });
  const task = resolveRef(result, { $ref: taskId })!;
  assert.equal(task.percentComplete, 50);
  assert.equal(task.finish, "2026-08-10");
  assert.equal(task.start, "2026-08-01");

  await assert.rejects(
    tasks.updateTask({ projectId, taskId, percentComplete: 150 }),
    /between 0 and 100/,
  );
  await assert.rejects(
    tasks.updateTask({ projectId, taskId, finish: "2026-07-01" }),
    /before start/,
  );

  // The failed updates must not have persisted.
  const stored = await tasks.getTask(projectId, taskId);
  assert.equal(stored?.percentComplete, 50);
  assert.equal(stored?.finish, "2026-08-10");

  assert.ok(updated.length >= 1);
  assert.deepEqual(updated[updated.length - 1], {
    projectId,
    taskId,
    action: "updateTask",
  });
});

test("setDependency rejects a direct self-dependency", async () => {
  const { tasks } = await loadTasks();

  const project = await tasks.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;
  const doc = await tasks.addTask({ projectId, name: "T" });
  const [taskId] = taskIds(doc);

  await assert.rejects(
    tasks.setDependency({ projectId, taskId, predecessorTaskId: taskId }),
    /cycle/,
  );
});

test("setDependency rejects an indirect cycle", async () => {
  const { tasks } = await loadTasks();

  const project = await tasks.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;

  const a = await tasks.addTask({ projectId, name: "A" });
  const aId = lastTaskId(a);
  const b = await tasks.addTask({ projectId, name: "B" });
  const bId = lastTaskId(b);
  const c = await tasks.addTask({ projectId, name: "C" });
  const cId = lastTaskId(c);

  await tasks.setDependency({ projectId, taskId: bId, predecessorTaskId: aId });
  await tasks.setDependency({ projectId, taskId: cId, predecessorTaskId: bId });

  // C depends on B depends on A; adding A depends on C would close the loop.
  await assert.rejects(
    tasks.setDependency({ projectId, taskId: aId, predecessorTaskId: cId }),
    /cycle/,
  );

  // The graph is still a valid chain.
  const cTask = await tasks.getTask(projectId, cId);
  assert.deepEqual(cTask?.predecessors, [
    { taskId: bId, type: "FS", lagDays: 0 },
  ]);
});

test("setDependency stores predecessors inline and is idempotent", async () => {
  const { tasks } = await loadTasks();

  const project = await tasks.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;

  const a = await tasks.addTask({ projectId, name: "A" });
  const aId = lastTaskId(a);
  const b = await tasks.addTask({ projectId, name: "B" });
  const bId = lastTaskId(b);

  await tasks.setDependency({
    projectId,
    taskId: bId,
    predecessorTaskId: aId,
    type: "SS",
    lagDays: 2,
  });

  let bTask = await tasks.getTask(projectId, bId);
  assert.deepEqual(bTask?.predecessors, [
    { taskId: aId, type: "SS", lagDays: 2 },
  ]);

  // Re-adding the same edge refreshes type/lagDays without duplicating.
  await tasks.setDependency({
    projectId,
    taskId: bId,
    predecessorTaskId: aId,
    type: "FF",
    lagDays: 0,
  });
  bTask = await tasks.getTask(projectId, bId);
  assert.deepEqual(bTask?.predecessors, [
    { taskId: aId, type: "FF", lagDays: 0 },
  ]);

  await assert.rejects(
    tasks.setDependency({ projectId, taskId: bId, predecessorTaskId: aId, type: "XX" as never }),
    /FS, SS, FF, SF/,
  );
});

test("assignResource embeds a contact as an OLE $ref and emits taskUpdated", async () => {
  const storageManager = new StorageManager(
    await fs.mkdtemp(path.join(os.tmpdir(), "tasks-data-")),
  );

  const contacts = (await loadPlugin(
    contactsPluginDir,
    storageManager,
    new HookRegistry(),
  )) as ContactsApi;
  await contacts.addContact({
    peerId: PEER_ID,
    publicKeyHex: PEER_ID,
    displayName: "Alice",
  });

  const { tasks, hooks } = await loadTasks(storageManager);
  const updated: unknown[] = [];
  hooks.on("tasks:taskUpdated", (p) => {
    updated.push(p);
  });

  const project = await tasks.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;
  const doc = await tasks.addTask({ projectId, name: "T" });
  const [taskId] = taskIds(doc);

  const result = await tasks.assignResource({
    projectId,
    taskId,
    contactPeerId: PEER_ID,
  });

  const task = resolveRef(result, { $ref: taskId })!;
  const assignments = task.resourceAssignments as PBXReference[];
  assert.equal(assignments.length, 1);

  const imported = resolveRef(result, assignments[0])!;
  assert.equal(imported.$class, "P2P.Contact");
  assert.equal(imported.peerId, PEER_ID);
  assert.equal(imported.displayName, "Alice");

  // The addTask emission precedes this one; the last event is assignResource.
  const last = updated[updated.length - 1];
  assert.deepEqual(last, {
    projectId,
    taskId,
    taskName: "T",
    contactPeerId: PEER_ID,
    action: "assignResource",
  });
});

test("assignResource rejects an unknown contact with a clean error", async () => {
  const { tasks } = await loadTasks();

  const project = await tasks.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;
  const doc = await tasks.addTask({ projectId, name: "T" });
  const [taskId] = taskIds(doc);

  await assert.rejects(
    tasks.assignResource({ projectId, taskId, contactPeerId: PEER_ID }),
    /contact .* not found/,
  );
});

test("skills are registered in the tasks namespace; UI skills are httpBridgeOnly", async () => {
  const { broker } = await loadTasks();
  const names = broker.listSkills().map((s) => s.skill).sort();
  assert.deepEqual(names, [
    "tasks.addMember",
    "tasks.addTask",
    "tasks.assignAgent",
    "tasks.assignResource",
    "tasks.attachNote",
    "tasks.createProject",
    "tasks.delegateTask",
    "tasks.getCapacity",
    "tasks.getCriticalPath",
    "tasks.getProject",
    "tasks.getTask",
    "tasks.listProjects",
    "tasks.listTasks",
    "tasks.planDay",
    "tasks.planProject",
    "tasks.requestMutation",
    "tasks.setDependencies",
    "tasks.setDependency",
    "tasks.updateBudget",
    "tasks.updateTask",
  ]);

  // The 13 skills the plugin UI drives through the shell bridge are
  // `httpBridgeOnly`: a local-operator privilege behind the per-boot token,
  // structurally never reachable over the network (broker forces localOnly +
  // httpExposed and drops any remote policy at registration).
  const uiSkills = new Set([
    "tasks.createProject",
    "tasks.getProject",
    "tasks.listProjects",
    "tasks.addTask",
    "tasks.listTasks",
    "tasks.updateTask",
    "tasks.setDependency",
    "tasks.setDependencies",
    "tasks.delegateTask",
    "tasks.getCapacity",
    "tasks.getCriticalPath",
    "tasks.assignResource",
    "tasks.addMember",
  ]);

  for (const entry of broker.listSkills()) {
    if (entry.skill === "tasks.requestMutation") {
      // The single member-facing network skill: verified-contact remote gate,
      // never HTTP-exposed (the UI drives every mutation through it locally).
      assert.equal(entry.localOnly, false);
      assert.equal(entry.httpExposed, false);
      assert.equal(entry.httpBridgeOnly, false);
      assert.deepEqual(entry.remote, { gate: "verified-contact" });
    } else if (uiSkills.has(entry.skill)) {
      assert.equal(entry.localOnly, true);
      assert.equal(entry.httpExposed, true);
      assert.equal(entry.httpBridgeOnly, true);
      assert.equal(entry.remote, undefined);
    } else {
      assert.equal(entry.localOnly, true);
      assert.equal(entry.httpExposed, false);
      assert.equal(entry.httpBridgeOnly, false);
      assert.equal(entry.remote, undefined);
    }
  }
});

test("createProject seeds the owner as a member with mutationSeq 0 and validates budget", async () => {
  const { tasks } = await loadTasks();

  const project = await tasks.createProject({ name: "P" });
  const root = rootObject(project)!;
  assert.equal(root.$class, "P2P.Project");
  assert.ok(Array.isArray(root.members));
  assert.equal(root.members.length, 1);
  assert.equal(typeof root.members[0], "string");
  assert.equal(root.mutationSeq, 0);

  const withBudget = await tasks.createProject({ name: "B", budgetCents: 5000 });
  assert.equal(rootObject(withBudget)!.budgetCents, 5000);

  await assert.rejects(
    tasks.createProject({ name: "X", budgetCents: -1 }),
    /non-negative integer/,
  );
  await assert.rejects(
    tasks.createProject({ name: "X", budgetCents: 1.5 }),
    /non-negative integer/,
  );
});

test("addMember adds a peer to the members list and updateBudget persists spending", async () => {
  const { tasks } = await loadTasks();

  const project = await tasks.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;

  const withMember = await tasks.addMember({ projectId, peerId: PEER_ID });
  assert.deepEqual(membersOf(withMember), [membersOf(project)[0], PEER_ID]);

  const withBudget = await tasks.updateBudget({
    projectId,
    budgetCents: 10000,
    spentCents: 3500,
  });
  const budgetRoot = rootObject(withBudget)!;
  assert.equal(budgetRoot.budgetCents, 10000);
  assert.equal(budgetRoot.spentCents, 3500);

  await assert.rejects(
    tasks.updateBudget({ projectId, budgetCents: -5 }),
    /non-negative integer/,
  );
});

test("requestMutation applies a member's UPDATE_STATUS and rejects non-members", async () => {
  const { tasks } = await loadTasks();

  const project = await tasks.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;
  const doc = await tasks.addTask({ projectId, name: "T" });
  const [taskId] = taskIds(doc);

  // The owner is a member; the owner's mutation applies. (addTask bumped the
  // seq to 1, so this first requestMutation is seq 2.)
  const ownerPeerId = membersOf(project)[0];
  const result = await tasks.requestMutation({
    projectId,
    type: "UPDATE_STATUS",
    taskId,
    senderPeerId: ownerPeerId,
    payload: { status: "in-progress" },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.mutationSeq, 2);
    assert.equal(result.action, "updateStatus");
  }
  const task = await tasks.getTask(projectId, taskId);
  assert.equal(task?.status, "in-progress");

  // A stranger is not a member → denied with a clean error.
  await assert.rejects(
    tasks.requestMutation({
      projectId,
      type: "UPDATE_STATUS",
      taskId,
      senderPeerId: "b".repeat(64),
      payload: { status: "done" },
    }),
    /not a member/,
  );

  // An empty (no transport-verified identity) sender is denied.
  await assert.rejects(
    tasks.requestMutation({
      projectId,
      type: "UPDATE_STATUS",
      taskId,
      senderPeerId: "",
      payload: { status: "done" },
    }),
    /no transport-verified sender identity/,
  );

  // The rejected mutations must not have persisted.
  assert.equal((await tasks.getTask(projectId, taskId))?.status, "in-progress");
});

test("requestMutation applies concurrent mutations in deterministic FIFO order", async () => {
  const { tasks } = await loadTasks();

  const project = await tasks.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;
  const doc = await tasks.addTask({ projectId, name: "T" });
  const [taskId] = taskIds(doc);
  const ownerPeerId = membersOf(project)[0];

  // Fire three LOG_TIME requests without awaiting between them. The plugin
  // enqueues synchronously (before any await), so arrival order is the call
  // order, and the per-project FIFO queue must apply them in that exact order.
  const requests = [
    tasks.requestMutation({
      projectId,
      type: "LOG_TIME",
      taskId,
      senderPeerId: ownerPeerId,
      payload: { start: "2026-08-01T09:00:00.000Z", end: "2026-08-01T10:00:00.000Z" },
    }),
    tasks.requestMutation({
      projectId,
      type: "LOG_TIME",
      taskId,
      senderPeerId: ownerPeerId,
      payload: { start: "2026-08-02T09:00:00.000Z", end: "2026-08-02T10:00:00.000Z" },
    }),
    tasks.requestMutation({
      projectId,
      type: "LOG_TIME",
      taskId,
      senderPeerId: ownerPeerId,
      payload: { start: "2026-08-03T09:00:00.000Z", end: "2026-08-03T10:00:00.000Z" },
    }),
  ];
  const results = await Promise.all(requests);
  // The addTask bump is seq 1, so the three FIFO-ordered LOG_TIME mutations
  // land on 2, 3, 4 in exact arrival order.
  const seqs = results.map((r) => (r.ok ? r.mutationSeq : -1));
  assert.deepEqual(seqs, [2, 3, 4]);

  // The applied time entries keep arrival order (the queue is the single
  // writer; there is no lost update or reordering).
  const task = (await tasks.getTask(projectId, taskId)) as unknown as {
    timeEntries: Array<{ start: string; end: string; peerId: string }>;
  };
  assert.deepEqual(
    task.timeEntries.map((e) => e.start),
    [
      "2026-08-01T09:00:00.000Z",
      "2026-08-02T09:00:00.000Z",
      "2026-08-03T09:00:00.000Z",
    ],
  );
  for (const entry of task.timeEntries) {
    assert.equal(entry.peerId, ownerPeerId);
  }
});

test("requestMutation CREATE_SUBTASK builds a task tree and done cascades to descendants", async () => {
  const { tasks } = await loadTasks();

  const project = await tasks.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;
  const doc = await tasks.addTask({ projectId, name: "Parent" });
  const [parentId] = taskIds(doc);
  const ownerPeerId = membersOf(project)[0];

  const created = await tasks.requestMutation({
    projectId,
    type: "CREATE_SUBTASK",
    taskId: parentId,
    senderPeerId: ownerPeerId,
    payload: { name: "Child" },
  });
  assert.equal(created.ok, true);

  const listed = await tasks.listTasks(projectId);
  const child = listed.find((t) => t.name === "Child")!;
  assert.equal(child.parentTaskId, parentId);

  // Marking the parent done cascades `done` to the child.
  await tasks.requestMutation({
    projectId,
    type: "UPDATE_STATUS",
    taskId: parentId,
    senderPeerId: ownerPeerId,
    payload: { status: "done" },
  });
  assert.equal((await tasks.getTask(projectId, parentId))?.status, "done");
  assert.equal((await tasks.getTask(projectId, child.$id))?.status, "done");
});

test("requestMutation MOVE_TASK reparents and rejects a parent cycle", async () => {
  const { tasks } = await loadTasks();

  const project = await tasks.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;
  const ownerPeerId = membersOf(project)[0];

  const a = await tasks.addTask({ projectId, name: "A" });
  const aId = lastTaskId(a);
  const b = await tasks.addTask({ projectId, name: "B" });
  const bId = lastTaskId(b);
  const c = await tasks.addTask({ projectId, name: "C" });
  const cId = lastTaskId(c);

  // B becomes a child of A.
  const moved = await tasks.requestMutation({
    projectId,
    type: "MOVE_TASK",
    taskId: bId,
    senderPeerId: ownerPeerId,
    payload: { newParentTaskId: aId },
  });
  assert.equal(moved.ok, true);
  assert.equal((await tasks.getTask(projectId, bId))?.parentTaskId, aId);

  // Moving A under B would close a cycle (A -> B -> A) → denied.
  await assert.rejects(
    tasks.requestMutation({
      projectId,
      type: "MOVE_TASK",
      taskId: aId,
      senderPeerId: ownerPeerId,
      payload: { newParentTaskId: bId },
    }),
    /cycle/,
  );

  // The rejected move must not have persisted.
  assert.equal((await tasks.getTask(projectId, aId))?.parentTaskId, undefined);
  assert.equal((await tasks.getTask(projectId, cId))?.parentTaskId, undefined);
});

test("assignAgent emits a notification hook without changing project state", async () => {
  const { tasks, hooks } = await loadTasks();

  const project = await tasks.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;
  const doc = await tasks.addTask({ projectId, name: "T" });
  const [taskId] = taskIds(doc);

  const before = await tasks.getProject(projectId);
  const beforeSeq = rootObject(before!)!.mutationSeq as number;
  assert.equal(beforeSeq, 1); // createProject (0) + addTask (1)

  const emitted: unknown[] = [];
  hooks.on("tasks:taskUpdated", (p) => {
    emitted.push(p);
  });

  const result = await tasks.assignAgent({
    projectId,
    taskId,
    agentPeerId: "c".repeat(64),
  });
  assert.deepEqual(result, {
    ok: true,
    projectId,
    taskId,
    agentPeerId: "c".repeat(64),
  });

  const last = emitted[emitted.length - 1];
  assert.deepEqual(last, {
    projectId,
    taskId,
    taskName: "T",
    agentPeerId: "c".repeat(64),
    action: "assignAgent",
  });

  // Notification only: the project document is untouched (mutationSeq is
  // still whatever addTask left it at).
  const after = await tasks.getProject(projectId);
  assert.equal(rootObject(after!)!.mutationSeq as number, beforeSeq);
});

test("attachNote embeds an OLE noteRef into the project document", async () => {
  const storageManager = new StorageManager(
    await fs.mkdtemp(path.join(os.tmpdir(), "tasks-data-")),
  );

  // Seed a note in the notepad plugin's store, exactly like notepad would.
  const notepad = storageManager.getOrCreate("notepad");
  const noteDoc = createDocument("P2P.SmartNote", { name: "Meeting" });
  const noteId = rootObject(noteDoc)!.$id;
  await notepad.set(`note:${noteId}`, noteDoc);

  const { tasks } = await loadTasks(storageManager);

  const project = await tasks.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;

  const withNote = await tasks.attachNote({ projectId, noteId });
  const noteRef = rootObject(withNote)!.noteRef as PBXReference;
  const embedded = resolveRef(withNote, noteRef);
  assert.equal(embedded?.$class, "P2P.EmbeddedObject");
  assert.equal(embedded?.targetClass, "P2P.SmartNote");
  assert.equal(embedded?.targetId, noteId);

  await assert.rejects(
    tasks.attachNote({ projectId, noteId: "missing" }),
    /not found/,
  );
});

test("planDay and planProject are propose-then-confirm and never mutate", async () => {
  const { tasks } = await loadTasks();

  const project = await tasks.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;
  await tasks.addTask({ projectId, name: "T" });

  const before = await tasks.getProject(projectId);
  const beforeSeq = rootObject(before!)!.mutationSeq as number;
  assert.equal(beforeSeq, 1); // createProject (0) + addTask (1)

  // Without an AI key the provider fails cleanly — the planner returns a
  // non-OK PlanResult and mutates nothing (propose-then-confirm).
  const day = await tasks.planDay({ projectId, goal: "focus" });
  assert.equal(day.ok, false);
  if (!day.ok) {
    assert.match(day.error, /AI/i);
  }

  const plan = await tasks.planProject({ projectId, scope: "v1" });
  assert.equal(plan.ok, false);

  // Unknown projects fail without touching any document.
  const missing = await tasks.planDay({ projectId: "nope" });
  assert.equal(missing.ok, false);

  const after = await tasks.getProject(projectId);
  assert.equal(rootObject(after!)!.mutationSeq as number, beforeSeq);
  assert.equal((await tasks.listTasks(projectId)).length, 1);
});

// ---- SmartProjects v1.1: dependency guard --------------------------------

test("dependency guard blocks start/complete while a dependency is unfinished", async () => {
  const { tasks } = await loadTasks();

  const project = await tasks.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;
  const a = await tasks.addTask({ projectId, name: "A" });
  const aId = lastTaskId(a);
  const b = await tasks.addTask({ projectId, name: "B" });
  const bId = lastTaskId(b);

  await tasks.setDependencies({ projectId, taskId: bId, dependencyIds: [aId] });

  // Deterministic "Invalid Dependency State" errors on both transitions.
  await assert.rejects(
    tasks.updateTask({ projectId, taskId: bId, status: "in-progress" }),
    /Invalid Dependency State/,
  );
  await assert.rejects(
    tasks.updateTask({ projectId, taskId: bId, status: "done" }),
    /Invalid Dependency State/,
  );

  // The rejected updates must not have persisted.
  assert.equal((await tasks.getTask(projectId, bId))?.status, "todo");

  // Completing the dependency unblocks the dependent.
  await tasks.updateTask({ projectId, taskId: aId, status: "done" });
  await tasks.updateTask({ projectId, taskId: bId, status: "in-progress" });
  await tasks.updateTask({ projectId, taskId: bId, status: "done" });
  assert.equal((await tasks.getTask(projectId, bId))?.status, "done");
});

test("dependency guard stops the done cascade from smuggling an unfinished dependency", async () => {
  const { tasks } = await loadTasks();

  const project = await tasks.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;
  const parent = await tasks.addTask({ projectId, name: "Parent" });
  const parentId = lastTaskId(parent);
  const a = await tasks.addTask({ projectId, name: "A" });
  const aId = lastTaskId(a);
  const child = await tasks.addTask({
    projectId,
    name: "Child",
    parentTaskId: parentId,
  });
  const childId = lastTaskId(child);

  // Child depends on A, which stays unfinished. Marking Parent done would
  // cascade `done` to Child — assertCanComplete walks the whole subtree and
  // refuses.
  await tasks.setDependencies({ projectId, taskId: childId, dependencyIds: [aId] });
  await assert.rejects(
    tasks.updateTask({ projectId, taskId: parentId, status: "done" }),
    /Invalid Dependency State/,
  );
  assert.equal((await tasks.getTask(projectId, parentId))?.status, "todo");
  assert.equal((await tasks.getTask(projectId, childId))?.status, "todo");

  // Unblocking the leaf dependency lets the parent close the whole subtree.
  await tasks.updateTask({ projectId, taskId: aId, status: "done" });
  await tasks.updateTask({ projectId, taskId: parentId, status: "done" });
  assert.equal((await tasks.getTask(projectId, parentId))?.status, "done");
  assert.equal((await tasks.getTask(projectId, childId))?.status, "done");
});

test("setDependencies rejects self/missing/cyclic sets and keeps predecessors in sync", async () => {
  const { tasks } = await loadTasks();

  const project = await tasks.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;
  const a = await tasks.addTask({ projectId, name: "A" });
  const aId = lastTaskId(a);
  const b = await tasks.addTask({ projectId, name: "B" });
  const bId = lastTaskId(b);
  const c = await tasks.addTask({ projectId, name: "C" });
  const cId = lastTaskId(c);

  await assert.rejects(
    tasks.setDependencies({ projectId, taskId: aId, dependencyIds: [aId] }),
    /depend on itself/,
  );
  await assert.rejects(
    tasks.setDependencies({ projectId, taskId: aId, dependencyIds: ["missing"] }),
    /not found/,
  );

  // A depends on B; making B depend on A would close the loop.
  await tasks.setDependencies({ projectId, taskId: aId, dependencyIds: [bId] });
  await assert.rejects(
    tasks.setDependencies({ projectId, taskId: bId, dependencyIds: [aId] }),
    /cycle/,
  );

  // setDependency carries type/lagDays; setDependencies preserves them for the
  // same id and gives new ids the MSPDI default FS/0.
  await tasks.setDependency({
    projectId,
    taskId: cId,
    predecessorTaskId: aId,
    type: "SS",
    lagDays: 2,
  });
  await tasks.setDependencies({
    projectId,
    taskId: cId,
    dependencyIds: [aId, bId],
  });
  const cTask = await tasks.getTask(projectId, cId);
  assert.deepEqual(cTask?.dependencies, [aId, bId]);
  assert.deepEqual(cTask?.predecessors, [
    { taskId: aId, type: "SS", lagDays: 2 },
    { taskId: bId, type: "FS", lagDays: 0 },
  ]);
});

test("requestMutation UPDATE_STATUS enforces the dependency guard for members", async () => {
  const { tasks } = await loadTasks();

  const project = await tasks.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;
  const a = await tasks.addTask({ projectId, name: "A" });
  const aId = lastTaskId(a);
  const b = await tasks.addTask({ projectId, name: "B" });
  const bId = lastTaskId(b);
  const ownerPeerId = membersOf(project)[0];

  await tasks.requestMutation({
    projectId,
    type: "SET_DEPENDENCIES",
    taskId: bId,
    senderPeerId: ownerPeerId,
    payload: { dependencyIds: [aId] },
  });

  // The guard is on the member write path too, not just the local one.
  await assert.rejects(
    tasks.requestMutation({
      projectId,
      type: "UPDATE_STATUS",
      taskId: bId,
      senderPeerId: ownerPeerId,
      payload: { status: "in-progress" },
    }),
    /Invalid Dependency State/,
  );
  await assert.rejects(
    tasks.requestMutation({
      projectId,
      type: "UPDATE_STATUS",
      taskId: bId,
      senderPeerId: ownerPeerId,
      payload: { status: "done" },
    }),
    /Invalid Dependency State/,
  );
  assert.equal((await tasks.getTask(projectId, bId))?.status, "todo");
});

// ---- SmartProjects v1.1: delegation handshake ---------------------------

/** A second node with its own vault → its own persistent identity. */
async function loadSecondNode(): Promise<{
  tasks: TasksPlugin;
  identity: IdentityManager;
  peerId: string;
}> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tasks-node2-"));
  const vault = new VaultManager({
    dataDir: path.join(dataDir, "vault"),
    masterKey: "tasks-test-node2-master-key",
  });
  const identity = new IdentityManager({ vault });
  const tasks = (await loadPlugin(
    pluginDir,
    new StorageManager(dataDir),
    new HookRegistry(),
    new TaskBroker(),
    vault,
    identity,
  )) as TasksPlugin;
  const peerId = (await identity.getOrCreateIdentity()).peerId;
  return { tasks, identity, peerId };
}

test("delegation handshake: delegate → accept → sign proof → submit → done", async () => {
  const { tasks: owner } = await loadTasks();
  const node2 = await loadSecondNode();
  const peerB = node2.peerId;

  const project = await owner.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;
  const doc = await owner.addTask({ projectId, name: "T" });
  const [taskId] = taskIds(doc);

  // Owner delegates: the delegatee becomes a member so the handshake can run
  // through the member-only requestMutation surface.
  const delegated = await owner.delegateTask({
    projectId,
    taskId,
    peerId: peerB,
  });
  const t = resolveRef(delegated, { $ref: taskId })!;
  assert.deepEqual(t.delegation, { assignedTo: peerB, status: "pending" });
  assert.ok(membersOf(delegated).includes(peerB));

  // A member who is NOT the assignee can never accept/decline on their behalf.
  const ownerPeerId = membersOf(project)[0];
  await assert.rejects(
    owner.requestMutation({
      projectId,
      type: "ACCEPT_DELEGATION",
      taskId,
      senderPeerId: ownerPeerId,
      payload: {},
    }),
    /not the assignee/,
  );

  // A completion proof before acceptance is refused.
  await assert.rejects(
    owner.requestMutation({
      projectId,
      type: "SUBMIT_COMPLETION_PROOF",
      taskId,
      senderPeerId: peerB,
      payload: {},
    }),
    /must be accepted/,
  );

  // The assignee accepts on ITS OWN node identity (transport-verified sender).
  const accepted = await owner.requestMutation({
    projectId,
    type: "ACCEPT_DELEGATION",
    taskId,
    senderPeerId: peerB,
    payload: {},
  });
  assert.equal(accepted.ok, true);
  const afterAccept = taskRecord((await owner.getProject(projectId))!, taskId);
  assert.equal(afterAccept.delegation?.status, "accepted");

  // The delegatee signs a proof on its own node. The signature covers
  // COMPLETION_PROOF_DOMAIN_PREFIX + "<taskId>:<projectId>:<timestamp>".
  const timestamp = "2026-08-10T12:00:00.000Z";
  const proof = await node2.tasks.signCompletionProof({
    taskId,
    projectId,
    timestamp,
  });
  assert.equal(proof.signedBy, peerB);
  assert.equal(proof.timestamp, timestamp);
  assert.match(proof.signatureHex, /^[0-9a-f]+$/);

  // A proof whose signature was minted for a DIFFERENT task/project/timestamp
  // fails verification — domain separation + payload binding is structural.
  const differentTimestamp = { ...proof, timestamp: "2026-08-11T12:00:00.000Z" };
  await assert.rejects(
    owner.requestMutation({
      projectId,
      type: "SUBMIT_COMPLETION_PROOF",
      taskId,
      senderPeerId: peerB,
      payload: { proof: differentTimestamp },
    }),
    /verification failed/,
  );

  // A corrupted signature fails verification.
  const corrupted = { ...proof, signatureHex: "00".repeat(64) };
  await assert.rejects(
    owner.requestMutation({
      projectId,
      type: "SUBMIT_COMPLETION_PROOF",
      taskId,
      senderPeerId: peerB,
      payload: { proof: corrupted },
    }),
    /verification failed/,
  );

  // A signature minted in a FOREIGN domain is structurally meaningless here:
  // node B signs the same payload bytes under the chat message domain, and the
  // owner verifies under COMPLETION_PROOF_DOMAIN_PREFIX — the bytes never match.
  const foreignDomainSignature = await node2.identity.sign(
    Buffer.from(
      `p2p-hub:chat:message:v1:${taskId}:${projectId}:${timestamp}`,
      "utf8",
    ),
  );
  const foreignDomainProof = {
    signedBy: peerB,
    timestamp,
    signatureHex: foreignDomainSignature.toString("hex"),
  };
  assert.notEqual(
    COMPLETION_PROOF_DOMAIN_PREFIX,
    "p2p-hub:chat:message:v1:",
    "the completion-proof domain must differ from the chat domain",
  );
  await assert.rejects(
    owner.requestMutation({
      projectId,
      type: "SUBMIT_COMPLETION_PROOF",
      taskId,
      senderPeerId: peerB,
      payload: { proof: foreignDomainProof },
    }),
    /verification failed/,
  );

  // A proof whose signedBy does not equal the transport-verified sender fails.
  await assert.rejects(
    owner.requestMutation({
      projectId,
      type: "SUBMIT_COMPLETION_PROOF",
      taskId,
      senderPeerId: peerB,
      payload: { proof: { ...proof, signedBy: ownerPeerId } },
    }),
    /signedBy must equal/,
  );

  // The valid proof completes the task.
  const completed = await owner.requestMutation({
    projectId,
    type: "SUBMIT_COMPLETION_PROOF",
    taskId,
    senderPeerId: peerB,
    payload: { proof },
  });
  assert.equal(completed.ok, true);
  const done = taskRecord((await owner.getProject(projectId))!, taskId);
  assert.equal(done.status, "done");
  assert.equal(done.completionProof?.signedBy, peerB);

  // A second, independent delegation ends with a declined handshake.
  const doc2 = await owner.addTask({ projectId, name: "U" });
  const uId = lastTaskId(doc2);
  await owner.delegateTask({ projectId, taskId: uId, peerId: peerB });
  const declined = await owner.requestMutation({
    projectId,
    type: "DECLINE_DELEGATION",
    taskId: uId,
    senderPeerId: peerB,
    payload: { reason: "too busy" },
  });
  assert.equal(declined.ok, true);
  const u = taskRecord((await owner.getProject(projectId))!, uId);
  assert.equal(u.delegation?.status, "declined");
  assert.equal(u.delegation?.declinedReason, "too busy");
  assert.notEqual(u.status, "done");

  // A non-pending delegation can neither be accepted nor declined again.
  await assert.rejects(
    owner.requestMutation({
      projectId,
      type: "ACCEPT_DELEGATION",
      taskId: uId,
      senderPeerId: peerB,
      payload: {},
    }),
    /not pending/,
  );
  await assert.rejects(
    owner.requestMutation({
      projectId,
      type: "DECLINE_DELEGATION",
      taskId: uId,
      senderPeerId: peerB,
      payload: {},
    }),
    /not pending/,
  );
});

test("ACCEPT_DELEGATION is applied in FIFO arrival order without any timing", async () => {
  const { tasks } = await loadTasks();

  const project = await tasks.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;
  const doc = await tasks.addTask({ projectId, name: "T" });
  const [taskId] = taskIds(doc);
  const peerB = "b".repeat(64);
  const peerC = "c".repeat(64);

  // Owner delegates to B and adds C as a member. Both are members afterwards.
  await tasks.delegateTask({ projectId, taskId, peerId: peerB });
  await tasks.addMember({ projectId, peerId: peerC });

  // Fire three mutations without awaiting, in exact call order: B accepts,
  // C logs time, then B tries to decline. The enqueue is synchronous (before
  // any await), so FIFO order equals arrival order. The third call can only
  // fail with "not pending (status: accepted)" if the accept ran FIRST — the
  // outcome itself is the ordering proof, with no sleeps or timing.
  const before = rootObject((await tasks.getProject(projectId))!)!
    .mutationSeq as number;
  const settled = await Promise.allSettled([
    tasks.requestMutation({
      projectId,
      type: "ACCEPT_DELEGATION",
      taskId,
      senderPeerId: peerB,
      payload: {},
    }),
    tasks.requestMutation({
      projectId,
      type: "LOG_TIME",
      taskId,
      senderPeerId: peerC,
      payload: {
        start: "2026-08-01T09:00:00.000Z",
        end: "2026-08-01T10:00:00.000Z",
      },
    }),
    tasks.requestMutation({
      projectId,
      type: "DECLINE_DELEGATION",
      taskId,
      senderPeerId: peerB,
      payload: {},
    }),
  ]);

  assert.equal(settled[0].status, "fulfilled");
  assert.equal(settled[1].status, "fulfilled");
  const first = settled[0] as PromiseFulfilledResult<MutationResult>;
  const second = settled[1] as PromiseFulfilledResult<MutationResult>;
  assert.equal(first.value.ok, true);
  assert.equal(second.value.ok, true);
  if (first.value.ok) assert.equal(first.value.mutationSeq, before + 1);
  if (second.value.ok) assert.equal(second.value.mutationSeq, before + 2);

  // The DECLINE ran after the ACCEPT: it was refused because the delegation is
  // no longer pending — deterministic evidence of queue order.
  assert.equal(settled[2].status, "rejected");
  const declined = (settled[2] as PromiseRejectedResult).reason as Error;
  assert.match(String(declined?.message ?? declined), /not pending \(status: accepted\)/);

  const finalTask = taskRecord((await tasks.getProject(projectId))!, taskId);
  assert.equal(finalTask.delegation?.status, "accepted");
});

// ---- SmartProjects v1.1: pure computations ------------------------------

test("calculateProjectCapacity warns over 8h/peer/day and floors working days at 1", () => {
  const tasks: TaskLike[] = [
    // 20h over 2 days → 10h/day → over capacity.
    { id: "t1", estimatedHours: 20, start: "2026-08-03", finish: "2026-08-04", assignedPeerIds: ["p1"] },
    // 16h over 2 days → exactly 8h/day → not over (strict >).
    { id: "t2", estimatedHours: 16, start: "2026-08-05", finish: "2026-08-06", assignedPeerIds: ["p2"] },
    // No dates: falls back to the project span as its working-days window.
    { id: "t3", estimatedHours: 8, assignedPeerIds: ["p3"] },
  ];
  const timeEntries: TimeEntryLike[] = [
    { taskId: "t1", peerId: "p1", start: "2026-08-03T09:00:00.000Z", end: "2026-08-03T11:00:00.000Z" },
  ];

  const cap = calculateProjectCapacity(tasks, timeEntries);
  assert.equal(cap.totalEstimatedHours, 44);
  assert.equal(cap.totalSpentHours, 2);
  assert.equal(cap.workingDays, 4); // 03, 04, 05, 06
  assert.equal(cap.estimatedHoursPerDay, 11);

  const p1 = cap.perPeer.find((p) => p.peerId === "p1")!;
  assert.equal(p1.estimatedHours, 20);
  assert.equal(p1.spentHours, 2);
  assert.equal(p1.workingDays, 2);
  assert.equal(p1.estimatedHoursPerDay, 10);
  assert.equal(p1.overCapacity, true);

  const p2 = cap.perPeer.find((p) => p.peerId === "p2")!;
  assert.equal(p2.estimatedHoursPerDay, 8);
  assert.equal(p2.overCapacity, false);

  const p3 = cap.perPeer.find((p) => p.peerId === "p3")!;
  assert.equal(p3.workingDays, cap.workingDays); // project span fallback
  assert.equal(p3.overCapacity, false);

  assert.deepEqual(cap.overAllocation, [
    { peerId: "p1", estimatedHoursPerDay: 10 },
  ]);
});

test("calculateCriticalPath is deterministic and picks the longest dependency chain", () => {
  const base: TaskLike[] = [
    { id: "a", durationDays: 1 },
    { id: "b", durationDays: 2, dependencies: ["a"] },
    { id: "c", durationDays: 3, dependencies: ["b"] },
    { id: "d", durationDays: 4, dependencies: ["c"] },
  ];
  const one = calculateCriticalPath(base);
  assert.deepEqual(one.path, ["d", "c", "b", "a"]);
  assert.equal(one.totalWeight, 10);
  assert.deepEqual(one.criticalTaskIds, one.path);

  // Re-ordered input yields the identical result (first-wins tie-breaks).
  const two = calculateCriticalPath([...base].reverse());
  assert.deepEqual(two.path, ["d", "c", "b", "a"]);
  assert.equal(two.totalWeight, 10);

  // An empty graph has an empty path.
  assert.deepEqual(calculateCriticalPath([]), {
    path: [],
    totalWeight: 0,
    criticalTaskIds: [],
  });
});

test("calculateCriticalPath falls back to estimatedHours then to 1, and branches correctly", () => {
  const cp = calculateCriticalPath([
    { id: "a", estimatedHours: 2 },
    { id: "b", durationDays: 3 },
    { id: "x", dependencies: ["a", "b"] }, // weight 1, picks the heavier dep (b)
    { id: "y", dependencies: ["x"] }, // weight 1
  ]);
  assert.deepEqual(cp.path, ["y", "x", "b"]);
  assert.equal(cp.totalWeight, 5);
});

test("getCriticalPath and getCapacity wire the pure computations to the store", async () => {
  const { tasks } = await loadTasks();

  const project = await tasks.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;
  const a = await tasks.addTask({
    projectId,
    name: "A",
    estimatedHours: 2,
    start: "2026-08-03",
    finish: "2026-08-03",
  });
  const aId = lastTaskId(a);
  const b = await tasks.addTask({
    projectId,
    name: "B",
    estimatedHours: 3,
    start: "2026-08-04",
    finish: "2026-08-04",
  });
  const bId = lastTaskId(b);
  await tasks.setDependencies({ projectId, taskId: bId, dependencyIds: [aId] });

  const cp = await tasks.getCriticalPath(projectId);
  assert.deepEqual(cp.path, [bId, aId]);
  assert.equal(cp.totalWeight, 5); // 3 + 2

  const ownerPeerId = membersOf(project)[0];
  await tasks.requestMutation({
    projectId,
    type: "LOG_TIME",
    taskId: aId,
    senderPeerId: ownerPeerId,
    payload: {
      start: "2026-08-03T09:00:00.000Z",
      end: "2026-08-03T10:00:00.000Z",
    },
  });

  const cap = await tasks.getCapacity(projectId);
  assert.equal(cap.totalEstimatedHours, 5);
  assert.equal(cap.totalSpentHours, 1);
  assert.equal(cap.workingDays, 2); // 08-03 and 08-04
});
