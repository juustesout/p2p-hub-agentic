import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { computePluginContentHash } from "./certification-service";

/**
 * Static pre-review scanner (Fase 3 Stap 3, Pijler B of the certification
 * brief). Scans the *built* bundle of a plugin and reports behaviour that
 * deviates from what the manifest claims — the scanner is a pattern-reporter,
 * never an approver (see `docs/plugin-certification-scanner.md`).
 *
 * Two hard rules from the brief are enforced here:
 * - red flags are never suppressed (no trusted-plugin list, no auto-legit);
 * - the report is loud about its own limitations (a "clean" result is only
 *   ever "clean on statically visible patterns").
 *
 * Implementation: the TypeScript compiler API over the emitted `.js`/`.mjs`/
 * `.cjs` files (regex/string-matching provably misses quoted requires and the
 * `node:` prefix — see the brief's Pilar B evidence).
 */

/** The sensitive-module set from the brief (normalized, `node:` stripped). */
export const SENSITIVE_MODULES = new Set([
  "net",
  "tls",
  "http",
  "https",
  "http2",
  "dgram",
  "dns",
  "child_process",
  "fs",
  "fs/promises",
  "worker_threads",
  "cluster",
  "vm",
  "process",
]);

/** Network modules — direct use without a declared `network:*` permission is a
 * permission-mismatch finding (the "unauthorized network call" case). */
const NETWORK_MODULES = new Set([
  "net",
  "tls",
  "http",
  "https",
  "http2",
  "dgram",
  "dns",
]);

/** Modules that are capability-escape primitives — always critical. */
const CRITICAL_MODULES = new Set(["child_process", "worker_threads", "cluster", "vm"]);

export type ScanFindingSeverity = "critical" | "advisory";
export type ScanFindingKind = "module" | "pattern" | "permission";

export interface ScanFinding {
  severity: ScanFindingSeverity;
  kind: ScanFindingKind;
  /** Human-readable description. */
  detail: string;
  /** How it was triggered (`require()`, `import`, `new`, `call`, …). */
  via: string;
  /** Path relative to the plugin root. */
  file: string;
  /** 1-based line in the scanned file. */
  line?: number;
}

export interface ScanReport {
  pluginId: string;
  /** True when no *critical* finding is present. Advisories never fail the
   * scan — a human reviews them and signs. */
  passed: boolean;
  findings: ScanFinding[];
  /** Deterministic content hash of the plugin on disk (what gets certified). */
  contentHash: string;
  /** The manifest's declared permissions, as scanned. */
  manifestPermissions: string[];
  /** Every external module the bundle requires/imports (informative, sorted). */
  modules: string[];
  /** Number of bundle files scanned. */
  scannedFiles: number;
  /** The brief's mandatory loud limitations — always present in a report. */
  limitations: string[];
}

interface Flag extends Omit<ScanFinding, "file"> {}

function normalizeModule(spec: string): string {
  return spec.startsWith("node:") ? spec.slice(5) : spec;
}

/** Constant-fold a string expression (literal, template, `"a" + "b"`). */
function foldString(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isParenthesizedExpression(node)) {
    return foldString(node.expression);
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = foldString(node.left);
    const right = foldString(node.right);
    return left !== null && right !== null ? left + right : null;
  }
  return null;
}

/** Unwrap parens/comma-sequences so `(0, eval)` and `globalThis["eval"]` are caught. */
function calleeName(expr: ts.Expression): string | null {
  let n = expr;
  while (ts.isParenthesizedExpression(n)) n = n.expression;
  if (
    ts.isBinaryExpression(n) &&
    n.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    n = n.right;
    while (ts.isParenthesizedExpression(n)) n = n.expression;
  }
  if (ts.isIdentifier(n)) return n.text;
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (ts.isElementAccessExpression(n)) {
    return foldString(n.argumentExpression);
  }
  if (ts.isToken(n)) return ts.tokenToString(n.kind) ?? null;
  return null;
}

