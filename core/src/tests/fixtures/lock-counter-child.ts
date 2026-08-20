import * as path from "node:path";
import { sharedWriteQueue } from "../../storage/queue";
import { atomicWriteFile, readJsonFile } from "../../storage/atomic-write";

/**
 * Child-process worker for the multi-process lock test.
 *
 * Repeatedly does a read-modify-write on a shared JSON counter file through the
 * *real* storage primitives (shared write queue + atomic write). The delay
 * between the read and the write deliberately widens the race window so two
 * concurrently-running children interleave: without the cross-process lock
 * inside the queue, both would read the same snapshot and drop each other's
 * increments.
 *
 * Usage: node lock-counter-child.js <counterFile> <rounds> <delayMs>
 */
async function main(): Promise<void> {
  const [fileArg, roundsArg, delayArg] = process.argv.slice(2);
  const file = path.resolve(fileArg!);
  const rounds = Number(roundsArg ?? "15");
  const delayMs = Number(delayArg ?? "3");

  for (let i = 0; i < rounds; i++) {
    await sharedWriteQueue.enqueue(file, async () => {
      const current =
        (await readJsonFile<{ count: number }>(file)) ?? { count: 0 };
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      current.count += 1;
      await atomicWriteFile(file, JSON.stringify(current));
    });
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[lock-counter-child]", err);
  process.exit(1);
});
