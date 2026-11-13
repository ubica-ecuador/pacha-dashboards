#!/bin/sh
# Builds the files the dsn-now dashboard draws: NASA's Deep Space Network, its
# fifteen antennas at Goldstone, Madrid and Canberra, one 3D model per complex
# whose parts turn (azimuth, elevation) with the live feed.
#
# Downloads:
#   - NASA's 3D model of a 34 m DSN antenna (science.nasa.gov 3D resources, free
#     to use under NASA's media guidelines; about 3 MB), Draco-compressed;
#   - DSN Now's configuration (eyes.nasa.gov): the complexes, their antennas and
#     each antenna's type (70 m, 34 m);
#   - OpenStreetMap's data around each complex (three calls to the OSM API,
#     about 2 MB in all; © OpenStreetMap contributors, ODbL), where each antenna
#     (DSS-nn) stands.
# Then build.py, in a Python container, decodes the model's meshes and leaves
# here, in datasets/dsn-antennas/:
#
#   gdscc.glb, mdscc.glb, cdscc.glb
#                   each complex as one model: every antenna at its place
#                   around the complex's 70 m antenna (the model's origin), a 70 m
#                   one at twice the size, all facing north at rest, pointing at
#                   the zenith. Its parts are named <dish>.azimuth,
#                   <dish>.elevation, <dish>.dish and so on (DSS26.azimuth), so a
#                   reading turns <dish>.azimuth by its azimuth and tilts
#                   <dish>.elevation by its elevation (Kepler Plus's 4D Model,
#                   model_yaw and model_pitch). The gateway serves them to
#                   browsers at /datasets/dsn-antennas/<site>.glb.
#   dishes.parquet  the antennas: dish (DSS26), site (gdscc), its name, type and
#                   diameter, where it stands, and its model's origin.
#   recording-empty.parquet
#                   the recorder's dsn-now feed with no rows, which the dashboard
#                   reads beside the recording.
#
# The readings are not here: the dashboard reads DSN Now live through the
# gateway (/dsn/dsn.xml), and its history from the recorder's dsn-now feed
# (recorder/feeds/dsn-now.sql). A minute; nothing to restart afterwards.
#
# Needs curl and docker.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
UA='pacha-dataset-build'
MODEL='https://assets.science.nasa.gov/content/dam/science/cds/3d/resources/model/deep-space-network-34-meter/Deep%20Space%20Network%2034-meter.glb'
PYTHON_IMAGE='python:3.12-slim'
PACKAGES='duckdb==1.5.4 DracoPy==2.2.0'
FILES='gdscc.glb mdscc.glb cdscc.glb dishes.parquet recording-empty.parquet'

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/out"

echo "NASA's 34 m antenna ..."
curl -fsSL -A "$UA" -o "$work/dsn34.glb" "$MODEL"
echo "DSN Now's configuration ..."
curl -fsSL -A "$UA" -o "$work/config.xml" 'https://eyes.nasa.gov/dsn/config.xml'
# Each complex's antennas, with room around them (Goldstone's 70 m DSS-14 is
# some 10 km north of the Apollo site's 34 m antennas).
for site in 'gdscc -116.900,35.330,-116.860,35.432' 'mdscc -4.262,40.420,-4.238,40.440' \
  'cdscc 148.970,-35.410,148.992,-35.392'; do
  set -- $site
  echo "OpenStreetMap around $1 ..."
  curl -fsSL -A "$UA" -o "$work/osm-$1.json" "https://api.openstreetmap.org/api/0.6/map.json?bbox=$2"
  sleep 2
done

echo "Models and table ..."
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$work:/work" -v "$here:/src:ro" "$PYTHON_IMAGE" sh -eu -c "
    pip install -q --disable-pip-version-check --target /tmp/py $PACKAGES
    PYTHONPATH=/tmp/py python -P -s /src/build.py /work /work/out"

# Replaced by a rename: a reader never sees half a file.
for f in $FILES; do
  cp "$work/out/$f" "./.$f.tmp"
  chmod a+r "./.$f.tmp"
  mv "./.$f.tmp" "./$f"
done
ls -l $FILES
