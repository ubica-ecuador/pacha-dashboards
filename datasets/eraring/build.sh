#!/bin/sh
# Builds the files the aemo-eraring-live dashboard draws: Eraring Power Station
# (New South Wales, 4 x 720 MW) as a schematic 3D model whose four units are
# parts named by their AEMO ids, and the units' table. The footprints come from
# Overture Maps (OpenStreetMap and Microsoft's buildings); the units, their
# houses and the two chimneys are drawn on the main block's footprint. Leaves
# here, in datasets/eraring/:
#
#   model.glb      about 1 MB; the gateway serves it to browsers at
#                  /datasets/eraring/model.glb for Kepler Plus's 4D Model layer.
#   units.parquet  the units, read by Grafana's DuckDB at
#                  http://feeds/datasets/eraring/units.parquet.
#
# The live readings are not here: the recorder keeps AEMO's five-minute SCADA
# (recorder/feeds/aemo-scada.sql). Nothing to restart afterwards; run it again
# for a newer Overture release (RELEASE in build.py).
#
# Needs python3 (3.10 or later) with venv: DuckDB, NumPy and mapbox_earcut are
# installed into a throwaway environment.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
FILES='model.glb units.parquet'

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/out"

echo "Python packages ..."
python3 -m venv "$work/venv"
"$work/venv/bin/pip" install -q 'duckdb==1.5.4' 'numpy<3' 'mapbox_earcut==1.0.3'

echo "Footprints and model ..."
"$work/venv/bin/python" -I "$here/build.py" "$work/out"

# Replaced by a rename: a reader never sees half a file.
for f in $FILES; do
  cp "$work/out/$f" "./.$f.tmp"
  chmod a+r "./.$f.tmp"
  mv "./.$f.tmp" "./$f"
done
ls -l $FILES
