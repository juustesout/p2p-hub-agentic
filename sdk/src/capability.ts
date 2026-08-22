/**
 * The platform-level discriminator for what kind of work a capability does
 * (plan.md "Besluit 3" / design doc "Decision 3").
 *
 * - `"action"` — a discrete, possibly side-effect-ful operation (write, mutate,
 *   produce, request approval). Default, and the fail-closed choice: a
 *   capability that does not declare a type is treated as an action.
 * - `"telemetry"` — a read-only, side-effect-free stream/sample (status, ping,
 *   metrics). Telemetry capabilities are rate-limited per peer by the
 *   `TaskBroker` so a peer cannot flood the host, and they are never exempted
 *   from the normal remote gates.
 */
export type CapabilityType = "action" | "telemetry";

/**
 * Fail-closed default: an undeclared capability type is an `"action"`.
 * Declaring telemetry must always be explicit.
 */
export const DEFAULT_CAPABILITY_TYPE: CapabilityType = "action";

/**
 * Strict runtime guard. A value that is not exactly `"action"` or
 * `"telemetry"` is treated as the fail-closed default (`"action"`), so a
 * typo'd or maliciously-typed value from a plugin can never silently widen
 * a capability's treatment.
 */
export function isCapabilityType(value: unknown): value is CapabilityType {
  return value === "action" || value === "telemetry";
}
