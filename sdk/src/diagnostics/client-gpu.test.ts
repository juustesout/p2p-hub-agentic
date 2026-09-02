import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeClientGpu,
  GPU_STRING_MAX_LENGTH,
  type ClientGpuProbe,
} from "./client-gpu";

test("sanitizeClientGpu passes through a well-formed probe unchanged", () => {
  const probe: ClientGpuProbe = {
    vendor: "Google Inc. (NVIDIA)",
    renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11)",
    hardwareAcceleration: true,
    windowScaleFactor: 1.25,
  };
  assert.deepEqual(sanitizeClientGpu(probe), probe);
});

test("sanitizeClientGpu returns null for a non-object payload", () => {
  assert.equal(sanitizeClientGpu(null), null);
  assert.equal(sanitizeClientGpu("gpu"), null);
  assert.equal(sanitizeClientGpu([1, 2]), null);
  assert.equal(sanitizeClientGpu(undefined), null);
});

test("sanitizeClientGpu drops unknown keys and malformed fields to null", () => {
  const out = sanitizeClientGpu({
    renderer: "ok",
    vendor: 42,
    hardwareAcceleration: "yes",
    windowScaleFactor: "high",
    evil: "payload",
    peerId: "a".repeat(64),
  });
  assert.deepEqual(out, {
    vendor: null,
    renderer: "ok",
    hardwareAcceleration: null,
    windowScaleFactor: null,
  });
});

test("sanitizeClientGpu bounds strings and strips control characters", () => {
  const long = "x".repeat(GPU_STRING_MAX_LENGTH + 1);
  const ctl = "vendor\u0000with\u001fcontrol";
  const out = sanitizeClientGpu({ vendor: long, renderer: ctl });
  assert.equal(out!.vendor, null);
  assert.equal(out!.renderer, "vendor with control");
});

test("sanitizeClientGpu bounds windowScaleFactor and requires finite numbers", () => {
  assert.equal(sanitizeClientGpu({ windowScaleFactor: 0.05 })!.windowScaleFactor, null);
  assert.equal(sanitizeClientGpu({ windowScaleFactor: 11 })!.windowScaleFactor, null);
  assert.equal(sanitizeClientGpu({ windowScaleFactor: Number.NaN })!.windowScaleFactor, null);
  assert.equal(sanitizeClientGpu({ windowScaleFactor: Number.POSITIVE_INFINITY })!.windowScaleFactor, null);
  assert.equal(sanitizeClientGpu({ windowScaleFactor: 2 })!.windowScaleFactor, 2);
});

test("sanitizeClientGpu caps the number of keys it copies", () => {
  const hostile: Record<string, unknown> = {};
  for (let i = 0; i < 20; i += 1) {
    hostile[`k${i}`] = "value";
  }
  hostile.renderer = "smuggled after the cap";
  const out = sanitizeClientGpu(hostile);
  assert.ok(out);
  assert.equal(out!.renderer, null);
  assert.equal(out!.vendor, null);
});
