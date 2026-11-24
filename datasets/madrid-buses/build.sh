#!/bin/sh
# Builds what madrid-live's Buses tab draws: a day of Madrid's city buses as EMT schedules it, from its GTFS
# (https://www.emtmadrid.es, open data; mirrored by MobilityData as mdb-793).
#
#   buses.parquet    every stop of every bus on the day, one row per bus and stop in time order: bus (the vehicle
#                    of a GTFS block, numbered 1..n), line, kind (Day, or Night for the Búhos), time (Madrid's
#                    local time, as a TIMESTAMP on the day; trips after midnight run into the next day) and
#                    latitude/longitude of the stop. About a million rows: kepler draws each bus as one trip.
#   active.parquet   minute by minute, the buses on a trip (between the first and the last stop of one of their
#                    trips) and the trips under way, Day and Night apart.
#   day.parquet      one row: the day, its services, and its buses, lines, trips and stops served.
#
# Usage: ./build.sh [YYYY-MM-DD]  (default: the next Tuesday, an ordinary working day). EMT's server answers on
# port 8443, which some hosts cannot reach: the MobilityData mirror (a day behind) is tried after it.
# The gateway serves the files at http://feeds/datasets/madrid-buses/; nothing to restart.
#
# Needs curl and unzip.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
DAY=${1:-$(date -d "$(( (9 - $(date +%u)) % 7 )) days" +%Y-%m-%d)}

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

echo "GTFS ..."
curl -fsS -m 120 -o "$work/gtfs.zip" https://servicios.emtmadrid.es:8443/gtfs/transitemt.zip ||
  curl -fsSL -m 300 -o "$work/gtfs.zip" https://files.mobilitydatabase.org/mdb-793/latest.zip
mkdir -p "$work/gtfs"
unzip -q -j "$work/gtfs.zip" '*.txt' -d "$work/gtfs"

echo "Day $DAY ..."
(cd "$work" && "$work/duckdb" -bail -c "SET VARIABLE day = DATE '$DAY';" -c ".read '$here/build.sql'")

for f in buses active day; do
  mv "$work/$f.parquet" "$here/$f.parquet.tmp" && mv "$here/$f.parquet.tmp" "$here/$f.parquet"
done
echo "Done: $(ls "$here"/*.parquet | wc -l) files in $here"
