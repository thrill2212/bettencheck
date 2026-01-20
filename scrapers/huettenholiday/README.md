# Hüttenholiday Scraper

Prüft die Verfügbarkeit von Hütten auf [huetten-holiday.com](https://www.huetten-holiday.com) für die Bergsaison.

## Konfiguration

**Geprüfte Hütten:**
- Hütte 27 (Cabin ID: 27)
- Hütte 24 (Cabin ID: 24)

**Saison:** Juni - Oktober (automatische Jahresauswahl)
- Bei Datum nach 1. Oktober: Nächstes Jahr
- Sonst: Aktuelles Jahr

## Ausführung

### Lokal
```bash
bash check-availability.sh
```

### GitHub Actions
- **Automatisch:** Alle 3 Stunden
- **Manuell:** Actions Tab → "Check Hüttenholiday Availability" → "Run workflow"

## Output

Das Script erstellt JSON-Dateien im Verzeichnis `availability-results/`:

```json
{
  "scrapedAt": "2026-01-20T20:02:06Z",
  "cabins": [
    {
      "id": 27,
      "name": "Hütte 27",
      "availability": [
        {
          "date": "2026-06-05T00:00:00.000000Z",
          "totalPlaces": 180,
          "bookedPlaces": 79,
          "availablePlaces": 79
        }
      ]
    }
  ]
}
```

### Datenstruktur

- **scrapedAt**: Zeitstempel des Scraping-Durchlaufs (ISO 8601, UTC)
- **cabins**: Array mit Hütten-Daten
  - **id**: Cabin ID
  - **name**: Hüttenname
  - **availability**: Array mit Tagesverfügbarkeit
    - **date**: Datum (ISO 8601)
    - **totalPlaces**: Gesamtkapazität an diesem Tag
    - **bookedPlaces**: Bereits gebuchte Plätze
    - **availablePlaces**: Verfügbare Plätze

### Status-Indikatoren (GitHub Actions Summary)

- ✅ **Available**: >5 Plätze verfügbar
- ⚠️ **Low**: 1-5 Plätze verfügbar
- ❌ **Full**: Ausgebucht (0 Plätze)
- 🔒 **Closed**: Geschlossen (totalPlaces = 0)

## Dependencies

- `curl` - HTTP-Requests
- `jq` - JSON-Verarbeitung
- `grep`, `sed` - Text-Parsing

Alle Tools sind auf GitHub Runners vorinstalliert.

## Technische Details

### Session-Handling

Das Script verwendet Session-Cookies und CSRF-Token-Authentication:

1. Initiale GET-Request zu `/huts` → Cookies + CSRF-Token
2. POST-Requests mit Session-Cookies und `X-CSRF-TOKEN` Header

### API Endpoint

```
POST https://www.huetten-holiday.com/cabins/get-month-availability
Content-Type: application/json
X-CSRF-TOKEN: {token}
X-Requested-With: XMLHttpRequest

Payload:
{
  "cabinId": 27,
  "selectedMonth": {
    "monthNumber": 6,
    "year": 2026
  },
  "multipleCalendar": false
}
```

### Rate Limiting

- 500ms Delay zwischen Requests
- 3 Retry-Versuche bei fehlgeschlagenen Requests
- JSON-Validierung nach jedem Request

## Troubleshooting

### CSRF Token Fehler

Falls "CSRF token mismatch" Fehler auftreten:
- Session-Cookie und CSRF-Token müssen aus derselben Request stammen
- Script prüft automatisch Token-Validität

### Leere Resultate

- Prüfe, ob Website erreichbar ist
- Validiere CSRF-Token-Extraktion (kann bei HTML-Änderungen brechen)
- Prüfe API-Response-Format mit: `curl ... | jq .`

## Performance

**Lokale Ausführung:** ~30 Sekunden
- Session Init: ~1s
- 2 Hütten × 5 Monate = 10 Requests mit 500ms Delay: ~5s
- JSON-Verarbeitung: <1s

**GitHub Actions:** ~8-10 Sekunden total (inkl. Checkout und Upload)
