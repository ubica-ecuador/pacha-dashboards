#!/bin/sh
# Builds the file the baltic-cable-watch dashboard and its alert rule read:
# every cable and pipeline on the floor of the Baltic, from the Kattegat to the
# Bothnian Bay, each with its fence, the corridor a ship must not linger in.
#
#   telecom  TeleGeography's Submarine Cable Map (CC BY-SA 4.0)
#   power    OpenStreetMap's underwater power cables (ODbL), from Overpass
#   gas      EMODnet Human Activities' pipelines (CC BY 4.0), gas only
#
# A fence is the cable's line widened to a kilometre on each side, less five
# kilometres around every port (EMODnet's port locations) and every cable
# landing (TeleGeography's): ships wait and moor there, over the cables'
# landfalls, and that is no alarm.
#
# Leaves cables.parquet and flags.parquet (a ship's flag by the first digits
# of its MMSI) here, in datasets/baltic-cables/, which the gateway serves at
# http://feeds/datasets/baltic-cables/. About a megabyte; a minute to build. Nothing to restart afterwards. The seabed
# changes slowly: run it again when a cable is laid.
#
# Overpass: overpass-api.de refuses some hosts (this one since October 2026),
# so its mirrors are tried in turn.
#
# Needs curl and unzip.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
FILES='cables flags'
UA='Pacha (+https://github.com/ubica-ecuador/pacha)'

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

echo "Telecom cables and landings, TeleGeography ..."
curl -fsSL -A "$UA" -o "$work/telecom.json" https://www.submarinecablemap.com/api/v3/cable/cable-geo.json
curl -fsSL -A "$UA" -o "$work/landings.json" https://www.submarinecablemap.com/api/v3/landing-point/landing-point-geo.json

# EMODnet's WFS takes the box as lat,lon in EPSG:4326's own axis order.
wfs='https://ows.emodnet-humanactivities.eu/wfs?service=WFS&version=2.0.0&request=GetFeature&outputFormat=application/json&srsName=EPSG:4326&bbox=53,9,67,33,urn:ogc:def:crs:EPSG::4326&typeNames=emodnet:'
echo "Pipelines and ports, EMODnet ..."
curl -fsSL -A "$UA" -o "$work/pipelines.json" "${wfs}pipelines"
curl -fsSL -A "$UA" -o "$work/ports.json" "${wfs}portlocations"

echo "Power cables, OpenStreetMap ..."
query='[out:json][timeout:120];way["power"="cable"]["location"~"underwater|submarine"](53,9,67,33);out tags geom;'
got=
for api in https://overpass-api.de/api/interpreter https://maps.mail.ru/osm/tools/overpass/api/interpreter \
           https://overpass.kumi.systems/api/interpreter; do
  if curl -fsS -A "$UA" -m 180 --data-urlencode "data=$query" -o "$work/power.json" "$api" \
     && grep -q '"elements"' "$work/power.json"; then
    got=$api
    break
  fi
  echo "  $api did not answer" >&2
done
[ -n "$got" ] || { echo "No Overpass server answered" >&2; exit 1; }

mkdir "$work/out"
(cd "$work/out" && "$work/duckdb" -bail "$work/build.db" \
  -c "SET VARIABLE dir = '$work'" \
  -c ".read '$here/build.sql'")

# Replaced by a rename: a reader never sees half a file.
for f in $FILES; do
  cp "$work/out/$f.parquet" "./.$f.parquet.tmp"
  chmod a+r "./.$f.parquet.tmp"
  mv "./.$f.parquet.tmp" "./$f.parquet"
done
ls -l ./*.parquet
