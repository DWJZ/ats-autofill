#!/usr/bin/env bash
# mail_list_unread_all.sh - print every unread message (sender + subject + date), then the count.
#
# WHY: mail_app_list_unread.applescript takes ONE index (0 = count only), so seeing the inbox meant running it once per
# message and losing track of which index was which. This wraps that in a loop so one call shows everything.
#
# Usage: bash src/tools/mail_list_unread_all.sh [max]
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
MAX="${1:-25}"

COUNT=$(osascript src/tools/mail_app_list_unread.applescript 0 2>/dev/null | grep -oE '[0-9]+' | tail -1)
COUNT="${COUNT:-0}"
echo "UNREAD: $COUNT"
if [ "$COUNT" -eq 0 ]; then exit 0; fi

LIMIT=$(( COUNT < MAX ? COUNT : MAX ))
for i in $(seq 1 "$LIMIT"); do
  osascript src/tools/mail_app_list_unread.applescript "$i" 2>/dev/null | grep -vi TISFile | sed "s/^/[$i] /"
done
if [ "$COUNT" -gt "$LIMIT" ]; then echo "... and $(( COUNT - LIMIT )) more (raise max to see them)"; fi
