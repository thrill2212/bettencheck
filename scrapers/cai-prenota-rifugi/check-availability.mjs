#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { buildDetailPageUrl, buildMediaUrl, fetchShelterCalendar } from "./lib/api.mjs";
import { getInfoValue } from "./lib/filter-alpine.mjs";

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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function slugify(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstNonEmpty(values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const item = value.find((entry) => String(entry ?? "").trim() !== "");
      if (item !== undefined) return item;
      continue;
    }
    if (String(value).trim() !== "") return value;
  }
  return null;
}

function parseMonthSpec(spec) {
  const [year, month] = String(spec).split("-").map((value) => Number(value));
  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    throw new Error(`Invalid month spec '${spec}'. Expected YYYY-MM.`);
  }
  return { year, month };
}

function buildRollingMonths(windowSize = 6) {
  const months = [];
  const now = new Date();
  for (let offset = 0; offset < windowSize; offset += 1) {
    const current = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    months.push({
      year: current.getUTCFullYear(),
      month: current.getUTCMonth() + 1,
    });
  }
  return months;
}

function getSheltersFromInput(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.shelters)) return payload.shelters;
  return [];
}

function mapProviderStatus(type) {
  if (type === "open") return "available";
  if (type === "closed") return "closed";
  return "unavailable";
}

function buildIsoDate(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function getPrimaryCoords(shelter) {
  const address = Array.isArray(shelter?.addresses) ? shelter.addresses[0] : null;
  const lat = toNumberOrNull(address?.coords?.lat);
  const lng = toNumberOrNull(address?.coords?.lng);
  return { latitude: lat, longitude: lng };
}

function mapShelterMetadata(shelter) {
  const { latitude, longitude } = getPrimaryCoords(shelter);
  const detailPageUrl = buildDetailPageUrl(shelter);
  const websiteUrl = firstNonEmpty([
    shelter?.publicwebsite,
    shelter?.website,
    shelter?.social_channels?.find((channel) => String(channel?.url ?? "").startsWith("http"))?.url,
  ]);
  const email = firstNonEmpty([shelter?.publicmail, shelter?.email]);
  const phone = firstNonEmpty([shelter?.phone]);
  return {
    id: shelter.id,
    name: shelter.name ?? null,
    slug: shelter.slug ?? slugify(shelter.name),
    detailPageUrl,
    bookingUrl: detailPageUrl,
    websiteUrl: websiteUrl ? String(websiteUrl) : null,
    imageUrl: buildMediaUrl(shelter?.img?.file),
    region: getInfoValue(shelter, "region_geo"),
    country: firstNonEmpty([
      shelter?.addresses?.[0]?.country,
      "IT",
    ]),
    municipality: getInfoValue(shelter, "municipality_geo"),
    locality: getInfoValue(shelter, "locality_geo"),
    massif: getInfoValue(shelter, "massif_geo"),
    valley: getInfoValue(shelter, "valley_geo"),
    caiBranch: getInfoValue(shelter, "branch_cai"),
    latitude,
    longitude,
    altitude: toNumberOrNull(shelter?.altitude ?? shelter?.height),
    sleepingPlacesTotal: toNumberOrNull(shelter?.beds),
    emergencyBeds: toNumberOrNull(shelter?.emergency_beds),
    priceFromEur: toNumberOrNull(shelter?.price),
    email: email ? String(email) : null,
    phone: phone ? String(phone) : null,
    paths: Array.isArray(shelter?.paths) ? shelter.paths : [],
    services: Array.isArray(shelter?.services) ? shelter.services : [],
    classification: shelter?.classification ?? null,
    raw: shelter,
  };
}

async function mapWithConcurrency(items, worker, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = parseArgs(process.argv);
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const defaultInputPath = path.resolve(scriptDir, "data/shelters.alpine.json");
  const inputPath = path.resolve(args["input-file"] ?? defaultInputPath);
  const outputDir = path.resolve(args["output-dir"] ?? path.resolve(scriptDir, "availability-results"));
  const summaryPath = path.resolve(args["summary-file"] ?? path.join(outputDir, "scrape-summary.json"));
  const failedPath = path.resolve(args["failed-file"] ?? path.join(outputDir, "failed-huts.json"));
  const people = Number(args.people ?? 1);
  const monthSpecs = args.months
    ? String(args.months)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map(parseMonthSpec)
    : buildRollingMonths(Number(args["month-window"] ?? 6));
  const concurrency = Number(args.concurrency ?? 3);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Missing input file: ${inputPath}. Run discover-huts.mjs first.`);
  }

  const shelters = getSheltersFromInput(readJson(inputPath));
  const timestamp = new Date().toISOString();
  const results = [];
  const failures = [];

  const processed = await mapWithConcurrency(
    shelters,
    async (shelter) => {
      const metadata = mapShelterMetadata(shelter);
      const availability = [];

      try {
        for (const monthSpec of monthSpecs) {
          const payload = await fetchShelterCalendar({
            shelterId: shelter.id,
            slug: shelter.slug,
            year: monthSpec.year,
            month: monthSpec.month,
            people,
          });
          const response = Array.isArray(payload?.response) ? payload.response : [];
          for (const day of response) {
            if (!Number.isFinite(Number(day?.day))) continue;
            availability.push({
              date: buildIsoDate(monthSpec.year, monthSpec.month, Number(day.day)),
              status: mapProviderStatus(day?.type),
              providerStatus: day?.type ?? null,
              availablePlaces: null,
              totalPlaces: metadata.sleepingPlacesTotal ?? null,
            });
          }
        }

        return {
          id: shelter.id,
          name: shelter.name,
          metadata,
          availability,
        };
      } catch (error) {
        failures.push({
          shelterId: shelter.id,
          shelterName: shelter.name,
          error: String(error?.message ?? error),
        });
        return null;
      }
    },
    concurrency,
  );

  for (const cabin of processed) {
    if (cabin) results.push(cabin);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const outputFile = path.join(
    outputDir,
    `availability-cai-prenota-rifugi-${timestamp.replace(/[:.]/g, "")}.json`,
  );

  writeJson(outputFile, {
    scrapedAt: timestamp,
    source: "cai-prenota-rifugi",
    peopleProbe: people,
    months: monthSpecs,
    cabins: results,
  });

  writeJson(failedPath, failures);
  writeJson(summaryPath, {
    generatedAt: timestamp,
    sourceShelterFile: inputPath,
    outputFile,
    failedHutsFile: failedPath,
    peopleProbe: people,
    monthCount: monthSpecs.length,
    attemptedCount: shelters.length,
    successCount: results.length,
    failedCount: failures.length,
    attemptedHuts: shelters.map((shelter) => ({
      shelterId: shelter.id,
      shelterName: shelter.name,
    })),
    successHuts: results.map((cabin) => ({
      shelterId: cabin.id,
      shelterName: cabin.name,
    })),
    failedHuts: failures,
  });

  console.error(
    `[cai-prenota-rifugi] wrote ${results.length} huts to ${outputFile} (${failures.length} failures)`,
  );
  console.log(outputFile);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