function scanSource(source: string): { flags: Flag[]; modules: string[] } {
  const flags: Flag[] = [];
  const modules = new Set<string>();
  let seenProcessEnv = false;

  const sf = ts.createSourceFile(
    "scan.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const lineOf = (node: ts.Node): number | undefined => {
    const pos = node.getStart(sf);
    return pos >= 0 ? ts.getLineAndCharacterOfPosition(sf, pos).line + 1 : undefined;
  };

  function checkModuleSpecifier(
    node: ts.Expression | undefined,
    kind: "require()" | "import()" | "import" | "export-from" | "import-equals",
    line?: number,
  ): void {
    if (!node) return;
    const spec = foldString(node);
    if (spec !== null) {
      const bare = normalizeModule(spec);
      modules.add(spec);
      if (SENSITIVE_MODULES.has(bare)) {
        flags.push({
          severity: CRITICAL_MODULES.has(bare) ? "critical" : "advisory",
          kind: "module",
          detail: `requires sensitive module "${bare}"`,
          via: kind,
          line,
        });
      }
    } else {
      flags.push({
        severity: "critical",
        kind: "pattern",
        detail: "require/import specifier is not a constant (runtime-computed path)",
        via: kind,
        line,
      });
    }
  }

  function visit(n: ts.Node): void {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression);
      if (name === "require" && n.arguments.length > 0) {
        checkModuleSpecifier(n.arguments[0], "require()", lineOf(n));
      } else if (name === "import" && n.arguments.length > 0) {
        checkModuleSpecifier(n.arguments[0], "import()", lineOf(n));
      } else if (name === "eval") {
        flags.push({
          severity: "critical",
          kind: "pattern",
          detail: "direct eval call",
          via: "call",
          line: lineOf(n),
        });
      } else if (name === "Function") {
        flags.push({
          severity: "critical",
          kind: "pattern",
          detail: "Function constructor call",
          via: "call",
          line: lineOf(n),
        });
      }
    }

    if (ts.isNewExpression(n)) {
      const name = calleeName(n.expression);
      if (name === "Function") {
        flags.push({
          severity: "critical",
          kind: "pattern",
          detail: "new Function(...) constructor",
          via: "new",
          line: lineOf(n),
        });
      }
    }

    if (ts.isImportDeclaration(n)) {
      const typeOnly = !!n.importClause && n.importClause.isTypeOnly;
      if (!typeOnly) {
        checkModuleSpecifier(n.moduleSpecifier, "import", lineOf(n));
      }
    }
    if (ts.isExportDeclaration(n)) {
      if (!n.isTypeOnly) {
        checkModuleSpecifier(n.moduleSpecifier, "export-from", lineOf(n));
      }
    }
    if (
      ts.isImportEqualsDeclaration(n) &&
      ts.isExternalModuleReference(n.moduleReference)
    ) {
      checkModuleSpecifier(n.moduleReference.expression, "import-equals", lineOf(n));
    }

    if (
      !seenProcessEnv &&
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "process" &&
      n.name.text === "env"
    ) {
      seenProcessEnv = true;
      flags.push({
        severity: "advisory",
        kind: "pattern",
        detail: "process.env access (one per file)",
        via: "member",
        line: lineOf(n),
      });
    }

    ts.forEachChild(n, visit);
  }

  visit(sf);
  return { flags, modules: [...modules] };
}

/** Recursively collect bundle `.js`/`.mjs`/`.cjs` files, never following
 * symlinks, skipping node_modules/test-build/map artifacts. */
function collectBundleJsFiles(dir: string, out: string[] = []): void {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      collectBundleJsFiles(path.join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (
      !/\.(js|mjs|cjs)$/.test(entry.name) ||
      entry.name.endsWith(".test.js") ||
      entry.name.endsWith(".spec.js") ||
      entry.name.endsWith(".js.map")
    ) {
      continue;
    }
    out.push(path.join(dir, entry.name));
  }
}

