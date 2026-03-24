# CAI Prenota Rifugi Ingestion Plan

Stand: 2026-03-24

## Ziel

Wir binden `CAI Prenota Rifugi` als neuen Availability-Provider an, sodass:

- CAI-Hütten zuverlässig entdeckt werden
- für jede CAI-Hütte Tagesverfügbarkeit in `availability_daily` landet
- möglichst dieselben Hut-Metadaten wie bei den bestehenden Scrapern in `huts` gepflegt werden
- wir in V1 gezielt mit Hütten in der Alpenregion starten

## Ausgangslage

Bereits verifiziert:

- Discovery läuft über `GET /api/1.0/it/json/get/shelter/byAttributes`
- Tagesverfügbarkeit läuft über `GET /api/1.0/json/get/shelter/calendar/{shelterId}`
- die API verlangt browserartige Header, sonst kommt `403`
- `calendar` liefert pro Tag stabile Statuswerte: `open`, `full`, `closed`
- `people` beeinflusst die Antwort und muss bewusst gesetzt werden

Bereits im Repo vorhanden:

- Scraper-Muster unter `scrapers/hut-reservation/` und `scrapers/huettenholiday/`
- gemeinsame Normalisierung in `scripts/lib/normalize.mjs`
- gemeinsamer Upsert nach Supabase in `scripts/normalize-and-upsert.mjs`
- Provider-Target-Listen in `scripts/build-live-target-lists.mjs`

## Produktentscheidung für V1

### Empfehlung

V1 soll **alle CAI-Hütten discovern, lokal auf "alpin" filtern und dann nur diese Hütten weiterverarbeiten**.

Warum:

- die Trail-/Path-Filter der Plattform sind noch nicht sauber verifiziert
- der Discovery-Endpoint liefert bereits genügend Metadaten für einen robusten lokalen Filter
- wir entkoppeln uns damit von einer unklaren Backend-Filtersemantik

### Alpine-Definition für V1

Empfohlene V1-Heuristik:

1. Hütte liegt in einer italienischen Alpenregion
2. und hat brauchbare Hütten-Metadaten wie Koordinaten oder Höhenlage

Pragmatische Allowlist für V1:

- Valle d'Aosta
- Piemonte
- Lombardia
- Trentino-Alto Adige / Alto Adige / Sudtirol / Südtirol
- Veneto
- Friuli-Venezia Giulia

Bewusste V1-Auslassung:

- Liguria und Emilia-Romagna nur dann, wenn wir später einen präziseren Geo-Filter ergänzen

Hinweis:
Das ist eine bewusste Produktheuristik, keine exakte amtliche Alpenabgrenzung. Für Bettencheck ist sie als Startpunkt gut genug und deutlich stabiler als ein halb verstandener API-Filter.

## Architekturvorschlag

```text
CAI discovery API
  -> Roh-Hüttenkatalog als JSON
  -> lokaler Alpine-Filter
  -> per shelterId Monatskalender abrufen
  -> provider-spezifisches Ergebnisformat schreiben
  -> normalize-and-upsert
  -> Supabase: huts + availability_daily + scrape_runs
```

## Empfohlenes Zielbild im Repo

Neue Dateien:

- `scrapers/cai-prenota-rifugi/discover-huts.mjs`
- `scrapers/cai-prenota-rifugi/check-availability.mjs`
- `scrapers/cai-prenota-rifugi/lib/api.mjs`
- `scrapers/cai-prenota-rifugi/lib/filter-alpine.mjs`
- `scrapers/cai-prenota-rifugi/README.md`

Zu erweiternde Dateien:

- `scripts/lib/normalize.mjs`
- `scripts/normalize-and-upsert.mjs`
- optional später `scripts/build-live-target-lists.mjs`

## Datenfluss im Detail

### 1. Discovery

`discover-huts.mjs` zieht seitenweise den gesamten Katalog über `shelter/byAttributes`.

Pro Hütte speichern wir:

- `id`
- `slug`
- `name`
- `beds`
- `price`
- `paths`
- `services`
- `addresses`
- `addresses[].coords`
- `img.file`
- alle weiteren relevanten Rohfelder unverändert unter `raw`

Empfohlene Rohdatei:

- `scrapers/cai-prenota-rifugi/data/shelters.raw.json`

Empfohlene gefilterte Datei:

- `scrapers/cai-prenota-rifugi/data/shelters.alpine.json`

### 2. Alpine-Filter

`filter-alpine.mjs` klassifiziert eine Hütte als alpin, wenn mindestens eine der Bedingungen erfüllt ist:

- Region/Adresse matcht die Allowlist
- ein `path` oder Namensfeld deutet klar auf eine Alpenregion hin
- Koordinaten liegen im definierten Bounding-Box-Korridor der italienischen Alpen

