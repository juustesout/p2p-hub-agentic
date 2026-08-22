"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const distDir = path.join(process.cwd(), "dist");

function findTests(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findTests(full, out);
    } else if (entry.name.endsWith(".test.js")) {
      out.push(full);
    }
  }
  return out;
}

const files = findTests(distDir);
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
