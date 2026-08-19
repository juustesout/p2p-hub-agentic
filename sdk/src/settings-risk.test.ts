import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateSettingsRisk,
  highestSeverity,
  normalizeSettings,
  type EffectiveSettings,
} from "./settings-risk";
import { requiredTrustTier } from "./trust-tier";

const SAFE: EffectiveSettings = {
  p2pHubExposed: false,
  chatAutoNotify: false,
  unrestrictedRemoteSkills: false,
  allowExternalApiExecution: false,
  localVaultStorage: false,
};

function withOverrides(
  overrides: Partial<EffectiveSettings>,
): EffectiveSettings {
  return { ...SAFE, ...overrides };
}

test("safe settings produce no findings and aggregate none", () => {
  const result = evaluateSettingsRisk(SAFE);
  assert.deepEqual(result.findings, []);
  assert.equal(result.aggregate, "none");
});

test("undefined and partial settings are normalized to all-false defaults", () => {
  assert.deepEqual(evaluateSettingsRisk(undefined).findings, []);
  assert.deepEqual(evaluateSettingsRisk({}).findings, []);
  assert.deepEqual(normalizeSettings(undefined), SAFE);
  assert.deepEqual(normalizeSettings({ p2pHubExposed: true }), {
    ...SAFE,
    p2pHubExposed: true,
  });
});

test("critical rule: exposed + autoNotify + unrestricted remote skills", () => {
  const result = evaluateSettingsRisk(
    withOverrides({
      p2pHubExposed: true,
      chatAutoNotify: true,
      unrestrictedRemoteSkills: true,
    }),
  );
  assert.equal(result.aggregate, "critical");
  assert.ok(
    result.findings.some((f) => f.id === "ERR_EXPOSED_UNRESTRICTED_SKILL"),
  );
});

test("critical rule requires all three flags together", () => {
  // exposed + autoNotify, but remote skills still restricted -> no critical.
  const r = evaluateSettingsRisk(
    withOverrides({ p2pHubExposed: true, chatAutoNotify: true }),
  );
  assert.equal(r.aggregate, "none");
  assert.ok(
    !r.findings.some((f) => f.id === "ERR_EXPOSED_UNRESTRICTED_SKILL"),
  );
});

test("high rule: external api execution + unrestricted remote skills", () => {
  const result = evaluateSettingsRisk(
    withOverrides({
      allowExternalApiExecution: true,
      unrestrictedRemoteSkills: true,
    }),
  );
  assert.equal(result.aggregate, "high");
  assert.ok(result.findings.some((f) => f.id === "ERR_REMOTE_EXTERNAL_API_ACCESS"));
});

test("medium rule: exposed hub + local vault storage", () => {
  const result = evaluateSettingsRisk(
    withOverrides({ p2pHubExposed: true, localVaultStorage: true }),
  );
  assert.equal(result.aggregate, "medium");
  assert.ok(result.findings.some((f) => f.id === "WARN_P2P_VAULT_EXPOSURE"));
});

test("all findings are returned, sorted highest severity first", () => {
  const result = evaluateSettingsRisk(
    withOverrides({
      p2pHubExposed: true,
      chatAutoNotify: true,
      unrestrictedRemoteSkills: true,
      allowExternalApiExecution: true,
      localVaultStorage: true,
    }),
  );
  assert.equal(result.aggregate, "critical");
  const ids = result.findings.map((f) => f.id);
  assert.deepEqual(ids, [
    "ERR_EXPOSED_UNRESTRICTED_SKILL",
    "ERR_REMOTE_EXTERNAL_API_ACCESS",
    "WARN_P2P_VAULT_EXPOSURE",
  ]);
});

test("evaluation is deterministic and side-effect free", () => {
  const settings = withOverrides({
    p2pHubExposed: true,
    chatAutoNotify: true,
    unrestrictedRemoteSkills: true,
    allowExternalApiExecution: true,
    localVaultStorage: true,
  });
  const frozen = Object.freeze({ ...settings });
  const first = evaluateSettingsRisk(frozen);
  const second = evaluateSettingsRisk(frozen);
  assert.deepEqual(first, second);
  // The input object is untouched.
  assert.deepEqual(frozen, settings);
});

test("evaluateSettingsRisk does not mutate its input", () => {
  const settings = withOverrides({ p2pHubExposed: true });
  const snapshot = { ...settings };
  evaluateSettingsRisk(settings);
  assert.deepEqual(settings, snapshot);
});

test("highestSeverity picks the most severe value", () => {
  assert.equal(highestSeverity([]), "none");
  assert.equal(highestSeverity(["low"]), "low");
  assert.equal(highestSeverity(["low", "medium", "high"]), "high");
  assert.equal(highestSeverity(["medium", "critical", "high"]), "critical");
});

test("evaluation runs in well under 5ms", () => {
  const start = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) {
    evaluateSettingsRisk(SAFE);
    evaluateSettingsRisk(
      withOverrides({
        p2pHubExposed: true,
        chatAutoNotify: true,
        unrestrictedRemoteSkills: true,
        allowExternalApiExecution: true,
        localVaultStorage: true,
      }),
    );
  }
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(elapsedMs < 5000, `2000 evaluations took ${elapsedMs}ms`);
});

test("requiredTrustTier maps severity to minimum tier", () => {
  assert.equal(requiredTrustTier("critical"), 2);
  assert.equal(requiredTrustTier("high"), 1);
  assert.equal(requiredTrustTier("medium"), 0);
  assert.equal(requiredTrustTier("low"), 0);
  assert.equal(requiredTrustTier("none"), 0);
});
