/**
 * Offline HelpCenter documentation toolkit (Pijler E — shared corpus).
 *
 * This module is the single source of truth for the HelpCenter knowledge base:
 * the desktop-shell's Documentatie tab and the core-server help-agent both
 * consume {@link HELP_CENTER_DOCS} and the pure parser/search functions from
 * here, so there is exactly one corpus and one ranking implementation. It is
 * deliberately free of Node built-ins and DOM access so it runs unchanged in
 * the browser (Vite consumes the SDK from TypeScript source) and in Node
 * (core-server consumes the compiled dist).
 *
 * The renderer is a deliberately small, safe subset of markdown: headings,
 * paragraphs, bullet/numbered lists and fenced code blocks. Inline emphasis
 * (`*`, `**`, `` ` ``) and links are stripped to plain text for search, and the
 * React layer renders the small set of allowed spans — no raw HTML is ever
 * emitted, so an accidental HTML-looking string in a doc can never become a
 * live element.
 */

export interface HelpDoc {
  id: string;
  title: string;
  /** Canonical list of doc ids → group label, see DOC_CATEGORIES. */
  category: "aan-de-slag" | "herstel";
  summary: string;
  keywords: string[];
  /** Full markdown body (already includes the title as a `#` heading). */
  markdown: string;
}

export const DOC_CATEGORIES: Array<{ id: HelpDoc["category"]; label: string }> = [
  { id: "aan-de-slag", label: "Aan de slag" },
  { id: "herstel", label: "Problemen oplossen" },
];

// ---------------------------------------------------------------------------
// Markdown parsing
// ---------------------------------------------------------------------------

export type DocBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; text: string };

