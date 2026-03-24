# CAI Prenota Rifugi Reverse Engineering

Stand: 2026-03-24

## Kurzfazit

Die Plattform trennt zwischen:

- `prenotarifugi.cai.it` als WordPress-Frontend
- `booking.prenotarifugi.cai.it/backend/web/...` als eigentlichem Booking-/API-Backend

Direkte API-Requests ohne browserartige Header liefern `403 Forbidden`.
Mit `Referer`, `Origin` und `X-Requested-With: XMLHttpRequest` funktionieren die Calls.

## Verifizierte Endpunkte

### 1. Hüttenliste / Metadaten

```text
GET https://booking.prenotarifugi.cai.it/backend/web/api/1.0/it/json/get/shelter/byAttributes
```

Beobachtet in:

- `https://www.prenotarifugi.cai.it/cerca-e-prenota/`
- `data-infinite-scroll`
- `window.DISCOVER_SEARCH_CONFIG`

Verifizierte Header:

```text
Referer: https://www.prenotarifugi.cai.it/cerca-e-prenota/
Origin: https://www.prenotarifugi.cai.it
X-Requested-With: XMLHttpRequest
User-Agent: Mozilla/5.0
```

Beispiel:

```bash
curl -sG \
  'https://booking.prenotarifugi.cai.it/backend/web/api/1.0/it/json/get/shelter/byAttributes' \
  --data-urlencode 'page=1' \
  --data-urlencode 'rows=2' \
  -H 'Referer: https://www.prenotarifugi.cai.it/cerca-e-prenota/' \
  -H 'Origin: https://www.prenotarifugi.cai.it' \
  -H 'X-Requested-With: XMLHttpRequest' \
  -H 'User-Agent: Mozilla/5.0'
```

Response enthält u. a.:

- `id`
- `name`
- `beds`
- `paths`
- `services`
- `addresses[].coords`
- `price`
- `img.file`
- `slug`

Wichtig:

- `disponibilita` kam in meinen direkten Tests über `byAttributes` nicht zuverlässig zurück.
- Für echte Tagesverfügbarkeit ist der Kalender-Endpoint der bessere Weg.

### 2. Verfügbarkeit pro Hütte / Monat

```text
GET https://booking.prenotarifugi.cai.it/backend/web/api/1.0/json/get/shelter/calendar/{shelterId}
```

Beobachtet in:

- Detailseite `https://www.prenotarifugi.cai.it/dettaglio/.../?id=...`
- Attribut `data-available` auf `.calendar`

Beispiel:

```bash
curl -sG \
  'https://booking.prenotarifugi.cai.it/backend/web/api/1.0/json/get/shelter/calendar/5759' \
  --data-urlencode 'people=4' \
  --data-urlencode 'month=7' \
  --data-urlencode 'year=2026' \
  -H 'Referer: https://www.prenotarifugi.cai.it/dettaglio/Rifugio-Cibrario/?id=5759' \
  -H 'Origin: https://www.prenotarifugi.cai.it' \
  -H 'X-Requested-With: XMLHttpRequest' \
  -H 'User-Agent: Mozilla/5.0'
```

Response-Schema:

```json
{
  "status": "success",
  "response": [
    { "day": 1, "available": true, "type": "open" },
    { "day": 2, "available": false, "type": "full" },
    { "day": 3, "available": false, "type": "closed" }
  ]
}
```

Beobachtete `type`-Werte:

- `open`
- `full`
- `closed`

Verifiziert:

- `people` beeinflusst die Antwort
- `month` und `year` beeinflussen die Antwort

Beispiel aus Tests für `shelterId=5759`:

- `month=7&year=2026&people=1` -> 30x `open`, 1x `full`
- `month=7&year=2026&people=4` -> 30x `open`, 1x `full`
- `month=7&year=2026&people=8` -> 31x `full`

### 3. Filter-Metadaten

```text
GET https://booking.prenotarifugi.cai.it/backend/web/api/1.0/it/json/get/shelter/attributes?for=getByAttributes
```

Verifiziert:

- liefert `type_id`
- liefert `tags_id`
- liefert `path_id`

Beispiel:

```bash
curl -sG \
  'https://booking.prenotarifugi.cai.it/backend/web/api/1.0/it/json/get/shelter/attributes' \
  --data-urlencode 'for=getByAttributes' \
  -H 'Referer: https://www.prenotarifugi.cai.it/cerca-e-prenota/' \
  -H 'Origin: https://www.prenotarifugi.cai.it' \
  -H 'X-Requested-With: XMLHttpRequest' \
  -H 'User-Agent: Mozilla/5.0'
```

Nützlich für:

- numerische Trail-/Path-IDs
- Service-/Tag-IDs
- Unterkunftstypen

## Route-/Trail-API

Zusätzlicher Endpunkt auf der Suchseite:

```text
GET https://booking.prenotarifugi.cai.it/backend/web/api/1.0/it/json/get/hikingroute/byAttributes
```

Hinweis:

- Der Call mit `attribute[trails]=Alta-via-delle-Valli-di-Lanzo` erzeugte einen Backend-Fehler.
- Der Endpunkt erwartet offenbar numerische IDs, nicht Slugs/Namen.
- Der Test mit `attribute[trails]=373` war syntaktisch erfolgreich, lieferte aber `0` Ergebnisse.
- Für einen ersten Bettencheck-Connector ist dieser Teil nicht kritisch und kann später separat verifiziert werden.

## Frontend-/Backend-Hinweise

Zusätzlich im Frontend gefunden:

- `GET /frontend/web/user-management/auth/get-web-user`
- `GET /frontend/web/book/cart/ping-order`
- `GET /frontend/web/book/cart/delete-cart`

Diese sind eher Session-/Cart-bezogen und für Availability-Sync vermutlich nicht nötig.

## Empfohlener Integrationsansatz

### Für Bettencheck

1. Hüttenkatalog einmalig oder periodisch über `shelter/byAttributes` ziehen.
2. Pro Hütte Verfügbarkeit über `shelter/calendar/{id}` abrufen.
3. Für jeden relevanten Monat `people` explizit setzen.
4. `open/full/closed` auf unser internes Availability-Modell mappen.
5. Immer browserartige Header mitsenden.

### Warum dieser Ansatz funktioniert

- Kein HTML-Scraping für Availability nötig
- Monatsweise, strukturierte JSON-Antworten
- Reagiert direkt auf Personenzahl
- Reproduzierbar per `curl`

## Offene Punkte

- Ob `byAttributes` zusätzlich eine stabile aggregierte `disponibilita` liefern kann
- Wie Trail-Filter exakt an `shelter/byAttributes` übergeben werden müssen
- Ob Rate-Limits / WAF bei größeren Volumina aggressiver werden

## Empfehlung für die Implementierung

Minimal robuster V1:

- Discovery: `shelter/byAttributes`
- Availability: `calendar/{id}?people={n}&month={m}&year={y}`
- Header-Template zentral kapseln
- Retry + leichtes Rate-Limiting einbauen
- Trail-Filter erst in V2 ergänzen
