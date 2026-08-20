import { VaultManager } from "../../storage/vault-manager";

/**
 * Child-process worker for the multi-process vault test.
 *
 * Each child writes its own set of secrets to the shared vault file. Two such
 * children racing each other are exactly the CLAUDE.md failure scenario: both
 * would load the same vault snapshot, encrypt their own key into it, and the
 * last rename would silently drop the other child's keys. The cross-process
 * lock in the shared write queue must keep every key from both children.
 *
 * Usage: node vault-writer-child.js <dataDir> <masterKey> <prefix> <count>
 */
async function main(): Promise<void> {
  const [dataDir, masterKey, prefix, countArg] = process.argv.slice(2);
  const vault = new VaultManager({ dataDir, masterKey });
  const count = Number(countArg ?? "15");

  for (let i = 0; i < count; i++) {
    await vault.setSecret(`${prefix}-${i}`, `value-${prefix}-${i}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[vault-writer-child]", err);
  process.exit(1);
});