/**
 * The loud limitations every report carries (brief Pilar C). Never trimmed —
 * a scanner that hides its own weakness is worse than no scanner.
 */
export const SCANNER_LIMITATIONS: string[] = [
  "static analysis only: runtime-computed module paths are flagged but not followed",
  "obfuscation/string-encoding escapes static analysis — a clean scan is NOT a safety certificate",
  "runtime redirection (prototype patching, monkey-patching, child_process of a fresh node) is not statically catchable",
  "the bundle on disk is scanned; source can be obfuscated before build",
  "permission-vs-behaviour checks only flag module usage WITHOUT a declared permission — over-declared permissions are not flagged (platform-provided networking never shows in plugin code)",
];

/**
 * Scan a built plugin directory. Scans the bundle directory containing
 * `manifest.entry` (the executable behaviour — never `src/`), then verifies
 * the manifest's declared permissions against observed module usage and
 * computes the plugin's content hash.
 */
export async function scanPluginDirectory(
  pluginDir: string,
): Promise<ScanReport> {
  const manifestPath = path.join(pluginDir, "manifest.json");
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new Error(`cannot read/parse manifest at ${manifestPath}`);
  }
  const pluginId =
    typeof manifest.id === "string" ? manifest.id : path.basename(pluginDir);
  const permissions = Array.isArray(manifest.permissions)
    ? (manifest.permissions as unknown[]).filter(
        (p): p is string => typeof p === "string",
      )
    : [];
  const entry =
    typeof manifest.entry === "string" ? manifest.entry : "./dist/index.js";
  const bundleDir = path.resolve(pluginDir, path.dirname(entry));

  const files: string[] = [];
  collectBundleJsFiles(bundleDir, files);

  const flags: ScanFinding[] = [];
  const modules = new Set<string>();
  for (const file of files) {
    let source: string;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = path.relative(pluginDir, file);
    const result = scanSource(source);
    for (const flag of result.flags) {
      flags.push({
        severity: flag.severity,
        kind: flag.kind,
        detail: flag.detail,
        via: flag.via,
        line: flag.line,
        file: rel,
      });
    }
    for (const m of result.modules) {
      modules.add(m);
    }
  }

  // Permission-vs-behaviour: every sensitive module usage must be covered by a
  // declared permission, or it is a red flag for the human reviewer. Never an
  // auto-legit, never suppressed (brief Pilar C rule 2).
  for (const moduleName of [...modules].map(normalizeModule).sort()) {
    if (NETWORK_MODULES.has(moduleName)) {
      const hasNetworkPermission = permissions.some((p) =>
        p.startsWith("network:"),
      );
      if (!hasNetworkPermission) {
        flags.push({
          severity: "advisory",
          kind: "permission",
          detail: `network module "${moduleName}" used but the manifest declares no network:* permission`,
          via: "permission-cross-check",
          file: "(aggregate)",
        });
      }
    } else if (moduleName === "fs" || moduleName === "fs/promises") {
      flags.push({
        severity: "advisory",
        kind: "permission",
        detail: `filesystem module "${moduleName}" used; the manifest declares no capability that corresponds to filesystem access`,
        via: "permission-cross-check",
        file: "(aggregate)",
      });
    }
  }

  const findings = flags.sort(
    (a, b) =>
      (b.severity === "critical" ? 1 : 0) - (a.severity === "critical" ? 1 : 0),
  );
  const contentHash = await computePluginContentHash(pluginDir);
  return {
    pluginId,
    passed: findings.every((f) => f.severity !== "critical"),
    findings,
    contentHash,
    manifestPermissions: [...permissions],
    modules: [...modules].sort(),
    scannedFiles: files.length,
    limitations: [...SCANNER_LIMITATIONS],
  };
}
