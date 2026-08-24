#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  generateKeyPair,
  scaffoldPlugin,
  signPluginDir,
  verifyPluginDir,
  certifyPluginDir,
  revokePluginCertification,
  scanPluginForCertification,
} from "./commands";
import { CertificationService } from "@p2p-hub/core";

/** Where signing keys live by default (loudly a dev location, never trusted). */
function defaultKeyPath(): string {
  return path.join(os.homedir(), ".p2p-hub", "keys", "plugin-signing.key");
}

async function loadOrCreateKey(keyPath: string): Promise<string> {
  try {
    return await fs.readFile(keyPath, "utf8");
  } catch {
    const { privateKeyPem, publicKeyHex } = generateKeyPair();
    await fs.mkdir(path.dirname(keyPath), { recursive: true });
    await fs.writeFile(keyPath, privateKeyPem, { mode: 0o600 });
    console.warn(
      `generated a new dev signing key at ${keyPath} (public key ${publicKeyHex}). ` +
        `This key signs plugin manifests; keep it secret and never commit it.`,
    );
    return privateKeyPem;
  }
}

function printHelp(): void {
  console.log(`create-p2p-plugin — scaffold and sign p2p-hub plugins

usage:
  create-p2p-plugin new <name> [--dir <pluginsDir>] [--sign [--key <path>]]
      Scaffold a new plugin at <pluginsDir>/<name> (default ./plugins).
      --sign also signs it; the key defaults to ~/.p2p-hub/keys/plugin-signing.key.

  create-p2p-plugin sign <dir> --key <path>
      Hash every shipped file and stamp signature + files into manifest.json.

  create-p2p-plugin keygen [--out <path>]
      Generate an Ed25519 signing keypair (PKCS8 PEM + public key hex).

  create-p2p-plugin verify <dir>
      Report the signing status of a plugin directory.

  create-p2p-plugin scan <dir>
      Run the static pre-review scanner on a built plugin and print the
      ScanReport (findings, permissions, content hash, limitations).

  create-p2p-plugin certify <dir> --key <reviewer-key> [--reviewer <name>]
                                   [--expires <ISO-date>]
      Scan the plugin, then sign certification.json with the reviewer key.
      Refuses to certify when the scanner finds a critical pattern.

  create-p2p-plugin revoke <contentHash> --reason "<why>" [--plugin <id>]
                              [--revocations <path>] [--data-dir <dir>]
      Add a content hash to the revocation register (default path
      <data-dir>/certifications/revocations.json, or --revocations).
`);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "new": {
      const name = rest[0];
      if (!name) {
        throw new Error("usage: create-p2p-plugin new <name> [--dir <dir>] [--sign]");
      }
      let targetDir = path.join(process.cwd(), "plugins");
      let sign = false;
      let keyPath = "";
      for (let i = 1; i < rest.length; i++) {
        if (rest[i] === "--dir") {
          targetDir = rest[++i] ?? "";
        } else if (rest[i] === "--sign") {
          sign = true;
        } else if (rest[i] === "--key") {
          keyPath = rest[++i] ?? "";
        }
      }
      if (!targetDir) {
        throw new Error("--dir requires a value");
      }
      const dir = await scaffoldPlugin(name, targetDir);
      console.log(`scaffolded plugin at ${dir}`);
      if (sign) {
        const key = await loadOrCreateKey(keyPath || defaultKeyPath());
        const result = await signPluginDir(dir, key);
        console.log(
          `signed ${result.fileCount} file(s) with public key ${result.publicKeyHex}`,
        );
      } else {
        console.warn(
          "plugin is unsigned — sign it before distributing: " +
            `create-p2p-plugin sign ${dir} --key <path>`,
        );
      }
      return 0;
    }
    case "sign": {
      const dir = rest[0];
      if (!dir) {
        throw new Error("usage: create-p2p-plugin sign <dir> --key <path>");
      }
      let keyPath = "";
      for (let i = 1; i < rest.length; i++) {
        if (rest[i] === "--key") {
          keyPath = rest[++i] ?? "";
        }
      }
      const key = await loadOrCreateKey(keyPath || defaultKeyPath());
      const result = await signPluginDir(path.resolve(dir), key);
      console.log(
        `signed ${result.fileCount} file(s) at ${dir} with public key ${result.publicKeyHex}`,
      );
      return 0;
    }
    case "keygen": {
      let outPath = "";
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--out") {
          outPath = rest[++i] ?? "";
        }
      }
      const { privateKeyPem, publicKeyHex } = generateKeyPair();
      if (outPath) {
        await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
        await fs.writeFile(path.resolve(outPath), privateKeyPem, { mode: 0o600 });
      }
      console.log(`public key: ${publicKeyHex}`);
      if (outPath) {
        console.log(`private key written to ${outPath}`);
      }
      return 0;
    }
    case "verify": {
      const dir = rest[0];
      if (!dir) {
        throw new Error("usage: create-p2p-plugin verify <dir>");
      }
      const result = await verifyPluginDir(path.resolve(dir));
      if (result.signed && result.ok) {
        console.log(
          `OK: signed (${result.fileCount} files) by ${result.publicKey}`,
        );
        return 0;
      }
      if (result.signed && !result.ok) {
        console.error(`BROKEN SIGNATURE: ${result.reason}`);
        return 1;
      }
      console.error(`UNSIGNED: ${result.reason}`);
      return 1;
    }
    case "scan": {
      const dir = rest[0];
      if (!dir) {
        throw new Error("usage: create-p2p-plugin scan <dir>");
      }
      const report = await scanPluginForCertification(path.resolve(dir));
      console.log(`plugin:   ${report.pluginId}`);
      console.log(`files:    ${report.scannedFiles}`);
      console.log(`content:  ${report.contentHash}`);
      console.log(`passed:   ${report.passed}`);
      console.log(`modules:  ${report.modules.length ? report.modules.join(", ") : "(none)"}`);
      console.log(`permissions: ${report.manifestPermissions.length ? report.manifestPermissions.join(", ") : "(none)"}`);
      if (report.findings.length === 0) {
        console.log("findings: (none)");
      } else {
        for (const f of report.findings) {
          const at = `${f.file}${f.line ? `:${f.line}` : ""}`;
          console.log(
            `  [${f.severity}/${f.kind}] ${f.detail} (${f.via}) ${at}`,
          );
        }
      }
      console.log("limitations (loud, always true):");
      for (const l of report.limitations) {
        console.log(`  - ${l}`);
      }
      return report.passed ? 0 : 1;
    }
    case "certify": {
      const dir = rest[0];
      if (!dir) {
        throw new Error(
          "usage: create-p2p-plugin certify <dir> --key <reviewer-key> [--reviewer <name>] [--expires <ISO>]",
        );
      }
      let keyPath = "";
      let reviewerId = "";
      let expiresAt = "";
      for (let i = 1; i < rest.length; i++) {
        if (rest[i] === "--key") {
          keyPath = rest[++i] ?? "";
        } else if (rest[i] === "--reviewer") {
          reviewerId = rest[++i] ?? "";
        } else if (rest[i] === "--expires") {
          expiresAt = rest[++i] ?? "";
        }
      }
      const key = await loadOrCreateKey(keyPath || defaultKeyPath());
      const result = await certifyPluginDir(path.resolve(dir), key, {
        reviewerId: reviewerId || undefined,
        expiresAt: expiresAt || undefined,
      });
      console.log(
        `certified ${result.record.pluginId} (contentHash ${result.contentHash}) by ${result.reviewerId}`,
      );
      console.log(`scan findings: ${result.findings.length} (critical: ${result.findings.filter((f) => f.severity === "critical").length})`);
      return 0;
    }
    case "revoke": {
      const contentHash = rest[0];
      if (!contentHash) {
        throw new Error(
          'usage: create-p2p-plugin revoke <contentHash> --reason "<why>" [--plugin <id>] [--revocations <path>] [--data-dir <dir>]',
        );
      }
      let reason = "";
      let pluginId = "";
      let revocationsPath = "";
      let dataDir = "";
      for (let i = 1; i < rest.length; i++) {
        if (rest[i] === "--reason") {
          reason = rest[++i] ?? "";
        } else if (rest[i] === "--plugin") {
          pluginId = rest[++i] ?? "";
        } else if (rest[i] === "--revocations") {
          revocationsPath = rest[++i] ?? "";
        } else if (rest[i] === "--data-dir") {
          dataDir = rest[++i] ?? "";
        }
      }
      const resolvedPath = revocationsPath
        ? path.resolve(revocationsPath)
        : CertificationService.defaultRevocationListPath(
            path.resolve(dataDir || "."),
          );
      const list = await revokePluginCertification(
        contentHash,
        reason,
        resolvedPath,
        pluginId || undefined,
      );
      console.log(
        `revoked ${contentHash} (register now has ${list.entries.length} entr${list.entries.length === 1 ? "y" : "ies"})`,
      );
      return 0;
    }
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    default:
      printHelp();
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`error: ${(err as Error).message}`);
    process.exitCode = 1;
  });