Empfohlene Reihenfolge:

1. String-Match auf Region/Adresse
2. Fallback: Geo-Heuristik über Latitude/Longitude
3. Wenn beides fehlt: Hütte verwerfen und im Report als `unclassified` markieren

Wichtig:

- Unklassifizierte Hütten nicht stillschweigend verwerfen
- immer Zähler mitführen: `total`, `alpine`, `nonAlpine`, `unclassified`

## Verfügbarkeitsstrategie

### Primäre Abfrage

Für jede alpine Hütte:

- `GET /calendar/{shelterId}`
- mit `people=1`
- für jeden Zielmonat der Saison

### Warum `people=1`

Empfehlung:

- V1 nutzt `people=1` als kleinste robuste Probe auf Bettverfügbarkeit

Begründung:

- die API reagiert auf Gruppengröße
- mit `people=1` messen wir, ob an dem Tag grundsätzlich noch buchbare Kapazität vorhanden ist
- das passt besser zu unserem aktuellen Zielsystem als eine zufällige größere Gruppengröße

Grenze:

- `people=1` liefert keine exakte Bettanzahl
- wir können deshalb für CAI in V1 nur **Status-sicher**, aber nicht **Bed-count-sicher** sein

### Mapping in unser internes Modell

Kalenderstatus auf `availability_daily`:

- `open` -> `status=available`
- `full` -> `status=unavailable`
- `closed` -> `status=closed`

`available_beds`:

- V1: `null`

`confidence`:

- V1: `inferred`

Wichtig:

- CAI ist in V1 ein Status-Provider, kein exakter Betten-Provider
- das ist konsistent mit dem bestehenden Normalisierungsmodell, solange wir das sauber markieren

## Empfohlenes Provider-Ausgabeformat

Damit der Source-Output möglichst nah an `huettenholiday` liegt, sollte `check-availability.mjs` pro Run eine Datei mit dieser Struktur schreiben:

```json
{
  "scrapedAt": "2026-03-24T12:00:00.000Z",
  "source": "cai-prenota-rifugi",
  "peopleProbe": 1,
  "months": [
    { "year": 2026, "month": 6 },
    { "year": 2026, "month": 7 }
  ],
  "cabins": [
    {
      "id": 5759,
      "name": "Rifugio Cibrario",
      "metadata": {
        "slug": "Rifugio-Cibrario",
        "detailPageUrl": "https://www.prenotarifugi.cai.it/dettaglio/Rifugio-Cibrario/?id=5759",
        "bookingUrl": "https://www.prenotarifugi.cai.it/dettaglio/Rifugio-Cibrario/?id=5759",
        "websiteUrl": null,
        "region": "Piemonte",
        "country": "IT",
        "latitude": 45.3,
        "longitude": 7.2,
        "sleepingPlacesTotal": 40,
        "priceFromEur": 25,
        "paths": [],
        "services": [],
        "raw": {}
      },
      "availability": [
        {
          "date": "2026-07-01",
          "status": "available",
          "providerStatus": "open",
          "availablePlaces": null,
          "totalPlaces": null
        }
      ]
    }
  ]
}
```

Warum dieses Format:

- ähnlich genug zu `huettenholiday`, damit die Normalize-Stufe schlank bleibt
- reich genug für spätere Debugbarkeit
- kapselt die CAI-Spezifika wie `providerStatus` und `peopleProbe`

## Auswirkungen auf Normalize / Upsert

### `scripts/lib/normalize.mjs`

Neue Source ergänzen:

- `cai-prenota-rifugi`

Neue Normalizer-Regeln:

- iteriere `cabins[]`
- mappe `availability[].status`
- setze `available_beds = null`
- setze `confidence = "inferred"`

### `scripts/normalize-and-upsert.mjs`

Neue Default-Input-Dir:

- `scrapers/cai-prenota-rifugi/availability-results`

Zusätzlich analog zu `huettenholiday` eine optionale Huts-Synchronisierung:

- `provider = "cai-prenota-rifugi"`
- `provider_ref = shelterId`
- `booking_platform = "prenotarifugi.cai.it"`
- `name`
- `booking_url`
- `website_url`, falls im Payload vorhanden
- `elevation_m`, sofern herleitbar
- `sleeping_places_total = beds`
- `price_from_eur = price`
- `latitude`, `longitude`
- `source_url`

Empfehlung:

- die Huts-Upserts für CAI direkt in V1 mitbauen
- sonst haben wir Availability-Daten ohne stabile Provider-Zuordnung in `huts`

## Umgang mit bestehenden Live-Target-Listen

### Empfehlung für V1

`scripts/build-live-target-lists.mjs` vorerst **nicht** erweitern.

Stattdessen:

