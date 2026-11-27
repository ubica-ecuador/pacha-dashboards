# Portoviejo centre, prepared for sky view and sun on the ground, roofs and walls (prueba DIGI-GADS, desechable).
# Writes to $WORK: buildings.parquet (footprint in UTM 17S, height and where it comes from), dsm_base.npy and
# dsm_esc.npy (1 m surface, buildings + trees, metres over the ground; esc adds street trees on calle Chile),
# bld.npy (building id + 1 per cell, 0 none), canopy_*.npy, grid.json (origin, size), trees_esc.parquet.
# Inputs: Overture 2026-11-18 buildings and road segments, GHSL Built-H ANBH 2018 (100 m, $GHSL), Meta/WRI canopy
# height 1 m (dataforgood-fb-data, tile 210001103). The ground is flat: Portoviejo's centre sits on the valley floor.
import json, os, sys
import duckdb, numpy as np, rasterio
from rasterio import features, warp
from rasterio.transform import from_origin
from shapely import wkb, ops
from shapely.geometry import LineString, Point, mapping
from pyproj import Transformer

WORK = os.environ.get('WORK', '/work')
GHSL = os.environ['GHSL']
W, S, E, N = (float(os.environ.get(k, d)) for k, d in
              (('WEST', '-80.461'), ('SOUTH', '-1.0605'), ('EAST', '-80.450'), ('NORTH', '-1.0495')))
MARGIN = 120  # metres of buildings and trees around the area, for what they shade into it
STREET = os.environ.get('STREET', 'Chile')
OV = 's3://overturemaps-us-west-2/release/2026-11-18.0'

to_utm = Transformer.from_crs(4326, 32717, always_xy=True)
x0, y0 = to_utm.transform(W, S)
x1, y1 = to_utm.transform(E, N)
gx0, gy1 = np.floor(x0 - MARGIN), np.ceil(y1 + MARGIN)
nx, ny = int(np.ceil(x1 + MARGIN - gx0)), int(np.ceil(gy1 - (y0 - MARGIN)))
transform = from_origin(gx0, gy1, 1.0, 1.0)
inner = [int(np.floor(x0 - gx0)), int(np.floor(gy1 - y1)), int(np.ceil(x1 - gx0)), int(np.ceil(gy1 - y0))]  # c0 r0 c1 r1
print('grid', nx, ny, 'inner', inner, flush=True)

d = 0.0015  # degrees of margin for the queries (~165 m)
con = duckdb.connect()
con.sql("INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2'; SET geometry_always_xy=true")
rows = con.sql(f"""
SELECT id, height, num_floors, ST_AsWKB(ST_Transform(geometry, 'EPSG:4326', 'EPSG:32717')) g
FROM read_parquet('{OV}/theme=buildings/type=building/*', hive_partitioning=1)
WHERE bbox.xmin > {W - d} AND bbox.xmax < {E + d} AND bbox.ymin > {S - d} AND bbox.ymax < {N + d}
  AND ST_GeometryType(geometry) IN ('POLYGON', 'MULTIPOLYGON')""").fetchall()
print('buildings', len(rows), flush=True)

# GHSL average net building height at each centroid (Mollweide, 100 m).
with rasterio.open(GHSL) as g:
    moll = Transformer.from_crs(32717, g.crs, always_xy=True)
    geoms = [wkb.loads(bytes(r[3])) for r in rows]
    cents = [moll.transform(*gm.centroid.coords[0]) for gm in geoms]
    ghsl = np.array([v[0] for v in g.sample(cents)], dtype=float)

out = []
for (bid, h, fl, _), gm, gh in zip(rows, geoms, ghsl):
    if h is not None:
        hh, src = h, 'altura (OSM)'
    elif fl is not None:
        hh, src = fl * 3.0, 'pisos (OSM)'
    elif gh > 0:
        hh, src = gh, 'GHSL 100 m'
    else:
        hh, src = 6.0, 'por defecto'
    if gm.area < 15:
        hh = min(hh, 3.0)  # sheds and kiosks
    out.append((bid, round(float(max(hh, 2.5)), 1), src, gm))
