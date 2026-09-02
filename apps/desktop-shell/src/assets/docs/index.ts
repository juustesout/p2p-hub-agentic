import type { HelpDoc } from "../../components/helpcenter/docs";
import whatIsHelpcenter from "./what-is-helpcenter.md?raw";
import vaultKeyLost from "./vault-key-lost.md?raw";
import noPeersFound from "./no-peers-found.md?raw";
import networkOffline from "./network-offline.md?raw";
import safeMode from "./safe-mode.md?raw";
import makeBundle from "./make-bundle.md?raw";
import readingLogs from "./reading-logs.md?raw";

/**
 * The offline documentation corpus (Pijler E). Markdown files bundled into the
 * app at build time — no network requests, ever. This module is the ONLY place
 * `.md?raw` imports live; the pure parser/search in
 * `components/helpcenter/docs.ts` is what the tests exercise.
 *
 * Metadata (title/summary/keywords) drives the docs tab list + search ranking;
 * the raw markdown is parsed at render time. Keep summaries one short sentence
 * (Dutch, same tone as the UI).
 */
export const HELP_DOCS: HelpDoc[] = [
  {
    id: "what-is-helpcenter",
    title: "Wat is het HelpCenter?",
    category: "aan-de-slag",
    summary: "Eén plek om problemen te bekijken en veilig te delen.",
    keywords: ["helpcenter", "diagnose", "uitleg", "wat", "waarvoor"],
    markdown: whatIsHelpcenter,
  },
  {
    id: "make-bundle",
    title: "Een diagnose-bundel maken en delen",
    category: "aan-de-slag",
    summary: "Stap voor stap een bundel maken om naar de helpdesk te sturen.",
    keywords: ["bundel", "diagnose", "delen", "kopiëren", "opslaan", "helpdesk"],
    markdown: makeBundle,
  },
  {
    id: "reading-logs",
    title: "Logs lezen: wat betekent dit?",
    category: "aan-de-slag",
    summary: "De veilige logweergave, niveaus en de ongeredacteerde waarschuwing.",
    keywords: ["logs", "logboek", "niveau", "lezen", "ongeredacteerd", "fout"],
    markdown: readingLogs,
  },
  {
    id: "vault-key-lost",
    title: "App vraagt om een sleutel",
    category: "herstel",
    summary: "Waarom de vault om de master-sleutel vraagt en wat je moet doen.",
    keywords: ["sleutel", "vault", "vergrendeld", "wachtwoord", "master"],
    markdown: vaultKeyLost,
  },
  {
    id: "no-peers-found",
    title: "Er zijn geen peers (verbindingen) gevonden",
    category: "herstel",
    summary: "Waarom er niemand zichtbaar is en wat je kunt controleren.",
    keywords: ["peers", "verbinding", "netwerk", "offline", "vrienden"],
    markdown: noPeersFound,
  },
  {
    id: "network-offline",
    title: "Het netwerk is uit",
    category: "herstel",
    summary: "Netwerk gepauzeerd of offline: oorzaken en wat je moet doen.",
    keywords: ["netwerk", "pauze", "offline", "uit", "verbinding"],
    markdown: networkOffline,
  },
  {
    id: "safe-mode",
    title: "De app start niet (of tekent niet)",
    category: "herstel",
    summary: "De veilige modus gebruiken om een vastgelopen app te herstellen.",
    keywords: ["start", "veilige modus", "safemode", "herstel", "leeg", "hangt"],
    markdown: safeMode,
  },
];
