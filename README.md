# Bettencheck - API Scraper Collection

Sammlung von API-Scrapern zur automatischen Verfügbarkeitsprüfung verschiedener Buchungsplattformen.

## Struktur

```
.
├── .github/
│   └── workflows/           # GitHub Actions Workflows
│       ├── check-hut-availability.yml
│       ├── check-huettenholiday-availability.yml
│       └── check-casablanca-availability.yml
├── scrapers/
│   ├── hut-reservation/     # Hüttenbuchungen (hut-reservation.org)
│   │   ├── discover-huts.sh
│   │   ├── check-availability.sh
│   │   ├── upsert-supabase.mjs
│   │   ├── huts.json
│   │   ├── hut-id-name-map.json
│   │   ├── tour-id-coverage.json
│   │   ├── availability-results/
│   │   └── README.md
│   ├── huettenholiday/      # Hüttenbuchungen (huetten-holiday.com)
│   │   ├── check-availability.sh
│   │   ├── availability-results/
│   │   └── README.md
│   └── casablanca/          # Berghütten (Casablanca System)
│       ├── check-availability.sh
│       ├── availability-results/
│       └── README.md
└── README.md
```

## Verfügbare Scraper

### 1. Hut Reservation (`scrapers/hut-reservation/`)

Prüft Hüttenverfügbarkeit auf hut-reservation.org.

- **Plattform:** [hut-reservation.org](https://www.hut-reservation.org)
- **Hütten:** aus `tour-id-coverage.json` (empfohlen) oder `huts.json`
- **Intervall:** Alle 3 Stunden
- **Workflow:** `.github/workflows/check-hut-availability.yml`
- **Dokumentation:** [scrapers/hut-reservation/README.md](scrapers/hut-reservation/README.md)
- **Live-Sync:** Optionaler Upsert nach Supabase via `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
- **Optimierungen:**
  - Robustes Retry/Backoff bei `403/429` (WAF-Block)
  - `hutInfo`-Cache mit TTL (weniger API-Requests)
  - Supabase-Upsert verarbeitet nur die neueste Datei je Hütte (schneller bei großem History-Ordner)

#### Empfohlener produktiver Flow

```bash
cd scrapers/hut-reservation

node generate-huts-from-tour-coverage.mjs \
  --input ./tour-id-coverage.json \
  --output ./huts.from-coverage.json

HUT_LIST_FILE=./huts.from-coverage.json \
FETCH_HUT_INFO=false \
REQUEST_DELAY_SECONDS=0.12 \
MAX_RETRIES=6 \
RETRY_DELAY_SECONDS=6 \
BLOCK_COOLDOWN_SECONDS=45 \
HUT_INFO_CACHE_TTL_HOURS=168 \
TOUR_COVERAGE_FILE=./tour-id-coverage.json \
bash check-availability.sh
```

Für Live-Sync zusätzlich:

```bash
export SUPABASE_URL=...
export SUPABASE_SERVICE_ROLE_KEY=...
```

### 2. Hüttenholiday (`scrapers/huettenholiday/`)

Prüft Hüttenverfügbarkeit auf huetten-holiday.com.

- **Plattform:** [huetten-holiday.com](https://www.huetten-holiday.com)
- **Hütten:** Hütte 27, Hütte 24
- **Intervall:** Alle 3 Stunden
- **Workflow:** `.github/workflows/check-huettenholiday-availability.yml`
- **Dokumentation:** [scrapers/huettenholiday/README.md](scrapers/huettenholiday/README.md)

### 3. Casablanca (`scrapers/casablanca/`)

Prüft Bettenverfügbarkeit auf Casablanca Buchungssystem.

- **Plattform:** [Casablanca Booking System](https://frontend.casablanca.at/)
- **Resort:** A_6511_SKIHU (konfigurierbar)
- **Intervall:** Alle 6 Stunden
- **Workflow:** `.github/workflows/check-casablanca-availability.yml`
- **Features:** Binary Search Algorithmus, saisonale Suche (Juni-Oktober)
- **Dokumentation:** [scrapers/casablanca/README.md](scrapers/casablanca/README.md)

## Neuen Scraper hinzufügen

### 1. Ordnerstruktur erstellen

```bash
mkdir -p scrapers/[plattform-name]
cd scrapers/[plattform-name]
```

### 2. Script erstellen

Erstelle ein Bash-Script (oder andere Sprache):

```bash
#!/bin/bash
set -e

# Change to script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Deine Scraper-Logik hier...
```

**Best Practices:**
- Output in `availability-results/` oder `results/` Verzeichnis
- Verwende GitHub Actions-kompatible Dateinamen (keine `:` erlaubt)
- Generiere GitHub Actions Summary via `$GITHUB_STEP_SUMMARY`
- Nutze vorinstallierte Tools: `curl`, `jq`, `python3`, `node`

### 3. GitHub Workflow erstellen

Erstelle `.github/workflows/[plattform-name].yml`:

```yaml
name: Check [Platform] Availability

on:
  schedule:
    - cron: '0 */6 * * *'  # Alle 6 Stunden
  workflow_dispatch:

jobs:
  check-availability:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Run scraper
        run: bash scrapers/[plattform-name]/check-availability.sh

      - name: Upload results
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: [plattform-name]-results-${{ github.run_number }}
          path: scrapers/[plattform-name]/results/*.json
          retention-days: 90
```

### 4. README erstellen

Erstelle `scrapers/[plattform-name]/README.md` mit:
- Beschreibung der Plattform
- Konfiguration (IDs, Daten, etc.)
- Output-Format
- Dependencies
- API-Dokumentation

### 5. Testen und commiten

```bash
# Lokal testen
bash scrapers/[plattform-name]/check-availability.sh

# Commiten
git add .
git commit -m "Add [platform-name] scraper"
git push
```

## GitHub Actions

Alle Scraper laufen automatisch als GitHub Actions:

- **Actions Tab:** Siehe alle Workflow-Runs
- **Artifacts:** Download der JSON-Ergebnisse
- **Summary:** Schnellübersicht in jedem Run
- **Manual Trigger:** "Run workflow" Button für sofortige Ausführung

### Relevante Secrets für Live-Sync

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
## Artifacts

Ergebnisse werden als Artifacts gespeichert:
- **Retention:** 90 Tage
- **Format:** JSON
- **Naming:** `[scraper-name]-results-[run-number]`

## Dependencies

Die meisten GitHub Runner haben vorinstalliert:
- `bash`, `curl`, `jq`
- `python3`, `pip`
- `node`, `npm`
- `git`

Für spezielle Dependencies, siehe den jeweiligen Scraper.

## Live-Daten in Website bringen (Kurzcheckliste)

1. Scraper in `scrapers/hut-reservation` mit Tour-Coverage laufen lassen.
2. Prüfen, dass `upsert-supabase.mjs` am Ende `upserted: true` ausgibt.
3. In der Website (`huettentouren_org`) `npm run check:live-routes` ausführen.
4. Erwartung: keine `missingHutIds`, alle Zielrouten `isReady: true`.

## Beispiele für weitere Scraper

Mögliche zukünftige Scraper:
- Booking.com Verfügbarkeit
- Airbnb Preise
- Bahn/Flug Verfügbarkeit
- Hotel-Vergleichsportale
- Event-Tickets
- Campingplätze

## Lizenz

Für persönlichen Gebrauch. Bitte respektiere die Terms of Service der jeweiligen Plattformen.
