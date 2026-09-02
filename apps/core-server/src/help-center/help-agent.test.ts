import { test } from "node:test";
import assert from "node:assert/strict";
import { HELP_CENTER_DOCS } from "@p2p-hub/sdk";
import {
  HelpAgent,
  MAX_AGENT_QUESTION_LENGTH,
  MAX_AGENT_STEPS,
  describeState,
  type HelpAgentAI,
  type HelpAgentState,
} from "./help-agent";

const IDLE_STATE: HelpAgentState = {
  safeMode: false,
  networkPaused: false,
  vaultExists: true,
  vaultUnlocked: true,
};

function stubAI(overrides: Partial<HelpAgentAI> = {}): HelpAgentAI & {
  calls: Array<{ prompt: string; system?: string }>;
} {
  const calls: Array<{ prompt: string; system?: string }> = [];
  return {
    isConfigured: async () => true,
    generateText: async (options) => {
      calls.push(options);
      return JSON.stringify({
        answer: 'De app start mogelijk in de veilige modus. Zie "De app start niet".',
        steps: ["Start de app opnieuw met --safe-mode.", "Maak een diagnose-bundel."],
      });
    },
    ...overrides,
    calls,
  } as HelpAgentAI & { calls: typeof calls };
}

function makeAgent(ai: HelpAgentAI): HelpAgent {
  return new HelpAgent(ai, () => IDLE_STATE);
}

test("ask rejects non-string and empty questions with a typed error", async () => {
  const agent = makeAgent(stubAI());
  const r1 = await agent.ask(42);
  assert.equal(r1.ok, false);
  if (!r1.ok) {
    assert.equal(r1.error.code, "invalid-question");
  }
  const r2 = await agent.ask("   ");
  assert.equal(r2.ok, false);
  if (!r2.ok) {
    assert.equal(r2.error.code, "invalid-question");
  }
});

test("ask returns ai-not-configured when no provider is available", async () => {
  const agent = makeAgent(stubAI({ isConfigured: async () => false }));
  const result = await agent.ask("help, de app start niet");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "ai-not-configured");
  }
});

test("a happy-path ask returns the parsed proposal with grounded sources", async () => {
  const ai = stubAI();
  const agent = makeAgent(ai);
  const result = await agent.ask("mijn app start niet meer na een update");

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.proposal.steps.length, 2);
  assert.match(result.proposal.answer, /veilige modus/);
  assert.ok(result.proposal.sources.length > 0, "should cite at least one source");
  assert.ok(
    result.proposal.sources.every(
      (s) => HELP_CENTER_DOCS.some((d) => d.id === s.docId),
    ),
    "cited sources must exist in the corpus",
  );

  // The LLM must have been told the propose-then-confirm rules and given the
  // situation + corpus, and must never be asked to execute anything itself.
  const prompt = ai.calls[0].prompt;
  const system = ai.calls[0].system ?? "";
  assert.match(prompt, /Situatie van de app/);
  assert.match(prompt, /Document "De app start niet/);
  assert.match(system, /JSON-formaat/);
  assert.match(system, /voert NOOIT zelf acties uit/);
  assert.doesNotMatch(system, /execute|uitvoeren\b/i);
});

test("ask forwards a secret-free state snapshot and never raw vault values", async () => {
  const ai = stubAI();
  const agent = makeAgent(ai);
  await agent.ask("netwerk werkt niet");
  const prompt = ai.calls[0].prompt;
  assert.match(prompt, /Vault aanwezig: ja/);
  assert.match(prompt, /Netwerk gepauzeerd: nee/);
  assert.doesNotMatch(prompt, /sk-test|Bearer|api[_-]?key/i);
});

test("a malformed model reply degrades to the raw text, never fabricated steps", async () => {
  const ai = stubAI({
    generateText: async () => "sorry, ik kon geen json maken\nmaar probeer dit: herstart",
  });
  const result = await makeAgent(ai).ask("wat nu?");
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.proposal.steps.length, 0);
  assert.match(result.proposal.answer, /herstart/);
});

test("model replies are clamped: step count, step length and answer length", async () => {
  const manySteps = Array.from({ length: 9 }, (_, i) => `Stap ${i + 1}`);
  const ai = stubAI({
    generateText: async () =>
      JSON.stringify({
        answer: "x".repeat(6000),
        steps: manySteps.map((s) => s.repeat(100)),
      }),
  });
  const result = await makeAgent(ai).ask("vraag");
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.ok(result.proposal.answer.length <= 4000, "answer length must be bounded");
  assert.ok(result.proposal.steps.length <= MAX_AGENT_STEPS);
  assert.ok(
    result.proposal.steps.every((s) => s.length <= 240),
    "each step must be bounded",
  );
});

test("an unreachable provider maps to ai-unavailable, never a raw throw", async () => {
  const ai = stubAI({
    generateText: async () => {
      throw new Error("AI request failed: 502 Bad Gateway");
    },
  });
  const result = await makeAgent(ai).ask("help");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "ai-unavailable");
    assert.match(result.error.detail, /502/);
  }
});

test("describeState renders every field in Dutch", () => {
  const text = describeState({
    safeMode: true,
    networkPaused: true,
    vaultExists: false,
    vaultUnlocked: false,
  });
  assert.match(text, /Veilige modus actief: ja/);
  assert.match(text, /Netwerk gepauzeerd: ja/);
  assert.match(text, /Vault aanwezig: nee/);
  assert.match(text, /Vault ontgrendeld: nee/);
});

test("questions are trimmed and length-bounded before reaching the model", async () => {
  const ai = stubAI();
  const agent = makeAgent(ai);
  const long = `q${"x".repeat(MAX_AGENT_QUESTION_LENGTH + 500)}`;
  const result = await agent.ask(`  ${long}  `);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.ok(result.proposal.question.length <= MAX_AGENT_QUESTION_LENGTH);
});
