# surfaces.parquet as CityJSON 2.0 tiles for Kepler Plus's City Model in files mode: the city cut into cells of STEP
# degrees (about 550 m), each building in the cell of its middle, one file per cell (cityjson/t_<ix>_<iy>.json, gzipped
# when GZIP=1) and an index of the cells, tiles.parquet (file, west, south, east, north, buildings), whose rows the map
# reads so it fetches only the tiles in view. Each building is a Building with one MultiSurface (LoD 2.2): its roof and
# wall faces (semantics RoofSurface / WallSurface) and, through the appearance's materials (theme "colour"), each
# face's tone, the colour the rows mode took from the `tone` column. Vertices in EPSG:4979 (longitude, latitude in
# degrees, height in metres over the building's ground), integers over the cell's corner: 1e-7 degrees (about 1 cm)
# and 1 cm. Runs in the recorder image (python + duckdb): IN and OUT are paths.
import gzip, json, math, os, re, sys
import duckdb

IN = os.environ.get('TILES_IN', '/work/surfaces.parquet')
OUT = os.environ.get('TILES_OUT', '/work/cityjson')
STEP = float(os.environ.get('TILES_STEP', '0.005'))
GZIP = os.environ.get('GZIP', '0') == '1'

# The tones, as the dashboard's legend names them (sorted: the material index of each).
TONES = dict([("Clay tile, dark", "#9C4A32"), ("Clay tile", "#C2603F"), ("Clay tile, light", "#D98A5F"),
  ("Weathered tile", "#A9785F"), ("Light roof", "#E8E4DC"), ("Grey roof", "#A8A6A2"), ("Dark roof", "#5E5C5A"),
  ("Wall, lime-washed", "#F1E8D8"), ("Wall, ochre", "#E2CDA8"), ("Wall, plaster", "#D8D6D2"),
  ("Wall, white", "#F4F2EC"), ("Wall, brick", "#9A5A45"), ("Roof, brick", "#86574A"),
  ("Tile, blue", "#7D9AD0"), ("Cupola, white", "#ECEAE4"), ("Tile, glazed brown", "#8E5B47"),
  ("Tile, green", "#6E8F72"), ("Slate", "#4C5562"), ("Wall, pink marble", "#B98A7E"), ("Wall, stone", "#C8AC92"),
  ("Stone trim", "#DCC0A2"), ("Opening", "#2E2826"), ("Trim, grey", "#C9C5BC"), ("Gallery ceiling", "#5E574F"),
  ("Gallery, in shade", "#4A443E"), ("Trim, ochre", "#C9A24E"), ("Stone, dark", "#57534E"),
  ("Railing, iron", "#2E2B29"), ("Eave, wood", "#5C3F2C"), ("Gallery, wooden beams", "#4B3627"),
  ("Window, wood frame", "#6B4A33"), ("Glass", "#33373B"), ("Wood, posts", "#7A4E2E"),
  ("Wood, balustrade", "#8A5B36"), ("Door, wood", "#5A3B26"), ("Window, blue frame", "#3E6FA8")])
NAMES = sorted(TONES)
INDEX = {n: i for i, n in enumerate(NAMES)}
MATERIALS = [{"name": n, "diffuseColor": [round(int(TONES[n][k:k + 2], 16) / 255, 4) for k in (1, 3, 5)]}
             for n in NAMES]
SEMANTIC = {'RoofSurface': 0, 'WallSurface': 1}
NUM = re.compile(r'(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)')
RING = re.compile(r'\(([^()]+)\)')


def rings_of(wkt):
    """A POLYGON Z's rings (outer first) as lists of (x, y, z), the closing point dropped; MULTIPOLYGON: each polygon."""
    polygons = wkt.split(')), ((') if wkt.startswith('MULTIPOLYGON') else [wkt]
    for p in polygons:
        rings = []
        for r in RING.findall(p):
            pts = [tuple(map(float, m)) for m in NUM.findall(r)]
            if len(pts) > 1 and pts[0] == pts[-1]:
                pts = pts[:-1]
            if len(pts) >= 3:
                rings.append(pts)
        if rings:
            yield rings


