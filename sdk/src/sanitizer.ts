/**
 * Content sanitizer: deterministic, in-memory stripping of HTML tags, scripts,
 * inline event handlers and dangerous URL schemes from user/peer-supplied text
 * and Markdown. Output is safe to render as plain text (or as text embedded in
 * a controlled document) without executing anything.
 *
 * Deliberately avoids `eval`/`new Function` and ReDoS-prone regexes: tag and
 * link scanning is a single linear pass, and scheme detection compares against
 * a fixed allow/deny list after normalizing the scheme prefix.
 */

/** URL schemes that can trigger script/HTML execution and are neutralized. */
const DANGEROUS_SCHEMES = new Set(["javascript", "vbscript", "data"]);

/** Word-boundary-anchored detection of dangerous schemes in raw text. */
const DANGEROUS_SCHEME_RE = /\b(?:javascript|vbscript|data)\s*:/i;

/** Element names whose *content* is also removed, not just the tag. */
const CONTENT_BLOCKED_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
]);

function isTagStartChar(ch: string): boolean {
  return /[a-zA-Z]/.test(ch);
}

function isNameChar(ch: string): boolean {
  return /[a-zA-Z0-9]/.test(ch);
}

interface ReadTagResult {
  name: string;
  end: number;
  selfClosing: boolean;
}

/**
 * Attempt to read a full HTML tag starting at `input[start] === "<"`. Returns
 * null when the `<` is not a tag (e.g. `2 < 3`). Attribute scanning honours
 * quoted values so a `>` inside an attribute does not truncate the tag.
 */
function readTag(input: string, start: number): ReadTagResult | null {
  const n = input.length;
  let i = start + 1;
  if (i >= n) {
    return null;
  }

  if (input[i] === "/") {
    i += 1;
    let name = "";
    while (i < n && isNameChar(input[i])) {
      name += input[i];
      i += 1;
    }
    const gt = input.indexOf(">", i);
    if (gt === -1) {
      return null;
    }
    return { name: name.toLowerCase(), end: gt + 1, selfClosing: false };
  }

  if (input[i] === "!" || input[i] === "?") {
    const gt = input.indexOf(">", i);
    if (gt === -1) {
      return null;
    }
    return { name: "", end: gt + 1, selfClosing: false };
  }

  if (!isTagStartChar(input[i])) {
    return null;
  }

  let name = "";
  while (i < n && isNameChar(input[i])) {
    name += input[i];
    i += 1;
  }

  let selfClosing = false;
  while (i < n) {
    const c = input[i];
    if (c === ">") {
      i += 1;
      break;
    }
    if (c === "/" && input[i + 1] === ">") {
      selfClosing = true;
      i += 2;
      break;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i += 1;
      while (i < n && input[i] !== quote) {
        i += 1;
      }
      if (i < n) {
        i += 1;
      }
      continue;
    }
    i += 1;
  }

  return { name, end: i, selfClosing };
}

/**
 * Find the index just past the closing tag `</name>` at or after `from`.
 * Returns -1 when no matching close tag exists. Linear scan, no regex.
 */
function findClosingTag(input: string, from: number, name: string): number {
  const lower = input.toLowerCase();
  const needle = `</${name}`;
  let idx = lower.indexOf(needle, from);
  while (idx !== -1) {
    let j = idx + needle.length;
    while (j < input.length && /\s/.test(input[j])) {
      j += 1;
    }
    if (input[j] === ">") {
      return j + 1;
    }
    idx = lower.indexOf(needle, idx + 1);
  }
  return -1;
}

/**
 * Remove HTML comments, tags, and the full content of script/style/iframe/
 * object/embed elements. The text *between* ordinary tags is preserved.
 */
export function stripHtml(input: string): string {
  let out = "";
  let i = 0;
  const n = input.length;
  while (i < n) {
    if (input[i] === "<") {
      if (input.startsWith("<!--", i)) {
        const end = input.indexOf("-->", i + 4);
        i = end === -1 ? n : end + 3;
        continue;
      }
      const tag = readTag(input, i);
      if (tag !== null) {
        if (
          CONTENT_BLOCKED_TAGS.has(tag.name) &&
          !tag.selfClosing
        ) {
          const close = findClosingTag(input, tag.end, tag.name);
          i = close === -1 ? n : close;
        } else {
          i = tag.end;
        }
        continue;
      }
    }
    out += input[i];
    i += 1;
  }
  return out;
}

