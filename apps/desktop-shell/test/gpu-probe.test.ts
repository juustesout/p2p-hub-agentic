import { beforeEach, it } from "node:test";
import assert from "node:assert/strict";
import "./test-globals";
import {
  buildGpuProbe,
  probeWebglGpu,
  readWebglGpu,
  __resetGpuProbeCache,
} from "../src/services/gpu-probe";

function fakeGl(
  overrides: Partial<{
    getExtension: (name: string) => unknown;
    getParameter: (param: unknown) => unknown;
  }> = {},
): WebGLRenderingContext {
  return {
    getExtension: (name: string) => (name === "WEBGL_debug_renderer_info" ? { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 } : null),
    getParameter: () => null,
    ...overrides,
  } as unknown as WebGLRenderingContext;
}

beforeEach(() => {
  __resetGpuProbeCache();
});

it("reads unmasked vendor/renderer from the debug extension", () => {
  const gl = fakeGl({
    getExtension: () => ({
      UNMASKED_VENDOR_WEBGL: 0x9245,
      UNMASKED_RENDERER_WEBGL: 0x9246,
    }),
    getParameter: (param: unknown) =>
      param === 0x9245 ? "Google Inc. (NVIDIA)" : "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11)",
  });
  const probe = buildGpuProbe({ gl, devicePixelRatio: 1.5 });
  assert.equal(probe.vendor, "Google Inc. (NVIDIA)");
  assert.equal(probe.renderer, "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11)");
  assert.equal(probe.hardwareAcceleration, true);
  assert.equal(probe.windowScaleFactor, 1.5);
});

it("flags software renderers as hardwareAcceleration: false", () => {
  for (const renderer of [
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero))",
    "Mesa offscreen",
    "llvmpipe (LLVM 15.0.7, 256 bits)",
    "Microsoft Basic Render Driver",
  ]) {
    const gl = fakeGl({
      getParameter: () => renderer,
    });
    const probe = buildGpuProbe({ gl, devicePixelRatio: 1 });
    assert.equal(probe.hardwareAcceleration, false, `expected software for ${renderer}`);
  }
});

it("fails closed to nulls without a debug extension", () => {
  const gl = fakeGl({ getExtension: () => null });
  const probe = buildGpuProbe({ gl, devicePixelRatio: 2 });
  assert.equal(probe.vendor, null);
  assert.equal(probe.renderer, null);
  assert.equal(probe.hardwareAcceleration, null);
  assert.equal(probe.windowScaleFactor, 2);
});

it("fails closed to nulls with a null context", () => {
  const probe = buildGpuProbe({ gl: null, devicePixelRatio: 1 });
  assert.deepEqual(probe, {
    vendor: null,
    renderer: null,
    hardwareAcceleration: null,
    windowScaleFactor: 1,
  });
});

it("normalizes a junk devicePixelRatio to null", () => {
  const probe = buildGpuProbe({ gl: null, devicePixelRatio: Number.NaN });
  assert.equal(probe.windowScaleFactor, null);
  const negative = buildGpuProbe({ gl: null, devicePixelRatio: -1 });
  assert.equal(negative.windowScaleFactor, null);
});

it("never reports hardwareAcceleration: false without a software marker", () => {
  // A context that exists but yields an inconclusive renderer is reported as
  // accelerated (true), never as a fabricated "acceleration off".
  const gl = fakeGl({ getParameter: () => "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11)" });
  assert.equal(buildGpuProbe({ gl, devicePixelRatio: 1 }).hardwareAcceleration, true);
});

it("readWebglGpu fails closed in a DOM-less node environment", () => {
  const probe = readWebglGpu();
  assert.deepEqual(probe, {
    vendor: null,
    renderer: null,
    hardwareAcceleration: null,
    windowScaleFactor: null,
  });
});

it("probeWebglGpu caches its result across calls", () => {
  const first = probeWebglGpu();
  const second = probeWebglGpu();
  assert.equal(first, second);
});
