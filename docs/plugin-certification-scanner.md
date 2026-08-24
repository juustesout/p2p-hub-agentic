# Plugin Certification Scanner — ontwerp (certificatie-brief)

## Doel & filosofie

De plugin-certificatie is een **mens-in-de-lus-review** van een plugin vóór
distributie: de scanner produceert een rapport, een mens neemt het besluit. De
scanner is een **patroon-rapporteur, geen goedkeurder**. Twee niet-onderhandelbare
regels volgen hieruit:

1. **De scanner oordeelt nooit "is dit gebruik oké" — alleen "wijkt dit af van
   wat het manifest claimt".** Een rode vlag betekent: mens, kijk hier. Dat de
   beoordelaar het daarna legitiem vindt, is een menselijk besluit en verandert
   niets aan de vlag.
2. **Rode vlaggen worden nooit onderdrukt.** Geen "vertrouwde plugin"-lijst, geen
   signature-override, geen automatische "dit is duidelijk goedaardig"-filter.
   Automatisering die stilzwijgend legitiem gebruik filtert op basis van haar
   eigen inschatting, maakt de mens-in-de-lus overbodig vóórdat dat verdiend is.

Het primaire kwaad dat deze brief vermijdt is **schijnvertrouwen**: een vals
"clean"-resultaat is gevaarlijker dan een valse waarschuwing, want het verleidt
tot een handtekening zonder review. Elke beperking van de scanner moet daardoor
**loud** in het rapport staan, nooit stilzwijgend wegvallen.

## Empirische basis (gemeten op 8 first-party plugins, niet aangenomen)

Deze ontwerpbeslissingen zijn genomen na meting op de gebouwde `dist/`-bundles
van alle 8 first-party plugins (calc, peersite, chat, calendar, contacts,
notepad, tasks, paint), niet op basis van de documentatie van de tooling.

| meting | resultaat |
|---|---|
| `eslint-plugin-security` `recommended`-preset | **42 findings — 0 echt.** 38× `detect-object-injection` + 4× `detect-unsafe-regex`, allemaal false-positive/goedaardig (zie onder) |
| hard-only ruleset (9 regels, zie Pijler A) | **8/8 plugins CLEAN, nul bevindingen, nul ruis** |
| eigen cross-check, regex-gebaseerd (v1) | meldde 8/8 CLEAN — maar miste stilzwijgend `node:fs/promises` in peersite |
| eigen cross-check, AST-gebaseerd (v2) | 7/8 CLEAN + 1 rode vlag (peersite `node:fs/promises`) — de vlag is terecht en legitiem, zie Pijler C |

De klassieke ruisbronnen, per geval geclassificeerd:

- `detect-object-injection` flagt **string-indexing** (`src[i]` in de calc
  formule-parser — `src` is een `string`), **PBX/OLE object-graph lookups**
  (`doc.$objects[id]`, `cells[coord]`, `book.$objects[contactId]` — sleutels uit
  het document zelf, geen property-injectie), **tsc-emitted helpers**
  (`__exportStar`/`__createBinding` `m[k]`), **`ownKeys`-iteratie** over de eigen
  module-export-map, en de **`tasks` merge-allowlist** (`task[key] = patch[key]`
  over een hardcoded array van literal keys `["name","start",...]` — de `key` is
  niet caller-gecontroleerd). `detect-object-injection` is per ontwerp blind voor
  dat onderscheid; het produceert alleen ruis op deze codebase.
- `detect-unsafe-regex` flagt **elke statische regex-literal**, ook de
  onschuldige (`RANGE_RE = /^([A-Za-z]+\d+)(?::([A-Za-z]+\d+))?$/`,
  `MATH_RE`). Er zit geen user-input in het patroon en geen backtracking-catastrofe.

**Conclusie die de brief draagt:** de naïeve `recommended`-preset is op deze
codebase ~100% ruis en mag niet als uitgangspunt dienen. De hard-only ruleset is
de bruikbare kern; de cross-check is de tweede pijler.

## Pijler A — eslint-plugin-security, hard-only ruleset

Precies deze 9 regels, allemaal `error`:

