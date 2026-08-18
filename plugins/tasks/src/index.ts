import type { PluginContext } from "@p2p-hub/core";
import {
  addObject,
  createDocument,
  isPBXDocument,
  linkObject,
  resolveRef,
  rootObject,
  type PBXDocument,
  type PBXObject,
  type PBXReference,
} from "@p2p-hub/sdk";

/**
 * SmartTasks — an MSPDI-inspired project/task model on the PBX/OLE standard.
 *
 * Every project is a {@link PBXDocument} whose root is a `P2P.Project` linking
 * to `P2P.Task` children via `$ref`. Task fields mirror MSPDI 1-op-1:
 * `name`, `start`/`finish` (ISO 8601), `durationDays`, `percentComplete`
 * (0-100), a `predecessors` list of inline `{ taskId, type, lagDays }`
 * dependencies, and `resourceAssignments` — OLE `$ref` pointers to `P2P.Contact`
 * objects imported from the contacts plugin.
 *
 * All skills are `localOnly` — nothing here is reachable over the network or
 * the HTTP bridge. There is deliberately no MSPDI-XML (`.mpp`) import/export
 * here; that belongs in a separate bridge plugin.
 */

export type DependencyType = "FS" | "SS" | "FF" | "SF";

/** An inline predecessor dependency (a `P2P.Task.predecessors` entry). */
export interface Predecessor {
  taskId: string;
  type: DependencyType;
  lagDays: number;
}

export interface CreateProjectInput {
  name: string;
}

export interface AddTaskInput {
  projectId: string;
  name: string;
  start?: string;
  finish?: string;
  durationDays?: number;
  percentComplete?: number;
}

export interface UpdateTaskInput {
  projectId: string;
  taskId: string;
  name?: string;
  start?: string;
  finish?: string;
  durationDays?: number;
  percentComplete?: number;
}

export interface SetDependencyInput {
  projectId: string;
  taskId: string;
  predecessorTaskId: string;
  type?: DependencyType;
  lagDays?: number;
}

export interface AssignResourceInput {
  projectId: string;
  taskId: string;
  contactPeerId: string;
}

export interface TasksPlugin {
  createProject(input: CreateProjectInput): Promise<PBXDocument>;
  getProject(projectId: string): Promise<PBXDocument | null>;
  listProjects(): Promise<PBXDocument[]>;
  addTask(input: AddTaskInput): Promise<PBXDocument>;
  getTask(projectId: string, taskId: string): Promise<PBXObject | null>;
  listTasks(projectId: string): Promise<PBXObject[]>;
  updateTask(input: UpdateTaskInput): Promise<PBXDocument>;
  setDependency(input: SetDependencyInput): Promise<PBXDocument>;
  assignResource(input: AssignResourceInput): Promise<PBXDocument>;
}

const PROJECT_CLASS = "P2P.Project";
const TASK_CLASS = "P2P.Task";
const CONTACT_CLASS = "P2P.Contact";
const PROJECT_KEY_PREFIX = "project:";
const CONTACT_BOOK_KEY = "contactBook";
const DEPENDENCY_TYPES: ReadonlySet<string> = new Set(["FS", "SS", "FF", "SF"]);

function projectKey(projectId: string): string {
  return `${PROJECT_KEY_PREFIX}${projectId}`;
}

function isIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

