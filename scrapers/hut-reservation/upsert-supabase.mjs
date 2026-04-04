#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const outputDir = process.env.OUTPUT_DIR
  ? path.resolve(process.cwd(), process.env.OUTPUT_DIR)
  : path.join(scriptDir, "availability-results");
const hutInfoCacheDir = process.env.HUT_INFO_CACHE_DIR
  ? path.resolve(process.cwd(), process.env.HUT_INFO_CACHE_DIR)
  : path.join(scriptDir, ".cache", "hut-info");
const coverageFile = process.env.TOUR_COVERAGE_FILE
  ? path.resolve(process.cwd(), process.env.TOUR_COVERAGE_FILE)
  : path.join(scriptDir, "tour-id-coverage.json");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RUN_ID =
  process.env.BETTENCHECK_RUN_ID ??
  process.env.GITHUB_RUN_ID ??
  `local-${new Date().toISOString()}`;
const SCRAPE_SUMMARY_FILE = process.env.SCRAPE_SUMMARY_FILE
  ? path.resolve(process.cwd(), process.env.SCRAPE_SUMMARY_FILE)
  : path.join(outputDir, "scrape-summary.json");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.log(
    JSON.stringify(
      {
        skipped: true,
        reason: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing",
      },
      null,
      2
    )
  );
  process.exit(0);
}

if (!fs.existsSync(coverageFile)) {
  throw new Error(`Coverage file missing: ${coverageFile}`);
}

if (!fs.existsSync(outputDir)) {
  throw new Error(`Availability output dir missing: ${outputDir}`);
}

function slugify(value, fallback = "unknown") {
  const cleaned = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function parseElevation(raw) {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(1, Math.round(raw));
  const match = String(raw).match(/-?\d+/);
  if (!match) return null;
  const n = Number(match[0]);
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.round(n));
}

function toCategoryEntries(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    return Object.entries(value).map(([providerCategoryId, count]) => ({
      providerCategoryId,
      totalFreePlaces: count,
    }));
  }
  return [];
}

function parseBeds(day) {
  const directCandidates = [day?.availableBeds, day?.freeBeds];
  for (const candidate of directCandidates) {
    const n = Number(candidate);
    if (Number.isFinite(n)) {
      return Math.max(0, Math.round(n));
    }
  }

  const categoryCollections = [
    Array.isArray(day?.bedCategoriesData) ? day.bedCategoriesData : [],
    toCategoryEntries(day?.freeBedsPerCategory),
  ];

  for (const categories of categoryCollections) {
    if (categories.length === 0) continue;
    let sum = 0;
    let hasValue = false;
    for (const category of categories) {
      const possibleFields = [category?.totalFreePlaces, category?.freeBeds, category?.freePlaces];
      for (const field of possibleFields) {
        const n = Number(field);
        if (Number.isFinite(n)) {
          sum += n;
          hasValue = true;
          break;
        }
      }
    }
    if (hasValue) {
      return Math.max(0, Math.round(sum));
    }
  }

  return null;
}

function getPreferredCategoryLabel(category) {
  const languageData = Array.isArray(category?.hutBedCategoryLanguageData)
    ? category.hutBedCategoryLanguageData
    : [];
  const preferred = languageData.find((entry) => entry?.language === "DE_DE" || entry?.language === "DE_CH");
  if (preferred?.label) return String(preferred.label).trim();
  const fallback = languageData.find((entry) => typeof entry?.label === "string" && entry.label.trim() !== "");
  return fallback?.label ? String(fallback.label).trim() : null;
}

