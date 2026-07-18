#!/bin/bash
OUTPUT_FILE="$HOME/Library/Application Support/Claude/local-agent-mode-sessions/ecd1c5fb-9ac7-47e7-bea4-1cd69ff17d19/aec1fc9d-6e30-426b-b44d-b902ad44ebc6/local_e394bbe2-5d07-4c86-837a-c77409485311/outputs/xposter_restart_result.txt"

{
  echo "=== Stopping com.akshay.xposter ==="
  launchctl stop com.akshay.xposter 2>&1
  echo "Stop exit code: $?"

  echo ""
  echo "=== Waiting 4 seconds ==="
  sleep 4

  echo ""
  echo "=== Starting com.akshay.xposter ==="
  launchctl start com.akshay.xposter 2>&1
  echo "Start exit code: $?"

  echo ""
  echo "=== launchctl list | grep xposter ==="
  launchctl list | grep com.akshay.xposter 2>&1

  echo ""
  echo "=== Done ==="
} | tee "$OUTPUT_FILE"

echo ""
echo "Results saved to: $OUTPUT_FILE"
