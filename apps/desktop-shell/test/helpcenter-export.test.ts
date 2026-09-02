import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bundleFilename,
  bundleJson,
  copyToClipboard,
  downloadTextFile,
  type ClipboardLike,
  type DownloadEnv,
} from "../src/components/helpcenter/export";
import type { DiagnosticBundle } from "../src/types";

function bundle(): DiagnosticBundle {
  return {
    kind: "p2p-hub-diagnostic-bundle",
    version: 1,
    createdAt: 0,
    snapshot: {},
    logs: [],
    userNote: "noot",
    preview: { sections: ["system"], logSources: [], hasNote: true, redacted: true },
    redacted: true,
  } as DiagnosticBundle;
}

test("bundleFilename is stable and filesystem-friendly", () => {
  const now = new Date(Date.UTC(2026, 8, 2, 15, 30, 45));
  assert.equal(bundleFilename(now), "p2p-hub-bundel-20260902-153045.json");
});

test("bundleJson pretty-prints with a trailing newline", () => {
  const json = bundleJson(bundle());
  assert.ok(json.endsWith("\n"));
  assert.equal(JSON.parse(json).redacted, true);
});

test("copyToClipboard returns false with no clipboard available", async () => {
  assert.equal(await copyToClipboard("text"), false);
});

test("copyToClipboard reports success/failure from the injected clipboard", async () => {
  let written = "";
  const ok: ClipboardLike = { writeText: async (t) => void (written = t) };
  assert.equal(await copyToClipboard("hello", ok), true);
  assert.equal(written, "hello");
  const failing: ClipboardLike = {
    writeText: async () => {
      throw new Error("denied");
    },
  };
  assert.equal(await copyToClipboard("hello", failing), false);
});

test("downloadTextFile triggers a click with the right filename and blob url", () => {
  const holder: {
    anchor: { href: string; download: string } | null;
    clicked: number;
  } = { anchor: null, clicked: 0 };
  const env: DownloadEnv = {
    createElement: (tag) => {
      assert.equal(tag, "a");
      const anchor = { href: "", download: "", click: () => void (holder.clicked += 1) };
      holder.anchor = anchor;
      return anchor;
    },
    createObjectURL: (blob) => {
      assert.ok(blob instanceof Blob);
      return "blob:test";
    },
    revokeObjectURL: () => undefined,
  };
  const ok = downloadTextFile("bundel.json", "{}\n", env);
  assert.equal(ok, true);
  assert.equal(holder.clicked, 1);
  assert.ok(holder.anchor);
  assert.equal(holder.anchor.download, "bundel.json");
  assert.equal(holder.anchor.href, "blob:test");
});

test("downloadTextFile fails closed when the environment throws", () => {
  const env: DownloadEnv = {
    createElement: () => {
      throw new Error("no dom");
    },
    createObjectURL: (blob) => {
      void blob;
      return "";
    },
    revokeObjectURL: () => undefined,
  };
  assert.equal(downloadTextFile("x.json", "{}", env), false);
  // Without an environment and without a DOM, it cannot download either.
  assert.equal(downloadTextFile("x.json", "{}"), false);
});
