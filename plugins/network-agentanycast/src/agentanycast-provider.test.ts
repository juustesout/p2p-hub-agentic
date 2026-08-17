import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { AgentAnycastProvider } from "./agentanycast-provider";

test("checkStatus reports ready when daemon is reachable via unix socket", async () => {
  const socketPath = path.join(
    os.tmpdir(),
    `agentanycast-${process.pid}-${Date.now()}.sock`,
  );
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  const previous = process.env.AGENTANYCAST_SOCKET;
  process.env.AGENTANYCAST_SOCKET = socketPath;
  try {
    const provider = new AgentAnycastProvider("127.0.0.1:59999");
    assert.equal(await provider.checkStatus(), "ready");
  } finally {
    process.env.AGENTANYCAST_SOCKET = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("checkStatus reports not-installed when daemon is absent", async () => {
  const provider = new AgentAnycastProvider();
  const status = await provider.checkStatus();
  assert.equal(status, "not-installed");
});

test("checkStatus reports not-installed when socket, TCP and binary are all absent", async () => {
  const previous = process.env.AGENTANYCAST_SOCKET;
  process.env.AGENTANYCAST_SOCKET = path.join(
    os.tmpdir(),
    `agentanycast-missing-${process.pid}-${Date.now()}.sock`,
  );
  try {
    const provider = new AgentAnycastProvider("127.0.0.1:59999");
    assert.equal(await provider.checkStatus(), "not-installed");
  } finally {
    process.env.AGENTANYCAST_SOCKET = previous;
  }
});

test("start/isReady reflect the daemon state", async () => {
  const provider = new AgentAnycastProvider();
  assert.equal(provider.isReady(), false);

  await provider.start();

  assert.equal(provider.isReady(), false);

  await provider.stop();
  assert.equal(provider.isReady(), false);
});