order = sorted(range(len(out)), key=lambda i: out[i][1])  # taller drawn last: they win a shared cell
shapes = [(mapping(out[i][3]), out[i][1]) for i in order]
dsm_b = features.rasterize(shapes, out_shape=(ny, nx), transform=transform, fill=0, dtype='float32')
bld = features.rasterize([(mapping(out[i][3]), i + 1) for i in order], out_shape=(ny, nx), transform=transform,
                         fill=0, dtype='int32')

# Canopy height (Meta/WRI, EPSG:3857, ~1.2 m) onto the grid; trees only where no building stands.
chm = np.zeros((ny, nx), dtype='float32')
with rasterio.open('/vsicurl/https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/210001103.tif') as c:
    l, b, r, t = warp.transform_bounds(32717, c.crs, gx0, gy1 - ny, gx0 + nx, gy1)
    win = c.window(l - 50, b - 50, r + 50, t + 50).round_offsets().round_lengths()
    src = c.read(1, window=win).astype('float32')
    warp.reproject(src, chm, src_transform=c.window_transform(win), src_crs=c.crs, dst_transform=transform,
                   dst_crs='EPSG:32717', resampling=warp.Resampling.bilinear)
canopy = np.where((bld == 0) & (chm >= 3.0), chm, 0).astype('float32')
print('canopy cells >= 3 m', int((canopy > 0).sum()), flush=True)

# Scenario: a tree every 8 m on both sides of the street, 5 m from its axis, crown 3 m in radius and 8 m high,
# where the spot falls on open ground (not in a building, not under an existing crown).
segs = con.sql(f"""
SELECT ST_AsWKB(ST_Transform(geometry, 'EPSG:4326', 'EPSG:32717'))
FROM read_parquet('{OV}/theme=transportation/type=segment/*', hive_partitioning=1)
WHERE bbox.xmin > {W} AND bbox.xmax < {E} AND bbox.ymin > {S} AND bbox.ymax < {N}
  AND subtype = 'road' AND names.primary = '{STREET}'""").fetchall()
line = ops.linemerge([wkb.loads(bytes(s[0])) for s in segs])
trees = []
for ln in getattr(line, 'geoms', [line]):
    for side in (5, -5):
        off = ln.parallel_offset(side, 'left', join_style=2)
        for part in getattr(off, 'geoms', [off]):
            for k in np.arange(4, part.length, 8):
                p = part.interpolate(k)
                c_, r_ = int(p.x - gx0), int(gy1 - p.y)
                if 0 <= r_ < ny and 0 <= c_ < nx and bld[r_, c_] == 0 and canopy[r_, c_] == 0:
                    trees.append(p)
crowns = features.rasterize([(mapping(p.buffer(3.0)), 8.0) for p in trees], out_shape=(ny, nx),
                            transform=transform, fill=0, dtype='float32') if trees else np.zeros_like(canopy)
canopy_esc = np.where(bld == 0, np.maximum(canopy, crowns), 0).astype('float32')
print('street trees', len(trees), flush=True)

np.save(f'{WORK}/dsm_base.npy', np.maximum(dsm_b, canopy))
np.save(f'{WORK}/dsm_esc.npy', np.maximum(dsm_b, canopy_esc))
np.save(f'{WORK}/canopy_base.npy', canopy)
np.save(f'{WORK}/canopy_esc.npy', canopy_esc)
np.save(f'{WORK}/bld.npy', bld)
json.dump({'x0': gx0, 'y1': gy1, 'nx': nx, 'ny': ny, 'inner': inner, 'bbox': [W, S, E, N]}, open(f'{WORK}/grid.json', 'w'))
con.execute('CREATE TABLE b (idx INT, id VARCHAR, height_m DOUBLE, height_from VARCHAR, g BLOB)')
con.executemany('INSERT INTO b VALUES (?, ?, ?, ?, ?)', [(i + 1, o[0], o[1], o[2], o[3].wkb) for i, o in enumerate(out)])
con.sql(f"COPY b TO '{WORK}/buildings.parquet' (FORMAT parquet)")
con.execute('CREATE TABLE t (g BLOB)')
con.executemany('INSERT INTO t VALUES (?)', [(p.wkb,) for p in trees])
con.sql(f"COPY t TO '{WORK}/trees_esc.parquet' (FORMAT parquet)")
print(con.sql('SELECT height_from, count(*), round(median(height_m), 1) FROM b GROUP BY 1 ORDER BY 2 DESC').fetchall())
