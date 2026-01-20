#!/bin/bash

set -e

# Change to script directory to ensure relative paths work correctly
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Configuration
CABINS=(27 24)
CABIN_NAMES=("Hütte 27" "Hütte 24")
OUTPUT_DIR="availability-results"
BASE_URL="https://www.huetten-holiday.com"
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
        cat "$response_file" | head -20 >&2
        return 1
    fi

    log_info "Session initialized successfully (token: ${csrf_token:0:10}...)"
    echo "$csrf_token"
}

# Determine season (June-October)
get_season_info() {
    local current_month=$(date +%-m)
    local current_year=$(date +%Y)

    # If after October 1st, use next year
    if [ "$current_month" -gt 10 ]; then
        echo $((current_year + 1))
    else
        echo "$current_year"
    fi
}

# Make API request with retry logic
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
        log_warn "Request failed (attempt $retry_count/$max_retries), retrying..."
        sleep 1
    done

    log_error "Failed to get data for cabin $cabin_id, month $month/$year after $max_retries attempts"
    return 1
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
    local year=$3
    local csrf_token=$4

    log_info "Scraping $cabin_name (ID: $cabin_id)..."

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
        --arg name "$cabin_name" \
        --argjson availability "$all_availability" \
        '{
            id: ($id | tonumber),
            name: $name,
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

    # Scrape all cabins
    local cabins_json="[]"
    for i in "${!CABINS[@]}"; do
        local cabin_id="${CABINS[$i]}"
        local cabin_name="${CABIN_NAMES[$i]}"

        local cabin_data
        local cabin_file="$TEMP_DIR/cabin_${cabin_id}.json"

        # Note: Don't redirect stderr to stdout here, as logging goes to stderr
        scrape_cabin "$cabin_id" "$cabin_name" "$year" "$csrf_token" > "$cabin_file" || {
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

    jq -n \
        --arg scraped_at "$timestamp" \
        --argjson cabins "$cabins_json" \
        '{
            scrapedAt: $scraped_at,
            cabins: $cabins
        }' > "$output_file"

    log_info "Results saved to: $output_file"

    # Validate output
    if jq -e '.scrapedAt and .cabins[0].id' "$output_file" > /dev/null; then
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
    echo "Cabins scraped: ${#CABINS[@]}"
    echo "Total days: $(jq '[.cabins[].availability | length] | add' "$output_file")"
    echo "=========================================="
}

# Run main function
main "$@"
