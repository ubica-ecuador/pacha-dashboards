#!/bin/sh
# Builds what paris-ride draws: a camera crossing Paris from Port-Royal to Strasbourg-Saint-Denis, one
# picture a second, and the places along its way.
#
#   ride.parquet    one row per picture of a Panoramax sequence (626 on 13 May 2025, 4.2 km in 15 minutes,
#                   about 16 km/h): when, where, which way the camera looked and how wide, its speed, the
#                   distance and the time from the start, and the address of the picture (read by the
#                   browser from Panoramax, never stored here)
#   places.parquet  Overture's places within 300 m of the route (the view's range), with their name and
#                   category, for the places the camera has in sight
#
# The sequence does not change: run this once. Two downloads, about 4 MB from Panoramax and a few from
# Overture's files on S3, not kept. The gateway serves the files at http://feeds/datasets/paris-ride/;
# nothing to restart.
#
# The data: the pictures and their positions, Pierre Beyssac on Panoramax (panoramax.openstreetmap.fr),
# CC BY-SA 4.0; the places, Overture Maps Foundation, release 2026-10-21.0 (CDLA Permissive 2.0, ODbL
# where it comes from OpenStreetMap).
#
# Needs curl and unzip.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
SEQUENCE=8278fba7-8e07-4f52-a76f-9660a919f4b0
ITEMS="https://panoramax.openstreetmap.fr/api/collections/$SEQUENCE/items?limit=1000"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

case $(uname -m) in
  x86_64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "No DuckDB CLI for $(uname -m)" >&2; exit 1 ;;
esac
echo "DuckDB $DUCKDB_VERSION ..."
curl -fsSL -o "$work/duckdb.zip" "https://github.com/duckdb/duckdb/releases/download/v$DUCKDB_VERSION/duckdb_cli-linux-$arch.zip"
unzip -q "$work/duckdb.zip" -d "$work"

echo "The sequence's pictures ..."
curl -fsSL -o "$work/items.json" "$ITEMS"
echo "The ride and the places along it ..."
(cd "$work" && "$work/duckdb" -bail -c ".read '$here/build.sql'")
mv "$work/ride.parquet" "$work/places.parquet" "$here/"
echo "Done: $(ls "$here"/*.parquet | tr '\n' ' ')"
