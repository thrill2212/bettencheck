# Hut Reservation Scraper

Prueft die Verfuegbarkeit von Huetten auf [hut-reservation.org](https://www.hut-reservation.org) fuer die Bergsaison.

## Was ist neu

- Der Availability-Run nutzt jetzt eine Hutliste aus `huts.json` (statt nur 2 hardcoded IDs).
- Pro Huette wird zusaetzlich `hutInfo/{hutId}` abgefragt.
- `hutInfo` wird lokal gecacht (Standard: 168h), um API-Requests deutlich zu reduzieren.
- Wenn verfuegbar, wird die Location aus `coordinates` als `latitude`/`longitude` gespeichert.
- IDs und Huettennamen werden separat in `hut-id-name-map.json` gepflegt.
- Optionaler Supabase-Sync schreibt die Daten direkt in:
  - `routes`
  - `huts`
  - `route_stages`
  - `availability_daily`
  - `scrape_runs`

## 1) Hutliste aufbauen/aktualisieren

Einmalig oder bei Bedarf ausfuehren:

```bash
bash discover-huts.sh
```

Wichtige Optionen:

```bash
START_ID=1 END_ID=900 REQUEST_DELAY_SECONDS=0.10 MAX_RETRIES=4 bash discover-huts.sh
```

Outputs:

- `huts.json` (vollstaendige Metadaten je Huette)
- `hut-id-name-map.json` (nur `hutId` + `hutName`)

## 2) Availability pruefen

```bash
bash check-availability.sh
```

Optionale Parameter:

```bash
HUT_LIST_FILE=huts.json REQUEST_DELAY_SECONDS=0.10 bash check-availability.sh
```

Wichtige Optimierungs-Parameter:

```bash
HUT_INFO_CACHE_DIR=.cache/hut-info \
HUT_INFO_CACHE_TTL_HOURS=168 \
REQUEST_DELAY_SECONDS=0.40 \
MAX_RETRIES=6 \
BLOCK_COOLDOWN_SECONDS=45 \
bash check-availability.sh
```

### Tour-basierter Voll-Lauf (empfohlen)

Huettenliste direkt aus dem Tour-Mapping erzeugen:

```bash
node generate-huts-from-tour-coverage.mjs \
  --input ./tour-id-coverage.json \
  --output ./huts.from-coverage.json

HUT_LIST_FILE=./huts.from-coverage.json \
REQUEST_DELAY_SECONDS=0.05 \
bash check-availability.sh
```

Optionaler Live-Sync nach Supabase:

```bash
SUPABASE_URL=... \
SUPABASE_SERVICE_ROLE_KEY=... \
TOUR_COVERAGE_FILE=./tour-id-coverage.json \
bash check-availability.sh
```

Die Datei `tour-id-coverage.json` dient als Mapping (`routeId -> huts[ohrsHutId]`) fuer `route_stages`.

## GitHub Actions

- **Automatisch:** Alle 3 Stunden
- **Manuell:** Actions Tab -> "Check Hut Availability" -> "Run workflow"

## Output

Das Script erstellt JSON-Dateien im Verzeichnis `availability-results/`:

```json
{
  "hutId": 366,
  "hutName": "Braunschweiger Huette",
  "source": "hut-reservation",
  "sourceHutRef": "366",
  "bookingUrl": "https://www.hut-reservation.org/reservation/book-hut/366/wizard",
  "checkedAt": "2026-02-20T19:21:41Z",
  "season": {
    "start": "2026-06-01",
    "end": "2026-10-01"
  },
  "hutInfo": {
    "tenantCode": "DAV",
    "altitude": "2.759m"
  },
  "location": {
    "rawCoordinates": "46.93540/10.91048",
    "latitude": 46.9354,
    "longitude": 10.91048
  },
  "totalDaysChecked": 122,
  "availableCount": 108,
  "closedCount": 14,
  "availableDays": [...],
  "closedDays": [...],
  "allDays": [...]
}
```

Wenn Supabase-Credentials gesetzt sind, wird danach automatisch `upsert-supabase.mjs` ausgefuehrt.
Der Upsert verarbeitet dabei nur die neueste Availability-Datei pro Huette (schneller bei grossen historischen Ordnern).

## Dependencies

- `curl` - API-Aufrufe
- `jq` - JSON-Parsing

Beide Tools sind auf GitHub Runners vorinstalliert.

## API Endpoints

```text
GET https://www.hut-reservation.org/api/v1/reservation/hutInfo/{id}
GET https://www.hut-reservation.org/api/v1/reservation/getHutAvailability?hutId={id}&step=WIZARD
```
