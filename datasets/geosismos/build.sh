#!/bin/sh
# Builds the file the geosismos-gnss-plus dashboard draws its map arrows, its
# station paths and its latitude-time map from: the daily east, north and up
# position of every Geo-Sismos GNSS station since 2013.
# Downloads the station catalog and each station's whole series from the
# Geo-Sismos API (158 requests, about 60 MB of JSON, four at a time), runs
# build.sql on each with a DuckDB CLI of the release the Grafana datasource is
# linked against, and leaves positions.parquet (about 3 MB, half a million
# days) here, in datasets/geosismos/, which the gateway serves at
# http://feeds/datasets/geosismos/. A few minutes; nothing to restart afterwards.
#
# Why a file: the API hands out one station per request, about a second each,
# and refuses the HEAD request DuckDB starts with, so a panel cannot gather the
# whole network on the fly. Geo-Sismos rewrites its series every few weeks
# (the dashboard's "Latest data"); run this again then to extend the file.
#
# The data is open: Data Observatory Foundation (2026), DOI 10.57716/5j4w-3b13.
#
# Needs curl and unzip.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
API='https://d3l3n3l7bvxxh8.cloudfront.net/graphs'
CATALOG='https://proj-sismos-source-files-prod.s3.us-east-1.amazonaws.com/summary_stations/parsed_data.json'
FILES='positions'

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

echo "Station catalog ..."
curl -fsSL --retry 4 --retry-delay 5 -o "$work/catalog.json" "$CATALOG"
"$work/duckdb" -noheader -list -separator ' ' -c "
  SELECT s.properties.id, s.properties.min_date_registered, s.properties.max_date_registered
  FROM (SELECT unnest(stations) AS s FROM read_json('$work/catalog.json', maximum_object_size = 16000000))
  ORDER BY 1" > "$work/stations.txt"
echo "  $(wc -l < "$work/stations.txt") stations"

# Each station's whole record in one request. The API writes NaN for a missing
# value, which is not JSON; it becomes null on the way to disk.
echo "Series, four at a time ..."
mkdir "$work/json"
export API work
xargs -P 4 -n 3 sh -c '
  curl -fsS --retry 4 --retry-delay 5 --retry-all-errors --max-time 120 \
    -A "pacha datasets/geosismos/build.sh" \
    "$API?id_station=$0&min_date=$1&max_date=$2" | sed "s/NaN/null/g" > "$work/json/$0.json"
  echo "  $0"
' < "$work/stations.txt"

# One station at a time, so memory stays at one record's worth, then one file.
echo "Positions ..."
mkdir "$work/parts" "$work/out"
for json in "$work"/json/*.json; do
  id=$(basename "$json" .json)
  (cd "$work/parts" && "$work/duckdb" -bail -c "SET VARIABLE src = '$json'" -c ".read '$here/build.sql'" \
    && mv part.parquet "$id.parquet")
done
(cd "$work/out" && "$work/duckdb" -bail -c "
  COPY (SELECT * FROM read_parquet('$work/parts/*.parquet') ORDER BY id, day)
  TO 'positions.parquet' (FORMAT parquet, COMPRESSION zstd)")

# Replaced one by one, each by a rename: a reader never sees half a file.
for f in $FILES; do
  cp "$work/out/$f.parquet" "./.$f.parquet.tmp"
  chmod a+r "./.$f.parquet.tmp"
  mv "./.$f.parquet.tmp" "./$f.parquet"
done
ls -l ./*.parquet
