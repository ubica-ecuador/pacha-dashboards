#!/bin/sh
# A MapLibre style.json over Mapbox's Static Tiles API, for kepler's Base map -> Self-hosted style.json
# (bogota-rush-hour): https://<instance>/datasets/mapbox-basemap/style/style.json. The tiles are the Mapbox
# style STYLE (default mapbox/dark-v11) as 512 px rasters at twice the resolution.
# The token is MAPBOX_BASEMAP_TOKEN, from the environment or Pacha's .env (PACHA_DIR, default ../pacha):
# a public token (no secret scope) restricted by URL to this instance, since the browser fetches the tiles
# with it. It is written into style/style.json, which git ignores; run this again after rotating it.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
PACHA_DIR=${PACHA_DIR:-$here/../../../pacha}
TOKEN=${MAPBOX_BASEMAP_TOKEN:-$(sed -n 's/^MAPBOX_BASEMAP_TOKEN=//p' "$PACHA_DIR/.env" | tail -n 1)}
STYLE=${STYLE:-mapbox/dark-v11}
case "$TOKEN" in pk.*) ;; *) echo "MAPBOX_BASEMAP_TOKEN is not a public token (pk.)" >&2; exit 1 ;; esac
case "$TOKEN" in *[!A-Za-z0-9._-]*) echo "MAPBOX_BASEMAP_TOKEN has unexpected characters" >&2; exit 1 ;; esac
mkdir -p "$here/style"
cat > "$here/style/style.json.tmp" <<JSON
{
  "version": 8,
  "name": "Mapbox ($STYLE, Static Tiles)",
  "sources": {
    "mapbox": {
      "type": "raster",
      "tiles": ["https://api.mapbox.com/styles/v1/$STYLE/tiles/512/{z}/{x}/{y}@2x?access_token=$TOKEN"],
      "tileSize": 512,
      "maxzoom": 22,
      "attribution": "<a href=\"https://www.mapbox.com/about/maps/\">© Mapbox</a> <a href=\"https://www.openstreetmap.org/copyright\">© OpenStreetMap</a> <a href=\"https://www.mapbox.com/map-feedback/\">Improve this map</a>"
    }
  },
  "layers": [{ "id": "mapbox", "type": "raster", "source": "mapbox" }]
}
JSON
mv "$here/style/style.json.tmp" "$here/style/style.json"
echo "wrote $here/style/style.json ($STYLE)"
