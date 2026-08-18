import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  HookRegistry,
  StorageManager,
  TaskBroker,
  loadPlugin,
} from "@p2p-hub/core";
import {
  resolveRef,
  rootObject,
  type PBXDocument,
  type PBXReference,
} from "@p2p-hub/sdk";
import type { TasksPlugin } from "./index";

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

function lastTaskId(doc: PBXDocument): string {
  const root = rootObject(doc)!;
  const refs = root.tasks as PBXReference[];
  return resolveRef(doc, refs[refs.length - 1])!.$id;
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

test("skills are registered in the tasks namespace and local-only", async () => {
  const { broker } = await loadTasks();
  const names = broker.listSkills().map((s) => s.skill).sort();
  assert.deepEqual(names, [
    "tasks.addTask",
    "tasks.assignResource",
    "tasks.createProject",
    "tasks.getProject",
    "tasks.getTask",
    "tasks.listProjects",
    "tasks.listTasks",
    "tasks.setDependency",
    "tasks.updateTask",
  ]);
  for (const entry of broker.listSkills()) {
    assert.equal(entry.localOnly, true);
    assert.equal(entry.httpExposed, false);
  }
});
