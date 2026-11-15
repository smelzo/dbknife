#!/usr/bin/env bash
# Turns the frames recorded by a demo script (e2e/recorder.mjs) into the videos of the site:
#   e2e/demo-video.sh <frames dir> [width]
# writes <frames dir>.mp4 (H.264, for every browser), <frames dir>.webm (VP9, smaller) and
# <frames dir>.jpg (the last frame: poster, and the image shown with reduced motion); with
# <frames dir>.png (recorder.still) also <frames dir>-screenshot.png.
# The capture holds the page only: the macOS window buttons (trafficLightPosition in
# src/main/index.ts) are drawn on top, at the 2x scale of the frames.
set -euo pipefail
dir=${1:?frames dir}
width=${2:-1920}
[ -f "$dir/frames.txt" ] || { echo "no $dir/frames.txt" >&2; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# close, minimize, zoom: 24 px circles centered at x 38/78/118, y 36 (12 px at 19/39/59, 18 in points)
lights=$tmp/lights.png
magick -size 140x72 xc:none -strokewidth 2 \
  -fill '#ff5f57' -stroke '#e0443e' -draw 'circle 38,36 49,36' \
  -fill '#febc2e' -stroke '#dea123' -draw 'circle 78,36 89,36' \
  -fill '#28c840' -stroke '#1aab29' -draw 'circle 118,36 129,36' "$lights"

graph="[0:v][1:v]overlay=0:0,fps=30,scale=$width:-2:flags=lanczos"
ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "$dir/frames.txt" -i "$lights" -filter_complex "$graph" \
  -c:v libx264 -preset slow -crf 24 -tune animation -pix_fmt yuv420p -movflags +faststart -an "$dir.mp4"
ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "$dir/frames.txt" -i "$lights" -filter_complex "$graph" \
  -c:v libvpx-vp9 -crf 36 -b:v 0 -row-mt 1 -pix_fmt yuv420p -an "$dir.webm"
last=$(ls "$dir"/f*.jpg | tail -1)
magick "$last" "$lights" -composite -resize "$width"x -quality 85 "$dir.jpg"
outputs=("$dir.mp4" "$dir.webm" "$dir.jpg")
if [ -f "$dir.png" ]; then
  magick "$dir.png" "$lights" -composite "$dir-screenshot.png"
  outputs+=("$dir-screenshot.png")
fi
ls -lh "${outputs[@]}" | awk '{print $5, $NF}'