const FENCE_RE = /^```/;

/**
 * Parse the small markdown subset into blocks. Blank lines separate blocks;
 * consecutive `- `/`1. ` lines group into a list; fenced code runs verbatim
 * (no inline interpretation). Everything else becomes a paragraph. Pure and
 * safe: it never interprets HTML and never evaluates anything.
 */
export function parseMarkdown(markdown: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code: copy until the closing fence (or EOF).
    if (FENCE_RE.test(line.trim())) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i].trim())) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // skip the closing fence
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      i += 1;
      continue;
    }

    // Lists: bullet `-` or numbered `1.` — grouped until a blank/non-item line.
    if (/^\s*(-|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*(-|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*(-|\d+\.)\s+/, "").trim());
        i += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // Paragraph: accumulate until a blank line or another structural line.
    if (line.trim() !== "") {
      const paragraph: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !/^(#{1,3})\s+/.test(lines[i]) &&
        !FENCE_RE.test(lines[i].trim())
      ) {
        paragraph.push(lines[i].trim());
        i += 1;
      }
      blocks.push({ type: "paragraph", text: paragraph.join(" ") });
      continue;
    }

    i += 1;
  }
  return blocks;
}

/** The plain text of a doc: heading text + paragraph/list/code content. */
export function docPlainText(markdown: string): string {
  const parts: string[] = [];
  for (const block of parseMarkdown(markdown)) {
    switch (block.type) {
      case "heading":
        parts.push(block.text);
        break;
      case "paragraph":
        parts.push(block.text);
        break;
      case "list":
        parts.push(...block.items);
        break;
      case "code":
        parts.push(block.text);
        break;
    }
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface DocSearchHit {
  doc: HelpDoc;
  score: number;
}

/** Tokenize plain text into lowercase words (3+ chars), deduped. */
function tokens(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9\u00e0-\u00ff]+/)) {
    const word = raw.trim();
    if (word.length >= 3 && !seen.has(word)) {
      seen.add(word);
      out.push(word);
    }
  }
  return out;
}

/** True when every whitespace-split query term appears in the haystack text. */
export function queryMatches(text: string, query: string): boolean {
  const lower = text.toLowerCase();
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => lower.includes(term));
}

/**
 * Rank docs by relevance to a free-text query. Score is the number of query
 * words found in (keywords/title/summary/body), weighted so a title or keyword
 * hit outweighs a body hit. Docs with zero matched terms are excluded unless
 * the query is empty (then everything scores 0 and is returned in doc order).
 * Pure and deterministic.
 */
export function searchDocs(docs: HelpDoc[], query: string): DocSearchHit[] {
  const q = query.trim();
  if (!q) {
    return docs.map((doc) => ({ doc, score: 0 }));
  }
  const queryWords = tokens(q);
  if (queryWords.length === 0) {
    return docs.map((doc) => ({ doc, score: 0 }));
  }
  const scored = docs.map((doc) => {
    const keywordText = `${doc.keywords.join(" ")} ${doc.title}`.toLowerCase();
    const bodyText = docPlainText(doc.markdown).toLowerCase();
    const summaryText = doc.summary.toLowerCase();
    let score = 0;
    let matched = 0;
    for (const word of queryWords) {
      const inKeyword = keywordText.includes(word);
      const inTitle = doc.title.toLowerCase().includes(word);
      const inSummary = summaryText.includes(word);
      const inBody = bodyText.includes(word);
      if (inKeyword || inTitle || inSummary || inBody) {
        matched += 1;
      }
      if (inTitle) {
        score += 4;
      }
      if (inKeyword) {
        score += 3;
      }
      if (inSummary) {
        score += 2;
      }
      if (inBody) {
        score += 1;
      }
    }
    if (matched === 0) {
      return null;
    }
    // A doc matching more distinct query words ranks higher.
    score *= matched;
    return { doc, score };
  });
  return scored
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id));
}

/** Group docs into category buckets in DOC_CATEGORIES order. */
export function groupDocs(
  docs: HelpDoc[],
): Array<{ id: HelpDoc["category"]; label: string; docs: HelpDoc[] }> {
  return DOC_CATEGORIES.map((cat) => ({
    ...cat,
    docs: docs.filter((d) => d.category === cat.id),
  })).filter((group) => group.docs.length > 0);
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/**
 * The offline documentation corpus. Metadata (title/summary/keywords) drives
 * the docs tab list + search ranking; the raw markdown is parsed at render
 * time. Keep summaries one short sentence (Dutch, same tone as the UI). The
 * markdown bodies are verbatim copies of the original `.md` assets, now kept
 * here so the help-agent reasons over exactly the same text a user reads.
 */
export const HELP_CENTER_DOCS: HelpDoc[] = [
  {
    id: "what-is-helpcenter",
    title: "Wat is het HelpCenter?",
    category: "aan-de-slag",
    summary: "Eén plek om problemen te bekijken en veilig te delen.",
    keywords: ["helpcenter", "diagnose", "uitleg", "wat", "waarvoor"],
    markdown: `# Wat is het HelpCenter?

Het HelpCenter is de enige plek waar je problemen met de app kunt **zien** en
**delen** zonder dat je iets aan iemand hoeft uit te leggen. Het bestaat uit
drie tabbladen:

- **Diagnose** — maakt in één klik een overzicht van je systeem, de app-versie,
  het netwerk en de vault. Daarmee maak je een **diagnostische bundel**: één
  tekstblok dat je kunt kopiëren of opslaan en naar de helpdesk kunt sturen.
- **Logs** — de laatste regels die de app zelf bijhoudt over wat er gebeurt.
  Standaard zie je alleen de veilige, afgeschermde weergave.
- **Documentatie** — deze kennisbank, die ook zonder internet werkt.

## Wanneer gebruik ik het?

Open het HelpCenter via de **help-knop** in de taakbalk of via de knop "Toon
details" op een foutmelding. Wordt er iets niet wat je verwacht? Maak dan eerst
een bundel voordat je hulp vraagt.

## Wat zit er nooit in een bundel?

