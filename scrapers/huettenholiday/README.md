# Hüttenholiday Scraper

Prüft die Verfügbarkeit von Hütten auf [huetten-holiday.com](https://www.huetten-holiday.com) für die Bergsaison.

## Konfiguration

**Geprüfte Hütten:**
- Kemptner Hütte (Cabin ID: 27)
- Memminger Hütte (Cabin ID: 24)

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
      "name": "Kemptner Hütte",
      "metadata": {
        "sources": ["api", "website"],
        "slug": "kemptner-huette",
        "detailPageUrl": "https://www.huetten-holiday.com/huts/kemptner-huette",
        "websiteUrl": "https://www.kemptner-huette.de",
        "region": "Allgäuer Alpen",
        "country": "Deutschland",
        "altitude": 1844,
        "latitude": 47.313340234915444,
        "longitude": 10.327922453689553,
        "sleepingPlacesTotal": 182
      },
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
  - **metadata**: Hütten-Metadaten (API-first, Website-Fallback)
    - **sources**: Welche Quellen genutzt wurden (`api`, `website`)
    - **slug**, **detailPageUrl**, **websiteUrl**
    - **region**, **country**
    - **altitude**, **latitude**, **longitude**
    - **sleepingPlacesTotal**, **rooms**, **facilities**, **seasons**
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
- `node` - Parsing der eingebetteten Detailseiten-Metadaten

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

### Metadaten-Erhebung (API first, Website fallback)

1. API-Call `POST /cabins/search` (mit CSRF + Session), um Basisdaten zu erhalten.
2. Detailseite `/huts/{slug}` wird als Fallback/Ergänzung geparst (eingebettetes `:cabin="{...}"` JSON).
3. Metadaten werden pro Hütte in `cabins[].metadata` gespeichert.
4. Beim Workflow-Upsert werden diese Metadaten zusätzlich in die Tabelle `huts` geschrieben
   (u. a. `sleeping_places_total`, `latitude`, `longitude`, `email`, `website_url`).

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
