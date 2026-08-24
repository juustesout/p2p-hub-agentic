import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TaskBroker } from "../task-broker/task-broker";
import { loadManifest } from "../plugin-loader/plugin-loader";
import {
  SandboxedPluginAdapter,
  PluginExecutionTimeoutError,
} from "./sandboxed-plugin-adapter";
import type { SandboxedPluginAdapterOptions } from "./sandboxed-plugin-adapter";
import { spawnSandboxProcess } from "./launcher";
import { filteredEnv } from "./runner";

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Fixture {
  pluginRoot: string;
  pluginId: string;
}

async function makeFixture(
  t: import("node:test").TestContext,
  entrySource: string,
  overrides: { id?: string; permissions?: string[] } = {},
): Promise<Fixture> {
  const pluginId = overrides.id ?? "echo";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-adapter-"));
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id: pluginId,
      version: "1.0.0",
      kind: "generic",
      entry: "index.js",
      permissions: overrides.permissions ?? [],
    }),
  );
  await fs.writeFile(path.join(dir, "index.js"), entrySource);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { pluginRoot: dir, pluginId };
}

async function startAdapter(
  t: import("node:test").TestContext,
  fixture: Fixture,
  options: Partial<SandboxedPluginAdapterOptions> = {},
): Promise<{ adapter: SandboxedPluginAdapter; broker: TaskBroker }> {
  const broker = new TaskBroker();
  const manifest = await loadManifest(fixture.pluginRoot);
  const adapter = new SandboxedPluginAdapter({
    pluginId: fixture.pluginId,
    pluginRoot: fixture.pluginRoot,
    manifest,
    broker,
    stderr: () => {
      /* keep test output clean */
    },
    ...options,
  });
  t.after(() => {
    adapter.kill();
  });
  await adapter.start();
  return { adapter, broker };
}

function task(pluginId: string, skill: string, payload: unknown) {
  return {
    id: randomUUID(),
    skill: `${pluginId}.${skill}`,
    payload,
  };
}

const ECHO_ENTRY = `
exports.default = async function activate(ctx) {
  ctx.skills.register("echo", async (payload, context) => {
    return { received: payload, context };
  });
};
`;

test("basic skill invocation over the spawn execution loop", async (t) => {
  const fixture = await makeFixture(t, ECHO_ENTRY);
  const { adapter, broker } = await startAdapter(t, fixture);
  assert.equal(adapter.isCrashed, false);

  const result = await broker.handle(task(fixture.pluginId, "echo", { x: 1 }));
  assert.equal(result.status, "ok");
  assert.deepEqual(
    (result as { result: { received: unknown; context: unknown } }).result,
    // `peerId: undefined` is dropped by JSON serialization across the IPC
    // pipe — an absent caller identity travels as an absent field.
    { received: { x: 1 }, context: {} },
  );

  await adapter.shutdown();
  assert.equal(adapter.childProcess?.exitCode, 0);
});

test("a throwing handler is a normal error outcome, the sandbox survives", async (t) => {
  const fixture = await makeFixture(
    t,
    `
    exports.default = async function activate(ctx) {
      ctx.skills.register("echo", async (payload) => ({ received: payload }));
      ctx.skills.register("boom", async () => { throw new Error("kaboom"); });
    };
    `,
  );
  const { adapter, broker } = await startAdapter(t, fixture);

  const boom = await broker.handle(task(fixture.pluginId, "boom", {}));
  assert.equal(boom.status, "error");
  assert.match(boom.error ?? "", /kaboom/);
  assert.equal(adapter.isCrashed, false);

  const echo = await broker.handle(task(fixture.pluginId, "echo", { ok: true }));
  assert.equal(echo.status, "ok");

  await adapter.shutdown();
});