function readCachedHutInfo(ref) {
  const normalizedRef = String(ref ?? "").trim();
  if (!normalizedRef) return null;
  const cacheFile = path.join(hutInfoCacheDir, `hut-${normalizedRef}.json`);
  if (!fs.existsSync(cacheFile)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeRoomCategoryLabel(label) {
  const raw = String(label ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "matratzenlager" || raw === "massenlager") return "matratzenlager";
  if (
    raw === "mehrbettzimmer" ||
    raw === "zimmerlager" ||
    raw === "schlaflager" ||
    raw === "zimmer" ||
    raw === "bettenlager" ||
    raw === "4-er zimmer"
  ) {
    return "mehrbettzimmer";
  }
  if (raw === "dortoir" || raw === "zimmern") return "matratzenlager";
  if (
    raw === "zweierzimmer" ||
    raw === "2-er zimmer" ||
    raw === "2er zimmer" ||
    raw === "doppelzimmer" ||
    raw === "privatzimmer"
  ) {
    return "privatzimmer";
  }
  return null;
}

function deriveDisplayStrategy({ normalizedCategory, rawLabel, reservationMode }) {
  if (normalizedCategory) return "map_to_normalized";
  const raw = String(rawLabel ?? "").trim().toLowerCase();
  const mode = String(reservationMode ?? "").trim().toUpperCase();
  if (
    mode === "UNSERVICED" ||
    raw.includes("unbewirtschaft") ||
    raw.includes("winterraum") ||
    raw.includes("schutzraum") ||
    raw.includes("sonderkategorie")
  ) {
    return "fallback_to_total";
  }
  return "ignore";
}

function buildRoomCategoryRows(day) {
  return toCategoryEntries(day?.freeBedsPerCategory)
    .map((category) => {
      const providerCategoryId = String(
        category?.providerCategoryId ??
          category?.categoryId ??
          category?.bedCategoryId ??
          category?.id ??
          ""
      ).trim();
      if (!providerCategoryId) return null;
      const availableBedsRaw = category?.totalFreePlaces ?? category?.freeBeds ?? category?.freePlaces;
      const availableBeds = Number(availableBedsRaw);
      return {
        provider_category_id: providerCategoryId,
        available_beds: Number.isFinite(availableBeds) ? Math.max(0, Math.round(availableBeds)) : null,
      };
    })
    .filter(Boolean);
}

function parseBedsTotal(raw) {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, Math.round(raw));
  const match = String(raw).match(/\d+/);
  if (!match) return null;
  const n = Number(match[0]);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.round(n));
}

function mapStatus(day) {
  const raw = String(day?.hutStatus ?? "").toUpperCase();
  const percentage = String(day?.percentage ?? "").toUpperCase();
  if (raw === "CLOSED") return "closed";
  if (percentage === "CLOSED") return "closed";
  if (percentage === "FULL") return "unavailable";
  const pct = Number(day?.percentage);
  if (Number.isFinite(pct)) return pct > 0 ? "available" : "unavailable";
  if (raw.includes("UNAVAILABLE") || raw.includes("FULL")) return "unavailable";
  return "available";
}

function getSeasonWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  const seasonYear = month > 10 || (month === 10 && day > 1) ? year + 1 : year;
  return {
    seasonStart: `${seasonYear}-01-01`,
    seasonEnd: `${seasonYear + 1}-01-01`,
  };
}

function buildSeasonFields(rows) {
  let seasonOpen = null;
  let seasonClose = null;
  let seasonCheckedAt = null;

  for (const row of rows) {
    const date = String(row?.date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    if (row?.status === "available" || row?.status === "unavailable") {
      if (!seasonOpen || date < seasonOpen) seasonOpen = date;
      if (!seasonClose || date > seasonClose) seasonClose = date;
    }

    const checkedAt = String(row?.checked_at ?? "");
    if (checkedAt && (!seasonCheckedAt || checkedAt > seasonCheckedAt)) {
      seasonCheckedAt = checkedAt;
    }
  }

  return {
    season_open: seasonOpen,
    season_close: seasonClose,
    season_checked_at: seasonCheckedAt,
  };
}

async function postgrest(url, key, method, table, { rows, onConflict, query } = {}) {
  const u = new URL(`${url.replace(/\/$/, "")}/rest/v1/${table}`);
  if (onConflict) u.searchParams.set("on_conflict", onConflict);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      u.searchParams.set(k, v);
    }
  }

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };

  if (method === "POST") {
    headers.Prefer = "resolution=merge-duplicates,return=minimal";
  }

  const res = await fetch(u, {
    method,
    headers,
    body: rows ? JSON.stringify(rows) : undefined,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${method} ${u} failed: ${res.status} ${body}`);
  }
}

async function selectRows(table, query = {}) {
  const u = new URL(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(query)) {
    u.searchParams.set(k, v);
  }
  const res = await fetch(u, {
    method: "GET",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${u} failed: ${res.status} ${body}`);
  }
  return res.json();
}

