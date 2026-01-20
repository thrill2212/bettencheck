#!/bin/bash

set -e

# Change to script directory to ensure relative paths work correctly
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ============================================================================
# CONFIGURATION
# ============================================================================

# API Configuration
RESORT_ID="${RESORT_ID:-A_6511_SKIHU}"
COMPANY="${COMPANY:-c_COMP1}"
API_URL="https://frontend.casablanca.at/de/api/${RESORT_ID}/${COMPANY}/IBE/GetBookability"

# Scraping Configuration
MAX_BEDS=10
MIN_BEDS=1
REQUEST_DELAY=0.5  # seconds between requests
MAX_RETRIES=3
TIMEOUT=30

# Test mode
TEST_MODE="${TEST_MODE:-false}"
TEST_DAYS=7

# Output
OUTPUT_DIR="availability-results"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1" >&2
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1" >&2
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1" >&2
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

# ============================================================================
# PAYLOAD BUILDER
# ============================================================================

build_payload() {
    local date=$1
    local bed_count=$2
    local payload="StartDate=${date}"

    for ((i=0; i<bed_count; i++)); do
        payload+="&Rooms[$i][Index]=$((i+1))"
        payload+="&Rooms[$i][Adults]=1"
        payload+="&Rooms[$i][Children]=0"
    done

    payload+="&SelectedRoomtypeId=&AllCompanies=false"
    echo "$payload"
}

# ============================================================================
# API CLIENT
# ============================================================================

