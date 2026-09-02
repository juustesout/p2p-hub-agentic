/**
 * Ambient declarations for Vite `?raw` text imports. Vite inlines the file as a
 * string at build time; this declaration makes TypeScript accept the specifier.
 * The node:test suites never import these modules (esbuild would have no raw
 * loader) — they test the parser/search with inline strings instead.
 */
declare module "*.md?raw" {
  const content: string;
  export default content;
}
