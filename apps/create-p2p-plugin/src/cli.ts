#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  generateKeyPair,
  scaffoldPlugin,
  signPluginDir,
  verifyPluginDir,
} from "./commands";

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
