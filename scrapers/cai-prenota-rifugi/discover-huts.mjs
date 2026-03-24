#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { discoverAllShelters } from "./lib/api.mjs";
import { partitionSheltersByAlpineStatus } from "./lib/filter-alpine.mjs";

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

async function main() {
  const args = parseArgs(process.argv);
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const dataDir = path.resolve(scriptDir, "data");
  const rawOutputPath = path.resolve(args["raw-output"] ?? path.join(dataDir, "shelters.raw.json"));
  const alpineOutputPath = path.resolve(
    args["alpine-output"] ?? path.join(dataDir, "shelters.alpine.json"),
  );
  const rowsPerPage = Number(args["rows-per-page"] ?? 100);
  const pageLimit = args["page-limit"] ? Number(args["page-limit"]) : null;

  const discovered = await discoverAllShelters({
    rowsPerPage,
    pageLimit,
    log: (message) => console.error(`[cai-prenota-rifugi] ${message}`),
  });
  const partitioned = partitionSheltersByAlpineStatus(discovered.shelters);
  const scrapedAt = new Date().toISOString();

  writeJson(rawOutputPath, {
    scrapedAt,
    source: "cai-prenota-rifugi",
    totalResults: discovered.totalResults,
    totalPages: discovered.totalPages,
    rowsPerPage: discovered.rows,
    shelters: discovered.shelters,
  });

  writeJson(alpineOutputPath, {
    scrapedAt,
    source: "cai-prenota-rifugi",
    totalResults: discovered.totalResults,
    totalPages: discovered.totalPages,
    rowsPerPage: discovered.rows,
    summary: partitioned.summary,
    shelters: partitioned.alpine,
    nonAlpineShelters: partitioned.nonAlpine,
    unclassifiedShelters: partitioned.unclassified,
  });

  console.error(
    `[cai-prenota-rifugi] discovered ${discovered.shelters.length} shelters (${partitioned.summary.alpine} alpine, ${partitioned.summary.nonAlpine} non-alpine, ${partitioned.summary.unclassified} unclassified)`,
  );
  console.log(alpineOutputPath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
