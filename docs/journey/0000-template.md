# NN – <Korte titel van de opdracht of het besluit>

> Structuur voor architectuurhistorische aantekeningen in `docs/journey/`.
> Elke brief / grotere opdracht krijgt één zo'n log. Kopieer dit bestand naar
> `docs/journey/<JJJJMMDD>-<NNN>-<kebab-slug>.md`, vul de secties in en verwijder
> deze kopregel.
>
> Schrijfregels:
> - Besluiten kort en **verifieerbaar** — verwijs naar code, constants en
>   commit-hashes, geen losse meningen.
> - Benoem altijd de **afgewezen alternatieven** en de **accepteerde trade-offs**
>   (vooral security-relevant werk).
> - Status = één van `Accepted` / `Proposed` / `Superseded-by <NN>`.
> - `docs/wiki/` wordt door Hermes gegenereerd uit deze bronbestanden — schrijf
>   alsof een model er een coherent verhaal van moet kunnen bouwen. Gebruik de
>   wiki-slug in de tabel hieronder als koppelvlak.

| | |
|---|---|
| **Status** | Accepted |
| **Datum** | JJJJ-MM-DD |
| **Opdracht/brief** | <plan.md-sectie of `docs/<brief>.md`> |
| **Commits** | `<sha>` (+ `<sha>` voor vervolgslices) |
| **Wiki-sectie** | `docs/wiki/<NN>-<slug>.md` |

## Context

<Waarom bestond dit werk? Welk probleem lost het op? Wie is de betrokken
actor (peer, plugin, operator, agent)? Wat was de staat vóór dit werk?>

## Besluiten

### <NN.N> — <besluit-titel>

<De beslissing, het mechanisme en waar het in de code staat
(`bestand:regel`-verwijzingen).>

## Alternatieven overwogen

- <optic> — <waarom niet gekozen>

## Gevolgen & grenzen

- <wat dit besluit opent of sluit>
- <bewuste niet-doelen / openstaande follow-ups>

## Status & testbewijs

<Gebouwd? Getest? Suite-stand: `<N> tests / 0 fail`; relevante testbestanden.>

## Gerelateerd

- <andere journey-logs, `docs/`-documenten, plan.md-secties>
