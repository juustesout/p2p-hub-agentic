# Logs lezen: wat betekent dit?

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
opnieuw. Kijk bij twijfel naar de laatste fout en maak een diagnose-bundel.