Jouw geheimen blijven op jouw apparaat: de bundel bevat **geen**
master-sleutel, geen app-token en geen onherkenbare peer-IDs. Alles wat je
deelt is van tevoren afgeschermd en je ziet altijd eerst een voorbeeld van wat
er precies wordt gedeeld.`,
  },
  {
    id: "make-bundle",
    title: "Een diagnose-bundel maken en delen",
    category: "aan-de-slag",
    summary: "Stap voor stap een bundel maken om naar de helpdesk te sturen.",
    keywords: ["bundel", "diagnose", "delen", "kopiëren", "opslaan", "helpdesk"],
    markdown: `# Een diagnose-bundel maken en delen

Een **diagnose-bundel** is één tekstblok met alles wat de helpdesk nodig heeft
om jouw probleem te begrijpen: een momentopname van jouw systeem en app, plus
de gekozen logboeken. Je maakt hem in het tabblad **Diagnose**.

## Hoe maak ik een bundel?

1. Klik op **"Maak bundel"**.
2. Kies welke onderdelen je wilt meesturen:
   - **Momentopname** — systeem, hardware, netwerk, vault-status, geïnstalleerde
     onderdelen. Meestal wil je alles aan laten.
   - **Logboeken** — vink de logboeken aan die relevant zijn voor jouw probleem
     (bijvoorbeeld "Netwerk" of "Vault").
3. Typ eventueel een korte beschrijving van het probleem.
4. Klik op **"Genereer bundel"**.

## Wat gebeurt er daarna?

Je ziet eerst een **voorbeeld** van de bundel, precies zoals die eruitziet.
Daarna kun je:

- **Kopiëren** — plak de bundel in een e-mail of chatbericht.
- **Opslaan** — bewaar de bundel als bestand op je apparaat.

De bundel wordt **niet** automatisch verstuurd. Er gaat niets van je apparaat
af zonder dat jij het doet.

## Wat zit er in een bundel? (en wat niet)

Alles in de bundel is van tevoren **afgeschermd**: peer-IDs en adressen worden
gemaskeerd, geheimen worden nooit meegestuurd. Je ziet altijd eerst het
voorbeeld, dus je kunt controleren wat er precies wordt gedeeld.

## Tip

