#!/bin/sh
# Builds what ufo-sightings draws: the reports to the National UFO Reporting
# Center (NUFORC), 80,331 from 1906 to 2014, geocoded and their times
# standardized by planetsig in 2014 (github.com/planetsig/ufo-reports):
#
#   nuforc.parquet   the repository's CSV as it is, column for column and as
#                    text (it has no header row): datetime, city, state,
#                    country, shape, duration in seconds and as reported,
#                    comments, date posted, latitude, longitude. The
#                    dashboard's dataset cleans and casts them in its own SQL.
#
# One download of 14 MB, not kept. The gateway serves the file at
# http://feeds/datasets/ufo-sightings/nuforc.parquet; nothing to restart.
#
# Needs curl and unzip.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
CSV=https://raw.githubusercontent.com/planetsig/ufo-reports/master/csv-data/ufo-scrubbed-geocoded-time-standardized.csv

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

echo "NUFORC reports ..."
curl -fsSL -o "$work/nuforc.csv" "$CSV"
(cd "$work" && "$work/duckdb" -bail -c ".read '$here/build.sql'")

mv "$work/nuforc.parquet" "$here/nuforc.parquet.tmp" && mv "$here/nuforc.parquet.tmp" "$here/nuforc.parquet"
echo "Done: $here/nuforc.parquet"
