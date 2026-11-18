#!/bin/sh
# Builds the files the schependomlaan-4d dashboard reads: a 2015 apartment
# block in Nijmegen as an IFC model with its construction schedule, from the
# public Dataset Schependomlaan (TU Eindhoven, Hendriks Bouw en Ontwikkeling,
# ROOT, TNO, RAAMAC; CC BY 4.0). Downloads the as-planned IFC (65 MB) and the
# planned and as-built event logs, and leaves here, in
# datasets/schependomlaan/:
#
#   model.glb      the model, one glTF node per IFC element named by its
#                  GlobalId (about 10 MB). The gateway serves it to browsers
#                  at /datasets/schependomlaan/model.glb for Kepler Plus's
#                  4D Model layer.
#   parts.parquet  one row per element: its first task, the span of its
#                  tasks, its kind, and whether the as-built log has it late.
#   tasks.parquet  one row per task: its span and how many elements it builds.
#
# The Parquet files are read by Grafana's DuckDB at
# http://feeds/datasets/schependomlaan/. Nothing to restart afterwards; the
# source does not change, so one run is enough.
#
# Needs curl and python3 (3.10 or later) with venv: IfcOpenShell, NumPy and
# DuckDB are installed into a throwaway environment.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
SOURCE=https://raw.githubusercontent.com/openBIMstandards/Archive-DataSetSchependomlaan/master
FILES='model.glb parts.parquet tasks.parquet'

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/src" "$work/out"

echo "Dataset Schependomlaan ..."
curl -fsSL -o "$work/src/planned.ifc" "$SOURCE/As%20Planned%20models/IFC%20Schependomlaan%20incl%20planningsdata.ifc"
curl -fsSL -o "$work/src/eventlog_planned.csv" "$SOURCE/Event%20log/Eventlog%20As%20Planned/eventlog%20IFC%20schependomlaan.csv"
curl -fsSL -o "$work/src/eventlog_asbuilt.csv" "$SOURCE/Event%20log/Eventlog%20with%20As%20Built%20information/Schependomlaan%20eventlog%20as%20planned%20data%20incl%20as%20built%20data.csv"
# The IFC is a Git LFS object: a pointer instead of the model means the
# source moved.
head -c 15 "$work/src/planned.ifc" | grep -q 'ISO-10303-21' || { echo "planned.ifc is not an IFC" >&2; exit 1; }

echo "IfcOpenShell ..."
python3 -m venv "$work/venv"
"$work/venv/bin/pip" install -q 'ifcopenshell==0.9.0.post1' 'numpy<3' 'duckdb==1.5.4'

echo "Model and schedule ..."
"$work/venv/bin/python" -I "$here/build.py" "$work/src" "$work/out"

# Replaced by a rename: a reader never sees half a file.
for f in $FILES; do
  cp "$work/out/$f" "./.$f.tmp"
  chmod a+r "./.$f.tmp"
  mv "./.$f.tmp" "./$f"
done
ls -l $FILES
