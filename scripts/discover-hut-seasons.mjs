#!/usr/bin/env node

/**
 * Season Discovery: determines when each hut opens and closes.
 *
 * For each hut in the database, checks the booking system for the
 * earliest and latest bookable dates. Writes season_open/season_close
 * back to the huts table in Supabase.
 *
 * Run monthly to keep season windows accurate.
 * Usage: node scripts/discover-hut-seasons.mjs
 */

import fs from "node:fs";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function toRestHeaders(serviceRoleKey) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    Prefer: "return=minimal",
  };
}

async function getJson(url, headers) {
  const response = await fetch(url, { method: "GET", headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return response.json();
}

async function patchHut(restBase, headers, hutId, seasonOpen, seasonClose) {
  const url = `${restBase}/huts?id=eq.${encodeURIComponent(hutId)}`;
  const body = {
    season_open: seasonOpen,
    season_close: seasonClose,
    season_checked_at: new Date().toISOString(),
  };
  const response = await fetch(url, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`PATCH ${hutId}: ${response.status} ${text}`);
  }
}

async function main() {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const restBase = `${supabaseUrl.replace(/\/$/, "")}/rest/v1`;
  const headers = toRestHeaders(serviceRoleKey);

  // Determine which year's season to discover
  const now = new Date();
  const year = now.getMonth() >= 10 ? now.getFullYear() + 1 : now.getFullYear();

  // Fetch all huts
  const params = new URLSearchParams();
  params.set("select", "id,name,provider,provider_ref");
  params.set("limit", "2000");
  const allHuts = await getJson(`${restBase}/huts?${params.toString()}`, headers);
  console.log(`Discovering seasons for ${allHuts.length} huts (year: ${year})...`);

  // For each hut, check availability_daily for the earliest and latest dates
  // This uses EXISTING scraped data — no new API calls to booking systems needed.
  // The data from the daily scraper already contains the answer:
  // if a hut has availability rows for May → it opens in May.
  let updated = 0;
  let skipped = 0;
  let noData = 0;

  for (const hut of allHuts) {
    try {
      // Query availability_daily for this hut, this year's season window (wide: Jan–Dec)
      const availParams = new URLSearchParams();
      availParams.set("select", "date");
      availParams.set("hut_id", `eq.${hut.id}`);
      availParams.set("date", `gte.${year}-01-01`);
      availParams.append("date", `lte.${year}-12-31`);
      availParams.set("status", "neq.closed");
      availParams.set("order", "date.asc");
      availParams.set("limit", "1");
      const earliest = await getJson(`${restBase}/availability_daily?${availParams.toString()}`, headers);

      if (!earliest || earliest.length === 0) {
        noData++;
        continue;
      }

      // Get latest date
      const latestParams = new URLSearchParams();
      latestParams.set("select", "date");
      latestParams.set("hut_id", `eq.${hut.id}`);
      latestParams.set("date", `gte.${year}-01-01`);
      latestParams.append("date", `lte.${year}-12-31`);
      latestParams.set("status", "neq.closed");
      latestParams.set("order", "date.desc");
      latestParams.set("limit", "1");
      const latest = await getJson(`${restBase}/availability_daily?${latestParams.toString()}`, headers);

      const seasonOpen = earliest[0].date;
      const seasonClose = latest.length > 0 ? latest[0].date : seasonOpen;

      await patchHut(restBase, headers, hut.id, seasonOpen, seasonClose);
      updated++;

      if (updated % 50 === 0) {
        console.log(`  ... ${updated} huts updated`);
      }
    } catch (err) {
      console.error(`  Error for ${hut.id} (${hut.name}): ${err.message}`);
      skipped++;
    }
  }

  console.log(`\nSeason discovery complete:`);
  console.log(`  Updated: ${updated}`);
  console.log(`  No data: ${noData}`);
  console.log(`  Errors:  ${skipped}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
