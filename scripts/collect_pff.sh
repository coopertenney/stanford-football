#!/usr/bin/env bash
# Move PFF WAR/WAA exports out of ~/Downloads into pff_data/, named by the season
# found INSIDE the file.
#
# Every export downloads as the same filename, so consecutive pulls collide in
# ~/Downloads. Renaming by the file's own `season` column is the only reliable
# way to tell them apart — the filename carries no season information.
set -euo pipefail

DEST="$(cd "$(dirname "$0")/.." && pwd)/pff_data"
mkdir -p "$DEST"

shopt -s nullglob
found=0
for f in "$HOME/Downloads"/wins_above_replacement*.csv; do
  # Season is column 1; read it from the first data row.
  season=$(sed -n '2p' "$f" | cut -d, -f1)
  if ! [[ "$season" =~ ^[0-9]{4}$ ]]; then
    echo "SKIP $(basename "$f") — no 4-digit season in first data row (got '$season')"
    continue
  fi
  target="$DEST/waa_${season}.csv"
  if [ -e "$target" ]; then
    echo "SKIP $(basename "$f") — waa_${season}.csv already present"
    continue
  fi
  mv "$f" "$target"
  echo "MOVED season $season -> pff_data/waa_${season}.csv ($(du -h "$target" | cut -f1))"
  found=$((found+1))
done

echo "---"
echo "collected $found new file(s); pff_data now has:"
ls -1 "$DEST" | sed 's/^/  /'
