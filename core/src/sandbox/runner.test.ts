import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { IPCErrorCodes } from "@p2p-hub/sdk";
import type { IPCMessageEnvelope } from "@p2p-hub/sdk";
import { IPCSocketTransport } from "./ipc-transport";
import { filteredEnv } from "./runner";

const REQUEST_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

const PLUGIN_ID = "peersite";

async function makePluginFixture(entrySource: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-runner-"));
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id: PLUGIN_ID,
      version: "0.0.1",
      kind: "generic",
      entry: "index.js",
      permissions: [],
    }),
  );
  await fs.writeFile(path.join(dir, "index.js"), entrySource);
  return dir;
}

const TRIVIAL_ENTRY = `
exports.default = async function activate() {};
`;

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("filteredEnv exposes only allowlisted, non-credential keys", () => {
  const source: Record<string, string | undefined> = {
    PATH: "/usr/bin",
    HOME: "/home/x",
    MY_SECRET: "shh",
    API_KEY: "k",
    PRIVATE_KEY: "p",
    FOO: "bar",
  };
  const out = filteredEnv(
    ["PATH", "HOME", "MY_SECRET", "API_KEY", "PRIVATE_KEY", "FOO"],
    source,
  );
  assert.deepEqual(out, { PATH: "/usr/bin", HOME: "/home/x", FOO: "bar" });
});

test("filteredEnv defaults to a minimal allowlist and never reads everything", () => {
  const source: Record<string, string | undefined> = {
    PATH: "/usr/bin",
    HOME: "/home/x",
    LANG: "nl_NL.UTF-8",
    TZ: "Europe/Amsterdam",
    NODE_OPTIONS: "--inspect",
    FOO: "bar",
  };
  const out: Record<string, string | undefined> = filteredEnv(
    undefined,
    source,
  );
  assert.deepEqual(out, {
    PATH: "/usr/bin",
    HOME: "/home/x",
    LANG: "nl_NL.UTF-8",
    TZ: "Europe/Amsterdam",
  });
  assert.equal(Object.hasOwn(out, "FOO"), false);
  assert.equal(Object.hasOwn(out, "NODE_OPTIONS"), false);
});

test("filteredEnv with an empty allowlist yields an empty env", () => {
  const source = { PATH: "/usr/bin", FOO: "bar" };
  assert.deepEqual(filteredEnv([], source), {});
});

test("filteredEnv drops malformed key names and absent values", () => {
  const source = { "BAD KEY": "x", NOTHERE: undefined, OK: "1" };
  assert.deepEqual(filteredEnv(["BAD KEY", "NOTHERE", "OK"], source), { OK: "1" });
});

test("filteredEnv honors a custom secretKeyRe override", () => {
  const source = { TOKEN: "t", BLOB: "b", OK: "1" };
  const out = filteredEnv(["TOKEN", "BLOB", "OK"], source, /token/i);
  assert.deepEqual(out, { BLOB: "b", OK: "1" });
});

async function spawnRunner(
  childEnv: Record<string, string>,
  entrySource: string = TRIVIAL_ENTRY,
): Promise<{
  child: ReturnType<typeof spawn>;
  host: IPCSocketTransport;
  received: IPCMessageEnvelope[];
  errors: Error[];
  cleanup: () => Promise<void>;
}> {
  const pluginRoot = await makePluginFixture(entrySource);
  const runnerPath = path.join(__dirname, "runner.js");
  const child = spawn(
    process.execPath,
    [runnerPath, "--plugin-root", pluginRoot],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    },
  );
  const received: IPCMessageEnvelope[] = [];
  const errors: Error[] = [];
  const host = new IPCSocketTransport(child.stdout, child.stdin);
  host.onMessage((m) => received.push(m));
  host.onError((err) => errors.push(err));
  await waitFor(() => child.pid !== undefined);
  const cleanup = async (): Promise<void> => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    host.close();
    await fs.rm(pluginRoot, { recursive: true, force: true });
  };
  return { child, host, received, errors, cleanup };
}

test("runner: initialize returns a filtered env and rejects secret keys", async () => {
  const { host, received, errors, cleanup } = await spawnRunner({
    PATH: "/usr/bin",
    HOME: "/home/x",
    FOO: "bar",
    MY_SECRET: "shh",
    API_KEY: "k",
  });

  host.send({
    type: "request",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    method: "initialize",
    params: {
      pluginId: PLUGIN_ID,
      envAllowlist: ["PATH", "HOME", "FOO", "MY_SECRET", "API_KEY"],
    },
  });
  await waitFor(() => received.length === 1);
  assert.deepEqual(errors, []);

  const response = received[0];
  assert.equal(response.type, "response");
  const result = (response as { result: Record<string, unknown> }).result;
  assert.equal(result.initialized, true);
  assert.equal(typeof result.pid, "number");
  assert.equal(typeof result.platform, "string");
  assert.equal(typeof result.arch, "string");
  assert.equal(typeof result.nodeVersion, "string");
  assert.deepEqual(result.env, { PATH: "/usr/bin", HOME: "/home/x", FOO: "bar" });
  assert.deepEqual(result.plugin, { id: PLUGIN_ID, entry: "index.js" });

  await cleanup();
});

