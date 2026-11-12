#!/bin/sh
# Builds the files the wivenhoe-pumped-hydro dashboard draws: Wivenhoe Power
# Station (Queensland, a pumped storage station of two 285 MW reversible units)
# as a schematic 3D model whose parts are named by unit, and the tables that
# place the units, the parts and the water's path.
#
# Downloads OpenStreetMap's data around the station (one call to the OSM API,
# about 1 MB; © OpenStreetMap contributors, ODbL): the machine hall, its two
# transformer bays, the two intake towers in Splityard Creek Dam and the two
# underground pipelines between them. Then build.py, in a Python container,
# draws the rest from the station's public description (two concrete silos of
# about 32 m internal diameter, one unit in each) and leaves here, in
# datasets/wivenhoe/:
#
#   model.glb      the model; the gateway serves it to browsers at
#                  /datasets/wivenhoe/model.glb for Kepler Plus's 4D Model layer.
#   units.parquet  the two units: AEMO's ids for generating and pumping, ratings,
#                  where each silo stands, the model's origin.
#   parts.parquet  every part named in the model: its unit, what it is, its floor.
#   floors.parquet the floors for the map's floor picker: the ground over the
#                  station, and each silo's three round its machine pit.
#   water.parquet  each unit's water path (intake, penstock, valve, turbine,
#                  draft tube, outlet) in the model's metres, for a Pipeline layer.
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
FILES='model.glb units.parquet parts.parquet water.parquet floors.parquet'

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
