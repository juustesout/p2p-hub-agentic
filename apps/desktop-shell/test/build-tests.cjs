"use strict";

/**
 * Bundles the desktop-shell node:test suites with esbuild.
 *
 * The services under test are browser-oriented (they read `location`/`window`
 * and dynamically import `@tauri-apps/api/core`), so:
 *   - `test/test-globals.ts` is imported by each test and installs the DOM
 *     globals the services need before they are evaluated;
 *   - the `@tauri-apps/api/core` specifier is redirected to
 *     `test/stubs/tauri-core.ts`, which exposes the mutable `__tauri` holder
 *     the tests drive;
 *   - esbuild bundles `node:test`, the services and the globals into one file
 *     per test suite, so no runtime dependencies are required.
 */

const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const shellRoot = path.join(__dirname, "..");
const testDir = path.join(shellRoot, "test");
const outDir = path.join(shellRoot, "dist-tests");
const tauriStub = path.join(testDir, "stubs", "tauri-core.ts");
// Mirror the vite.config.ts alias: consume the SDK from TypeScript source, not
// its CommonJS dist. The compiled barrel is CJS whose nested `require("node:crypto")`
// cannot be converted to a node ESM bundle; the source is ESM with importable
// node built-ins, so it bundles cleanly here (same reason the app uses it).
const sdkSource = path.join(shellRoot, "..", "..", "sdk", "src", "index.ts");

const entryPoints = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => path.join(testDir, f));

if (entryPoints.length === 0) {
  console.error("no *.test.ts files found under apps/desktop-shell/test");
  process.exit(1);
}

esbuild
  .build({
    entryPoints,
    outdir: outDir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: false,
    logLevel: "error",
    plugins: [
      {
        name: "sdk-source-alias",
        setup(build) {
          build.onResolve(
            { filter: /^@p2p-hub\/sdk$/ },
            () => ({ path: sdkSource }),
          );
        },
      },
      {
        name: "tauri-core-stub",
        setup(build) {
          build.onResolve(
            { filter: /^@tauri-apps\/api\/core$/ },
            () => ({ path: tauriStub }),
          );
        },
      },
    ],
  })
  .then(() => {
    console.log(
      `built ${entryPoints.length} desktop-shell test bundle(s) -> ${path.relative(
        shellRoot,
        outDir,
      )}`,
    );
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
