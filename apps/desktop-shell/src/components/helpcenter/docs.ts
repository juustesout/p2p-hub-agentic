/**
 * Re-export of the shared HelpCenter documentation toolkit.
 *
 * The corpus and its pure parser/search now live in the SDK
 * (`sdk/src/docs.ts`) so the desktop-shell's Documentatie tab and the
 * core-server help-agent reason over exactly one copy of the knowledge base.
 * This module keeps the old import surface (`parseMarkdown`, `searchDocs`,
 * `HELP_DOCS`, ...) so components and the doc tests keep working unchanged;
 * `HELP_CENTER_DOCS` is exported under the legacy alias `HELP_DOCS`.
 */

export {
  parseMarkdown,
  docPlainText,
  queryMatches,
  searchDocs,
  groupDocs,
  DOC_CATEGORIES,
  HELP_CENTER_DOCS as HELP_DOCS,
} from "@p2p-hub/sdk";

export type { HelpDoc, DocBlock, DocSearchHit } from "@p2p-hub/sdk";
