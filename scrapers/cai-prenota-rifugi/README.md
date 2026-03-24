# CAI Prenota Rifugi Scraper

Discovery:

```bash
node scrapers/cai-prenota-rifugi/discover-huts.mjs
```

Availability:

```bash
node scrapers/cai-prenota-rifugi/check-availability.mjs
```

Custom month window:

```bash
node scrapers/cai-prenota-rifugi/check-availability.mjs --months 2026-06,2026-07,2026-08
```

Normalize and upsert:

```bash
node scripts/normalize-and-upsert.mjs --source cai-prenota-rifugi
```

Notes:

- Discovery fetches the full CAI catalog and classifies Alpine huts locally.
- Availability uses the CAI calendar endpoint with `people=1`.
- V1 stores reliable daily status, but not exact free bed counts.
