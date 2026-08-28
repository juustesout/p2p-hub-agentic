#!/usr/bin/env node
// Build the p2p-hub-core Single Executable Application (SEA) binary.
//
// Pipeline (matches the Node 22 SEA docs):
//   1. esbuild-bundle apps/core-server/src/index.ts -> dist/bundle.cjs
//      (CommonJS, Node 22 target, minified). The bundle replaces the
//      node_modules dependency on the target machine — the binary runs on any
//      Linux/Windows/macOS without Node installed.
//   2. node --experimental-sea-config sea-config.json -> dist/sea-prep.blob
//      (the V8 code cache, `useCodeCache: true`, is generated at blob-build
//      time in Node 22, not on first run — no two-phase warm-up needed).
//   3. Copy the running Node binary -> p2p-hub-core and postject-inject the
//      blob (with the platform-specific Mach-O segment on macOS).
//   4. Re-sign the macOS binary (ad-hoc) — SEA injection invalidates the
//      original signature.
//   5. Place the binary in the Tauri `bin/` dir under the target-triple name
//      Tauri's `bundle.externalBin` expects.
//
// Outputs:
//   dist/bundle.cjs          — the self-contained bundle (also used by the
//                              `npm run test:sea` regression suite)
//   dist/sea-prep.blob       — the SEA preparation blob (never shipped)
//   dist/bin/p2p-hub-core[.exe]           — the injectable binary (for manual
//                                           runs and the standalone tests)
//   ../desktop-shell/src-tauri/bin/p2p-hub-core-<target-triple> — Tauri sidecar
//
// Requires a Node 20.6+ runtime (the copy of `process.execPath` IS the binary
// base). Node 22 is the supported target; on 20 the SEA API is experimental.

"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const BIN_DIR = path.join(DIST, "bin");
const TAUIR_BIN_DIR = path.resolve(ROOT, "../desktop-shell/src-tauri/bin");
const SEA_CONFIG = path.join(ROOT, "sea-config.json");
const BLOB = path.join(DIST, "sea-prep.blob");
const BUNDLE = path.join(DIST, "bundle.cjs");

const pkg = require(path.join(ROOT, "package.json"));
const VERSION = pkg.version || "0.0.0";

// The FUSE sentinel Node's loader uses to find the injected blob. Must match
// postject's default AND the value compiled into Node (node_sea.cc).
const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