async function upsertBatched(table, rows, onConflict, batchSize = 500) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    await postgrest(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, "POST", table, {
      rows: chunk,
      onConflict,
    });
  }
}

async function upsertOptionalTable(table, rows, onConflict, batchSize = 500) {
  if (!rows.length) {
    return { skipped: false, usedFallback: false, count: 0 };
  }

  try {
    await upsertBatched(table, rows, onConflict, batchSize);
    return { skipped: false, usedFallback: false, count: rows.length };
  } catch (error) {
    const msg = String(error?.message ?? error);
    if (!msg.includes("PGRST204")) throw error;
    return { skipped: true, usedFallback: true, reason: msg, count: 0 };
  }
}

async function upsertWithSchemaFallback({
  table,
  preferredRows,
  fallbackRows,
  onConflict,
  batchSize,
}) {
  try {
    await upsertBatched(table, preferredRows, onConflict, batchSize);
    return { usedFallback: false };
  } catch (error) {
    const msg = String(error?.message ?? error);
    if (!msg.includes("PGRST204")) throw error;
    await upsertBatched(table, fallbackRows, onConflict, batchSize);
    return { usedFallback: true, reason: msg };
  }
}

const coverage = JSON.parse(fs.readFileSync(coverageFile, "utf8"));
const coverageTours = Array.isArray(coverage.tours) ? coverage.tours : [];

async function patchRowsBatched(table, rows, keyField, batchSize = 100) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    for (const row of chunk) {
      const key = String(row?.[keyField] ?? "").trim();
      if (!key) continue;
      const body = { ...row };
      delete body[keyField];
      await postgrest(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, "PATCH", table, {
        rows: body,
        query: {
          [keyField]: `eq.${key}`,
        },
      });
    }
  }
}

async function patchRowsWithSchemaFallback({
  table,
  preferredRows,
  fallbackRows,
  keyField,
  batchSize,
}) {
  try {
    await patchRowsBatched(table, preferredRows, keyField, batchSize);
    return { usedFallback: false };
  } catch (error) {
    const msg = String(error?.message ?? error);
    if (!msg.includes("PGRST204")) throw error;
    await patchRowsBatched(table, fallbackRows, keyField, batchSize);
    return { usedFallback: true, reason: msg };
  }
}

const availabilityFiles = fs
  .readdirSync(outputDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => path.join(outputDir, f))
  .map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
  .sort((a, b) => b.mtimeMs - a.mtimeMs)
  .map((x) => x.file);

// Keep only the newest file per hut reference to avoid re-reading the full history.
const availabilityDocs = [];
const seenHutRefs = new Set();
for (const file of availabilityFiles) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const hutRef = String(doc?.sourceHutRef ?? doc?.hutId ?? "").trim();
  if (!hutRef || seenHutRefs.has(hutRef)) continue;
  const cachedHutInfo = readCachedHutInfo(hutRef);
  if (
    cachedHutInfo &&
    (!doc?.hutInfo || typeof doc.hutInfo !== "object" || Array.isArray(doc.hutInfo) || !Array.isArray(doc.hutInfo.hutBedCategories))
  ) {
    doc.hutInfo = {
      ...(doc?.hutInfo && typeof doc.hutInfo === "object" && !Array.isArray(doc.hutInfo) ? doc.hutInfo : {}),
      ...cachedHutInfo,
    };
  }
  seenHutRefs.add(hutRef);
  availabilityDocs.push(doc);
}

const latestByHutRef = new Map();
for (const doc of availabilityDocs) {
  const hutRef = String(doc?.sourceHutRef ?? doc?.hutId ?? "").trim();
  if (!hutRef) continue;
  latestByHutRef.set(hutRef, doc);
}

const allRefs = new Set();
for (const t of coverageTours) {
  for (const h of t.huts ?? []) {
    const ref = String(h.ohrsHutId ?? "").trim();
    if (ref) allRefs.add(ref);
  }
}
for (const ref of latestByHutRef.keys()) allRefs.add(String(ref));

