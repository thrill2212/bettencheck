#!/bin/bash

set -e

# Configuration
API_URL="https://www.hut-reservation.org/api/v1/reservation/getHutAvailability"
HUT_IDS=(366 476)
HUT_NAMES=("Braunschweiger-Huette" "Martin-Busch-Huette")
OUTPUT_DIR="availability-results"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Create output directory
mkdir -p "$OUTPUT_DIR"

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
echo "=========================================="
echo ""

# Initialize summary for GitHub Actions
summary_file="${GITHUB_STEP_SUMMARY:-summary.md}"
echo "# Hut Availability Check Results" > "$summary_file"
echo "" >> "$summary_file"
echo "**Checked at:** $(date -u +"%Y-%m-%dT%H:%M:%SZ")" >> "$summary_file"
echo "**Season:** $season_start to $season_end" >> "$summary_file"
echo "" >> "$summary_file"
echo "| Hut Name | Hut ID | Total Days | Available Days | Closed Days |" >> "$summary_file"
echo "|----------|--------|------------|----------------|-------------|" >> "$summary_file"

# Process each hut
for i in "${!HUT_IDS[@]}"; do
    hut_id="${HUT_IDS[$i]}"
    hut_name="${HUT_NAMES[$i]}"

    echo -e "${BLUE}Processing: $hut_name (ID: $hut_id)${NC}"

    # Make API request (GET with query parameters)
    response=$(curl -s -X GET "${API_URL}?hutId=${hut_id}&step=WIZARD" \
        -H "Accept: application/json" \
        -H "Content-Type: application/json")

    # Check if response is valid
    if [ -z "$response" ]; then
        echo -e "${YELLOW}Warning: Empty response for $hut_name${NC}"
        continue
    fi

    # Parse response and filter by season
    # Use filesystem-safe timestamp format (no colons for GitHub artifacts)
    timestamp=$(date -u +"%Y-%m-%dT%H%M%SZ")
    timestamp_display=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    output_file="${OUTPUT_DIR}/availability-${hut_name}-${hut_id}-${timestamp}.json"

    # Filter days within season and categorize
    # Convert date format from ISO to YYYY-MM-DD for comparison
    filtered_data=$(echo "$response" | jq --arg start "$season_start" --arg end "$season_end" --arg hutid "$hut_id" --arg hutname "$hut_name" '
        {
            hutId: ($hutid | tonumber),
            hutName: $hutname,
            checkedAt: "'$timestamp_display'",
            season: {
                start: $start,
                end: $end
            },
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

    # Print summary
    echo -e "  Total days in season: ${total_days}"
    echo -e "  ${GREEN}Available days: ${available_count}${NC}"
    echo -e "  ${YELLOW}Closed days: ${closed_count}${NC}"
    echo -e "  Saved to: ${output_file}"
    echo ""

    # Add to GitHub Actions summary
    echo "| $hut_name | $hut_id | $total_days | $available_count | $closed_count |" >> "$summary_file"

    # Show some available dates as examples
    if [ "$available_count" -gt 0 ]; then
        echo "  Sample available dates:"
        echo "$filtered_data" | jq -r '.availableDays[:5] | .[] | "    - \(.dateFormatted) (Status: \(.hutStatus), \(.percentage))"'
        echo ""
    fi
done

echo "=========================================="
echo -e "${GREEN}Check completed!${NC}"
echo "Results saved in: $OUTPUT_DIR/"
echo "=========================================="

# Add artifacts info to summary
echo "" >> "$summary_file"
echo "## Output Files" >> "$summary_file"
echo "" >> "$summary_file"
echo "JSON files with detailed availability data have been saved as artifacts." >> "$summary_file"
echo "Each file contains:" >> "$summary_file"
echo "- All days in the season with their status" >> "$summary_file"
echo "- Categorized lists of available and closed days" >> "$summary_file"
echo "- Timestamps and metadata" >> "$summary_file"
