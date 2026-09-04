import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CoreServer } from "./app";
import type { PluginHost } from "@p2p-hub/core";

const BOOT_TOKEN = "helpcenter-token";
const TEST_TMP_ROOT = path.resolve(__dirname, "../../../node_modules/.cache/p2p-hub-test");
const CHAT_SRC = path.resolve(__dirname, "../../../plugins/chat");

/**
 * Boot a pluginless CoreServer (chat plugin added per-test when needed) under
 * the node_modules cache so plugin `require("@p2p-hub/*")` resolves.
 */
async function bootHelpServer(extraPlugins: Array<[string, string]> = []): Promise<{
  server: CoreServer;
  port: number;
}> {
  await fs.mkdir(TEST_TMP_ROOT, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(TEST_TMP_ROOT, "core-server-help-"));
  const pluginsDir = path.join(dataDir, "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });
  for (const [name, src] of extraPlugins) {
    await fs.cp(src, path.join(pluginsDir, name), { recursive: true });
  }

  const server = new CoreServer({
    pluginsDir,
    dataDir,
    host: "127.0.0.1",
    port: 0,
    bootToken: BOOT_TOKEN,
    networking: false,
  });
  await server.start();
  const addr = server.address();
  assert.ok(addr, "server should report its bound address");
  return { server, port: addr.port };
}

async function get(
  port: number,
  urlPath: string,
  token = BOOT_TOKEN,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function post(
  port: number,
  urlPath: string,
  body: unknown,
  token = BOOT_TOKEN,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("the support contact fails closed until an operator supplies a peerId", async () => {
  const { server, port } = await bootHelpServer();
  const previous = process.env.P2P_HUB_SUPPORT_PEER_ID;
  try {
    process.env.P2P_HUB_SUPPORT_PEER_ID = "";
    let res = await get(port, "/api/help/support");
    assert.equal(res.status, 200);
    const support = res.body.support as {
      peerId: string | null;
      configured: boolean;
      displayName: string;
    };
    assert.equal(support.configured, false);
    assert.equal(support.peerId, null);
    assert.equal(typeof support.displayName, "string");

    process.env.P2P_HUB_SUPPORT_PEER_ID = "ab".repeat(32);
    res = await get(port, "/api/help/support");
    const configured = res.body.support as { peerId: string; configured: boolean };
    assert.equal(configured.configured, true);
    assert.equal(configured.peerId, "ab".repeat(32));
  } finally {
    if (previous === undefined) {
      delete process.env.P2P_HUB_SUPPORT_PEER_ID;
    } else {
      process.env.P2P_HUB_SUPPORT_PEER_ID = previous;
    }
    await server.stop();
  }
});

test("the help agent reports unavailable and refuses asks until AI is configured", async () => {
  const { server, port } = await bootHelpServer();
  try {
    // Tokenless request is refused at the gate (uniform /api auth).
    const anonymous = await get(port, "/api/help/agent/status", "");
    assert.equal(anonymous.status, 401);

    const status = await get(port, "/api/help/agent/status");
    assert.equal(status.status, 200);
    assert.deepEqual(status.body, { ok: true, available: false });

    const ask = await post(port, "/api/help/agent/ask", { question: "help!" });
    assert.equal(ask.status, 200);
    assert.equal(ask.body.ok, false);
    assert.equal(ask.body.code, "ai-not-configured");
  } finally {
    await server.stop();
  }
});

test("the help agent answers over HTTP once AI is configured (seeded vault + stubbed fetch)", async () => {
  const { server, port } = await bootHelpServer();
  const realFetch = globalThis.fetch;
  try {
    const host = server as unknown as { host: PluginHost };
    const vault = host.host.vaultManager();
    await vault.setSecret("ai.apiKey", "sk-test-placeholder");
    await vault.setSecret("ai.baseUrl", "http://127.0.0.1:9/v1");
    await vault.setSecret("ai.model", "fake-model");

    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("/chat/completions")) {
        return realFetch(input, init);
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: unknown };
      void body;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '{"answer":"Herstart de app in de veilige modus \\"De app start niet\\".","steps":["Open het HelpCenter.","Maak een diagnose-bundel."]}',
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const status = await get(port, "/api/help/agent/status");
    assert.deepEqual(status.body, { ok: true, available: true });

    const ask = await post(port, "/api/help/agent/ask", {
      question: "de app start niet meer",
    });
    assert.equal(ask.status, 200);
    assert.equal(ask.body.ok, true);
    const proposal = ask.body.proposal as {
      answer: string;
      steps: string[];
      sources: Array<{ docId: string; title: string }>;
    };
    assert.match(proposal.answer, /veilige modus/);
    assert.ok(proposal.steps.length >= 1);
    assert.ok(proposal.sources.length >= 1);
    assert.ok(
      proposal.sources.every(
        (s) => typeof s.docId === "string" && s.docId.length > 0,
      ),
    );
  } finally {
    globalThis.fetch = realFetch;
    await server.stop();
  }
});

test("a too-large or non-JSON ask body is refused cleanly", async () => {
  const { server, port } = await bootHelpServer();
  try {
    const res = await post(port, "/api/help/agent/ask", "not-an-object");
    assert.equal(res.status, 400);
  } finally {
    await server.stop();
  }
});

test("chat skills stay operator-only after the 7D httpBridgeOnly flip", async () => {
  const { server } = await bootHelpServer([["chat", CHAT_SRC]]);
  try {
    const host = server as unknown as {
      host: {
        broker: {
          handleRemote: (t: {
            id: string;
            skill: string;
            payload: unknown;
            peerId: string;
          }) => Promise<{ status: string; error?: string }>;
          handleHttp: (t: {
            id: string;
            skill: string;
            payload: unknown;
          }) => Promise<{ status: string; result?: unknown; error?: string }>;
        };
      };
    };
    const broker = host.host.broker;

    // Network path: a peer must never reach the shell-facing chat skills.
    const remote = await broker.handleRemote({
      id: "remote-1",
      skill: "chat.sendMessage",
      payload: { toPeerId: "b".repeat(64), text: "hi" },
      peerId: "c".repeat(64),
    });
    assert.equal(remote.status, "error");
    assert.match(remote.error ?? "", /local-only/);

    // Local HTTP-bridge path: the operator can list threads and send a message
    // (delivery to an unreachable peer is graceful; the own copy is stored).
    const target = "d".repeat(64);
    const sent = await broker.handleHttp({
      id: "local-1",
      skill: "chat.sendMessage",
      payload: { toPeerId: target, text: "hallo helpdesk" },
    });
    assert.equal(sent.status, "ok");
    const record = sent.result as { toPeerId: string; verified: boolean };
    assert.equal(record.toPeerId, target);
    assert.equal(record.verified, true);

    const thread = await broker.handleHttp({
      id: "local-2",
      skill: "chat.getThread",
      payload: { peerId: target },
    });
    assert.equal(thread.status, "ok");
    const messages = thread.result as Array<{ text: string }>;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, "hallo helpdesk");
  } finally {
    await server.stop();
  }
});
