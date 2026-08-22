import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CoreServer } from "./app";
import { canonicalizeJson } from "@p2p-hub/sdk";
import { verifyIdentitySignature } from "@p2p-hub/core";

const BOOT_TOKEN = "agent-test-token";

async function bootAgentServer(): Promise<{
  server: CoreServer;
  port: number;
}> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-server-agents-"));
  await fs.mkdir(path.join(dataDir, "plugins"), { recursive: true });
  const server = new CoreServer({
    pluginsDir: path.join(dataDir, "plugins"),
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

const json = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

interface AgentBody {
  label: string;
  peerId: string;
  publicKeyHex: string;
  certificate: {
    context: string;
    parent: string;
    child: string;
    label: string;
    issuedAt: number;
    signature: string;
  };
  createdAt: number;
}

test("agents: list starts empty", async () => {
  const { server, port } = await bootAgentServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/agents`, {
      headers: { Authorization: `Bearer ${BOOT_TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = (await json(res)) as { agents: unknown[] };
    assert.deepEqual(body.agents, []);
  } finally {
    await server.stop();
  }
});

test("agents: create returns only public material and an operator-signed cert", async () => {
  const { server, port } = await bootAgentServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/agents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BOOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ label: "alice" }),
    });
    assert.equal(res.status, 200);
    const body = (await json(res)) as { ok: boolean; agent: AgentBody };
    assert.equal(body.ok, true);

    const agent = body.agent;
    assert.equal(agent.label, "alice");
    assert.match(agent.peerId, /^[0-9a-f]{64}$/);
    assert.equal(agent.publicKeyHex, agent.peerId);
    assert.equal(agent.createdAt, agent.certificate.issuedAt);

    // The certificate binds the agent to the operator and is publicly
    // verifiable from the operator's public key embedded in it (registry-free).
    const cert = agent.certificate;
    assert.equal(cert.context, "p2p-hub:agent-identity:cert:v1");
    assert.equal(cert.parent.length, 64);
    assert.equal(cert.child, agent.peerId);
    assert.equal(cert.label, "alice");
    assert.equal(typeof cert.issuedAt, "number");
    assert.equal(
      verifyIdentitySignature(
        cert.parent,
        Buffer.from(
          canonicalizeJson({
            context: cert.context,
            parent: cert.parent,
            child: cert.child,
            label: cert.label,
            issuedAt: cert.issuedAt,
          }),
          "utf8",
        ),
        Buffer.from(cert.signature, "hex"),
      ),
      true,
      "the operator must have signed this certificate",
    );

    // The private key never leaves IdentityManager — it must not appear anywhere
    // in the serialized response.
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes("private"), "no private key material may leak");
  } finally {
    await server.stop();
  }
});

test("agents: create is idempotent per label (same derived peerId)", async () => {
  const { server, port } = await bootAgentServer();
  try {
    const headers = {
      Authorization: `Bearer ${BOOT_TOKEN}`,
      "Content-Type": "application/json",
    };
    const first = (await json(
      await fetch(`http://127.0.0.1:${port}/api/agents`, {
        method: "POST",
        headers,
        body: JSON.stringify({ label: "bob" }),
      }),
    )) as { agent: AgentBody };
    const second = (await json(
      await fetch(`http://127.0.0.1:${port}/api/agents`, {
        method: "POST",
        headers,
        body: JSON.stringify({ label: "bob" }),
      }),
    )) as { agent: AgentBody };

    assert.equal(second.agent.peerId, first.agent.peerId);
    assert.deepEqual(second.agent.certificate, first.agent.certificate);
  } finally {
    await server.stop();
  }
});

test("agents: create rejects an invalid label with a clean 4xx", async () => {
  const { server, port } = await bootAgentServer();
  try {
    for (const label of ["../evil", "bad label!", "", "a/b", "-leading"]) {
      const res = await fetch(`http://127.0.0.1:${port}/api/agents`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${BOOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ label }),
      });
      assert.equal(res.status, 400, `label "${label}" must be rejected`);
    }
  } finally {
    await server.stop();
  }
});

test("agents: list reflects created agents; delete removes and is idempotent", async () => {
  const { server, port } = await bootAgentServer();
  try {
    const headers = { Authorization: `Bearer ${BOOT_TOKEN}` };
    await fetch(`http://127.0.0.1:${port}/api/agents`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "carol" }),
    });
    await fetch(`http://127.0.0.1:${port}/api/agents`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "dave" }),
    });

    const list = (await json(
      await fetch(`http://127.0.0.1:${port}/api/agents`, { headers }),
    )) as { agents: AgentBody[] };
    assert.deepEqual(
      list.agents.map((a) => a.label).sort(),
      ["carol", "dave"],
    );

    const del = (await json(
      await fetch(`http://127.0.0.1:${port}/api/agents/carol`, {
        method: "DELETE",
        headers,
      }),
    )) as { ok: boolean; deleted: boolean };
    assert.equal(del.ok, true);
    assert.equal(del.deleted, true);

    const after = (await json(
      await fetch(`http://127.0.0.1:${port}/api/agents`, { headers }),
    )) as { agents: AgentBody[] };
    assert.deepEqual(after.agents.map((a) => a.label), ["dave"]);

    const again = (await json(
      await fetch(`http://127.0.0.1:${port}/api/agents/carol`, {
        method: "DELETE",
        headers,
      }),
    )) as { ok: boolean; deleted: boolean };
    assert.equal(again.deleted, false);
  } finally {
    await server.stop();
  }
});

test("agents: delete rejects an invalid label with a clean 4xx", async () => {
  const { server, port } = await bootAgentServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/agents/..%2Fevil`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${BOOT_TOKEN}` },
    });
    assert.equal(res.status, 400);
  } finally {
    await server.stop();
  }
});

test("agents: the API is guarded by the boot token", async () => {
  const { server, port } = await bootAgentServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/agents`);
    assert.equal(res.status, 401);
    const create = await fetch(`http://127.0.0.1:${port}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "eve" }),
    });
    assert.equal(create.status, 401);
  } finally {
    await server.stop();
  }
});
