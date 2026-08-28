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
import {
  calculateCriticalPath,
  calculateProjectCapacity,
  type CriticalPath,
  type ProjectCapacity,
  type TaskLike,
  type TimeEntryLike,
} from "./computations";
import {
  COMPLETION_PROOF_DOMAIN_PREFIX,
  type TaskCompletionProof,
  type TaskDelegation,
} from "./types";

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
 * SmartProjects v1 adds a collaboration model on top:
 *
 *  - `P2P.Project.members` (peerIds) — the document-level access list. The
 *    owner (the operator who created the project) is always a member; every
 *    mutation — local or remote — is routed through a per-project FIFO queue
 *    so the project is a single-writer, ordered store (a `mutationSeq` on the
 *    root records the applied order).
 *  - `P2P.Task.status` (`todo`/`in-progress`/`done`/`blocked`) with
 *    `P2P.Task.parentTaskId?` for a task tree; marking a task `done` cascades
 *    `done` to every descendant.
 *  - `P2P.TimeEntry` inline time-tracking (`task.timeEntries`), and a
 *    `P2P.Project.noteRef` OLE pointer to an attached notepad note.
 *  - A network skill `tasks.requestMutation` (`localOnly: false`,
 *    `network:skill:tasks.requestMutation`): a *member* peer sends a
 *    `P2P.ProjectMutationRequest` which the owner applies to current state in
 *    FIFO arrival order. The broker's `verified-contact` gate is the
 *    contact-level check; the handler re-checks `members` (document-level).
 *    The transport-verified `context.peerId` is the sender identity — never a
 *    caller-supplied payload field.
 *  - Per-project remote event topics `tasks:project:<projectId>:updated`,
 *    exposed via the manifest pattern `tasks:project:*` and gated per-peer by
 *    a subscription guard (`ctx.events.registerSubscriptionGuard`) at subscribe
 *    time AND again before each emit to an already-subscribed peer.
 *
 * SmartProjects v1.1 adds the collaboration/capacity layer:
 *
 *  - `P2P.Task.dependencies` (task ids that must be `done` before this task can
 *    be started or completed) with a fail-closed **dependency guard**
 *    (`assertCanStart`/`assertCanComplete`): a task with an unfinished
 *    dependency can never move to `in-progress`/`done`, on the local write path
 *    and the `requestMutation` path alike. The guard also applies to the
 *    parent-completion cascade, so marking a parent `done` can never smuggle an
 *    unfinished dependency to `done` through a descendant. `dependencies` and
 *    the MSPDI `predecessors` stay a single graph — both write paths
 *    (`setDependency`, `setDependencies`) keep them in sync.
 *  - **Delegation handshake**: `P2P.Task.delegation` (`assignedTo`, status
 *    pending/accepted/declined). The owner assigns via `delegateTask` (which
 *    also adds the delegatee as a member — the handshake runs through the
 *    member-only `requestMutation` surface); the delegatee accepts or declines
 *    via `ACCEPT_DELEGATION`/`DECLINE_DELEGATION`. The transport-verified
 *    `context.peerId` must equal `delegation.assignedTo` — no caller-supplied
 *    field can accept on someone else's behalf.
 *  - **Proof of completion**: an accepted delegatee generates a
 *    `TaskCompletionProof` by signing
 *    `COMPLETION_PROOF_DOMAIN_PREFIX + "<taskId>:<projectId>:<timestamp>"`
 *    with its own identity (`signCompletionProof`, domain separation is
 *    structural — see `types.ts`). The owner verifies the signature with
 *    `ctx.identity.verify` in the same domain before marking the task `done`
 *    (`SUBMIT_COMPLETION_PROOF`). A signature minted in any other domain, or
 *    over a payload for a different task/project/timestamp, fails closed.
 *  - **Pure computations** (`computations.ts`): `calculateCriticalPath`
 *    (longest dependency chain by `durationDays`/`estimatedHours`) and
 *    `calculateProjectCapacity` (estimated vs spent hours per peer/project with
 *    the 8h/peer/day warning), exposed read-only via `getCriticalPath`/
 *    `getCapacity`. No network side-effects, no background timers.
 *  - A **plugin UI** (`src/ui/`, served at `/ui/tasks/*`) that drives all of
 *    this through the shell bridge. The UI-reachable skills are registered
 *    `httpBridgeOnly` — a local operator privilege, structurally never
 *    reachable over the network (CLAUDE.md "httpBridgeOnly" section).
 *
 * All other skills stay `localOnly` — nothing else here is reachable over the
 * network or the HTTP bridge. There is deliberately no MSPDI-XML (`.mpp`)
 * import/export here; that belongs in a separate bridge plugin.
 */

export type DependencyType = "FS" | "SS" | "FF" | "SF";

export type TaskStatus = "todo" | "in-progress" | "done" | "blocked";

export type ProjectMutationType =
  | "CREATE_SUBTASK"
  | "MOVE_TASK"
  | "UPDATE_STATUS"
  | "LOG_TIME"
  | "ACCEPT_DELEGATION"
  | "DECLINE_DELEGATION"
  | "SUBMIT_COMPLETION_PROOF"
  | "SET_DEPENDENCIES";

/** An inline predecessor dependency (a `P2P.Task.predecessors` entry). */
export interface Predecessor {
  taskId: string;
  type: DependencyType;
  lagDays: number;
}

/** An inline time-tracking entry on a task (`P2P.Task.timeEntries`). */
export interface TimeEntry {
  taskId: string;
  peerId: string;
  start: string;
  end: string;
}

export interface CreateProjectInput {
  name: string;
  budgetCents?: number;
}

export interface AddTaskInput {
  projectId: string;
  name: string;
  parentTaskId?: string;
  status?: TaskStatus;
  start?: string;
  finish?: string;
  durationDays?: number;
  percentComplete?: number;
  estimatedHours?: number;
}

export interface UpdateTaskInput {
  projectId: string;
  taskId: string;
  name?: string;
  status?: TaskStatus;
  parentTaskId?: string | null;
  start?: string;
  finish?: string;
  durationDays?: number;
  percentComplete?: number;
  estimatedHours?: number;
}

/** Replace the whole dependency block-list of a task (owner/local skill). */
export interface SetDependenciesInput {
  projectId: string;
  taskId: string;
  /** Task ids that must be `done` before `taskId` can start/complete. */
  dependencyIds: string[];
}

