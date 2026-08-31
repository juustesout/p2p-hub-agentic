import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Root of the monorepo (this file lives in apps/desktop-shell/dist-tests).
const here = path.dirname(fileURLToPath(import.meta.url));
const shellRoot = path.resolve(here, "..");
const root = path.resolve(shellRoot, "..", "..");
const srcTauri = path.join(shellRoot, "src-tauri");

const tauriConf = JSON.parse(
  readFileSync(path.join(srcTauri, "tauri.conf.json"), "utf8"),
);
const cargoToml = readFileSync(path.join(srcTauri, "Cargo.toml"), "utf8");
const libRs = readFileSync(path.join(srcTauri, "src", "lib.rs"), "utf8");
const updateGuardRs = readFileSync(
  path.join(srcTauri, "src", "update_guard.rs"),
  "utf8",
);

const b64 = (s: string) => Buffer.from(s, "base64");

describe("Brief 4 — updater config hardening", () => {
  it("enables the updater with a baked-in pubkey (no unsigned-update path)", () => {
    const updater = tauriConf.plugins?.updater;
    assert.ok(updater, "plugins.updater must be present");
    assert.ok(
      typeof updater.pubkey === "string" && updater.pubkey.length > 0,
      "plugins.updater.pubkey must be a non-empty string",
    );
    assert.ok(
      tauriConf.bundle?.createUpdaterArtifacts === true,
      "bundle.createUpdaterArtifacts must be true so the release build produces signed updater artifacts",
    );
  });

  it("pubkey decodes to a valid minisign public-key box", () => {
    // The pubkey in config is base64 of a two-line minisign box:
    //   untrusted comment: minisign public key: <keynum hex>
    //   <base64 of 42-byte blob: "Ed" || keynum(8) || pk(32)>
    const box = b64(tauriConf.plugins.updater.pubkey).toString("utf8");
    const lines = box.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 2, "pubkey box must be exactly two non-empty lines");
    assert.match(
      lines[0],
      /^untrusted comment: minisign public key: [0-9A-F]{16}$/,
    );
    const blob = b64(lines[1].trim());
    assert.equal(blob.length, 42, "minisign public key blob must be 42 bytes");
    // Signature-algorithm header: "Ed" (0x45 0x64) or "ED" (0x45 0x44),
    // matching minisign_verify's PublicKey::from_base64 acceptance.
    assert.deepEqual(blob.subarray(0, 2), Buffer.from("Ed", "ascii"));
  });

  it("all updater endpoints are HTTPS-only", () => {
    const endpoints = tauriConf.plugins.updater.endpoints;
    assert.ok(Array.isArray(endpoints) && endpoints.length > 0, "endpoints must be non-empty");
    for (const endpoint of endpoints) {
      assert.ok(
        typeof endpoint === "string" && endpoint.startsWith("https://"),
        `endpoint must be https://, got: ${endpoint}`,
      );
      assert.ok(
        !/^http:\/\//.test(endpoint),
        `plain-http endpoint is forbidden: ${endpoint}`,
      );
    }
  });

  it("does not enable any updater 'dangerous' transport bypasses", () => {
    const updater = tauriConf.plugins.updater;
    for (const flag of [
      "dangerousInsecureTransportProtocol",
      "dangerous-insecure-transport-protocol",
      "dangerousAcceptInvalidCerts",
      "dangerous-accept-invalid-certs",
      "dangerousAcceptInvalidHostnames",
      "dangerous-accept-invalid-hostnames",
    ]) {
      assert.ok(
        !(flag in updater) || updater[flag] === false,
        `updater must not enable ${flag}`,
      );
    }
  });

  it("declares tauri-plugin-updater as a Rust dependency", () => {
    assert.match(cargoToml, /tauri-plugin-updater\s*=\s*"2"/);
  });

  it("registers the updater plugin with the downgrade-guard comparator", () => {
    assert.match(
      libRs,
      /tauri_plugin_updater::Builder::new\(\)/,
      "lib.rs must register the updater plugin",
    );
    assert.match(
      libRs,
      /\.default_version_comparator\(update_guard::should_offer_update\)/,
      "lib.rs must wire the downgrade guard as the version comparator",
    );
  });

  it("contains the exact downgrade-blocked log line", () => {
    assert.ok(
      updateGuardRs.includes("Downgrade or re-install attempt blocked for security"),
      "update_guard.rs must log the exact acceptance-criterion sentence",
    );
  });
});

