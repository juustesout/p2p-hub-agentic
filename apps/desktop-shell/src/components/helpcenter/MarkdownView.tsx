import type { ReactNode } from "react";
import { parseMarkdown, type DocBlock } from "./docs";

/**
 * Renders the small markdown subset produced by {@link parseMarkdown} into
 * React elements. Safety-first: only the known inline forms are interpreted
 * (`code`, `**bold**`, `[label](url)`), everything else is plain text — raw
 * HTML in a doc is never injected.
 */

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Ordered token scan: `code`, **bold**, [label](url). Handles each piece
  // once; leftovers become plain text. Bounded input (docs are local + short).
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      out.push(text.slice(last, match.index));
    }
    const token = match[0];
    const key = `${keyBase}-${i}`;
    i += 1;
    if (token.startsWith("`")) {
      out.push(
        <code key={key} className="rounded bg-white/10 px-1 py-0.5 font-mono text-[0.9em] text-sky-200">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      out.push(
        <strong key={key} className="font-semibold text-slate-100">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (link) {
        const [label, url] = [link[1], link[2]];
        if (/^https?:\/\//.test(url)) {
          out.push(
            <a
              key={key}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-300 underline hover:text-sky-200"
            >
              {label}
            </a>
          );
        } else {
          out.push(label);
        }
      } else {
        out.push(token);
      }
    }
    last = re.lastIndex;
  }
  if (last < text.length) {
    out.push(text.slice(last));
  }
  return out;
}

function blockView(block: DocBlock, index: number): ReactNode {
  const key = `b${index}`;
  switch (block.type) {
    case "heading":
      if (block.level === 1) {
        return (
          <h1 key={key} className="mb-2 text-lg font-semibold text-slate-100">
            {inline(block.text, key)}
          </h1>
        );
      }
      if (block.level === 2) {
        return (
          <h2 key={key} className="mb-1.5 mt-4 text-base font-semibold text-slate-200">
            {inline(block.text, key)}
          </h2>
        );
      }
      return (
        <h3 key={key} className="mb-1 mt-3 text-sm font-semibold text-slate-300">
          {inline(block.text, key)}
        </h3>
      );
    case "paragraph":
      return (
        <p key={key} className="mb-2 text-[13px] leading-relaxed text-slate-300">
          {inline(block.text, key)}
        </p>
      );
    case "list": {
      const items = block.items.map((item, itemIndex) => (
        <li key={`${key}-${itemIndex}`} className="mb-1 text-[13px] leading-relaxed text-slate-300">
          {inline(item, `${key}-${itemIndex}`)}
        </li>
      ));
      return block.ordered ? (
        <ol key={key} className="mb-2 list-decimal space-y-1 pl-5 marker:text-slate-500">
          {items}
        </ol>
      ) : (
        <ul key={key} className="mb-2 list-disc space-y-1 pl-5 marker:text-slate-500">
          {items}
        </ul>
      );
    }
    case "code":
      return (
        <pre
          key={key}
          className="mb-2 overflow-x-auto rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-xs leading-relaxed text-slate-300"
        >
          {block.text}
        </pre>
      );
    default:
      return null;
  }
}

/** Render a full markdown document body. */
export function MarkdownView({ markdown }: { markdown: string }) {
  const blocks = parseMarkdown(markdown);
  return <div className="space-y-0.5">{blocks.map(blockView)}</div>;
}

/** Render a markdown document, dropping a leading `# <title>` heading. */
export function MarkdownDocView({ markdown, title }: { markdown: string; title: string }) {
  const blocks = parseMarkdown(markdown);
  const first = blocks[0];
  const body =
    first && first.type === "heading" && first.level === 1 && first.text === title
      ? blocks.slice(1)
      : blocks;
  return <div className="space-y-0.5">{body.map(blockView)}</div>;
}
