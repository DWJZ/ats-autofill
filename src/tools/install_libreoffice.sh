#!/bin/bash
# install_libreoffice.sh - keep a project-local LibreOffice used for DOCX -> PDF rendering.
#
# Homebrew cannot install on this machine (its prefix is not writable by the user without
# sudo), so this script extracts the official macOS build from the .dmg into
# .cache/libreoffice/ instead. No admin rights are needed.
#
# Usage:  bash src/tools/install_libreoffice.sh [version]
#         (default version: 26.8.0)
#
# Result: .cache/libreoffice/LibreOffice.app/Contents/MacOS/soffice
#         src/pipeline/render_docx.py finds it automatically.
set -euo pipefail

VERSION="${1:-26.8.0}"
ARCH="$(uname -m)"          # arm64 -> aarch64 in the LibreOffice file names
case "$ARCH" in
  arm64) LO_ARCH="aarch64" ;;
  x86_64) LO_ARCH="x86-64" ;;
  *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CACHE="$ROOT/.cache"
DMG="$CACHE/LibreOffice_${VERSION}_MacOS_${LO_ARCH}.dmg"
MOUNT="$CACHE/lo-mnt"
TARGET="$CACHE/libreoffice"
URL="https://download.documentfoundation.org/libreoffice/stable/${VERSION}/mac/${LO_ARCH}/LibreOffice_${VERSION}_MacOS_${LO_ARCH}.dmg"

mkdir -p "$CACHE"
if [[ ! -f "$DMG" ]]; then
  echo "downloading $URL"
  curl -L --fail --progress-bar -o "$DMG" "$URL"
fi

echo "mounting $DMG"
rm -rf "$MOUNT"
hdiutil attach -nobrowse -quiet -mountpoint "$MOUNT" "$DMG"

cleanup() {
  hdiutil detach -quiet "$MOUNT" || true
}
trap cleanup EXIT

echo "installing LibreOffice.app into $TARGET"
mkdir -p "$TARGET"
rm -rf "$TARGET/LibreOffice.app"
cp -R "$MOUNT/LibreOffice.app" "$TARGET/"

cleanup
trap - EXIT

"$TARGET/LibreOffice.app/Contents/MacOS/soffice" --version
echo "done: $TARGET/LibreOffice.app/Contents/MacOS/soffice"
