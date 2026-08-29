"use strict";

/**
 * Runs the desktop-shell node:test suites from dist-tests/.
 *
 * The test script must enumerate the bundled files explicitly instead of
 * relying on a shell glob (`dist-tests/*.test.js`): Windows cmd.exe does not
 * expand globs, and Node < 22 does not expand globs in `--test` arguments
 * either (only Node 22+ does). Passing the explicit file list makes the same
 * script work on every platform and Node version in the CI matrix.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const distDir = path.join(__dirname, "..", "dist-tests");

const files = fs
  .readdirSync(distDir)
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => path.join(distDir, f));

if (files.length === 0) {
  console.error(`no test files found under ${distDir}`);
  process.exit(1);
}

const timeoutMs = process.env.TEST_TIMEOUT_MS ?? "30000";
const args = ["--test"];
if (Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0) {
  args.push(`--test-timeout=${timeoutMs}`);
}
args.push(...files);

const result = spawnSync(process.execPath, args, {
  stdio: "inherit",
});

process.exit(result.status === null ? 1 : result.status);
