#!/bin/sh
# Builds what citibike-pulse draws: a month of Citi Bike trips in New York, from Lyft's public trip data
# (https://citibikenyc.com/system-data, s3://tripdata), turned into an average day. Jersey City and Hoboken
# publish their own files (JC-*): their stations are here only as the end of trips from New York.
#
#   stations.parquet  one row per station (by name, as the trips give it): latitude and longitude (the median of
#                     the trips' coordinates there) and the trips that started and ended there in the month.
#   hourly.parquet    one row per station, kind of day (Weekday, Weekend: Saturdays, Sundays and federal
#                     holidays) and hour (0-23, New York time): bikes taken out and brought in, on an average
#                     day of that kind. Out counts a trip in the hour it started, in in the hour it ended.
#   links.parquet     trips between H3 cells (resolution 8, about 0.7 km²) on an average day of each kind and
#                     each hour of departure: the 400 busiest pairs of different cells in each hour, with the
#                     cells' centres (lat0/lng0 to lat1/lng1). Station to station, the trips are too thin to draw:
#                     117,000 pairs share a weekday's 8 o'clock.
#
# Usage: ./build.sh [YYYYMM]  (default: the month before last, the latest Lyft has surely published; about
# 1 GB to download, 2 GB of scratch space). The gateway serves the files at http://feeds/datasets/citibike/;
# nothing to restart.
#
# Needs curl and unzip.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
MONTH=${1:-$(date -d "$(date +%Y-%m-01) -2 month" +%Y%m)}

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

echo "Trips $MONTH ..."
curl -fsS --retry 3 -o "$work/trips.zip" "https://s3.amazonaws.com/tripdata/$MONTH-citibike-tripdata.zip"
mkdir -p "$work/trips"
unzip -q -j "$work/trips.zip" '*.csv' -d "$work/trips"
rm "$work/trips.zip"

(cd "$work" && "$work/duckdb" -bail -c "SET VARIABLE month = '$MONTH';" -c ".read '$here/build.sql'")

for f in stations hourly links; do
  mv "$work/$f.parquet" "$here/$f.parquet.tmp" && mv "$here/$f.parquet.tmp" "$here/$f.parquet"
done
echo "Done: $(ls "$here"/*.parquet | wc -l) files in $here"
