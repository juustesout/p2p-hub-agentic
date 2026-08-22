import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CAPABILITY_TYPE,
  isCapabilityType,
} from "./capability";

test("the fail-closed default capability type is action", () => {
  assert.equal(DEFAULT_CAPABILITY_TYPE, "action");
});

test("isCapabilityType accepts exactly the two declared types", () => {
  assert.equal(isCapabilityType("action"), true);
  assert.equal(isCapabilityType("telemetry"), true);
});

test("isCapabilityType rejects anything that is not a declared type (fail-closed)", () => {
  assert.equal(isCapabilityType(undefined), false);
  assert.equal(isCapabilityType(""), false);
  assert.equal(isCapabilityType("stream"), false);
  assert.equal(isCapabilityType("ACTION"), false);
  assert.equal(isCapabilityType(42), false);
});
