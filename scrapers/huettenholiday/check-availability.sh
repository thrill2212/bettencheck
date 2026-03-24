#!/bin/bash

set -euo pipefail

# Change to script directory to ensure relative paths work correctly
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Configuration
CABIN_LIST_FILE="${CABIN_LIST_FILE:-cabins.from-live-targets.json}"
DEFAULT_CABINS=(27 24)
DEFAULT_CABIN_NAMES=("Kemptner Hütte" "Memminger Hütte")
DEFAULT_CABIN_SLUGS=("kemptner-huette" "memminger-huette")
DEFAULT_CABIN_SEARCH_TERMS=("kemptner" "memminger")
OUTPUT_DIR="availability-results"
BASE_URL="https://www.huetten-holiday.com"
IMAGE_BASE_URL="https://huetten-holiday.fra1.digitaloceanspaces.com/images"
TEMP_DIR="/tmp/huettenholiday-$$"

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Cleanup function
cleanup() {
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

# Create temp and output directories
mkdir -p "$TEMP_DIR" "$OUTPUT_DIR"

# Logging functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1" >&2
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1" >&2
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

load_cabin_rows() {
    if [ -f "$CABIN_LIST_FILE" ] && jq -e 'type == "array" and length > 0' "$CABIN_LIST_FILE" >/dev/null 2>&1; then
        jq -r '.[] | [(.cabinId|tostring), (.cabinName // ("Cabin " + (.cabinId|tostring))), (.cabinSlug // ("cabin-" + (.cabinId|tostring))), (.cabinSearchTerm // (.cabinName // ""))] | @tsv' "$CABIN_LIST_FILE"
        return 0
    fi

    for i in "${!DEFAULT_CABINS[@]}"; do
        printf '%s\t%s\t%s\t%s\n' \
            "${DEFAULT_CABINS[$i]}" \
            "${DEFAULT_CABIN_NAMES[$i]}" \
            "${DEFAULT_CABIN_SLUGS[$i]}" \
            "${DEFAULT_CABIN_SEARCH_TERMS[$i]}"
    done
}

# Initialize session and get CSRF token
initialize_session() {
    log_info "Initializing session..."

    local response_file="$TEMP_DIR/initial_page.html"
    local cookies_file="$TEMP_DIR/cookies.txt"

    # Fetch page and save both HTML and cookies
    if ! curl -s -c "$cookies_file" "$BASE_URL/huts" -o "$response_file"; then
        log_error "Failed to fetch initial page"
        return 1
    fi

    # Extract CSRF token from the saved page
    local csrf_token
    csrf_token=$(grep -o 'csrf-token" content="[^"]*' "$response_file" | head -1 | sed 's/csrf-token" content="//' || echo "")

    if [ -z "$csrf_token" ]; then
        log_error "Failed to extract CSRF token"
        head -20 "$response_file" >&2
        return 1
    fi

    log_info "Session initialized successfully (token: ${csrf_token:0:10}...)"
    echo "$csrf_token"
}

# Determine season (June-October)
get_season_info() {
    local current_month
    current_month=$(date +%-m)
    local current_year
    current_year=$(date +%Y)

    # If after October 1st, use next year
    if [ "$current_month" -gt 10 ]; then
        echo $((current_year + 1))
    else
        echo "$current_year"
    fi
}

# Make availability API request with retry logic
make_api_request() {
    local cabin_id=$1
    local month=$2
    local year=$3
    local csrf_token=$4
    local max_retries=3
    local retry_count=0

    local cookies_file="$TEMP_DIR/cookies.txt"
    local payload="{\"cabinId\":$cabin_id,\"selectedMonth\":{\"monthNumber\":$month,\"year\":$year},\"multipleCalendar\":false}"

    while [ $retry_count -lt $max_retries ]; do
        local response
        response=$(curl -s -X POST \
            -H "Content-Type: application/json" \
            -H "X-CSRF-TOKEN: $csrf_token" \
            -H "X-Requested-With: XMLHttpRequest" \
            -b "$cookies_file" \
            -d "$payload" \
            "$BASE_URL/cabins/get-month-availability")

        # Validate JSON
        if echo "$response" | jq empty 2>/dev/null; then
            echo "$response"
            return 0
        fi

        retry_count=$((retry_count + 1))
        log_warn "Availability request failed (attempt $retry_count/$max_retries), retrying..."
        sleep 1
    done

    log_error "Failed to get availability for cabin $cabin_id, month $month/$year after $max_retries attempts"
    return 1
}

# API-first metadata fetch via /cabins/search
fetch_metadata_api() {
    local cabin_id=$1
    local search_term=$2
    local fallback_name=$3
    local csrf_token=$4

    local cookies_file="$TEMP_DIR/cookies.txt"
    local payload
    payload=$(jq -n --arg q "$search_term" '{searchParam: $q}')

    local response
    response=$(curl -s -X POST \
        -H "Content-Type: application/json" \
        -H "X-CSRF-TOKEN: $csrf_token" \
        -H "X-Requested-With: XMLHttpRequest" \
        -b "$cookies_file" \
        -d "$payload" \
        "$BASE_URL/cabins/search" || true)

    if ! echo "$response" | jq empty >/dev/null 2>&1; then
        log_warn "Metadata API response invalid for cabin $cabin_id"
        echo '{}'
        return 0
    fi

    echo "$response" | jq \
      --argjson id "$cabin_id" \
      --arg fallback_name "$fallback_name" \
      --arg base "$BASE_URL" \
      --arg image_base "$IMAGE_BASE_URL" '
        ((map(select(.id == $id)) | .[0]) // .[0] // {}) as $c
        | if ($c | type) != "object" or ($c | length) == 0 then {}
          else {
            source: "api",
            id: ($c.id // $id),
            name: ($c.name // $fallback_name),
            slug: ($c.slug // null),
            websiteUrl: (
              if ($c.website // "") == "" then null
              elif ($c.website | test("^https?://")) then $c.website
              else ("https://" + $c.website)
              end
            ),
            altitude: ($c.altitude | tonumber? // null),
            latitude: ($c.latitude | tonumber? // null),
            longitude: ($c.longitude | tonumber? // null),
            region: ($c.region.name.de // null),
            country: ($c.country.name.de // null),
            titleImageUrl: (
              if (($c.cabin_title_image | type) == "array") and (($c.cabin_title_image | length) > 0) and ($c.cabin_title_image[0].url != null)
              then ($image_base + $c.cabin_title_image[0].url)
              else null
              end
            ),
            sourceUrl: (if ($c.slug // "") != "" then ($base + "/huts/" + $c.slug) else null end)
          }
          end
      '
}

# Website fallback/augmentation: parse full :cabin JSON from hut detail page
fetch_metadata_website() {
    local slug="$1"
    local fallback_name="$2"

    if [ -z "$slug" ]; then
        echo '{}'
        return 0
    fi

    local detail_url="$BASE_URL/huts/$slug"
    local detail_file="$TEMP_DIR/cabin-${slug}.html"

    if ! curl -sL "$detail_url" -o "$detail_file"; then
        log_warn "Failed to fetch detail page for slug $slug"
        echo '{}'
        return 0
    fi

    node - "$detail_file" "$IMAGE_BASE_URL" "$detail_url" "$fallback_name" <<'NODE'
const fs = require('fs');

const [, , htmlPath, imageBaseUrl, detailUrl, fallbackName] = process.argv;
const html = fs.readFileSync(htmlPath, 'utf8');

const encodedMatches = [];
const cabinAttrRegex = /:cabin="([^"]+)"/g;
for (const match of html.matchAll(cabinAttrRegex)) {
  if (match?.[1]) encodedMatches.push(match[1]);
}

if (encodedMatches.length === 0) {
  process.stdout.write('{}');
  process.exit(0);
}

function decodeEntities(input) {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

let cabin = null;
for (const encoded of encodedMatches) {
  try {
    const candidate = JSON.parse(decodeEntities(encoded));
    if (!cabin) {
      cabin = candidate;
      continue;
    }

    const prevScore = JSON.stringify(cabin).length;
    const nextScore = JSON.stringify(candidate).length;
    if (nextScore > prevScore) {
      cabin = candidate;
    }
  } catch {
    // Ignore parse failures.
  }
}

if (!cabin) {
  process.stdout.write('{}');
  process.exit(0);
}

const images = Array.isArray(cabin.images) ? cabin.images : [];
const rooms = Array.isArray(cabin.rooms) ? cabin.rooms : [];

const titleImage = images.find((img) => Number(img?.image_type_id) === 1 && img?.url);
const galleryImageCount = images.filter((img) => Number(img?.image_type_id) === 3).length;

const sleepingPlacesTotal = rooms.reduce((sum, room) => {
  const places = Number(room?.details?.places);
  return sum + (Number.isFinite(places) ? places : 0);
}, 0);

const websiteRaw = typeof cabin.website === 'string' ? cabin.website.trim() : '';
const websiteUrl = websiteRaw
  ? (websiteRaw.startsWith('http://') || websiteRaw.startsWith('https://')
      ? websiteRaw
      : `https://${websiteRaw}`)
  : null;

const roomSummary = rooms.map((room) => ({
  roomId: room?.room?.id ?? null,
  roomType: room?.room?.slug ?? null,
  roomName: room?.room?.name?.de ?? room?.room?.name?.en ?? null,
  places: Number(room?.details?.places) || 0,
  capacity: Number(room?.room?.capacity) || null
}));

const facilities = (Array.isArray(cabin.facilities) ? cabin.facilities : []).map((f) => ({
  slug: f?.facility?.slug ?? null,
  name: f?.facility?.name?.de ?? f?.facility?.name?.en ?? null
}));

const seasons = (Array.isArray(cabin.seasons) ? cabin.seasons : []).map((s) => ({
  slug: s?.slug ?? null,
  year: s?.year ?? null,
  seasonOpen: s?.season_open ?? null,
  seasonClose: s?.season_close ?? null
}));

const result = {
  source: 'website',
  id: cabin?.id ?? null,
  name: cabin?.name ?? fallbackName,
  slug: cabin?.slug ?? null,
  websiteUrl,
  bookingUrl: detailUrl,
  altitude: Number(cabin?.altitude) || null,
  latitude: Number(cabin?.latitude) || null,
  longitude: Number(cabin?.longitude) || null,
  region: cabin?.region?.name?.de ?? null,
  country: cabin?.country?.name?.de ?? null,
  routes: cabin?.routes ?? null,
  reachableFrom: cabin?.reachable_from ?? null,
  checkinFrom: cabin?.checkin_from ?? null,
  checkinTo: cabin?.checkin_to ?? null,
  cancellationDays: Number(cabin?.cancellation_days) || null,
  depositAmount: Number(cabin?.deposit_amount) || null,
  halfboardAmount: Number(cabin?.halfboard_amount) || null,
  email: cabin?.user?.email ?? null,
  titleImageUrl: titleImage?.url ? `${imageBaseUrl}${titleImage.url}` : null,
  galleryImageCount,
  sleepingPlacesTotal,
  rooms: roomSummary,
  facilities,
  seasons,
  updatedAt: cabin?.updated_at ?? null
};

process.stdout.write(JSON.stringify(result));
NODE
}

collect_cabin_metadata() {
    local cabin_id=$1
    local cabin_name=$2
    local cabin_slug=$3
    local cabin_search_term=$4
    local csrf_token=$5

    local metadata_api='{}'
    metadata_api=$(fetch_metadata_api "$cabin_id" "$cabin_search_term" "$cabin_name" "$csrf_token")

    local resolved_slug
    resolved_slug=$(echo "$metadata_api" | jq -r --arg fallback "$cabin_slug" '.slug // $fallback // empty')
    if [ -z "$resolved_slug" ]; then
        resolved_slug="$cabin_slug"
    fi

    local metadata_web='{}'
    metadata_web=$(fetch_metadata_website "$resolved_slug" "$cabin_name")

    jq -n \
      --argjson api "$metadata_api" \
      --argjson web "$metadata_web" \
      --arg fallback_name "$cabin_name" \
      --arg fallback_slug "$cabin_slug" \
      --arg base "$BASE_URL" '
      {
        sources: [
          (if ($api | type) == "object" and ($api | length) > 0 then "api" else empty end),
          (if ($web | type) == "object" and ($web | length) > 0 then "website" else empty end)
        ],
        id: ($api.id // $web.id // null),
        name: ($api.name // $web.name // $fallback_name),
        slug: ($api.slug // $web.slug // $fallback_slug),
        detailPageUrl: (
          if ($api.sourceUrl // "") != "" then $api.sourceUrl
          elif ($web.bookingUrl // "") != "" then $web.bookingUrl
          elif (($api.slug // $web.slug // $fallback_slug) != "") then ($base + "/huts/" + ($api.slug // $web.slug // $fallback_slug))
          else null end
        ),
        websiteUrl: ($api.websiteUrl // $web.websiteUrl // null),
        bookingUrl: ($web.bookingUrl // null),
        region: ($api.region // $web.region // null),
        country: ($api.country // $web.country // null),
        altitude: ($api.altitude // $web.altitude // null),
        latitude: ($api.latitude // $web.latitude // null),
        longitude: ($api.longitude // $web.longitude // null),
        titleImageUrl: ($api.titleImageUrl // $web.titleImageUrl // null),
        email: ($web.email // null),
        routes: ($web.routes // null),
        reachableFrom: ($web.reachableFrom // null),
        checkinFrom: ($web.checkinFrom // null),
        checkinTo: ($web.checkinTo // null),
        cancellationDays: ($web.cancellationDays // null),
        depositAmount: ($web.depositAmount // null),
        halfboardAmount: ($web.halfboardAmount // null),
        sleepingPlacesTotal: ($web.sleepingPlacesTotal // null),
        galleryImageCount: ($web.galleryImageCount // null),
        rooms: ($web.rooms // []),
        facilities: ($web.facilities // []),
        seasons: ($web.seasons // []),
        updatedAt: ($web.updatedAt // null),
        metadataCollectedAt: (now | todateiso8601)
      }
      '
}

# Process availability data with jq
process_availability() {
    local json_data=$1

    echo "$json_data" | jq '[.[] | {
        date: .date,
        totalPlaces: .totalPlaces,
        bookedPlaces: ([.rooms[].booked_places] | add // 0),
        availablePlaces: (if .totalPlaces == 0 then 0 else ([.rooms[].places] | add // 0) end)
    }]'
}

# Scrape cabin data
scrape_cabin() {
    local cabin_id=$1
    local cabin_name=$2
    local cabin_slug=$3
    local cabin_search_term=$4
    local year=$5
    local csrf_token=$6

    log_info "Scraping $cabin_name (ID: $cabin_id)..."

    local metadata
    metadata=$(collect_cabin_metadata "$cabin_id" "$cabin_name" "$cabin_slug" "$cabin_search_term" "$csrf_token")
    local effective_name
    effective_name=$(echo "$metadata" | jq -r '.name // empty')
    if [ -z "$effective_name" ]; then
      effective_name="$cabin_name"
    fi

    local all_availability="[]"

    # Loop through months (June to October: 6-10)
    for month in {6..10}; do
        log_info "  Fetching month $month/$year..."

        local raw_data
        if ! raw_data=$(make_api_request "$cabin_id" "$month" "$year" "$csrf_token"); then
            log_warn "  Skipping month $month due to request failure"
            continue
        fi

        local processed_data
        if ! processed_data=$(process_availability "$raw_data" 2>/dev/null); then
            log_warn "  Failed to process data for month $month"
            continue
        fi

        # Merge with accumulated data
        if ! all_availability=$(echo "$all_availability" | jq --argjson new "$processed_data" '. + $new' 2>/dev/null); then
            log_warn "  Failed to merge data for month $month"
            continue
        fi

        # Rate limiting
        sleep 0.5
    done

    # Create cabin object
    jq -n \
        --arg id "$cabin_id" \
        --arg name "$effective_name" \
        --argjson metadata "$metadata" \
        --argjson availability "$all_availability" \
        '{
            id: ($id | tonumber),
            name: $name,
            metadata: $metadata,
            availability: $availability
        }'
}

# Generate GitHub Actions summary
generate_summary() {
    local output_file=$1

    if [ -z "${GITHUB_STEP_SUMMARY:-}" ]; then
        return
    fi

    log_info "Generating GitHub Actions summary..."

    {
        echo "# 🏔️ Hüttenholiday Availability Report"
        echo ""
        echo "**Scraped at:** $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
        echo ""

        # Process each cabin
        local cabin_count
        cabin_count=$(jq '.cabins | length' "$output_file")

        for ((i=0; i<cabin_count; i++)); do
            local cabin_name
            cabin_name=$(jq -r ".cabins[$i].name" "$output_file")

            echo "## $cabin_name"
            echo ""
            echo "| Date | Total Places | Booked | Available | Status |"
            echo "|------|--------------|--------|-----------|--------|"

            jq -r ".cabins[$i].availability[] |
                \"| \(.date) | \(.totalPlaces) | \(.bookedPlaces) | \(.availablePlaces) | \(
                    if .totalPlaces == 0 then \"🔒 Closed\"
                    elif .availablePlaces == 0 then \"❌ Full\"
                    elif .availablePlaces <= 5 then \"⚠️ Low\"
                    else \"✅ Available\"
                    end
                ) |\"" "$output_file"

            echo ""

            # Statistics
            local total_days open_days available_spots
            total_days=$(jq ".cabins[$i].availability | length" "$output_file")
            open_days=$(jq "[.cabins[$i].availability[] | select(.totalPlaces > 0)] | length" "$output_file")
            available_spots=$(jq "[.cabins[$i].availability[] | .availablePlaces] | add" "$output_file")

            echo "**Statistics:**"
            echo "- Total days: $total_days"
            echo "- Open days: $open_days"
            echo "- Total available spots: $available_spots"
            echo ""
        done
    } >> "$GITHUB_STEP_SUMMARY"
}

# Main function
main() {
    echo "=========================================="
    echo "Checking Hüttenholiday Availability"
    echo "=========================================="
    echo "Current Date: $(date +%Y-%m-%d)"
    echo "=========================================="
    echo ""

    log_info "Starting Hüttenholiday scraper..."

    # Initialize session
    local csrf_token
    if ! csrf_token=$(initialize_session); then
        log_error "Session initialization failed"
        exit 1
    fi

    # Get season year
    local year
    year=$(get_season_info)
    log_info "Scraping season: $year"

    # Load cabin rows from live-target file or fallback defaults.
    # Avoid `mapfile` for Bash 3 compatibility on macOS.
    CABIN_ROWS=()
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        CABIN_ROWS+=("$line")
    done < <(load_cabin_rows)
    if [ "${#CABIN_ROWS[@]}" -eq 0 ]; then
        log_error "No cabins configured for scraping."
        exit 1
    fi
    log_info "Cabins configured: ${#CABIN_ROWS[@]} (source: $CABIN_LIST_FILE or defaults)"

    # Scrape all cabins
    local cabins_json="[]"
    for row in "${CABIN_ROWS[@]}"; do
        IFS=$'\t' read -r cabin_id cabin_name cabin_slug cabin_search_term <<< "$row"

        local cabin_data
        local cabin_file="$TEMP_DIR/cabin_${cabin_id}.json"

        scrape_cabin "$cabin_id" "$cabin_name" "$cabin_slug" "$cabin_search_term" "$year" "$csrf_token" > "$cabin_file" || {
            log_error "Failed to scrape $cabin_name"
            continue
        }

        cabin_data=$(cat "$cabin_file")

        # Validate cabin data before adding
        if echo "$cabin_data" | jq empty 2>/dev/null; then
            cabins_json=$(echo "$cabins_json" | jq --argjson cabin "$cabin_data" '. + [$cabin]')
            log_info "Successfully added $cabin_name to results"
        else
            log_error "Invalid data format for $cabin_name"
            log_error "Data preview: $(echo "$cabin_data" | head -c 200)"
        fi
    done

    # Generate final JSON
    local timestamp
    timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    local output_file="$OUTPUT_DIR/availability-$(date -u '+%Y-%m-%d').json"

    # Pipe cabins_json via stdin to avoid "Argument list too long" for large hut sets
    echo "$cabins_json" | jq -n \
        --arg scraped_at "$timestamp" \
        '{
            scrapedAt: $scraped_at,
            cabins: input
        }' > "$output_file"

    log_info "Results saved to: $output_file"

    # Validate output
    if jq -e '.scrapedAt and .cabins[0].id and .cabins[0].metadata' "$output_file" > /dev/null; then
        log_info "JSON validation successful"
    else
        log_error "JSON validation failed"
        exit 1
    fi

    # Generate summary for GitHub Actions
    generate_summary "$output_file"

    log_info "Scraping completed successfully!"

    # Summary output
    echo ""
    echo "=========================================="
    echo -e "${GREEN}✓ Scraping completed successfully${NC}"
    echo "=========================================="
    echo "Output: $output_file"
    echo "Cabins scraped: ${#CABIN_ROWS[@]}"
    echo "Total days: $(jq '[.cabins[].availability | length] | add' "$output_file")"
    echo "=========================================="
}

# Run main function
main "$@"
