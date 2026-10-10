#!/bin/sh
# Installs the helper that lets Market Helper's Update button run `git pull`.
# Run once per computer, from a git clone loaded with "Load unpacked":
#
#   native/install.sh [extension-id]
#
# The id is worked out from this folder's path, which is how Chrome assigns ids
# to unpacked extensions. Pass it explicitly if the Update button says it differs.
set -eu

NAME=site.ideaz.market_helper
REPO=$(cd "$(dirname "$0")/.." && pwd -P)
HOST="$REPO/native/host.py"

ID=${1:-$(printf %s "$REPO" | shasum -a 256 | cut -c1-32 | tr 0-9a-f a-p)}

case "$(uname)" in
  Darwin) BASE="$HOME/Library/Application Support" DIRS="Google/Chrome Chromium" ;;
  *) BASE="${XDG_CONFIG_HOME:-$HOME/.config}" DIRS="google-chrome chromium" ;;
esac

chmod +x "$HOST"
for DIR in $DIRS; do
  [ -d "$BASE/$DIR" ] || continue
  mkdir -p "$BASE/$DIR/NativeMessagingHosts"
  cat > "$BASE/$DIR/NativeMessagingHosts/$NAME.json" <<JSON
{
  "name": "$NAME",
  "description": "Runs git pull for the Market Helper extension",
  "path": "$HOST",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$ID/"]
}
JSON
  echo "Installed for extension $ID: $BASE/$DIR/NativeMessagingHosts/$NAME.json"
done
