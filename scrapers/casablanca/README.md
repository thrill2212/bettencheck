# Casablanca API Scraper

Automatisierter Availability-Checker für die Casablanca Buchungsplattform. Prüft Bettenverfügbarkeit für Berghütten und Hotels.

## 📋 Übersicht

Dieser Scraper nutzt einen Binary-Search-Algorithmus, um effizient die genaue Anzahl verfügbarer Betten für jeden Tag zu ermitteln.

**Plattform:** [Casablanca Booking System](https://frontend.casablanca.at/)

## 🎯 Features

- **Binary Search Optimierung**: Findet exakte Bettenanzahl (1-10) mit nur 1-4 API-Calls pro Datum
- **Rate Limiting**: 0.5s Delay zwischen Requests (ca. 120 req/min)
- **Automatische Retries**: Bis zu 3 Versuche bei Fehlern
- **Test Mode**: Schnelles Testen mit nur 7 Tagen
- **Saisonale Suche**: Prüft automatisch die Berghüttensaison (Juni - Oktober)
- **GitHub Actions**: Läuft automatisch alle 6 Stunden

## 🏗️ Architektur

### Bash-Script ohne Dependencies

Das Script benötigt nur:
- ✅ `bash` (vorinstalliert)
- ✅ `curl` (vorinstalliert)
- ✅ `jq` (vorinstalliert auf GitHub Runners)

Keine `npm install`, keine `node_modules`, keine Package-Dependencies!

## ⚙️ Konfiguration

### Umgebungsvariablen

```bash
# Resort Configuration
RESORT_ID="A_6511_SKIHU"    # Die Resort-ID aus der Casablanca URL
COMPANY="c_COMP1"            # Die Company-ID aus der Casablanca URL

# Test Mode
TEST_MODE="false"            # Auf "true" setzen für Test mit 7 Tagen
```

### Unterstützte Resorts

Beliebige Casablanca-Resorts können konfiguriert werden. Die IDs findest du in der URL der Buchungsseite:

```
https://frontend.casablanca.at/de/api/{RESORT_ID}/{COMPANY}/IBE/GetBookability
```

**Beispiele:**
- **Skihütte**: `A_6511_SKIHU` / `c_COMP1`
- Weitere Resorts können durch Ändern der IDs hinzugefügt werden

## 🚀 Verwendung

### Lokal ausführen

```bash
# Standard-Modus (ganze Saison Juni-Oktober)
bash check-availability.sh

# Test-Modus (nur 7 Tage)
TEST_MODE=true bash check-availability.sh

# Mit Custom Resort
RESORT_ID="A_1234_TEST" COMPANY="c_TEST" bash check-availability.sh
```

### GitHub Actions

Die GitHub Action läuft automatisch:
- **Zeitplan**: Alle 6 Stunden (`0 */6 * * *`)
- **Manuell**: Über "Actions" → "Run workflow"

#### Manual Trigger Optionen

Im GitHub UI kannst du beim manuellen Trigger einstellen:
- **Test Mode**: Nur 7 Tage prüfen (schneller)
- **Resort ID**: Alternative Resort-ID verwenden
- **Company**: Alternative Company-ID verwenden

## 📊 Output Format

### Results JSON

Gespeichert in `availability-results/results-YYYY-MM-DDTHHMMSSZ.json`:

```json
[
  {
    "date": "2026-06-01",
    "availableBeds": 5,
    "isAvailable": true,
    "checkedAt": "2026-01-20T21:00:00Z"
  },
  {
    "date": "2026-06-02",
    "availableBeds": 0,
    "isAvailable": false,
    "checkedAt": "2026-01-20T21:00:15Z"
  },
  {
    "date": "2026-06-03",
    "availableBeds": 10,
    "isAvailable": true,
    "checkedAt": "2026-01-20T21:00:30Z"
  }
]
```

### Felder Erklärung

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `date` | string | Datum im Format YYYY-MM-DD |
| `availableBeds` | number | Anzahl verfügbarer Betten (0-10+) |
| `isAvailable` | boolean | `true` wenn mindestens 1 Bett verfügbar |
| `checkedAt` | string | ISO-8601 Timestamp der Prüfung |

### GitHub Actions Summary

Nach jedem Run wird eine Übersicht generiert:

```markdown
# Casablanca Availability Check Results

**Resort:** A_6511_SKIHU (c_COMP1)
**Season:** 2026-06-01 to 2026-10-01
**Checked at:** 2026-01-20T21:00:00Z

| Total Days | Available Days | Unavailable Days | Total Beds Available |
|------------|----------------|------------------|---------------------|
| 123        | 89             | 34               | 456                 |

## Sample Available Dates
- **2026-06-15**: 7 beds
- **2026-07-20**: 10 beds
- **2026-08-05**: 3 beds
```

## 🔍 Wie es funktioniert

### 1. Saisonberechnung

```bash
# Aktuelles Datum: 2026-01-20
# → Prüfe Saison 2026: 2026-06-01 bis 2026-10-01

# Aktuelles Datum: 2026-11-15
# → Prüfe Saison 2027: 2027-06-01 bis 2027-10-01
```

### 2. Binary Search Algorithmus

Für jedes Datum:

```
1. Prüfe 10 Betten
   ├─ Verfügbar? → Fertig! (10+ Betten)
   └─ Nicht verfügbar? → Binary Search (1-9)

2. Binary Search
   ├─ Start: min=1, max=9
   ├─ Prüfe mid=(1+9)/2=5
   ├─ Verfügbar? → min=6, max=9
   └─ Nicht verfügbar? → min=1, max=4
   └─ Wiederhole bis min > max
```

**Beispiel:**
- Datum hat 7 Betten verfügbar
- API-Calls: 10 (nicht verfügbar) → 5 (verfügbar) → 7 (verfügbar) → 8 (nicht verfügbar)
- **Ergebnis: 7 Betten mit nur 4 Requests** statt 10!

### 3. API Request Format

**Endpoint:**
```
POST https://frontend.casablanca.at/de/api/{RESORT_ID}/{COMPANY}/IBE/GetBookability
```

**Payload (URL-encoded):**
```
StartDate=2026-06-01
&Rooms[0][Index]=1&Rooms[0][Adults]=1&Rooms[0][Children]=0
&Rooms[1][Index]=2&Rooms[1][Adults]=1&Rooms[1][Children]=0
...
&SelectedRoomtypeId=&AllCompanies=false
```

Die Anzahl der `Rooms`-Einträge entspricht der Anzahl der geprüften Betten.

**Response:**
```json
[
  {
    "Bookable": true,
    "Available": true,
    "EffectiveDateString": "2026-06-01",
    "Availability": 7,
    "MinLOS": 1,
    ...
  }
]
```

Ein Tag ist nur dann buchbar, wenn **beide** Felder `true` sind:
- `Bookable == true`
- `Available == true`

## ⚡ Performance

### Requests pro Datum

| Szenario | Binary Search Calls | Total Calls |
|----------|---------------------|-------------|
| 10+ Betten | 0 | 1 |
| 5 Betten | ~3 | 4 |
| 0 Betten | ~4 | 5 |
| **Durchschnitt** | **~3** | **~4** |

### Laufzeit

- **Pro Datum**: ~2-3 Sekunden (inkl. Rate Limiting)
- **123 Tage (Juni-Okt)**: ~5-8 Minuten
- **7 Tage (Test)**: ~20-30 Sekunden

### GitHub Actions Free Tier

| Metrik | Wert |
|--------|------|
| Free Minutes/Monat | 2000 Min |
| Runs pro Tag (6h) | 4 |
| Dauer pro Run | ~8 Min |
| **Verbrauch/Monat** | **~960 Min** ✅ |
| **Übrig** | **~1040 Min** |

## 🛠️ Entwicklung

### Lokales Testen

```bash
# Test Mode für schnelle Entwicklung
TEST_MODE=true bash check-availability.sh

# Mit Debug Output
bash -x check-availability.sh

# Nur einen Tag testen (manuell)
TEST_MODE=true TEST_DAYS=1 bash check-availability.sh
```

### Script-Struktur

```bash
check-availability.sh
├── Configuration          # Umgebungsvariablen & Konstanten
├── Utility Functions      # Logging (log_info, log_success, etc.)
├── Payload Builder        # URL-encoded Payload für API
├── API Client             # curl Requests mit Retry-Logik
├── Availability Checker   # Prüft einzelne Datums-/Betten-Kombination
├── Binary Search          # Binary Search Algorithmus
├── Date Range Generator   # Generiert Datumsbereich
└── Main Execution         # Orchestriert den gesamten Ablauf
```

## 📦 GitHub Actions Artifacts

Results werden als Artifacts gespeichert:
- **Name**: `casablanca-availability-results-{run_number}`
- **Retention**: 90 Tage
- **Format**: JSON
- **Download**: Actions Tab → Run auswählen → Artifacts

## 🔒 Sicherheit & Best Practices

- ✅ Keine sensiblen Daten im Code
- ✅ Rate Limiting (0.5s Delay)
- ✅ Retry-Logik mit Exponential Backoff
- ✅ Timeout bei API-Requests (30s)
- ✅ Error Handling für fehlgeschlagene Requests
- ✅ User-Agent Header (verhindert Bot-Blocking)

## 🐛 Troubleshooting

### Script schlägt fehl mit "command not found: jq"

**Problem**: `jq` ist nicht installiert

**Lösung**:
```bash
# macOS
brew install jq

# Linux (Ubuntu/Debian)
sudo apt-get install jq

# Linux (CentOS/RHEL)
sudo yum install jq
```

### Alle Requests schlagen fehl

**Mögliche Ursachen**:
1. **Falsche Resort ID oder Company**: Prüfe die IDs in der Casablanca URL
2. **API ist down**: Prüfe ob die Casablanca Website erreichbar ist
3. **Rate Limiting**: Erhöhe `REQUEST_DELAY` auf 1-2 Sekunden

### macOS vs. Linux Date Command

Das Script erkennt automatisch das OS und verwendet den richtigen `date`-Befehl:
- **macOS**: `date -j -v+1d`
- **Linux**: `date -d "+1 day"`

## 📝 Weitere Resorts hinzufügen

1. **Finde die Resort IDs**: Öffne die Casablanca Buchungsseite und inspiziere die API-Calls
2. **Erstelle neue Workflow-Datei** (optional für separaten Zeitplan)
3. **Oder**: Nutze die `workflow_dispatch` Inputs für flexible Konfiguration

```yaml
# Beispiel: Anderes Resort prüfen
jobs:
  check-another-resort:
    env:
      RESORT_ID: "A_1234_OTHER"
      COMPANY: "c_COMP2"
```

## 📄 Lizenz

Für persönlichen Gebrauch. Bitte respektiere die Terms of Service von Casablanca.

## 🙏 Credits

Basierend auf der Architektur des [hut-reservation-scraper](https://github.com/thrill2212/bettencheck).
