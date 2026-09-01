import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPeerId,
  maskIp,
  maskPeerId,
  redact,
  redactLines,
  redactNamedValue,
  redactStructured,
} from "./redact";

const PEER_64HEX = "9f2ab1c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80";
const PEER_64HEX_SHORT =
  "c0ffee1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const BOOT_TOKEN_HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

test("maskPeerId keeps a 4+4 hint and a gap marker", () => {
  assert.equal(maskPeerId(PEER_64HEX), `peer_9f2a…7f80`);
  assert.equal(maskPeerId("abcd"), "peer_abcd…");
});

test("isPeerId matches exactly the 64-hex shape", () => {
  assert.equal(isPeerId(PEER_64HEX), true);
  assert.equal(isPeerId("1234"), false);
  assert.equal(isPeerId(PEER_64HEX.toUpperCase()), false);
});

test("maskIp fully masks both address families", () => {
  assert.equal(maskIp("1.2.3.4"), "[ip]");
  assert.equal(maskIp("::1"), "[ipv6]");
  assert.equal(maskIp("2001:db8::1"), "[ipv6]");
});

test("redact masks a bare 64-hex peerId with the partial form by default", () => {
  const out = redact(`peer connected ${PEER_64HEX} now`);
  assert.match(out, /peer_9f2a…7f80/);
  assert.ok(!out.includes(PEER_64HEX));
});

test("redact masks the boot token (same 64-hex shape) as a peer", () => {
  const out = redact(`auth token=${BOOT_TOKEN_HEX}`);
  assert.ok(!out.includes(BOOT_TOKEN_HEX));
  assert.match(out, /peer_0001…1e1f/);
});

test("redact keepPartial=false replaces the whole value with [peerId]", () => {
  const out = redact(`peer connected ${PEER_64HEX} now`, { keepPartial: false });
  assert.ok(!out.includes(PEER_64HEX));
  assert.ok(!out.includes("9f2a"));
  assert.match(out, /\[peerId\]/);
});

test("redact masks IPv4 and IPv6 addresses", () => {
  const out = redact("dial 192.168.1.42 and 2001:db8::1 and aa:bb:cc:dd:ee:ff");
  assert.ok(!out.includes("192.168.1.42"));
  assert.ok(!out.includes("2001:db8::1"));
  assert.ok(!out.includes("aa:bb:cc:dd:ee:ff"));
  assert.match(out, /\[ip\]/);
  assert.match(out, /\[ipv6\]/);
});

test("redact masks well-known token prefixes", () => {
  const out = redact("key sk-abcdefghijklmnopqrstuvwxyz01234567 and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U");
  assert.ok(!out.includes("sk-abcdefghijklmnopqrstuvwxyz01234567"));
  assert.ok(!out.includes("eyJhbGciOiJIUzI1NiJ9"));
  assert.match(out, /\[redacted:token\]/);
});

test("redact leaves ordinary prose untouched", () => {
  const msg = "message received from peer, 240 bytes, verified";
  assert.equal(redact(msg), msg);
});

test("redactLines applies the filter per line (multi-line export)", () => {
  const exportText = `line one ${PEER_64HEX}\nline two 10.0.0.5\nfinal`;
  const out = redactLines(exportText);
  assert.ok(!out.includes(PEER_64HEX));
  assert.ok(!out.includes("10.0.0.5"));
  assert.equal(out.split("\n").length, 3);
  assert.ok(out.endsWith("final"));
});

test("redactNamedValue masks secret-bearing keys and peerId-shaped values", () => {
  assert.equal(redactNamedValue("apiKey", "sk-anything"), "[redacted:apiKey]");
  assert.equal(redactNamedValue("masterKey", "hunter2"), "[redacted:masterKey]");
  assert.equal(redactNamedValue("authorization", "Bearer x"), "[redacted:authorization]");
  assert.equal(redactNamedValue("bootToken", "x"), "[redacted:bootToken]");
  assert.match(
    redactNamedValue("peerId", PEER_64HEX) as string,
    /^peer_9f2a…7f80$/,
  );
  assert.equal(
    redactNamedValue("peerId", "not-a-real-peer"),
    "[redacted:peerId]",
  );
});

test("redactNamedValue leaves benign keys untouched", () => {
  assert.equal(redactNamedValue("module", "vault"), "vault");
  assert.equal(redactNamedValue("peerCount", 3), 3);
});

test("redactStructured deep-copies and masks nested secrets, leaving the rest intact", () => {
  const input = {
    module: "vault",
    peerId: PEER_64HEX_SHORT,
    network: {
      remote: {
        apiKey: "sk-super-secret",
        address: "10.0.0.9",
      },
      count: 2,
    },
  };
  const out = redactStructured(input) as Record<string, any>;
  assert.equal(out.module, "vault");
  assert.equal(out.count, undefined);
  assert.match(out.peerId as string, /^peer_c0ff…7890$/);
  assert.equal(out.network.remote.apiKey, "[redacted:apiKey]");
  assert.equal(out.network.remote.address, "10.0.0.9");
  assert.equal(out.network.count, 2);
  // No mutation of the caller's object.
  assert.equal(input.network.remote.apiKey, "sk-super-secret");
  assert.equal(input.peerId, PEER_64HEX_SHORT);
});

test("redactStructured is depth-capped (no stack overflow on hostile nesting)", () => {
  let deep: unknown = "leaf";
  for (let i = 0; i < 40; i++) {
    deep = { nested: deep };
  }
  const out = redactStructured(deep) as Record<string, unknown>;
  let node: unknown = out;
  let sawCap = false;
  for (let i = 0; i < 50; i++) {
    if (node === "[depth-limit]") {
      sawCap = true;
      break;
    }
    if (typeof node === "object" && node !== null) {
      node = (node as Record<string, unknown>).nested;
    } else {
      break;
    }
  }
  assert.equal(sawCap, true);
});
