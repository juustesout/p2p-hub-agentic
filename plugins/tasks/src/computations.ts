/**
 * SmartProjects v1.1 — pure, deterministic computations over task/time-entry
 * records (Critical Path & Capacity).
 *
 * These functions are deliberately pure: they take plain data, do no I/O, no
 * timers, no network side-effects and never throw. The plugin entry module
 * (`index.ts`) is the only caller — it resolves OLE `$ref`s (resource
 * assignments → peerIds) and flattens inline `P2P.TimeEntry` records before
 * calling in, and the UI gets the results through read-only skills.
 *
 * Determinism contract: for the same input array the output is identical,
 * regardless of scheduling or insertion order — all maps/arrays are iterated
 * in the caller's array order and tie-breaks are first-wins, so a re-ordered
 * input yields the same result.
 */

/** The normalized task view the computations consume (see module doc). */
export interface TaskLike {
  id: string;
  /** MSPDI-style estimated effort in hours (used as critical-path weight fallback). */
  estimatedHours?: number;
  /** Calendar duration in days (primary critical-path weight). */
  durationDays?: number;
  /** Task ids that must be `done` before this task can be worked/completed. */
  dependencies?: string[];
  /** Resolved peerIds from `resourceAssignments` (per-peer capacity input). */
  assignedPeerIds?: string[];
  /** ISO 8601 start date of the task window (capacity working-days input). */
  start?: string;
  /** ISO 8601 finish date of the task window (capacity working-days input). */
  finish?: string;
}

/** A single inline `P2P.TimeEntry` record (flattened by the caller). */
export interface TimeEntryLike {
  taskId: string;
  peerId: string;
  start: string;
  end: string;
}

/** Per-peer capacity summary. */
export interface PeerCapacity {
  peerId: string;
  estimatedHours: number;
  spentHours: number;
  /** Distinct calendar days spanned by the peer's dated tasks (min 1). */
  workingDays: number;
  estimatedHoursPerDay: number;
  /** True when estimated hours per day exceed the 8h/peer standard. */
  overCapacity: boolean;
}

/** Project-level capacity summary plus per-peer detail and warnings. */
export interface ProjectCapacity {
  totalEstimatedHours: number;
  totalSpentHours: number;
  /** Distinct calendar days spanned by any dated task in the project (min 1). */
  workingDays: number;
  estimatedHoursPerDay: number;
  perPeer: PeerCapacity[];
  /** Peers whose estimated hours/day exceed the 8h standard. */
  overAllocation: Array<{ peerId: string; estimatedHoursPerDay: number }>;
}

const STANDARD_HOURS_PER_DAY = 8;

const MS_PER_HOUR = 3_600_000;

/** UTC calendar day (`YYYY-MM-DD`) for an ISO timestamp/date string. */
function dayOf(value: string): string {
  return value.slice(0, 10);
}

function hoursBetween(start: string, end: string): number {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
    return 0;
  }
  return (endMs - startMs) / MS_PER_HOUR;
}

/**
 * Distinct UTC calendar days spanned (inclusive) by a task's [start, finish]
 * window, or an empty set when the task has no usable window.
 */
function taskDaySet(task: TaskLike): Set<string> {
  if (typeof task.start !== "string" || typeof task.finish !== "string") {
    return new Set<string>();
  }
  const startMs = Date.parse(task.start);
  const endMs = Date.parse(task.finish);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
    return new Set<string>();
  }
  const days = new Set<string>();
  for (
    let cursor = startMs;
    cursor <= endMs;
    cursor += MS_PER_HOUR * 24
  ) {
    days.add(dayOf(new Date(cursor).toISOString()));
  }
  return days;
}

/**
 * Project + per-peer estimated vs spent hours, with the standard
 * 8h/peer/day warning. `overCapacity` is `estimatedHours / workingDays > 8`
 * where workingDays is the peer's own dated task window (project span as a
 * fallback when the peer has tasks but none dated).
 */
