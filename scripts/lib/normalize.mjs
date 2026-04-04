import fs from "node:fs";
import path from "node:path";

const DEFAULT_CASABLANCA_RESORT = "A_6511_SKIHU";

function toIsoDate(value) {
  if (!value) return null;
  if (typeof value !== "string") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return value.slice(0, 10);
}

function normalizeCheckedAt(value) {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }
  return parsed.toISOString();
}

function categoryItems(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    return Object.entries(value).map(([categoryId, count]) => ({
      categoryId,
      totalFreePlaces: count,
    }));
  }
  return [];
}

export function loadProviderMapping(mappingPath) {
  const raw = fs.readFileSync(mappingPath, "utf8");
  return JSON.parse(raw);
}

export function listJsonFiles(inputDir) {
  if (!fs.existsSync(inputDir)) return [];
  return fs
    .readdirSync(inputDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(inputDir, name));
}

export function normalizeHutReservationPayload(payload, mapping) {
  const hutId = mapping[String(payload.hutId)];
  if (!hutId) {
    return [];
  }
  const checkedAt = normalizeCheckedAt(payload.checkedAt);
  const allDays = Array.isArray(payload.allDays) ? payload.allDays : [];

  return allDays
    .map((day) => {
      const date = toIsoDate(day.date);
      if (!date) return null;
      const closed = day.hutStatus === "CLOSED";
      const directFreeBeds = Number(day.freeBeds);
      const hasDirectFreeBeds = Number.isFinite(directFreeBeds);
      const categoryList = categoryItems(day.freeBedsPerCategory);
      const freeBedsFromCategories = categoryList.reduce((sum, category) => {
        const n = Number(category?.totalFreePlaces ?? category?.freeBeds ?? category?.freePlaces);
        return Number.isFinite(n) ? sum + n : sum;
      }, 0);
      const hasCategoryValues = categoryList.some((category) =>
        Number.isFinite(Number(category?.totalFreePlaces ?? category?.freeBeds ?? category?.freePlaces))
      );
      const freeBeds = hasDirectFreeBeds
        ? Math.max(0, Math.round(directFreeBeds))
        : hasCategoryValues
          ? Math.max(0, Math.round(freeBedsFromCategories))
          : null;
      const percentage = String(day.percentage ?? "").toUpperCase();
      const status = closed
        ? "closed"
        : percentage === "FULL"
          ? "unavailable"
        : freeBeds !== null
          ? freeBeds > 0
            ? "available"
            : "unavailable"
          : "available";
      return {
        hut_id: hutId,
        date,
        available_beds: freeBeds,
        status,
        confidence: freeBeds !== null ? "exact" : "inferred",
        source: "hut-reservation",
        checked_at: checkedAt,
      };
    })
    .filter(Boolean);
}

export function normalizeHuettenholidayPayload(payload, mapping) {
  const checkedAt = normalizeCheckedAt(payload.scrapedAt);
  const cabins = Array.isArray(payload.cabins) ? payload.cabins : [];
  const rows = [];

  for (const cabin of cabins) {
    const hutId = mapping[String(cabin.id)];
    if (!hutId) continue;
    const availability = Array.isArray(cabin.availability) ? cabin.availability : [];
    for (const day of availability) {
      const date = toIsoDate(day.date);
      if (!date) continue;
      const totalPlaces = Number(day.totalPlaces ?? 0);
      const availablePlaces = Number(day.availablePlaces ?? 0);
      const status =
        totalPlaces <= 0 ? "closed" : availablePlaces > 0 ? "available" : "unavailable";
      rows.push({
        hut_id: hutId,
        date,
        available_beds: Math.max(0, availablePlaces),
        status,
        confidence: "exact",
        source: "huettenholiday",
        checked_at: checkedAt,
      });
    }
  }

  return rows;
}

