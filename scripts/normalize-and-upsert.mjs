#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { listJsonFiles, loadProviderMapping, normalizeFiles } from "./lib/normalize.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function getDefaultInputDir(source) {
  if (source === "hut-reservation") return "scrapers/hut-reservation/availability-results";
  if (source === "huettenholiday") return "scrapers/huettenholiday/availability-results";
  if (source === "casablanca") return "scrapers/casablanca/availability-results";
  return "";
}

function toRestHeaders(serviceRoleKey) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates,return=minimal",
  };
}

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toPositiveIntOrNull(value) {
  const n = toNumberOrNull(value);
  if (n === null) return null;
  return Math.max(0, Math.round(n));
}

function toElevationOrDefault(value, fallback = 1) {
  const n = toNumberOrNull(value);
  if (n === null) return fallback;
  return Math.max(1, Math.round(n));
}

async function postJson(url, headers, body) {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
}

async function getJson(url, headers) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      ...headers,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return response.json();
}

async function upsertBatched(url, headers, rows, batchSize = 500) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    await postJson(url, headers, chunk);
  }
}

async function upsertAvailabilityRows({
  supabaseUrl,
  serviceRoleKey,
  rows,
}) {
  if (rows.length === 0) return;
  const url = `${supabaseUrl}/rest/v1/availability_daily?on_conflict=hut_id,date`;
  await upsertBatched(url, toRestHeaders(serviceRoleKey), rows, 1000);
}

async function upsertScrapeRun({
  supabaseUrl,
  serviceRoleKey,
  source,
  runId,
  status,
  startedAt,
  finishedAt,
  errorSummary,
  metadata,
}) {
  const url = `${supabaseUrl}/rest/v1/scrape_runs?on_conflict=source,run_id`;
  await postJson(url, toRestHeaders(serviceRoleKey), [
    {
      source,
      run_id: runId,
      status,
      started_at: startedAt,
      finished_at: finishedAt,
      error_summary: errorSummary ?? null,
      metadata: metadata ?? {},
    },
  ]);
}

