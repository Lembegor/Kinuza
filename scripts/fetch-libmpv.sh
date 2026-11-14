#!/usr/bin/env bash
# Puts the pinned LGPL libmpv build (media-kit/libmpv-darwin-build) into src-tauri/resources/bin/libmpv.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
lock="$root/src-tauri/libmpv.lock.json"
target="$root/src-tauri/resources/bin/libmpv"
field() { /usr/bin/plutil -extract "$1" raw -o - "$lock"; }

tag="$(field tag)"
libs="$(field libs)"
headers="$(field headers)"
if [[ -f "$target/lib/libmpv.dylib" && "$(cat "$target/version.txt" 2>/dev/null)" == "$libs" ]]; then
  echo "libmpv $tag is already in place"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
base="https://github.com/media-kit/libmpv-darwin-build/releases/download/$tag"
echo "Downloading libmpv $tag"
curl -fsSL --retry 3 -o "$work/libs.tar.gz" "$base/$libs"
curl -fsSL --retry 3 -o "$work/headers.zip" "$base/$headers"
echo "$(field libsSha256)  $work/libs.tar.gz" | shasum -a 256 -c - >/dev/null
echo "$(field headersSha256)  $work/headers.zip" | shasum -a 256 -c - >/dev/null

mkdir -p "$work/libs" "$work/headers"
tar -xzf "$work/libs.tar.gz" -C "$work/libs"
unzip -q "$work/headers.zip" -d "$work/headers"

rm -rf "$target"
mkdir -p "$target/lib" "$target/include/mpv"
find "$work/libs" -name '*.dylib' -exec cp {} "$target/lib/" \;
find "$work/headers" -path '*macos*' -path '*Headers*' \( -name client.h -o -name render.h -o -name render_gl.h \) -exec cp {} "$target/include/mpv/" \;
[[ -f "$target/lib/libmpv.dylib" && -f "$target/include/mpv/render_gl.h" ]] || { echo "The libmpv archives did not have the expected files." >&2; exit 1; }

printf '%s' "$libs" > "$target/version.txt"
echo "libmpv $tag is ready in src-tauri/resources/bin/libmpv"