/**
 * Normalize a URL's scheme prefix for comparison: strips leading whitespace
 * and control characters (used to obfuscate `java\nscript:`) so the scheme
 * text can be matched against the deny list reliably.
 */
function schemeOf(url: string): string {
  let scheme = "";
  for (let i = 0; i < url.length; i++) {
    const ch = url[i];
    if (ch === ":") {
      break;
    }
    if (ch <= " " || /\s/.test(ch)) {
      continue;
    }
    scheme += ch;
    if (scheme.length > 32) {
      break;
    }
  }
  return scheme.toLowerCase();
}

/** True when `url` uses a scheme that can execute script or embed HTML. */
export function isDangerousUrl(url: string): boolean {
  return DANGEROUS_SCHEMES.has(schemeOf(url.trim()));
}

/**
 * Return `url` unchanged when its scheme is safe, or `about:blank` when it
 * uses `javascript:`/`vbscript:`/`data:` (possibly with whitespace
 * obfuscation).
 */
export function sanitizeUrl(url: string): string {
  return isDangerousUrl(url) ? "about:blank" : url;
}

/**
 * True when `text` contains an HTML tag (a `<` followed by a letter, `/` or
 * `!`) or a dangerous URL scheme. The scheme check is word-boundary-anchored
 * so innocuous words like "metadata:" do not false-positive, and both checks
 * are single-pass (no backtracking).
 */
export function containsUnsafeContent(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "<") {
      const next = text[i + 1];
      if (next !== undefined && (isTagStartChar(next) || next === "/" || next === "!")) {
        return true;
      }
    }
  }
  return DANGEROUS_SCHEME_RE.test(text);
}

/**
 * Return `input` with every HTML tag, script/style block and inline handler
 * removed. Plain text between tags is preserved verbatim.
 */
export function sanitizeText(input: string): string {
  return stripHtml(input);
}

interface ParsedLink {
  label: string;
  url: string;
  end: number;
}

/**
 * Parse a Markdown inline link/image whose `[` is at `openBracket`. Returns
 * null when it is not a well-formed link. The URL is read with balanced
 * parentheses so `javascript:void(0)` is captured whole.
 */
function parseLink(text: string, openBracket: number): ParsedLink | null {
  const closeBracket = text.indexOf("]", openBracket + 1);
  if (closeBracket === -1) {
    return null;
  }
  if (text[closeBracket + 1] !== "(") {
    return null;
  }
  const label = text.slice(openBracket + 1, closeBracket);
  let depth = 1;
  let i = closeBracket + 2;
  while (i < text.length) {
    const c = text[i];
    if (c === "(") {
      depth += 1;
    } else if (c === ")") {
      depth -= 1;
      if (depth === 0) {
        break;
      }
    }
    i += 1;
  }
  if (depth !== 0) {
    return null;
  }
  return { label, url: text.slice(closeBracket + 2, i), end: i + 1 };
}

/**
 * Strip inline HTML/scripts while preserving basic Markdown structure
 * (`**bold**`, `*italic*`, lists). Inline link/image URLs are run through
 * {@link sanitizeUrl}: a dangerous URL becomes `about:blank` rather than
 * remaining a live `javascript:` link.
 */
export function sanitizeMarkdown(markdown: string): string {
  const text = stripHtml(markdown);
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "!" && text[i + 1] === "[") {
      const link = parseLink(text, i + 1);
      if (link) {
        out += `![${link.label}](${sanitizeUrl(link.url)})`;
        i = link.end;
        continue;
      }
    } else if (ch === "[") {
      const link = parseLink(text, i);
      if (link) {
        out += `[${link.label}](${sanitizeUrl(link.url)})`;
        i = link.end;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Strip the control characters (excluding `\t`, `\n`, `\r`) that would survive
 * {@link sanitizeMarkdown}. These can be smuggled into terminal logs, JSON
 * payloads, or UI strings via an AI response.
 */
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * End-to-end sanitizer for AI-generated text. Runs the output through
 * {@link sanitizeMarkdown} (removing HTML/scripts and neutralizing dangerous
 * link schemes) and then strips stray control characters. Every AI completion
 * that can reach the UI or a Propose-Then-Confirm flow must pass through this.
 */
export function sanitizeAIOutput(text: string): string {
  return sanitizeMarkdown(text).replace(CONTROL_CHARS_RE, "");
}
