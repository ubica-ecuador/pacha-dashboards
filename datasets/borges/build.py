"""The maps of borges-map-of-the-empire, the Borges ladder: four USGS sheets around Rhyolite, Nevada, from 1:250,000
to 1:24,000, the last one laid at 1:1 over the town and torn by the years, and the animals recorded there.

Run by build.sh: python3 build.py <out dir> <work dir> <duckdb cli>. Needs GDAL's command-line tools
(gdalwarp, gdal_translate, gdalinfo) and numpy; Python's GDAL bindings are not needed.
"""
import json
import math
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

import numpy as np

OUT, WORK, DUCKDB = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
TNM = 'https://prd-tnm.s3.amazonaws.com/StagedProducts/Maps/HistoricalTopo/GeoTIFF'
UA = {'User-Agent': 'pacha-dashboards datasets/borges'}
# NAD27 to WGS 84 in Nevada needs NOAA's grids (NADCON): PROJ fetches the tiles it needs from its CDN.
ENV = dict(os.environ, PROJ_NETWORK='ON', GDAL_NUM_THREADS='ALL_CPUS')

# The ladder: each sheet a quarter of the one before, nested; its neatline in NAD27 degrees.
SHEETS = [
    ('empire', 'Furnace Creek', 1908, 250000, 'CA/CA_Furnace%20Creek_299776_1908_250000_geo.tif', (-117.0, 36.0, -116.0, 37.0)),
    ('province', 'Bullfrog', 1942, 125000, 'NV/NV_Bullfrog_471784_1942_125000_geo.tif', (-117.0, 36.5, -116.5, 37.0)),
    ('district', 'Bullfrog', 1954, 62500, 'NV/NV_Bullfrog_320753_1954_62500_geo.tif', (-117.0, 36.75, -116.75, 37.0)),
    ('town', 'Beatty', 1987, 24000, 'NV/NV_Beatty_318078_1987_24000_geo.tif', (-116.875, 36.875, -116.75, 37.0)),
]
# The 1:1: the town of Rhyolite, in WGS 84 degrees, and the years of its map's ruin, five by five.
TOWN = (-116.845, 36.894, -116.813, 36.914)
LAID = 1987
STAGES = 8
LEFT = [1.0, 0.92, 0.82, 0.70, 0.57, 0.44, 0.32, 0.22]   # the share of the paper still there, stage by stage


def run(*args):
    subprocess.run([str(a) for a in args], check=True, env=ENV)


def info(path):
    return json.loads(subprocess.run(['gdalinfo', '-json', str(path)], check=True, capture_output=True, text=True, env=ENV).stdout)


def fetch(url, path):
    if not path.exists():
        print('  ', url.rsplit('/', 1)[-1], flush=True)
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r, open(path, 'wb') as f:
            f.write(r.read())
    return path


def ground_km(w, s, e, n):
    """A neatline's width and height on the ground, in km (a sphere of the WGS 84 mean radius)."""
    lat = math.radians((s + n) / 2)
    k = 6371.0088 * math.pi / 180
    return (e - w) * k * math.cos(lat), (n - s) * k


# ---------- the four sheets ----------
rows = []
for level, name, year, scale, path, (w, s, e, n) in SHEETS:
    src = fetch(f'{TNM}/{path}', WORK / f'{level}-src.tif')
    tmp = WORK / f'{level}-3857.tif'
    # Clipped at the neatline (the collar and its legend off), into Web Mercator, transparent outside.
    run('gdalwarp', '-q', '-overwrite', '-t_srs', 'EPSG:3857', '-te_srs', 'EPSG:4267', '-te', w, s, e, n, '-to', 'ONLY_BEST=YES',
        '-r', 'bilinear', '-dstalpha', '-co', 'TILED=YES', src, tmp)
    run('gdal_translate', '-q', '-of', 'COG', '-b', 1, '-b', 2, '-b', 3, '-mask', 4, '-co', 'COMPRESS=JPEG', '-co', 'QUALITY=88',
        '--config', 'GDAL_TIFF_INTERNAL_MASK', 'YES', tmp, OUT / f'{level}-{year}.tif')
    gw, gh = ground_km(w, s, e, n)
    rows.append({'level': level, 'quadrangle': name, 'year': year, 'scale': scale, 'file': f'{level}-{year}.tif',
                 'west': w, 'south': s, 'east': e, 'north': n, 'ground_w_km': round(gw, 2), 'ground_h_km': round(gh, 2),
                 'paper_w_cm': round(gw * 1e5 / scale, 1), 'paper_h_cm': round(gh * 1e5 / scale, 1)})