const existingByRef = new Map();
if (allRefs.size > 0) {
  const refsCsv = [...allRefs].map((r) => `"${r}"`).join(",");
  const existingRows = await selectRows("huts", {
    select:
      "id,provider,provider_ref,name,booking_url,operator,elevation_m,website_url,booking_platform,phone,email,warden_name,sleeping_places_total,price_from_eur,latitude,longitude,source_url",
    provider: "eq.hut-reservation",
    provider_ref: `in.(${refsCsv})`,
    limit: "5000",
  });
  for (const row of existingRows) {
    if (row?.provider_ref) existingByRef.set(String(row.provider_ref), row);
  }
}

function hutIdForRef(ref) {
  return existingByRef.get(String(ref))?.id ?? `ohrs-${ref}`;
}

const coverageRouteIds = [...new Set(coverageTours.map((tour) => String(tour?.routeId ?? "").trim()).filter(Boolean))];
const existingRouteIds = new Set();
if (coverageRouteIds.length > 0) {
  const routesCsv = coverageRouteIds.map((id) => `"${id}"`).join(",");
  const existingRouteRows = await selectRows("routes", {
    select: "id",
    id: `in.(${routesCsv})`,
    limit: "5000",
  });
  for (const row of existingRouteRows ?? []) {
    if (row?.id) existingRouteIds.add(String(row.id));
  }
}
const tours = coverageTours.filter((tour) => existingRouteIds.has(String(tour?.routeId ?? "").trim()));

const { seasonStart, seasonEnd } = getSeasonWindow();

const routesRows = tours.map((t) => ({
  id: t.routeId,
  name: t.tourName,
  stage_count: Math.max(0, t.huts?.length ?? 0),
  duration_days: Math.max(2, (t.huts?.length ?? 1) + 1),
  season_start: seasonStart,
  season_end: seasonEnd,
  is_active: true,
}));
const routesRowsBase = routesRows.map((route) => ({
  id: route.id,
  name: route.name,
  stage_count: route.stage_count,
  duration_days: route.duration_days,
  is_active: route.is_active,
}));

const hutsMap = new Map();
for (const t of tours) {
  for (const h of t.huts ?? []) {
    const ref = String(h.ohrsHutId ?? "").trim();
    if (!ref) continue;
    const doc = latestByHutRef.get(ref);
    const hutId = hutIdForRef(ref);
    const existing = existingByRef.get(ref) ?? null;
    const name = h.name ?? doc?.hutName ?? `Hut ${ref}`;
    const bookingUrl =
      doc?.bookingUrl ?? `https://www.hut-reservation.org/reservation/book-hut/${ref}/wizard`;
    const altitude = parseElevation(doc?.hutInfo?.altitude);
    const totalBeds = parseBedsTotal(doc?.hutInfo?.totalBedsInfo);
    hutsMap.set(hutId, {
      id: hutId,
      provider: "hut-reservation",
      provider_ref: ref,
      name: name ?? existing?.name ?? `Hut ${ref}`,
      booking_url: bookingUrl ?? existing?.booking_url ?? `https://www.hut-reservation.org/reservation/book-hut/${ref}/wizard`,
      operator: doc?.hutInfo?.providerName ?? doc?.hutInfo?.tenantCode ?? existing?.operator ?? "unknown",
      elevation_m: altitude ?? existing?.elevation_m ?? 1,
      website_url: doc?.hutInfo?.hutWebsite ?? existing?.website_url ?? null,
      booking_platform: existing?.booking_platform ?? "hut-reservation.org",
      phone: doc?.hutInfo?.phone ?? existing?.phone ?? null,
      email: existing?.email ?? null,
      warden_name: doc?.hutInfo?.hutWarden ?? existing?.warden_name ?? null,
      sleeping_places_total: totalBeds ?? existing?.sleeping_places_total ?? null,
      price_from_eur: existing?.price_from_eur ?? null,
      latitude: doc?.location?.latitude ?? existing?.latitude ?? null,
      longitude: doc?.location?.longitude ?? existing?.longitude ?? null,
      source_url: bookingUrl ?? existing?.source_url ?? null,
    });
  }
}
for (const [ref, doc] of latestByHutRef.entries()) {
  const hutId = hutIdForRef(ref);
  if (hutsMap.has(hutId)) continue;
  const existing = existingByRef.get(ref) ?? null;
  const bookingUrl =
    doc?.bookingUrl ?? `https://www.hut-reservation.org/reservation/book-hut/${ref}/wizard`;
  const altitude = parseElevation(doc?.hutInfo?.altitude);
  const totalBeds = parseBedsTotal(doc?.hutInfo?.totalBedsInfo);
  hutsMap.set(hutId, {
    id: hutId,
    provider: "hut-reservation",
    provider_ref: ref,
    name: doc?.hutName ?? existing?.name ?? `Hut ${ref}`,
    booking_url: bookingUrl ?? existing?.booking_url ?? `https://www.hut-reservation.org/reservation/book-hut/${ref}/wizard`,
    operator: doc?.hutInfo?.providerName ?? doc?.hutInfo?.tenantCode ?? existing?.operator ?? "unknown",
    elevation_m: altitude ?? existing?.elevation_m ?? 1,
    website_url: doc?.hutInfo?.hutWebsite ?? existing?.website_url ?? null,
    booking_platform: existing?.booking_platform ?? "hut-reservation.org",
    phone: doc?.hutInfo?.phone ?? existing?.phone ?? null,
    email: existing?.email ?? null,
    warden_name: doc?.hutInfo?.hutWarden ?? existing?.warden_name ?? null,
    sleeping_places_total: totalBeds ?? existing?.sleeping_places_total ?? null,
    price_from_eur: existing?.price_from_eur ?? null,
    latitude: doc?.location?.latitude ?? existing?.latitude ?? null,
    longitude: doc?.location?.longitude ?? existing?.longitude ?? null,
    source_url: bookingUrl ?? existing?.source_url ?? null,
  });
}
const hutsRowsExtended = [...hutsMap.values()];
const hutsRowsBase = hutsRowsExtended.map((h) => ({
  id: h.id,
  provider: h.provider,
  provider_ref: h.provider_ref,
  name: h.name,
  booking_url: h.booking_url,
  operator: h.operator,
  elevation_m: h.elevation_m,
}));

