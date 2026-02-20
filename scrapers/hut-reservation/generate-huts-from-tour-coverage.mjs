#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { input: "", output: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--input") args.input = argv[++i] ?? "";
    if (token === "--output") args.output = argv[++i] ?? "";
  }
  return args;
}

const { input, output } = parseArgs(process.argv);
if (!input || !output) {
  console.error("Usage: node generate-huts-from-tour-coverage.mjs --input <file> --output <file>");
  process.exit(1);
}

const inputPath = path.resolve(process.cwd(), input);
const outputPath = path.resolve(process.cwd(), output);

if (!fs.existsSync(inputPath)) {
  throw new Error(`Input file not found: ${inputPath}`);
}

const coverage = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const tours = Array.isArray(coverage.tours) ? coverage.tours : [];

const byId = new Map();
for (const tour of tours) {
  const huts = Array.isArray(tour.huts) ? tour.huts : [];
  for (const hut of huts) {
    const ref = String(hut?.ohrsHutId ?? "").trim();
    if (!/^\d+$/.test(ref)) continue;
    const id = Number(ref);
    const name = String(hut?.name ?? `hut-${id}`).trim() || `hut-${id}`;
    if (!byId.has(id)) byId.set(id, { hutId: id, hutName: name });
  }
}

const rows = [...byId.values()].sort((a, b) => a.hutId - b.hutId);
fs.writeFileSync(outputPath, JSON.stringify(rows, null, 2) + "\n", "utf8");

console.log(
  JSON.stringify(
    {
      generated: true,
      input: inputPath,
      output: outputPath,
      huts: rows.length,
    },
    null,
    2
  )
);
