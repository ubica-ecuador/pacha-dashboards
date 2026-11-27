# compute.py's values as what the dashboard draws (prueba DIGI-GADS, desechable), each indicator in the same classes
# on the ground and on the buildings:
# - pintado-<set>.tif: the ground, one byte per cell (its class, 0 = a building or no data) with the classes' colour
#   table, for Pacha's tile server to paint (rasterPainted);
# - cityjson/<set>_t_<ix>_<iy>.json: the buildings as CityJSON 2.0 tiles (cells of STEP degrees), every roof and wall
#   panel a face whose material is its class's colour, for Kepler Plus's City Model in files mode (material);
# - tiles.parquet: one row per set and tile, the file and the box its buildings cover;
# - classes.parquet: each set's classes, from, to, colour and label, for the legend.
# <set> is <indicator>-<scenario>: sombra, svf, sol_h by base and esc, and sombra-dif (esc − base).
import json, math, os
import duckdb, numpy as np, rasterio

DIR = os.environ.get('OUT', os.path.dirname(os.path.abspath(__file__)))
STEP = 0.005

# Classes: upper bounds (the last open), colours, labels.
PAL = {
    'sombra': ([0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 0.95, None],
               ['#FFE680', '#F9C66B', '#E8A47A', '#C78897', '#9C76B0', '#6F68BE', '#4757B5', '#26408F'],
               ['< 10 %', '10–25 %', '25–40 %', '40–55 %', '55–70 %', '70–85 %', '85–95 %', '≥ 95 %']),
    'svf': ([0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.85, None],
            ['#08306B', '#08519C', '#2171B5', '#4292C6', '#6BAED6', '#9ECAE1', '#C6DBEF', '#F2F8FF'],
            ['< 0,2', '0,2–0,3', '0,3–0,4', '0,4–0,5', '0,5–0,6', '0,6–0,7', '0,7–0,85', '≥ 0,85']),
    'sol_h': ([1.5, 3, 4.5, 6, 7.5, 9, 10.5, None],
              ['#160B39', '#420A68', '#6A176E', '#932667', '#BC3754', '#DD513A', '#F37819', '#FCC33A'],
              ['< 1,5 h', '1,5–3 h', '3–4,5 h', '4,5–6 h', '6–7,5 h', '7,5–9 h', '9–10,5 h', '≥ 10,5 h']),
    'dif': ([-0.2, -0.05, 0.05, 0.2, 0.4, None],
            ['#B2182B', '#EF8A62', '#E6E6E6', '#67A9CF', '#2166AC', '#053061'],
            ['pierde > 20 pts', 'pierde 5–20', 'sin cambio (± 5)', 'gana 5–20 pts', 'gana 20–40', 'gana > 40']),
}
SETS = [('sombra', 'base'), ('sombra', 'esc'), ('svf', 'base'), ('svf', 'esc'), ('sol_h', 'base'), ('sol_h', 'esc'),
        ('sombra', 'dif')]


def classes(ind, esc):
    return PAL['dif' if esc == 'dif' else ind]


def classify(values, ind, esc):
    """1-based class of each value (0 for NaN)."""
    bounds = classes(ind, esc)[0][:-1]
    k = np.searchsorted(np.array(bounds), values, side='right') + 1
    return np.where(np.isnan(values), 0, k).astype(np.uint8)


def rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


for ind, esc in SETS:
    src = f'{DIR}/suelo-{ind}-{esc}.tif'
    with rasterio.open(src) as s:
        v = s.read(1)
        prof = s.profile
    k = classify(v, ind, esc)
    prof.update(driver='COG', dtype='uint8', nodata=0, compress='deflate')
    with rasterio.open(f'{DIR}/pintado-{ind}-{esc}.tif', 'w', **prof) as o:
        o.write(k, 1)
        o.write_colormap(1, {0: (0, 0, 0, 0), **{i + 1: (*rgb(c), 255) for i, c in enumerate(classes(ind, esc)[1])}})

con = duckdb.connect()
rows = con.execute(f"""
  SELECT building_id, surface_type, height_m, height_from, latitude, longitude, geometry,
         sombra_base, sombra_esc, svf_base, svf_esc, sol_h_base, sol_h_esc
  FROM '{DIR}/superficies.parquet' ORDER BY building_id""").fetchall()
