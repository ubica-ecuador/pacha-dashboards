#!/bin/sh
# Builds what nyc-street-heat draws: the air temperature on New York's streets, hour by hour, through the heat
# wave of July 2019, from the sensors of the Cool Neighborhoods NYC study, and the city's Heat Vulnerability Index.
#
#   readings.parquet  one row per sensor and hour, 15 to 24 July 2019 (84,595 rows from 354 sensors): when (UTC),
#                     the sensor and where it hangs (a street tree or a light pole), its neighbourhood (code and
#                     name), and the hour's mean air temperature in °C and °F
#   zcta.parquet      New York's ZIP Code Tabulation Areas with the Heat Vulnerability Index of each (1 lowest
#                     risk, 5 highest), the outline as WKT simplified to about 5 m, and its box
#
# NYC Parks, the Mayor's Office of Resilience and the Department of Health (DOHMH) hung these sensors on blocks of
# the neighbourhoods with the highest heat mortality risk (East Harlem, the South Bronx, Brownsville...) in the
# summers of 2018 and 2019. The study is over: run this once. Four downloads from NYC Open Data (Socrata), about
# 15 MB, not kept. The gateway serves the files at http://feeds/datasets/nyc-street-heat/; nothing to restart.
#
# The data, all under NYC Open Data's terms of use: "Hyperlocal Temperature Monitoring" (qdq3-9eqn), DOHMH and NYC
# Parks; the neighbourhoods' names, "New York City Population By Neighborhood Tabulation Areas" (swpk-hqdp), the
# 2010 NTAs, Department of City Planning; "Heat Vulnerability Index Rankings" (4mhf-duep), DOHMH; "ZIP Code
# Tabulation Areas" (35j5-n34v).
#
# Needs curl and unzip.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
# Hours as published, in New York's time (EDT, UTC-4 in July): from the 15th at midnight to the 24th at 23 h.
READINGS="https://data.cityofnewyork.us/resource/qdq3-9eqn.csv?\$where=day%20between%20'2019-07-15T00:00:00'%20and%20'2019-07-24T00:00:00'&\$order=sensor_id,day,hour&\$limit=200000"
NAMES="https://data.cityofnewyork.us/resource/swpk-hqdp.csv?\$select=nta_code,nta_name&\$where=year='2010'&\$limit=1000"
HVI="https://data.cityofnewyork.us/resource/4mhf-duep.csv?\$limit=1000"
ZCTA="https://data.cityofnewyork.us/resource/35j5-n34v.geojson?\$limit=1000"

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

echo "The sensors' readings ..."
curl -fsSL -A 'pacha-datasets' -o "$work/readings.csv" "$READINGS"
echo "The neighbourhoods' names ..."
curl -fsSL -A 'pacha-datasets' -o "$work/names.csv" "$NAMES"
echo "The ZIP codes and their Heat Vulnerability Index ..."
curl -fsSL -A 'pacha-datasets' -o "$work/hvi.csv" "$HVI"
curl -fsSL -A 'pacha-datasets' -o "$work/zcta.geojson" "$ZCTA"
(cd "$work" && "$work/duckdb" -bail -c ".read '$here/build.sql'")
mv "$work/readings.parquet" "$work/zcta.parquet" "$here/"
echo "Done: $(ls "$here"/*.parquet | tr '\n' ' ')"
