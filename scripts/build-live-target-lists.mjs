#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

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

function writeJson(filePath, payload) {
  const resolved = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function toSafeString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function slugify(value) {
  return toSafeString(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function defaultSearchTerm(name) {
  const slug = slugify(name);
  const first = slug.split("-").find(Boolean);
  return first || "hut";
}

function isAvailabilityRequiredProvider(provider) {
  const normalized = toSafeString(provider).toLowerCase();
  if (!normalized) return true;
  return !normalized.includes("fallback");
}

function getStageAvailabilityHutId(stage) {
  return toSafeString(stage?.overnight_hut_id);
}

function parseExplicitRouteIds(value) {
  if (!value) return [];
  return [...new Set(String(value).split(",").map((v) => v.trim()).filter(Boolean))];
}

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

async function fetchPublishedRouteIds({ supabaseUrl, serviceRoleKey, explicitRouteIds }) {
  const params = new URLSearchParams();
  params.set("select", "id");
  params.set("is_active", "eq.true");
  params.set("publish_status", "eq.published");
  params.set("order", "id.asc");
  if (explicitRouteIds.length > 0) {
    const quoted = explicitRouteIds.map((id) => `"${id}"`).join(",");
    params.set("id", `in.(${quoted})`);
  }
  const url = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/routes?${params.toString()}`;
  const data = await getJson(url, toRestHeaders(serviceRoleKey));
  return (data ?? []).map((row) => row.id);
}

async function main() {
  const args = parseArgs(process.argv);
  const hutOutput = args["hut-output"] ?? "scrapers/hut-reservation/huts.from-live-targets.json";
  const huettenholidayOutput =
    args["huettenholiday-output"] ?? "scrapers/huettenholiday/cabins.from-live-targets.json";
  const explicitRouteIds = parseExplicitRouteIds(
    args["route-ids"] ?? process.env.LIVE_AVAILABILITY_ROUTE_IDS,
  );

  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const restBase = `${supabaseUrl.replace(/\/$/, "")}/rest/v1`;
  const headers = toRestHeaders(serviceRoleKey);

  const routeIds = await fetchPublishedRouteIds({
    supabaseUrl,
    serviceRoleKey,
    explicitRouteIds,
  });

  let stages = [];
  if (routeIds.length > 0) {
    const quoted = routeIds.map((id) => `"${id}"`).join(",");
    const params = new URLSearchParams();
    params.set("select", "route_id,day_index,overnight_hut_id");
    params.set("route_id", `in.(${quoted})`);
    params.set("order", "route_id.asc,day_index.asc");
    stages = await getJson(`${restBase}/route_stages?${params.toString()}`, headers);
  }

  const hutIds = [...new Set(stages.map((row) => getStageAvailabilityHutId(row)).filter(Boolean))];
  const hutsById = new Map();
  if (hutIds.length > 0) {
    const quoted = hutIds.map((id) => `"${id}"`).join(",");
    const params = new URLSearchParams();
    params.set("select", "id,name,provider,provider_ref");
    params.set("id", `in.(${quoted})`);
    const data = await getJson(`${restBase}/huts?${params.toString()}`, headers);
    for (const hut of data ?? []) hutsById.set(hut.id, hut);
  }

  const hutReservationMap = new Map();
  const huettenholidayMap = new Map();
  const ignored = new Set();

  for (const stage of stages) {
    const hutId = getStageAvailabilityHutId(stage);
    const hut = hutsById.get(hutId);
    if (!hut) continue;

    const provider = toSafeString(hut.provider).toLowerCase();
    const providerRef = toSafeString(hut.provider_ref);
    if (!provider || !providerRef || !isAvailabilityRequiredProvider(provider)) {
      ignored.add(hutId);
      continue;
    }

    if (provider === "hut-reservation") {
      const hutId = Number(providerRef);
      if (!Number.isFinite(hutId)) continue;
      if (!hutReservationMap.has(hutId)) {
        hutReservationMap.set(hutId, {
          hutId,
          hutName: toSafeString(hut.name) || `hut-${hutId}`,
        });
      }
      continue;
    }

    if (provider === "huettenholiday") {
      const cabinId = Number(providerRef);
      if (!Number.isFinite(cabinId)) continue;
      if (!huettenholidayMap.has(cabinId)) {
        const cabinName = toSafeString(hut.name) || `Cabin ${cabinId}`;
        huettenholidayMap.set(cabinId, {
          cabinId,
          cabinName,
          cabinSlug: slugify(cabinName) || `cabin-${cabinId}`,
          cabinSearchTerm: defaultSearchTerm(cabinName),
        });
      }
    }
  }

  const huts = [...hutReservationMap.values()].sort((a, b) => a.hutId - b.hutId);
  const cabins = [...huettenholidayMap.values()].sort((a, b) => a.cabinId - b.cabinId);

  writeJson(hutOutput, huts);
  writeJson(huettenholidayOutput, cabins);

  console.log(
    JSON.stringify(
      {
        source: "supabase",
        routeCount: routeIds.length,
        stageCount: stages.length,
        hutReservationCount: huts.length,
        huettenholidayCount: cabins.length,
        ignoredHutIds: ignored.size,
        hutOutput: path.resolve(process.cwd(), hutOutput),
        huettenholidayOutput: path.resolve(process.cwd(), huettenholidayOutput),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
