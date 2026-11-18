#!/bin/sh
# Builds the GeoLife files the geolife-mobility dashboard reads: downloads the
# dataset from Microsoft Research (313 MB), runs build.sql on it with a DuckDB
# CLI of the release the Grafana datasource is linked against (its Parquet is
# the Parquet Grafana reads), and leaves the files here, in datasets/geolife/,
# which the gateway serves at http://feeds/datasets/geolife/. Once per
# instance, about three minutes; nothing to restart afterwards.
#
# GeoLife is Microsoft Research's, for non-commercial research use (see the
# dashboard's About tab): it is not in git, and the gateway serves these files
# to Grafana's DuckDB only, never to browsers.
#
# Needs curl, unzip, about 6 GB of free disk and DuckDB 8 GB of memory
# (GEOLIFE_MEMORY to change it).
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
ZIP_URL='https://download.microsoft.com/download/F/4/8/F4894AA5-FDBC-481E-9285-D5F8C4C4F039/Geolife%20Trajectories%201.3.zip'
FILES='fixes trips stops track cleaning sampling'

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

echo "GeoLife (313 MB) ..."
curl -fsSL -o "$work/geolife.zip" "$ZIP_URL"
mkdir "$work/data"
unzip -q "$work/geolife.zip" -d "$work/data"
src="$work/data/Geolife Trajectories 1.3"
[ -d "$src/Data" ] || { echo "No Data folder in the zip" >&2; exit 1; }

echo "Cleaning and analysing ..."
mkdir "$work/out" "$work/spill"
(cd "$work/out" && "$work/duckdb" -bail "$work/build.db" \
  -c "SET memory_limit = '${GEOLIFE_MEMORY:-8GB}'; SET threads = 4; SET preserve_insertion_order = false;
      SET temp_directory = '$work/spill'; SET VARIABLE src = '$src'" \
  -c ".read '$here/build.sql'")

# Replaced one by one, each by a rename: a reader never sees half a file.
for f in $FILES; do
  cp "$work/out/$f.parquet" "./.$f.parquet.tmp"
  chmod a+r "./.$f.parquet.tmp"
  mv "./.$f.parquet.tmp" "./$f.parquet"
done
ls -l ./*.parquet
