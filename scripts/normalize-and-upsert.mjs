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

async function upsertAvailabilityRows({
  supabaseUrl,
  serviceRoleKey,
  rows,
}) {
  if (rows.length === 0) return;
  const url = `${supabaseUrl}/rest/v1/availability_daily?on_conflict=hut_id,date`;
  await postJson(url, toRestHeaders(serviceRoleKey), rows);
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
    metadata: { source, inputDir, fileCount: filePaths.length, rowCount: rows.length },
  });

  console.log(
    `[${source}] normalized ${rows.length} rows from ${filePaths.length} files and upserted successfully.`
  );
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