describe("Brief 4 — CI signing protocol", () => {
  const workflowFiles = readdirSync(path.join(root, ".github", "workflows"))
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => path.join(root, ".github", "workflows", f));
  const workflows = workflowFiles.map((f) => ({ name: f, text: readFileSync(f, "utf8") }));

  it("has a release workflow that reads the signing key from GitHub Secrets", () => {
    const release = workflows.find((w) => w.text.includes("TAURI_SIGNING_PRIVATE_KEY"));
    assert.ok(release, "a workflow must reference TAURI_SIGNING_PRIVATE_KEY");
    assert.match(
      release.text,
      /\$\{\{\s*secrets\.TAURI_SIGNING_PRIVATE_KEY\s*\}\}/,
      "the signing key must come from GitHub Secrets, never from a hardcoded value",
    );
    // Every occurrence must be the secrets reference (env mapping or the guard
    // comparison) — a literal value next to the env name is the fail signal.
    const envMapping = release.text.match(
      /TAURI_SIGNING_PRIVATE_KEY:\s*(.*)$/m,
    );
    if (envMapping) {
      assert.match(
        envMapping[1],
        /\$\{\{\s*secrets\./,
        "TAURI_SIGNING_PRIVATE_KEY env must be bound to a secret reference",
      );
    }
  });

  it("release workflow fails closed when the signing key is absent", () => {
    const release = workflows.find((w) => w.text.includes("TAURI_SIGNING_PRIVATE_KEY"));
    assert.ok(release, "a release workflow must reference TAURI_SIGNING_PRIVATE_KEY");
    assert.ok(
      release.text.includes("exit 1") &&
        /refus.{0,20}unsigned/i.test(release.text),
      "release workflow must hard-fail (exit 1) when the signing key is missing",
    );
  });

  it("does not hardcode an updater private key anywhere in the repo", () => {
    // Scan for the base64 encoding of "untrusted comment: rsign" — the fixed
    // header of ANY minisign secret-key box (the format tauri-cli signs
    // with). This catches a committed signing key without embedding the actual
    // key value in this test (which would itself be a leak). The marker is
    // assembled from parts so it does not appear as a literal here.
    const marker = ["dW50cnVzdGVkIG", "NvbW1lbnQ6IHJzaWdu"].join("");
    const grep = (p: string) => {
      const entries = readdirSync(p, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.name === "node_modules" ||
          entry.name === "target" ||
          entry.name === "dist" ||
          entry.name === ".git"
        ) {
          continue;
        }
        const full = path.join(p, entry.name);
        if (entry.isDirectory()) {
          grep(full);
        } else if (/\.(ts|tsx|js|cjs|mjs|json|yml|yaml|toml|rs|md|sh)$/.test(entry.name)) {
          const content = readFileSync(full, "utf8");
          assert.ok(
            !content.includes(marker),
            `a minisign secret-key box must not be committed (found in ${full})`,
          );
        }
      }
    };
    grep(root);
  });

  it("no workflow binds TAURI_SIGNING_PRIVATE_KEY to a literal value", () => {
    for (const w of workflows) {
      for (const line of w.text.split("\n")) {
        if (!line.includes("TAURI_SIGNING_PRIVATE_KEY")) continue;
        // Only bindings matter (`KEY: value` / `KEY=value`); prose mentions in
        // error messages are fine. Every binding must reference `${{ secrets.`
        // — a literal value would mean the key is hardcoded.
        const isBinding = /TAURI_SIGNING_PRIVATE_KEY\s*[:=]/.test(line);
        if (isBinding && !/\$\{\{\s*secrets\./.test(line)) {
          assert.fail(
            `TAURI_SIGNING_PRIVATE_KEY bound to a non-Secret value in ${w.name}: ${line.trim()}`,
          );
        }
      }
    }
  });
});