export function calculateProjectCapacity(
  tasks: TaskLike[],
  timeEntries: TimeEntryLike[],
): ProjectCapacity {
  let totalEstimatedHours = 0;
  let totalSpentHours = 0;
  const projectDays = new Set<string>();

  const estimatedByPeer = new Map<string, number>();
  const spentByPeer = new Map<string, number>();
  const taskIdsByPeer = new Map<string, string[]>();

  for (const task of tasks) {
    const estimated = typeof task.estimatedHours === "number" ? task.estimatedHours : 0;
    totalEstimatedHours += estimated;
    for (const day of taskDaySet(task)) {
      projectDays.add(day);
    }
    for (const peerId of task.assignedPeerIds ?? []) {
      estimatedByPeer.set(peerId, (estimatedByPeer.get(peerId) ?? 0) + estimated);
      const ids = taskIdsByPeer.get(peerId) ?? [];
      ids.push(task.id);
      taskIdsByPeer.set(peerId, ids);
    }
  }

  for (const entry of timeEntries) {
    const duration = hoursBetween(entry.start, entry.end);
    totalSpentHours += duration;
    if (typeof entry.peerId === "string" && entry.peerId) {
      spentByPeer.set(entry.peerId, (spentByPeer.get(entry.peerId) ?? 0) + duration);
    }
  }

  const projectWorkingDays = projectDays.size > 0 ? projectDays.size : 1;

  const peerIds = new Set<string>([
    ...estimatedByPeer.keys(),
    ...spentByPeer.keys(),
  ]);
  const perPeer: PeerCapacity[] = [];
  for (const peerId of [...peerIds].sort()) {
    const estimatedHours = estimatedByPeer.get(peerId) ?? 0;
    const spentHours = spentByPeer.get(peerId) ?? 0;
    const peerTaskIds = taskIdsByPeer.get(peerId) ?? [];
    const peerDays = new Set<string>();
    for (const id of peerTaskIds) {
      const task = tasks.find((t) => t.id === id);
      if (task) {
        for (const day of taskDaySet(task)) {
          peerDays.add(day);
        }
      }
    }
    const workingDays = peerDays.size > 0 ? peerDays.size : projectWorkingDays;
    const estimatedHoursPerDay = estimatedHours / workingDays;
    perPeer.push({
      peerId,
      estimatedHours,
      spentHours,
      workingDays,
      estimatedHoursPerDay,
      overCapacity: estimatedHoursPerDay > STANDARD_HOURS_PER_DAY,
    });
  }

  const overAllocation = perPeer
    .filter((p) => p.overCapacity)
    .map((p) => ({ peerId: p.peerId, estimatedHoursPerDay: p.estimatedHoursPerDay }))
    .sort((a, b) => a.peerId.localeCompare(b.peerId));

  return {
    totalEstimatedHours,
    totalSpentHours,
    workingDays: projectWorkingDays,
    estimatedHoursPerDay: totalEstimatedHours / projectWorkingDays,
    perPeer,
    overAllocation,
  };
}

/** Result of the critical-path computation. */
export interface CriticalPath {
  /** Task ids on the longest dependency chain, start → finish. */
  path: string[];
  /** Sum of the path's weights (`durationDays` ?? `estimatedHours` ?? 1). */
  totalWeight: number;
  /** Same as `path` — the ids a view should highlight as critical. */
  criticalTaskIds: string[];
}

/**
 * Longest dependency chain through the task graph. Each task's weight is
 * `durationDays` when present, else `estimatedHours`, else 1. A cycle (which
 * the write path rejects, but this is defense-in-depth) contributes 0 weight
 * instead of hanging or throwing.
 */
export function calculateCriticalPath(tasks: TaskLike[]): CriticalPath {
  const byId = new Map<string, TaskLike>();
  for (const task of tasks) {
    byId.set(task.id, task);
  }

  function weightOf(task: TaskLike): number {
    if (typeof task.durationDays === "number" && task.durationDays > 0) {
      return task.durationDays;
    }
    if (typeof task.estimatedHours === "number" && task.estimatedHours > 0) {
      return task.estimatedHours;
    }
    return 1;
  }

  const memo = new Map<string, { weight: number; next: string | null }>();
  const inStack = new Set<string>();

  function longestFrom(id: string): { weight: number; next: string | null } {
    const cached = memo.get(id);
    if (cached) {
      return cached;
    }
    const task = byId.get(id);
    if (!task) {
      const empty = { weight: 0, next: null as string | null };
      memo.set(id, empty);
      return empty;
    }
    if (inStack.has(id)) {
      // Cycle: contribute nothing for this branch instead of recursing forever.
      return { weight: 0, next: null };
    }
    inStack.add(id);
    let bestWeight = 0;
    let bestNext: string | null = null;
    for (const depId of task.dependencies ?? []) {
      if (!byId.has(depId)) {
        continue;
      }
      const sub = longestFrom(depId);
      if (sub.weight > bestWeight) {
        bestWeight = sub.weight;
        bestNext = depId;
      }
    }
    inStack.delete(id);
    const result = { weight: weightOf(task) + bestWeight, next: bestNext };
    memo.set(id, result);
    return result;
  }

  let bestId: string | null = null;
  let bestWeight = -1;
  for (const task of tasks) {
    const candidate = longestFrom(task.id);
    if (candidate.weight > bestWeight) {
      bestWeight = candidate.weight;
      bestId = task.id;
    }
  }

  if (bestId === null) {
    return { path: [], totalWeight: 0, criticalTaskIds: [] };
  }

  const path: string[] = [];
  let cursor: string | null = bestId;
  while (cursor !== null) {
    path.push(cursor);
    cursor = memo.get(cursor)?.next ?? null;
  }

  return { path, totalWeight: bestWeight, criticalTaskIds: path };
}
