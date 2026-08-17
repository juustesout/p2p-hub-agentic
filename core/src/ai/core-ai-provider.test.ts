import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CoreAIProvider } from "./core-ai-provider";
import { VaultManager } from "../storage/vault-manager";

async function makeVault(): Promise<VaultManager> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-provider-"));
  return new VaultManager({ dataDir, masterKey: "test-master" });
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    json: async () => body,
  } as Response;
}

test("generateText injects the vault key and returns the completion", async () => {
  const vault = await makeVault();
  await vault.setSecret("ai.apiKey", "sk-test-key");
  await vault.setSecret("ai.model", "deepseek-chat");

  let captured!: { url?: string; headers?: Record<string, string>; body?: unknown };
  const fetchFn = async (url: unknown, init: unknown) => {
    captured = {
      url: String(url),
      headers: (init as RequestInit).headers as Record<string, string>,
      body: JSON.parse((init as RequestInit).body as string),
    };
    return jsonResponse(200, {
      choices: [{ message: { content: "hello from the model" } }],
    });
  };

  const provider = new CoreAIProvider({ vault, fetchFn: fetchFn as typeof fetch });
  const result = await provider.generateText({ prompt: "hi" });

  assert.equal(result, "hello from the model");
  assert.equal(captured!.headers!.Authorization, "Bearer sk-test-key");
  assert.deepEqual(captured!.body, {
    model: "deepseek-chat",
    messages: [{ role: "user", content: "hi" }],
  });
});

test("generateText throws a VaultError when no key is configured", async () => {
  const vault = await makeVault();
  const provider = new CoreAIProvider({ vault });

  await assert.rejects(
    () => provider.generateText({ prompt: "hi" }),
    /VaultError: No active AI key configured in Vault/,
  );
});

test("a local endpoint works without an API key", async () => {
  const vault = await makeVault();
  await vault.setSecret("ai.baseUrl", "http://localhost:11434/v1");

  const fetchFn = async () =>
    jsonResponse(200, {
      choices: [{ message: { content: "local reply" } }],
    });

  const provider = new CoreAIProvider({ vault, fetchFn: fetchFn as typeof fetch });
  const result = await provider.generateText({ prompt: "hi" });

  assert.equal(result, "local reply");
});
