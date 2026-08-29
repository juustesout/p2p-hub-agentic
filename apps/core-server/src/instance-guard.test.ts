import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { CoreServer } from "./app";
import {
  INSTANCE_LOCK_FILE,
  InstanceLockError,
  acquireInstanceLock,
} from "./instance-guard";

async function tmpDataDir(prefix: string): Promise<string> {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Spawn a short-lived child and resolve once it has exited (guaranteed-dead pid). */
function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    child.once("error", reject);
    child.once("exit", () => {
      if (typeof child.pid === "number") {
        resolve(child.pid);
      } else {
        reject(new Error("child exited without a pid"));
      }
    });
  });
}

// POSIX permission bits are not meaningful on Windows (the mode maps to NTFS
// ACLs / a readonly attribute, so fs.statSync().mode & 0o777 comes back as
// 0o666 for a fresh write). The PID content and path assertions still run on
// every platform; only the 0600 bit check is gated.
const WIN_MODE_SKIP =
  process.platform === "win32" &&
  "POSIX 0600 mode bits are not meaningful on Windows (NTFS ACLs); PID/path content is still asserted";

test("acquire creates a 0600 pid file holding our PID", async (t) => {
  const dataDir = await tmpDataDir("instance-guard-");
  const lock = acquireInstanceLock(dataDir);
  try {
    const file = path.join(dataDir, INSTANCE_LOCK_FILE);
    assert.equal(lock.file, file);
    assert.equal(fs.readFileSync(file, "utf8").trim(), String(process.pid));
    await t.test(
      "lock file is owner-only (POSIX 0600)",
      { skip: WIN_MODE_SKIP },
      () => {
        const mode = fs.statSync(file).mode & 0o777;
        assert.equal(mode, 0o600, "lock file must be owner-only");
      },
    );
  } finally {
    lock.release();
  }
});

test("a second acquire on the same data dir fails hard (in-process)", async () => {
  const dataDir = await tmpDataDir("instance-guard-");
  const first = acquireInstanceLock(dataDir);
  try {
    assert.throws(
      () => acquireInstanceLock(dataDir),
      (err) =>
        err instanceof InstanceLockError &&
        /already runs a core-server instance/.test(err.message),
    );
  } finally {
    first.release();
  }
});

test("release removes the lock so the dir can be re-acquired", async () => {
  const dataDir = await tmpDataDir("instance-guard-");
  const first = acquireInstanceLock(dataDir);
  first.release();
  assert.equal(fs.existsSync(path.join(dataDir, INSTANCE_LOCK_FILE)), false);
  const second = acquireInstanceLock(dataDir);
  try {
    assert.ok(second.file, "re-acquire must succeed after release");
  } finally {
    second.release();
  }
});

test("a live foreign PID in the lock file refuses the boot", async () => {
  const dataDir = await tmpDataDir("instance-guard-");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
  try {
    await new Promise((resolve) => child.once("spawn", resolve));
    fs.writeFileSync(path.join(dataDir, INSTANCE_LOCK_FILE), `${child.pid}\n`);
    assert.throws(
      () => acquireInstanceLock(dataDir),
      (err) =>
        err instanceof InstanceLockError &&
        /another core-server instance is already running/.test(err.message) &&
        err.message.includes(String(child.pid)),
    );
  } finally {
    child.kill("SIGKILL");
  }
});

test("a stale (dead) foreign PID is overwritten, not refused", async () => {
  const dataDir = await tmpDataDir("instance-guard-");
  const gone = await deadPid();
  fs.writeFileSync(path.join(dataDir, INSTANCE_LOCK_FILE), `${gone}\n`);
  const lock = acquireInstanceLock(dataDir);
  try {
    assert.equal(
      fs.readFileSync(path.join(dataDir, INSTANCE_LOCK_FILE), "utf8").trim(),
      String(process.pid),
      "stale pid must be replaced by ours",
    );
  } finally {
    lock.release();
  }
});

test("a corrupt or unparseable lock file is refused loudly", async () => {
  for (const corrupt of ["", "abc", "1.5", "0", "-3", "99999999999999999999"]) {
    const dataDir = await tmpDataDir("instance-guard-");
    fs.writeFileSync(path.join(dataDir, INSTANCE_LOCK_FILE), `${corrupt}\n`);
    assert.throws(
      () => acquireInstanceLock(dataDir),
      (err) =>
        err instanceof InstanceLockError &&
        /corrupt|Cannot determine whether another instance/.test(err.message),
      `corrupt contents ${JSON.stringify(corrupt)} must be refused`,
    );
  }
});

// ---------------------------------------------------------------------------
// CoreServer-level: instance 2 on the same dataDir fails hard at start().
// ---------------------------------------------------------------------------

async function bootLocalOnly(dataDir: string): Promise<CoreServer> {
  await fsPromises.mkdir(path.join(dataDir, "plugins"), { recursive: true });
  const server = new CoreServer({
    pluginsDir: path.join(dataDir, "plugins"),
    dataDir,
    host: "127.0.0.1",
    port: 0,
    bootToken: "instance-guard-token",
    networking: false,
  });
  await server.start();
  return server;
}

test("a second CoreServer on the same dataDir fails hard at start()", async () => {
  const dataDir = await tmpDataDir("core-server-instance-");
  const first = await bootLocalOnly(dataDir);
  try {
    // Instance 2: same data dir, same process → the guard refuses the boot
    // before anything touches shared storage (fail-hard, never a silent race).
    await assert.rejects(() => bootLocalOnly(dataDir), /already runs a core-server/);
    // The first instance is untouched by the failed second boot.
    assert.ok(first.address(), "first instance keeps serving");
  } finally {
    await first.stop();
  }
});

test("after a clean stop the same dataDir can be reused", async () => {
  const dataDir = await tmpDataDir("core-server-instance-");
  const first = await bootLocalOnly(dataDir);
  await first.stop();
  assert.equal(
    fs.existsSync(path.join(dataDir, INSTANCE_LOCK_FILE)),
    false,
    "stop() must release the instance lock",
  );
  const second = await bootLocalOnly(dataDir);
  await second.stop();
});

test("a failed boot releases the instance lock", async () => {
  const dataDir = await tmpDataDir("core-server-instance-");
  await fsPromises.mkdir(path.join(dataDir, "plugins"), { recursive: true });
  await fsPromises.writeFile(path.join(dataDir, "vault.json"), "{ nope }");

  const failing = new CoreServer({
    pluginsDir: path.join(dataDir, "plugins"),
    dataDir,
    host: "127.0.0.1",
    port: 0,
    networking: true,
  });
  await assert.rejects(
    () => failing.start(),
    /StorageCorruptionError|cannot be parsed|corrupt/i,
  );

  assert.equal(
    fs.existsSync(path.join(dataDir, INSTANCE_LOCK_FILE)),
    false,
    "a failed boot must not leave a stale instance lock behind",
  );

  // And the dir is reusable afterwards.
  const ok = await bootLocalOnly(dataDir);
  await ok.stop();
});
