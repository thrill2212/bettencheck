# Hut-Reservation -> Supabase Sync Fix (2026-02-21)

## Problem

`available_beds` aus `hut-reservation` kam in `availability_daily` nicht verlässlich an.

Ursache: Der Upsert hat primär Legacy-Felder erwartet (`availableBeds`, `bedCategoriesData`),
während aktuelle Scraper-Payloads Felder wie `freeBeds` und `freeBedsPerCategory` liefern.

## Technischer Fix

### 1) Upsert-Pfad angepasst

Datei: `scrapers/hut-reservation/upsert-supabase.mjs`

- `parseBeds(day)` unterstützt jetzt beide Schemata:
  - `availableBeds` (legacy)
  - `freeBeds` (aktuell)
  - `bedCategoriesData` (legacy Kategorien)
  - `freeBedsPerCategory` (aktuelle Kategorien)
- Kategorien akzeptieren mehrere Feldnamen (`totalFreePlaces`, `freeBeds`, `freePlaces`).
- `mapStatus(day)` behandelt `percentage = "FULL"` explizit als `unavailable`.

### 2) Normalizer konsistent gemacht

Datei: `scripts/lib/normalize.mjs`

- Entsprechende Logik für `freeBedsPerCategory` ergänzt.
- `percentage = "FULL"` wird als `unavailable` normalisiert.

### 3) Tests erweitert

Datei: `scripts/tests/normalize.test.mjs`

Neue Testfälle:
- Summierung von `freeBedsPerCategory`.
- `percentage = FULL` -> `status = unavailable`.

## Live-Verifikation

Ausgeführt am 2026-02-21:

1. Voller hut-reservation Run + Upsert gegen Supabase.
2. Zielhütte (`hutId=119`, Olpererhütte) separat nachgezogen (zuvor temporär 403-bedingt ausgelassen).
3. Ergebnis in Supabase:
   - `source = hut-reservation`
   - `availability_daily`: 6710 Zeilen
   - Zeilen mit `available_beds != null`: 6710
4. Frontend API verifiziert:
   - `/api/routes/e5/availability?...`
   - `fallbackUsed = false`
   - hut-reservation Hütten liefern echte `availableBeds`.
5. Readiness:
   - `scripts/check-live-routes-readiness.mjs`
   - `readyRoutes: 12`, `notReadyRoutes: []`.

## Operative Hinweise

- Die Workflows `check-hut-availability.yml` und `check-hut-availability-full.yml`
  nutzen `scrapers/hut-reservation/check-availability.sh`, das automatisch
  `upsert-supabase.mjs` aufruft, wenn `SUPABASE_*` gesetzt ist.
- Der Fix wirkt dadurch direkt für reguläre Workflow-Runs.