gw, gh = ground_km(*TOWN)
rows.append({'level': 'one-to-one', 'quadrangle': 'Rhyolite', 'year': LAID, 'scale': 1, 'file': 'ruins-0.tif',
             'west': TOWN[0], 'south': TOWN[1], 'east': TOWN[2], 'north': TOWN[3], 'ground_w_km': round(gw, 2),
             'ground_h_km': round(gh, 2), 'paper_w_cm': round(gw * 1e5, 1), 'paper_h_cm': round(gh * 1e5, 1)})
(WORK / 'sheets.json').write_text('\n'.join(json.dumps(r) for r in rows))


# ---------- the 1:1: the 1987 sheet over Rhyolite, torn stage by stage ----------
crop = WORK / 'town-crop.tif'
run('gdalwarp', '-q', '-overwrite', '-t_srs', 'EPSG:3857', '-te_srs', 'EPSG:4326', '-te', *TOWN, '-tr', 2.5, 2.5, '-to', 'ONLY_BEST=YES',
    '-r', 'bilinear', WORK / 'town-src.tif', crop)
meta = info(crop)
wpx, hpx = meta['size']
raw = WORK / 'town-crop.bin'
run('gdal_translate', '-q', '-of', 'ENVI', '-co', 'INTERLEAVE=BSQ', crop, raw)
rgb = np.fromfile(raw, dtype=np.uint8).reshape(3, hpx, wpx).astype(np.float32)

rng = np.random.default_rng(1946)  # the year Borges published the story


