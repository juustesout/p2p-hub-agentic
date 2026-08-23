/**
 * Fase 3 Slice 2 — process launcher.
 *
 * Spawns the {@link runner} as a hardened child process with hardening
 * flags and a strictly filtered environment, and wires its stdin/stdout to an
 * {@link IPCSocketTransport}. This is deliberately `spawn`, not `fork`:
 * `fork()` adds Node's internal `'ipc'` channel (`child.send`/`message`),
 * which would bypass the length-prefixed framing that is our security
 * boundary. With plain `spawn` + stdio pipes, *exactly* one channel exists and
 * it is the framed protocol.
 *
 * IMPORTANT — what this is, and is not. This is **process isolation for
 * crash/abuse containment**, not an OS-level security sandbox. The child runs
 * as the same OS user and retains full access to Node's built-in modules: a
 * plugin inside the sandbox can still `require("fs")` / `require("net")` /
 * `require("child_process")` directly. The hardening flags below only close
 * the obvious escape hatches; the `ctx` shim only fail-closes the
 * plugin-facing capability API. It does not restrict the module loader.
 *
 * Hardening flags (each is a deliberate fail-closed choice):
 *
 * - `--no-addons` — native `.node` modules cannot be loaded, so plugin code
 *   cannot escape the V8/OS memory model through a native module.
 * - `--disallow-code-generation-from-strings` — `eval`/`new Function` throw,
 *   so a compromised plugin cannot turn attacker data into code.
 * - `--max-old-space-size=<cap>` — bounded heap (default 256 MB) so a
 *   memory-eating plugin cannot exhaust the host machine.
 *
 * The child environment is a *filtered* view ({@link filteredEnv}): only
 * allowlisted keys that do not look like credentials, and `NODE_OPTIONS` is
 * hard-stripped regardless of the allowlist so the child can never inherit a
 * `--require`/`--import` preload from the host.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { IPCSocketTransport } from "./ipc-transport";
import { filteredEnv } from "./runner";

export const DEFAULT_HEAP_SIZE_MB = 256;

export interface SandboxSpawnConfig {
  /** Absolute plugin root directory the runner loads the manifest from. */
  pluginRoot: string;
  /** Optional subset of the host env the sandbox may inherit. */
  envAllowlist?: readonly string[];
  /** Max framed payload (see `IPCSocketTransport`). */
  maxFrameBytes?: number;
  /** V8 heap cap in MB. Defaults to {@link DEFAULT_HEAP_SIZE_MB}. */
  heapSizeMb?: number;
  /** Override the runner script path (tests). */
  runnerPath?: string;
  /** Forward the child's stderr (the sandbox's log channel). */
  stderr?: (chunk: string) => void;
}

export interface SpawnedSandbox {
  child: ChildProcess;
  transport: IPCSocketTransport;
  pluginRoot: string;
}

/** `NODE_OPTIONS` is stripped even if someone explicitly allowlists it. */
function hardenEnv(env: Record<string, string>): Record<string, string> {
  const out = { ...env };
  delete out.NODE_OPTIONS;
  return out;
}

/**
 * Spawn the sandbox runner as a hardened OS process. Never throws for a
 * plugin problem (a bad manifest surfaces later through the IPC handshake);
 * it only throws on a launch failure (e.g. missing runner script).
 */
export function spawnSandboxProcess(config: SandboxSpawnConfig): SpawnedSandbox {
  const runnerPath =
    config.runnerPath ?? path.join(__dirname, "runner.js");
  const heapSizeMb =
    Number.isInteger(config.heapSizeMb) && (config.heapSizeMb as number) > 0
      ? (config.heapSizeMb as number)
      : DEFAULT_HEAP_SIZE_MB;

  const args = [
    "--no-addons",
    "--disallow-code-generation-from-strings",
    `--max-old-space-size=${heapSizeMb}`,
    runnerPath,
    "--plugin-root",
    config.pluginRoot,
  ];

  const env = hardenEnv(filteredEnv(config.envAllowlist));
  const child = spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  if (config.stderr) {
    child.stderr?.on("data", (chunk: Buffer) => {
      config.stderr?.(chunk.toString("utf8"));
    });
  }

  const transport = new IPCSocketTransport(child.stdout, child.stdin, {
    maxFrameBytes: config.maxFrameBytes,
  });

  return { child, transport, pluginRoot: config.pluginRoot };
}
