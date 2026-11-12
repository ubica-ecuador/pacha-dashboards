#!/bin/sh
# Builds the files the mtr-admiralty dashboard reads: Admiralty station of
# Hong Kong's MTR, floor by floor, and the track beside each of its eight
# platforms.
#
#   floors.parquet     its eight floors (L6, 34 m under the street, to the
#                      landscape deck U1): name, height (mPD), height to the
#                      next floor, outline
#   units.parquet      platforms, tracks, escalators, stairs, lifts,
#                      concourses, toilets and shops, each its outline
#   walls.parquet      each floor's outline as a wall 0.3 m thick, 1.4 m high
#   points.parquet     exits, platforms, gates, customer service, toilets,
#                      defibrillators and shops, each a point
#   platforms.parquet  the eight platforms: line, colour, direction, where a
#                      train stops along the track and how long it is
#   slices.parquet     the track beside each platform cut every metre along
#                      it: a train is drawn as the slices it covers
#
# Source: the Lands Department's 3D Indoor Map of MTR stations, from the
# Common Spatial Data Infrastructure (CSDI) Portal's Map API
# (mapapi.hkmapservice.gov.hk, free, no key; "Map from Lands Department",
# CSDI terms of use: the Government and the CSDI Portal named as the source).
# Seven requests, two seconds apart, as the API asks (venue by venue, no
# bursts). The live trains are not here: the dashboard asks MTR's Next Train
# API through the gateway (/mtr/nexttrain/).
#
# The Parquet files are read by Grafana's DuckDB at
# http://feeds/datasets/mtr-admiralty/. Nothing to restart afterwards; one run
# is enough (the station changes rarely).
#
# Needs curl and unzip.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
VENUE=b9b2f6ff-582d-40b0-b82d-027e950e6791 # Admiralty Station
FILES='floors units walls points platforms slices'
API=https://mapapi.hkmapservice.gov.hk/ogc/wfs/indoor
WFS='service=WFS&version=1.1.0&request=GetFeature&outputFormat=application%2Fjson'

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

echo "Lands Department 3D Indoor Map, Admiralty ..."
mkdir "$work/in"
for layer in level_polygon unit_polygon amenity_point occupant_point; do
  curl -fsS --retry 2 -o "$work/in/${layer%_*}.json" \
    "$API/mtr_$layer?$WFS&cql_filter=venue_id%3D%27$VENUE%27"
  sleep 2
done
# Every station's outline (98): where the neighbouring stations are.
curl -fsS --retry 2 -o "$work/in/mtr_venues.json" "$API/mtr_venue_polygon?$WFS"

sed -e "s|@IN@|$work/in|g" -e "s|@OUT@|$work|g" build.sql | "$work/duckdb" -bail
for f in $FILES; do mv "$work/$f.parquet" "$here/$f.parquet"; done
ls -l $(for f in $FILES; do printf '%s.parquet ' "$f"; done)
