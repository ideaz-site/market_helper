#!/bin/sh
# Builds the Chrome Web Store zip from HEAD: runtime files only, and without the
# nativeMessaging permission, which only the git-pull helper for unpacked
# installs uses.
#
#   store/build-zip.sh <output.zip>
set -eu

OUT=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
cd "$(dirname "$0")/.."
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

git archive HEAD manifest.json background.js panel.html panel.css panel.js catalog.js picker.js icons | tar -x -C "$WORK"
python3 - "$WORK/manifest.json" <<'PY'
import json, sys
path = sys.argv[1]
manifest = json.load(open(path))
manifest['permissions'].remove('nativeMessaging')
with open(path, 'w') as out:
    json.dump(manifest, out, indent=2)
    out.write('\n')
PY
rm -f "$OUT"
(cd "$WORK" && zip -qr "$OUT" .)
