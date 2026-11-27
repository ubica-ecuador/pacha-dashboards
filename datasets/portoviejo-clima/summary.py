# The figures beside the maps (prueba DIGI-GADS, desechable): each indicator's mean over the baseline and the scenario,
# for the street the scenario plants (its ground within 10 m of the axis, its walls within 15 m) and for the whole
# area. Writes resumen.parquet (zona, superficie, indicador, base, esc) and calle.parquet (the street's axis as WKT).
import os
import duckdb, numpy as np, rasterio
from rasterio import features
from shapely import wkb, ops
from shapely.geometry import mapping, Point
from pyproj import Transformer

DIR = os.environ.get('OUT', os.path.dirname(os.path.abspath(__file__)))
W, S, E, N = -80.461, -1.0605, -80.450, -1.0495
STREET = os.environ.get('STREET', 'Chile')
con = duckdb.connect()
con.sql("INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2'; SET geometry_always_xy=true")
segs = con.sql(f"""
SELECT ST_AsWKB(ST_Transform(geometry, 'EPSG:4326', 'EPSG:32717'))
FROM read_parquet('s3://overturemaps-us-west-2/release/2026-11-18.0/theme=transportation/type=segment/*', hive_partitioning=1)
WHERE bbox.xmin > {W} AND bbox.xmax < {E} AND bbox.ymin > {S} AND bbox.ymax < {N}
  AND subtype = 'road' AND names.primary = '{STREET}'""").fetchall()
axis = ops.linemerge([wkb.loads(bytes(s[0])) for s in segs])

rows = []
for ind in ('sombra', 'svf', 'sol_h'):
    vals = {}
    for esc in ('base', 'esc'):
        with rasterio.open(f'{DIR}/suelo-{ind}-{esc}.tif') as r:
            v = r.read(1)
            near = features.rasterize([(mapping(axis.buffer(10)), 1)], out_shape=v.shape, transform=r.transform, fill=0)
        vals[esc] = v
    for zona, m in ((f'Calle {STREET}', near == 1), ('Todo el centro', np.ones_like(near, bool))):
        rows.append((zona, 'Suelo', ind, float(np.nanmean(np.where(m, vals['base'], np.nan))),
                     float(np.nanmean(np.where(m, vals['esc'], np.nan)))))

to_utm = Transformer.from_crs(4326, 32717, always_xy=True)
walls = con.sql(f"SELECT longitude, latitude, sombra_base, sombra_esc, svf_base, svf_esc, sol_h_base, sol_h_esc FROM '{DIR}/superficies.parquet' WHERE surface_type = 'WallSurface'").fetchnumpy()
x, y = to_utm.transform(walls['longitude'], walls['latitude'])
zone = axis.buffer(15)
inside = np.array([zone.contains(Point(a, b)) for a, b in zip(x, y)])
for ind in ('sombra', 'svf', 'sol_h'):
    for zona, m in ((f'Calle {STREET}', inside), ('Todo el centro', np.ones_like(inside))):
        rows.append((zona, 'Fachadas', ind, float(walls[f'{ind}_base'][m].mean()), float(walls[f'{ind}_esc'][m].mean())))

con.execute('CREATE TABLE r (zona VARCHAR, superficie VARCHAR, indicador VARCHAR, base DOUBLE, esc DOUBLE)')
con.executemany('INSERT INTO r VALUES (?, ?, ?, ?, ?)', rows)
con.execute(f"COPY r TO '{DIR}/resumen.parquet' (FORMAT parquet)")
to_wgs = Transformer.from_crs(32717, 4326, always_xy=True)
con.execute('CREATE TABLE c (nombre VARCHAR, wkt VARCHAR)')
con.execute('INSERT INTO c VALUES (?, ?)', [STREET, ops.transform(lambda a, b, z=None: to_wgs.transform(a, b), axis).wkt])
con.execute(f"COPY c TO '{DIR}/calle.parquet' (FORMAT parquet)")
for r in rows:
    print(r)
