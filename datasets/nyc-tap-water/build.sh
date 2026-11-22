#!/bin/sh
# Builds what nyc-tap-water draws: what New York's tap water carries on its way from the reservoirs to the
# street, from DEP's sampling of its distribution system (NYC Open Data, Distribution Water Quality, bkwf-xfky).
#
#   samples.parquet   one row per sample DEP took at a sampling station on the city's mains, 2015 to the
#                     latest month published: site, borough (Tunnel shafts for the shafts where
#                     the aqueducts' water enters the mains), time (New York), free chlorine (mg/L, what the tap tastes
#                     of), temperature (°C), turbidity (NTU) and total coliform and E. coli (MPN per 100 mL,
#                     0 where DEP found less than 1). About 14,000 a year at some 380 stations. 2015 is when
#                     DEP's free-chlorine analyte begins under its present name.
#   stations.parquet  the stations, from stations.csv (committed, written by locate.py): site, borough,
#                     DEP's description, latitude and longitude (null for the few it could not place) and
#                     how it was placed, with each station's sample count and first and last sample. Stations
#                     DEP stopped sampling before 2024 are not in it: their samples count, off the map.
#
# Socrata answers a year at a time in under a minute. The gateway serves the files at
# http://feeds/datasets/nyc-tap-water/; nothing to restart. DEP publishes a month or so behind.
#
# Needs curl and unzip.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
SOCRATA=https://data.cityofnewyork.us/resource/bkwf-xfky.csv
FIRST_YEAR=2015

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

mkdir -p "$work/samples"
year=$FIRST_YEAR
last=$(date +%Y)
while [ "$year" -le "$last" ]; do
  echo "Samples $year ..."
  curl -fsS --retry 3 --retry-delay 20 -m 600 -G -o "$work/samples/$year.csv" "$SOCRATA" \
    --data-urlencode '$select=sampleid,sampledatetime,site,borough,analyte,final' \
    --data-urlencode "\$where=system='Distribution' AND analyte in('Chlorine - Free Residual','Temperature','Turbidity','Total Coliform','E. Coli (Enumeration)') AND sampledatetime >= '$year-01-01' AND sampledatetime < '$((year + 1))-01-01'" \
    --data-urlencode '$limit=2000000'
  year=$((year + 1))
done
cp stations.csv "$work/"

(cd "$work" && "$work/duckdb" -bail -c ".read '$here/build.sql'")

for f in samples stations; do
  mv "$work/$f.parquet" "$here/$f.parquet.tmp" && mv "$here/$f.parquet.tmp" "$here/$f.parquet"
done
echo "Done: $(ls "$here"/*.parquet | wc -l) files in $here"