test("unproxied capabilities are fail-closed loud in the sandbox", async (t) => {
  const fixture = await makeFixture(
    t,
    `
    exports.default = async function activate(ctx) {
      ctx.skills.register("probe", async () => {
        const out = {};
        try { await ctx.vault.listSecretKeys(); } catch (e) { out.vault = e.message; }
        try { await ctx.ai.generateText({ prompt: "x" }); } catch (e) { out.ai = e.message; }
        try { await ctx.identity.peerId(); } catch (e) { out.identity = e.message; }
        try { await ctx.storage.get("k"); } catch (e) { out.storage = e.message; }
        try { const d = ctx.dataDir; return { got: d }; } catch (e) { out.dataDir = e.message; }
        return out;
      });
    };
    `,
  );
  const { adapter, broker } = await startAdapter(t, fixture);

  const result = await broker.handle(task(fixture.pluginId, "probe", {}));
  assert.equal(result.status, "ok");
  const out = (result as { result: Record<string, string> }).result;
  assert.match(out.vault, /ctx\.vault\.listSecretKeys/);
  assert.match(out.ai, /ctx\.ai\.generateText/);
  assert.match(out.identity, /ctx\.identity\.peerId/);
  assert.match(out.storage, /ctx\.storage\.get/);
  assert.match(out.dataDir, /ctx\.dataDir/);
  assert.match(out.vault, /not available in the sandbox/);

  await adapter.shutdown();
});

test("a skill claiming a network permission the manifest lacks is denied at the host", async (t) => {
  const fixture = await makeFixture(
    t,
    `
    exports.default = async function activate(ctx) {
      ctx.skills.register("ok", async () => "ok");
      await ctx.skills.register("exposed", async () => "x", { localOnly: false });
    };
    `,
    { id: "deny" },
  );
  const broker = new TaskBroker();
  const manifest = await loadManifest(fixture.pluginRoot);
  const adapter = new SandboxedPluginAdapter({
    pluginId: "deny",
    pluginRoot: fixture.pluginRoot,
    manifest,
    broker,
    stderr: () => {},
  });
  t.after(() => adapter.kill());

  await assert.rejects(
    adapter.start(),
    /network:skill:deny\.exposed/,
  );
  // The denied registration aborts activation → the sandbox is torn down and
  // even the skill that registered cleanly first is unregistered.
  assert.equal(adapter.isCrashed, true);
  assert.equal(broker.hasSkill("deny.ok"), false);
  assert.equal(broker.hasSkill("deny.exposed"), false);
});

test("hardening flags reach the child and NODE_OPTIONS never does", async (t) => {
  const fixture = await makeFixture(
    t,
    `
    exports.default = async function activate(ctx) {
      ctx.skills.register("env", async () => ({
        execArgv: process.execArgv,
        nodeOptions: process.env.NODE_OPTIONS,
        path: process.env.PATH,
      }));
    };
    `,
  );
  const { adapter, broker } = await startAdapter(t, fixture, {
    envAllowlist: ["PATH", "NODE_OPTIONS"],
    heapSizeMb: 256,
  });

  const result = await broker.handle(task(fixture.pluginId, "env", {}));
  assert.equal(result.status, "ok");
  const out = (result as { result: { execArgv: string[]; nodeOptions?: string; path?: string } }).result;
  assert.ok(out.execArgv.includes("--no-addons"), "child must run with --no-addons");
  assert.ok(
    out.execArgv.includes("--disallow-code-generation-from-strings"),
    "child must run with --disallow-code-generation-from-strings",
  );
  assert.ok(out.execArgv.includes("--max-old-space-size=256"), "heap cap must be applied");
  assert.equal(out.nodeOptions, undefined, "NODE_OPTIONS is stripped even when allowlisted");
  assert.ok(
    typeof out.path === "string" && out.path.length > 0,
    "PATH is preserved when allowlisted",
  );

  await adapter.shutdown();
});

