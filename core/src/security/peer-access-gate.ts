/**
 * Stap 2 (checkPeerAccess-generalisatie) — uniforme, fail-closed peer-access
 * primitive.
 *
 * PeerSite had een geïsoleerde verified-contact/access-pass-controle in de
 * plugin (zie `plugins/peersite/src/index.ts`). Deze gate generaliseert dat
 * patroon naar één centrale, herbruikbare primitive die elke peer-facing
 * capability (PeerSite, media:v1, toekomstige world:v1-capabilities) gebruikt
 * om één vraag te beantwoorden: "mag deze binnenkomende `peerId` deze
 * capability aanroepen?".
 *
 * Beveiligings-invarianten (CLAUDE.md):
 *   - **Deny-by-default.** Ontbrekende/ongeldige `options`, een lege
 *     `modes`-lijst, een niet-bewezen configuratie (access-pass zonder scope
 *     of zonder pass-capability, verified-contact zonder contact-capability)
 *     en een lege/afwezige `peerId` sluiten de gate — nooit een open deur
 *     voor een niet-bewezen situatie.
 *   - **Access passes zijn GEEN bearer tokens.** De `access-pass`-mode checkt
 *     een peerId-gebonden, gescoped pass via de geïnjecteerde
 *     `accessPasses`-capability — nooit een caller-supplied token. Het
 *     oorspronkelijke ontwerp-voorstel met een `accessPassToken`/
 *     `verifyPass(token, peerId)` is bewust niet overgenomen: dat introduceert
 *     een bearer-achtige capability, en CLAUDE.md schrijft voor dat passes
 *     "never bearer tokens" zijn (de peer bewijst possession over het
 *     transport op elke call).
 *   - **OR-semantiek, geen enkelvoudige mode.** De `modes`-lijst wordt als OR
 *     geëvalueerd (zelfde semantiek als `RemoteGateSpec` in de broker): een
 *     capability als `fetchAsset` wil "verified-contact ÓF geldige pass". De
 *     specifieke denial-reason van de eerst-geëvalueerde wél-bewezen gate
 *     wordt gerapporteerd wanneer geen enkele mode granted.
 *   - **De primitive vertrouwt de context niet meer dan nodig.** Contacts- en
 *     access-pass-lookups worden door de host geïnjecteerd; een werpende
 *     lookup is een denial (nooit een open deur) — dezelfde regel als
 *     `TaskBroker.evaluateGates`.
 *   - **Een lege `peerId` passeert geen enkele mode:** een transport-verified
 *     identiteit (die alleen de Fase 1B identity binding kan leveren) is de
 *     basis van elke grant.
 *   - **`open-lan`/`public` kennen alleen transport-verified peers**, en een
 *     geblokkeerd contact wordt ook onder deze modi geweigerd wanneer de
 *     context dat kan zeggen (peer-blacklist = `blocked`-truststate in
 *     contacts).
 */

export type PeerAccessMode =
  | "verified-contact"
  | "access-pass"
  | "open-lan"
  | "public";

export interface PeerAccessOptions {
  /**
   * Gate(s) die een binnenkomende peer moet passeren, geëvalueerd als OR.
   * Leeg of afwezig = deny (fail-closed). `"open-lan"` en `"public"` zijn
   * permissief (elke transport-verified peer) maar blijven "mits niet
   * geblokkeerd" — ze worden vandaag identiek geëvalueerd en onderscheiden
   * zich alleen semantisch voor de rapportage.
   */
  modes: PeerAccessMode[];
  /**
   * Vereist wanneer `"access-pass"` in `modes` zit: de scope die de pass van
   * de peer moet dekken (bv. `"site-read-only"`). Een pass is gescoped — één
   * pass tilt nooit de gate van een gerelateerde capability.
   */
  accessPassScope?: string;
  /**
   * Wanneer waar: de host's eigen peerId (`context.selfPeerId`) passeert altijd.
   * Default `false`. De `selfPeerId` komt uit de geïnjecteerde context (de
   * operator's eigen identiteit), nooit van de caller.
   */
  allowSelf?: boolean;
}

export type PeerAccessDecision =
  | {
      granted: true;
      reason: "verified_contact" | "valid_access_pass" | "public_policy" | "self";
    }
  | {
      granted: false;
      reason:
        | "not_a_contact"
        | "invalid_access_pass"
        | "expired_access_pass"
        | "denied_by_policy";
    };

/** Contact-capability die een host injecteert. Beide lookups mogen nooit werpen. */
export interface PeerAccessContacts {
  isVerifiedContact(peerId: string): Promise<boolean> | boolean;
  /** Optioneel: alleen geraadpleegd onder `open-lan`/`public` om een geblokkeerd contact te weren. */
  isBlockedContact?(peerId: string): Promise<boolean> | boolean;
}

