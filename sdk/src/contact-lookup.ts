/**
 * The narrow, in-process contract a plugin (or the host) exposes so that the
 * P2P PeerSite capability can answer one question: "is this `peerId` a trusted
 * contact, and in what state?".
 *
 * This lives in the SDK — not in core, and not in the contacts plugin — so
 * that core stays type-ignorant of contacts: it only ever sees this tiny
 * shape, never the plugin's `ContactsPlugin`/`ContactRecord` types. The
 * contacts plugin's `activate()` return *implements* this shape (an extra
 * `getContact` field next to its skills), and the host reads it through
 * `host.getActivated("contacts")` guarded by {@link asContactLookup}.
 *
 * This is the *only* authorized read-seam for trust state — the same pattern
 * as `CoreAIProvider` being the only reader of raw vault secrets. No caller
 * reaches into contacts' storage directly; storage isolation is preserved.
 */

/**
 * Trust state of a stored contact. `pending` = added but not yet proven to
 * hold the private key behind its peerId; `verified` = passed a
 * challenge-response proof of possession; `blocked` = explicitly denied.
 */
export type ContactTrustState = "pending" | "verified" | "blocked";

/** Minimal result of a contact trust lookup. `publicKeyHex` is omitted because
 * it is always identical to `peerId` in the identity layer (enforced by the
 * contacts plugin on add). */
export interface ContactTrustInfo {
  trustState: ContactTrustState;
}

/**
 * A capability an activated plugin (or host component) may implement to answer
 * trust queries. Implemented in-process by the contacts plugin; never a skill,
 * never network-exposed.
 */
export interface ContactLookup {
  getContact(peerId: string): Promise<ContactTrustInfo | null>;
}

/**
 * Runtime duck-type guard: return `value` as a {@link ContactLookup} only when
 * it actually has a `getContact` *function*, otherwise `null`. This is the
 * safe way to read `host.getActivated("contacts")` — a `typeof` check, never a
 * blind `as` cast. A plugin that does not (or no longer) implement the seam is
 * silently treated as "no trust lookup available" (fail-closed), not trusted.
 */
export function asContactLookup(value: unknown): ContactLookup | null {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { getContact?: unknown }).getContact === "function"
  ) {
    return value as ContactLookup;
  }
  return null;
}