export function normalizeCaiPrenotaRifugiPayload(payload, mapping) {
  const checkedAt = normalizeCheckedAt(payload.scrapedAt);
  const cabins = Array.isArray(payload.cabins) ? payload.cabins : [];
  const rows = [];

  for (const cabin of cabins) {
    const hutId = mapping[String(cabin.id)];
    if (!hutId) continue;
    const availability = Array.isArray(cabin.availability) ? cabin.availability : [];
    for (const day of availability) {
      const date = toIsoDate(day.date);
      if (!date) continue;
      let status = String(day.status ?? "").trim().toLowerCase();
      if (status !== "available" && status !== "unavailable" && status !== "closed") {
        status = "unavailable";
      }
      rows.push({
        hut_id: hutId,
        date,
        available_beds: null,
        status,
        confidence: "inferred",
        source: "cai-prenota-rifugi",
        checked_at: checkedAt,
      });
    }
  }

  return rows;
}

export function normalizeCasablancaPayload(payload, mapping, resortId = DEFAULT_CASABLANCA_RESORT) {
  const hutId = mapping[resortId];
  if (!hutId) {
    return [];
  }
  const days = Array.isArray(payload) ? payload : [];
  return days
    .map((day) => {
      const date = toIsoDate(day.date);
      if (!date) return null;
      const availableBeds = Number(day.availableBeds ?? 0);
      const isAvailable = Boolean(day.isAvailable) && availableBeds > 0;
      return {
        hut_id: hutId,
        date,
        available_beds: Math.max(0, availableBeds),
        status: isAvailable ? "available" : "unavailable",
        confidence: "exact",
        source: "casablanca",
        checked_at: normalizeCheckedAt(day.checkedAt),
      };
    })
    .filter(Boolean);
}

export function dedupeAvailabilityRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.hut_id}:${row.date}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }
    const existingAt = new Date(existing.checked_at).getTime();
    const currentAt = new Date(row.checked_at).getTime();
    if (currentAt >= existingAt) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

function isInSeasonStatus(status) {
  return status === "available" || status === "unavailable";
}

export function buildSeasonPatchRows(rows) {
  const byHut = new Map();

  for (const row of rows) {
    const hutId = String(row?.hut_id ?? "").trim();
    const date = toIsoDate(row?.date);
    if (!hutId || !date) continue;

    const checkedAt = normalizeCheckedAt(row?.checked_at);
    const entry =
      byHut.get(hutId) ??
      {
        id: hutId,
        season_open: null,
        season_close: null,
        season_checked_at: checkedAt,
      };

    if (isInSeasonStatus(row?.status)) {
      if (!entry.season_open || date < entry.season_open) {
        entry.season_open = date;
      }
      if (!entry.season_close || date > entry.season_close) {
        entry.season_close = date;
      }
    }

    if (checkedAt > entry.season_checked_at) {
      entry.season_checked_at = checkedAt;
    }

    byHut.set(hutId, entry);
  }

  return [...byHut.values()];
}

export function normalizeFiles({
  source,
  filePaths,
  mapping,
  resortId = DEFAULT_CASABLANCA_RESORT,
}) {
  const rows = [];
  for (const filePath of filePaths) {
    const raw = fs.readFileSync(filePath, "utf8");
    const payload = JSON.parse(raw);
    if (source === "hut-reservation") {
      rows.push(...normalizeHutReservationPayload(payload, mapping["hut-reservation"] ?? {}));
    } else if (source === "huettenholiday") {
      rows.push(...normalizeHuettenholidayPayload(payload, mapping.huettenholiday ?? {}));
    } else if (source === "cai-prenota-rifugi") {
      rows.push(...normalizeCaiPrenotaRifugiPayload(payload, mapping["cai-prenota-rifugi"] ?? {}));
    } else if (source === "casablanca") {
      rows.push(...normalizeCasablancaPayload(payload, mapping.casablanca ?? {}, resortId));
    } else {
      throw new Error(`Unsupported source '${source}'.`);
    }
  }
  return dedupeAvailabilityRows(rows);
}
