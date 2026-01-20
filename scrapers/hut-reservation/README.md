# Hut Reservation Scraper

Prüft die Verfügbarkeit von Hütten auf [hut-reservation.org](https://www.hut-reservation.org) für die Bergsaison.

## Konfiguration

**Geprüfte Hütten:**
- Braunschweiger Hütte (ID: 366)
- Martin-Busch-Hütte (ID: 476)

**Saison:** 1. Juni - 1. Oktober (automatische Jahresauswahl)

## Ausführung

### Lokal
```bash
bash check-availability.sh
```

### GitHub Actions
- **Automatisch:** Alle 3 Stunden
- **Manuell:** Actions Tab → "Check Hut Availability" → "Run workflow"

## Output

Das Script erstellt JSON-Dateien im Verzeichnis `availability-results/`:

```json
{
  "hutId": 366,
  "hutName": "Braunschweiger-Huette",
  "checkedAt": "2026-01-20T19:21:41Z",
  "season": {
    "start": "2026-06-01",
    "end": "2026-10-01"
  },
  "totalDaysChecked": 122,
  "availableCount": 108,
  "closedCount": 14,
  "availableDays": [...],
  "closedDays": [...],
  "allDays": [...]
}
```

## Dependencies

- `curl` - API-Aufrufe
- `jq` - JSON-Parsing

Beide Tools sind auf GitHub Runners vorinstalliert.

## API Endpoint

```
GET https://www.hut-reservation.org/api/v1/reservation/getHutAvailability?hutId={id}&step=WIZARD
```
