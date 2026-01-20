# Bettencheck - API Scraper Collection

Sammlung von API-Scrapern zur automatischen Verfügbarkeitsprüfung verschiedener Buchungsplattformen.

## Struktur

```
.
├── .github/
│   └── workflows/           # GitHub Actions Workflows
│       └── check-hut-availability.yml
├── scrapers/
│   └── hut-reservation/     # Hüttenbuchungen (hut-reservation.org)
│       ├── check-availability.sh
│       ├── availability-results/
│       └── README.md
└── README.md
```

## Verfügbare Scraper

### 1. Hut Reservation (`scrapers/hut-reservation/`)

Prüft Hüttenverfügbarkeit auf hut-reservation.org.

- **Plattform:** [hut-reservation.org](https://www.hut-reservation.org)
- **Hütten:** Braunschweiger Hütte, Martin-Busch-Hütte
- **Intervall:** Alle 3 Stunden
- **Workflow:** `.github/workflows/check-hut-availability.yml`
- **Dokumentation:** [scrapers/hut-reservation/README.md](scrapers/hut-reservation/README.md)

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