/** Access-pass-capability die een host injecteert. Nooit een token-check. */
export interface PeerAccessPasses {
  hasValidPass(peerId: string, scope: string): Promise<boolean> | boolean;
  /**
   * Optioneel: onderscheidt "nooit een pass gehad" van "pass verlopen" voor
   * een eerlijke `expired_access_pass`-reason. Wanneer afwezig valt de
   * primitive terug op `hasValidPass` (verlopen ⇒ `invalid_access_pass`).
   */
  inspectPass?(
    peerId: string,
    scope: string,
  ): Promise<"none" | "valid" | "expired"> | "none" | "valid" | "expired";
}

export interface PeerAccessContext {
  contacts?: PeerAccessContacts;
  accessPasses?: PeerAccessPasses;
  /** De host's eigen peerId — alleen geraadpleegd wanneer `allowSelf` waar is. */
  selfPeerId?: string;
}

const VALID_MODES = new Set<PeerAccessMode>([
  "verified-contact",
  "access-pass",
  "open-lan",
  "public",
]);

/**
 * Evalueer of een binnenkomende `peerId` de gevraagde toegang krijgt. Nooit
 * werpend; elke foutieve configuratie of werpende lookup is een denial.
 */
export async function checkPeerAccess(
  peerId: string,
  options: PeerAccessOptions | undefined,
  context: PeerAccessContext | undefined,
): Promise<PeerAccessDecision> {
  if (
    typeof peerId !== "string" ||
    peerId.length === 0 ||
    typeof options !== "object" ||
    options === null ||
    !Array.isArray(options.modes) ||
    options.modes.length === 0 ||
    !options.modes.every((mode) => VALID_MODES.has(mode))
  ) {
    return { granted: false, reason: "denied_by_policy" };
  }

  if (options.allowSelf === true) {
    const self = context?.selfPeerId;
    if (typeof self === "string" && self.length > 0 && self === peerId) {
      return { granted: true, reason: "self" };
    }
  }

  const ctx: PeerAccessContext = context ?? {};
  let peerSpecificDenial: PeerAccessDecision | null = null;

  for (const mode of options.modes) {
    switch (mode) {
      case "verified-contact": {
        if (!ctx.contacts) {
          break; // kan niets bewijzen ⇒ config-falen, geen peer-specifieke reason
        }
        const ok = await evaluateBool(() => ctx.contacts!.isVerifiedContact(peerId));
        if (ok) {
          return { granted: true, reason: "verified_contact" };
        }
        peerSpecificDenial ??= { granted: false, reason: "not_a_contact" };
        break;
      }
      case "access-pass": {
        const scope = options.accessPassScope;
        if (!ctx.accessPasses || typeof scope !== "string" || scope.length === 0) {
          break; // niet-bewezen configuratie ⇒ denied_by_policy onderaan
        }
        const decision = await evaluatePass(ctx.accessPasses, peerId, scope);
        if (decision.granted) {
          return decision;
        }
        peerSpecificDenial ??= decision;
        break;
      }
      case "open-lan":
      case "public": {
        if (ctx.contacts?.isBlockedContact) {
          const blocked = await evaluateBool(() =>
            ctx.contacts!.isBlockedContact!(peerId),
          );
          if (blocked) {
            // Deny-list wint: een geblokkeerd contact krijgt ook publieke modi niet.
            return { granted: false, reason: "denied_by_policy" };
          }
        }
        return { granted: true, reason: "public_policy" };
      }
    }
  }

  return peerSpecificDenial ?? { granted: false, reason: "denied_by_policy" };
}

async function evaluatePass(
  passes: PeerAccessPasses,
  peerId: string,
  scope: string,
): Promise<PeerAccessDecision> {
  if (typeof passes.inspectPass === "function") {
    let state: "none" | "valid" | "expired";
    try {
      state = await passes.inspectPass(peerId, scope);
    } catch {
      state = "none";
    }
    if (state === "valid") {
      return { granted: true, reason: "valid_access_pass" };
    }
    return state === "expired"
      ? { granted: false, reason: "expired_access_pass" }
      : { granted: false, reason: "invalid_access_pass" };
  }
  const ok = await evaluateBool(() => passes.hasValidPass(peerId, scope));
  return ok
    ? { granted: true, reason: "valid_access_pass" }
    : { granted: false, reason: "invalid_access_pass" };
}

/** Een werpende lookup is een denial — nooit een open deur. */
async function evaluateBool(
  check: () => Promise<boolean> | boolean,
): Promise<boolean> {
  try {
    return await check();
  } catch {
    return false;
  }
}
