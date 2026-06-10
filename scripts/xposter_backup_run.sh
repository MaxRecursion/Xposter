#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
DEST="${XPOSTER_BACKUP_DIR:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/Xposter-Backups}"
SRC="${XPOSTER_DB_PATH:-$REPO_ROOT/data/xposter.db}"
RESULT_FILE="$REPO_ROOT/.xposter_backup_result.txt"

if [ ! -f "$SRC" ]; then
  echo "Database not found: $SRC" >&2
  exit 1
fi

mkdir -p "$DEST"
TS=$(date +%Y-%m-%d_%H-%M)
NEW="xposter_${TS}.db"
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required for a consistent WAL-mode backup" >&2
  exit 1
fi
sqlite3 "$SRC" ".backup '$DEST/$NEW'"

# Keep the 30 most recent backups.
ls -t "$DEST"/xposter_*.db |
  tail -n +31 |
  while IFS= read -r old_backup; do
    rm -f -- "$old_backup"
  done

SIZE=$(ls -lh "$DEST/$NEW" | awk '{print $5}')
COUNT=$(find "$DEST" -maxdepth 1 -name 'xposter_*.db' | wc -l | tr -d ' ')
RESULT="NEW=$NEW SIZE=$SIZE TOTAL=$COUNT"
echo "$RESULT"
echo "$RESULT" > "$RESULT_FILE"
