#!/bin/sh
# Builds the files the mbta-south-station dashboard reads: Boston's South
# Station floor by floor, from the Red Line platforms three floors down to the
# bus terminal.
#
#   floors.parquet     its six floors: name, outline (everything on the floor,
#                      3 m around, merged)
#   areas.parquet      platforms, concourses, rooms and the Silver Line busway
#                      from OpenStreetMap, each its outline and floor
#   lifts.parquet      every elevator and escalator, one row per floor it
#                      reaches: its MBTA facility id, name, the floors it joins
#   points.parquet     the platforms and entrances (GTFS stops)
#   tracks.parquet     Commuter Rail tracks 1 to 13 and the Red Line's two, as
#                      1.5 m beds, each with the GTFS stop its trains use
#   slices.parquet     each track cut every metre along it, 3 m wide, with its
#                      middle in metres (EPSG:26986): a train is drawn as the
#                      slices between its tail and its front
#
# Sources: MBTA's GTFS (cdn.mbta.com/MBTA_GTFS.zip: levels.txt, stops.txt,
# pathways.txt, facilities.txt; MBTA developers' terms) and OpenStreetMap
# (api.openstreetmap.org, one map request of the station's block,
# © OpenStreetMap contributors, ODbL). The live trains, buses and service
# alerts are not here: the dashboard reads MBTA's GTFS Realtime feeds through
# the gateway (/mbta/realtime/).
#
# The Parquet files are read by Grafana's DuckDB at
# http://feeds/datasets/mbta-south-station/. Nothing to restart afterwards; run
# it again when MBTA renumbers the station's elevators or escalators.
#
# Needs curl and unzip.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
FILES='floors areas lifts points tracks slices'
BBOX=-71.0590,42.3480,-71.0520,42.3545

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

mkdir "$work/in"
echo "MBTA GTFS ..."
curl -fsSL -o "$work/gtfs.zip" https://cdn.mbta.com/MBTA_GTFS.zip
unzip -q -j "$work/gtfs.zip" levels.txt stops.txt pathways.txt facilities.txt -d "$work/in"
echo "OpenStreetMap, South Station ..."
curl -fsS -A "Pacha (+https://github.com/ubica-ecuador/pacha-dashboards)" \
  -o "$work/in/osm.json" "https://api.openstreetmap.org/api/0.6/map.json?bbox=$BBOX"

sed -e "s|@IN@|$work/in|g" -e "s|@OUT@|$work|g" build.sql | "$work/duckdb" -bail
for f in $FILES; do mv "$work/$f.parquet" "$here/$f.parquet"; done
ls -l $(for f in $FILES; do printf '%s.parquet ' "$f"; done)
