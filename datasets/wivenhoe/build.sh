#!/bin/sh
# Builds the files the wivenhoe-pumped-hydro dashboard draws: Wivenhoe Power
# Station (Queensland, a pumped storage station of two 285 MW reversible units)
# as two schematic 3D models whose parts are named by unit, and the tables that
# place the units, the parts, the floors and the water's way.
#
# Downloads OpenStreetMap's data around the station (one call to the OSM API,
# about 1 MB; © OpenStreetMap contributors, ODbL): the machine hall, its two
# transformer bays, the two intake towers in Splityard Creek Dam and the two
# underground pipelines between them. Then build.py, in a Python container,
# draws the rest from the station's public description (two concrete silos of
# about 32 m internal diameter, one unit in each) and leaves here, in
# datasets/wivenhoe/:
#
#   station.glb    the hall, the silos and their machines; and intakes.glb, the
#   intakes.glb    intake towers up the hill. The gateway serves both to
#                  browsers at /datasets/wivenhoe/ for Kepler Plus's 4D Model.
#   units.parquet  the two units: AEMO's ids for generating and pumping, ratings,
#                  where each silo stands, both models' origins.
#   parts.parquet  every part named in the models: its unit, what it is, its
#                  floor, its model.
#   floors.parquet the floors for the map's floor picker: the ground over the
#                  station, and each silo's three round its machine pit.
#   penstocks.parquet  each penstock down the hill, in longitude and latitude.
#   station-water.parquet  each unit's water path through the station (shaft,
#                  valve, turbine, draft tube, outlet) in the station's metres.
#
# The readings are not here: the recorder keeps AEMO's five-minute SCADA
# (Pacha's recorder/feeds/aemo-scada.sql). A few seconds; nothing to restart
# afterwards.
#
# Needs curl and docker.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
BBOX='152.625,-27.385,152.665,-27.355'
UA='pacha-dataset-build'
PYTHON_IMAGE='python:3.12-slim'
PACKAGES='duckdb==1.5.4 numpy==2.3.4 mapbox_earcut==1.0.3'
FILES='station.glb intakes.glb units.parquet parts.parquet floors.parquet penstocks.parquet station-water.parquet'

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/out"

echo "OpenStreetMap around the station ..."
curl -fsSL -A "$UA" -o "$work/osm.json" "https://api.openstreetmap.org/api/0.6/map.json?bbox=$BBOX"

echo "Model and tables ..."
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$work:/work" -v "$here:/src:ro" "$PYTHON_IMAGE" sh -eu -c "
    pip install -q --disable-pip-version-check --target /tmp/py $PACKAGES
    PYTHONPATH=/tmp/py python -P -s /src/build.py /work/osm.json /work/out"

# Replaced by a rename: a reader never sees half a file.
for f in $FILES; do
  cp "$work/out/$f" "./.$f.tmp"
  chmod a+r "./.$f.tmp"
  mv "./.$f.tmp" "./$f"
done
ls -l $FILES
