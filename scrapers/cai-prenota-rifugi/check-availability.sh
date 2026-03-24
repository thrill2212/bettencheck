#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DISCOVERY_PAGE_LIMIT="${DISCOVERY_PAGE_LIMIT:-}"
ROWS_PER_PAGE="${ROWS_PER_PAGE:-100}"
INPUT_FILE="${INPUT_FILE:-$SCRIPT_DIR/data/shelters.alpine.json}"
OUTPUT_DIR="${OUTPUT_DIR:-$SCRIPT_DIR/availability-results}"
CONCURRENCY="${CONCURRENCY:-3}"
MONTHS="${MONTHS:-}"
MONTH_WINDOW="${MONTH_WINDOW:-6}"
PEOPLE="${PEOPLE:-1}"

DISCOVERY_ARGS=(--rows-per-page "$ROWS_PER_PAGE")
if [ -n "$DISCOVERY_PAGE_LIMIT" ]; then
  DISCOVERY_ARGS+=(--page-limit "$DISCOVERY_PAGE_LIMIT")
fi

AVAILABILITY_ARGS=(
  --input-file "$INPUT_FILE"
  --output-dir "$OUTPUT_DIR"
  --concurrency "$CONCURRENCY"
  --month-window "$MONTH_WINDOW"
  --people "$PEOPLE"
)

if [ -n "$MONTHS" ]; then
  AVAILABILITY_ARGS+=(--months "$MONTHS")
fi

echo "[cai-prenota-rifugi] Discovering huts..."
node "$SCRIPT_DIR/discover-huts.mjs" "${DISCOVERY_ARGS[@]}"

echo "[cai-prenota-rifugi] Checking availability..."
node "$SCRIPT_DIR/check-availability.mjs" "${AVAILABILITY_ARGS[@]}"
