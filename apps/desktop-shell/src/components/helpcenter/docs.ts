/**
 * Offline documentation toolkit for the HelpCenter (Pijler E / Brief 7C).
 *
 * The corpus lives as local markdown (bundled into the app — no network) and
 * is rendered + searched entirely on-device. This module is deliberately free
 * of `.md?raw` imports so the node:test suites can exercise parser and search
 * against inline strings; the registry (`assets/docs/index.ts`) is the only
 * place raw imports happen.
 *
 * The renderer is a deliberately small, safe subset of markdown: headings,
 * paragraphs, bullet/numbered lists and fenced code blocks. Inline emphasis
 * (`*`, `**`, `` ` ``) and links are stripped to plain text for search, and the
 * React layer renders the small set of allowed spans — no raw HTML is ever
 * emitted, so an accidental HTML-looking string in a doc can never become a
 * live element.
 */

export interface HelpDoc {
  id: string;
  title: string;
  /** Canonical list of doc ids → group label, see DOC_CATEGORIES. */
  category: "aan-de-slag" | "herstel";
  summary: string;
  keywords: string[];
  /** Full markdown body (already includes the title as a `#` heading). */
  markdown: string;
}

export const DOC_CATEGORIES: Array<{ id: HelpDoc["category"]; label: string }> = [
  { id: "aan-de-slag", label: "Aan de slag" },
  { id: "herstel", label: "Problemen oplossen" },
];

// ---------------------------------------------------------------------------
// Markdown parsing
// ---------------------------------------------------------------------------

export type DocBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; text: string };

const FENCE_RE = /^```/;

/**
 * Parse the small markdown subset into blocks. Blank lines separate blocks;
 * consecutive `- `/`1. ` lines group into a list; fenced code runs verbatim
 * (no inline interpretation). Everything else becomes a paragraph. Pure and
 * safe: it never interprets HTML and never evaluates anything.
 */
export function parseMarkdown(markdown: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code: copy until the closing fence (or EOF).
    if (FENCE_RE.test(line.trim())) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i].trim())) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // skip the closing fence
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      i += 1;
      continue;
    }

    // Lists: bullet `-` or numbered `1.` — grouped until a blank/non-item line.
    if (/^\s*(-|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*(-|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*(-|\d+\.)\s+/, "").trim());
        i += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // Paragraph: accumulate until a blank line or another structural line.
    if (line.trim() !== "") {
      const paragraph: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !/^(#{1,3})\s+/.test(lines[i]) &&
        !FENCE_RE.test(lines[i].trim())
      ) {
        paragraph.push(lines[i].trim());
        i += 1;
      }
      blocks.push({ type: "paragraph", text: paragraph.join(" ") });
      continue;
    }

    i += 1;
  }
  return blocks;
}

/** The plain text of a doc: heading text + paragraph/list/code content. */
export function docPlainText(markdown: string): string {
  const parts: string[] = [];
  for (const block of parseMarkdown(markdown)) {
    switch (block.type) {
      case "heading":
        parts.push(block.text);
        break;
      case "paragraph":
        parts.push(block.text);
        break;
      case "list":
        parts.push(...block.items);
        break;
      case "code":
        parts.push(block.text);
        break;
    }
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface DocSearchHit {
  doc: HelpDoc;
  score: number;
}

/** Tokenize plain text into lowercase words (3+ chars), deduped. */
function tokens(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9\u00e0-\u00ff]+/)) {
    const word = raw.trim();
    if (word.length >= 3 && !seen.has(word)) {
      seen.add(word);
      out.push(word);
    }
  }
  return out;
}

/** True when every whitespace-split query term appears in the haystack text. */
export function queryMatches(text: string, query: string): boolean {
  const lower = text.toLowerCase();
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => lower.includes(term));
}

/**
 * Rank docs by relevance to a free-text query. Score is the number of query
 * words found in (keywords/title/summary/body), weighted so a title or keyword
 * hit outweighs a body hit. Docs with zero matched terms are excluded unless
 * the query is empty (then everything scores 0 and is returned in doc order).
 * Pure and deterministic.
 */
export function searchDocs(docs: HelpDoc[], query: string): DocSearchHit[] {
  const q = query.trim();
  if (!q) {
    return docs.map((doc) => ({ doc, score: 0 }));
  }
  const queryWords = tokens(q);
  if (queryWords.length === 0) {
    return docs.map((doc) => ({ doc, score: 0 }));
  }
  const scored = docs.map((doc) => {
    const keywordText = `${doc.keywords.join(" ")} ${doc.title}`.toLowerCase();
    const bodyText = docPlainText(doc.markdown).toLowerCase();
    const summaryText = doc.summary.toLowerCase();
    let score = 0;
    let matched = 0;
    for (const word of queryWords) {
      const inKeyword = keywordText.includes(word);
      const inTitle = doc.title.toLowerCase().includes(word);
      const inSummary = summaryText.includes(word);
      const inBody = bodyText.includes(word);
      if (inKeyword || inTitle || inSummary || inBody) {
        matched += 1;
      }
      if (inTitle) {
        score += 4;
      }
      if (inKeyword) {
        score += 3;
      }
      if (inSummary) {
        score += 2;
      }
      if (inBody) {
        score += 1;
      }
    }
    if (matched === 0) {
      return null;
    }
    // A doc matching more distinct query words ranks higher.
    score *= matched;
    return { doc, score };
  });
  return scored
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id));
}

/** Group docs into category buckets in DOC_CATEGORIES order. */
export function groupDocs(docs: HelpDoc[]): Array<{ id: HelpDoc["category"]; label: string; docs: HelpDoc[] }> {
  return DOC_CATEGORIES.map((cat) => ({
    ...cat,
    docs: docs.filter((d) => d.category === cat.id),
  })).filter((group) => group.docs.length > 0);
}
