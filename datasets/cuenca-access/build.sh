#!/bin/sh
# Builds what the cuenca-accessibility dashboard joins R5's travel times to,
# every row placed in a cell of R5's grid of Cuenca (zoom 10, about 153 m
# across) by its column and row, px and py, so that a travel-time surface
# joins it on two integers, in the server or in the browser, with no spatial
# test:
#
#   population.parquet  people in each cell: LlactaLAB's population per
#                       building (Google Open Buildings, disaggregated), the
#                       same layer R5's accessibility counts were built from
#   streets.parquet     every road of Overture Maps cut at the cells' edges,
#                       one piece per street and cell
#   places.parquet      transit stops (the GTFS R5 routes on), park entrances
#                       (LlactaLAB, Universidad de Cuenca), hospitals, schools
#                       and shopping centres (Overture), one row per place and
#                       cell it touches
#
# A few seconds of downloads (27 MB of buildings, Overture's few files of
# Cuenca) and a minute of DuckDB. The files land here, in
# datasets/cuenca-access/, which the gateway serves at
# http://feeds/datasets/cuenca-access/. Nothing to restart afterwards.
#
# R5_URL is where the R5 instance of Cuenca answers (its gateway, which the
# stops are read from); only pacha.ubica.dev has one. RELEASE is an Overture
# Maps release.
#
# The data: LlactaLAB, Universidad de Cuenca; Overture Maps Foundation, from
# OpenStreetMap contributors, ODbL; the GTFS of Cuenca's buses and tram.
#
# Needs curl and unzip.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
RELEASE=${RELEASE:-2026-10-21.0}
R5_URL=${R5_URL:-http://127.0.0.1:7070}
GTFS_BUNDLE=${GTFS_BUNDLE:-6a976415196cd834c785ad5d}
LLACTALAB=https://appsllactalab.ucuenca.edu.ec/geoserver/geonode
FILES='population streets places'

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

echo "Population per building, LlactaLAB ..."
curl -fsS -m 900 -G "$LLACTALAB/open_buildings_cuenca_centroid/ows" -o "$work/buildings.csv" \
  --data-urlencode service=WFS --data-urlencode version=2.0.0 --data-urlencode request=GetFeature \
  --data-urlencode typeNames=geonode:open_buildings_cuenca_centroid --data-urlencode outputFormat=csv \
  --data-urlencode propertyName=latitude,longitude,poblacion_edificacion \
  --data-urlencode "cql_filter=BBOX(geom,-79.11,-3.02,-78.87,-2.76,'EPSG:4326')"
echo "Park entrances, LlactaLAB ..."
curl -fsS -m 300 -G "$LLACTALAB/puntos_acceso_parques/ows" -o "$work/parks.geojson" \
  --data-urlencode service=WFS --data-urlencode version=2.0.0 --data-urlencode request=GetFeature \
  --data-urlencode typeNames=geonode:puntos_acceso_parques --data-urlencode outputFormat=application/json \
  --data-urlencode srsName=EPSG:4326
echo "Transit stops, R5 at $R5_URL ..."
curl -fsS -m 60 -o "$work/stops.json" "$R5_URL/api/gtfs/$GTFS_BUNDLE/stops"

echo "Streets and services, Overture $RELEASE ..."
mkdir "$work/out" "$work/spill"
(cd "$work/out" && "$work/duckdb" -bail "$work/build.db" \
  -c "SET threads = 4; SET memory_limit = '3GB'; SET preserve_insertion_order = false;
      SET temp_directory = '$work/spill'; SET VARIABLE release = '$RELEASE';
      SET VARIABLE buildings = '$work/buildings.csv'; SET VARIABLE parks = '$work/parks.geojson';
      SET VARIABLE stops = '$work/stops.json'" \
  -c ".read '$here/build.sql'")

# Replaced by a rename: a reader never sees half a file.
for f in $FILES; do
  cp "$work/out/$f.parquet" "./.$f.parquet.tmp"
  chmod a+r "./.$f.parquet.tmp"
  mv "./.$f.parquet.tmp" "./$f.parquet"
done
ls -l ./*.parquet