check_availability_api() {
    local date=$1
    local bed_count=$2
    local retry_count=0
    local response=""

    while [ $retry_count -lt $MAX_RETRIES ]; do
        local payload=$(build_payload "$date" "$bed_count")

        response=$(curl -s -X POST "$API_URL" \
            -H "Content-Type: application/x-www-form-urlencoded" \
            -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" \
            -d "$payload" \
            --max-time $TIMEOUT \
            -w "\n%{http_code}" 2>/dev/null || echo -e "\n000")

        # Extract HTTP status code (last line)
        local http_code=$(echo "$response" | tail -n 1)
        local response_body=$(echo "$response" | sed '$d')

        # Check if request was successful
        if [ "$http_code" = "200" ] && [ -n "$response_body" ]; then
            echo "$response_body"
            return 0
        fi

        retry_count=$((retry_count + 1))
        if [ $retry_count -lt $MAX_RETRIES ]; then
            log_warn "Request failed (HTTP $http_code), retrying ($retry_count/$MAX_RETRIES)..."
            sleep $((retry_count * 2))  # Exponential backoff
        fi
    done

    log_error "Failed after $MAX_RETRIES retries"
    return 1
}

# ============================================================================
# AVAILABILITY CHECKER
# ============================================================================

is_available() {
    local date=$1
    local bed_count=$2

    local response=$(check_availability_api "$date" "$bed_count")

    if [ -z "$response" ]; then
        return 1
    fi

    # Parse JSON and check "Bookable" and "Available"
    local bookable=$(echo "$response" | jq -r ".[] | select(.EffectiveDateString == \"$date\") | .Bookable // false")
    local available=$(echo "$response" | jq -r ".[] | select(.EffectiveDateString == \"$date\") | .Available // false")

    [ "$bookable" == "true" ] && [ "$available" == "true" ]
}

# ============================================================================
# BINARY SEARCH ALGORITHM
# ============================================================================

binary_search_beds() {
    local date=$1
    local min=$MIN_BEDS
    local max=$((MAX_BEDS - 1))
    local available_beds=0

    log_info "  Binary search for exact bed count..."

    while [ $min -le $max ]; do
        local mid=$(( (min + max) / 2 ))

        if is_available "$date" "$mid"; then
            available_beds=$mid
            min=$((mid + 1))
        else
            max=$((mid - 1))
        fi

        sleep $REQUEST_DELAY  # Rate limiting
    done

    echo $available_beds
}

check_date_availability() {
    local date=$1

    log_info "Checking $date..."

    # Step 1: Check maximum beds first
    if is_available "$date" "$MAX_BEDS"; then
        log_success "  ${MAX_BEDS}+ beds available"
        echo "{\"date\":\"$date\",\"availableBeds\":$MAX_BEDS,\"isAvailable\":true,\"checkedAt\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}"
        return 0
    fi

    sleep $REQUEST_DELAY  # Rate limiting

    # Step 2: Binary search for exact bed count
    local available_beds=$(binary_search_beds "$date")

    if [ $available_beds -gt 0 ]; then
        log_success "  $available_beds beds available"
        echo "{\"date\":\"$date\",\"availableBeds\":$available_beds,\"isAvailable\":true,\"checkedAt\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}"
    else
        log_info "  No beds available"
        echo "{\"date\":\"$date\",\"availableBeds\":0,\"isAvailable\":false,\"checkedAt\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}"
    fi
}

# ============================================================================
# DATE RANGE GENERATOR
# ============================================================================

generate_date_range() {
    local current_year=$(date +%Y)
    local current_month=$(date +%m)
    local current_day=$(date +%d)

    # If past October 1st, check next year's season
    if [ "$current_month" -gt 10 ] || ([ "$current_month" -eq 10 ] && [ "$current_day" -gt 1 ]); then
        season_year=$((current_year + 1))
    else
        season_year=$current_year
    fi

    local start_date="${season_year}-06-01"
    local end_date="${season_year}-10-01"

    echo "$start_date"
    echo "$end_date"
}

generate_test_dates() {
    local current_date=$(date +%Y-%m-%d)
    for ((i=0; i<TEST_DAYS; i++)); do
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS
            date -j -v+${i}d -f "%Y-%m-%d" "$current_date" +%Y-%m-%d
        else
            # Linux
            date -d "$current_date + $i days" +%Y-%m-%d
        fi
    done
}

generate_dates_in_range() {
    local start_date=$1
    local end_date=$2

    local current="$start_date"

    while [[ "$current" < "$end_date" ]]; do
        echo "$current"

        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS
            current=$(date -j -v+1d -f "%Y-%m-%d" "$current" +%Y-%m-%d 2>/dev/null || break)
        else
            # Linux
            current=$(date -d "$current + 1 day" +%Y-%m-%d 2>/dev/null || break)
        fi
    done
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================

main() {
    echo "=========================================="
    echo "Casablanca Availability Checker"
    echo "=========================================="
    echo "Resort ID: $RESORT_ID"
    echo "Company: $COMPANY"
    echo "Test Mode: $TEST_MODE"
    echo "=========================================="
    echo ""

    # Create output directory
    mkdir -p "$OUTPUT_DIR"

    # Generate dates
    local dates=()
    if [ "$TEST_MODE" = "true" ]; then
        log_info "Running in TEST MODE - checking $TEST_DAYS days"
        while IFS= read -r date; do
            dates+=("$date")
        done < <(generate_test_dates)
        season_start=$(date +%Y-%m-%d)
        season_end=$(date -d "$season_start + $TEST_DAYS days" +%Y-%m-%d 2>/dev/null || date -j -v+${TEST_DAYS}d -f "%Y-%m-%d" "$season_start" +%Y-%m-%d)
    else
        read -r season_start season_end < <(generate_date_range)
        log_info "Checking season: $season_start to $season_end"
        while IFS= read -r date; do
            dates+=("$date")
        done < <(generate_dates_in_range "$season_start" "$season_end")
    fi

    local total_dates=${#dates[@]}
    log_info "Total dates to check: $total_dates"
    echo ""

    # Initialize results
    local results=()
    local available_count=0
    local unavailable_count=0
    local total_beds=0
    local failed_count=0

    # Process each date
    local count=0
    for date in "${dates[@]}"; do
        count=$((count + 1))
        echo "[$count/$total_dates] Processing date: $date"

        result=$(check_date_availability "$date" || echo "{\"date\":\"$date\",\"error\":\"Failed to check\",\"isAvailable\":false}")
        results+=("$result")

        # Update statistics
        if echo "$result" | jq -e '.error' >/dev/null 2>&1; then
            failed_count=$((failed_count + 1))
        elif echo "$result" | jq -e '.isAvailable == true' >/dev/null 2>&1; then
            available_count=$((available_count + 1))
            local beds=$(echo "$result" | jq -r '.availableBeds')
            total_beds=$((total_beds + beds))
        else
            unavailable_count=$((unavailable_count + 1))
        fi

        echo ""
    done

    # Save results to JSON file
    local timestamp=$(date -u +"%Y-%m-%dT%H%M%SZ")
    local output_file="${OUTPUT_DIR}/results-${timestamp}.json"

    printf '%s\n' "${results[@]}" | jq -s '.' > "$output_file"

    # Create summary
    echo "=========================================="
    log_success "Check completed!"
    echo "=========================================="
    echo "Total dates checked: $total_dates"
    echo -e "${GREEN}Available days: $available_count${NC}"
    echo -e "${YELLOW}Unavailable days: $unavailable_count${NC}"
    [ $failed_count -gt 0 ] && echo -e "${RED}Failed checks: $failed_count${NC}"
    echo "Total beds available: $total_beds"
    echo "Results saved to: $output_file"
    echo "=========================================="

    # Generate GitHub Actions summary
    local summary_file="${GITHUB_STEP_SUMMARY:-summary.md}"
    {
        echo "# Casablanca Availability Check Results"
        echo ""
        echo "**Resort:** $RESORT_ID ($COMPANY)"
        echo "**Season:** $season_start to $season_end"
        echo "**Checked at:** $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
        echo ""
        echo "| Total Days | Available Days | Unavailable Days | Failed Checks | Total Beds Available |"
        echo "|------------|----------------|------------------|---------------|---------------------|"
        echo "| $total_dates | $available_count | $unavailable_count | $failed_count | $total_beds |"
        echo ""

        if [ $available_count -gt 0 ]; then
            echo "## Sample Available Dates"
            echo ""
            printf '%s\n' "${results[@]}" | jq -r '.[] | select(.isAvailable == true) | "- **\(.date)**: \(.availableBeds) beds"' | head -10
            echo ""
        fi

        echo "## Output Files"
        echo ""
        echo "Results have been saved to \`$output_file\`"
        echo ""
        echo "Each entry contains:"
        echo "- \`date\`: The date checked"
        echo "- \`availableBeds\`: Number of beds available (0-10+)"
        echo "- \`isAvailable\`: Boolean availability status"
        echo "- \`checkedAt\`: Timestamp of the check"
    } > "$summary_file"

    log_success "Summary generated!"
}

# Run main function
main