/** Assign a task to a network peer for explicit acceptance (owner skill). */
export interface DelegateTaskInput {
  projectId: string;
  taskId: string;
  /** The transport identity of the peer to delegate to. */
  peerId: string;
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

export interface AddMemberInput {
  projectId: string;
  peerId: string;
}

export interface AssignAgentInput {
  projectId: string;
  taskId: string;
  agentPeerId: string;
}

export interface AttachNoteInput {
  projectId: string;
  noteId: string;
}

export interface UpdateBudgetInput {
  projectId: string;
  budgetCents?: number;
  spentCents?: number;
}

/**
 * A single proposed change from the AI planner. The UI applies it through the
 * explicit mutation surface (`tasks.requestMutation` for members, the local
 * `tasks.updateTask`/`tasks.addTask` skills for the owner) — the planner never
 * mutates.
 */
export interface PlanStep {
  taskId?: string;
  title: string;
  action: "UPDATE_STATUS" | "CREATE_SUBTASK" | "MOVE_TASK" | "LOG_TIME" | "none";
  payload?: Record<string, unknown>;
}

/** A propose-then-confirm AI proposal. Never applied by the planner itself. */
export interface PlanProposal {
  kind: "day" | "project";
  generatedAt: string;
  goal?: string;
  summary: string;
  steps: PlanStep[];
}

export interface PlanDayInput {
  projectId: string;
  goal?: string;
}

export interface PlanProjectInput {
  projectId: string;
  scope?: string;
}

/**
 * The member → owner project mutation envelope. `peerId` is deliberately NOT a
 * field: the sender identity is always the transport-verified `peerId` the
 * TaskBroker passes to the handler.
 */
export interface ProjectMutationRequest {
  projectId: string;
  type: ProjectMutationType;
  /** The task the mutation targets (the parent task for `CREATE_SUBTASK`). */
  taskId: string;
  payload?: Record<string, unknown>;
}

export type MutationResult =
  | { ok: true; projectId: string; mutationSeq: number; action: string }
  | { ok: false; error: string };

export type PlanResult =
  | { ok: true; proposal: PlanProposal }
  | { ok: false; error: string };

export interface TasksPlugin {
  createProject(input: CreateProjectInput): Promise<PBXDocument>;
  getProject(projectId: string): Promise<PBXDocument | null>;
  listProjects(): Promise<PBXDocument[]>;
  addTask(input: AddTaskInput): Promise<PBXDocument>;
  getTask(projectId: string, taskId: string): Promise<PBXObject | null>;
  listTasks(projectId: string): Promise<PBXObject[]>;
  updateTask(input: UpdateTaskInput): Promise<PBXDocument>;
  setDependency(input: SetDependencyInput): Promise<PBXDocument>;
  /** Replace the whole dependency block-list of a task (cycle + existence checked). */
  setDependencies(input: SetDependenciesInput): Promise<PBXDocument>;
  /** Delegate a task to a peer (also makes them a member so the handshake works). */
  delegateTask(input: DelegateTaskInput): Promise<PBXDocument>;
  /**
   * Sign a completion proof for `taskId`/`projectId`/`timestamp` with the local
   * identity, in the tasks completion-proof domain. Call this on the *delegatee's*
   * node; the owner verifies the result before marking the task done.
   */
  signCompletionProof(input: {
    taskId: string;
    projectId: string;
    timestamp: string;
  }): Promise<TaskCompletionProof>;
  /** Read-only capacity computation (pure, see `computations.ts`). */
  getCapacity(projectId: string): Promise<ProjectCapacity>;
  /** Read-only critical-path computation (pure, see `computations.ts`). */
  getCriticalPath(projectId: string): Promise<CriticalPath>;
  assignResource(input: AssignResourceInput): Promise<PBXDocument>;
  addMember(input: AddMemberInput): Promise<PBXDocument>;
  updateBudget(input: UpdateBudgetInput): Promise<PBXDocument>;
  attachNote(input: AttachNoteInput): Promise<PBXDocument>;
  assignAgent(
    input: AssignAgentInput,
  ): Promise<{ ok: boolean; projectId: string; taskId: string; agentPeerId: string }>;
  planDay(input: PlanDayInput): Promise<PlanResult>;
  planProject(input: PlanProjectInput): Promise<PlanResult>;
  /** Apply a member's mutation request as the owner, in FIFO per-project order. */
  requestMutation(
    input: ProjectMutationRequest & { senderPeerId: string },
  ): Promise<MutationResult>;
}

const PROJECT_CLASS = "P2P.Project";
const TASK_CLASS = "P2P.Task";
const CONTACT_CLASS = "P2P.Contact";
const EMBEDDED_CLASS = "P2P.EmbeddedObject";
const PROJECT_KEY_PREFIX = "project:";
const CONTACT_BOOK_KEY = "contactBook";
const NOTE_KEY_PREFIX = "note:";
const DEPENDENCY_TYPES: ReadonlySet<string> = new Set(["FS", "SS", "FF", "SF"]);
const TASK_STATUSES: ReadonlySet<string> = new Set([
  "todo",
  "in-progress",
  "done",
  "blocked",
]);
const MUTATION_TYPES: ReadonlySet<string> = new Set([
  "CREATE_SUBTASK",
  "MOVE_TASK",
  "UPDATE_STATUS",
  "LOG_TIME",
  "ACCEPT_DELEGATION",
  "DECLINE_DELEGATION",
  "SUBMIT_COMPLETION_PROOF",
  "SET_DEPENDENCIES",
]);
const PROJECT_TOPIC_PREFIX = "tasks:project:";
/**
 * The charset a project id must match before it is embedded in an event topic
 * string (mirrors the topic-segment charset of core's `EVENT_TOPIC_RE`, and the
 * plugin-id validation pattern): a `:` can never smuggle a fake delimiter into
 * a topic, so `tasks:project:<id>:updated` can never collide with another
 * project's topic (CLAUDE.md principle #2).
 */
const TOPIC_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function projectKey(projectId: string): string {
  return `${PROJECT_KEY_PREFIX}${projectId}`;
}

function isIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/** Per-project FIFO mutation queue (see module doc for the single-writer model). */
function projectQueue() {
  const queues = new Map<string, Promise<unknown>>();
  return function enqueueProjectMutation<T>(
    projectId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous = queues.get(projectId) ?? Promise.resolve();
    // `run` starts after the previous entry settles (success OR failure), so a
    // failed mutation never poisons the chain; the tail swallows rejections so
    // the queue keeps accepting new entries.
    const next = previous.then(run, run);
    queues.set(
      projectId,
      next.then(
        () => {},
        () => {},
      ),
    );
    return next;
  };
}

export default function activate(ctx: PluginContext): TasksPlugin {
  const enqueueProjectMutation = projectQueue();

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

  async function getTask(projectId: string, taskId: string): Promise<PBXObject | null> {
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

  function childrenOf(doc: PBXDocument, parentId: string): PBXObject[] {
    return listTaskObjects(doc).filter((t) => t.parentTaskId === parentId);
  }

  function isMember(doc: PBXDocument, peerId: string): boolean {
    const members = rootObject(doc)?.members;
    return Array.isArray(members) && members.includes(peerId);
  }

  function addMemberToList(doc: PBXDocument, peerId: string): boolean {
    const root = rootObject(doc);
    const members = Array.isArray(root?.members)
      ? (root.members as string[])
      : [];
    if (members.includes(peerId)) {
      return false;
    }
    members.push(peerId);
    root!.members = members;
    return true;
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
   * The block-list the dependency guard and critical path operate on: the
   * `dependencies` field when present, else (v1.0 legacy docs) the predecessor
   * ids. Both write paths keep `dependencies`/`predecessors` in sync, so these
   * agree in practice; the fallback keeps pre-v1.1 data guarded too.
   */
  function dependenciesOf(task: PBXObject): string[] {
    if (Array.isArray(task.dependencies)) {
      return (task.dependencies as unknown[]).filter(
        (id): id is string => typeof id === "string",
      );
    }
    return predecessorsOf(task);
  }

  /**
   * Keep `dependencies` (simple block-list) and `predecessors` (MSPDI edges
   * with type/lagDays) as a single graph: writing one updates both. Existing
   * predecessors keep their type/lagDays; new ids get the MSPDI default FS/0.
   */
  function syncDependencyFields(task: PBXObject, ids: string[]): void {
    task.dependencies = [...ids];
    const byId = new Map<string, Predecessor>();
    const existing = Array.isArray(task.predecessors)
      ? (task.predecessors as Predecessor[])
      : [];
    for (const p of existing) {
      byId.set(p.taskId, p);
    }
    task.predecessors = ids.map(
      (id) => byId.get(id) ?? { taskId: id, type: "FS", lagDays: 0 },
    );
  }

  /**
   * True if replacing `taskId`'s dependencies with `newDependencyIds` would
   * close a cycle anywhere in the dependency graph. Iterative DFS over the
   * whole document with `taskId`'s edges overridden — robust against prior
   * state and defensive about long graphs (no recursion stack overflow).
   */
  function wouldCreateDependencyCycle(
    doc: PBXDocument,
    taskId: string,
    newDependencyIds: string[],
  ): boolean {
    const adjacency = new Map<string, string[]>();
    for (const t of listTaskObjects(doc)) {
      adjacency.set(
        t.$id,
        t.$id === taskId ? [...newDependencyIds] : dependenciesOf(t),
      );
    }
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    for (const id of adjacency.keys()) {
      if ((color.get(id) ?? WHITE) !== WHITE) {
        continue;
      }
      const stack: string[] = [id];
      while (stack.length > 0) {
        const node = stack[stack.length - 1];
        const state = color.get(node) ?? WHITE;
        if (state === WHITE) {
          color.set(node, GRAY);
          for (const dep of adjacency.get(node) ?? []) {
            const depState = color.get(dep) ?? WHITE;
            if (depState === GRAY) {
              return true;
            }
            if (depState === WHITE) {
              stack.push(dep);
            }
          }
        } else {
          color.set(node, BLACK);
          stack.pop();
        }
      }
    }
    return false;
  }

  /**
   * The dependencies of `task` that are NOT `done`. A missing dependency task
   * counts as blocking (fail-closed): the write paths validate existence, so
   * this only ever triggers on inconsistent/corrupt data.
   */
  function blockingDependencies(doc: PBXDocument, task: PBXObject): string[] {
    return dependenciesOf(task).filter((id) => {
      const dep = findTask(doc, id);
      return !dep || dep.status !== "done";
    });
  }

  /** The dependency guard's first half: block moving to `in-progress`. */
  function assertCanStart(doc: PBXDocument, task: PBXObject): void {
    const blocking = blockingDependencies(doc, task);
    if (blocking.length > 0) {
      throw new Error(
        `Invalid Dependency State: cannot start "${String(task.name ?? task.$id)}" ` +
          `while unfinished dependencies remain: ${blocking.join(", ")}`,
      );
    }
  }

  /**
   * The dependency guard's second half: block moving to `done`. Walks the whole
   * subtree (task + descendants) so the parent-completion cascade can never
   * smuggle a descendant with an unfinished dependency to `done`.
   */
  function assertCanComplete(doc: PBXDocument, task: PBXObject): void {
    const stack = [task.$id];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const node = findTask(doc, id);
      if (!node) {
        continue;
      }
      const blocking = blockingDependencies(doc, node);
      if (blocking.length > 0) {
        throw new Error(
          `Invalid Dependency State: cannot complete "${String(node.name ?? id)}" ` +
            `while unfinished dependencies remain: ${blocking.join(", ")}`,
        );
      }
      for (const child of childrenOf(doc, id)) {
        stack.push(child.$id);
      }
    }
  }

  /** Resolve `resourceAssignments` OLE refs to their `peerId`s. */
  function assignedPeerIdsOf(doc: PBXDocument, task: PBXObject): string[] {
    const refs = Array.isArray(task.resourceAssignments)
      ? (task.resourceAssignments as PBXReference[])
      : [];
    const out: string[] = [];
    for (const ref of refs) {
      const obj = resolveRef(doc, ref);
      if (obj && typeof obj.peerId === "string") {
        out.push(obj.peerId);
      }
    }
    return out;
  }

  /**
   * The delegation handshake gate: only the transport-verified assignee can
   * accept/decline/submit on a task — never a caller-supplied payload field.
   */
  function delegateeOf(task: PBXObject, senderPeerId: string): TaskDelegation {
    const delegation = task.delegation as TaskDelegation | undefined;
    if (!delegation || delegation.assignedTo !== senderPeerId) {
      throw new Error(
        `requestMutation: peer "${senderPeerId}" is not the assignee of this task`,
      );
    }
    return delegation;
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

  /**
   * True if making `taskId` a child of `newParentId` would close a parent
   * cycle (newParentId is taskId itself or one of taskId's descendants).
   * Iterative, walking UP the parent chain from newParentId.
   */
  function wouldCreateParentCycle(
    doc: PBXDocument,
    taskId: string,
    newParentId: string | null,
  ): boolean {
    if (newParentId === null) {
      return false;
    }
    let cursor: string | null = newParentId;
    const visited = new Set<string>();
    while (cursor !== null) {
      if (cursor === taskId) {
        return true;
      }
      if (visited.has(cursor)) {
        return false;
      }
      visited.add(cursor);
      const task = findTask(doc, cursor);
      const parent = typeof task?.parentTaskId === "string" ? task.parentTaskId : null;
      cursor = parent;
    }
    return false;
  }

  /** Mark `taskId` and every descendant `done` (parent-completion cascade). */
  function cascadeDone(doc: PBXDocument, taskId: string): void {
    const stack = [taskId];
    const visited = new Set<string>();
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) {
        continue;
      }
      visited.add(id);
      for (const child of childrenOf(doc, id)) {
        child.status = "done";
        stack.push(child.$id);
      }
    }
  }

  /** Validate a task field patch, returning a normalized copy of valid fields. */
  function validatePatch(input: {
    name?: unknown;
    status?: unknown;
    start?: unknown;
    finish?: unknown;
    durationDays?: unknown;
    percentComplete?: unknown;
    estimatedHours?: unknown;
  }): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (typeof input.name === "string") {
      const name = input.name.trim();
      if (!name) {
        throw new Error("task name must be a non-empty string");
      }
      out.name = name;
    }
    if (input.status !== undefined) {
      if (typeof input.status !== "string" || !TASK_STATUSES.has(input.status)) {
        throw new Error(
          "status must be one of todo, in-progress, done, blocked",
        );
      }
      out.status = input.status;
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
    if (input.estimatedHours !== undefined) {
      if (
        typeof input.estimatedHours !== "number" ||
        !Number.isFinite(input.estimatedHours) ||
        input.estimatedHours < 0
      ) {
        throw new Error("estimatedHours must be a non-negative number");
      }
      out.estimatedHours = input.estimatedHours;
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

  function assertTopicSegment(projectId: string): void {
    if (!TOPIC_SEGMENT_RE.test(projectId)) {
      throw new Error(
        `projectId "${projectId}" is not valid in an event topic ` +
          `(allowed: ${TOPIC_SEGMENT_RE})`,
      );
    }
  }

  /** The canonical per-project remote event topic. */
  function projectUpdatedTopic(projectId: string): string {
    assertTopicSegment(projectId);
    return `${PROJECT_TOPIC_PREFIX}${projectId}:updated`;
  }

  /**
   * Best-effort fan-out of a project change to remote member subscribers.
   * Never throws: a non-exposed topic or a missing network must not break the
   * local mutation (the local `tasks:taskUpdated` hook is the authoritative
   * in-process signal).
   */
  async function publishProjectUpdated(
    projectId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      await ctx.events.publishRemote(projectUpdatedTopic(projectId), {
        projectId,
        at: new Date().toISOString(),
        ...detail,
      });
    } catch {
      // Best-effort; see doc comment.
    }
  }

  /** Local hook + remote project event for every applied mutation. */
  async function afterMutation(
    projectId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await ctx.hooks.emit("tasks:taskUpdated", { projectId, ...detail });
    await publishProjectUpdated(projectId, detail);
  }

  /** Bump the per-project ordering ledger on the root. */
  function bumpMutationSeq(doc: PBXDocument): number {
    const root = rootObject(doc)!;
    const next = (typeof root.mutationSeq === "number" ? root.mutationSeq : 0) + 1;
    root.mutationSeq = next;
    return next;
  }

  // ---- owner/local mutators (run inside the per-project FIFO queue) ----

  async function createProject(input: CreateProjectInput): Promise<PBXDocument> {
    const name = (input?.name ?? "").trim();
    if (!name) {
      throw new Error("createProject: name must not be empty");
    }
    const budgetCents = (input as CreateProjectInput)?.budgetCents;
    if (budgetCents !== undefined) {
      if (
        typeof budgetCents !== "number" ||
        !Number.isInteger(budgetCents) ||
        budgetCents < 0
      ) {
        throw new Error("createProject: budgetCents must be a non-negative integer");
      }
    }
    const ownerPeerId = await ctx.identity.peerId();
    const now = new Date().toISOString();
    const doc = createDocument(PROJECT_CLASS, {
      name,
      createdAt: now,
      updatedAt: now,
      tasks: [],
      members: [ownerPeerId],
      mutationSeq: 0,
      ...(budgetCents !== undefined ? { budgetCents } : {}),
    });
    const root = rootObject(doc)!;
    await ctx.storage.set(projectKey(root.$id), doc);
    return doc;
  }

  async function rawAddTask(input: AddTaskInput): Promise<PBXDocument> {
    const { projectId } = input;
    const name = (input as AddTaskInput)?.name;
    if (typeof name !== "string" || !name.trim()) {
      throw new Error("addTask: name must be a non-empty string");
    }

    const patch = validatePatch({
      name,
      status: (input as AddTaskInput)?.status,
      start: (input as AddTaskInput)?.start,
      finish: (input as AddTaskInput)?.finish,
      durationDays: (input as AddTaskInput)?.durationDays,
      percentComplete: (input as AddTaskInput)?.percentComplete,
      estimatedHours: (input as AddTaskInput)?.estimatedHours,
    });
    assertChronology(patch.start, patch.finish);

    const parentTaskId = (input as AddTaskInput)?.parentTaskId;
    const doc = await getProject(projectId);
    if (!doc) {
      throw new Error(`addTask: project "${projectId}" not found`);
    }
    if (parentTaskId !== undefined) {
      if (!findTask(doc, parentTaskId)) {
        throw new Error(`addTask: parent task "${parentTaskId}" not found`);
      }
    }

    const taskId = addObject(doc, TASK_CLASS, {
      ...patch,
      status: patch.status ?? "todo",
      ...(parentTaskId !== undefined ? { parentTaskId } : {}),
      predecessors: [],
      dependencies: [],
      resourceAssignments: [],
      timeEntries: [],
    });
    const root = rootObject(doc);
    const refs = taskRefs(doc);
    refs.push(linkObject(doc, taskId));
    if (root) {
      root.tasks = refs;
    }

    bumpMutationSeq(doc);
    await saveProject(projectId, doc);
    await afterMutation(projectId, {
      taskId,
      action: "addTask",
    });
    return doc;
  }

  async function rawUpdateTask(input: UpdateTaskInput): Promise<PBXDocument> {
    const { projectId, taskId } = input;
    const doc = await getProject(projectId);
    if (!doc) {
      throw new Error(`updateTask: project "${projectId}" not found`);
    }
    const task = findTask(doc, taskId);
    if (!task) {
      throw new Error(`updateTask: task "${taskId}" not found`);
    }

    const patch = validatePatch({
      name: (input as UpdateTaskInput)?.name,
      status: (input as UpdateTaskInput)?.status,
      start: (input as UpdateTaskInput)?.start,
      finish: (input as UpdateTaskInput)?.finish,
      durationDays: (input as UpdateTaskInput)?.durationDays,
      percentComplete: (input as UpdateTaskInput)?.percentComplete,
      estimatedHours: (input as UpdateTaskInput)?.estimatedHours,
    });
    for (const key of [
      "name",
      "status",
      "start",
      "finish",
      "durationDays",
      "percentComplete",
      "estimatedHours",
    ] as const) {
      if (patch[key] !== undefined) {
        task[key] = patch[key];
      }
    }

    // Parent re-parenting (move) with cycle + existence checks.
    const inputParent = (input as UpdateTaskInput)?.parentTaskId;
    if (inputParent !== undefined) {
      const newParent = inputParent === null ? null : inputParent;
      if (newParent !== null) {
        if (!findTask(doc, newParent)) {
          throw new Error(`updateTask: parent task "${newParent}" not found`);
        }
      }
      if (wouldCreateParentCycle(doc, taskId, newParent)) {
        throw new Error("updateTask: moving the task would create a cycle");
      }
      task.parentTaskId = newParent;
    }

    assertChronology(task.start, task.finish);

    // SmartProjects v1.1 dependency guard: a task with an unfinished dependency
    // can never move to `in-progress`/`done`. `done` additionally requires the
    // whole subtree (task + descendants) to be unblocked, so the cascade below
    // can never force an unfinished-dependency descendant to `done`.
    if (patch.status === "in-progress") {
      assertCanStart(doc, task);
    }
    if (patch.status === "done") {
      assertCanComplete(doc, task);
    }

    // Parent-completion rule: a task that becomes `done` closes every
    // descendant. Enforced here (the single write path), never in the UI.
    if (patch.status === "done") {
      cascadeDone(doc, taskId);
    }

    bumpMutationSeq(doc);
    await saveProject(projectId, doc);
    await afterMutation(projectId, {
      taskId,
      action: "updateTask",
    });
    return doc;
  }

  async function rawSetDependency(input: SetDependencyInput): Promise<PBXDocument> {
    const { projectId, taskId, predecessorTaskId } = input;
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
    // Keep the v1.1 block-list (`dependencies`) and the MSPDI predecessors a
    // single graph — the dependency guard and critical path read the former.
    syncDependencyFields(task, predecessors.map((p) => p.taskId));

    bumpMutationSeq(doc);
    await saveProject(projectId, doc);
    await afterMutation(projectId, {
      taskId,
      action: "setDependency",
    });
    return doc;
  }

  async function rawSetDependencies(
    input: SetDependenciesInput,
  ): Promise<PBXDocument> {
    const { projectId, taskId, dependencyIds } = input;
    if (
      !Array.isArray(dependencyIds) ||
      dependencyIds.some((id) => typeof id !== "string" || !id)
    ) {
      throw new Error(
        "setDependencies: dependencyIds must be an array of non-empty task ids",
      );
    }
    const ids = [...new Set(dependencyIds as string[])];
    const doc = await getProject(projectId);
    if (!doc) {
      throw new Error(`setDependencies: project "${projectId}" not found`);
    }
    const task = findTask(doc, taskId);
    if (!task) {
      throw new Error(`setDependencies: task "${taskId}" not found`);
    }
    for (const id of ids) {
      if (id === taskId) {
        throw new Error("setDependencies: a task cannot depend on itself");
      }
      if (!findTask(doc, id)) {
        throw new Error(`setDependencies: dependency task "${id}" not found`);
      }
    }
    if (wouldCreateDependencyCycle(doc, taskId, ids)) {
      throw new Error("setDependencies: dependency set would create a cycle");
    }
    syncDependencyFields(task, ids);

    bumpMutationSeq(doc);
    await saveProject(projectId, doc);
    await afterMutation(projectId, {
      taskId,
      action: "setDependencies",
    });
    return doc;
  }

  async function rawDelegateTask(input: DelegateTaskInput): Promise<PBXDocument> {
    const { projectId, taskId, peerId } = input;
    if (typeof peerId !== "string" || !peerId) {
      throw new Error("delegateTask: peerId must be a non-empty string");
    }
    const doc = await getProject(projectId);
    if (!doc) {
      throw new Error(`delegateTask: project "${projectId}" not found`);
    }
    const task = findTask(doc, taskId);
    if (!task) {
      throw new Error(`delegateTask: task "${taskId}" not found`);
    }
    // The delegatee must be a member: the acceptance/decline handshake runs
    // through the member-only `requestMutation` surface. Adding the member is
    // the owner's explicit delegation act — no separate membership step.
    addMemberToList(doc, peerId);
    task.delegation = { assignedTo: peerId, status: "pending" };

    bumpMutationSeq(doc);
    await saveProject(projectId, doc);
    await afterMutation(projectId, {
      taskId,
      taskName: String(task.name),
      assignedTo: peerId,
      action: "delegateTask",
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

  async function rawAssignResource(input: AssignResourceInput): Promise<PBXDocument> {
    const { projectId, taskId, contactPeerId } = input;
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

    bumpMutationSeq(doc);
    await saveProject(projectId, doc);
    await afterMutation(projectId, {
      taskId,
      taskName: String(task.name),
      contactPeerId,
      action: "assignResource",
    });
    return doc;
  }

  async function rawAddMember(input: AddMemberInput): Promise<PBXDocument> {
    const { projectId, peerId } = input;
    if (typeof peerId !== "string" || !peerId) {
      throw new Error("addMember: peerId must be a non-empty string");
    }
    const doc = await getProject(projectId);
    if (!doc) {
      throw new Error(`addMember: project "${projectId}" not found`);
    }
    const added = addMemberToList(doc, peerId);
    bumpMutationSeq(doc);
    await saveProject(projectId, doc);
    await afterMutation(projectId, {
      memberPeerId: peerId,
      action: added ? "addMember" : "memberAlreadyPresent",
    });
    return doc;
  }

  async function rawUpdateBudget(input: UpdateBudgetInput): Promise<PBXDocument> {
    const { projectId } = input;
    const doc = await getProject(projectId);
    if (!doc) {
      throw new Error(`updateBudget: project "${projectId}" not found`);
    }
    const root = rootObject(doc)!;
    for (const key of ["budgetCents", "spentCents"] as const) {
      const value = (input as UpdateBudgetInput)[key];
      if (value !== undefined) {
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
          throw new Error(`updateBudget: ${key} must be a non-negative integer`);
        }
        root[key] = value;
      }
    }
    bumpMutationSeq(doc);
    await saveProject(projectId, doc);
    await afterMutation(projectId, { action: "updateBudget" });
    return doc;
  }

  async function rawAttachNote(input: AttachNoteInput): Promise<PBXDocument> {
    const { projectId, noteId } = input;
    if (typeof noteId !== "string" || !noteId) {
      throw new Error("attachNote: noteId must be a non-empty string");
    }
    const doc = await getProject(projectId);
    if (!doc) {
      throw new Error(`attachNote: project "${projectId}" not found`);
    }
    const notepadStore = ctx.readStorageOf("notepad");
    if (!notepadStore) {
      throw new Error("attachNote: no read access to notepad storage");
    }
    const noteDoc = await notepadStore.get(`${NOTE_KEY_PREFIX}${noteId}`);
    if (!isPBXDocument(noteDoc)) {
      throw new Error(`attachNote: note "${noteId}" not found`);
    }
    const noteRoot = rootObject(noteDoc);
    if (!noteRoot) {
      throw new Error(`attachNote: note "${noteId}" has no root object`);
    }

    // Import the note as a typed OLE node in this document (mirrors notepad's
    // `embedObject` and the tasks `assignResource` import pattern), so the
    // `$ref` resolves here and the note travels with the project doc.
    const embedId = addObject(doc, EMBEDDED_CLASS, {
      targetClass: noteRoot.$class,
      targetId: noteId,
      attachedAt: new Date().toISOString(),
    });
    rootObject(doc)!.noteRef = linkObject(doc, embedId);

    bumpMutationSeq(doc);
    await saveProject(projectId, doc);
    await afterMutation(projectId, {
      action: "attachNote",
      noteId,
    });
    return doc;
  }

  /**
   * The single apply path for member-initiated requests (network
   * `tasks.requestMutation`). Runs inside the per-project FIFO queue so every
   * request applies to the state written by the previous one. Deny-by-default:
   * any invalid request throws a clean error (the broker turns it into a
   * `status: "error"` result) and never crashes the queue.
   */
  async function applyRequestMutation(
    projectId: string,
    senderPeerId: string,
    request: ProjectMutationRequest,
  ): Promise<MutationResult> {
    if (typeof senderPeerId !== "string" || !senderPeerId) {
      throw new Error("requestMutation: no transport-verified sender identity");
    }
    if (typeof request.type !== "string" || !MUTATION_TYPES.has(request.type)) {
      throw new Error(
        `requestMutation: type must be one of ${[...MUTATION_TYPES].join(", ")}`,
      );
    }
    if (typeof request.taskId !== "string" || !request.taskId) {
      throw new Error("requestMutation: taskId must be a non-empty string");
    }

    const doc = await getProject(projectId);
    if (!doc) {
      throw new Error(`requestMutation: project "${projectId}" not found`);
    }
    if (!isMember(doc, senderPeerId)) {
      throw new Error(`requestMutation: peer "${senderPeerId}" is not a member of the project`);
    }

    // Defense-in-depth contact check: when a trust lookup is wired (production
    // always has one), the sender must be a known, non-blocked contact. The
    // broker's `verified-contact` gate is the authoritative contact-level check
    // on the network path; this is the same gate repeated at the document layer.
    if (ctx.trust) {
      let known = false;
      try {
        const contact = await ctx.trust.getContact(senderPeerId);
        known = contact !== null && contact.trustState !== "blocked";
      } catch {
        known = false;
      }
      if (!known) {
        throw new Error(
          `requestMutation: peer "${senderPeerId}" is not a verified contact`,
        );
      }
    }

    const payload = (request.payload ?? {}) as Record<string, unknown>;
    const task = findTask(doc, request.taskId);
    if (!task) {
      throw new Error(`requestMutation: task "${request.taskId}" not found`);
    }

    switch (request.type) {
      case "CREATE_SUBTASK": {
        const patch = validatePatch({
          name: payload.name,
          status: payload.status,
          start: payload.start,
          finish: payload.finish,
          durationDays: payload.durationDays,
          percentComplete: payload.percentComplete,
        });
        assertChronology(patch.start, patch.finish);
        const childId = addObject(doc, TASK_CLASS, {
          ...patch,
          status: patch.status ?? "todo",
          parentTaskId: request.taskId,
          predecessors: [],
          dependencies: [],
          resourceAssignments: [],
          timeEntries: [],
        });
        const refs = taskRefs(doc);
        refs.push(linkObject(doc, childId));
        rootObject(doc)!.tasks = refs;
        const mutationSeq = bumpMutationSeq(doc);
        await saveProject(projectId, doc);
        await afterMutation(projectId, {
          taskId: childId,
          parentTaskId: request.taskId,
          action: "createSubtask",
        });
        return { ok: true, projectId, mutationSeq, action: "createSubtask" };
      }
      case "MOVE_TASK": {
        const newParent = payload.newParentTaskId ?? null;
        if (newParent !== null) {
          if (typeof newParent !== "string" || !findTask(doc, newParent)) {
            throw new Error(
              `requestMutation: parent task "${newParent}" not found`,
            );
          }
        }
        if (wouldCreateParentCycle(doc, request.taskId, newParent as string | null)) {
          throw new Error("requestMutation: move would create a cycle");
        }
        task.parentTaskId = newParent as string | null;
        const mutationSeq = bumpMutationSeq(doc);
        await saveProject(projectId, doc);
        await afterMutation(projectId, {
          taskId: request.taskId,
          action: "moveTask",
        });
        return { ok: true, projectId, mutationSeq, action: "moveTask" };
      }
      case "UPDATE_STATUS": {
        const patch = validatePatch({ status: payload.status });
        const nextStatus = patch.status;
        // v1.1 dependency guard on the member path too — a member can never
        // start/complete a task whose dependencies are unfinished.
        if (nextStatus === "in-progress") {
          assertCanStart(doc, task);
        }
        if (nextStatus === "done") {
          assertCanComplete(doc, task);
        }
        task.status = nextStatus;
        if (nextStatus === "done") {
          cascadeDone(doc, request.taskId);
        }
        const mutationSeq = bumpMutationSeq(doc);
        await saveProject(projectId, doc);
        await afterMutation(projectId, {
          taskId: request.taskId,
          action: "updateStatus",
        });
        return { ok: true, projectId, mutationSeq, action: "updateStatus" };
      }
      case "LOG_TIME": {
        const start = payload.start;
        const end = payload.end;
        if (typeof start !== "string" || !isIsoDate(start)) {
          throw new Error("requestMutation: start must be an ISO 8601 date string");
        }
        if (typeof end !== "string" || !isIsoDate(end)) {
          throw new Error("requestMutation: end must be an ISO 8601 date string");
        }
        if (Date.parse(end) < Date.parse(start)) {
          throw new Error("requestMutation: end must not be before start");
        }
        const entries = Array.isArray(task.timeEntries)
          ? (task.timeEntries as TimeEntry[])
          : [];
        entries.push({ taskId: request.taskId, peerId: senderPeerId, start, end });
        task.timeEntries = entries;
        const mutationSeq = bumpMutationSeq(doc);
        await saveProject(projectId, doc);
        await afterMutation(projectId, {
          taskId: request.taskId,
          peerId: senderPeerId,
          action: "logTime",
        });
        return { ok: true, projectId, mutationSeq, action: "logTime" };
      }
      case "ACCEPT_DELEGATION": {
        const delegation = delegateeOf(task, senderPeerId);
        if (delegation.status !== "pending") {
          throw new Error(
            `requestMutation: delegation for task "${request.taskId}" is not pending ` +
              `(status: ${delegation.status})`,
          );
        }
        task.delegation = { assignedTo: delegation.assignedTo, status: "accepted" };
        const mutationSeq = bumpMutationSeq(doc);
        await saveProject(projectId, doc);
        await afterMutation(projectId, {
          taskId: request.taskId,
          assignedTo: delegation.assignedTo,
          action: "acceptDelegation",
        });
        return { ok: true, projectId, mutationSeq, action: "acceptDelegation" };
      }
      case "DECLINE_DELEGATION": {
        const delegation = delegateeOf(task, senderPeerId);
        if (delegation.status !== "pending") {
          throw new Error(
            `requestMutation: delegation for task "${request.taskId}" is not pending ` +
              `(status: ${delegation.status})`,
          );
        }
        const rawReason = payload.reason;
        const reason =
          typeof rawReason === "string" && rawReason.trim()
            ? rawReason.trim().slice(0, 500)
            : undefined;
        task.delegation = {
          assignedTo: delegation.assignedTo,
          status: "declined",
          ...(reason !== undefined ? { declinedReason: reason } : {}),
        };
        const mutationSeq = bumpMutationSeq(doc);
        await saveProject(projectId, doc);
        await afterMutation(projectId, {
          taskId: request.taskId,
          assignedTo: delegation.assignedTo,
          action: "declineDelegation",
        });
        return { ok: true, projectId, mutationSeq, action: "declineDelegation" };
      }
      case "SUBMIT_COMPLETION_PROOF": {
        const delegation = delegateeOf(task, senderPeerId);
        if (delegation.status !== "accepted") {
          throw new Error(
            `requestMutation: delegation for task "${request.taskId}" must be accepted ` +
              `before a completion proof can be submitted (status: ${delegation.status})`,
          );
        }
        const proof = payload.proof as TaskCompletionProof | undefined;
        if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
          throw new Error("requestMutation: a completion proof is required");
        }
        const { signedBy, timestamp, signatureHex } = proof;
        if (typeof signedBy !== "string" || signedBy !== senderPeerId) {
          throw new Error(
            "requestMutation: proof.signedBy must equal the transport-verified sender",
          );
        }
        if (typeof timestamp !== "string" || !isIsoDate(timestamp)) {
          throw new Error(
            "requestMutation: proof.timestamp must be an ISO 8601 date string",
          );
        }
        if (
          typeof signatureHex !== "string" ||
          !/^[0-9a-fA-F]+$/.test(signatureHex) ||
          signatureHex.length % 2 !== 0
        ) {
          throw new Error("requestMutation: proof.signatureHex must be hex");
        }
        // Domain separation is structural: the owner verifies in the tasks
        // completion-proof domain, so a signature minted over any other
        // `domain || data` (or a different task/project/timestamp) fails here.
        const payloadBytes = Buffer.from(
          `${request.taskId}:${projectId}:${timestamp}`,
          "utf8",
        );
        const valid = ctx.identity.verify(
          signedBy,
          COMPLETION_PROOF_DOMAIN_PREFIX,
          payloadBytes,
          Buffer.from(signatureHex, "hex"),
        );
        if (!valid) {
          throw new Error(
            "requestMutation: completion proof signature verification failed",
          );
        }
        // The dependency guard applies to proof-driven completion too.
        assertCanComplete(doc, task);
        task.status = "done";
        task.completionProof = { signedBy, timestamp, signatureHex };
        cascadeDone(doc, request.taskId);
        const mutationSeq = bumpMutationSeq(doc);
        await saveProject(projectId, doc);
        await afterMutation(projectId, {
          taskId: request.taskId,
          signedBy,
          action: "submitCompletionProof",
        });
        return { ok: true, projectId, mutationSeq, action: "submitCompletionProof" };
      }
      case "SET_DEPENDENCIES": {
        const dependencyIds = payload.dependencyIds;
        if (
          !Array.isArray(dependencyIds) ||
          dependencyIds.some((id) => typeof id !== "string" || !id)
        ) {
          throw new Error(
            "requestMutation: dependencyIds must be an array of non-empty task ids",
          );
        }
        const ids = [...new Set(dependencyIds as string[])];
        for (const id of ids) {
          if (id === request.taskId) {
            throw new Error("requestMutation: a task cannot depend on itself");
          }
          if (!findTask(doc, id)) {
            throw new Error(`requestMutation: dependency task "${id}" not found`);
          }
        }
        if (wouldCreateDependencyCycle(doc, request.taskId, ids)) {
          throw new Error("requestMutation: dependency set would create a cycle");
        }
        syncDependencyFields(task, ids);
        const mutationSeq = bumpMutationSeq(doc);
        await saveProject(projectId, doc);
        await afterMutation(projectId, {
          taskId: request.taskId,
          action: "setDependencies",
        });
        return { ok: true, projectId, mutationSeq, action: "setDependencies" };
      }
    }
  }

  async function assignAgent(
    input: AssignAgentInput,
  ): Promise<{ ok: boolean; projectId: string; taskId: string; agentPeerId: string }> {
    const { projectId, taskId, agentPeerId } = (input ?? {}) as {
      projectId?: unknown;
      taskId?: unknown;
      agentPeerId?: unknown;
    };
    if (
      typeof projectId !== "string" ||
      typeof taskId !== "string" ||
      typeof agentPeerId !== "string"
    ) {
      throw new Error("assignAgent: projectId, taskId and agentPeerId are required");
    }
    const doc = await getProject(projectId);
    if (!doc) {
      throw new Error(`assignAgent: project "${projectId}" not found`);
    }
    const task = findTask(doc, taskId);
    if (!task) {
      throw new Error(`assignAgent: task "${taskId}" not found`);
    }
    // Notification only — agents are addressable assignees, never executing.
    // The existing tasks→chat notification path (chat's `tasks:taskUpdated`
    // hook) is the only side effect; no project state changes here.
    await ctx.hooks.emit("tasks:taskUpdated", {
      projectId,
      taskId,
      taskName: String(task.name),
      agentPeerId,
      action: "assignAgent",
    });
    return { ok: true, projectId, taskId, agentPeerId };
  }

  // ---- AI propose-then-confirm (never mutates) ----

  const PLANNER_SYSTEM_PROMPT =
    "You are a project planning assistant. Return ONLY a strict JSON object " +
    'with the shape {"summary": string, "steps": [{"title": string, ' +
    '"action": "UPDATE_STATUS" | "CREATE_SUBTASK" | "MOVE_TASK" | "LOG_TIME" | "none", ' +
    '"taskId"?: string, "payload"?: object}]}. Do not include markdown fences.';

  function describeTasks(doc: PBXDocument): string {
    return listTaskObjects(doc)
      .map((t) => {
        const parent = typeof t.parentTaskId === "string" ? t.parentTaskId : "root";
        return `- ${t.$id} [${String(t.status ?? "todo")}] "${String(t.name ?? "")}" ` +
          `parent=${parent} percent=${String(t.percentComplete ?? 0)}`;
      })
      .join("\n");
  }

  function parseProposal(raw: string): { summary: string; steps: PlanStep[] } {
    const trimmed = raw.trim();
    const jsonStart = trimmed.indexOf("{");
    const jsonEnd = trimmed.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) {
      throw new Error("AI response contained no JSON object");
    }
    const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as {
      summary?: unknown;
      steps?: unknown;
    };
    if (typeof parsed.summary !== "string" || !Array.isArray(parsed.steps)) {
      throw new Error("AI proposal must contain a summary string and a steps array");
    }
    const steps: PlanStep[] = parsed.steps.map((rawStep) => {
      const step = (rawStep ?? {}) as {
        title?: unknown;
        action?: unknown;
        taskId?: unknown;
        payload?: unknown;
      };
      const action = step.action;
      const allowed = ["UPDATE_STATUS", "CREATE_SUBTASK", "MOVE_TASK", "LOG_TIME", "none"];
      if (typeof step.title !== "string" || typeof action !== "string" || !allowed.includes(action)) {
        throw new Error("AI proposal step must have a title and a known action");
      }
      return {
        ...(typeof step.taskId === "string" ? { taskId: step.taskId } : {}),
        title: step.title,
        action: action as PlanStep["action"],
        ...(step.payload && typeof step.payload === "object"
          ? { payload: step.payload as Record<string, unknown> }
          : {}),
      };
    });
    return { summary: parsed.summary, steps };
  }

  async function planDay(input: PlanDayInput): Promise<PlanResult> {
    const { projectId, goal } = (input ?? {}) as {
      projectId?: unknown;
      goal?: unknown;
    };
    if (typeof projectId !== "string") {
      return { ok: false, error: "planDay expects { projectId: string, goal?: string }" };
    }
    const doc = await getProject(projectId);
    if (!doc) {
      return { ok: false, error: `planDay: project "${projectId}" not found` };
    }
    const today = new Date().toISOString().slice(0, 10);
    const prompt =
      `Plan the work day for the project "${String(rootObject(doc)?.name ?? projectId)}".\n` +
      `Today: ${today}.\n` +
      (typeof goal === "string" && goal ? `Focus goal: ${goal}.\n` : "") +
      `Current tasks:\n${describeTasks(doc)}\n` +
      "Propose a concrete ordered list of next steps.";
    try {
      const raw = await ctx.ai.generateText({
        prompt,
        system: PLANNER_SYSTEM_PROMPT,
        temperature: 0.2,
      });
      const { summary, steps } = parseProposal(raw);
      return {
        ok: true,
        proposal: {
          kind: "day",
          generatedAt: new Date().toISOString(),
          ...(typeof goal === "string" && goal ? { goal } : {}),
          summary,
          steps,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function planProject(input: PlanProjectInput): Promise<PlanResult> {
    const { projectId, scope } = (input ?? {}) as {
      projectId?: unknown;
      scope?: unknown;
    };
    if (typeof projectId !== "string") {
      return { ok: false, error: "planProject expects { projectId: string, scope?: string }" };
    }
    const doc = await getProject(projectId);
    if (!doc) {
      return { ok: false, error: `planProject: project "${projectId}" not found` };
    }
    const prompt =
      `Plan the next slice of work for the project "${String(rootObject(doc)?.name ?? projectId)}".\n` +
      (typeof scope === "string" && scope ? `Scope: ${scope}.\n` : "") +
      `Current tasks:\n${describeTasks(doc)}\n` +
      "Propose the next concrete milestones and their steps.";
    try {
      const raw = await ctx.ai.generateText({
        prompt,
        system: PLANNER_SYSTEM_PROMPT,
        temperature: 0.2,
      });
      const { summary, steps } = parseProposal(raw);
      return {
        ok: true,
        proposal: {
          kind: "project",
          generatedAt: new Date().toISOString(),
          ...(typeof scope === "string" && scope ? { goal: scope } : {}),
          summary,
          steps,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---- public wrapper methods (route every mutation through the FIFO queue) ----

  async function addTask(input: AddTaskInput): Promise<PBXDocument> {
    const { projectId } = (input ?? {}) as { projectId?: unknown };
    if (typeof projectId !== "string") {
      throw new Error("addTask: projectId is required");
    }
    return enqueueProjectMutation(projectId, () => rawAddTask(input));
  }

  async function updateTask(input: UpdateTaskInput): Promise<PBXDocument> {
    const { projectId, taskId } = (input ?? {}) as {
      projectId?: unknown;
      taskId?: unknown;
    };
    if (typeof projectId !== "string" || typeof taskId !== "string") {
      throw new Error("updateTask: projectId and taskId are required");
    }
    return enqueueProjectMutation(projectId, () => rawUpdateTask(input));
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
    return enqueueProjectMutation(projectId, () => rawSetDependency(input));
  }

  async function setDependencies(input: SetDependenciesInput): Promise<PBXDocument> {
    const { projectId, taskId } = (input ?? {}) as {
      projectId?: unknown;
      taskId?: unknown;
    };
    if (typeof projectId !== "string" || typeof taskId !== "string") {
      throw new Error("setDependencies: projectId and taskId are required");
    }
    return enqueueProjectMutation(projectId, () => rawSetDependencies(input));
  }

  async function delegateTask(input: DelegateTaskInput): Promise<PBXDocument> {
    const { projectId, taskId, peerId } = (input ?? {}) as {
      projectId?: unknown;
      taskId?: unknown;
      peerId?: unknown;
    };
    if (
      typeof projectId !== "string" ||
      typeof taskId !== "string" ||
      typeof peerId !== "string"
    ) {
      throw new Error("delegateTask: projectId, taskId and peerId are required");
    }
    return enqueueProjectMutation(projectId, () => rawDelegateTask(input));
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
    return enqueueProjectMutation(projectId, () => rawAssignResource(input));
  }

  async function addMember(input: AddMemberInput): Promise<PBXDocument> {
    const { projectId } = (input ?? {}) as { projectId?: unknown };
    if (typeof projectId !== "string") {
      throw new Error("addMember: projectId is required");
    }
    return enqueueProjectMutation(projectId, () => rawAddMember(input));
  }

  async function updateBudget(input: UpdateBudgetInput): Promise<PBXDocument> {
    const { projectId } = (input ?? {}) as { projectId?: unknown };
    if (typeof projectId !== "string") {
      throw new Error("updateBudget: projectId is required");
    }
    return enqueueProjectMutation(projectId, () => rawUpdateBudget(input));
  }

  async function attachNote(input: AttachNoteInput): Promise<PBXDocument> {
    const { projectId } = (input ?? {}) as { projectId?: unknown };
    if (typeof projectId !== "string") {
      throw new Error("attachNote: projectId is required");
    }
    return enqueueProjectMutation(projectId, () => rawAttachNote(input));
  }

  /**
   * The member → owner mutation entry point. The skill wrapper feeds it the
   * transport-verified `context.peerId`; the in-process method takes it as
   * `senderPeerId` so tests can exercise the same path. Enqueued synchronously
   * (before any await) so FIFO order equals arrival order.
   */
  async function requestMutation(
    input: ProjectMutationRequest & { senderPeerId: string },
  ): Promise<MutationResult> {
    const { projectId } = (input ?? {}) as { projectId?: unknown };
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("requestMutation: projectId is required");
    }
    return enqueueProjectMutation(projectId, () =>
      applyRequestMutation(projectId, input.senderPeerId, input),
    );
  }

  // ---- SmartProjects v1.1: proof signing + pure computations ----

  /**
   * Sign a completion proof for `taskId`/`projectId`/`timestamp` with the local
   * identity in the tasks completion-proof domain. Called on the *delegatee's*
   * node; the domain is prepended structurally by core (`ctx.identity.sign`),
   * so the returned proof can only verify against the same constant on the
   * owner side. `signedBy` doubles as the peer's identity — the owner uses it
   * both as the delegation check and as the verification key.
   */
  async function signCompletionProof(input: {
    taskId: string;
    projectId: string;
    timestamp: string;
  }): Promise<TaskCompletionProof> {
    const { taskId, projectId, timestamp } = input;
    if (typeof taskId !== "string" || !taskId) {
      throw new Error("signCompletionProof: taskId must be a non-empty string");
    }
    if (typeof projectId !== "string" || !projectId) {
      throw new Error(
        "signCompletionProof: projectId must be a non-empty string",
      );
    }
    if (typeof timestamp !== "string" || !isIsoDate(timestamp)) {
      throw new Error(
        "signCompletionProof: timestamp must be an ISO 8601 date string",
      );
    }
    const signedBy = await ctx.identity.peerId();
    const signature = await ctx.identity.sign(
      COMPLETION_PROOF_DOMAIN_PREFIX,
      Buffer.from(`${taskId}:${projectId}:${timestamp}`, "utf8"),
    );
    return { signedBy, timestamp, signatureHex: signature.toString("hex") };
  }

  /** Normalize a task object for the pure computations (resolves $refs). */
  function taskLikeOf(doc: PBXDocument, task: PBXObject): TaskLike {
    return {
      id: task.$id,
      ...(typeof task.estimatedHours === "number"
        ? { estimatedHours: task.estimatedHours }
        : {}),
      ...(typeof task.durationDays === "number"
        ? { durationDays: task.durationDays }
        : {}),
      ...(Array.isArray(task.dependencies)
        ? { dependencies: task.dependencies as string[] }
        : {}),
      assignedPeerIds: assignedPeerIdsOf(doc, task),
      ...(typeof task.start === "string" ? { start: task.start } : {}),
      ...(typeof task.finish === "string" ? { finish: task.finish } : {}),
    };
  }

  async function getCapacity(projectId: string): Promise<ProjectCapacity> {
    const doc = await getProject(projectId);
    if (!doc) {
      throw new Error(`getCapacity: project "${projectId}" not found`);
    }
    const taskObjects = listTaskObjects(doc);
    const timeEntries: TimeEntryLike[] = [];
    for (const t of taskObjects) {
      if (Array.isArray(t.timeEntries)) {
        for (const e of t.timeEntries as TimeEntry[]) {
          timeEntries.push({
            taskId: e.taskId,
            peerId: e.peerId,
            start: e.start,
            end: e.end,
          });
        }
      }
    }
    return calculateProjectCapacity(
      taskObjects.map((t) => taskLikeOf(doc, t)),
      timeEntries,
    );
  }

  async function getCriticalPath(projectId: string): Promise<CriticalPath> {
    const doc = await getProject(projectId);
    if (!doc) {
      throw new Error(`getCriticalPath: project "${projectId}" not found`);
    }
    return calculateCriticalPath(
      listTaskObjects(doc).map((t) => taskLikeOf(doc, t)),
    );
  }

  // ---- remote per-project event membership guard ----

  /**
   * The subscription guard for the `tasks:project:` namespace: only a current
   * member of the named project may subscribe to (or keep receiving) its
   * events. Runs at subscribe time AND again before each emit to an
   * already-subscribed peer (a removed member stops receiving immediately).
   * The captured id is charset-validated by the regex, so it can never smuggle
   * a fake delimiter into the storage key.
   */
  async function guardProjectTopic(peerId: string, topic: string): Promise<boolean> {
    const match = /^tasks:project:([A-Za-z0-9][A-Za-z0-9_.-]*)(?::updated)?$/.exec(
      topic,
    );
    if (!match) {
      return false;
    }
    const doc = await getProject(match[1]);
    if (!doc) {
      return false;
    }
    return isMember(doc, peerId);
  }

  ctx.events.registerSubscriptionGuard("tasks:project:", guardProjectTopic);

  ctx.skills.register(
    "createProject",
    async (payload) => createProject(payload as CreateProjectInput),
    { httpBridgeOnly: true },
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
    { httpBridgeOnly: true },
  );

  ctx.skills.register(
    "listProjects",
    async () => listProjects(),
    { httpBridgeOnly: true },
  );

  ctx.skills.register(
    "addTask",
    async (payload) => addTask(payload as AddTaskInput),
    { httpBridgeOnly: true },
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
    { httpBridgeOnly: true },
  );

  ctx.skills.register(
    "updateTask",
    async (payload) => updateTask(payload as UpdateTaskInput),
    { httpBridgeOnly: true },
  );

  ctx.skills.register(
    "setDependency",
    async (payload) => setDependency(payload as SetDependencyInput),
    { httpBridgeOnly: true },
  );

  ctx.skills.register(
    "setDependencies",
    async (payload) => setDependencies(payload as SetDependenciesInput),
    { httpBridgeOnly: true },
  );

  ctx.skills.register(
    "delegateTask",
    async (payload) => delegateTask(payload as DelegateTaskInput),
    { httpBridgeOnly: true },
  );

  ctx.skills.register(
    "getCapacity",
    async (payload) => {
      const { projectId } = (payload ?? {}) as { projectId?: unknown };
      if (typeof projectId !== "string") {
        throw new Error("getCapacity expects { projectId: string }");
      }
      return getCapacity(projectId);
    },
    { httpBridgeOnly: true },
  );

  ctx.skills.register(
    "getCriticalPath",
    async (payload) => {
      const { projectId } = (payload ?? {}) as { projectId?: unknown };
      if (typeof projectId !== "string") {
        throw new Error("getCriticalPath expects { projectId: string }");
      }
      return getCriticalPath(projectId);
    },
    { httpBridgeOnly: true },
  );

  ctx.skills.register(
    "assignResource",
    async (payload) => assignResource(payload as AssignResourceInput),
    { httpBridgeOnly: true },
  );

  ctx.skills.register(
    "addMember",
    async (payload) => addMember(payload as AddMemberInput),
    { httpBridgeOnly: true },
  );

  ctx.skills.register(
    "updateBudget",
    async (payload) => updateBudget(payload as UpdateBudgetInput),
    { localOnly: true },
  );

  ctx.skills.register(
    "attachNote",
    async (payload) => attachNote(payload as AttachNoteInput),
    { localOnly: true },
  );

  ctx.skills.register(
    "assignAgent",
    async (payload) => assignAgent(payload as AssignAgentInput),
    { localOnly: true },
  );

  ctx.skills.register(
    "planDay",
    async (payload) => planDay(payload as PlanDayInput),
    { localOnly: true },
  );

  ctx.skills.register(
    "planProject",
    async (payload) => planProject(payload as PlanProjectInput),
    { localOnly: true },
  );

  // The single member-facing network skill: a member asks the owner to apply
  // a mutation. `localOnly: false` requires the `network:skill:tasks.requestMutation`
  // manifest permission (enforced by the loader), and the Fase 2A `verified-contact`
  // gate is the broker-side contact check. The handler additionally enforces
  // project membership on the transport-verified peerId.
  ctx.skills.register(
    "requestMutation",
    async (payload, context) =>
      requestMutation({
        ...(payload as ProjectMutationRequest),
        senderPeerId: context?.peerId ?? "",
      }),
    { localOnly: false, remote: { gate: "verified-contact" } },
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
    setDependencies,
    delegateTask,
    signCompletionProof,
    getCapacity,
    getCriticalPath,
    assignResource,
    addMember,
    updateBudget,
    attachNote,
    assignAgent,
    planDay,
    planProject,
    requestMutation,
  };
}

// Re-exported v1.1 schema + computation surfaces so the UI and tests can import
// the same shapes without reaching into module internals.
export {
  COMPLETION_PROOF_DOMAIN_PREFIX,
  type TaskCompletionProof,
  type TaskDelegation,
  type DelegationStatus,
} from "./types";
export {
  calculateCriticalPath,
  calculateProjectCapacity,
  type CriticalPath,
  type ProjectCapacity,
  type PeerCapacity,
  type TaskLike,
  type TimeEntryLike,
} from "./computations";
