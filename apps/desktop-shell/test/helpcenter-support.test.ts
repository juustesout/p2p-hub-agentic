import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_QUESTION_MAX_LENGTH,
  agentAskFailure,
  bundleAsChatText,
  chatCapText,
  classifyMessage,
  SUPPORT_CHAT_MAX_LENGTH,
  validateAgentQuestion,
} from "../src/components/helpcenter/support";
import {
  lastBundleClipboardText,
  rememberLastBundle,
} from "../src/components/helpcenter/bundle-slot";
import type {
  ChatMessageRecordView,
  HelpAgentAskResult,
} from "../src/types";

function record(partial: Partial<ChatMessageRecordView>): ChatMessageRecordView {
  return {
    fromPeerId: "f".repeat(64),
    toPeerId: "t".repeat(64),
    text: "hallo",
    sentAt: "2026-09-02T10:00:00.000Z",
    verified: true,
    ...partial,
  };
}

test("chatCapText keeps short text intact and marks long text as truncated", () => {
  const ok = chatCapText("kort bericht");
  assert.equal(ok.truncated, false);
  assert.equal(ok.text, "kort bericht");

  const exact = chatCapText("x".repeat(SUPPORT_CHAT_MAX_LENGTH));
  assert.equal(exact.truncated, false);

  const long = chatCapText("a".repeat(SUPPORT_CHAT_MAX_LENGTH + 5000));
  assert.equal(long.truncated, true);
  assert.ok(long.text.length <= SUPPORT_CHAT_MAX_LENGTH);
  assert.match(long.text, /afgekapt tot het chatlimiet/);
});

test("bundleAsChatText surfaces the last remembered bundle with a banner", () => {
  rememberLastBundle("");
  assert.equal(lastBundleClipboardText(), "");
  assert.equal(bundleAsChatText(), null, "no bundle yet");

  rememberLastBundle("dit is de bundelinhoud");
  const bundled = bundleAsChatText();
  assert.ok(bundled, "a remembered bundle becomes chat text");
  assert.match(bundled?.text ?? "", /diagnose-bundel/);
  assert.match(bundled?.text ?? "", /dit is de bundelinhoud/);
  rememberLastBundle("");
});

test("classifyMessage distinguishes you/support/other from the thread peer", () => {
  const supportPeer = "s".repeat(64);
  const myPeer = "m".repeat(64);

  assert.equal(
    classifyMessage(record({ fromPeerId: supportPeer, toPeerId: myPeer }), supportPeer),
    "support",
  );
  assert.equal(
    classifyMessage(record({ fromPeerId: myPeer, toPeerId: supportPeer }), supportPeer),
    "you",
  );
  assert.equal(
    classifyMessage(
      record({ fromPeerId: "x".repeat(64), toPeerId: "y".repeat(64) }),
      supportPeer,
    ),
    "other",
  );
});

test("validateAgentQuestion rejects empty and over-long questions", () => {
  assert.equal(validateAgentQuestion("   "), "Stel eerst een vraag.");
  assert.equal(validateAgentQuestion("waarom werkt dit niet?"), null);
  assert.ok(validateAgentQuestion("a".repeat(AGENT_QUESTION_MAX_LENGTH + 1)));
});

test("agentAskFailure maps every known code to a Dutch message", () => {
  const cases: Array<Extract<HelpAgentAskResult, { ok: false }>> = [
    { ok: false, code: "ai-not-configured" },
    { ok: false, code: "ai-unavailable", detail: "AI request failed: 502" },
    { ok: false, code: "invalid-question", detail: "Stel eerst een vraag." },
    { ok: false },
  ];
  for (const c of cases) {
    const msg = agentAskFailure(c);
    assert.equal(typeof msg, "string");
    assert.ok(msg.length > 0);
  }
  assert.match(agentAskFailure({ ok: false, code: "ai-unavailable" }), /niet bereikbaar/);
  assert.match(agentAskFailure({ ok: false, code: "ai-unavailable", detail: "boom" }), /boom/);
});
