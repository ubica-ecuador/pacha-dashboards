#!/bin/sh
# Builds the walks of the cuenca-10-minute-city dashboard, on R5's grid of
# Cuenca (Web Mercator, zoom 10, about 153 m across), every row placed in a
# cell by its column and row, px and py, as Pacha's datasets/cuenca-access:
#
#   needs.parquet  six daily needs, one row per place: food shops and markets,
#                  pharmacies, health centres and schools (LlactaLAB's land
#                  uses: the city's trade permits and its public facilities;
#                  pharmacies from Overture too), parks and stops as in
#                  cuenca-access's places.parquet
#   walk.parquet   one row per cell and need within a 15-minute walk: the
#                  cell's px and py, the need and the minutes to its nearest
#   hubs.parquet   for cuenca-10-minute-utopia, HUBS places with all six needs
#                  each, opened one by one where each brings all six within a
#                  10-minute walk to the most people (utopia.sql, hub.sql,
#                  plan.sql); gained.parquet, the cells each one brings them to
#
# R5 walks from each cell holding a need (about 2,300) to every cell around it,
# on flat ground at 1.3 m/s. On the flat a walk is as long one way as the
# other, so those 2,300 walks give the minutes from each of the 16,000 cells
# people live in to its nearest food shop, pharmacy, health centre, school,
# park and stop. iso-cuenca asks R5 for each walk and keeps it on disk: the
# first run takes about half an hour, the next a minute or two.
#
# Runs where the R5 instance of Cuenca runs (only pacha.ubica.dev), after
# Pacha's datasets/cuenca-access/build.sh (PACHA_DIR, ../pacha beside this
# repo), whose parks and stops it reads. iso-cuenca publishes no port, so
# walk.py runs inside its container (ISO_CONTAINER), PARALLEL walks at a time;
# three keep R5 as busy as a few visitors would. DATE is the service day
# iso-cuenca keys its answers by; a walk does not depend on it. RELEASE is an
# Overture Maps release. The files land here, served at
# http://feeds/datasets/cuenca-walk/. Nothing to restart afterwards.
#
# The data: LlactaLAB, Universidad de Cuenca; Overture Maps Foundation, ODbL;
# the GTFS of Cuenca's buses and tram; the walks, R5 (Conveyal) on
# OpenStreetMap.
#
# Needs curl, unzip and docker.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
RELEASE=${RELEASE:-2026-10-21.0}
PACHA_DIR=${PACHA_DIR:-$here/../../../pacha}
ISO_CONTAINER=${ISO_CONTAINER:-iso-cuenca}
PARALLEL=${PARALLEL:-3}
HUBS=${HUBS:-60}
DATE=${DATE:-2026-09-02}
LLACTALAB=https://appsllactalab.ucuenca.edu.ec/geoserver/geonode
places="$PACHA_DIR/datasets/cuenca-access/places.parquet"
population="$PACHA_DIR/datasets/cuenca-access/population.parquet"
for f in "$places" "$population"; do
  [ -f "$f" ] || { echo "$f is missing: run Pacha's datasets/cuenca-access/build.sh first" >&2; exit 1; }
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

case $(uname -m) in
  x86_64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "No DuckDB CLI for $(uname -m)" >&2; exit 1 ;;
esac
echo "DuckDB $DUCKDB_VERSION ..."
curl -fsSL -o "$work/duckdb.zip" "https://github.com/duckdb/duckdb/releases/download/v$DUCKDB_VERSION/duckdb_cli-linux-$arch.zip"
unzip -q "$work/duckdb.zip" -d "$work"

echo "Land uses, LlactaLAB ..."
curl -fsS -m 300 -G "$LLACTALAB/ll_usos_merged/ows" -o "$work/usos.geojson" \
  --data-urlencode service=WFS --data-urlencode version=2.0.0 --data-urlencode request=GetFeature \
  --data-urlencode typeNames=geonode:ll_usos_merged --data-urlencode outputFormat=application/json \
  --data-urlencode srsName=EPSG:4326

echo "Needs, with Overture $RELEASE ..."
mkdir "$work/out"
(cd "$work/out" && "$work/duckdb" -bail \
  -c "SET threads = 4; SET memory_limit = '2GB'; SET VARIABLE release = '$RELEASE';
      SET VARIABLE usos = '$work/usos.geojson'; SET VARIABLE places = '$places'" \
  -c ".read '$here/build.sql'")

# Each cell holding a need, from its centre: R5's cells are Web Mercator pixels.
"$work/duckdb" -c "COPY (
  SELECT DISTINCT px, py,
         round(degrees(atan(sinh(pi() * (1 - 2 * (py + 0.5) / 262144)))), 6) AS lat,
         round((px + 0.5) / 262144 * 360 - 180, 6) AS lon
  FROM '$work/out/needs.parquet' ORDER BY py, px
) TO '$work/cells.csv' (HEADER false)"
echo "Walks from $(wc -l < "$work/cells.csv") cells, through $ISO_CONTAINER ..."
docker exec -i -e PARALLEL="$PARALLEL" -e DATE="$DATE" "$ISO_CONTAINER" \
  python3 -c "$(cat "$here/walk.py")" < "$work/cells.csv" > "$work/raw.csv"
# The walks, then the hubs: hub.sql once per hub, in the same session.
for _ in $(seq "$HUBS"); do echo ".read '$here/hub.sql'"; done > "$work/hubs.sql"
echo "Walks and $HUBS hubs ..."
(cd "$work/out" && "$work/duckdb" -bail \
  -c "SET VARIABLE raw = '$work/raw.csv'; SET VARIABLE population = '$population'" \
  -c ".read '$here/walk.sql'" -c ".read '$here/utopia.sql'" -c ".read '$work/hubs.sql'" -c ".read '$here/plan.sql'")

# Replaced by a rename: a reader never sees half a file.
for f in needs walk hubs gained; do
  cp "$work/out/$f.parquet" "./.$f.parquet.tmp"
  chmod a+r "./.$f.parquet.tmp"
  mv "./.$f.parquet.tmp" "./$f.parquet"
done
ls -l ./*.parquet
