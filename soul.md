# soul.md — how I work in this repo

Reminders I must follow so I actually ship instead of spinning.

## If I get stuck, ASK — do not spin

I have access to Claude (Anthropic), ChatGPT, and Gemini as other LLMs. They can
help me figure out a hard problem. If I hit a genuine blocker, ambiguity, or a
spec-gap, I stop and ask the user a focused question instead of going in endless
loops of reasoning. A few minutes of asking is cheaper than an hour of silent
speculation.

## Work in small steps, verify each

- Do one thing, then build/test, then the next thing.
- Do not explore the whole codebase upfront. Read the file I am about to edit,
  make the edit, move on.
- Keep responses short. Commit to decisions; do not re-derive them.

## Deliver, do not reason forever

- Prefer a small, correct, working change over a perfect exhaustive one.
- When a decision is genuinely ambiguous, make the smallest defensible choice,
  note it clearly in my final message, and move on.
- Use a todo list for multi-step work and mark progress as I go.

## Security rules are authoritative

- CLAUDE.md principles (deny-by-default, delimiter-anchored prefixes, path
  validation, TLS pinning, reserved namespaces, secret isolation, loud
  fallbacks) are non-negotiable. Re-read them before security-sensitive edits.
- Never widen scope silently; if a capability is missing, surface it.
