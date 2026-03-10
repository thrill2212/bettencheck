#!/usr/bin/env node

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function toHeaders(serviceRoleKey) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    Accept: "application/json",
  };
}

function getSeasonBounds(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  const seasonYear = month > 10 || (month === 10 && day > 1) ? year + 1 : year;
  return {
    start: `${seasonYear}-06-01`,
    end: `${seasonYear}-10-01`,
  };
}

function getMaxStalenessHours() {
  const value = Number.parseInt(process.env.LIVE_READINESS_MAX_STALENESS_HOURS ?? "8", 10);
  if (Number.isFinite(value) && value >= 1 && value <= 168) return value;
  return 8;
}

function isAvailabilityRequiredProvider(provider) {
  const normalized = String(provider ?? "").trim().toLowerCase();
  if (!normalized) return true;
  return !normalized.includes("fallback");
}

function parseProviderScope() {
  const raw = String(process.env.READINESS_PROVIDER_SCOPE ?? "").trim();
  if (!raw) return null;
  const values = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return values.length > 0 ? new Set(values) : null;
}

async function getJson(url, headers) {
  const response = await fetch(url, { method: "GET", headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return response.json();
}

async function getAllJson(baseUrl, headers, pageSize = 1000) {
  const allRows = [];
  let offset = 0;
  while (true) {
    const url = new URL(baseUrl);
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(offset));
    const rows = await getJson(url.toString(), headers);
    allRows.push(...(rows ?? []));
    if (!Array.isArray(rows) || rows.length < pageSize) break;
    offset += pageSize;
  }
  return allRows;
}

async function main() {
  const supabaseUrl = requireEnv("SUPABASE_URL").replace(/\/$/, "");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const season = getSeasonBounds();
  const maxStalenessHours = getMaxStalenessHours();
  const providerScope = parseProviderScope();
  const headers = toHeaders(serviceRoleKey);

  const routesParams = new URLSearchParams();
  routesParams.set("select", "id");
  routesParams.set("is_active", "eq.true");
  routesParams.set("publish_status", "eq.published");
  routesParams.set("order", "id.asc");
  const routes = await getJson(`${supabaseUrl}/rest/v1/routes?${routesParams.toString()}`, headers);
  const routeIds = (routes ?? []).map((route) => route.id).filter(Boolean);

  if (routeIds.length === 0) {
    console.log(JSON.stringify({ totalRoutes: 0, notCoverageReadyRoutes: [], notFreshRoutes: [] }, null, 2));
    return;
  }

  const quotedRouteIds = routeIds.map((id) => `"${id}"`).join(",");
  const stagesParams = new URLSearchParams();
  stagesParams.set("select", "route_id,hut_id,huts!route_stages_hut_id_fkey(provider)");
  stagesParams.set("route_id", `in.(${quotedRouteIds})`);
  const stages = await getJson(`${supabaseUrl}/rest/v1/route_stages?${stagesParams.toString()}`, headers);

  const routeRequiredHuts = new Map();
  for (const stage of stages ?? []) {
    const provider = String(stage?.huts?.provider ?? "").trim().toLowerCase();
    if (!isAvailabilityRequiredProvider(provider)) continue;
    if (providerScope && !providerScope.has(provider)) continue;
    const routeId = stage.route_id;
    const hutId = stage.hut_id;
    if (!routeId || !hutId) continue;
    if (!routeRequiredHuts.has(routeId)) routeRequiredHuts.set(routeId, new Set());
    routeRequiredHuts.get(routeId).add(hutId);
  }

  const requiredHutIds = [...new Set([...routeRequiredHuts.values()].flatMap((set) => [...set]))];
  const latestByHut = new Map();
  if (requiredHutIds.length > 0) {
    const quotedHutIds = requiredHutIds.map((id) => `"${id}"`).join(",");
    const availabilityParams = new URLSearchParams();
    availabilityParams.set("select", "hut_id,checked_at,date");
    availabilityParams.set("hut_id", `in.(${quotedHutIds})`);
    availabilityParams.set("date", `gte.${season.start}`);
    availabilityParams.append("date", `lt.${season.end}`);
    availabilityParams.set("order", "checked_at.desc");
    const availabilityRows = await getAllJson(
      `${supabaseUrl}/rest/v1/availability_daily?${availabilityParams.toString()}`,
      headers,
      1000,
    );
    for (const row of availabilityRows ?? []) {
      if (!latestByHut.has(row.hut_id)) latestByHut.set(row.hut_id, row.checked_at);
    }
  }

  const nowMs = Date.now();
  const notCoverageReadyRoutes = [];
  const notFreshRoutes = [];
  for (const routeId of routeIds) {
    const hutIds = [...(routeRequiredHuts.get(routeId) ?? [])];
    const missing = hutIds.filter((hutId) => !latestByHut.has(hutId));
    if (missing.length > 0) {
      notCoverageReadyRoutes.push(routeId);
      continue;
    }
    const stale = hutIds.filter((hutId) => {
      const checkedAt = latestByHut.get(hutId);
      const ts = Date.parse(checkedAt ?? "");
      if (!Number.isFinite(ts)) return true;
      return (nowMs - ts) / (1000 * 60 * 60) > maxStalenessHours;
    });
    if (stale.length > 0) notFreshRoutes.push(routeId);
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    season,
    maxStalenessHours,
    providerScope: providerScope ? [...providerScope] : null,
    totalRoutes: routeIds.length,
    notCoverageReadyRoutes,
    notFreshRoutes,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (notCoverageReadyRoutes.length > 0 || notFreshRoutes.length > 0) {
    process.exitCode = 1;
  }
}

await main();
