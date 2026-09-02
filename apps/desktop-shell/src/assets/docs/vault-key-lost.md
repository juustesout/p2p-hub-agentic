# App vraagt om een sleutel

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
vallen en opstaan kan achterhalen waarom een sleutel niet klopt.