const stageRowsExtended = [];
for (const t of tours) {
  const ordered = (t.huts ?? []).filter((h) => h.ohrsHutId != null && String(h.ohrsHutId).trim() !== "");
  for (let i = 0; i < ordered.length; i += 1) {
    const curr = ordered[i];
    const prev = i > 0 ? ordered[i - 1] : null;
    stageRowsExtended.push({
      route_id: t.routeId,
      day_index: i + 1,
      overnight_hut_id: hutIdForRef(curr.ohrsHutId),
      start_hut_id: prev ? hutIdForRef(prev.ohrsHutId) : null,
      end_hut_id: hutIdForRef(curr.ohrsHutId),
      title: prev ? `${prev.name} -> ${curr.name}` : `${t.tourName} Start -> ${curr.name}`,
      info_url: null,
    });
  }
}
const stageRowsBase = stageRowsExtended.map((s) => ({
  route_id: s.route_id,
  day_index: s.day_index,
  overnight_hut_id: s.overnight_hut_id,
}));

const roomCategoryMappingRows = [];
for (const doc of availabilityDocs) {
  const ref = String(doc?.sourceHutRef ?? doc?.hutId ?? "").trim();
  if (!ref) continue;
  const hutId = hutIdForRef(ref);
  const checkedAt = doc?.checkedAt ?? new Date().toISOString();
  const categories = Array.isArray(doc?.hutBedCategories)
    ? doc.hutBedCategories
    : Array.isArray(doc?.hutInfo?.hutBedCategories)
      ? doc.hutInfo.hutBedCategories
      : [];
  for (const category of categories) {
    const providerCategoryId = String(category?.categoryID ?? category?.categoryId ?? "").trim();
    if (!providerCategoryId) continue;
    const rawLabel = getPreferredCategoryLabel(category);
    const normalizedCategory = normalizeRoomCategoryLabel(rawLabel);
    const displayStrategy = deriveDisplayStrategy({
      normalizedCategory,
      rawLabel,
      reservationMode: category?.reservationMode,
    });
    roomCategoryMappingRows.push({
      hut_id: hutId,
      provider: "hut-reservation",
      provider_ref: ref,
      provider_category_id: providerCategoryId,
      raw_category_label: rawLabel,
      normalized_category: normalizedCategory,
      display_strategy: displayStrategy,
      reservation_mode: category?.reservationMode ?? null,
      is_visible: category?.isVisible ?? true,
      total_sleeping_places: parseBedsTotal(category?.totalSleepingPlaces),
      checked_at: checkedAt,
      source: "hut-reservation.hutInfo",
      metadata: {
        tenant_bed_category_id: category?.tenantBedCategoryId ?? null,
        category_index: category?.index ?? null,
        is_linked_to_reservation: category?.isLinkedToReservation ?? null,
      },
    });
  }
}
const roomCategoryMappingByKey = new Map();
for (const row of roomCategoryMappingRows) {
  const key = `${row.hut_id}|${row.provider_category_id}`;
  const prev = roomCategoryMappingByKey.get(key);
  if (!prev || String(row.checked_at) >= String(prev.checked_at)) {
    roomCategoryMappingByKey.set(key, row);
  }
}
const dedupedRoomCategoryMappingRows = [...roomCategoryMappingByKey.values()];

