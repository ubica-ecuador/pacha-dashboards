#!/bin/sh
# Builds the week of New York taxi trips the nyc-taxi-live dashboard replays:
# downloads Monday 14 to Sunday 20 September 2015 from QuestDB's public demo
# (demo.questdb.io, CSV through its /exp endpoint, about 370 MB), runs
# build.sql on it with a DuckDB CLI of the release the Grafana datasource is
# linked against, and leaves trips-2015-w38.parquet (about 80 MB, 3.1 million
# trips) here, in datasets/nyc-taxi/, which the gateway serves at
# http://feeds/datasets/nyc-taxi/. Once per instance, a few minutes; nothing to
# restart afterwards.
#
# Why QuestDB's demo and not the TLC: the trip records the NYC Taxi & Limousine
# Commission publishes today no longer carry coordinates for any year (the 2015
# files were reprocessed with only zone ids, and the original CSV bucket
# answers 403). The QuestDB demo still holds the original rows with latitude
# and longitude. It is somebody else's demo instance, so this mirrors one week
# rather than letting a dashboard query it.
#
# Needs curl, unzip, about 1 GB of free disk and internet access for the DuckDB
# community extension h3.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
EXPORT='https://demo.questdb.io/exp'
COLUMNS='cab_type, pickup_datetime, dropoff_datetime, pickup_latitude, pickup_longitude, dropoff_latitude, dropoff_longitude, passenger_count, trip_distance, fare_amount, tip_amount, total_amount'
FILES='trips-2015-w38'

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

# One day per request, as QuestDB's CSV export. The demo answers 403 to some
# user agents (Python's), so it gets a name of its own.
mkdir "$work/csv"
for d in 14 15 16 17 18 19 20; do
  day="2015-09-$d"
  echo "Trips of $day ..."
  curl -fsS --retry 4 --retry-delay 5 --retry-all-errors --max-time 600 \
    -A 'pacha datasets/nyc-taxi/build.sh' -G "$EXPORT" \
    --data-urlencode "query=SELECT $COLUMNS FROM trips WHERE pickup_datetime IN '$day'" \
    -o "$work/csv/$day.csv"
done

echo "Cleaning ..."
mkdir "$work/out"
(cd "$work/out" && "$work/duckdb" -bail \
  -c "SET VARIABLE src = '$work/csv'" \
  -c ".read '$here/build.sql'")

# Replaced one by one, each by a rename: a reader never sees half a file.
for f in $FILES; do
  cp "$work/out/$f.parquet" "./.$f.parquet.tmp"
  chmod a+r "./.$f.parquet.tmp"
  mv "./.$f.parquet.tmp" "./$f.parquet"
done
ls -l ./*.parquet
