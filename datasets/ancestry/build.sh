#!/bin/sh
# Builds the files the ancestry-esda dashboard reads:
# downloads the American Community Survey 2020-2024 five-year summary files for
# three tables and the Census Bureau's cartographic boundary file of census
# tracts (about 370 MB, all from www2.census.gov, no key), runs build.sql on
# them with a DuckDB CLI of the release the Grafana datasource is linked
# against, and leaves the files here, in datasets/ancestry/, which the gateway
# serves at http://feeds/datasets/ancestry/. Once per instance, a few minutes;
# nothing to restart afterwards.
#
# Every input is a work of the U.S. federal government, in the public domain.
# The outputs are derived (about 70 MB) and rebuilt rather than kept in git.
#
# Needs curl, unzip, about 2 GB of free disk and internet access for the DuckDB
# extensions spatial (core) and h3 (community).
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
YEAR=2024
SF="https://www2.census.gov/programs-surveys/acs/summary_file/$YEAR/table-based-SF"
TIGER="https://www2.census.gov/geo/tiger/GENZ$YEAR/shp"
FILES='ancestries dots h3 tract-ancestry tracts-geom tracts weights'

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

get() { echo "  $1"; curl -fsSL --retry 4 --retry-delay 5 -o "$work/src/$1" "$2/$1"; }
echo "Census inputs ..."
mkdir "$work/src"
get "ACS${YEAR}5YR_Table_Shells.txt" "$SF/documentation"
for t in b04006 b03001 b02015; do
  get "acsdt5y$YEAR-$t.dat" "$SF/data/5YRData"
done
get "cb_${YEAR}_us_tract_500k.zip" "$TIGER"

echo "Groups, tracts, dots, hexagons ..."
mkdir "$work/out" "$work/spill"
(cd "$work/out" && "$work/duckdb" -bail "$work/build.db" \
  -c "SET threads = 4; SET preserve_insertion_order = false; SET temp_directory = '$work/spill';
      SET VARIABLE src = '$work/src'; SET VARIABLE year = '$YEAR'" \
  -c ".read '$here/build.sql'")

# Replaced one by one, each by a rename: a reader never sees half a file.
for f in $FILES; do
  cp "$work/out/$f.parquet" "./.$f.parquet.tmp"
  chmod a+r "./.$f.parquet.tmp"
  mv "./.$f.parquet.tmp" "./$f.parquet"
done
ls -l ./*.parquet
