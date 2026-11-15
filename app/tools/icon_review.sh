#!/bin/zsh
# Renders Roomie/AppIcon.icon the way iOS shows it, with Icon Composer's ictool, into one contact sheet:
#   Default, Dark, TintedDark, ClearLight at 360 px (twice the home screen's 60 pt @3x), then Default at 58 and 40 px
#   (Settings and Spotlight, the smallest places it shows up).
# Usage: tools/icon_review.sh [out.png]     (default /tmp/Roomie-icon.png)
set -euo pipefail
here=${0:A:h}
app=${here:h}
out=${1:-/tmp/Roomie-icon.png}
ictool="$(xcode-select -p)/../Applications/Icon Composer.app/Contents/Executables/ictool"
[[ -x "$ictool" ]] || { echo "ictool not found. Install Xcode 26 or later."; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
render() { # rendition px file
  "$ictool" "$app/Roomie/AppIcon.icon" --export-image --output-file "$work/$3" \
    --platform iOS --rendition "$1" --width "$2" --height "$2" --scale 1 >/dev/null
}
render Default 360 1.png
render Dark 360 2.png
render TintedDark 360 3.png
render ClearLight 360 4.png
render Default 58 5.png
render Default 40 6.png
swift "$here/icon_sheet.swift" "$out" "$work"/{1,2,3,4,5,6}.png
echo "wrote $out"