test("code generation from strings is blocked at activate (controlled boot failure)", async (t) => {
  const fixture = await makeFixture(
    t,
    `exports.default = async function activate() { new Function("return 1"); };`,
  );
  const broker = new TaskBroker();
  const manifest = await loadManifest(fixture.pluginRoot);
  const adapter = new SandboxedPluginAdapter({
    pluginId: fixture.pluginId,
    pluginRoot: fixture.pluginRoot,
    manifest,
    broker,
    stderr: () => {},
  });
  t.after(() => adapter.kill());

  await assert.rejects(adapter.start(), /Code generation from strings disallowed/);
  assert.equal(adapter.isCrashed, true);
});

test("code generation from strings is blocked inside a skill handler", async (t) => {
  const fixture = await makeFixture(
    t,
    `
    exports.default = async function activate(ctx) {
      ctx.skills.register("hack", async () => {
        try {
          new Function("return 1");
          return { blocked: false };
        } catch (e) {
          return { blocked: true, message: e.message };
        }
      });
    };
    `,
  );
  const { adapter, broker } = await startAdapter(t, fixture);

  const result = await broker.handle(task(fixture.pluginId, "hack", {}));
  assert.equal(result.status, "ok");
  const out = (result as { result: { blocked: boolean; message: string } }).result;
  assert.equal(out.blocked, true);
  assert.match(out.message, /Code generation from strings disallowed/);

  await adapter.shutdown();
});

test("an infinite-loop skill is killed by the host and surfaces a timeout", async (t) => {
  const fixture = await makeFixture(
    t,
    `
    exports.default = async function activate(ctx) {
      ctx.skills.register("hang", async () => { while (true) {} });
    };
    `,
  );
  const { adapter, broker } = await startAdapter(t, fixture, {
    invokeSkillTimeoutMs: 300,
    heartbeatIntervalMs: 10_000, // keep the heartbeat out of the way
  });

  const started = Date.now();
  const result = await broker.handle(task(fixture.pluginId, "hang", {}));
  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /exceeded the \d+ms execution timeout/);
  assert.ok(Date.now() - started < 5_000, "timeout must not take forever");
  assert.equal(adapter.isCrashed, true);
  assert.equal(broker.hasSkill(`${fixture.pluginId}.hang`), false);
  // The child was SIGKILLed, never left running.
  await waitFor(() => adapter.childProcess?.signalCode === "SIGKILL");
  assert.equal(adapter.childProcess?.signalCode, "SIGKILL");
});

test("a sandbox that stops answering heartbeats is killed by the host", async (t) => {
  const fixture = await makeFixture(
    t,
    `
    exports.default = async function activate(ctx) {
      ctx.skills.register("busy", async () => {
        ctx.timers.setInterval(() => { while (true) {} }, 30);
        return { scheduled: true };
      });
    };
    `,
  );
  const { adapter, broker } = await startAdapter(t, fixture, {
    heartbeatIntervalMs: 80,
    heartbeatTimeoutMs: 120,
    invokeSkillTimeoutMs: 10_000,
  });

  const invoke = await broker.handle(task(fixture.pluginId, "busy", {}));
  assert.equal(invoke.status, "ok"); // returned before the loop blocks the loop

  // Once the interval fires and blocks the child's event loop, the host's
  // heartbeat pings stop getting answers and the host SIGKILLs the sandbox.
  await waitFor(() => adapter.isCrashed, 5000);
  assert.equal(broker.hasSkill(`${fixture.pluginId}.busy`), false);
  await waitFor(() => adapter.childProcess?.signalCode === "SIGKILL");
  assert.equal(adapter.childProcess?.signalCode, "SIGKILL");
});

test("an external SIGKILL crashes in-flight invocations with PluginCrashError", async (t) => {
  const fixture = await makeFixture(
    t,
    `
    exports.default = async function activate(ctx) {
      ctx.skills.register("slow", async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return "done";
      });
    };
    `,
  );
  const { adapter, broker } = await startAdapter(t, fixture);

  const pending = broker.handle(task(fixture.pluginId, "slow", {}));
  await new Promise((resolve) => setTimeout(resolve, 50));
  adapter.childProcess?.kill("SIGKILL");

  const result = await pending;
  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /crashed/);
  assert.equal(adapter.isCrashed, true);
  assert.equal(broker.hasSkill(`${fixture.pluginId}.slow`), false);
});