test("runner: initialize rejects an invalid pluginId and malformed envAllowlist", async () => {
  const { host, received, cleanup } = await spawnRunner({ PATH: "/usr/bin" });

  host.send({
    type: "request",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    method: "initialize",
    params: { pluginId: "../evil" },
  });
  await waitFor(() => received.length === 1);
  const badId = received[0] as { error?: { code: number; message: string } };
  assert.equal(badId.error?.code, IPCErrorCodes.INVALID_PARAMS);

  host.send({
    type: "request",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    method: "initialize",
    params: { pluginId: "ok", envAllowlist: "PATH" },
  });
  await waitFor(() => received.length === 2);
  const badAllow = received[1] as { error?: { code: number; message: string } };
  assert.equal(badAllow.error?.code, IPCErrorCodes.INVALID_PARAMS);

  await cleanup();
});

test("runner: initialize rejects a pluginId that does not match the manifest", async () => {
  const { host, received, cleanup } = await spawnRunner({ PATH: "/usr/bin" });

  host.send({
    type: "request",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    method: "initialize",
    params: { pluginId: "notpeersite" },
  });
  await waitFor(() => received.length === 1);
  const response = received[0] as { error?: { code: number; message: string } };
  assert.equal(response.error?.code, IPCErrorCodes.INVALID_PARAMS);
  assert.match(response.error?.message ?? "", /does not match initialized pluginId/);

  await cleanup();
});

test("runner: a plugin whose activate throws fails initialize and exits nonzero", async () => {
  const { child, host, received, cleanup } = await spawnRunner(
    { PATH: "/usr/bin" },
    `exports.default = async function activate() { throw new Error("evil activate"); };`,
  );

  host.send({
    type: "request",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    method: "initialize",
    params: { pluginId: PLUGIN_ID },
  });
  await waitFor(() => received.length === 1);
  const response = received[0] as { error?: { code: number; message: string } };
  assert.equal(response.error?.code, IPCErrorCodes.INTERNAL_ERROR);
  assert.match(response.error?.message ?? "", /plugin activation failed: evil activate/);

  const exit = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
  });
  const code = await Promise.race([
    exit,
    new Promise<number | null>((resolve) =>
      setTimeout(() => resolve(null), 2000),
    ),
  ]);
  assert.equal(code, 1);

  await cleanup();
});

test("runner: unknown method returns METHOD_NOT_FOUND", async () => {
  const { host, received, cleanup } = await spawnRunner({ PATH: "/usr/bin" });

  host.send({
    type: "request",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    method: "definitely:not:real",
  });
  await waitFor(() => received.length === 1);
  const response = received[0] as { error?: { code: number; message: string } };
  assert.equal(response.error?.code, IPCErrorCodes.METHOD_NOT_FOUND);

  await cleanup();
});

test("runner: shutdown acknowledges and the process exits 0", async () => {
  const { child, host, received, cleanup } = await spawnRunner({ PATH: "/usr/bin" });

  host.send({
    type: "request",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    method: "shutdown",
  });
  await waitFor(() => received.length === 1);
  const response = received[0] as { result?: unknown };
  assert.deepEqual(response.result, { shutdown: true });

  const exit = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
  });
  const code = await Promise.race([
    exit,
    new Promise<number | null>((resolve) =>
      setTimeout(() => resolve(null), 2000),
    ),
  ]);
  assert.equal(code, 0);

  await cleanup();
});

test("runner: default envAllowlist (no params) still never leaks secrets", async () => {
  const { host, received, cleanup } = await spawnRunner({
    PATH: "/usr/bin",
    MY_SECRET: "shh",
    API_KEY: "k",
    TZ: "Europe/Amsterdam",
  });

  host.send({
    type: "request",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    method: "initialize",
    params: { pluginId: PLUGIN_ID },
  });
  await waitFor(() => received.length === 1);
  const response = received[0] as { result: { env: Record<string, string> } };
  const env = response.result.env;
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.TZ, "Europe/Amsterdam");
  assert.equal(env.MY_SECRET, undefined);
  assert.equal(env.API_KEY, undefined);

  await cleanup();
});

test("runner: initialize rejects a plugin whose entry symlink escapes the directory", async () => {
  const pluginRoot = await makePluginFixture(
    `exports.default = async function activate() {};`,
  );
  // Point the entry at a file outside the plugin directory.
  const outside = path.join(os.tmpdir(), `sandbox-outside-${Date.now()}.js`);
  await fs.writeFile(outside, `module.exports = {};`);
  await fs.rm(path.join(pluginRoot, "index.js"));
  await fs.symlink(outside, path.join(pluginRoot, "index.js"));
  try {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, "runner.js"), "--plugin-root", pluginRoot],
      { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin" } },
    );
    const received: IPCMessageEnvelope[] = [];
    const host = new IPCSocketTransport(child.stdout, child.stdin);
    host.onMessage((m) => received.push(m));
    await waitFor(() => child.pid !== undefined);

    host.send({
      type: "request",
      jsonrpc: "2.0",
      id: REQUEST_ID,
      method: "initialize",
      params: { pluginId: PLUGIN_ID },
    });
    await waitFor(() => received.length === 1);
    const response = received[0] as { error?: { code: number; message: string } };
    assert.equal(response.error?.code, IPCErrorCodes.INTERNAL_ERROR);
    assert.match(response.error?.message ?? "", /plugin directory rejected:.*symlink/);
    host.close();
    child.kill("SIGKILL");
  } finally {
    await fs.rm(pluginRoot, { recursive: true, force: true });
    await fs.rm(outside, { force: true });
  }
});
