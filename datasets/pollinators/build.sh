#!/bin/sh
# Builds what who-visits-whom draws: animals seen visiting or pollinating flowers, from Global
# Biotic Interactions (GloBI), at its snapshot of 10 September 2026 on Zenodo (CC0:
# doi.org/10.5281/zenodo.22691479).
#
#   visits.parquet    one row per place (to 0.01°, about 1 km), visitor, plant and month, with
#                     the records behind it, in numbers only: about 530,000 rows for 1.3 million
#                     records. A visitor is an animal of a pollinating group (bees, wasps and ants,
#                     hoverflies, other flies, butterflies and moths, beetles, other insects, birds,
#                     bats) recorded as pollinating or visiting the flowers of a plant, both named
#                     at least to the genus.
#   visitors.parquet  the visitors' numbers, names and groups.
#   plants.parquet    the plants' numbers, names and families.
#
# GloBI gathers hundreds of datasets, each under its own terms; the largest here are EuPPollNet
# (CC BY 4.0), iNaturalist (each observer's licence), GBIF-US bee collections, DoPI and CropPol.
# Only records with coordinates are kept. Names come as GloBI matched them: a few that resolve
# to something that is no flower visitor (a fish, a squirrel) fall outside the groups and out.
#
# interactions.parquet is 2.4 GB with 24 million interactions; DuckDB reads only the 95 of its
# 198 row groups that hold flower visits, and only 14 columns, one group at a time with retries:
# Zenodo answers parallel range reads with HTTP 429. About 25 minutes, nothing kept but the
# result. The gateway serves them at http://feeds/datasets/pollinators/; nothing to restart.
#
# Needs curl and unzip.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
GLOBI=https://zenodo.org/records/22691479/files/interactions.parquet
TYPES="'pollinates', 'visitsFlowersOf', 'pollinatedBy', 'flowersVisitedBy'"
COLUMNS="sourceTaxonSpeciesName, sourceTaxonGenusName, sourceTaxonFamilyName, sourceTaxonOrderName, sourceTaxonClassName,
  targetTaxonSpeciesName, targetTaxonGenusName, targetTaxonFamilyName, targetTaxonKingdomName,
  interactionTypeName, decimalLatitude, decimalLongitude, eventDate, sourceNamespace"
POLITE="SET threads = 4; SET http_retries = 12; SET http_retry_wait_ms = 3000; SET http_retry_backoff = 2;"

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
duckdb() { (cd "$work" && "$work/duckdb" -bail -c "$POLITE $1" < /dev/null); }

# The row groups that hold flower visits, with the first and last row of each: the interaction
# type is the only column read.
echo "GloBI: the row groups with flower visits ..."
duckdb "COPY (
  WITH g AS (SELECT row_group_id AS rg, any_value(row_group_num_rows) AS n FROM parquet_metadata('$GLOBI') GROUP BY ALL),
  s AS (SELECT rg, sum(n) OVER (ORDER BY rg) - n AS lo, sum(n) OVER (ORDER BY rg) AS hi FROM g),
  v AS (SELECT file_row_number AS f FROM read_parquet('$GLOBI', file_row_number = true) WHERE interactionTypeName IN ($TYPES))
  SELECT s.rg, s.lo, s.hi FROM v JOIN s ON v.f >= s.lo AND v.f < s.hi GROUP BY ALL ORDER BY s.rg
) TO 'groups.csv' (HEADER false)"

# Each group on its own, so a refusal costs one group and a retry, not the whole read: DuckDB
# skips the row groups outside the file_row_number range.
mkdir "$work/parts"
total=$(wc -l < "$work/groups.csv")
i=0
while IFS=, read -r rg lo hi; do
  i=$((i + 1))
  for try in 1 2 3 4 5; do
    if duckdb "COPY (SELECT $COLUMNS FROM read_parquet('$GLOBI', file_row_number = true)
        WHERE file_row_number >= $lo AND file_row_number < $hi AND interactionTypeName IN ($TYPES))
      TO 'parts/rg-$rg.parquet' (FORMAT parquet, COMPRESSION zstd)" >/dev/null; then
      break
    fi
    [ "$try" = 5 ] && { echo "row group $rg failed 5 times" >&2; exit 1; }
    sleep $((try * 30))
  done
  echo "  $i/$total"
done < "$work/groups.csv"

echo "Flower visits ..."
(cd "$work" && "$work/duckdb" -bail -c ".read '$here/build.sql'" < /dev/null)
for f in visits.parquet visitors.parquet plants.parquet; do
  mv "$work/$f" "$here/$f.tmp" && mv "$here/$f.tmp" "$here/$f"
done
echo "Done: $(ls "$here"/*.parquet | wc -l) files in $here"