def value_noise(h, w, cell):
    g = rng.random((h // cell + 2, w // cell + 2))
    y, x = np.arange(h) / cell, np.arange(w) / cell
    y0, x0 = y.astype(int), x.astype(int)
    fy, fx = y - y0, x - x0
    fy, fx = fy * fy * (3 - 2 * fy), fx * fx * (3 - 2 * fx)
    a, b = g[y0][:, x0], g[y0][:, x0 + 1]
    c, d = g[y0 + 1][:, x0], g[y0 + 1][:, x0 + 1]
    top, bottom = a + (b - a) * fx[None, :], c + (d - c) * fx[None, :]
    return top + (bottom - top) * fy[:, None]


def fractal(h, w, base, octaves, gain=0.55):
    total, amp, cell, norm = 0, 1.0, base, 0
    for _ in range(octaves):
        total = total + amp * value_noise(h, w, max(1, cell))
        norm += amp
        amp *= gain
        cell //= 2
    return total / norm


# Where the paper goes first: low ground of a fractal field, folds and tears along a few lines.
decay = fractal(hpx, wpx, 144, 7, gain=0.62)
yy, xx = np.mgrid[0:hpx, 0:wpx].astype(np.float32)
for _ in range(7):
    x0, y0 = rng.uniform(0, wpx), rng.uniform(0, hpx)
    ang = rng.uniform(0, math.pi)
    dist = np.abs((xx - x0) * math.sin(ang) - (yy - y0) * math.cos(ang))
    decay -= 0.09 * np.exp(-(dist / rng.uniform(6, 18)) ** 2) * (0.5 + value_noise(hpx, wpx, 64))
stain = fractal(hpx, wpx, 96, 4)
SAND = np.array([214, 196, 160], dtype=np.float32)[:, None, None]

stage_rows = []
for k in range(STAGES):
    cut = -np.inf if LEFT[k] >= 1 else np.quantile(decay, 1 - LEFT[k])
    # Paper or no paper: a soft edge comes out of renderers as coloured fringes.
    alpha = np.ones((hpx, wpx), np.float32) if LEFT[k] >= 1 else (decay >= cut).astype(np.float32)
    # The sun bleaches the paper toward the sand; stains come and go; the torn edges darken.
    bleach = np.clip(0.06 + 0.06 * k + 0.22 * (stain - 0.5) * (k / STAGES), 0, 0.7)
    paper = rgb * (1 - bleach) + SAND * bleach
    if LEFT[k] < 1:
        edge = (np.clip(1 - (decay - cut) / 0.008, 0, 1) * (decay >= cut))[None]
        paper = paper * (1 - 0.55 * edge) + np.array([92, 70, 44], np.float32)[:, None, None] * 0.55 * edge
    # Under the transparent part, the colour of a dirty edge: what a tile server's resampling bleeds in from there.
    paper = np.where(alpha[None] > 0, paper, np.array([92, 70, 44], np.float32)[:, None, None])
    out = np.concatenate([np.clip(paper, 0, 255), (alpha * 255)[None]]).astype(np.uint8)
    rawk = WORK / f'ruins-{k}.bin'
    out.tofile(rawk)
    gt = meta['geoTransform']
    srs = meta['coordinateSystem']['wkt'].replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')
    bands = ''.join(f'''<VRTRasterBand dataType="Byte" band="{b + 1}" subClass="VRTRawRasterBand">
      <ColorInterp>{('Red', 'Green', 'Blue', 'Alpha')[b]}</ColorInterp>
      <SourceFilename relativeToVRT="1">{rawk.name}</SourceFilename>
      <ImageOffset>{b * wpx * hpx}</ImageOffset><PixelOffset>1</PixelOffset><LineOffset>{wpx}</LineOffset>
    </VRTRasterBand>''' for b in range(4))
    vrt = WORK / f'ruins-{k}.vrt'
    vrt.write_text(f'''<VRTDataset rasterXSize="{wpx}" rasterYSize="{hpx}">
  <SRS>{srs}</SRS>
  <GeoTransform>{', '.join(str(v) for v in gt)}</GeoTransform>
  {bands}
</VRTDataset>''')
    run('gdal_translate', '-q', '-of', 'COG', '-co', 'COMPRESS=DEFLATE', '-co', 'PREDICTOR=2', vrt, OUT / f'ruins-{k}.tif')
    stage_rows.append({'stage': k, 'year_from': LAID + 5 * k, 'year_to': LAID + 5 * k + 4, 'file': f'ruins-{k}.tif',
                       'paper_left': round(float(alpha.mean()), 3)})
(WORK / 'stages.json').write_text('\n'.join(json.dumps(r) for r in stage_rows))


# ---------- the animals: GBIF's occurrences in the town, under CC0 or CC BY ----------
def gbif(path, **q):
    url = f'https://api.gbif.org/v1/{path}?' + '&'.join(f'{k}={v}' for k, v in q.items())
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        return json.load(r)


box = dict(decimalLatitude=f'{TOWN[1]},{TOWN[3]}', decimalLongitude=f'{TOWN[0]},{TOWN[2]}', hasCoordinate='true',
           hasGeospatialIssue='false', kingdomKey=1, limit=300)
animals, offset = [], 0
while True:
    page = gbif('occurrence/search', offset=offset, **box)
    animals += page['results']
    offset += len(page['results'])
    if page['endOfRecords'] or not page['results']:
        break
english = {}
for key in sorted({a['speciesKey'] for a in animals if a.get('speciesKey')}):
    english[key] = gbif(f'species/{key}').get('vernacularName')  # GBIF's preferred English name
with open(WORK / 'animals.json', 'w') as f:
    for a in animals:  # every licence here; DuckDB keeps CC0 and CC BY below
        f.write(json.dumps({k: a.get(k) for k in ('key', 'scientificName', 'species', 'genus', 'family', 'order', 'class',
                                                   'year', 'eventDate', 'decimalLatitude', 'decimalLongitude', 'license',
                                                   'datasetName', 'publisher', 'basisOfRecord', 'speciesKey')}
                           | {'english': english.get(a.get('speciesKey'))}) + '\n')
print('  animals', len(animals), 'species', len(english), flush=True)

subprocess.run([DUCKDB, '-bail', '-c', f"""
COPY (SELECT * FROM read_json('{WORK / 'sheets.json'}', format = 'newline_delimited')) TO '{OUT / 'sheets.parquet'}';
COPY (SELECT * FROM read_json('{WORK / 'stages.json'}', format = 'newline_delimited')) TO '{OUT / 'stages.parquet'}';
COPY (
  SELECT key::BIGINT AS gbif_id, coalesce(species, genus, scientificName) AS animal, english, class, "order", family,
         year::INTEGER AS year, try_cast(left(eventDate, 10) AS DATE) AS day,
         decimalLatitude AS latitude, decimalLongitude AS longitude,
         CASE WHEN license ILIKE '%publicdomain/zero%' THEN 'CC0 1.0' WHEN license ILIKE '%licenses/by/4.0%' THEN 'CC BY 4.0' END AS licence,
         datasetName AS dataset, basisOfRecord AS basis
  FROM read_json('{WORK / 'animals.json'}', format = 'newline_delimited')
  WHERE year IS NOT NULL AND (license ILIKE '%publicdomain/zero%' OR license ILIKE '%licenses/by/4.0%')
  ORDER BY year, gbif_id
) TO '{OUT / 'animals.parquet'}';
SELECT count(*) AS animals, count(DISTINCT animal) AS kinds, min(year), max(year) FROM '{OUT / 'animals.parquet'}';
SELECT level, year, scale, paper_w_cm, paper_h_cm, ground_w_km, ground_h_km FROM '{OUT / 'sheets.parquet'}';
SELECT * FROM '{OUT / 'stages.parquet'}';
"""], check=True, env=ENV)