```
security/detect-eval-with-expression
security/detect-child-process
security/detect-non-literal-fs-filename
security/detect-non-literal-regexp
security/detect-pseudoRandomBytes
security/detect-possible-timing-attacks
security/detect-buffer-noassert
security/detect-new-buffer
security/detect-non-literal-require
```

Gemeten gedrag op de 8 first-party plugins: nul findings, nul ruis. Dit zijn de
regels waarvan een treffer bijna altijd een echte afwijking is (`eval` met
expressie, `child_process`, niet-literal fs/regex/require, timing-gevoelige
vergelijking, oude buffer-API's).

**`detect-object-injection` en `detect-unsafe-regex` worden niet opgenomen.**
Niet omdat de patronen niet bestaan, maar omdat de rule-noise op deze codebase
bewezen >98% is (zie boven) en de treffers die er wél toe doen al door de
cross-check worden gevangen: onveilige regex *met runtime-variabele* is
`detect-non-literal-regexp`, en property-injectie *met caller-controle op een
record* is het vak van de AST-cross-check (Pijler B), niet van een string-regex.
Toekomstige regel-toevoeging heeft dezelfde deur als een nieuwe capability:
eerst een noise-meting op de first-party plugins, pas daarna inschakelen.

## Pijler B — AST cross-check (manifest-versus-gedrag)

De tweede pijler vergelijkt het **werkelijke gedrag van de gebouwde bundle**
tegen wat `manifest.permissions` claimt. Implementatie: **TypeScript compiler
API** (`ts.createSourceFile` + `ts.forEachChild` over de `dist/*.js`), géén
regex of string-matching. Elke `require`/`import`/re-export wordt via de AST
geëxtraheerd, geconstant-folded, en tegen een gevoelige-module-set gecheckt.

### Module-extractie (alle vormen, elk apart getest)

| vorm | voorbeeld | detectie |
|---|---|---|
| statische require | `require("net")` | ✓ |
| template-literal | `` require(`child_process`) `` | ✓ |
| string-concatenatie | `require("ne" + "t")` | ✓ constant-folding |
| ESM import | `import d from "http"` | ✓ |
| re-export | `export * from "dgram"` | ✓ |
| import-equals | `import e = require("dns")` | ✓ |
| dynamische import | `import("tls")` | ✓ (`ImportKeyword`-node, geen identifier) |
| `node:`-prefix | `require("node:fs/promises")` | ✓ genormaliseerd naar `fs/promises` |
| dynamische require | `require(process.env.MODULE)` | ✓ gevlagd als `require-dynamic` |

**Negatieve controles:** `import type {} from "fs"` en `export type {} from
"net"` worden **niet** gevlagd — die zijn runtime-geëraseerd en hebben geen
gedragseffect. Het onderscheid voorkomt ruis zonder de garantie te verzwakken.

### Patroon-detectie

`eval` (inclusief indirecte varianten `(0, eval)`, `globalThis.eval`,
`window["eval"]` — via callee-unwrapping van parenthesized/binary-comma
expressies), `new Function`, `Function(...)`-call, `require-dynamic`, en
`process.env` (één vlag per bestand).

### Gevoelige module-set

`net, tls, http, https, http2, dgram, dns, child_process, fs, fs/promises,
worker_threads, cluster, vm, process` — genormaliseerd (`node:`-prefix gestript)
vóór de set-check.

### Waarom AST en niet regex — het bewijs

De regex-versie (v1) meldde **8/8 CLEAN** en miste twee klassen stilzwijgend:
gequote requires via een charset-gat (`require("...")` matched niet omdat de
quote niet geconsumeerd werd) en `node:`-prefix (het `:` zat niet in de
extractie-charset → `node` geëxtraheerd, niet gevoelig → geen vlag). De
AST-versie vond daarmee een echte bevinding die v1 als "CLEAN" rapporteerde:
**peersite requiret `node:fs/promises`**. Dit is het exacte schijnvertrouwen-
scenario uit de filosofie, met een reproduceerbaar bewijs in plaats van een
aanname dat de AST-versie beter zou zijn. De ontwijkingsmatrix hierboven is
daarom een **regressietest-set** voor de scanner, geen illustratie.

## Pijler C — Rapport & mens-in-de-lus

Het rapport per plugin bevat:

1. **Alle externe module-requests** (informatief, gesorteerd) — zodat de
   reviewer ziet wat de plugin überhaupt inlaadt.
2. **Rode vlaggen** — elke gevoelige-module- of patroontreffer, mét bestand en
   regel. **Nooit onderdrukt, nooit geautomatiseerd goedgekeurd.**
3. **De manifest-permissies** zoals gescand — zodat "afwijken van het manifest"
   controleerbaar is.

Voorbeeld uit de validatie: peersite's `node:fs/promises` gaat als rode vlag het
rapport in, óók al is het gebruik legitiem (gedocumenteerde read-only site-mirror
met `resolveAndContainFile` path-containment en per-asset byte-cap,
`plugins/peersite/src/index.ts:377-387`). De manifest-permissies van peersite
claimen geen fs-toegang; of dat gat acceptabel is, is een menselijk besluit over
het permissiemodel — de scanner levert alleen het feit dat de bundle fs raakt.
De discipline is: **de scanner faalt nooit closed op "ik vind dit wel oké"**.

## Beperkingen & anti-schijnvertrouwen

Deze lijst staat **loud in elk rapport** en in de brief, omdat een scanner die
zichzelf ongemerkt zwakker is dan hij lijkt, gevaarlijker is dan geen scanner.

- **Runtime-berekende module-paden** (`require(computePath())` met
  variabele-invoer) zijn niet te volgen — de scanner vlagt `require-dynamic`
  en de reviewer beslist.
- **Obfuscatie / string-encoding** (hex/unicode escapes, omgekeerde strings)
  ontsnapt aan elke statische analyse. De scanner is een **bar-raiser, geen
  garantie** — dezelfde framing als het Node Permission Model in CLAUDE.md:
  het verhoogt de lat tegen onbedoelde bugs en halfslachtige pogingen, niet
  tegen vastberaden kwaadwillende code.
- **Runtime-omleiding** (prototype-patching, module-object-monkey-patching,
  `process.binding`-achtige paden, een `child_process`-spawn van een verse
  node) is empirisch bewezen niet statisch te vangen — zie de Node Permission
  Model-bevindingen in CLAUDE.md. De certificatie is daardoor nooit "deze
  plugin is veilig", maar "deze plugin is op statische patronen gescand en
  een mens heeft de vlaggen bekeken".
- **De cross-check scant de gebouwde `dist/`, niet de `src/`.** De bron is
  triviaal te obfusceren vóór build; het uitvoerbare gedrag is de enige
  eerlijke meetbasis.

## Slice plan

- **Slice 1 — scanner-kern:** `core/src/plugin-scan/` (of een eigen workspace):
  Pijler A-config (de 9 harde regels) + Pijler B (AST-cross-check, TS-compiler-API)
  + rapport-generator. De ontwijkingsmatrix als regressietests, plus de
  8 first-party plugins als "expected-clean"-test (peersite één verwachte vlag).
- **Slice 2 — review-workflow:** rapport-formaat dat de mens leest, output naar
  een certificatie-record (welke plugin, welke versie, welke vlaggen, wie heeft
  beslist). Geen automatische blokkade; de mens tekent.
- **Slice 3 — (optioneel, niet de default)** blokkerende gate in de
  distributie-pipeline. Alleen na bewezen stabiliteit van de vlag-set over
  meerdere plugins en een expliciete beslissing dat de mens-in-de-lus mag
  wijken. Tot die tijd: rapport eerst, handtekening altijd menselijk.

## Security-invariants (overgenomen uit CLAUDE.md)

- **Rode vlaggen nooit onderdrukt** en nooit geautomatiseerd "legitiem" verklaard
  (Pijler C-regel 2).
- **Elke nieuwe regel of nieuwe gevoelige module** volgt dezelfde deur als een
  nieuwe capability: eerst een noise-meting op de first-party plugins, en elke
  afwijking van "alleen harde regels" wordt expliciet beargumenteerd in plaats
  van geruisloos toegevoegd.
- **Beperkingen staan loud in het rapport**, nooit als voetnoot weggeschreven —
  een vals "clean" is de primaire faalmodus die deze brief vermijdt.
