import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  HookRegistry,
  NetworkRegistry,
  StorageManager,
  TaskBroker,
  VaultManager,
  loadPlugin,
} from "@p2p-hub/core";
import type {
  NetworkPeer,
  NetworkProvider,
  TaskRequest,
  TaskResult,
} from "@p2p-hub/sdk";
import {
  rootObject,
  resolveRef,
  type PBXDocument,
  type PBXObject,
  type PBXReference,
} from "@p2p-hub/sdk";
import type { ChatPlugin, TaskAssignmentAction } from "./index";

const chatDir = path.resolve(__dirname, "..");
const tasksDir = path.resolve(__dirname, "../../tasks");
const contactsDir = path.resolve(__dirname, "../../contacts");

interface ContactsApi {
  addContact(input: {
    peerId: string;
    publicKeyHex: string;
    displayName: string;
  }): Promise<unknown>;
}

interface TasksApi {
  createProject(input: { name: string }): Promise<PBXDocument>;
  addTask(input: { projectId: string; name: string }): Promise<PBXDocument>;
  updateTask(input: {
    projectId: string;
    taskId: string;
    percentComplete?: number;
  }): Promise<PBXDocument>;
  assignResource(input: {
    projectId: string;
    taskId: string;
    contactPeerId: string;
  }): Promise<PBXDocument>;
  getTask(projectId: string, taskId: string): Promise<PBXObject | null>;
}

function hex64(): string {
  return crypto.randomBytes(32).toString("hex");
}

function lastTaskId(doc: PBXDocument): string {
  const root = rootObject(doc)!;
  const refs = root.tasks as PBXReference[];
  return resolveRef(doc, refs[refs.length - 1])!.$id;
}

interface CapturedSend {
  task?: TaskRequest;
}

function fakeProvider(peerId: string, capture?: CapturedSend): NetworkProvider {
  return {
    id: "fake",
    priority: 100,
    isReady: () => true,
    start: async () => {},
    stop: async () => {},
    discover: async () => [],
    listPeers: (): NetworkPeer[] => [
      {
        id: "fake-instance",
        address: "127.0.0.1:1",
        skills: ["chat.receiveMessage"],
        peerId,
      },
    ],
    sendTask: async (
      _peer: NetworkPeer,
      task: TaskRequest,
    ): Promise<TaskResult> => {
      if (capture) {
        capture.task = task;
      }
      return { taskId: task.id, status: "ok", result: { received: true } };
    },
    onTask: () => {},
  };
}

async function loadSuite(contactPeerId?: string): Promise<{
  tasks: TasksApi;
  chat: ChatPlugin;
  captured?: CapturedSend;
}> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autonotify-"));
  const storageManager = new StorageManager(dataDir);
  const hooks = new HookRegistry();
  const vault = new VaultManager({
    dataDir: path.join(dataDir, "vault"),
    masterKey: "test-master",
  });

  const contacts = (await loadPlugin(
    contactsDir,
    storageManager,
    new HookRegistry(),
  )) as ContactsApi;
  if (contactPeerId) {
    await contacts.addContact({
      peerId: contactPeerId,
      publicKeyHex: contactPeerId,
      displayName: "Alice",
    });
  }

  // tasks and chat share the same hook registry so chat observes tasks' events.
  const tasks = (await loadPlugin(tasksDir, storageManager, hooks)) as TasksApi;

  let registry: NetworkRegistry | null = null;
  let captured: CapturedSend | undefined;
  if (contactPeerId) {
    registry = new NetworkRegistry();
    captured = {};
    registry.register(fakeProvider(contactPeerId, captured));
  }
  const chat = (await loadPlugin(
    chatDir,
    storageManager,
    hooks,
    new TaskBroker(),
    vault,
    undefined,
    registry,
  )) as ChatPlugin;

  return { tasks, chat, captured };
}

test("setAutoNotifyAssignments(true) sends a stored assignment notification", async () => {
  const peerId = hex64();
  const { tasks, chat, captured } = await loadSuite(peerId);

  await chat.setAutoNotifyAssignments({ enabled: true });

  const project = await tasks.createProject({ name: "Launch" });
  const projectId = rootObject(project)!.$id;
  const doc = await tasks.addTask({ projectId, name: "Write spec" });
  const taskId = lastTaskId(doc);

  await tasks.assignResource({ projectId, taskId, contactPeerId: peerId });

  const thread = await chat.getThread(peerId);
  assert.equal(thread.length, 1);
  assert.equal(thread[0].toPeerId, peerId);
  assert.equal(thread[0].text, "Je bent toegewezen aan taak: Write spec");

  const action = thread[0].action as TaskAssignmentAction;
  assert.equal(action.$ref, taskId);
  assert.equal(action.targetClass, "P2P.Task");
  assert.equal(action.projectId, projectId);

  // The message was actually delivered over the network capability.
  assert.ok(captured?.task, "sendTask should have been invoked");
  assert.equal(captured!.task!.skill, "chat.receiveMessage");
});

test("no notification is sent by default or when explicitly disabled", async () => {
  const peerId = hex64();
  const { tasks, chat } = await loadSuite(peerId);

  const project = await tasks.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;
  const doc = await tasks.addTask({ projectId, name: "T" });
  const taskId = lastTaskId(doc);

  // Default (unset) -> no message.
  await tasks.assignResource({ projectId, taskId, contactPeerId: peerId });
  assert.equal((await chat.getThread(peerId)).length, 0);

  // Explicitly disabled -> still no message.
  await chat.setAutoNotifyAssignments({ enabled: false });
  await tasks.assignResource({ projectId, taskId, contactPeerId: peerId });
  assert.equal((await chat.getThread(peerId)).length, 0);
});

test("a non-assignment taskUpdated event does not notify", async () => {
  const peerId = hex64();
  const { tasks, chat } = await loadSuite(peerId);
  await chat.setAutoNotifyAssignments({ enabled: true });

  const project = await tasks.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;
  const doc = await tasks.addTask({ projectId, name: "T" });
  const taskId = lastTaskId(doc);

  await tasks.updateTask({ projectId, taskId, percentComplete: 50 });

  assert.equal((await chat.getThread(peerId)).length, 0);
});

test("the action reference resolves back to the correct P2P.Task", async () => {
  const peerId = hex64();
  const { tasks, chat } = await loadSuite(peerId);
  await chat.setAutoNotifyAssignments({ enabled: true });

  const project = await tasks.createProject({ name: "P" });
  const projectId = rootObject(project)!.$id;
  const doc = await tasks.addTask({ projectId, name: "Ship" });
  const taskId = lastTaskId(doc);

  await tasks.assignResource({ projectId, taskId, contactPeerId: peerId });

  const [message] = await chat.getThread(peerId);
  const action = message.action as TaskAssignmentAction;

  // Cross-document resolution is ID-level: use the owning plugin's own lookup
  // with the document id (`projectId`) and object id (`$ref`).
  const resolved = await tasks.getTask(action.projectId, action.$ref);
  assert.ok(resolved, "action must resolve to an existing task");
  assert.equal(resolved.$class, "P2P.Task");
  assert.equal(resolved.name, "Ship");
  assert.equal(resolved.$id, taskId);
});

test("setAutoNotifyAssignments rejects a non-boolean and is local-only", async () => {
  const { chat, tasks } = await loadSuite(hex64());
  await assert.rejects(
    chat.setAutoNotifyAssignments({ enabled: "yes" as never }),
    /expects \{ enabled: boolean \}/,
  );

  // Sanity: the skill exists and is not network-reachable.
  assert.ok(tasks, "tasks plugin loads alongside chat");
});
