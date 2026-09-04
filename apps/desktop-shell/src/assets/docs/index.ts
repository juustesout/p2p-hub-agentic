/**
 * HelpCenter documentation corpus entry point.
 *
 * Since Pijler E (Brief 7D) the corpus is owned by the SDK
 * (`sdk/src/docs.ts`) so the desktop shell and the core-server help-agent read
 * the same knowledge base. This module is kept as a thin re-export to preserve
 * the legacy `HELP_DOCS` import path used across the shell.
 */

export { HELP_CENTER_DOCS as HELP_DOCS } from "@p2p-hub/sdk";
