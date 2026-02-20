#!/bin/bash

set -euo pipefail

# Change to script directory to ensure relative paths work correctly
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Configuration
API_AVAILABILITY_URL="https://www.hut-reservation.org/api/v1/reservation/getHutAvailability"
API_HUT_INFO_URL="https://www.hut-reservation.org/api/v1/reservation/hutInfo"
OUTPUT_DIR="availability-results"
HUT_LIST_FILE="${HUT_LIST_FILE:-huts.json}"
REQUEST_DELAY_SECONDS="${REQUEST_DELAY_SECONDS:-1.25}"
USER_AGENT="${USER_AGENT:-Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36}"
COOKIE_JAR="${COOKIE_JAR:-.cookies.txt}"
MAX_RETRIES="${MAX_RETRIES:-6}"
RETRY_DELAY_SECONDS="${RETRY_DELAY_SECONDS:-6}"
BLOCK_COOLDOWN_SECONDS="${BLOCK_COOLDOWN_SECONDS:-45}"

# Legacy fallback when no hut list is available
LEGACY_HUT_IDS=(366 476)
LEGACY_HUT_NAMES=("Braunschweiger-Huette" "Martin-Busch-Huette")

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Prime session cookies once before API requests
prime_session() {
  curl -sS -m 20 -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
  -H "User-Agent: ${USER_AGENT}" \
  "https://www.hut-reservation.org/" >/dev/null || true
}

fetch_with_retries() {
  local url="$1"
  local expect_array="${2:-false}"
  local attempt=1
  local response=""
  local status=""
  local body=""

  while [ "$attempt" -le "$MAX_RETRIES" ]; do
    response=$(curl -sS -m 25 -w $'\n%{http_code}' -X GET "$url" \
      -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
      -H "Accept: application/json, text/plain, */*" \
      -H "Content-Type: application/json" \
      -H "Origin: https://www.hut-reservation.org" \
      -H "Referer: https://www.hut-reservation.org/" \
      -H "User-Agent: ${USER_AGENT}" || true)

    status=$(printf '%s\n' "$response" | tail -n 1)
    body=$(printf '%s\n' "$response" | sed '$d')

    if [ "$status" = "200" ]; then
      if [ "$expect_array" = "true" ]; then
        if echo "$body" | jq -e 'type == "array"' >/dev/null 2>&1; then
          printf '%s' "$body"
          return 0
        fi
      else
        if echo "$body" | jq -e 'type == "object"' >/dev/null 2>&1; then
          printf '%s' "$body"
          return 0
        fi
      fi
    fi

    if [ "$status" = "403" ] || [ "$status" = "429" ] || echo "$body" | grep -qiE "forbidden|blocked|access denied"; then
      echo -e "${YELLOW}  Attempt $attempt/$MAX_RETRIES got HTTP ${status:-n/a} (blocked). Cooling down ${BLOCK_COOLDOWN_SECONDS}s...${NC}" >&2
      sleep "$BLOCK_COOLDOWN_SECONDS"
      prime_session
    else
      echo -e "${YELLOW}  Attempt $attempt/$MAX_RETRIES failed (HTTP ${status:-n/a}). Retrying in ${RETRY_DELAY_SECONDS}s...${NC}" >&2
      sleep "$RETRY_DELAY_SECONDS"
    fi

    attempt=$((attempt + 1))
  done

  return 1
}

prime_session

# Load huts from list file, fallback to legacy IDs if needed
declare -a HUT_ROWS=()
if [ -f "$HUT_LIST_FILE" ] && jq -e 'type == "array" and length > 0' "$HUT_LIST_FILE" >/dev/null 2>&1; then
  while IFS=$'\t' read -r hut_id hut_name; do
    [ -n "$hut_id" ] || continue
    HUT_ROWS+=("${hut_id}"$'\t'"${hut_name}")
  done < <(jq -r '.[] | [(.hutId | tostring), (.hutName // ("hut-" + (.hutId | tostring)))] | @tsv' "$HUT_LIST_FILE")
