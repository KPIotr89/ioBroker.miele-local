# DOP2 / MieleH256 — Protokoll- und Leaf-Referenz

Technische Referenz zum lokalen Miele-Protokoll, wie im Adapter umgesetzt. Basis: eigenes
Reverse-Engineering + öffentliche Projekte (akappner/MieleRESTServer, ha-miele-at-lan,
home-assistant-miele-mobile).

## 1. Request-Signierung (MieleH256)

```
canonical =  METHOD + "\n"
          +  HOST + "/" + resource + "\n"
          +  "application/vnd.miele.v1+json; charset=utf-8" + "\n"   (Content-Type)
          +  "application/vnd.miele.v1+json" + "\n"                  (Accept)
          +  Date + "\n"
          +  Body (bei PUT/POST, gepaddet)
signature =  HMAC_SHA256(GroupKey, canonical)  → Hex, GROSSBUCHSTABEN
Header:      Authorization: MieleH256 <GroupID>:<signature>
```
- `Date` wird vom Gerät nicht geprüft (fester Wert möglich).
- GroupKey = 64 Byte. **AES-Key = GroupKey[0:32]**, HMAC-Key = GroupKey[0:64].

## 2. Ver-/Entschlüsselung (AES-256-CBC, kein Auto-Padding)

- **Antwort entschlüsseln:** IV = erste 16 Byte der Signatur aus dem `X-Signature`-Antwortheader.
- **Request-Body verschlüsseln:** IV = erste 16 Byte der Request-Signatur.
- **Padding:** JSON-Bodys auf min. 64 Byte und 16-Byte-Ausrichtung, Leerzeichen VOR `}`.
  Andere Bodys auf die nächste 16-Byte-Grenze mit `0x20`.

## 3. Endpunkte

| Methode | Ressource | Zweck |
|---|---|---|
| GET | `Devices/` | Liste der Geräte-Routen (Seriennummern) |
| GET | `Devices/<serie>/Ident` | Stammdaten (TechType, FabNumber, XKM …) |
| GET | `Devices/<serie>/State` | Live-Zustand (JSON) |
| GET | `Devices/<serie>/DOP2/` | DOP2-Wurzel (Knotenliste) |
| GET | `Devices/<serie>/DOP2/<unit>` | Leaf-Liste eines Knotens |
| GET | `Devices/<serie>/DOP2/<unit>/<attr>?idx1=0&idx2=0` | Leaf-Inhalt (binär, verschlüsselt) |
| PUT | `Devices/<serie>/DOP2/2/1583?idx1=0&idx2=0` | UserRequest (Steuerbefehle) |
| PUT | `Devices/<serie>/SuperVision/<ourFab>` | Push-Peer registrieren (falls unterstützt) |
| POST | `Subscriptions` | Push-Subscription anlegen |
| PUT | `Security/Commissioning/` | Erst-Pairing (nicht genutzt — würde Kopplung ändern) |

## 4. DOP2-Binärformat

Entschlüsselter Leaf:
```
[0..1]  payloadLength (big-endian)
[2..3]  unitId        [4..5] attributeId
[6..7]  (Header-Rest)
[8..]   payload   → payload[3]+payload[4]<<8 = Anzahl Felder, ab payload[5] die Felder
Feld:   [index(1B), type(1B), value(wireLength)]   (Padding 0x00 zwischen Struct-Feldern)
```
Feldtypen (Auszug): 1=bool, 2=U8, 3=S8, 5=U16, 6=S16, 8=U32, 9=S32, 11=U64, 14=float32,
15=float64, 16=struct, 18/32=string, 17/20/21/22/23/25/27=Arrays, **33=Liste von Strukturen**
(AStruct). Integer sind **Big-Endian**. Genau genommen ist die Feldnummer ein u16 (das „Padding"
ist ihr oberes Byte) und die Feldzahl einer Struktur ebenfalls.

**Typ 33 (AStruct, seit der Version nach 0.5.2):** `u16 Anzahl Elemente`, dann je Element
`u16 Anzahl Felder` und die Felder als `[u16 Nummer, u8 Typ, Wert]`. Kommt u. a. in 2/1585 Feld 6.7
(TwinDos/AutoDos-Behälter), 2/17 und 2/131 vor. Bis 0.5.2 brach der Parser daran mit
`Unknown DOP2 field type 33` ab – für das ganze Leaf.

**Einheitentyp der Generic-Hülle:** Sub-Feld 6 nennt, was gezählt wird – 121 = Wh, 45 = kWh,
44 = l (ha-miele-at-lan, an G7197/G7655 gegen die App geprüft). 2/1585 Feld 6.5/6.6 (Lebenszähler
der Spülmaschine) tragen 121 bzw. 44. Ohne Typangabe bleibt es beim Rohwert.
### Wertehüllen — zwei Bauarten, zwei Stellen

Jeder Messwert steckt in einer kleinen Struktur. Es gibt **zwei** davon, und sie sind an ihrer
Länge zu unterscheiden:

