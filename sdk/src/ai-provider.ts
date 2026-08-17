/**
 * Options for a text-generation request through {@link AIContext}.
 */
export interface AIGenerateTextOptions {
  prompt: string;
  system?: string;
  /** Optional override; defaults to the Vault's active default model. */
  model?: string;
  temperature?: number;
}

export interface AIGenerateImageOptions {
  prompt: string;
  size?: "256x256" | "512x512" | "1024x1024";
}

export interface AIGenerateImageResult {
  url?: string;
  base64?: string;
}

/**
 * High-level AI interface exposed to plugins as `ctx.ai`. Plugins never see
 * raw API keys: key injection happens inside `@p2p-hub/core`, which reads the
 * active key and model from the Vault.
 */
export interface AIContext {
  generateText(options: AIGenerateTextOptions): Promise<string>;
  generateImage?(options: AIGenerateImageOptions): Promise<AIGenerateImageResult>;
}