// Target-triple naming Tauri's `bundle.externalBin` expects.
function targetTriple() {
  const arch = os.arch();
  const platform = os.platform();
  if (platform === "darwin") {
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (platform === "win32") {
    return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }
  if (platform === "linux") {
    if (arch === "arm64") return "aarch64-unknown-linux-gnu";
    if (arch === "arm") return "armv7-unknown-linux-gnueabihf";
    return "x86_64-unknown-linux-gnu";
  }
  throw new Error(`unsupported platform for SEA build: ${platform}/${arch}`);
}

// Bundle prelude. This is injected VERBATIM at the top of the CJS bundle (esbuild
// does not minify banner content), so it must be plain CommonJS.
//
// 1. crypto: bundled libraries (node-forge via network-light) can touch the
//    WebCrypto global under esbuild's module wrapper. Node 22 already ships
//    `globalThis.crypto`, but the shim makes the dependency explicit and the
//    SEA run identical to the plain-node run regardless of bundling quirks.
// 2. Native-module guard: `*.node` requires are never inlined (esbuild
//    external). A native addon ships as a file next to the binary; when a
//    `.node` require cannot be resolved, retry the conventional native-lib
//    dirs (`<binaryDir>/bin/lib`, `<binaryDir>/lib`, `<binaryDir>/bin`) and
//    otherwise fail LOUDLY with the exact module path and the candidate
//    locations — never a bare MODULE_NOT_FOUND that looks like a missing
//    bundle file.
const BANNER = `/* p2p-hub-core SEA prelude */
const __p2p_hub_sea_prelude = (() => {
  const Module = require("node:module");
  const path = require("node:path");
  const fs = require("node:fs");
  try {
    const { webcrypto } = require("node:crypto");
    if (typeof globalThis.crypto === "undefined") {
      globalThis.crypto = webcrypto;
    }
  } catch (_) {}
  const __p2p_resolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    try {
      return __p2p_resolve.call(this, request, parent, isMain, options);
    } catch (err) {
      if (err && err.code === "MODULE_NOT_FOUND" && request.endsWith(".node")) {
        const base = path.basename(request);
        const binDir =
          typeof __dirname !== "undefined" ? __dirname : process.cwd();
        const candidates = [
          path.join(binDir, "bin", "lib", base),
          path.join(binDir, "lib", base),
          path.join(binDir, "bin", base),
        ];
        for (const candidate of candidates) {
          if (fs.existsSync(candidate)) {
            return __p2p_resolve.call(this, candidate, parent, isMain, options);
          }
        }
        const loud = new Error(
          "[p2p-hub-core] native module \\"" + request +
          "\\" is not bundled and was not found next to the binary. " +
          "Tried: " + candidates.join(", ") + ". " +
          "A SEA binary cannot load a native addon that is missing from its " +
          "shipment; rebuild from a checkout that contains it."
        );
        loud.code = "MODULE_NOT_FOUND";
        throw loud;
      }
      throw err;
    }
  };
})();
`;

function step(msg) {
  console.log(`[build-sea] ${msg}`);
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

async function main() {
  const esbuild = require("esbuild");

  step(`bundling core-server (v${VERSION}) -> ${path.relative(ROOT, BUNDLE)}`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "index.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: BUNDLE,
    minify: true,
    legalComments: "none",
    // Native addons are never inlined; they ship as files next to the binary
    // (see the prelude). ws's optional native deps are not installed here and
    // must stay as plain runtime requires (ws falls back to its JS impl).
    external: ["*.node", "bufferutil", "utf-8-validate"],
    define: {
      __P2P_HUB_CORE_VERSION__: JSON.stringify(VERSION),
    },
    banner: { js: BANNER },
    logLevel: "info",
  });

  step("generating SEA preparation blob (with V8 code cache)");
  run(process.execPath, ["--experimental-sea-config", SEA_CONFIG], {
    cwd: ROOT,
  });

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const isWindows = process.platform === "win32";
  const binaryName = isWindows ? "p2p-hub-core.exe" : "p2p-hub-core";
  const binary = path.join(BIN_DIR, binaryName);

  step(`copying node binary -> ${path.relative(ROOT, binary)}`);
  fs.copyFileSync(process.execPath, binary);
  fs.chmodSync(binary, 0o755);

  step("injecting blob via postject");
  const postjectArgs = [
    path.join(__dirname, "..", "..", "..", "node_modules", "postject", "dist", "cli.js"),
    binary,
    "NODE_SEA_BLOB",
    BLOB,
    "--sentinel-fuse",
    SENTINEL_FUSE,
    "--overwrite",
  ];
  if (process.platform === "darwin") {
    postjectArgs.push("--macho-segment-name", "NODE_SEA");
  }
  run(process.execPath, postjectArgs);

  if (process.platform === "darwin") {
    // Injection invalidates the original code signature; re-sign ad-hoc so the
    // binary stays executable on Apple Silicon. Best-effort: codesign is a
    // macOS-only tool.
    step("re-signing (ad-hoc codesign)");
    try {
      run("codesign", ["--force", "--sign", "-", binary]);
    } catch (err) {
      console.warn(`[build-sea] codesign failed (continuing): ${err.message}`);
    }
  }

  step(`built ${binary} (${(fs.statSync(binary).size / 1024 / 1024).toFixed(1)} MiB)`);

  const triple = targetTriple();
  const tauriBinary = path.join(TAUIR_BIN_DIR, `p2p-hub-core-${triple}${isWindows ? ".exe" : ""}`);
  fs.mkdirSync(TAUIR_BIN_DIR, { recursive: true });
  fs.copyFileSync(binary, tauriBinary);
  fs.chmodSync(tauriBinary, 0o755);
  step(`copied Tauri sidecar -> ${path.relative(ROOT, tauriBinary)}`);

  console.log("\n[build-sea] done. Standalone binary:");
  console.log(`  ${binary}`);
  console.log("Run it like the desktop shell does:");
  console.log(`  P2P_HUB_PORT=0 P2P_HUB_SIDECAR_READY=1 ${binary}`);
}

main().catch((err) => {
  console.error("[build-sea] FAILED:", err);
  process.exit(1);
});
