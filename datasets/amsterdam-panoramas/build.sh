#!/bin/sh
# Builds what amsterdam-panoramas-lidar draws: Dam Square and the streets round it, 450 m a side,
# as the city's street-level panoramas, the national LiDAR survey and the city's own registers.
#
#   panoramas.parquet  every 360° panorama the City of Amsterdam took in the box (about 11,600,
#                      2016 to 2025): its id, when, where, the car's heading, and the addresses of
#                      its equirectangular picture (2,000 and 4,000 px wide, north in the middle,
#                      faces and plates blurred), read by the browser from the city, never stored
#                      here; and the ground under it, from the LiDAR.
#   trees.parquet      the city's trees in the box: species, height class, year planted, and the
#                      height the LiDAR measures over the ground round the trunk.
#   buildings.parquet  BAG's buildings in the box: footprint, year built, the height the LiDAR
#                      measures (90th percentile of the roof over the ground beside it), and the
#                      monument's name and status where one stands on most of the footprint.
#   lidar/             the LiDAR as a 3D Tiles point cloud (tileset.json and .pnts tiles, about
#                      4 million points), coloured from the aerial photograph, the street at
#                      height 0, for the map's tile3d layer; the gateway serves it to browsers at
#                      /datasets/amsterdam-panoramas/lidar/tileset.json.
#   meta.parquet       when this was built, the box, and the street level the heights start from.
#
# Reads: the panorama API (12 pages of 1,000, a second apart), the city's API for trees,
# buildings and monuments, only the box of AHN5's 1 km COPC tile 121000_487000 (by HTTP ranges,
# not the whole 179 MB), and one 1,800 px aerial photograph from PDOK. Then build.py, in a Python
# container. About two minutes; nothing to restart afterwards: the gateway serves the tiles as
# they are written (Pacha a9ce8ed and later). The panoramas grow by a mission a year: run it again
# to follow them.
#
# The data: Gemeente Amsterdam, Panoramabeelden (CC BY 4.0, as data.overheid.nl lists it), and its
# registers of trees (bomen), buildings (BAG) and monuments (monumenten) at api.data.amsterdam.nl,
# published as public ("openbaar") with no licence named beyond that; AHN5 (Actueel Hoogtebestand
# Nederland, CC0); Beeldmateriaal Nederland / Kadaster, Luchtfoto Actueel Ortho through PDOK
# (opendata.beeldmateriaal.nl, CC BY 4.0).
#
# Needs docker.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
PYTHON_IMAGE='python:3.12-slim'
PACKAGES='duckdb==1.5.4 shapely==2.2.0 numpy==2.5.4 pyproj==3.7.2 laspy[lazrs]==2.6.1 requests==2.32.5 pillow==12.0.0'

# KEEP=<dir> keeps the downloads there, and reuses them on the next run.
if [ -n "${KEEP:-}" ]; then
  work=$KEEP
  mkdir -p "$work"
else
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
fi

echo "Panoramas, trees, buildings, monuments, LiDAR and the aerial photograph ..."
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$work:/work" -v "$here:/out" "$PYTHON_IMAGE" sh -eu -c "
    pip install -q --disable-pip-version-check --target /tmp/py $PACKAGES
    PYTHONPATH=/tmp/py python -P -s /out/build.py /work /out"
ls -l "$here"/*.parquet "$here"/lidar/tileset.json