def cell(lon, lat):
    return math.floor((lon + 180) / STEP), math.floor((lat + 90) / STEP)


con = duckdb.connect()
rows = con.execute(f"""
  SELECT building_id, any_value(name) OVER (PARTITION BY building_id) AS name, surface_type, tone, roof, height_m,
         height_from, source, pitched, latitude, longitude, geometry
  FROM '{IN}' ORDER BY building_id""").fetchall()

tiles = {}
for b, name, stype, tone, roof, height, hfrom, source, pitched, lat, lon, geom in rows:
    t = tiles.setdefault(cell(lon, lat), {})
    o = t.get(b)
    if o is None:
        attrs = {'name': name, 'roof': roof, 'height_m': height, 'height_from': hfrom, 'source': source,
                 'pitched': pitched}
        o = t[b] = {'attributes': {k: v for k, v in attrs.items() if v is not None}, 'faces': []}
    for rings in rings_of(geom):
        o['faces'].append((rings, SEMANTIC.get(stype, 1), INDEX.get(tone)))

os.makedirs(OUT, exist_ok=True)
index = []
total = 0
for (ix, iy), objects in sorted(tiles.items()):
    west, south = ix * STEP - 180, iy * STEP - 90
    vertices, seen = [], {}

    def v(p):
        key = (round((p[0] - west) * 1e7), round((p[1] - south) * 1e7), round(p[2] * 100))
        i = seen.get(key)
        if i is None:
            i = seen[key] = len(vertices)
            vertices.append(key)
        return i

    city = {}
    bw, bs, be, bn = math.inf, math.inf, -math.inf, -math.inf
    for b, o in objects.items():
        boundaries, sem, mat = [], [], []
        for rings, s, m in o['faces']:
            boundaries.append([[v(p) for p in r] for r in rings])
            sem.append(s)
            mat.append(m)
            for x, y, _ in rings[0]:
                bw, bs, be, bn = min(bw, x), min(bs, y), max(be, x), max(bn, y)
        city[b] = {'type': 'Building', 'attributes': o['attributes'], 'geometry': [{
            'type': 'MultiSurface', 'lod': '2.2', 'boundaries': boundaries,
            'semantics': {'surfaces': [{'type': 'RoofSurface'}, {'type': 'WallSurface'}], 'values': sem},
            'material': {'colour': {'values': mat}}}]}
    doc = {'type': 'CityJSON', 'version': '2.0',
           'transform': {'scale': [1e-7, 1e-7, 0.01], 'translate': [west, south, 0]},
           'metadata': {'referenceSystem': 'https://www.opengis.net/def/crs/EPSG/0/4979',
                        'title': 'Cuenca, Ecuador: buildings with roof and wall colours (pacha-dashboards cuenca-3d)'},
           'appearance': {'materials': MATERIALS},
           'CityObjects': city, 'vertices': vertices}
    name = f't_{ix}_{iy}.json'
    data = json.dumps(doc, separators=(',', ':'), ensure_ascii=False).encode()
    if GZIP:
        data = gzip.compress(data, 9)
    with open(f'{OUT}/{name}.tmp', 'wb') as f:
        f.write(data)
    os.replace(f'{OUT}/{name}.tmp', f'{OUT}/{name}')
    total += len(data)
    # The box the tile's buildings cover (they spill over the cell's edges), which the layer reads for "in view".
    index.append((name, round(bw, 6), round(bs, 6), round(be, 6), round(bn, 6), len(objects), len(data)))

con.execute("CREATE TABLE t (file VARCHAR, west DOUBLE, south DOUBLE, east DOUBLE, north DOUBLE, buildings INT, bytes INT)")
con.executemany("INSERT INTO t VALUES (?, ?, ?, ?, ?, ?, ?)", index)
con.execute(f"COPY (SELECT * FROM t ORDER BY file) TO '{OUT}/../tiles.parquet' (FORMAT parquet)")
big = sorted(index, key=lambda r: -r[6])[:3]
print(f'{len(index)} tiles, {sum(r[5] for r in index)} buildings, {total / 1e6:.1f} MB; largest',
      ', '.join(f'{r[0]} {r[5]} bldg {r[6] / 1e6:.2f} MB' for r in big))