cols = {'sombra-base': 7, 'sombra-esc': 8, 'svf-base': 9, 'svf-esc': 10, 'sol_h-base': 11, 'sol_h-esc': 12}


def ring_pts(wkt):
    inner = wkt[wkt.index('((') + 1:-1]
    out = []
    for part in inner.split('), ('):
        pts = [tuple(map(float, p.split())) for p in part.strip('()').split(', ')]
        if pts[0] == pts[-1]:
            pts = pts[:-1]
        if len(pts) >= 3:
            out.append(pts)
    return out


faces = {}
for r in rows:
    lat, lon = r[4], r[5]
    faces.setdefault(r[0], {'h': r[2], 'f': r[3], 'cell': (math.floor((lon + 180) / STEP), math.floor((lat + 90) / STEP)),
                            'faces': []})['faces'].append((ring_pts(r[6]), 0 if r[1] == 'RoofSurface' else 1, r))

index = []
for ind, esc in SETS:
    name = f'{ind}-{esc}'
    pal = classes(ind, esc)
    materials = [{'name': l, 'diffuseColor': [round(c / 255, 4) for c in rgb(h)]} for h, l in zip(pal[1], pal[2])]
    out = f'{DIR}/cityjson'
    os.makedirs(out, exist_ok=True)
    tiles = {}
    for b, o in faces.items():
        tiles.setdefault(o['cell'], []).append((b, o))
    for (ix, iy), objs in sorted(tiles.items()):
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
        for b, o in objs:
            bounds, sem, mat = [], [], []
            for rings, s, r in o['faces']:
                val = (r[8] - r[7]) if esc == 'dif' else r[cols[name]]
                bounds.append([[v(p) for p in ring] for ring in rings])
                sem.append(s)
                mat.append(int(classify(np.array([val], dtype=float), ind, esc)[0]) - 1)
                for x, y, _ in rings[0]:
                    bw, bs, be, bn = min(bw, x), min(bs, y), max(be, x), max(bn, y)
            city[b] = {'type': 'Building', 'attributes': {'altura_m': o['h'], 'altura_de': o['f']}, 'geometry': [{
                'type': 'MultiSurface', 'lod': '2.2', 'boundaries': bounds,
                'semantics': {'surfaces': [{'type': 'RoofSurface'}, {'type': 'WallSurface'}], 'values': sem},
                'material': {'valor': {'values': mat}}}]}
        doc = {'type': 'CityJSON', 'version': '2.0',
               'transform': {'scale': [1e-7, 1e-7, 0.01], 'translate': [west, south, 0]},
               'metadata': {'referenceSystem': 'https://www.opengis.net/def/crs/EPSG/0/4979',
                            'title': f'Portoviejo centro: {name} por cara (prueba DIGI-GADS)'},
               'appearance': {'materials': materials}, 'CityObjects': city, 'vertices': vertices}
        fn = f'{name}_t_{ix}_{iy}.json'
        with open(f'{out}/{fn}', 'w') as f:
            json.dump(doc, f, separators=(',', ':'), ensure_ascii=False)
        index.append((name, fn, round(bw, 6), round(bs, 6), round(be, 6), round(bn, 6), len(objs)))
    print(name, len(tiles), 'tiles', flush=True)

con.execute('CREATE TABLE t (conjunto VARCHAR, file VARCHAR, west DOUBLE, south DOUBLE, east DOUBLE, north DOUBLE, buildings INT)')
con.executemany('INSERT INTO t VALUES (?, ?, ?, ?, ?, ?, ?)', index)
con.execute(f"COPY (SELECT * FROM t ORDER BY conjunto, file) TO '{DIR}/tiles.parquet' (FORMAT parquet)")
cl = []
for key, (bounds, colours, labels) in PAL.items():
    lo = None
    for i, (hi, c, l) in enumerate(zip(bounds, colours, labels)):
        cl.append((key, i + 1, lo, hi, c, l))
        lo = hi
con.execute('CREATE TABLE c (paleta VARCHAR, clase INT, desde DOUBLE, hasta DOUBLE, color VARCHAR, etiqueta VARCHAR)')
con.executemany('INSERT INTO c VALUES (?, ?, ?, ?, ?, ?)', cl)
con.execute(f"COPY c TO '{DIR}/classes.parquet' (FORMAT parquet)")
