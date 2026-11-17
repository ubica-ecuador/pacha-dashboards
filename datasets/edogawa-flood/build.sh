#!/bin/sh
# Builds what edogawa-flood draws: Edogawa, Tokyo, building by building, with the water PLATEAU expects at each.
#
#   cityjson/m<mesh>.json  PLATEAU's buildings of each 1 km tile (62 tiles, JIS third-level meshes) as CityJSON 2.0:
#                      every building's LoD 1 block and, where PLATEAU has it, its LoD 2 model, in JGD2011
#                      (EPSG:6697, latitude first), each with the attributes the map shows on hover (key, storeys,
#                      height_m, usage, depth_l1_m, depth_l2_m, days_l2, depth_surge_m). Served to browsers by the gateway at
#                      /datasets/edogawa-flood/cityjson/m<mesh>.json for Kepler Plus's City Model layer.
#   buildings.parquet  one row per building (144,788): key, gml_id, tile, centre, storeys, height, use, footprint.
#   flood.parquet      one row per building, river and scenario PLATEAU maps it under water: depth (m), band
#                      (PLATEAU's ranks: under 0.5 m, 0.5 to 3, 3 to 5, 5 to 10) and hours the water stays; the
#                      scenarios L1 and L2 of the river studies, and Surge, Tokyo's storm surge study (2018).
#   tiles.parquet      each tile's box and how many buildings have their centre in it.
#   shelters.parquet   the ward's 163 shelters and evacuation areas, with the water expected round each.
#   border.parquet     the ward's border (WKT).
#   meta.parquet       when this was built, from what.
#
# The data: PLATEAU, Japan's 3D city models by the Ministry of Land, Infrastructure, Transport and Tourism (MLIT):
# Edogawa-ku FY2023, CityGML v4 (www.geospatial.jp, dataset plateau-13123-edogawa-ku-2023; free for any use with
# credit, PLATEAU's site policy, compatible with CC BY 4.0). Flateau, PLATEAU's attributes as tables, by Pacific
# Spatial Solutions (CC BY 4.0, source.coop/pacificspatial/flateau): its gml_id is the CityGML's own.
#
# The CityGML zip is 578 MB with every theme of the ward; plateau.py reads its index and then each building tile
# alone by HTTP ranges (84 MB of GML at most), citygml-tools turns a batch into CityJSON (keeping 7 decimals:
# its default 3 would move a corner by up to 100 m in degrees) and plateau.py lightens each file and gives its
# buildings their attributes. citygml-tools leaves PLATEAU's own attributes (its i-UR extension) out: they come
# from Flateau. About 400 MB on disk when done, never more than a batch of GML on the way.
#
# Needs docker. About ten minutes; nothing to restart afterwards.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
PYTHON_IMAGE='python:3.12-slim'
CITYGML_TOOLS='citygml4j/citygml-tools:2.5.0'
PACKAGES='duckdb==1.5.6'
CITYGML_ZIP='https://assets.cms.plateau.reearth.io/assets/92/28e36f-472f-42dc-8d9c-67348e3a7261/13123_edogawa-ku_pref_2023_citygml_2_op.zip'
RELATED_ZIP='https://assets.cms.plateau.reearth.io/assets/30/84c353-f07c-449a-848a-b7d07c93de8f/13123_edogawa-ku_2023_related.zip'
BATCH=6

# KEEP=<dir> keeps the work files there, and reuses them on the next run.
if [ -n "${KEEP:-}" ]; then
  work=$KEEP
  mkdir -p "$work"
else
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
fi
py() {
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$work:/work" -v "$here:/out" "$PYTHON_IMAGE" "$@"
}

echo "The building tiles in PLATEAU's zip, and its related data ..."
py python -I /out/plateau.py list "$CITYGML_ZIP" /work/tiles.txt
[ -s "$work/related.zip" ] || curl -fsS -o "$work/related.zip" "$RELATED_ZIP"
py python -I -c "import zipfile; zipfile.ZipFile('/work/related.zip').extractall('/work')"

echo "Flateau's buildings and floods ..."
py sh -eu -c "
  pip install -q --disable-pip-version-check --target /tmp/py $PACKAGES
  PYTHONPATH=/tmp/py python -P -s /out/build.py /out /work"

echo "CityGML to CityJSON, $BATCH tiles at a time ..."
mkdir -p "$here/cityjson" "$work/gml" "$work/cj"
todo=$(while read -r mesh entry; do [ -s "$here/cityjson/m$mesh.json" ] || echo "$mesh $entry"; done < "$work/tiles.txt")
echo "$todo" | grep . | awk -v n="$BATCH" '{ printf "%s%s", $2, (NR % n ? " " : "\n") } END { if (NR % n) print "" }' |
while read -r entries; do
  rm -f "$work"/gml/* "$work"/cj/*
  # shellcheck disable=SC2086
  py python -I /out/plateau.py extract "$CITYGML_ZIP" /work/gml $entries
  docker run --rm --user "$(id -u):$(id -g)" -v "$work:/data" "$CITYGML_TOOLS" \
    to-cityjson -v 2.0 -e 6697 --vertex-precision 7 -o /data/cj /data/gml > /dev/null
  for f in "$work"/cj/*.json; do
    mesh=$(basename "$f" .json)
    py python -I /out/plateau.py inject /work/attrs.json "/work/cj/$mesh.json" "/out/cityjson/m$mesh.json"
  done
done
rm -rf "$work/gml" "$work/cj"
# The attributes again on every tile, so a rebuild of the tables reaches the tiles made before.
py python -I /out/plateau.py attrs /work/attrs.json /out/cityjson
ls "$here"/cityjson | wc -l
du -sh "$here/cityjson"
ls -l "$here"/*.parquet
