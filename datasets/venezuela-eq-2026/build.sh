#!/bin/sh
# Builds what venezuela-earthquake-osm draws: how OpenStreetMap mapped Caracas and La Guaira after
# the earthquakes of 24 June 2026, what the satellites saw before and after, and where the damage was.
# The box is 67.35° W to 66.55° W, 10.35° N to 10.70° N: Caracas, El Junquito, Catia La Mar, La Guaira,
# Caraballeda and Naiguatá.
#
#   osm_changes.parquet   every building (a way tagged building=*) that OSM added to or deleted from the
#                         box, from its full history (October 2007) to 27 July 2026, through the ohsome
#                         API (HeiGIT): osm_id, time (UTC), kind (creation or deletion), latitude and
#                         longitude of its centroid, hex (H3 resolution 9, about 0.09 km²) and changeset.
#                         The buildings OSM had on a day are the creations before it less the deletions.
#                         ohsome's history ends on 27 July 2026, so the build stops there. About 200,000
#                         rows. © OpenStreetMap contributors, ODbL.
#   damage_cells.parquet  HOT's building damage areas, AI-detected on pre- and post-event imagery and
#                         reviewed by MapSwipe volunteers: one row per H3 cell (resolution 11, about
#                         1,800 m²) that volunteers accepted as damaged, with its area name, votes and the
#                         share that said damaged, its centre and its outline as GeoJSON. HDX dataset
#                         venezuela-m-7-5-earthquake-building-damage-assessment (HOT).
#   damage_points.parquet the damage HOT's field volunteers reported (ChatMap): latitude, longitude, level
#                         (complete, significant, minimal) and a name when given. Same dataset.
#   scenes.parquet        the event's open imagery from Vantor (Maxar), its STAC collection
#                         Venezuela-Earthquake-Jun-2026: id, phase (pre or post), time, cloud cover,
#                         ground sample distance, off-nadir angle, footprint box and the COG's URL
#                         (raster_url), which Pacha's tile server reads from S3. CC BY-NC 4.0.
#
# ohsome answers one box at a time: the box goes as 0.1° tiles, and a building crossing a tile edge
# comes back from both, so build.sql keeps one row per change. The gateway serves the files at
# http://feeds/datasets/venezuela-eq-2026/; nothing to restart.
#
# Needs curl and unzip; DuckDB installs its spatial and h3 extensions the first time.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
OHSOME=https://api.ohsome.org/v1
HDX=https://data.humdata.org/dataset/96d4c883-4e65-44fe-80b8-9ca709c91ca6/resource
STAC=https://vantor-opendata.s3.amazonaws.com/events/Venezuela-Earthquake-Jun-2026
FILTER='building%3D*%20and%20type%3Away'

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

# ohsome, tile by tile (a failed tile is retried; a second failure stops the build)
fetch() {
  curl -fsS --retry 3 --retry-delay 10 -m 600 -o "$2" "$1" || { echo "ohsome failed: $1" >&2; exit 1; }
}
mkdir -p "$work/changes"
i=0
for x in -67.35 -67.25 -67.15 -67.05 -66.95 -66.85 -66.75 -66.65; do
  for y in 10.35 10.45 10.55 10.65; do
    i=$((i + 1))
    box=$(awk -v x="$x" -v y="$y" 'BEGIN { t = y + 0.1; if (t > 10.70) t = 10.70; printf "%.2f,%.2f,%.2f,%.2f", x, y, x + 0.1, t }')
    echo "ohsome tile $i/32 ($box) ..."
    fetch "$OHSOME/contributions/centroid?bboxes=$box&filter=$FILTER&time=2007-10-08,2026-07-27&properties=metadata,contributionTypes" "$work/changes/$i.geojson"
  done
done

echo "HOT damage (HDX) ..."
curl -fsSL -o "$work/damage_cells.geojson" "$HDX/747503eb-5e2d-4660-9190-19ec19142732/download/venezuela_validated_accepted.geojson"
curl -fsSL -o "$work/damage_points.geojson" "$HDX/89df1b21-e40e-417f-9fe2-118e98e77140/download/damage_points.geojson"

echo "Vantor STAC ..."
curl -fsSL -o "$work/collection.json" "$STAC/collection.json"
mkdir -p "$work/items"
for id in $(grep -o '"href": *"[^"]*/[A-Z0-9]*\.json"' "$work/collection.json" | sed 's#.*/\([A-Z0-9]*\)\.json"#\1#' | sort -u); do
  curl -fsSL -o "$work/items/$id.json" "$STAC/$id.json"
done

(cd "$work" && "$work/duckdb" -bail -c ".read '$here/build.sql'")

for f in osm_changes damage_cells damage_points scenes; do
  mv "$work/$f.parquet" "$here/$f.parquet.tmp" && mv "$here/$f.parquet.tmp" "$here/$f.parquet"
done
echo "Done: $(ls "$here"/*.parquet | wc -l) files in $here"
