#!/bin/sh
# Builds what the cyclone-clouds-3d dashboard draws: Super Typhoon In-fa in one
# ECMWF forecast run (IFS, 0.25 degree, Open Data, 29 October 2026 at 18 UTC),
# every six hours to two days ahead:
#
#   clouds.parquet   relative humidity on eleven pressure levels (1000 to
#                    150 hPa), every cell and level at 60 % or more, in a box
#                    around the storm (5-42 N, 122-168 E)
#   centres.parquet  the storm's eye at each step: the model's lowest sea-level
#                    pressure near its track (10-30 N, 135-160 E)
#
# ECMWF publishes GRIB2, which DuckDB does not read: a Python container with
# ecmwf-opendata, eccodes and xarray downloads the two fields (some 45 MB, from
# the first of the open data's copies on Azure, Google, AWS or ECMWF's portal
# that answers: the cloud copies keep past runs) and writes the Parquet.
# The files land here, in datasets/cyclone-clouds/, which the gateway serves at
# http://feeds/datasets/cyclone-clouds/. Nothing to restart afterwards.
#
# The data: ECMWF Open Data, CC BY 4.0.
#
# Needs docker (DOCKER, `sg docker -c` where the shell predates the group).
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DOCKER=${DOCKER:-docker}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
chmod a+rwx "$work"

$DOCKER run --rm -v "$here/build.py:/build.py:ro" -v "$work:/work" -v "$work:/out" \
  -e RUN_DATE=2026-10-29 -e RUN_TIME=18 -e SOURCES="${SOURCES:-azure google aws ecmwf}" \
  -e SOUTH=5 -e NORTH=42 -e WEST=122 -e EAST=168 \
  -e EYE_SOUTH=10 -e EYE_NORTH=30 -e EYE_WEST=135 -e EYE_EAST=160 \
  python:3.12-slim sh -c 'pip install -q --root-user-action=ignore ecmwf-opendata eccodes cfgrib xarray pandas pyarrow && python -I /build.py'

# Replaced by a rename: a reader never sees half a file.
for f in clouds centres; do
  cp "$work/$f.parquet" "./.$f.parquet.tmp"
  chmod a+r "./.$f.parquet.tmp"
  mv "./.$f.parquet.tmp" "./$f.parquet"
done
ls -l ./*.parquet
