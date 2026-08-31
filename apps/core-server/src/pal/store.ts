/**
 * PALRuleStore — durable, per-rule-fail-safe persistence for the PAL rule set
 * (Brief 6).
 *
 * The rules live under the reserved `sys.pal.rules` namespace, represented on
 * disk as `<dataDir>/sys/pal/rules.json` — a path no plugin can write (plugin
 * storage is `<dataDir>/<pluginId>.json`, structurally distinct), so the rule
 * set is operator-only by construction.
 *
 * Hydration is deliberately fail-safe **per rule** (an explicit, documented
 * deviation from the governance-matrix fail-loud precedent):
 * - a missing file is the normal first-run case → empty rule set;
 * - a corrupt *rule* (fails `validatePALRule`) is logged
 *   `[PAL Store] Corrupt rule <id> skipped` and skipped, so a single malformed
 *   rule on disk can never abort the server boot;
 * - a duplicate rule id is likewise skipped with a loud log;
 * - a corrupt *file* (unparseable, wrong shape/version) still throws loudly
 *   (`StorageCorruptionError`/typed error): the whole rule set being unreadable
 *   is a different situation from one bad rule, and silently starting "empty"
 *   would be silent data loss (CLAUDE.md principle #9).
 *
 * Writes are atomic (temp-file + fsync + rename via the shared
 * `atomicWriteFile`) under the reserved namespace. Validation is the shared
 * SDK hand-written validator — no new schema dependency.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isPlainObject, validatePALRule, type PALRule } from "@p2p-hub/sdk";
import { atomicWriteFile, readJsonFile } from "@p2p-hub/core";
import { logger } from "../logger";

/** File version of the persisted rule set. Bumped on any shape change. */
export const PAL_RULES_FILE_VERSION = 1;

/** The file lives under the reserved `sys.pal.rules` namespace. */
export const PAL_RULES_FILE_NAME = "rules.json";

/** Hard ceiling on the number of rules (bounded store, bounded engine). */
export const MAX_PAL_RULE_COUNT = 500;

/** The exact log prefix the acceptance criterion checks for. */
export const CORRUPT_RULE_LOG_PREFIX = "[PAL Store] Corrupt rule";

/** Path of the rule set under the reserved `sys.pal.rules` namespace. */
export function palRulesFile(dataDir: string): string {
  return path.join(dataDir, "sys", "pal", PAL_RULES_FILE_NAME);
}

/** The rule is malformed (fails the shared SDK validator). Maps to 422. */
export class InvalidPALRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPALRuleError";
  }
}

/** A rule with this id is already active. Maps to 409. */
export class DuplicatePALRuleError extends Error {
  constructor(ruleId: string) {
    super(`a PAL rule with id "${ruleId}" already exists`);
    this.name = "DuplicatePALRuleError";
  }
}

export interface PALRuleStoreOptions {
  /** Path of the persisted rule file (under the reserved namespace). */
  filePath: string;
}

interface PersistedRuleSet {
  version: number;
  rules: PALRule[];
}

/** Defensively extract an id for the skip log even from a corrupt rule. */
function rawRuleId(raw: unknown): string {
  const id = (raw ?? {}) as { id?: unknown };
  return typeof id.id === "string" ? id.id : "<unknown>";
}

/**
 * Durable rule store for the PAL manager. `list()` returns the *validated,
 * normalized* rules; every write path (`add`/`remove`) persists atomically and
 * keeps the in-memory set the source of truth for reads.
 */
export class PALRuleStore {
  private readonly rules = new Map<string, PALRule>();

  constructor(private readonly options: PALRuleStoreOptions) {}

  /** Validated rules, sorted by id (stable order for engine + audit). */
  list(): PALRule[] {
    return [...this.rules.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(ruleId: string): PALRule | undefined {
    return this.rules.get(ruleId);
  }

  /**
   * Load persisted rules. Fail-safe per rule: a malformed rule is skipped with
   * `[PAL Store] Corrupt rule <id> skipped`; a corrupt file still throws.
   */
  async load(): Promise<void> {
    const persisted = await readJsonFile<PersistedRuleSet>(this.options.filePath);
    if (!persisted) {
      return;
    }
    if (
      !isPlainObject(persisted) ||
      !Array.isArray(persisted.rules) ||
      persisted.version !== PAL_RULES_FILE_VERSION
    ) {
      throw new Error(
        `PAL rules file has an unsupported shape/version: ${this.options.filePath}`,
      );
    }
    const seen = new Set<string>();
    for (const raw of persisted.rules) {
      let rule: PALRule;
      try {
        rule = validatePALRule(raw);
      } catch (err) {
        const id = rawRuleId(raw);
        logger.warn(
          `${CORRUPT_RULE_LOG_PREFIX} ${id} skipped: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (seen.has(rule.id)) {
        logger.warn(`[PAL Store] Duplicate rule ${rule.id} skipped`);
        continue;
      }
      seen.add(rule.id);
      this.rules.set(rule.id, rule);
    }
  }

  /**
   * Validate and add a rule, persisting atomically. Throws
   * {@link InvalidPALRuleError} on a malformed rule and
   * {@link DuplicatePALRuleError} on an existing id. Bounded at
   * {@link MAX_PAL_RULE_COUNT}.
   */
  async add(raw: unknown): Promise<PALRule> {
    let rule: PALRule;
    try {
      rule = validatePALRule(raw);
    } catch (err) {
      throw new InvalidPALRuleError(
        err instanceof Error ? err.message : String(err),
      );
    }
    if (this.rules.has(rule.id)) {
      throw new DuplicatePALRuleError(rule.id);
    }
    if (this.rules.size >= MAX_PAL_RULE_COUNT) {
      throw new InvalidPALRuleError(
        `rule set is at the maximum of ${MAX_PAL_RULE_COUNT} rules`,
      );
    }
    this.rules.set(rule.id, rule);
    await this.persist();
    return rule;
  }

  /** Remove a rule by id, persisting atomically. False when there was none. */
  async remove(ruleId: string): Promise<boolean> {
    const existed = this.rules.delete(ruleId);
    if (existed) {
      await this.persist();
    }
    return existed;
  }

  private async persist(): Promise<void> {
    // The reserved `sys/pal` namespace may not exist yet on first write.
    await fs.mkdir(path.dirname(this.options.filePath), { recursive: true });
    const persisted: PersistedRuleSet = {
      version: PAL_RULES_FILE_VERSION,
      rules: this.list(),
    };
    await atomicWriteFile(
      this.options.filePath,
      JSON.stringify(persisted, null, 2),
    );
  }
}
