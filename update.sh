#!/usr/bin/env bash
# Syncs this extracted copy into your real extension install folder, so
# updating just means: extract the new zip, run this script, click Reload
# in about:debugging. No manual file copying, and stale/removed files get
# cleaned up automatically (this is what "mdf.css" was, back when it hung
# around unused for several versions after being replaced).
#
# Usage:
#   ./update.sh                  # syncs to the default location below
#   ./update.sh /custom/path     # syncs to a custom location instead

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_TARGET="$HOME/Downloads/wt-mfd"
TARGET="${1:-$DEFAULT_TARGET}"

echo "Patching extension at: $TARGET"
mkdir -p "$TARGET"

if command -v rsync >/dev/null 2>&1; then
    rsync -av --delete --exclude 'update.sh' --exclude '*.zip' "$SCRIPT_DIR"/ "$TARGET"/
else
    echo "(rsync not found - falling back to cp. Stale files that were"
    echo " removed in this version won't be cleaned up automatically;"
    echo " consider installing rsync for a cleaner sync.)"
    cp -rf "$SCRIPT_DIR"/. "$TARGET"/
    rm -f "$TARGET/update.sh"
fi

echo ""
echo "Done. Now go to about:debugging#/runtime/this-firefox in Firefox"
echo "and click Reload on the extension."
