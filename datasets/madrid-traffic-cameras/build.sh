#!/bin/sh
# Builds what madrid-traffic-cameras draws: every traffic camera of Madrid's City Council, where it
# stands and the address of the picture it takes.
#
#   cameras.parquet  one row per camera of informo.madrid.es's CCTV.kml (357 in November 2026): its
#                    number, its name as the city writes it (the number added where two share a
#                    name), latitude and longitude, the picture's address (a JPEG the city replaces
#                    every few minutes, read by the browser, never stored here), whether it stands
#                    on the M-30 ring road or in a tunnel, and when the list was read.
#
# The list changes when the city adds or moves a camera: run this again to follow it. One download,
# about 240 KB, not kept. The gateway serves the file at
# http://feeds/datasets/madrid-traffic-cameras/; nothing to restart.
#
# The data: Ayuntamiento de Madrid, "Tráfico. Cámaras" (datos.madrid.es, dataset 202088),
# CC BY 4.0.
#
# Needs curl and unzip.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
CAMERAS=https://informo.madrid.es/informo/tmadrid/CCTV.kml

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

echo "Madrid's traffic cameras ..."
curl -fsSL -o "$work/CCTV.kml" "$CAMERAS"
(cd "$work" && "$work/duckdb" -bail -c ".read '$here/build.sql'")

mv "$work/cameras.parquet" "$here/cameras.parquet.tmp" && mv "$here/cameras.parquet.tmp" "$here/cameras.parquet"
echo "Done: $here/cameras.parquet"
