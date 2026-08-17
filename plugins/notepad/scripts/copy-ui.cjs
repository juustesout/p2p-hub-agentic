// Copy the static web UI (src/ui/*) into dist/ so the manifest's
// `ui.entry` (dist/index.html) is satisfiable. `tsc` only emits the compiled
// JS/typings; it does not copy non-TypeScript assets.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const srcDir = path.join(__dirname, "..", "src", "ui");
const outDir = path.join(__dirname, "..", "dist");

fs.mkdirSync(outDir, { recursive: true });

for (const name of fs.readdirSync(srcDir)) {
  fs.copyFileSync(path.join(srcDir, name), path.join(outDir, name));
}

console.log(`[notepad] copied UI assets from src/ui to dist`);