const roomCategoryAvailabilityRowsRaw = [];
const availabilityRowsRaw = [];
for (const doc of availabilityDocs) {
  const ref = String(doc?.sourceHutRef ?? doc?.hutId ?? "").trim();
  if (!ref) continue;
  const hutId = hutIdForRef(ref);
  const checkedAt = doc?.checkedAt ?? new Date().toISOString();
  const days = Array.isArray(doc?.allDays) ? doc.allDays : [];
  for (const day of days) {
    const date = String(day?.date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    availabilityRowsRaw.push({
      hut_id: hutId,
      date,
      available_beds: parseBeds(day),
      status: mapStatus(day),
      confidence: "exact",
      source: "hut-reservation",
      checked_at: checkedAt,
    });

    for (const categoryRow of buildRoomCategoryRows(day)) {
      roomCategoryAvailabilityRowsRaw.push({
        hut_id: hutId,
        date,
        provider_category_id: categoryRow.provider_category_id,
        available_beds: categoryRow.available_beds,
        status:
          mapStatus(day) === "closed"
            ? "closed"
            : (categoryRow.available_beds ?? 0) > 0
              ? "available"
              : "unavailable",
        confidence: categoryRow.available_beds !== null ? "exact" : "inferred",
        source: "hut-reservation",
        checked_at: checkedAt,
      });
    }
  }
}
const availabilityByKey = new Map();
for (const row of availabilityRowsRaw) {
  const key = `${row.hut_id}|${row.date}`;
  const prev = availabilityByKey.get(key);
  if (!prev) {
    availabilityByKey.set(key, row);
    continue;
  }
  const prevTs = Date.parse(prev.checked_at ?? "");
  const nextTs = Date.parse(row.checked_at ?? "");
  if (!Number.isFinite(prevTs) || (Number.isFinite(nextTs) && nextTs >= prevTs)) {
    availabilityByKey.set(key, row);
  }
}
const availabilityRows = [...availabilityByKey.values()];
const roomCategoryAvailabilityByKey = new Map();
for (const row of roomCategoryAvailabilityRowsRaw) {
  const key = `${row.hut_id}|${row.date}|${row.provider_category_id}`;
  const prev = roomCategoryAvailabilityByKey.get(key);
  if (!prev) {
    roomCategoryAvailabilityByKey.set(key, row);
    continue;
  }
  const prevTs = Date.parse(prev.checked_at ?? "");
  const nextTs = Date.parse(row.checked_at ?? "");
  if (!Number.isFinite(prevTs) || (Number.isFinite(nextTs) && nextTs >= prevTs)) {
    roomCategoryAvailabilityByKey.set(key, row);
  }
}
const roomCategoryAvailabilityRows = [...roomCategoryAvailabilityByKey.values()];
const seasonFieldsByHutId = new Map();
for (const row of availabilityRows) {
  const hutId = String(row?.hut_id ?? "").trim();
  if (!hutId) continue;
  const rowsForHut = seasonFieldsByHutId.get(hutId) ?? [];
  rowsForHut.push(row);
  seasonFieldsByHutId.set(hutId, rowsForHut);
}

for (const hutRow of hutsRowsExtended) {
  Object.assign(hutRow, buildSeasonFields(seasonFieldsByHutId.get(hutRow.id) ?? []));
}

let scrapeSummary = null;
if (fs.existsSync(SCRAPE_SUMMARY_FILE)) {
  try {
    scrapeSummary = JSON.parse(fs.readFileSync(SCRAPE_SUMMARY_FILE, "utf8"));
  } catch {
    scrapeSummary = null;
  }
}

const routesSync = await patchRowsWithSchemaFallback({
  table: "routes",
  preferredRows: routesRows,
  fallbackRows: routesRowsBase,
  keyField: "id",
});
const hutsSync = await upsertWithSchemaFallback({
  table: "huts",
  preferredRows: hutsRowsExtended,
  fallbackRows: hutsRowsBase,
  onConflict: "id",
});

const routeIds = routesRows.map((r) => r.id);
if (routeIds.length > 0) {
  await postgrest(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, "DELETE", "route_stages", {
    query: {
      route_id: `in.(${routeIds.map((id) => `"${id}"`).join(",")})`,
    },
  });
}

const stagesSync = await upsertWithSchemaFallback({
  table: "route_stages",
  preferredRows: stageRowsExtended,
  fallbackRows: stageRowsBase,
  onConflict: "route_id,day_index",
});

const roomCategoryMappingsSync = await upsertOptionalTable(
  "hut_room_category_mappings",
  dedupedRoomCategoryMappingRows,
  "hut_id,provider_category_id",
  1000
);
const roomCategoryAvailabilitySync = await upsertOptionalTable(
  "availability_daily_room_categories",
  roomCategoryAvailabilityRows,
  "hut_id,date,provider_category_id",
  1000
);

await upsertBatched("availability_daily", availabilityRows, "hut_id,date", 1000);

await upsertBatched("scrape_runs", [
  {
    source: "hut-reservation",
    run_id: String(RUN_ID),
    status: "ok",
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    error_summary: null,
    metadata: {
      source: "hut-reservation",
      inputDir: outputDir,
      fileCount: availabilityFiles.length,
      selectedFileCount: availabilityDocs.length,
      scrapeSummaryFile: SCRAPE_SUMMARY_FILE,
      attemptedHutCount: scrapeSummary?.attemptedCount ?? null,
      successfulHutCount: scrapeSummary?.successCount ?? null,
      failedHutCount: scrapeSummary?.failedCount ?? null,
      failedHutIds: Array.isArray(scrapeSummary?.failedHuts)
        ? scrapeSummary.failedHuts
            .map((hut) => String(hut?.hutId ?? "").trim())
            .filter(Boolean)
        : [],
      routeCount: routesRows.length,
      skippedCoverageRouteCount: coverageTours.length - tours.length,
      hutCount: hutsRowsExtended.length,
      stageCount: stageRowsExtended.length,
      availabilityRows: availabilityRows.length,
      roomCategoryMappingRows: dedupedRoomCategoryMappingRows.length,
      roomCategoryAvailabilityRows: roomCategoryAvailabilityRows.length,
      coverageFile,
      routesSchemaFallback: routesSync.usedFallback,
      hutsSchemaFallback: hutsSync.usedFallback,
      stagesSchemaFallback: stagesSync.usedFallback,
      roomCategoryMappingsSkipped: roomCategoryMappingsSync.skipped,
      roomCategoryAvailabilitySkipped: roomCategoryAvailabilitySync.skipped,
    },
  },
], "source,run_id");

console.log(
  JSON.stringify(
    {
      upserted: true,
      routes: routesRows.length,
      skippedCoverageRoutes: coverageTours.length - tours.length,
      huts: hutsRowsExtended.length,
      route_stages: stageRowsExtended.length,
      availability_daily: availabilityRows.length,
      hut_room_category_mappings: roomCategoryMappingsSync.count,
      availability_daily_room_categories: roomCategoryAvailabilitySync.count,
      coverageFile,
      outputDir,
      schemaFallback: {
        routes: routesSync.usedFallback,
        huts: hutsSync.usedFallback,
        route_stages: stagesSync.usedFallback,
        hut_room_category_mappings: roomCategoryMappingsSync.usedFallback,
        availability_daily_room_categories: roomCategoryAvailabilitySync.usedFallback,
      },
    },
    null,
    2
  )
);
