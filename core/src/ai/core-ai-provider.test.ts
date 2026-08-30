import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CoreAIProvider } from "./core-ai-provider";
import {
  AIQuotaExceededError,
  AI_QUOTA_EXCEEDED_ERROR_CODE,
  type AIBudgetGate,
} from "./ai-budget";
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

test("generateText consults the budget gate before resolving the key or fetching", async () => {
  const vault = await makeVault();
  await vault.setSecret("ai.baseUrl", "http://localhost:11434/v1");

  const seen: unknown[] = [];
  const gate: AIBudgetGate = {
    consume: (context) => {
      seen.push(context);
    },
  };
  let fetched = false;
  const fetchFn = async () => {
    fetched = true;
    return jsonResponse(200, {
      choices: [{ message: { content: "never reached" } }],
    });
  };

  const provider = new CoreAIProvider({
    vault,
    fetchFn: fetchFn as typeof fetch,
    aiBudgetGate: gate,
  });
  await provider.generateText({ prompt: "hi" }, { peerId: "peer-1" });

  assert.deepEqual(seen, [{ peerId: "peer-1" }]);
  assert.equal(fetched, true, "an in-budget call still reaches the LLM");
});

test("a quota-refused generateText throws AIQuotaExceededError without fetching", async () => {
  const vault = await makeVault();
  await vault.setSecret("ai.baseUrl", "http://localhost:11434/v1");

  let fetched = false;
  const fetchFn = async () => {
    fetched = true;
    return jsonResponse(200, {
      choices: [{ message: { content: "never reached" } }],
    });
  };
  const gate: AIBudgetGate = {
    consume: () => {
      throw new AIQuotaExceededError("AI quota exceeded for peer \"peer-1\"");
    },
  };

  const provider = new CoreAIProvider({
    vault,
    fetchFn: fetchFn as typeof fetch,
    aiBudgetGate: gate,
  });

  await assert.rejects(
    () => provider.generateText({ prompt: "hi" }, { peerId: "peer-1" }),
    (err: unknown) => {
      assert.ok(err instanceof AIQuotaExceededError);
      assert.equal((err as AIQuotaExceededError).code, AI_QUOTA_EXCEEDED_ERROR_CODE);
      return true;
    },
  );
  assert.equal(fetched, false, "the LLM must never be reached when over quota");
});

test("generateText with no caller context still passes through the gate", async () => {
  const vault = await makeVault();
  await vault.setSecret("ai.baseUrl", "http://localhost:11434/v1");

  const seen: unknown[] = [];
  const gate: AIBudgetGate = {
    consume: (context) => {
      seen.push(context);
    },
  };
  const fetchFn = async () =>
    jsonResponse(200, {
      choices: [{ message: { content: "ok" } }],
    });
  const provider = new CoreAIProvider({
    vault,
    fetchFn: fetchFn as typeof fetch,
    aiBudgetGate: gate,
  });

  await provider.generateText({ prompt: "hi" });
  assert.deepEqual(seen, [undefined], "local calls are attributed by the gate");
});

test("generateImage consults the budget gate too", async () => {
  const vault = await makeVault();
  await vault.setSecret("ai.baseUrl", "http://localhost:11434/v1");

  let gateCalls = 0;
  const gate: AIBudgetGate = {
    consume: () => {
      gateCalls += 1;
      throw new AIQuotaExceededError("over budget");
    },
  };
  const provider = new CoreAIProvider({
    vault,
    aiBudgetGate: gate,
    fetchFn: (async () =>
      jsonResponse(200, {
        data: [{ url: "https://example.test/img.png" }],
      })) as typeof fetch,
  });

  await assert.rejects(
    () => provider.generateImage({ prompt: "draw a cat" }, { peerId: "peer-1" }),
    AIQuotaExceededError,
  );
  assert.equal(gateCalls, 1);
});

test("without a gate, generateText behaves exactly as before", async () => {
  const vault = await makeVault();
  await vault.setSecret("ai.baseUrl", "http://localhost:11434/v1");
  const fetchFn = async () =>
    jsonResponse(200, {
      choices: [{ message: { content: "ungated reply" } }],
    });
  const provider = new CoreAIProvider({ vault, fetchFn: fetchFn as typeof fetch });
  assert.equal(await provider.generateText({ prompt: "hi" }), "ungated reply");
});
