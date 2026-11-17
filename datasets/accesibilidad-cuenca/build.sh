#!/bin/sh
# Builds what accesibilidad-cuenca draws: 37 COGs, one per category of urban
# opportunity in Cuenca, each pixel the minutes to the nearest one (P50 of a
# dual-accessibility study, capped at 120; 120 = no access), about 300 x 219 px,
# float32, EPSG:3857:
#
#   <slug>_<version>.tif   e.g. farmacia_v2.tif, the slug the dashboard's
#                          `categoria` variable carries
#
# The inputs are not published anywhere: they were handed over as files, one
# GeoTIFF per category (3eR_Dual_Subcat_1_Opport_unido, September 2026, named
# ..._e9xxxx_<key>_e9xxxx_P50_C1.dual.tif). Give their folder:
#
#   datasets/accesibilidad-cuenca/build.sh <folder> [version]
#
# The folder may also hold the COGs already built, named <slug>.tif (as
# keplergl-grafana-panel's testdata/make-accesibilidad.sh writes them): then
# they are copied as they are.
#
# This delivery marks a pixel with no access as 0; the first one marked it 120.
# Every 0 is a 120 of the old one and no pixel is 0 minutes from anything (the
# smallest real value is 1), so 0 goes back to 120: left as 0, the unreachable
# countryside would paint as the best-served place and count as "<= 15 min".
#
# The version is in the file name because Pacha's tile server keeps a COG's bytes
# in memory under its URL (VSI_CACHE): a new delivery under the same name would go
# on serving the old numbers until it restarts. A new delivery gets a new version
# here and in the dashboard's hidden `version` constant.
#
# The gateway serves the files at http://feeds/datasets/accesibilidad-cuenca/
# (gateway/datasets-tif.conf.template), to the tile server only. Nothing to
# restart afterwards.
#
# Needs docker (GDAL 3.11, ghcr.io/osgeo/gdal) for the raw delivery; nothing for
# built COGs.
set -eu
src=${1:?usage: $0 <folder with the source GeoTIFFs or the built COGs> [version]}
version=${2:-v2}
src=$(cd "$src" && pwd)
cd "$(dirname "$0")"
here=$(pwd)
GDAL_IMAGE=ghcr.io/osgeo/gdal:ubuntu-small-3.11.4

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# key (between the study's group hash and the category hash) and slug
cat > "$work/map" <<'MAP'
6_bikepath ciclovia
1_river rio
2_3_epa espacio-publico
5_zoo zoologico
11_pool piscina
13_indoor_play_center juegos-bajo-techo
14_video_game videojuegos
15_spa_party salon-de-fiestas
16_18_icecream_cafe heladeria-cafeteria
17_restaurant restaurante
19_dining_plaza patio-de-comidas
20_theaters teatro
21_commu_center centro-comunitario
22_library biblioteca
23_museum museo
24_art_gallery galeria-de-arte
25_cine cine
26_stadium estadio
27_28_church_catech iglesia-catequesis
29_hairsalon peluqueria
30_pharmacy farmacia
31_33_doctor_dent_terap medico-dentista-terapia
34_bookstore libreria
35_stationery_store papeleria
36_shopping_mall centro-comercial
37_38_neigh_fruit_store tienda-de-barrio-fruteria
39_bakery panaderia
40_supermarket supermercado
41_muni_market mercado-municipal
42_tram_stop parada-de-tranvia
43_bus_stop parada-de-bus
45_bicycle_repair taller-de-bicicletas
46_sport_acad academia-deportiva
47_music_art academia-de-musica-arte
48_languages academia-de-idiomas
49_reinf_scho refuerzo-escolar
51_school escuela
MAP

mkdir "$work/out"
while read -r key slug; do
  if [ -f "$src/$slug.tif" ]; then
    cp "$src/$slug.tif" "$work/out/$slug.tif"
    echo "$slug.tif <- $slug.tif (built)"
    continue
  fi
  # Both hashes around the key: a short key such as 1_river must not match
  # inside a longer one, and a second match is an error, not a pick.
  matches=$(find "$src" -maxdepth 1 -regextype posix-extended \
    -regex ".*_e9[0-9a-f]{4}_${key}_e9[0-9a-f]{4}_P50_C1\.dual\.tif")
  if [ "$(printf '%s\n' "$matches" | grep -c .)" != 1 ]; then
    echo "expected one source for '$key' ($slug), found: ${matches:-none}" >&2
    exit 1
  fi
  name=$(basename "$matches")
  # Float32 on purpose: the calculator would otherwise widen the band to
  # Float64. AVERAGE overviews: nearest ones would drop the thin low-minute
  # corridors along the streets at the zooms that show the whole city.
  docker run --rm -u "$(id -u):$(id -g)" -v "$src:/src:ro" -v "$work/out:/out" "$GDAL_IMAGE" sh -c "
    gdal raster calc -i 'A=/src/$name' --calc 'A == 0 ? 120 : A' --ot Float32 --of VRT -o /tmp/$slug.vrt --overwrite &&
    gdal_translate -q -of COG -co COMPRESS=DEFLATE -co PREDICTOR=YES \
      -co OVERVIEW_RESAMPLING=AVERAGE -co BLOCKSIZE=256 /tmp/$slug.vrt /out/$slug.tif"
  echo "$slug.tif <- $name"
done < "$work/map"

for f in "$work"/out/*.tif; do
  slug=$(basename "$f" .tif)
  mv "$f" "$here/${slug}_$version.tif.tmp" && mv "$here/${slug}_$version.tif.tmp" "$here/${slug}_$version.tif"
done
echo "Done: $(ls "$here"/*_"$version".tif | wc -l) files in $here"
