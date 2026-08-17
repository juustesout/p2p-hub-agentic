import type {
  AIGenerateImageOptions,
  AIGenerateImageResult,
  AIGenerateTextOptions,
} from "@p2p-hub/sdk";
import { VaultManager } from "../storage/vault-manager";

export interface CoreAIProviderOptions {
  vault: VaultManager;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
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

  async generateText(options: AIGenerateTextOptions): Promise<string> {
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
    return data.choices?.[0]?.message?.content ?? "";
  }

  async generateImage(
    options: AIGenerateImageOptions,
  ): Promise<AIGenerateImageResult> {
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
