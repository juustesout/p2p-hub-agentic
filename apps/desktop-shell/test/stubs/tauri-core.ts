/**
 * Test stub for `@tauri-apps/api/core`. The esbuild test bundle redirects the
 * `@tauri-apps/api/core` specifier here, so the services' runtime
 * `await import("@tauri-apps/api/core")` resolves to this module instead of the
 * real (WebView-only) Tauri API.
 *
 * The mutable `__tauri.invoke` holder is the injection point: tests reassign it
 * to control what each Tauri command returns. The exported `invoke` wrapper is
 * what the bundled services see, so reassigning the holder is visible to them
 * (an ESM namespace object itself is immutable — hence the holder object).
 */

export const __tauri: {
  invoke: (command: string, args?: unknown) => Promise<unknown>;
} = {
  invoke: async () => {
    throw new Error("Tauri invoke not stubbed");
  },
};

export function invoke(command: string, args?: unknown): Promise<unknown> {
  return __tauri.invoke(command, args);
}