Voeg altijd een korte beschrijving toe ("scherm blijft zwart na het
opstarten"). De helpdesk kan dan gerichter kijken.`,
  },
  {
    id: "reading-logs",
    title: "Logs lezen: wat betekent dit?",
    category: "aan-de-slag",
    summary: "De veilige logweergave, niveaus en de ongeredacteerde waarschuwing.",
    keywords: ["logs", "logboek", "niveau", "lezen", "ongeredacteerd", "fout"],
    markdown: `# Logs lezen: wat betekent dit?

Het tabblad **Logs** laat zien wat de app op de achtergrond doet. Het is
bedoeld om problemen op te sporen, niet om elke regel te begrijpen.

## De veilige weergave (standaard)

Standaard zie je de **afgeschermde** weergave. Persoonlijke gegevens zoals
apparaat-IDs en adressen zijn gemaskeerd, zodat je de logs veilig kunt
bekijken en delen zonder per ongeluk iets prijs te geven.

## "Toon ongeredacteerd"

Helemaal onderaan (of in de instellingen van het tabblad) zit een schakelaar
**"Toon ongeredacteerd"**. Die toont de echte, onafgeschermde regels — bedoeld
voor als je zelf iets nauwkeurig wilt bekijken.

**Waarschuwing:** schakel dit alleen in als je begrijpt wat je ziet. De
ongeredigeerde logs kunnen persoonlijke gegevens bevatten. **Deel ze nooit**
via een bundel of in een chat — maak in dat geval altijd een bundel, die is
altijd afgeschermd.

## Welke logboeken zijn er?

Elk onderdeel van de app houdt een eigen logboek bij:

- **Netwerk (LAN)** en **Netwerk (WAN)** — verbindingen met andere apparaten.
- **Vault** en **Identity** — jouw beveiligde kluis en identiteit. Deze zijn
  altijd aan en kunnen niet worden uitgezet (beveiliging).
- **TaskBroker** — de taken die de app uitvoert.
- **Chat** — berichtenverkeer.
- **Storage** en **Certificering** — opslag en controle van onderdelen.

## Wat betekenen de niveaus?

Elke regel heeft een niveau: **debug**, **info**, **waarschuwing** of **fout**.
- **Info** is de normale toestand.
- **Waarschuwing** is iets onverwachts, meestal niet erg.
- **Fout** is een probleem dat mogelijk hulp nodig heeft.

Een fout betekent niet altijd dat er iets stuk is: vaak probeert de app iets
opnieuw. Kijk bij twijfel naar de laatste fout en maak een diagnose-bundel.`,
  },
  {
    id: "vault-key-lost",
    title: "App vraagt om een sleutel",
    category: "herstel",
    summary: "Waarom de vault om de master-sleutel vraagt en wat je moet doen.",
    keywords: ["sleutel", "vault", "vergrendeld", "wachtwoord", "master"],
    markdown: `# App vraagt om een sleutel

Als de app na het opstarten om een **master-sleutel** vraagt, is de "kist"
(vault) waarin jouw geheimen staan op slot gezet. Dit gebeurt als:

- je de app afsluit terwijl de vault op slot is gezet;
- de app niet normaal kon worden afgesloten;
- je (of iemand met wie je het apparaat deelt) de vault handmatig heeft
  vergrendeld.

## Wat moet ik doen?

Vul de master-sleutel in die je bij de **eerste** keer opstarten hebt gekozen.
De app gebruikt die sleutel om de kist te openen — er is geen achterdeur.

## Ik ben mijn sleutel kwijt

Deze app heeft **geen** "wachtwoord vergeten"-knop. Dat is een bewuste keuze:
als iemand de sleutel kan laten herstellen, kan een aanvaller dat ook. Zonder
de juiste sleutel kan de inhoud van de vault **niet** worden gelezen.

Zorg daarom dat je de sleutel op een veilige plek bewaart (bijvoorbeeld in een
wachtwoordbeheerder). De sleutel wordt nooit opgeslagen en is alleen bij jou
bekend.

## Ik denk dat ik de juiste sleutel heb, maar hij wordt geweigerd

- Controleer op typfouten (hoofdletters, spaties, liggende streepjes).
- Sluit de app volledig af en start hem opnieuw.
- Is het netwerk uit of start de app in de veilige modus? Lees dan eerst de
  kaart "Netwerk is uit" en "App start niet".

Een verkeerde sleutel geeft bewust geen verdere uitleg, zodat niemand door
vallen en opstaan kan achterhalen waarom een sleutel niet klopt.`,
  },
  {
    id: "no-peers-found",
    title: "Er zijn geen peers (verbindingen) gevonden",
    category: "herstel",
    summary: "Waarom er niemand zichtbaar is en wat je kunt controleren.",
    keywords: ["peers", "verbinding", "netwerk", "offline", "vrienden"],
    markdown: `# Er zijn geen peers (verbindingen) gevonden

Deze app werkt **P2P**: je praat rechtstreeks met andere apparaten die dezelfde
app gebruiken. "Geen peers" betekent dat er op dit moment geen ander apparaat
zichtbaar is.

## Waarom is dat normaal?

- Je zit thuis en niemand anders in jouw netwerk gebruikt de app.
- De persoon die je zoekt is niet online.
- Het is de eerste keer dat je de app gebruikt — je hebt nog niemand
  toegevoegd.

## Wat kan ik controleren?

1. **Netwerk aan?** Kijk in de taakbalk of het netwerk niet op "pauze" staat.
   Zie de kaart "Het netwerk is uit" als dat zo is.
2. **Zit je op hetzelfde netwerk?** Vrienden op afstand vind je alleen via een
   uitnodiging. Vraag de ander om een uitnodiging te sturen en die te openen.
3. **Wacht even.** Ontdekking op het lokale netwerk duurt soms enkele
   seconden. Klik op vernieuwen of wacht tien seconden.

## Nog steeds niets?

Maak een **diagnose-bundel** via het tabblad Diagnose en vermeld daarin dat er
geen peers worden gevonden. De bundel laat de helpdesk zien of het netwerk
daadwerkelijk actief is zonder dat er persoonlijke gegevens meegaan.`,
  },
  {
    id: "network-offline",
    title: "Het netwerk is uit",
    category: "herstel",
    summary: "Netwerk gepauzeerd of offline: oorzaken en wat je moet doen.",
    keywords: ["netwerk", "pauze", "offline", "uit", "verbinding"],
    markdown: `# Het netwerk is uit

Je ziet de melding "Netwerk gepauzeerd" of de app lijkt "offline". De app kan
dan geen verbindingen maken en ook geen berichten ontvangen. Dit is meestal
geen fout, maar een bewuste schakelaar.

## Waarom is het netwerk uit?

- **Je hebt het zelf gepauzeerd.** Er zit een pauze-knop in de app waarmee je
  alle netwerkactiviteit tijdelijk stillegt — handig als je even niets wilt
  ontvangen.
- **De app is in de veilige modus gestart.** De veilige modus zet het netwerk
  uit zodat je kunt herstellen zonder dat andere apparaten verbinding maken.
- **Er is een instelling gewijzigd** waardoor netwerkverbindingen niet meer
  actief zijn.

## Wat moet ik doen?

1. Open het netwerkpaneel en zet "Netwerk gepauzeerd" uit.
2. Start de app opnieuw als de pauze niet verdwijnt.
3. Staat er in het tabblad Diagnose een **veilige modus**-badge? Start de app
   dan normaal (zonder veilige modus) op. Zie de kaart "App start niet".

## Belangrijk om te weten

Het netwerk staat nooit zomaar uit: als je het niet zelf hebt gepauzeerd en de
veilige modus niet actief is, dan is dit een aanwijzing dat er iets mis is met
de netwerklaag. Een diagnose-bundel helpt de helpdesk om dat snel te zien.`,
  },
  {
    id: "safe-mode",
    title: "De app start niet (of tekent niet)",
    category: "herstel",
    summary: "De veilige modus gebruiken om een vastgelopen app te herstellen.",
    keywords: ["start", "veilige modus", "safemode", "herstel", "leeg", "hangt"],
    markdown: `# De app start niet (of tekent niet)

Als het venster leeg blijft, de app blijft hangen of de app niet opstart, dan
is er een speciale opstartmodus om dat op te lossen: de **veilige modus**.

## Veilige modus starten

Start de app op met de veilige modus-optie aan (bijvoorbeeld \`--safe-mode\` op
de opdrachtregel of de omgevingsvariabele \`P2P_HUB_SAFE_MODE=1\`).

In de veilige modus start de app met een **minimale set**:

- geen extra onderdelen (plugins) die problemen kunnen veroorzaken;
- geen netwerkverbindingen;
- alleen de basis: het helpvenster en de logboeken.

Zo kun je een diagnose-bundel maken en zien wat er misgaat, ook als een
problematisch onderdeel de normale start blokkeert.

## Ik zie "veilige modus" in de app

De app toont dan duidelijk een badge "veilige modus". Dat is normaal en
bedoeld — de app laat je weten dat je in een herstelmodus zit, zodat je niet
verrast wordt door het ontbreken van functies.

## Wat moet ik daarna doen?

1. Maak in de veilige modus een **diagnose-bundel** via het tabblad Diagnose.
2. Probeer de app daarna normaal te starten.
3. Start zo nodig opnieuw in de veilige modus en deel de bundel met de
   helpdesk.

De veilige modus is een hersteltool, geen dagelijkse modus: als je eenmaal
hersteld bent, start je de app gewoon weer normaal op.`,
  },
];
