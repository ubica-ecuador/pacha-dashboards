#!/bin/sh
# Builds what madrid-heat-island draws: Madrid's surface temperature in July
# 2026 by day and by night, each against its countryside, in a frame of 60 km
# around Puerta del Sol (UTM 30N):
#
#   day.tif            Landsat 8 and 9 at 12:55 (Madrid's clock), 30 m: the
#                      median of July's clear passes of path 201, row 32 (clouds
#                      and their shadows masked by QA_PIXEL)
#   night.tif          MODIS Terra at night, 22:39, 1 km: the median of July's
#                      good-quality retrievals (MOD11A1 v6.1)
#                      Both in °C against the countryside: one byte, 128 + 10 ×
#                      °C, with a colour table (blue cooler, red warmer, ±6 °C at
#                      the ends) that Pacha's tile server paints.
#   cells.parquet      the 1 km cells: WorldCover's share of each class, the
#                      July medians in °C (Landsat averaged to the cell, MODIS by
#                      day at 11:33 and at night) and each against the
#                      countryside, the distance to Puerta del Sol, the square
#   landcover.parquet  Landsat's 30 m pixels by WorldCover class, against the
#                      countryside: count and percentiles
#   summary.parquet    the three products, their time and passes, and the
#                      countryside's median
#
# The countryside is the 1 km cells under 5 % built-up (ESA WorldCover 2021,
# 10 m) and not mostly water; its median is the zero of every map and chart.
# Surface temperature is how hot the ground, roofs and leaves are, not the air.
#
# Reads Microsoft's Planetary Computer (Landsat Collection 2 Level-2 and MODIS
# MOD11A1 as COGs, with its anonymous SAS tokens) and ESA WorldCover on AWS: a
# few minutes of downloads, none of them kept. Runs anywhere with GDAL's Python
# bindings and numpy (Debian's python3-gdal; or inside ghcr.io/osgeo/gdal); the
# files can then be copied to an instance's datasets/madrid-heat/. The
# gateway serves the Parquet at http://feeds/datasets/madrid-heat/ and the
# GeoTIFFs too (gateway/datasets-tif.conf.template). Nothing to restart
# afterwards. MONTH (YYYY-MM, 2026-07 unless set) builds another month.
#
# The data: USGS Landsat 8 and 9, NASA MODIS (LP DAAC), both through Microsoft
# Planetary Computer; ESA WorldCover 2021 (CC BY 4.0).
#
# Needs curl, unzip and python3 with GDAL.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
python3 -c 'from osgeo import gdal; import numpy' 2>/dev/null || {
  echo "python3 needs GDAL's bindings and numpy (apt install python3-gdal)" >&2; exit 1; }

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

mkdir "$work/out"
python3 "$here/build.py" "$work/out"
(cd "$work/out" && "$work/duckdb" -bail -c ".read '$here/build.sql'")

for f in day.tif night.tif cells.parquet landcover.parquet summary.parquet; do
  mv "$work/out/$f" "$here/$f.tmp" && mv "$here/$f.tmp" "$here/$f"
done
echo "Done: $(ls "$here"/*.tif "$here"/*.parquet | wc -l) files in $here"
