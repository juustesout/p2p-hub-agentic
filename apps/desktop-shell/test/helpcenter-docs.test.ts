import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DOC_CATEGORIES,
  docPlainText,
  groupDocs,
  parseMarkdown,
  queryMatches,
  searchDocs,
  type HelpDoc,
} from "../src/components/helpcenter/docs";

function doc(partial: Partial<HelpDoc>): HelpDoc {
  return {
    id: "x",
    title: "Titel",
    category: "aan-de-slag",
    summary: "Korte samenvatting.",
    keywords: [],
    markdown: `# ${partial.title ?? "Titel"}\n\nInhoud over ding.`,
    ...partial,
  };
}

test("parseMarkdown splits headings, paragraphs, lists and code fences", () => {
  const md = [
    "# Titel",
    "",
    "Eerste alinea over iets.",
    "Verder op dezelfde regel.",
    "",
    "- een item",
    "- twee item",
    "",
    "1. genummerd een",
    "1. genummerd twee",
    "",
    "```",
    "code { hier }",
    "```",
    "",
    "Laatste zin.",
  ].join("\n");
  const blocks = parseMarkdown(md);
  assert.deepEqual(blocks[0], { type: "heading", level: 1, text: "Titel" });
  assert.deepEqual(blocks[1], {
    type: "paragraph",
    text: "Eerste alinea over iets. Verder op dezelfde regel.",
  });
  assert.deepEqual(blocks[2], {
    type: "list",
    ordered: false,
    items: ["een item", "twee item"],
  });
  assert.deepEqual(blocks[3], { type: "list", ordered: true, items: ["genummerd een", "genummerd twee"] });
  assert.deepEqual(blocks[4], { type: "code", text: "code { hier }" });
  assert.deepEqual(blocks[5], { type: "paragraph", text: "Laatste zin." });
});

test("parseMarkdown never interprets HTML-like content as blocks", () => {
  const blocks = parseMarkdown("# Kop\n\n<script>alert(1)</script>");
  assert.equal(blocks[1].type, "paragraph");
  assert.equal(blocks[1].type === "paragraph" ? blocks[1].text : "", "<script>alert(1)</script>");
});

test("docPlainText returns heading + content text without markup", () => {
  const text = docPlainText("# Kop\n\nRegel **vet** en `code`.\n\n- lijstje item");
  assert.ok(text.includes("Kop"));
  assert.ok(text.includes("Regel"));
  assert.ok(text.includes("lijstje item"));
});

test("queryMatches requires every whitespace-split term", () => {
  assert.equal(queryMatches("De app start niet op", "app start"), true);
  assert.equal(queryMatches("De app start niet op", "app start vaart"), false);
  assert.equal(queryMatches("anything", ""), true);
});

test("searchDocs returns all docs in order for an empty query", () => {
  const docs = [doc({ id: "b", title: "Bee" }), doc({ id: "a", title: "Aa" })];
  const hits = searchDocs(docs, "   ");
  assert.deepEqual(hits.map((h) => h.doc.id), ["b", "a"]);
  assert.ok(hits.every((h) => h.score === 0));
});

test("searchDocs ranks a title hit above a body-only hit", () => {
  const docs = [
    doc({ id: "in-body", title: "Onbekend onderwerp", markdown: "# Onbekend\n\nVeel tekst over de vaultsleutel verloren raakt en herstel." }),
    doc({ id: "in-title", title: "Vaultsleutel verloren", markdown: "# Vaultsleutel verloren\n\nInhoud." }),
  ];
  const hits = searchDocs(docs, "vaultsleutel");
  assert.equal(hits.length, 2);
  assert.equal(hits[0].doc.id, "in-title", "title hit must rank first");
});

test("searchDocs honors keywords even when the body lacks the word", () => {
  const docs = [
    doc({ id: "k", title: "Geen netwerk", keywords: ["peer", "verbinding"], markdown: "# Geen netwerk\n\nContent zonder het trefwoord." }),
    doc({ id: "n", title: "Iets anders", markdown: "# Iets anders\n\nIets geheel anders." }),
  ];
  const hits = searchDocs(docs, "verbinding");
  assert.deepEqual(hits.map((h) => h.doc.id), ["k"]);
});

test("searchDocs excludes docs with no matched term", () => {
  const docs = [doc({ id: "a", title: "Peer gevonden" }), doc({ id: "b", title: "Vaultsleutel" })];
  const hits = searchDocs(docs, "zonnepaneel");
  assert.equal(hits.length, 0);
});

test("searchDocs ranks multi-word matches above single-word matches", () => {
  const docs = [
    doc({
      id: "both",
      title: "Netwerk en sleutel kwijt",
      markdown: "# Netwerk en sleutel kwijt\n\nNetwerk offline en sleutel zoek.",
    }),
    doc({
      id: "one",
      title: "Netwerk offline",
      markdown: "# Netwerk offline\n\nOver netwerk dat uitvalt.",
    }),
  ];
  const hits = searchDocs(docs, "netwerk sleutel");
  assert.equal(hits[0].doc.id, "both", "matches both terms, ranks first");
});

test("groupDocs buckets by category in DOC_CATEGORIES order", () => {
  const docs = [
    doc({ id: "a", category: "herstel", title: "A" }),
    doc({ id: "b", category: "aan-de-slag", title: "B" }),
    doc({ id: "c", category: "herstel", title: "C" }),
  ];
  const groups = groupDocs(docs);
  assert.deepEqual(groups.map((g) => g.id), ["aan-de-slag", "herstel"]);
  assert.equal(groups[0].label, DOC_CATEGORIES[0].label);
  assert.deepEqual(groups[0].docs.map((d) => d.id), ["b"]);
  assert.deepEqual(groups[1].docs.map((d) => d.id), ["a", "c"]);
});
