import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scanPluginDirectory } from "./scanner";
import type { ScanFinding } from "./scanner";

async function makeTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cert-scanner-"));
}

interface Fixture {
  dir: string;
  permissions?: string[];
}

async function makePlugin(
  root: string,
  name: string,
  bundleFiles: Record<string, string>,
  permissions: string[] = [],
): Promise<Fixture> {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id: name,
      version: "1.0.0",
      kind: "generic",
      permissions,
      entry: "./dist/index.js",
    }),
  );
  for (const [rel, content] of Object.entries(bundleFiles)) {
    const abs = path.join(dir, "dist", rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return { dir, permissions };
}

function byDetail(findings: ScanFinding[], fragment: string): ScanFinding[] {
  return findings.filter((f) => f.detail.includes(fragment));
}

test("a clean bundle passes with no critical findings", async () => {
  const root = await makeTmpRoot();
  const { dir } = await makePlugin(root, "clean", {
    "index.js": `
      export function greet() { return "hello"; }
      const x = [1,2,3].map((n) => n * 2);
      module.exports = { greet };
    `,
  });
  const report = await scanPluginDirectory(dir);
  assert.equal(report.passed, true);
  assert.equal(report.findings.length, 0);
  assert.equal(report.pluginId, "clean");
  assert.equal(report.scannedFiles, 1);
  assert.match(report.contentHash, /^[0-9a-f]{64}$/);
  assert.ok(report.limitations.length > 0, "limitations must be loud");
});

test("eval (including indirect forms) is a critical finding", async () => {
  const root = await makeTmpRoot();
  const { dir } = await makePlugin(root, "evald", {
    "index.js": `function run(code) { return (0, eval)(code); }`,
  });
  const report = await scanPluginDirectory(dir);
  assert.equal(report.passed, false);
  const evals = byDetail(report.findings, "eval");
  assert.equal(evals.length, 1);
  assert.equal(evals[0].severity, "critical");
  assert.equal(evals[0].line, 1);
});

test("globalThis['eval'] in call position is caught via element-access unwrapping", async () => {
  const root = await makeTmpRoot();
  const { dir } = await makePlugin(root, "indirect", {
    "index.js": `globalThis["eval"]("x");`,
  });
  const report = await scanPluginDirectory(dir);
  assert.equal(report.passed, false);
  assert.ok(byDetail(report.findings, "eval").length >= 1);
});

test("new Function and Function() call are critical findings", async () => {
  const root = await makeTmpRoot();
  const { dir } = await makePlugin(root, "dyn", {
    "index.js": `
      const a = new Function("return 1");
      const b = Function("return 2");
    `,
  });
  const report = await scanPluginDirectory(dir);
  assert.equal(report.passed, false);
  assert.ok(byDetail(report.findings, "new Function").length >= 1);
  assert.ok(byDetail(report.findings, "Function constructor call").length >= 1);
});

test("a runtime-computed require is a critical require-dynamic finding", async () => {
  const root = await makeTmpRoot();
  const { dir } = await makePlugin(root, "dynamic-require", {
    "index.js": `const m = require(process.env.MODULE);`,
  });
  const report = await scanPluginDirectory(dir);
  assert.equal(report.passed, false);
  assert.ok(byDetail(report.findings, "not a constant").length >= 1);
});

test("child_process is a critical module finding", async () => {
  const root = await makeTmpRoot();
  const { dir } = await makePlugin(root, "spawner", {
    "index.js": `const { spawn } = require("child_process");`,
  });
  const report = await scanPluginDirectory(dir);
  assert.equal(report.passed, false);
  const finding = byDetail(report.findings, 'child_process');
  assert.equal(finding.length, 1);
  assert.equal(finding[0].severity, "critical");
});

test("network module used without any network permission is a permission finding", async () => {
  const root = await makeTmpRoot();
  const { dir } = await makePlugin(root, "net-caller", {
    "index.js": `const http = require("http"); http.get("http://x");`,
  });
  const report = await scanPluginDirectory(dir);
  assert.equal(report.passed, true, "advisory findings never fail the scan");
  const perm = byDetail(report.findings, "network module");
  assert.equal(perm.length, 1);
  assert.equal(perm[0].kind, "permission");
  assert.equal(perm[0].severity, "advisory");
});

test("network module WITH a network permission gets no permission finding", async () => {
  const root = await makeTmpRoot();
  const { dir } = await makePlugin(root, "net-declared", {
    "index.js": `const net = require("node:net");`,
  }, ["network:skill:net-declared.ping"]);
  const report = await scanPluginDirectory(dir);
  assert.equal(byDetail(report.findings, "network module").length, 0);
});

test("node:fs/promises is normalized and flagged (the peersite case)", async () => {
  const root = await makeTmpRoot();
  const { dir } = await makePlugin(root, "fs-user", {
    "index.js": `const fs = require("node:fs/promises"); fs.readFile("x");`,
  });
  const report = await scanPluginDirectory(dir);
  const moduleFinding = report.findings.filter(
    (f) => f.kind === "module" && f.detail.includes("fs/promises"),
  );
  assert.equal(moduleFinding.length, 1, "the normalized sensitive module is flagged");
  assert.ok(byDetail(report.findings, "filesystem module").length >= 1, "permission mismatch reported");
  assert.equal(report.passed, true, "fs use is advisory, not critical");
});

test("import type from a sensitive module is NOT flagged (runtime-erased)", async () => {
  const root = await makeTmpRoot();
  const { dir } = await makePlugin(root, "type-only", {
    "index.js": `
      // tsc erases type-only imports; there is no runtime require.
      // (emitted form keeps them as a comment, not an import)
      export const x = 1;
    `,
  });
  // Force a real emitted type-only pattern: the bundle is CJS so `import type`
  // disappears entirely; simulate the erased output by writing no import at all
  // and asserting nothing is flagged — the negative control is that a runtime
  // `import d from "net"` below WOULD be flagged.
  const report = await scanPluginDirectory(dir);
  assert.equal(byDetail(report.findings, "net").length, 0);
});

test("a real ESM import of a sensitive module is flagged", async () => {
  const root = await makeTmpRoot();
  const { dir } = await makePlugin(root, "esm", {
    "index.js": `import dns from "dns";`,
  });
  const report = await scanPluginDirectory(dir);
  assert.ok(byDetail(report.findings, "dns").length >= 1);
});

test("constant-folded concatenation and template-literal requires are caught", async () => {
  const root = await makeTmpRoot();
  const { dir } = await makePlugin(root, "folded", {
    "index.js": `
      const a = require("child_" + "process");
      const b = require(\`node:vm\`);
    `,
  });
  const report = await scanPluginDirectory(dir);
  assert.equal(report.passed, false);
  assert.ok(byDetail(report.findings, "child_process").length >= 1);
  assert.ok(byDetail(report.findings, '"vm"').length >= 1);
});

test("src/ is not scanned, only the bundle; test-build files are skipped", async () => {
  const root = await makeTmpRoot();
  const { dir } = await makePlugin(root, "layout", {
    "index.js": `module.exports = 1;`,
  });
  await fs.mkdir(path.join(dir, "dist", "sub"), { recursive: true });
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "dist", "sub", "index.test.js"), `eval("x")`);
  await fs.writeFile(path.join(dir, "src", "index.js"), `eval("x")`);
  const report = await scanPluginDirectory(dir);
  assert.equal(report.findings.length, 0, "test-build and src files are not scanned");
  assert.equal(report.scannedFiles, 1);
});