test("a non-serializable handler result fails closed instead of corrupting the channel", async (t) => {
  const fixture = await makeFixture(
    t,
    `
    exports.default = async function activate(ctx) {
      ctx.skills.register("circular", async () => {
        const obj = {};
        obj.self = obj;
        return obj;
      });
      ctx.skills.register("echo", async (payload) => ({ received: payload }));
    };
    `,
  );
  const { adapter, broker } = await startAdapter(t, fixture);

  const circular = await broker.handle(task(fixture.pluginId, "circular", {}));
  assert.equal(circular.status, "error");
  assert.match(circular.error ?? "", /non-serializable/);
  assert.equal(adapter.isCrashed, false);

  // The channel is intact after the failed result.
  const echo = await broker.handle(task(fixture.pluginId, "echo", { ok: true }));
  assert.equal(echo.status, "ok");

  await adapter.shutdown();
});

test("broker dispatch enforces localOnly before it ever reaches the sandbox", async (t) => {
  const fixture = await makeFixture(
    t,
    ECHO_ENTRY,
    { id: "locked", permissions: ["network:skill:locked.echo"] },
  );
  const { adapter, broker } = await startAdapter(t, fixture, {
    heartbeatIntervalMs: 10_000,
  });

  // The sandboxed plugin declares the skill as network-accessible (permission
  // present), but the TaskBroker still applies its remote gate first.
  const remote = await broker.handleRemote({
    id: randomUUID(),
    skill: "locked.echo",
    payload: {},
  });
  // No remote policy was declared → fail-closed denial, never dispatched.
  assert.equal(remote.status, "error");

  const local = await broker.handle(task(fixture.pluginId, "echo", { via: "local" }));
  assert.equal(local.status, "ok");

  await adapter.shutdown();
});

test("PluginExecutionTimeoutError is the typed surface of a hung skill", async (t) => {
  const err = new PluginExecutionTimeoutError("hang", 300);
  assert.equal(err.name, "PluginExecutionTimeoutError");
  assert.equal(err.skill, "hang");
  assert.equal(err.timeoutMs, 300);
  assert.match(err.message, /hang.*300ms/);
});

async function makeProbeRunner(
  t: import("node:test").TestContext,
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-probe-"));
  await fs.writeFile(
    path.join(dir, "probe.js"),
    `
      process.stderr.write(JSON.stringify({ args: process.execArgv, env: process.env }) + "\\n");
      process.exit(0);
    `,
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, "probe.js");
}

test("spawnSandboxProcess passes hardening flags and strips NODE_OPTIONS", async (t) => {
  const runnerPath = await makeProbeRunner(t);
  const envBackup = { ...process.env };
  process.env.SANDBOX_LEGACY = "yes";
  process.env.NODE_OPTIONS = "--require /evil/preload.js";
  t.after(() => {
    process.env = envBackup;
  });

  const chunks: string[] = [];
  const spawned = spawnSandboxProcess({
    pluginRoot: "/nonexistent", // never read by the probe
    runnerPath,
    envAllowlist: ["SANDBOX_LEGACY", "NODE_OPTIONS", "PATH"],
    heapSizeMb: 512,
    stderr: (chunk) => chunks.push(chunk),
  });
  t.after(() => {
    spawned.child.kill("SIGKILL");
  });

  await waitFor(() => chunks.join("").includes('"args"'), 3000);
  const payload = JSON.parse(chunks.join("").split("\n").find((l) => l.includes('"args"'))!);
  assert.ok(payload.args.includes("--no-addons"), "child must run with --no-addons");
  assert.ok(
    payload.args.includes("--disallow-code-generation-from-strings"),
    "child must run with --disallow-code-generation-from-strings",
  );
  assert.ok(payload.args.includes("--max-old-space-size=512"), "heap cap must be applied");
  assert.equal(payload.env.NODE_OPTIONS, undefined, "NODE_OPTIONS is stripped even when allowlisted");
  assert.equal(payload.env.SANDBOX_LEGACY, "yes", "allowlisted non-secret env is inherited");
  assert.ok(
    typeof payload.env.PATH === "string" && payload.env.PATH.length > 0,
    "allowlisted PATH is inherited",
  );
  spawned.transport.close();
});

