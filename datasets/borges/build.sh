#!/bin/sh
# Builds what the five Borges dashboards draw (borges-empire, borges-province, borges-district,
# borges-town, borges-one-to-one): the country around Rhyolite, Nevada, a mining town of 1905 left
# in ruins by 1920, on four sheets of the USGS Historical Topographic Map Collection (public
# domain), each a quarter of the one before, and the last one laid at 1:1 over the town:
#
#   empire-1908.tif     Furnace Creek, 1:250,000, 1908 (1° × 1°)
#   province-1942.tif   Bullfrog, 1:125,000, 1942 (30')
#   district-1954.tif   Bullfrog, 1:62,500, 1954 (15')
#   town-1987.tif       Beatty, 1:24,000, 1987 (7.5')
#                       Each clipped at its neatline (the collar off) and moved from NAD27 into
#                       Web Mercator with NOAA's grids, JPEG with a mask, for Pacha's tile server.
#   ruins-0.tif …       the 1987 sheet over the town of Rhyolite at 2.5 m, as the years would leave
#   ruins-7.tif         paper laid on the desert: one file every five years from 1987, torn along
#                       a fractal field (seeded 1946, the year of the story), bleached toward the
#                       sand, its torn edges darkened. 22 % of the paper is left in the last.
#   sheets.parquet      each sheet: its level, quadrangle, year, scale, neatline, ground and
#                       paper sizes
#   stages.parquet      the eight stages: the years they cover and the paper left
#   animals.parquet     GBIF's animal occurrences in the town with a year, under CC0 or CC BY 4.0
#                       (the CC BY-NC records are left out), with English names from GBIF
#
# A few minutes: four sheets of 3 to 10 MB from the USGS, NOAA's grid tiles through PROJ's CDN,
# and GBIF's API. Nothing kept but the result. The gateway serves the GeoTIFFs to the tile server
# and the Parquet at http://feeds/datasets/borges/; nothing to restart.
#
# Needs curl, unzip, GDAL's command-line tools (gdalwarp, gdal_translate, gdalinfo; GDAL 3.6 or
# later for COG with a mask) and python3 with numpy.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
for tool in gdalwarp gdal_translate gdalinfo; do
  command -v "$tool" >/dev/null || { echo "$tool is missing (apt install gdal-bin)" >&2; exit 1; }
done
python3 -c 'import numpy' 2>/dev/null || { echo "python3 needs numpy (apt install python3-numpy)" >&2; exit 1; }

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
echo "Sheets, ruins and animals ..."
python3 "$here/build.py" "$work/out" "$work" "$work/duckdb"

for f in "$work"/out/*; do
  mv "$f" "$here/$(basename "$f")"
done
echo "Done: $(ls "$here" | grep -c -E '\.(tif|parquet)$') files in datasets/borges"