export default function activate(ctx: PluginContext): TasksPlugin {
  async function getProject(projectId: string): Promise<PBXDocument | null> {
    const value = await ctx.storage.get(projectKey(projectId));
    return isPBXDocument(value) ? value : null;
  }

  async function saveProject(
    projectId: string,
    doc: PBXDocument,
  ): Promise<void> {
    const root = rootObject(doc);
    if (root) {
      root.updatedAt = new Date().toISOString();
    }
    await ctx.storage.set(projectKey(projectId), doc);
  }

  async function listProjects(): Promise<PBXDocument[]> {
    const keys = await ctx.storage.list(PROJECT_KEY_PREFIX);
    const projects: PBXDocument[] = [];
    for (const key of keys) {
      const value = await ctx.storage.get(key);
      if (isPBXDocument(value)) {
        projects.push(value);
      }
    }
    return projects;
  }

  function taskRefs(doc: PBXDocument): PBXReference[] {
    const root = rootObject(doc);
    const refs = root?.tasks;
    return Array.isArray(refs) ? (refs as PBXReference[]) : [];
  }

  function findTask(doc: PBXDocument, taskId: string): PBXObject | null {
    for (const ref of taskRefs(doc)) {
      const obj = resolveRef(doc, ref);
      if (obj && obj.$id === taskId) {
        return obj;
      }
    }
    return null;
  }

  function listTaskObjects(doc: PBXDocument): PBXObject[] {
    const out: PBXObject[] = [];
    for (const ref of taskRefs(doc)) {
      const obj = resolveRef(doc, ref);
      if (obj) {
        out.push(obj);
      }
    }
    return out;
  }

  function predecessorsOf(task: PBXObject): string[] {
    const preds = task.predecessors;
    if (!Array.isArray(preds)) {
      return [];
    }
    return preds
      .map((p) => (p as { taskId?: unknown }).taskId)
      .filter((id): id is string => typeof id === "string");
  }

  /**
   * True if adding the edge `predecessorTaskId -> taskId` ("taskId depends on
   * predecessorTaskId") would close a cycle. That happens when taskId is
   * already a transitive predecessor of predecessorTaskId — i.e. walking
   * backwards from predecessorTaskId along its predecessors reaches taskId.
   *
   * Iterative (explicit stack + visited set) on purpose: a long linear chain
   * of thousands of tasks must not overflow the call stack.
   */
  function wouldCreateCycle(
    doc: PBXDocument,
    taskId: string,
    predecessorTaskId: string,
  ): boolean {
    if (taskId === predecessorTaskId) {
      return true;
    }
    const stack: string[] = [predecessorTaskId];
    const visited = new Set<string>();
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === taskId) {
        return true;
      }
      if (visited.has(id)) {
        continue;
      }
      visited.add(id);
      const task = findTask(doc, id);
      if (!task) {
        continue;
      }
      for (const predId of predecessorsOf(task)) {
        if (!visited.has(predId)) {
          stack.push(predId);
        }
      }
    }
    return false;
  }

  /** Validate a task field patch, returning a normalized copy of valid fields. */
  function validatePatch(input: {
    name?: unknown;
    start?: unknown;
    finish?: unknown;
    durationDays?: unknown;
    percentComplete?: unknown;
  }): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (typeof input.name === "string") {
      const name = input.name.trim();
      if (!name) {
        throw new Error("task name must be a non-empty string");
      }
      out.name = name;
    }
    if (input.start !== undefined) {
      if (typeof input.start !== "string" || !isIsoDate(input.start)) {
        throw new Error("start must be an ISO 8601 date string");
      }
      out.start = input.start;
    }
    if (input.finish !== undefined) {
      if (typeof input.finish !== "string" || !isIsoDate(input.finish)) {
        throw new Error("finish must be an ISO 8601 date string");
      }
      out.finish = input.finish;
    }
    if (input.durationDays !== undefined) {
      if (
        typeof input.durationDays !== "number" ||
        !Number.isFinite(input.durationDays) ||
        input.durationDays < 0
      ) {
        throw new Error("durationDays must be a non-negative number");
      }
      out.durationDays = input.durationDays;
    }
    if (input.percentComplete !== undefined) {
      if (
        typeof input.percentComplete !== "number" ||
        !Number.isFinite(input.percentComplete) ||
        input.percentComplete < 0 ||
        input.percentComplete > 100
      ) {
        throw new Error("percentComplete must be a number between 0 and 100");
      }
      out.percentComplete = input.percentComplete;
    }
    return out;
  }

  function assertChronology(start: unknown, finish: unknown): void {
    if (typeof start !== "string" || typeof finish !== "string") {
      return;
    }
    if (Date.parse(finish) < Date.parse(start)) {
      throw new Error("finish must not be before start");
    }
  }

  async function createProject(input: CreateProjectInput): Promise<PBXDocument> {
    const name = (input?.name ?? "").trim();
    if (!name) {
      throw new Error("createProject: name must not be empty");
    }
    const now = new Date().toISOString();
    const doc = createDocument(PROJECT_CLASS, {
      name,
      createdAt: now,
      updatedAt: now,
      tasks: [],
    });
    const root = rootObject(doc)!;
    await ctx.storage.set(projectKey(root.$id), doc);
    return doc;
  }

  async function addTask(input: AddTaskInput): Promise<PBXDocument> {
    const { projectId } = (input ?? {}) as { projectId?: unknown };
    if (typeof projectId !== "string") {
      throw new Error("addTask: projectId is required");
    }
    const name = (input as AddTaskInput)?.name;
    if (typeof name !== "string" || !name.trim()) {
      throw new Error("addTask: name must be a non-empty string");
    }

    const patch = validatePatch(
      (input ?? {}) as {
        name?: unknown;
        start?: unknown;
        finish?: unknown;
        durationDays?: unknown;
        percentComplete?: unknown;
      },
    );
    assertChronology(patch.start, patch.finish);

    const doc = await getProject(projectId);
    if (!doc) {
      throw new Error(`addTask: project "${projectId}" not found`);
    }

    const taskId = addObject(doc, TASK_CLASS, {
      ...patch,
      predecessors: [],
      resourceAssignments: [],
    });
    const root = rootObject(doc);
    const refs = taskRefs(doc);
    refs.push(linkObject(doc, taskId));
    if (root) {
      root.tasks = refs;
    }

    await saveProject(projectId, doc);
    await ctx.hooks.emit("tasks:taskUpdated", {
      projectId,
      taskId,
      action: "addTask",
    });
    return doc;
  }

  async function getTask(
    projectId: string,
    taskId: string,
  ): Promise<PBXObject | null> {
    const doc = await getProject(projectId);
    if (!doc) {
      return null;
    }
    return findTask(doc, taskId);
  }

  async function listTasks(projectId: string): Promise<PBXObject[]> {
    const doc = await getProject(projectId);
    if (!doc) {
      return [];
    }
    return listTaskObjects(doc);
  }

  async function updateTask(input: UpdateTaskInput): Promise<PBXDocument> {
    const { projectId, taskId } = (input ?? {}) as {
      projectId?: unknown;
      taskId?: unknown;
    };
    if (typeof projectId !== "string" || typeof taskId !== "string") {
      throw new Error("updateTask: projectId and taskId are required");
    }

    const doc = await getProject(projectId);
    if (!doc) {
      throw new Error(`updateTask: project "${projectId}" not found`);
    }
    const task = findTask(doc, taskId);
    if (!task) {
      throw new Error(`updateTask: task "${taskId}" not found`);
    }

    const patch = validatePatch(
      (input ?? {}) as {
        name?: unknown;
        start?: unknown;
        finish?: unknown;
        durationDays?: unknown;
        percentComplete?: unknown;
      },
    );
    for (const key of [
      "name",
      "start",
      "finish",
      "durationDays",
      "percentComplete",
    ] as const) {
      if (patch[key] !== undefined) {
        task[key] = patch[key];
      }
    }
    assertChronology(task.start, task.finish);

    await saveProject(projectId, doc);
    await ctx.hooks.emit("tasks:taskUpdated", {
      projectId,
      taskId,
      action: "updateTask",
    });
    return doc;
  }

  async function setDependency(input: SetDependencyInput): Promise<PBXDocument> {
    const { projectId, taskId, predecessorTaskId } = (input ?? {}) as {
      projectId?: unknown;
      taskId?: unknown;
      predecessorTaskId?: unknown;
    };
    if (
      typeof projectId !== "string" ||
      typeof taskId !== "string" ||
      typeof predecessorTaskId !== "string"
    ) {
      throw new Error(
        "setDependency: projectId, taskId and predecessorTaskId are required",
      );
    }

    const type = ((input as SetDependencyInput)?.type ?? "FS") as DependencyType;
    if (typeof type !== "string" || !DEPENDENCY_TYPES.has(type)) {
      throw new Error("setDependency: type must be one of FS, SS, FF, SF");
    }
    const lagDays = (input as SetDependencyInput)?.lagDays ?? 0;
    if (typeof lagDays !== "number" || !Number.isFinite(lagDays)) {
      throw new Error("setDependency: lagDays must be a number");
    }

    const doc = await getProject(projectId);
    if (!doc) {
      throw new Error(`setDependency: project "${projectId}" not found`);
    }
    const task = findTask(doc, taskId);
    if (!task) {
      throw new Error(`setDependency: task "${taskId}" not found`);
    }
    const predecessor = findTask(doc, predecessorTaskId);
    if (!predecessor) {
      throw new Error(
        `setDependency: predecessor task "${predecessorTaskId}" not found`,
      );
    }

    const predecessors = Array.isArray(task.predecessors)
      ? (task.predecessors as Predecessor[])
      : [];
    const existing = predecessors.find((p) => p.taskId === predecessorTaskId);
    if (existing) {
      // Idempotent re-add: refresh type/lagDays, keep the edge single.
      existing.type = type;
      existing.lagDays = lagDays;
    } else {
      if (wouldCreateCycle(doc, taskId, predecessorTaskId)) {
        throw new Error("setDependency: dependency would create a cycle");
      }
      predecessors.push({ taskId: predecessorTaskId, type, lagDays });
    }
    task.predecessors = predecessors;

    await saveProject(projectId, doc);
    await ctx.hooks.emit("tasks:taskUpdated", {
      projectId,
      taskId,
      action: "setDependency",
    });
    return doc;
  }

  function findContactInBook(book: unknown, peerId: string): PBXObject | null {
    if (!isPBXDocument(book)) {
      return null;
    }
    const refs = rootObject(book)?.contacts;
    if (!Array.isArray(refs)) {
      return null;
    }
    for (const ref of refs as PBXReference[]) {
      const obj = resolveRef(book, ref);
      if (obj && obj.peerId === peerId) {
        return obj;
      }
    }
    return null;
  }

  async function assignResource(input: AssignResourceInput): Promise<PBXDocument> {
    const { projectId, taskId, contactPeerId } = (input ?? {}) as {
      projectId?: unknown;
      taskId?: unknown;
      contactPeerId?: unknown;
    };
    if (
      typeof projectId !== "string" ||
      typeof taskId !== "string" ||
      typeof contactPeerId !== "string"
    ) {
      throw new Error(
        "assignResource: projectId, taskId and contactPeerId are required",
      );
    }

    const doc = await getProject(projectId);
    if (!doc) {
      throw new Error(`assignResource: project "${projectId}" not found`);
    }
    const task = findTask(doc, taskId);
    if (!task) {
      throw new Error(`assignResource: task "${taskId}" not found`);
    }

    const contactsStore = ctx.readStorageOf("contacts");
    if (!contactsStore) {
      throw new Error("assignResource: no read access to contacts storage");
    }
    const book = await contactsStore.get(CONTACT_BOOK_KEY);
    const contact = findContactInBook(book, contactPeerId);
    if (!contact) {
      throw new Error(`assignResource: contact "${contactPeerId}" not found`);
    }

    // Import the contact as a P2P.Contact node in this document so the OLE
    // `$ref` actually resolves here; keep `peerId` for cross-plugin identity.
    const contactId = addObject(doc, CONTACT_CLASS, { ...contact });

    const assignments = Array.isArray(task.resourceAssignments)
      ? (task.resourceAssignments as PBXReference[])
      : [];
    assignments.push(linkObject(doc, contactId));
    task.resourceAssignments = assignments;

    await saveProject(projectId, doc);
    await ctx.hooks.emit("tasks:taskUpdated", {
      projectId,
      taskId,
      taskName: String(task.name),
      contactPeerId,
      action: "assignResource",
    });
    return doc;
  }

  ctx.skills.register(
    "createProject",
    async (payload) => createProject(payload as CreateProjectInput),
    { localOnly: true },
  );

  ctx.skills.register(
    "getProject",
    async (payload) => {
      const { projectId } = (payload ?? {}) as { projectId?: unknown };
      if (typeof projectId !== "string") {
        throw new Error("getProject expects { projectId: string }");
      }
      return getProject(projectId);
    },
    { localOnly: true },
  );

  ctx.skills.register(
    "listProjects",
    async () => listProjects(),
    { localOnly: true },
  );

  ctx.skills.register(
    "addTask",
    async (payload) => addTask(payload as AddTaskInput),
    { localOnly: true },
  );

  ctx.skills.register(
    "getTask",
    async (payload) => {
      const { projectId, taskId } = (payload ?? {}) as {
        projectId?: unknown;
        taskId?: unknown;
      };
      if (typeof projectId !== "string" || typeof taskId !== "string") {
        throw new Error("getTask expects { projectId: string, taskId: string }");
      }
      return getTask(projectId, taskId);
    },
    { localOnly: true },
  );

  ctx.skills.register(
    "listTasks",
    async (payload) => {
      const { projectId } = (payload ?? {}) as { projectId?: unknown };
      if (typeof projectId !== "string") {
        throw new Error("listTasks expects { projectId: string }");
      }
      return listTasks(projectId);
    },
    { localOnly: true },
  );

  ctx.skills.register(
    "updateTask",
    async (payload) => updateTask(payload as UpdateTaskInput),
    { localOnly: true },
  );

  ctx.skills.register(
    "setDependency",
    async (payload) => setDependency(payload as SetDependencyInput),
    { localOnly: true },
  );

  ctx.skills.register(
    "assignResource",
    async (payload) => assignResource(payload as AssignResourceInput),
    { localOnly: true },
  );

  return {
    createProject,
    getProject,
    listProjects,
    addTask,
    getTask,
    listTasks,
    updateTask,
    setDependency,
    assignResource,
  };
}
