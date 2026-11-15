#!/bin/sh
# Builds what ecuador-from-inside draws: the earthquakes under the northern Andes, from Panama to
# central Peru (12° S to 8° N, 84° W to 66° W), as the USGS's ComCat catalog lists them since 1900.
#
#   quakes.parquet   one row per earthquake with a depth and a magnitude: id, time (UTC), place,
#                    latitude, longitude, depth in km, magnitude and its type, the network that
#                    located it and whether it was reviewed. About 12,000 rows. Public domain (USGS).
#   land.parquet     the countries' land inside the same box, as GeoJSON (geometry), for the map's
#                    ground: Natural Earth's 1:50m countries (public domain), version 5.1.2.
#
# ComCat holds what the world's networks report: outside the United States it is complete from
# about magnitude 4.5 since the 1970s, with fewer and coarser events before. A depth of exactly
# 10 or 33 km is often one the network fixed, not one it measured.
#
# One query to the catalog (its limit is 20,000 events a query; the script stops if the box holds
# more). The gateway serves the file at http://feeds/datasets/andes-quakes/; nothing to restart.
#
# Needs curl and unzip; DuckDB installs its spatial extension the first time.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
FDSN=https://earthquake.usgs.gov/fdsnws/event/1
LAND=https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_50m_admin_0_countries.geojson
BOX='minlatitude=-12&maxlatitude=8&minlongitude=-84&maxlongitude=-66&starttime=1900-01-01&eventtype=earthquake'

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

n=$(curl -fsSL "$FDSN/count?format=text&$BOX")
echo "ComCat: $n earthquakes in the box ..."
if [ "$n" -ge 20000 ]; then echo "More than one query can hold: split the box" >&2; exit 1; fi
curl -fsSL -o "$work/fdsn.csv" "$FDSN/query?format=csv&orderby=time-asc&$BOX"
echo "Natural Earth countries ..."
curl -fsSL -o "$work/countries.geojson" "$LAND"
(cd "$work" && "$work/duckdb" -bail -c ".read '$here/build.sql'")

for f in quakes.parquet land.parquet; do
  mv "$work/$f" "$here/$f.tmp" && mv "$here/$f.tmp" "$here/$f"
done
echo "Done: $(ls "$here"/*.parquet | wc -l) files in $here"
