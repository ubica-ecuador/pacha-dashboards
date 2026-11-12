#!/bin/sh
# Builds the files the tum-garching-lectures dashboard reads: the Technical
# University of Munich's Garching campus through one day of lectures.
#
#   rooms.parquet      every room of the Mathematics and Informatics and the
#                      Mechanical Engineering buildings, one row per room: its
#                      floor (OSM's level, "0;1" for a room over two), its kind
#                      (lecture hall, office, lab...) from NavigaTUM's use, how
#                      many lectures it holds that day, its outline as GeoJSON
#   corridors.parquet  their corridors and halls
#   slabs.parquet      each floor of the two buildings, its rooms merged
#   walls.parquet      walls along the rooms, open at the doors OSM maps
#   facades.parquet    every building of the campus as its footprint and height
#   lectures.parquet   one row per room and quarter hour in a lecture: the
#                      lecture's title, kind and hours, the minutes left, the
#                      room's floor, outline and middle
#   quarters.parquet   how many rooms are in a lecture each quarter hour,
#                      07:00 to 21:00
#
# Sources: the campus as mapped in OpenStreetMap (api.openstreetmap.org,
# © OpenStreetMap contributors, ODbL) and NavigaTUM (nav.tum.de, TUM's open
# campus API, its rooms and their calendars from TUMonline). The day is
# DAY (default 2026-11-10, a Tuesday of the winter semester, the day the
# dashboard shows); NavigaTUM is asked for its calendar ten rooms at a time,
# half a second apart, about a minute in all. build.mjs does the work; it was
# written for the Kepler Plus showcase of the same campus.
#
# The Parquet files are read by Grafana's DuckDB at
# http://feeds/datasets/tum-garching/. Nothing to restart afterwards; one run
# is enough.
#
# Needs curl, unzip, node (18 or later) and npm.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
DAY=${DAY:-2026-11-10}
FILES='rooms corridors slabs walls facades lectures quarters'

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

echo "polyclip-ts and @turf/buffer ..."
cp build.mjs "$work/"
(cd "$work" && echo '{"type":"module","private":true}' > package.json &&
  npm install --silent --no-audit --no-fund polyclip-ts@0.16.8 @turf/buffer@7.4.0)

echo "OpenStreetMap and NavigaTUM, $DAY ..."
mkdir "$work/data"
node "$work/build.mjs" "$work/data" "$DAY"

for f in $FILES; do
  echo "COPY (FROM read_json('$work/data/$f.ndjson', format = 'newline_delimited')) TO '$work/$f.parquet' (FORMAT parquet, COMPRESSION zstd);"
done | "$work/duckdb" -bail
for f in $FILES; do mv "$work/$f.parquet" "$here/$f.parquet"; done
ls -l $(for f in $FILES; do printf '%s.parquet ' "$f"; done)