async function upsertHuettenholidayHuts({
  supabaseUrl,
  serviceRoleKey,
  filePaths,
  mapping,
}) {
  const byId = new Map();

  for (const filePath of filePaths) {
    const raw = fs.readFileSync(filePath, "utf8");
    const payload = JSON.parse(raw);
    const checkedAtRaw = payload?.scrapedAt;
    const checkedAt = checkedAtRaw ? new Date(checkedAtRaw).getTime() : Date.now();
    const cabins = Array.isArray(payload?.cabins) ? payload.cabins : [];

    for (const cabin of cabins) {
      const mappedId = mapping[String(cabin?.id)];
      if (!mappedId) continue;
      const prev = byId.get(mappedId);
      if (!prev || checkedAt >= prev.checkedAt) {
        byId.set(mappedId, { cabin, checkedAt });
      }
    }
  }

  const hutIds = [...byId.keys()];
  if (hutIds.length === 0) return { upserted: 0, fallback: false };

  const idList = hutIds.map((id) => `"${id}"`).join(",");
  const selectUrl = `${supabaseUrl}/rest/v1/huts?select=id,provider,provider_ref,name,booking_url,operator,elevation_m,website_url,booking_platform,phone,email,warden_name,sleeping_places_total,price_from_eur,latitude,longitude,source_url&id=in.(${idList})`;
  const existingRows = await getJson(selectUrl, toRestHeaders(serviceRoleKey));
  const existingById = new Map(existingRows.map((row) => [row.id, row]));

  const extendedRows = hutIds.map((hutId) => {
    const { cabin } = byId.get(hutId);
    const metadata = cabin?.metadata ?? {};
    const existing = existingById.get(hutId) ?? {};
    const name = metadata?.name ?? cabin?.name ?? existing?.name ?? hutId;
    const sourceUrl =
      metadata?.detailPageUrl ?? metadata?.bookingUrl ?? existing?.source_url ?? null;
    const bookingUrl = metadata?.bookingUrl ?? existing?.booking_url ?? sourceUrl;

    return {
      id: hutId,
      provider: "huettenholiday",
      provider_ref: String(cabin?.id ?? existing?.provider_ref ?? hutId),
      name,
      booking_url: bookingUrl,
      operator: metadata?.region ?? existing?.operator ?? "unknown",
      elevation_m: toElevationOrDefault(metadata?.altitude, existing?.elevation_m ?? 1),
      website_url: metadata?.websiteUrl ?? existing?.website_url ?? null,
      booking_platform: existing?.booking_platform ?? "huetten-holiday.com",
      phone: existing?.phone ?? null,
      email: metadata?.email ?? existing?.email ?? null,
      warden_name: existing?.warden_name ?? null,
      sleeping_places_total:
        toPositiveIntOrNull(metadata?.sleepingPlacesTotal) ?? existing?.sleeping_places_total ?? null,
      price_from_eur: existing?.price_from_eur ?? null,
      latitude: toNumberOrNull(metadata?.latitude) ?? existing?.latitude ?? null,
      longitude: toNumberOrNull(metadata?.longitude) ?? existing?.longitude ?? null,
      source_url: sourceUrl,
    };
  });

  const baseRows = extendedRows.map((row) => ({
    id: row.id,
    name: row.name,
    booking_url: row.booking_url,
    operator: row.operator,
    elevation_m: row.elevation_m,
  }));

  const extendedUrl = `${supabaseUrl}/rest/v1/huts?on_conflict=id`;
  try {
    await upsertBatched(extendedUrl, toRestHeaders(serviceRoleKey), extendedRows, 200);
    return { upserted: extendedRows.length, fallback: false };
  } catch (error) {
    if (!String(error?.message ?? "").includes("PGRST204")) {
      throw error;
    }
    await upsertBatched(extendedUrl, toRestHeaders(serviceRoleKey), baseRows, 200);
    return { upserted: baseRows.length, fallback: true };
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const source = args.source;
  if (!source) {
    throw new Error("Missing --source argument.");
  }

  const inputDir = args["input-dir"] ?? getDefaultInputDir(source);
  if (!inputDir) {
    throw new Error(`No default input directory found for source '${source}'.`);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  }

  const startedAt = new Date().toISOString();
  const runId =
    args["run-id"] ??
    process.env.GITHUB_RUN_ID ??
    `${source}-${new Date().toISOString().replace(/[:.]/g, "")}`;
  const scraperOutcome = args["scraper-outcome"] ?? "success";
  const resortId = args["resort-id"] ?? process.env.RESORT_ID ?? "A_6511_SKIHU";

  const mappingPath = path.resolve(process.cwd(), "scripts/lib/provider-mapping.json");
  if (!fs.existsSync(mappingPath)) {
    throw new Error(`Missing mapping file: ${mappingPath}`);
  }
  const mapping = loadProviderMapping(mappingPath);

  const filePaths = listJsonFiles(path.resolve(process.cwd(), inputDir));

  if (scraperOutcome !== "success") {
    await upsertScrapeRun({
      supabaseUrl,
      serviceRoleKey,
      source,
      runId,
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      errorSummary: `Scraper step failed with outcome '${scraperOutcome}'.`,
      metadata: { source, inputDir, fileCount: filePaths.length },
    });
    console.log(`[${source}] scraper outcome '${scraperOutcome}', wrote failed scrape_runs row.`);
    return;
  }

  if (filePaths.length === 0) {
    await upsertScrapeRun({
      supabaseUrl,
      serviceRoleKey,
      source,
      runId,
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      errorSummary: `No JSON files found in ${inputDir}.`,
      metadata: { source, inputDir, fileCount: 0 },
    });
    throw new Error(`No JSON files found in ${inputDir}.`);
  }

  const rows = normalizeFiles({
    source,
    filePaths,
    mapping,
    resortId,
  });

  if (rows.length === 0) {
    await upsertScrapeRun({
      supabaseUrl,
      serviceRoleKey,
      source,
      runId,
      status: "partial",
      startedAt,
      finishedAt: new Date().toISOString(),
      errorSummary: "Normalization produced zero rows.",
      metadata: { source, inputDir, fileCount: filePaths.length, rowCount: 0 },
    });
    throw new Error("Normalization produced zero rows.");
  }

  await upsertAvailabilityRows({
    supabaseUrl,
    serviceRoleKey,
    rows,
  });

  let huettenholidayHutsSync = null;
  if (source === "huettenholiday") {
    huettenholidayHutsSync = await upsertHuettenholidayHuts({
      supabaseUrl,
      serviceRoleKey,
      filePaths,
      mapping: mapping.huettenholiday ?? {},
    });
  }

  const finishedAt = new Date().toISOString();
  await upsertScrapeRun({
    supabaseUrl,
    serviceRoleKey,
    source,
    runId,
    status: "ok",
    startedAt,
    finishedAt,
    errorSummary: null,
    metadata: {
      source,
      inputDir,
      fileCount: filePaths.length,
      rowCount: rows.length,
      hutsUpserted: huettenholidayHutsSync?.upserted ?? 0,
      hutsSchemaFallback: huettenholidayHutsSync?.fallback ?? false,
    },
  });

  const hutsInfo =
    source === "huettenholiday"
      ? ` huts=${huettenholidayHutsSync?.upserted ?? 0} (fallback=${huettenholidayHutsSync?.fallback ?? false})`
      : "";
  console.log(`[${source}] normalized ${rows.length} rows from ${filePaths.length} files and upserted successfully.${hutsInfo}`);
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