| Bauart | Aufbau | Länge | Nutzwert |
|---|---|---|---|
| `Annotated<T>` | `[requestMask=8, WERT, interpretation]` | 3 | Sub-Feld **2** |
| `Generic<T>` | `[requestMask=9, min, max, ISTWERT, stepSize, …]` | 5 oder mehr | Sub-Feld **4** |

Die Sub-Felder tragen eigene Nummern (`decodeStruct` hebt sie seit 0.3.37 auf); die Nummer ist
der zuverlässige Zugriff, die Position nur der Rückfall.

**Belegt am laufenden Gerät (15.09.2026, WCR860, 40-°C-Programm):** Feld 24 des Eco-Leaf
(`heatingTargetTemperature`, `GenericU8`) kam als `[9, 0, 0, 40, 0, 0]`. Wer das zweite Sub-Feld
liest, bekommt das Minimum — und das ist bei jedem beobachteten Generic-Feld 0. Betroffen waren in
2/6195 die Felder 1, 2, 3, 18, 19, 24 und 58.

Welches Feld welche Bauart hat, steht in `lib/leafnamen.js` (`GENERIC`), erzeugt aus den
Typangaben von `MieleRESTServer`.

## 5. Bekannte/genutzte Leaves

| Leaf (unit/attr) | Inhalt |
|---|---|
| `2/1583` | GLOBAL_USER_REQ — Steuerbefehle (PUT, 32-Byte-Payload, Prefix + Opcode) |
| `2/1586` | Combined State (modern) |
| `2/138` | Cycle Counter |
| `2/119` | Hours of Operation |
| `2/6195` | **ProcessData (Waschmaschine)** — Live-Prozess/EcoFeedback |
| `2/6192` / `2/6193` | Aktoren / Sensoren der Waschmaschine |
| `2/256` | DeviceState (Legacy-Vollzustand, u. a. #7 Restzeit s, #8 Laufzeit s) |
| `2/1584` | Programmliste (IDs, Dauer, Temperatur) |
| `2/1585` | GLOBAL_DeviceContext — Feld 6 trägt das **EcoFeedback des Geräts** (6.3/6.4 letztes Programm, 6.5/6.6 Lebenszähler, 6.7 Dosierbehälter) |
| `2/391` | laut Namenstabelle ebenfalls DeviceContext; Ersatz, wenn 2/1585 nichts liefert |
| `2/145` | Kennung: #1 Seriennummer, #3 Modell, #4 Materialnummer (eigene Messung, G5840) |
| `14/1570` / `14/1571` | Programm- und Optionsliste der Gargeräte (ha-miele-at-lan) |

Die vollständige Zuordnung Leaf → Struktur → Feldnamen steht in `lib/leafnamen.js`: 40 Leafs,
52 Strukturen, erzeugt aus `MieleRESTServer/dop2rs/src/payloader/**` und ergänzt um die Adressen,
die `ha-miele-at-lan` zusätzlich kennt.

### Was die Geräte dieses Haushalts beantworten (Stand 15.09.2026)

| Gerät | antwortende Leafs | Bemerkung |
|---|---|---|
| WCR860 (Waschmaschine) | 10 | 2/19, 2/20, 2/21, 2/23, 2/1583, 2/1584, 2/1586, 2/6192, 2/6193, 2/6195 |
| G5840 (Spülmaschine) | 19 | u. a. 2/119, 2/145, 2/173, 2/174, 2/256 — **kein** 2/6195 |
| H2469BP (Backofen) | 0 | alle 882 gescannten Adressen 404; Unit 14 war nie gefragt |

Keines der drei Geräte hat bisher 2/1585 beantwortet (XKM EK037/EK057, HTTP 404 bzw. 500) — dort,
wo das EcoFeedback des Herstellers stünde. Für sie zählt der Adapter die Impulse des
Durchflusszählers (Feld 21 ÷ 200). Seit der Version nach 0.5.2 wird 2/1585 (und 2/391) unabhängig
von 2/6195 gefragt; bis dahin lief die Abfrage nur nach einer erfolgreichen Antwort auf 2/6195 und
erreichte die Spülmaschine nie.

### /State.ExtendedState
Hex-Text in der Antwort auf `GET Devices/<serie>/State`. Für Kochfelder ist der Aufbau belegt
(ha-miele-at-lan, `extended_state.py`). Für Waschmaschinen gibt es nur den Hinweis, dass bei
WMV960/G6992 die Bytes 50–51 Energie (0,1 kWh) und 52–53 Wasser (l) tragen sollen — ungeprüft,
modellabhängig. Der Adapter legt den Rohwert nur als Diagnose ab (`collection.extendedState`) und
protokolliert auf debug die Bytes 50–53, deutet aber nichts.

### UserRequest-Payload (2/1583)
```
Prefix (hex): 00100001062f00000000000100010700
+ 1 Byte Opcode  + 15 Byte 0x20-Padding   → 32 Byte gesamt
```
Opcodes: 0x01 Start, 0x03 Pause, 0x37 Stop, 0x10 SwitchOn, 0x13 SwitchOff, 0x0d LightOn, 0x0e LightOff.

### Ein-/Ausschalten (seit 0.4.3, `lib/einschalten.js`)
Wie die Miele-App: Gerätezustand in **2/1586** (DeviceCombiState), Feld 1 ApplianceState, Typ E8,
**4 = ein, 1 = aus**. Fester Rumpf (nur Feld 1):
```
000e 0002 0632 0000 0000 0001 | 0001 04 <04|01> + 0x20 bis 32 Byte
```
Kaffeevollautomat (DeviceType 17): 2/1586 lesen, Feld 1 ersetzen, ganzen Leaf zurückschreiben.
Ablauf: State lesen (nur Auskunft) → GET 2/1586 (bei 500 wecken: `PUT State {"DeviceAction":2}`,
3 s, Kaffee 5 s + 1,5 s) → PUT 2/1586 (bei 500 wecken und wiederholen, höchstens 2 Runden) →
Rückfall 2/1583 (Kopf oben, unverändert) → Status nachlesen. ProtocolVersion 2 + Typ 17:
`POST Devices/<serie>/DOP/ {"Request":"110102000102"}` (ein) bzw. `…103` (aus).

Live 10.11.2026: G5840 (EK037 04.05) schaltet über 2/1586 mit festem Rumpf ein und aus (Status
1 → 3 → 1). Den kurz nach dem Wecken gelesenen ganzen Leaf (ApplianceState 2, OperationState 15)
nahm sie mit 204 an, blieb aber aus. WCR860 (EK037 04.05): jeder DOP2-Schreibbefehl 500,
Antwort `{"Error": 20645, "CausedByXkm": 0}`; schon das Wecken schaltete sie ein (Status 1 → 2).
H2469BP (EK057 08.37): jeder DOP2-Leaf 404.

### ProcessData (2/6195, Waschmaschine WCR860 — empirisch)
Feld-Indizes (1-based), Nutzwert = interpretiertes Struct-Sub-Feld:

Stand 13.11.2026 (31 bzw. 56 Läufe gegen Messsteckdose; frühere Einträge „#25 Energieverbrauch“ und
„#40 Wasser“ waren falsch):

| Feld | Bedeutung | Einheit | Beleg |
|---|---|---|---|
| #4 | **Laufzeit** (zählt aufwärts; Name `remainingTimeInMinutes` irreführend) | min | belegt |
| #5 | Programmphase; 12014 = Programmende, 12109 = Ruhezustand (WCR860) | — | beobachtet |
| #8..#12 | heaterRelay / lyePump / circulationPump / coldWaterValve / hotWaterValve (bool) | — | Index-Ausrichtung |
| **#16** | **Antriebsenergie** — zählt im Lauf aufwärts, OHNE Heizstab; fällt bei 12109 auf 0 | Wh | 13 Programme, R² 0,999 |
| #17 | waterConsumedInLitres | — | **widerlegt** (immer 0) |
| **#21** | Wasser (Durchflusszähler) | 5 ml je Impuls (÷200 → l) | 0,5 % gegen Hauswasserzähler |
| **#25** | **Heizenergie-Vorgabe** für die Hauptwäsche = #26 × 2020 W bei 230 V; einmal gesetzt, nie nachgeführt | Wh | 31 Paare ±1 Wh |
| **#26** | **geplante Heizzeit** | s | dto. |

> #25 + #16 taugt NICHT als Gesamtenergie (im Mittel 40 % daneben). Genau (~2 %) ginge nur
> #16 + Einschaltdauer Heizrelais (#8) × 2020 W × (U/230)² + 0,2 Wh/min — bräuchte eine Abfrage
> etwa alle 10 s. Die Indizes können je Modell abweichen.

## 6. SuperVision-Push (Enrollment)

1. `PUT /Devices/<serie>/SuperVision/<ourFab>`  Body `{"Show":true,"Signal":true}`
2. `POST /Subscriptions`  Body `{"Resource":"/Devices/<serie>/State/","Callback":"http://<ip>:<port>/Devices/<ourFab>/SuperVision/<serie>/State/"}`
   (je Ressource: `/State/`, `/State/Light/`, `/State/Status/`, `/Ident/`)

Danach POSTet das Gerät Zustandsänderungen an die Callback-URL (AES-verschlüsselt, IV aus
Authorization-Signatur). Voraussetzung: erreichbare LAN-IP (Host-Netz) UND ein Gerät mit
`/SuperVision`-Endpunkt. Basisgeräte (EK037/EK057 hier) liefern 404 → kein Push.

## 7. Beobachtete Fehlercodes

| Code | Bedeutung im Kontext |
|---|---|
| 404 | Endpunkt/Leaf existiert nicht (z. B. `/SuperVision` bei Basisgeräten; 2/6195 am Ofen) |
| 405 | Methode nicht erlaubt (z. B. GET auf `/Security/Commissioning`) |
| 500 | Gerät lehnt Leaf-Read ab (Spülmaschine G5840 bei allen DOP2-Leaf-Reads) |
| 204 | leere/erfolgreiche Antwort (z. B. Push-Empfang) |
