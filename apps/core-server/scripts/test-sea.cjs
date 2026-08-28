// SEA regression suite (acceptance tests for the `p2p-hub-core` binary).
//
// Run AFTER `npm run build:sea` (it does not build — it verifies the artifact):
//   npm run test:sea
//
// Covers:
//   1. Bundle code quality: CJS format, the native-module/crypto prelude is
//      present, no sourcemaps, no absolute monorepo paths leaked in.
//   2. Build reproducibility: esbuild emits byte-identical bundles for the
//      same input (same source → same artifact, twice).
//   3. Injection: the `dist/bin/p2p-hub-core` binary actually embeds the SEA
//      blob (it is not a plain `node` copy).
//   4. Standalone execution: the binary boots in a clean environment (no Node
//      on PATH), reports `p2p-hub-core v<version>`, binds an OS-assigned port,
//      emits the `[P2P_HUB_READY]` handshake with a `ready` state, and shuts
//      down cleanly on SIGTERM.

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const BUNDLE = path.join(DIST, "bundle.cjs");
const BINARY = path.join(DIST, "bin", process.platform === "win32" ? "p2p-hub-core.exe" : "p2p-hub-core");
const SENTINEL = Buffer.from("NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2");
const VERSION = require(path.join(ROOT, "package.json")).version;

function requireExists(file, hint) {
  assert.ok(fs.existsSync(file), `${hint}: missing ${file}`);
}

function bundleTwice() {
  const esbuild = require("esbuild");
  const target = os.tmpdir();
  const opts = {
    entryPoints: [path.join(ROOT, "src", "index.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    minify: true,
    legalComments: "none",
    external: ["*.node", "bufferutil", "utf-8-validate"],
    define: { __P2P_HUB_CORE_VERSION__: JSON.stringify(VERSION) },
    logLevel: "silent",
  };
  return (async () => {
    const out1 = path.join(target, `p2p-hub-repro-${process.pid}-a.cjs`);
    const out2 = path.join(target, `p2p-hub-repro-${process.pid}-b.cjs`);
    await Promise.all([
      esbuild.build({ ...opts, outfile: out1 }),
      esbuild.build({ ...opts, outfile: out2 }),
    ]);
    return { out1, out2 };
  })();
}

// Boot the SEA binary in sidecar mode inside a clean, Node-free environment.
// Resolves once the `[P2P_HUB_READY]` line is seen, together with the exit
// promise (attached BEFORE the kill so the clean-exit assertion can never race
// the SIGTERM).
function bootSeaBinary(dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(BINARY, [], {
      env: {
        // Deliberately NO PATH: the binary must run without Node anywhere on
        // the system. P2P_HUB_NETWORKING=0 keeps the boot quiet and fast. No
        // P2P_HUB_PLUGINS_DIR: the standalone boot must self-resolve its
        // plugins dir (falling back to <dataDir>/plugins).
        P2P_HUB_PORT: "0",
        P2P_HUB_SIDECAR_READY: "1",
        P2P_HUB_NETWORKING: "0",
        P2P_HUB_DATA_DIR: dataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const exitPromise = new Promise((resolveExit) => {
      child.on("exit", (code, signal) => resolveExit({ code, signal }));
    });
    child.stdout.on("data", (d) => {
      stdout += d.toString();
      const line = stdout
        .split("\n")
        .find((l) => l.startsWith("[P2P_HUB_READY] "));
      if (line && !settled) {
        settled = true;
        child.kill("SIGTERM");
        resolve({ child, line, stdout, exitPromise });
      }
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(
          new Error(
            `timed out booting SEA binary\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
      }
    }, 45000);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (!settled && signal !== "SIGTERM") {
        settled = true;
        reject(
          new Error(
            `SEA binary exited before ready (code=${code}, signal=${signal})\n${stdout}\n${stderr}`,
          ),
        );
      }
    });
  });
}

test("bundle is CJS with the SEA prelude and no dev-only artifacts", () => {
  requireExists(BUNDLE, "run `npm run build:sea` first");
  const code = fs.readFileSync(BUNDLE, "utf8");

  assert.match(
    code,
    /p2p-hub-core SEA prelude/,
    "the crypto + native-module prelude must be embedded in the bundle",
  );
  assert.match(
    code,
    /Module\._resolveFilename/,
    "the native-module resolver guard must be present",
  );
  assert.doesNotMatch(
    code,
    /sourceMappingURL=data:/,
    "no inline sourcemap may be embedded in a release bundle",
  );
  assert.ok(
    !fs.existsSync(path.join(DIST, "bundle.cjs.map")),
    "no external sourcemap file may be emitted for the release bundle",
  );
  assert.doesNotMatch(
    code,
    /\/workspace\//,
    "no absolute monorepo paths may leak into the shipped bundle",
  );
  // ws's optional native deps (not installed, JS-fallback at runtime) must stay
  // as plain runtime requires — esbuild must NOT have tried to bundle them.
  assert.match(
    code,
    /require\(["']bufferutil["']\)/,
    "ws's bufferutil must remain an external runtime require",
  );
  assert.match(
    code,
    /require\(["']utf-8-validate["']\)/,
    "ws's utf-8-validate must remain an external runtime require",
  );
});

test("esbuild bundling is reproducible (same input, same bytes)", async () => {
  const { out1, out2 } = await bundleTwice();
  const a = fs.readFileSync(out1);
  const b = fs.readFileSync(out2);
  assert.ok(a.equals(b), "two builds of the same source must be byte-identical");
});

test("the SEA binary embeds the blob (not a bare node copy)", () => {
  requireExists(BINARY, "run `npm run build:sea` first");
  const head = fs.readFileSync(BINARY);
  assert.ok(
    head.includes(SENTINEL),
    "the NODE_SEA_FUSE sentinel must be present in the injected binary",
  );
});

test("standalone boot: ready handshake, version, clean SIGTERM shutdown", async () => {
  requireExists(BINARY, "run `npm run build:sea` first");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-hub-sea-test-"));
  const { child, line, stdout, exitPromise } = await bootSeaBinary(dataDir);

  assert.match(line, /^\[P2P_HUB_READY\] \{/);
  const payload = JSON.parse(line.slice("[P2P_HUB_READY] ".length));
  assert.strictEqual(payload.state, "ready");
  assert.ok(payload.port > 0 && payload.port <= 65535, "an OS-assigned port must be bound");
  assert.ok(payload.token && payload.token.length > 0, "a non-empty boot token must be reported");
  assert.match(stdout, new RegExp(`p2p-hub-core v${VERSION.replace(/\./g, "\\.")}`));

  const exit = await exitPromise;
  assert.strictEqual(exit.code, 0, "SIGTERM must trigger a clean shutdown (exit 0)");
});