- CAI läuft in V1 als eigener Vollscan über den CAI-Katalog
- die alpine Filterung passiert provider-intern

Warum:

- CAI ist discovery-getrieben, nicht route-stage-getrieben
- wir vermeiden, schon vor dem ersten erfolgreichen Sync neue Abhängigkeiten in die Target-List-Logik einzubauen

### V2

Später können wir CAI-Hütten in `huts` an Routen hängen und dann optional selektiver fahren.

## Saison- und Run-Strategie

Empfohlene Standard-Saison für V1:

- aktueller Monat bis plus 5 Monate

Falls wir lieber explizit starten wollen:

- Juni bis Oktober

Empfehlung:

- Code so bauen, dass beides geht
- Default: rollierendes Fenster von 6 Monaten

Warum:

- robuster für wiederkehrende Runs
- vermeidet harte Saisonlogik im Code

## Fehler- und Ausfallstrategie

### Erwartbare Fehler

- `403` bei fehlenden Headern
- temporäre WAF-/Rate-Limit-Blockaden
- einzelne fehlerhafte Hüttenpayloads
- Monate ohne Daten
- unvollständige Koordinaten oder Regionsfelder

### Empfohlene Maßnahmen

- gemeinsamer Header-Builder in `lib/api.mjs`
- Request-Retry mit Backoff für `429`, `5xx`, Netzwerkfehler
- kleine Parallelität, z. B. 2 bis 4 gleichzeitige Hüttencalls
- per-Hütte Fehler sammeln statt Gesamt-Run abzubrechen
- Run-Metadaten mit Erfolgs-/Fehlerzählern versehen

## Testplan

### Unit-nah

- Alpine-Filter mit Fixtures:
  - klare Alpenregion
  - klare Nicht-Alpenregion
  - fehlende Region, aber passende Koordinaten
  - unklassifizierbar

- Kalender-Mapping:
  - `open`
  - `full`
  - `closed`

### Integration-nah

- ein Discovery-Fixture mit 2 bis 3 echten CAI-Hütten
- ein Kalender-Fixture über mindestens zwei Monate
- Normalizer erzeugt erwartete `availability_daily`-Rows

### Smoke-Test

- 1 echter Run gegen 3 bis 5 bekannte alpine CAI-Hütten
- Ergebnis prüfen:
  - JSON geschrieben
  - `normalize-and-upsert` erzeugt Rows
  - `huts`-Upsert klappt

## Edge Cases

- Hütte ist im Discovery-Katalog, aber Kalender antwortet leer
- Hütte hat keine Koordinaten, aber klaren Regionsnamen
- Hütte ist alpin, aber außerhalb des groben Geo-Bounds
- Hütte hat `beds`, aber Kalender ist für alle Tage `closed`
- gleiche Hütte erscheint in mehreren Runs mit leicht anderen Metadaten

## Nicht-Ziele für V1

- exakte freie Bettenzahl pro Tag
- stabiler Trail-/Path-Filter über die offizielle API
- direkte Zuordnung jeder CAI-Hütte zu bestehenden Bettencheck-Routen
- HTML-Scraping der Detailseiten als Primärquelle

## Empfohlene Umsetzungsreihenfolge

1. `lib/api.mjs` mit Headern, Pagination, Retry und Kalender-Fetch bauen
2. `discover-huts.mjs` für Vollkatalog plus Alpine-Klassifikation bauen
3. `check-availability.mjs` für Monatskalender und Provider-Output bauen
4. `normalize.mjs` um `cai-prenota-rifugi` erweitern
5. `normalize-and-upsert.mjs` um CAI-Input-Dir und Huts-Upsert erweitern
6. Smoke-Test mit kleinem Alps-Sample
7. erst danach optional Saisons, Scheduling und Route-Anbindung verfeinern

## Empfehlung

Die beste V1 ist:

- Voll-Discovery über CAI
- lokaler Alpenfilter
- Kalenderprobe mit `people=1`
- Status-Only-Normalisierung
- sofortiger Huts-Upsert

Das ist die kleinste Lösung, die fachlich brauchbar ist und sauber in die bestehende Architektur passt.

## Offene Entscheidungen

1. Sollen wir für V1 wirklich nur alpine CAI-Hütten persistieren, oder den Vollkatalog speichern und erst downstream filtern?
   Empfehlung: Vollkatalog als Rohdatei speichern, aber nur alpine Hütten nach `huts` und `availability_daily` weiterreichen.

2. Sollen wir das Zeitfenster rollierend oder saisonfest aufziehen?
   Empfehlung: rollierend 6 Monate, per CLI überschreibbar.

3. Sollen wir CAI direkt als regulären Provider im täglichen Lauf aktivieren?
   Empfehlung: erst nach einem manuellen Smoke-Test mit kleinem Alps-Sample.
