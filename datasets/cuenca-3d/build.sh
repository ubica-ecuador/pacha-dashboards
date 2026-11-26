#!/bin/sh
# Cuenca, Ecuador, building by building for Kepler Plus's City Model (dashboard cuenca-3d-tiles): footprints, heights,
# roofs and walls from open data, the centre's churches and the fronts round its squares. The area: WEST SOUTH EAST
# NORTH (default the urban area, about 208,000 buildings; roofs take some 75 minutes).
#   step1.sql  Overture 2026-11-18 buildings in the box, heights: OSM height, floors x 3 m, median of measured within 80 m, 6 m
#   pixels.py  Sentinel-2 L2A TCI over the box, 2024-09-12 filled from 2023-08-24 etc. where SCL says cloud, one row per 10 m pixel
#   step2.sql  each building's mean pixel colour (pixels inside, else the one under its centroid)
#   step3a.sql roof tone classes, footprints in UTM -> roofin.csv
#   roofs.py   hipped roofs (straight skeleton by mitred insets) over clay tile, PITCH degrees -> roofs.csv
#   step3b.sql flat roofs elsewhere, one wall per edge up to the eave, as POLYGON Z (WGS84, m) -> surfaces-base.parquet
#   landmarks.py the churches of landmarks.json (nave, towers, domes) from their OSM ways -> landmarks.csv
#   arcades.py the fronts of the houses facing the centre's squares (portals, windows, balconies) -> arcades.csv
#   lift.py    the arcaded houses raised to their taller floors -> surfaces-lifted.parquet
#   step3c.sql the arcades in place of those plain walls, the landmarks in place of the generic blocks -> surfaces.parquet
#   tiles.py   surfaces.parquet as CityJSON tiles (cells of ~550 m, colours as materials) -> cityjson/, tiles.parquet
# The map reads tiles.parquet (one row per tile: file and box) and fetches the tiles in view from the gateway
# (/datasets/cuenca-3d/cityjson/, which gzips them on the way); the panels' figures read surfaces.parquet.
# Runs in the stack's own images (recorder: python duckdb; titiler: rasterio). Work files in $WORK.
set -eu
export WEST=${WEST:--79.08} SOUTH=${SOUTH:--2.95} EAST=${EAST:--78.92} NORTH=${NORTH:--2.84}
here=$(cd "$(dirname "$0")" && pwd)
WORK=${WORK:-$(mktemp -d)}
run() { docker run --rm --entrypoint python -e WEST -e SOUTH -e EAST -e NORTH -v "$here":/build:ro -v "$WORK":/work "$1" "/build/$2" ${3:+/build/$3}; }
run ghcr.io/ubica-ecuador/pacha-recorder:dev run.py step1.sql
run ghcr.io/ubica-ecuador/pacha-titiler:dev pixels.py
run ghcr.io/ubica-ecuador/pacha-recorder:dev run.py step2.sql
run ghcr.io/ubica-ecuador/pacha-recorder:dev run.py step3a.sql
docker run --rm --entrypoint python -v "$here":/build:ro -v "$WORK":/work ghcr.io/ubica-ecuador/pacha-titiler:dev /build/roofs.py "${PITCH:-27}"
run ghcr.io/ubica-ecuador/pacha-recorder:dev run.py step3b.sql
docker run --rm --entrypoint python -v "$here":/build:ro -v "$WORK":/work ghcr.io/ubica-ecuador/pacha-titiler:dev /build/landmarks.py
docker run --rm --entrypoint python -v "$here":/build:ro -v "$WORK":/work ghcr.io/ubica-ecuador/pacha-titiler:dev /build/arcades.py
docker run --rm --entrypoint python -v "$here":/build:ro -v "$WORK":/work ghcr.io/ubica-ecuador/pacha-recorder:dev /build/lift.py
run ghcr.io/ubica-ecuador/pacha-recorder:dev run.py step3c.sql
cp "$WORK/surfaces.parquet" "$here/surfaces.parquet.tmp" && mv "$here/surfaces.parquet.tmp" "$here/surfaces.parquet"
docker run --rm --entrypoint python -v "$here":/build:ro -v "$WORK":/work ghcr.io/ubica-ecuador/pacha-recorder:dev /build/tiles.py
mkdir -p "$here/cityjson" && cp "$WORK"/cityjson/*.json "$here/cityjson/"
cp "$WORK/tiles.parquet" "$here/tiles.parquet.tmp" && mv "$here/tiles.parquet.tmp" "$here/tiles.parquet"
