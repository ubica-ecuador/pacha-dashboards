#!/bin/sh
# Portoviejo centre, sky view, sun hours and midday shade on the ground, roofs and every wall panel, baseline and a
# street-tree scenario on calle Chile, for dashboard portoviejo-clima-prueba (prueba DIGI-GADS, desechable).
#   prep.py     Overture buildings (heights: OSM, else GHSL Built-H 100 m), Meta/WRI canopy, street trees -> 1 m DSMs
#   compute.py  horizon at 72 azimuths -> suelo-<var>-<esc>.tif (float COGs) and superficies.parquet (one row per face)
#   summary.py  means over calle Chile and the whole area -> resumen.parquet, calle.parquet
#   paint.py    the classes the dashboard draws -> pintado-<set>.tif, cityjson/<set>_t_<ix>_<iy>.json, tiles.parquet
# Needs python with numpy, rasterio, duckdb, shapely, pyproj ($PY), and GHSL's tile R10_C10 of
# GHS_BUILT_H_ANBH_E2018_GLOBE_R2023A_54009_100 ($GHSL). About 40 minutes, most of it the walls of compute.py.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
export WORK=${WORK:-$(mktemp -d)} OUT=$here
PY=${PY:-python3}
$PY -I "$here/prep.py"
$PY -I "$here/compute.py"
$PY -I "$here/summary.py"
$PY -I "$here/paint.py"
