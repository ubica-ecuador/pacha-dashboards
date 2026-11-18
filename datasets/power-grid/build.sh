#!/bin/sh
# Builds the file the wildfires-power-grid dashboard measures fires against:
# every overhead line and cable of 200 kV and more on Earth, from the base
# theme of an Overture Maps release (its infrastructure features keep the
# OpenStreetMap tags they came from, voltage and operator among them). Reads
# the power features out of Overture's public bucket (about 14 GB to scan,
# some ten minutes) with a DuckDB CLI of the release the Grafana datasource is
# linked against, and leaves lines.parquet (about 120 MB, 300,000 lines) here,
# in datasets/power-grid/, which the gateway serves at
# http://feeds/datasets/power-grid/. Nothing to restart afterwards. Run it
# again with a newer RELEASE to take in the map's edits; the grid changes
# slowly.
#
# Why a file: the dashboard used to ask Overpass for each region's lines, and
# overpass-api.de refuses connections from some hosts (this one since
# October 2026) and queues the rest; a panel cannot wait on it. Reading
# Overture's bucket from a panel takes 20 s per region.
#
# The data: Overture Maps Foundation, from OpenStreetMap contributors, ODbL.
#
# Needs curl and unzip.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
RELEASE=${RELEASE:-2026-10-21.0}
FILES='lines'

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

echo "Lines of 200 kV and more, Overture $RELEASE ..."
mkdir "$work/out" "$work/spill"
(cd "$work/out" && "$work/duckdb" -bail "$work/build.db" \
  -c "SET threads = 4; SET memory_limit = '3GB'; SET preserve_insertion_order = false;
      SET temp_directory = '$work/spill'; SET VARIABLE release = '$RELEASE'" \
  -c ".read '$here/build.sql'")

# Replaced by a rename: a reader never sees half a file.
for f in $FILES; do
  cp "$work/out/$f.parquet" "./.$f.parquet.tmp"
  chmod a+r "./.$f.parquet.tmp"
  mv "./.$f.parquet.tmp" "./$f.parquet"
done
ls -l ./*.parquet