else
  echo -e "${YELLOW}Warning: $HUT_LIST_FILE not found or invalid. Falling back to legacy hut IDs.${NC}"
  for i in "${!LEGACY_HUT_IDS[@]}"; do
    HUT_ROWS+=("${LEGACY_HUT_IDS[$i]}"$'\t'"${LEGACY_HUT_NAMES[$i]}")
  done
fi

# Get current date and determine season
current_date=$(date +%Y-%m-%d)
current_year=$(date +%Y)
current_month=$(date +%m)
current_day=$(date +%d)

# Determine which year's season to check
# If we're past October 1st, check next year's season
if [ "$current_month" -gt 10 ] || ([ "$current_month" -eq 10 ] && [ "$current_day" -gt 1 ]); then
  season_year=$((current_year + 1))
else
  season_year=$current_year
fi

season_start="${season_year}-06-01"
season_end="${season_year}-10-01"

echo "=========================================="
echo "Checking Hut Availability"
echo "=========================================="
echo "Current Date: $current_date"
echo "Season: $season_start to $season_end"
echo "Hut list source: $HUT_LIST_FILE"
echo "Huts to process: ${#HUT_ROWS[@]}"
echo "=========================================="
echo ""

# Initialize summary for GitHub Actions
summary_file="${GITHUB_STEP_SUMMARY:-summary.md}"
echo "# Hut Availability Check Results" > "$summary_file"
echo "" >> "$summary_file"
echo "**Checked at:** $(date -u +"%Y-%m-%dT%H:%M:%SZ")" >> "$summary_file"
echo "**Season:** $season_start to $season_end" >> "$summary_file"
echo "**Huts processed:** ${#HUT_ROWS[@]}" >> "$summary_file"
echo "" >> "$summary_file"
echo "| Hut Name | Hut ID | Total Days | Available Days | Closed Days |" >> "$summary_file"
echo "|----------|--------|------------|----------------|-------------|" >> "$summary_file"

