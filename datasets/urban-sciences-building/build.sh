#!/bin/sh
# Builds the plan the urban-sciences-building dashboard draws: Newcastle
# University's Urban Sciences Building room by room on its seven floors, the
# internal walls, and which BMS point measures which room. The readings
# themselves are live: the recorder keeps them (recorder/feeds/
# urban-sciences-building.sql), and points.parquet ties them to the rooms.
#
# Downloads, from the Urban Observatory: its 3D viewer's page and script (the
# room points), two of its models (floor finishes and slabs, 3.7 MB; internal
# walls, 14 MB), and the REST API's entities (about 7 pages, 8 s apart: the API
# refuses a client after some 50 quick requests). Then build.py, in a Python
# container, turns them into rooms, floors, walls, points and stream-empty
# .parquet here, in datasets/urban-sciences-building/, which the gateway serves
# at http://feeds/datasets/urban-sciences-building/. About two minutes; nothing
# to restart afterwards. Run it again when the API's rooms or sensors change.
#
# The data: Urban Observatory, Newcastle University, CC BY 4.0
# (https://urbanobservatory.ac.uk). The models are the ones its public viewer
# (https://3d.usb.urbanobservatory.ac.uk) loads; only the plan derived from them
# is kept.
#
# Needs curl and docker.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
VIEWER='https://3d.usb.urbanobservatory.ac.uk'
API='https://api.usb.urbanobservatory.ac.uk/api/v2/sensors/entity?pageSize=100'
UA='pacha-dataset-build'
PYTHON_IMAGE='python:3.12-slim'
PACKAGES='duckdb==1.5.4 shapely==2.2.0 numpy==2.5.4'

# KEEP=<dir> keeps the downloads there, and reuses them on the next run.
if [ -n "${KEEP:-}" ]; then
  work=$KEEP
  mkdir -p "$work"
else
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
fi

if [ ! -s "$work/walls-internal.json" ] || [ ! -s "$work/entities-001.json" ]; then
echo "The 3D viewer ..."
curl -fsSL -A "$UA" -o "$work/index.html" "$VIEWER/"
app=$(grep -o 'app\.[0-9a-f]*\.js' "$work/index.html" | head -1)
[ -n "$app" ] || { echo "No app script on $VIEWER/" >&2; exit 1; }
curl -fsSL -A "$UA" -o "$work/app.js" "$VIEWER/$app"
curl -fsSL -A "$UA" -o "$work/flooring.json" "$VIEWER/resources/usb-architectural-flooring.json"
curl -fsSL -A "$UA" -o "$work/walls-internal.json" "$VIEWER/resources/usb-architectural-walls-internal.json"

echo "The API's entities ..."
page=1
pages=1
while [ "$page" -le "$pages" ]; do
  [ "$page" -gt 1 ] && sleep 8
  curl -fsSL -A "$UA" -o "$work/entities-$(printf %03d "$page").json" "$API&page=$page"
  if [ "$page" -eq 1 ]; then
    pages=$(grep -o '"pageCount": *[0-9]*' "$work/entities-001.json" | grep -o '[0-9]*$')
    echo "  $pages pages"
  fi
  page=$((page + 1))
done
fi

echo "Rooms, floors, walls and points ..."
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$work:/work:ro" -v "$here:/out" "$PYTHON_IMAGE" sh -eu -c "
    pip install -q --disable-pip-version-check --target /tmp/py $PACKAGES
    PYTHONPATH=/tmp/py python -P -s /out/build.py /work /out"
ls -l "$here"/*.parquet