test("spawnSandboxProcess forwards child stderr through the callback", async (t) => {
  const runnerPath = await makeProbeRunner(t);
  const chunks: string[] = [];
  const spawned = spawnSandboxProcess({
    pluginRoot: "/nonexistent",
    runnerPath,
    stderr: (chunk) => chunks.push(chunk),
  });
  t.after(() => {
    spawned.child.kill("SIGKILL");
  });
  await waitFor(() => chunks.join("").includes('"args"'), 3000);
  assert.ok(chunks.join("").includes('"args"'), "stderr reaches the callback");
  spawned.transport.close();
});

test("spawnSandboxProcess leaks no host file descriptors into the child", async (t) => {
  if (process.platform !== "linux") {
    t.skip("fd enumeration requires /proc/self/fd (Linux-only)");
    return;
  }
  // The Node Permission Model is bypassable through inherited fds (a child
  // reading via an fd the launcher passed in skips the fs grants). So the
  // launcher must never leak a host fd into the sandbox: only stdin/stdout/
  // stderr. This test opens a sensitive host fd, spawns a sandboxed probe,
  // and asserts the child's fd table contains no path pointing at it.
  const secretPath = path.join(os.tmpdir(), `sandbox-fd-secret-${randomUUID()}.txt`);
  await fs.writeFile(secretPath, "super-secret-host-file");
  const secretHandle = await fs.open(secretPath, "r");
  t.after(async () => {
    await secretHandle.close();
    await fs.rm(secretPath, { force: true });
  });

  const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-fd-probe-"));
  await fs.writeFile(
    path.join(probeDir, "probe.js"),
    `
      const fs = require("fs");
      const fds = fs.readdirSync("/proc/self/fd").map(Number).sort((a, b) => a - b);
      const targets = [];
      for (const fd of fds) {
        try { targets.push(fs.readlinkSync("/proc/self/fd/" + fd)); }
        catch { targets.push("(gone)"); }
      }
      process.stderr.write(JSON.stringify({ fdTargets: targets }) + "\\n");
      process.exit(0);
    `,
  );
  t.after(() => fs.rm(probeDir, { recursive: true, force: true }));

  const chunks: string[] = [];
  const spawned = spawnSandboxProcess({
    pluginRoot: "/nonexistent",
    runnerPath: path.join(probeDir, "probe.js"),
    stderr: (chunk) => chunks.push(chunk),
  });
  t.after(() => {
    spawned.child.kill("SIGKILL");
  });

  await waitFor(() => chunks.join("").includes('"fdTargets"'), 3000);
  const payload = JSON.parse(
    chunks.join("").split("\n").find((l) => l.includes('"fdTargets"'))!,
  );
  const targets = payload.fdTargets as string[];
  assert.ok(
    !targets.includes(secretPath),
    `host fd for ${secretPath} must not be inherited by the sandbox (got: ${targets.join(", ")})`,
  );
  spawned.transport.close();
});

test("filteredEnv drops secret-looking keys even when allowlisted", () => {
  const out = filteredEnv(
    ["API_KEY", "HOME", "PATH"],
    {
      API_KEY: "sk-1234",
      HOME: "/root",
      PATH: "/usr/bin",
      OTHER_SECRET: "nope",
    },
  );
  assert.deepEqual(out, { HOME: "/root", PATH: "/usr/bin" });
});