# Process each hut
for row in "${HUT_ROWS[@]}"; do
  hut_id="${row%%$'\t'*}"
  hut_name="${row#*$'\t'}"

  hut_name_slug=$(echo "$hut_name" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
  if [ -z "$hut_name_slug" ]; then
    hut_name_slug="hut-${hut_id}"
  fi

  echo -e "${BLUE}Processing: $hut_name (ID: $hut_id)${NC}"

  # Fetch availability with retries/backoff (WAF may temporarily block rapid request bursts)
  if ! availability_response=$(fetch_with_retries "${API_AVAILABILITY_URL}?hutId=${hut_id}&step=WIZARD" true); then
    echo -e "${YELLOW}Warning: Availability request failed for $hut_name (ID: $hut_id) after ${MAX_RETRIES} attempts${NC}"
    continue
  fi

  # Fetch hut info to enrich metadata/location
  hut_info_response=$(fetch_with_retries "${API_HUT_INFO_URL}/${hut_id}" false || true)

  hut_info_json='{}'
  if [ -n "$hut_info_response" ] && echo "$hut_info_response" | jq -e '.hutId? != null' >/dev/null 2>&1; then
    hut_info_json="$hut_info_response"
  fi

  location_json=$(echo "$hut_info_json" | jq '
    (.coordinates // "") as $coords
    | ($coords | split("/")) as $parts
    | {
        rawCoordinates: (if $coords == "" then null else $coords end),
        latitude: (if ($parts | length) == 2 then ($parts[0] | tonumber?) else null end),
        longitude: (if ($parts | length) == 2 then ($parts[1] | tonumber?) else null end)
      }
  ')

  # Use filesystem-safe timestamp format (no colons for GitHub artifacts)
  timestamp=$(date -u +"%Y-%m-%dT%H%M%SZ")
  timestamp_display=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  output_file="${OUTPUT_DIR}/availability-${hut_name_slug}-${hut_id}-${timestamp}.json"

  # Filter days within season and categorize
  filtered_data=$(echo "$availability_response" | jq \
    --arg start "$season_start" \
    --arg end "$season_end" \
    --arg hutid "$hut_id" \
    --arg hutname "$hut_name" \
    --arg checkedat "$timestamp_display" \
    --argjson hutinfo "$hut_info_json" \
    --argjson location "$location_json" '
      {
        hutId: ($hutid | tonumber),
        hutName: ($hutinfo.hutName // $hutname),
        source: "hut-reservation",
        sourceHutRef: $hutid,
        bookingUrl: ("https://www.hut-reservation.org/reservation/book-hut/" + $hutid + "/wizard"),
        checkedAt: $checkedat,
        season: {
          start: $start,
          end: $end
        },
        hutInfo: {
          tenantCode: ($hutinfo.tenantCode // null),
          tenantCountry: ($hutinfo.tenantCountry // null),
          altitude: ($hutinfo.altitude // null),
          hutWebsite: ($hutinfo.hutWebsite // null),
          hutWarden: ($hutinfo.hutWarden // null),
          phone: ($hutinfo.phone // null),
          providerName: ($hutinfo.providerName // null)
        },
        location: $location,
        allDays: [.[] | select(.date[0:10] >= $start and .date[0:10] < $end)],
        availableDays: [.[] | select(.date[0:10] >= $start and .date[0:10] < $end and .hutStatus != "CLOSED")],
        closedDays: [.[] | select(.date[0:10] >= $start and .date[0:10] < $end and .hutStatus == "CLOSED")],
        totalDaysChecked: ([.[] | select(.date[0:10] >= $start and .date[0:10] < $end)] | length),
        availableCount: ([.[] | select(.date[0:10] >= $start and .date[0:10] < $end and .hutStatus != "CLOSED")] | length),
        closedCount: ([.[] | select(.date[0:10] >= $start and .date[0:10] < $end and .hutStatus == "CLOSED")] | length)
      }
    ')

  # Save to file
  echo "$filtered_data" > "$output_file"

  # Extract counts
  total_days=$(echo "$filtered_data" | jq -r '.totalDaysChecked')
  available_count=$(echo "$filtered_data" | jq -r '.availableCount')
  closed_count=$(echo "$filtered_data" | jq -r '.closedCount')
  latitude=$(echo "$filtered_data" | jq -r '.location.latitude // "n/a"')
  longitude=$(echo "$filtered_data" | jq -r '.location.longitude // "n/a"')

  # Print summary
  echo -e "  Total days in season: ${total_days}"
  echo -e "  ${GREEN}Available days: ${available_count}${NC}"
  echo -e "  ${YELLOW}Closed days: ${closed_count}${NC}"
  echo -e "  Location: ${latitude}, ${longitude}"
  echo -e "  Saved to: ${output_file}"
  echo ""

  # Add to GitHub Actions summary
  echo "| $hut_name | $hut_id | $total_days | $available_count | $closed_count |" >> "$summary_file"

  # Show some available dates as examples
  if [ "$available_count" -gt 0 ]; then
    echo "  Sample available dates:"
    echo "$filtered_data" | jq -r '.availableDays[:5] | .[] | "    - \(.dateFormatted // .date) (Status: \(.hutStatus), \(.percentage // "n/a"))"'
    echo ""
  fi

  sleep "$REQUEST_DELAY_SECONDS"
done

echo "=========================================="
echo -e "${GREEN}Check completed!${NC}"
echo "Results saved in: $OUTPUT_DIR/"
echo "=========================================="

# Add artifacts info to summary
echo "" >> "$summary_file"
echo "## Output Files" >> "$summary_file"
echo "" >> "$summary_file"
echo "JSON files with detailed availability + hut metadata have been saved as artifacts." >> "$summary_file"
echo "Each file contains:" >> "$summary_file"
echo "- Season-filtered availability days" >> "$summary_file"
echo "- Availability counts" >> "$summary_file"
echo "- Hut metadata and location (if available via API)" >> "$summary_file"

# Optional: Sync results to Supabase when credentials are provided.
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  echo ""
  echo "=========================================="
  echo "Syncing availability data to Supabase"
  echo "=========================================="

  TOUR_COVERAGE_FILE="${TOUR_COVERAGE_FILE:-$SCRIPT_DIR/tour-id-coverage.json}" \
  OUTPUT_DIR="$OUTPUT_DIR" \
  node "$SCRIPT_DIR/upsert-supabase.mjs"
else
  echo ""
  echo "Supabase sync skipped (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set)."
fi
