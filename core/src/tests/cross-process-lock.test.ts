import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fork } from "node:child_process";
import {
  withFileLock,
  lockPathFor,
  StorageLockTimeoutError,
} from "../storage/file-lock";
import { atomicWriteFile, readJsonFile } from "../storage/atomic-write";
import { VaultManager } from "../storage/vault-manager";

async function makeTmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertLockGone(target: string): Promise<void> {
  await assert.rejects(fs.stat(lockPathFor(target)), (err) => {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  });
}

function runChild(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = fork(script, args, {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `child ${path.basename(script)} exited with code ${code ?? `signal ${signal}`}`,
          ),
        );
      }
    });
  });
}

test("withFileLock serializes read-modify-write so no update is lost", async () => {
  const dir = await makeTmpDir("xproc-lock-");
  const file = path.join(dir, "counter.json");

  await Promise.all([
    withFileLock(file, async () => {
      const current =
        (await readJsonFile<{ count: number }>(file)) ?? { count: 0 };
      await delay(20); // widen the interleaving window
      current.count += 1;
      await atomicWriteFile(file, JSON.stringify(current));
    }),
    withFileLock(file, async () => {
      const current =
        (await readJsonFile<{ count: number }>(file)) ?? { count: 0 };
      await delay(1);
      current.count += 1;
      await atomicWriteFile(file, JSON.stringify(current));
    }),
  ]);

  const final = await readJsonFile<{ count: number }>(file);
  assert.equal(final?.count, 2, "both increments must survive");
  await assertLockGone(file);
});

test("withFileLock is reentrant within the same process", async () => {
  const dir = await makeTmpDir("xproc-lock-");
  const file = path.join(dir, "data.json");
  let innerRan = false;

  await withFileLock(file, async () => {
    await withFileLock(file, async () => {
      innerRan = true;
    });
  });

  assert.equal(innerRan, true, "nested acquisition must run its task");
  await assertLockGone(file);
});

test("a live lock is not stolen; waiters time out loudly", async () => {
  const dir = await makeTmpDir("xproc-lock-");
  const file = path.join(dir, "data.json");
  await fs.writeFile(
    lockPathFor(file),
    JSON.stringify({
      pid: process.pid,
      host: os.hostname(),
      createdAt: Date.now(),
    }),
  );

  let ran = false;
  await assert.rejects(
    () =>
      withFileLock(
        file,
        async () => {
          ran = true;
        },
        { lockTimeoutMs: 150, retryIntervalMs: 20 },
      ),
    StorageLockTimeoutError,
  );
  assert.equal(ran, false, "task must not run while the lock is held");
  await fs.unlink(lockPathFor(file));
});

test("a stale lock from a dead process is stolen", async () => {
  const dir = await makeTmpDir("xproc-lock-");
  const file = path.join(dir, "data.json");
  await fs.writeFile(
    lockPathFor(file),
    JSON.stringify({
      pid: 2147483647, // a pid no live process can own
      host: "dead-host",
      createdAt: Date.now() - 60_000,
    }),
  );

  await withFileLock(file, async () => {
    await atomicWriteFile(file, "recovered");
  });

  assert.equal(await fs.readFile(file, "utf8"), "recovered");
  await assertLockGone(file);
});

test("two processes writing the same file do not lose updates", async () => {
  const dir = await makeTmpDir("xproc-multi-");
  const file = path.join(dir, "counter.json");
  await atomicWriteFile(file, JSON.stringify({ count: 0 }));

  const rounds = 20;
  const child = path.join(__dirname, "fixtures", "lock-counter-child.js");
  await Promise.all([
    runChild(child, [file, String(rounds), "3"]),
    runChild(child, [file, String(rounds), "3"]),
  ]);

  const final = await readJsonFile<{ count: number }>(file);
  assert.equal(final?.count, 2 * rounds, "no increment may be lost across processes");
  await assertLockGone(file);
});

test("two processes writing secrets to the same vault keep every key", async () => {
  const dir = await makeTmpDir("xproc-vault-");
  const masterKey = "xproc-master";
  const keysPerChild = 15;
  const child = path.join(__dirname, "fixtures", "vault-writer-child.js");

  await Promise.all([
    runChild(child, [dir, masterKey, "alpha", String(keysPerChild)]),
    runChild(child, [dir, masterKey, "beta", String(keysPerChild)]),
  ]);

  const vault = new VaultManager({ dataDir: dir, masterKey });
  const keys = await vault.listSecretKeys();
  assert.equal(keys.length, 2 * keysPerChild, "every key from both processes must survive");
  for (const prefix of ["alpha", "beta"]) {
    for (let i = 0; i < keysPerChild; i++) {
      assert.equal(
        await vault.getSecret(`${prefix}-${i}`),
        `value-${prefix}-${i}`,
      );
    }
  }
  await assertLockGone(path.join(dir, "vault.json"));
});
