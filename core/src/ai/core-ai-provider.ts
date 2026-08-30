import type {
  AIGenerateImageOptions,
  AIGenerateImageResult,
  AIGenerateTextOptions,
} from "@p2p-hub/sdk";
import { sanitizeAIOutput } from "@p2p-hub/sdk";
import { VaultManager } from "../storage/vault-manager";
import type { AIBudgetGate, AIInvocationContext } from "./ai-budget";

export interface CoreAIProviderOptions {
  vault: VaultManager;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /**
   * Anti-financial-DoS quota gate consulted at the top of every LLM call,
   * before the key is resolved and before any request leaves the process. The
   * gate throws {@link AIQuotaExceededError} to refuse a call. Injectable so
   * the operator's {@link AIBudgetManager} (core-server) enforces the quota
   * at this single choke point without the provider depending on it directly.
   * Absent ⇒ no quota is enforced (the default for tests and bare hosts).
   */
  aiBudgetGate?: AIBudgetGate;
}

interface ResolvedAI {
  apiKey: string | null;
  baseUrl: string | null;
  model: string | null;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

/**
 * The only component allowed to read raw AI keys from the Vault. It injects
 * the key into outbound calls; plugins only ever see the high-level result.
 */
export class CoreAIProvider {
  constructor(private readonly options: CoreAIProviderOptions) {}

  private async resolve(): Promise<ResolvedAI> {
    const [apiKey, baseUrl, model] = await Promise.all([
      this.options.vault.getSecret("ai.apiKey"),
      this.options.vault.getSecret("ai.baseUrl"),
      this.options.vault.getSecret("ai.model"),
    ]);
    return { apiKey, baseUrl, model };
  }

  private isLocal(baseUrl: string): boolean {
    return (
      baseUrl.includes("localhost") ||
      baseUrl.includes("127.0.0.1") ||
      baseUrl.includes(":11434")
    );
  }

  private requireKey(apiKey: string | null, baseUrl: string): void {
    if (!apiKey && !this.isLocal(baseUrl)) {
      throw new Error("VaultError: No active AI key configured in Vault");
    }
  }

  private chatUrl(baseUrl: string): string {
    return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  }

  async generateText(
    options: AIGenerateTextOptions,
    context?: AIInvocationContext,
  ): Promise<string> {
    // Mandatory anti-financial-DoS gate at the very top: a call that is over
    // quota is refused here, before the vault key is resolved and before the
    // LLM endpoint is reached. The gate throws AIQuotaExceededError, which the
    // TaskBroker surfaces as a typed error result (HTTP 429 on the bridge).
    this.options.aiBudgetGate?.consume(context);

    const { apiKey, baseUrl, model } = await this.resolve();
    const resolvedBase = baseUrl ?? DEFAULT_BASE_URL;
    this.requireKey(apiKey, resolvedBase);

    const fetchFn = this.options.fetchFn ?? fetch;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const body = {
      model: options.model ?? model ?? DEFAULT_MODEL,
      messages: [
        ...(options.system ? [{ role: "system", content: options.system }] : []),
        { role: "user", content: options.prompt },
      ],
      ...(options.temperature !== undefined
        ? { temperature: options.temperature }
        : {}),
    };

    const res = await fetchFn(this.chatUrl(resolvedBase), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`AI request failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    // Mandatory output sanitization at the single AI choke point: every
    // completion (structured JSON, PBX payloads, free text) is run through the
    // SDK sanitizer before it can reach a plugin, the UI, or a Propose-Then-
    // Confirm flow. A plugin cannot bypass this on the in-process path.
    return sanitizeAIOutput(content);
  }

  async generateImage(
    options: AIGenerateImageOptions,
    context?: AIInvocationContext,
  ): Promise<AIGenerateImageResult> {
    // Same mandatory quota gate as generateText: image generation is a billed
    // capability too, so a caller cannot route cost around the text path.
    this.options.aiBudgetGate?.consume(context);

    const { apiKey, baseUrl } = await this.resolve();
    const resolvedBase = baseUrl ?? DEFAULT_BASE_URL;
    this.requireKey(apiKey, resolvedBase);

    const fetchFn = this.options.fetchFn ?? fetch;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const res = await fetchFn(
      `${resolvedBase.replace(/\/+$/, "")}/images/generations`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: options.prompt, size: options.size }),
      },
    );

    if (!res.ok) {
      throw new Error(`AI request failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as {
      data?: Array<{ url?: string; b64_json?: string }>;
    };
    const first = data.data?.[0];
    return { url: first?.url, base64: first?.b64_json };
  }
}
