# Sky view factor, hours of direct sun and shade at midday on the ground, roofs and walls of central Portoviejo,
# for the baseline and the street-tree scenario (prueba DIGI-GADS, desechable). Reads prep.py's $WORK files.
#
# One engine for everything: the horizon. From a point, for each of 72 azimuths (5°), the highest obstruction angle
# over the 1 m surface model out to 120 m. Then:
#   svf     ground and roofs: (1/2π)∫cos²h dφ; walls: the view factor of a vertical face, (1/π)∫cosφ(π/4 − h/2 −
#           sin2h/4)dφ over its front half, times 2 so an open wall reads 1 like open ground.
#   sol_h   direct sun hours per day, mean of 12 representative days, every 15 min: the sun above the horizon at its
#           azimuth (and in front of the wall).
#   sombra  share of 10:00–15:00 (local clock, UTC−5) in shade, mean of the 12 days.
# Trees are opaque to other points; a point under a crown gets TAU of the sky and sun it would get above it.
# Writes suelo-<var>-<esc>.tif (COG, EPSG:32717, NaN on buildings) and superficies.parquet (one row per roof and
# wall panel, POLYGON Z in WGS84 with z in metres, the values of both scenarios).
import json, math, os
import duckdb, numpy as np, rasterio
from rasterio.transform import from_origin
from shapely import wkb
from shapely.geometry.polygon import orient
from pyproj import Transformer

WORK = os.environ.get('WORK', '/work')
OUT = os.environ.get('OUT', WORK)
LAT, LON, UTC = -1.055, -80.455, -5
TAU = 0.2
EYE = 1.1
AZ = np.deg2rad(np.arange(0, 360, 5.0))
DIST = np.unique(np.concatenate([np.arange(1, 20, 1.0), np.arange(20, 60, 2.0), np.arange(60, 121, 5.0)]))
PANEL = 3.0
g = json.load(open(f'{WORK}/grid.json'))
x0, y1, nx, ny = g['x0'], g['y1'], g['nx'], g['ny']
c0, r0, c1, r1 = g['inner']
bld = np.load(f'{WORK}/bld.npy')


def sun_positions():
    """(altitude, azimuth from north, in the 10–15 h window) every 15 min of 12 representative days."""
    out = []
    for n in (17, 47, 75, 105, 135, 162, 198, 228, 258, 288, 318, 344):
        gam = 2 * math.pi / 365 * (n - 1)
        eot = 229.18 * (0.000075 + 0.001868 * math.cos(gam) - 0.032077 * math.sin(gam)
                        - 0.014615 * math.cos(2 * gam) - 0.040849 * math.sin(2 * gam))
        dec = (0.006918 - 0.399912 * math.cos(gam) + 0.070257 * math.sin(gam) - 0.006758 * math.cos(2 * gam)
               + 0.000907 * math.sin(2 * gam) - 0.002697 * math.cos(3 * gam) + 0.00148 * math.sin(3 * gam))
        for m in range(0, 24 * 60, 15):
            clock = m + 7.5
            tst = clock + eot + 4 * LON - 60 * UTC
            ha = math.radians(tst / 4 - 180)
            lat = math.radians(LAT)
            cz = math.sin(lat) * math.sin(dec) + math.cos(lat) * math.cos(dec) * math.cos(ha)
            alt = math.asin(max(-1, min(1, cz)))
            if alt <= 0:
                continue
            az = math.atan2(math.sin(ha), math.cos(ha) * math.sin(lat) - math.tan(dec) * math.cos(lat)) + math.pi
            out.append((alt, az % (2 * math.pi), 600 <= clock < 900, n))
    return out


SUN = sun_positions()
SUN_AZI = np.array([int(round(a / math.radians(5))) % 72 for _, a, _, _ in SUN])
SUN_TAN = np.array([math.tan(a) for a, _, _, _ in SUN])
SUN_AZ = np.array([a for _, a, _, _ in SUN])
SUN_MID = np.array([m for _, _, m, _ in SUN])
DAYS = 12
STEP_H = 0.25


def ground(dsm, canopy):
    """Horizon tangents of every cell at eye height, then svf, sun hours and midday shade."""
    H = np.zeros((72, ny, nx), dtype=np.float16)
    pad = int(DIST.max()) + 2
    P = np.pad(dsm, pad)
    for i, a in enumerate(AZ):
        best = np.full((ny, nx), -1.0, dtype=np.float32)
        for d in DIST:
            dc, dr = int(round(d * math.sin(a))), int(round(-d * math.cos(a)))
            S = P[pad + dr:pad + dr + ny, pad + dc:pad + dc + nx]
            np.maximum(best, (S - EYE) / d, out=best)
        H[i] = np.maximum(best, 0)
    h = np.arctan(H.astype(np.float32))
    svf = (np.cos(h) ** 2).mean(axis=0)
    del h
    lit = np.zeros((ny, nx), dtype=np.float32)
    lit_mid = np.zeros((ny, nx), dtype=np.float32)
    for k in range(len(SUN)):
        on = (SUN_TAN[k] > H[SUN_AZI[k]]).astype(np.float32)
        lit += on
        if SUN_MID[k]:
            lit_mid += on
    under = canopy > EYE + 0.5
    t = np.where(under, TAU, 1.0)
    svf, lit, lit_mid = svf * t, lit * t, lit_mid * t
    sol_h = lit * STEP_H / DAYS
    sombra = 1 - lit_mid / SUN_MID.sum()
    mask = bld > 0
    return {k: np.where(mask, np.nan, v).astype(np.float32) for k, v in
            (('svf', svf), ('sol_h', sol_h), ('sombra', sombra))}


def points(dsm, px, py, pz, normal, own):
    """svf, sun hours and midday shade of points (roof centres: normal None; wall panels: outward azimuth)."""
    n = len(px)
    H = np.zeros((72, n), dtype=np.float32)
    for i, a in enumerate(AZ):
        best = np.zeros(n, dtype=np.float32)
        for d in DIST:
            c = np.clip(np.round(px + d * math.sin(a) - x0).astype(int), 0, nx - 1)
            r = np.clip(np.round(y1 - (py + d * math.cos(a))).astype(int), 0, ny - 1)
            z = dsm[r, c]
            z = np.where(bld[r, c] == own, -1e3, z)  # a building does not hide itself from its own roof or wall
            np.maximum(best, (z - pz) / d, out=best)
        H[i] = best
    h = np.arctan(H)
    wall = normal is not None
    if wall:
        rel = AZ[:, None] - normal[None, :]
        front = np.cos(rel)
        vf = np.where(front > 0, front * (math.pi / 4 - h / 2 - np.sin(2 * h) / 4), 0).sum(axis=0)
        svf = 2 * vf * math.radians(5) / math.pi
    else:
        svf = (np.cos(h) ** 2).mean(axis=0)
    lit = np.zeros(n, dtype=np.float32)
    lit_mid = np.zeros(n, dtype=np.float32)
    for k in range(len(SUN)):
        on = SUN_TAN[k] > H[SUN_AZI[k]]
        if wall:
            on &= np.cos(SUN_AZ[k] - normal) > 0
        lit += on
        if SUN_MID[k]:
            lit_mid += on
    return svf, lit * STEP_H / DAYS, 1 - lit_mid / SUN_MID.sum()


# Surfaces: each building in the area, its roof and its walls cut in panels of PANEL m by floor.
con = duckdb.connect()
con.sql('INSTALL spatial; LOAD spatial')
blds = con.sql(f"SELECT idx, id, height_m, height_from, g FROM '{WORK}/buildings.parquet'").fetchall()
to_wgs = Transformer.from_crs(32717, 4326, always_xy=True)
ix0, iy1 = x0 + c0, y1 - r0
ix1, iy0 = x0 + c1, y1 - r1
surf = []  # (idx, id, height_m, height_from, kind, ring(s) in UTM with z, px, py, pz, normal_az, floor)
for idx, bid, hm, hf, gb in blds:
    gm = wkb.loads(bytes(gb))
    ct = gm.centroid
    if not (ix0 <= ct.x <= ix1 and iy0 <= ct.y <= iy1):
        continue
    for poly in getattr(gm, 'geoms', [gm]):
        poly = orient(poly, 1.0)
        rp = poly.representative_point()
        rings = [[(x, y, hm) for x, y in poly.exterior.coords]] + [[(x, y, hm) for x, y in r.coords] for r in poly.interiors]
        surf.append((idx, bid, hm, hf, 'RoofSurface', rings, rp.x, rp.y, hm + 0.1, None, None))
        for ring in [poly.exterior, *poly.interiors]:
            xy = list(ring.coords)
            for (ax, ay), (bx, by) in zip(xy[:-1], xy[1:]):
                L = math.hypot(bx - ax, by - ay)
                if L < 0.5:
                    continue
                nrm = math.atan2(by - ay, -(bx - ax))  # azimuth from north of the outward normal (dy, −dx)
                ux, uy = math.sin(nrm), math.cos(nrm)
                ns, nf = max(1, math.ceil(L / PANEL)), max(1, math.ceil(hm / PANEL))
                for s in range(ns):
                    pa = (ax + (bx - ax) * s / ns, ay + (by - ay) * s / ns)
                    pb = (ax + (bx - ax) * (s + 1) / ns, ay + (by - ay) * (s + 1) / ns)
                    for f in range(nf):
                        za, zb = f * PANEL, min(hm, (f + 1) * PANEL)
                        ring4 = [(pa[0], pa[1], za), (pb[0], pb[1], za), (pb[0], pb[1], zb), (pa[0], pa[1], zb), (pa[0], pa[1], za)]
                        mx, my = (pa[0] + pb[0]) / 2 + 0.6 * ux, (pa[1] + pb[1]) / 2 + 0.6 * uy
                        surf.append((idx, bid, hm, hf, 'WallSurface', [ring4], mx, my, (za + zb) / 2, nrm, f + 1))
print('surfaces', len(surf), flush=True)

# Walls against a taller neighbour are inside the block: dropped.
dsm0 = np.load(f'{WORK}/dsm_base.npy')
keep = []
for s in surf:
    if s[4] == 'WallSurface':
        c, r = int(s[6] - x0), int(y1 - s[7])
        o = bld[r, c] if 0 <= r < ny and 0 <= c < nx else 0
        if o != 0 and o != s[0] and dsm0[r, c] > s[8]:
            continue
    keep.append(s)
surf = keep
print('surfaces kept', len(surf), flush=True)

res = {}
for esc in ('base', 'esc'):
    dsm = np.load(f'{WORK}/dsm_{esc}.npy')
    canopy = np.load(f'{WORK}/canopy_{esc}.npy')
    gr = ground(dsm, canopy)
    tr = from_origin(x0 + c0, y1 - r0, 1.0, 1.0)
    for k, v in gr.items():
        with rasterio.open(f'{OUT}/suelo-{k}-{esc}.tif', 'w', driver='COG', width=c1 - c0, height=r1 - r0, count=1,
                           dtype='float32', crs='EPSG:32717', transform=tr, nodata=float('nan'), compress='deflate') as o:
            o.write(v[r0:r1, c0:c1], 1)
    if esc == 'esc':
        with rasterio.open(f'{OUT}/suelo-sombra-dif.tif', 'w', driver='COG', width=c1 - c0, height=r1 - r0, count=1,
                           dtype='float32', crs='EPSG:32717', transform=tr, nodata=float('nan'), compress='deflate') as o:
            o.write((gr['sombra'] - res['ground_sombra_base'])[r0:r1, c0:c1], 1)
    else:
        res['ground_sombra_base'] = gr['sombra']
    print(esc, 'ground done', {k: float(np.nanmean(v[r0:r1, c0:c1])) for k, v in gr.items()}, flush=True)
    del gr
    for kind in ('RoofSurface', 'WallSurface'):
        sel = [s for s in surf if s[4] == kind]
        px = np.array([s[6] for s in sel]); py = np.array([s[7] for s in sel]); pz = np.array([s[8] for s in sel])
        own = np.array([s[0] for s in sel])
        nrm = np.array([s[9] for s in sel]) if kind == 'WallSurface' else None
        svf, sol, sombra = points(dsm, px, py, pz, nrm, own)
        res[(esc, kind)] = (svf, sol, sombra)
        print(esc, kind, len(sel), 'svf', float(svf.mean()), 'sol_h', float(sol.mean()), flush=True)

COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO']
rows = []
for kind in ('RoofSurface', 'WallSurface'):
    sel = [s for s in surf if s[4] == kind]
    b, e = res[('base', kind)], res[('esc', kind)]
    for i, s in enumerate(sel):
        rings = []
        for ring in s[5]:
            xs, ys, zs = zip(*ring)
            lo, la = to_wgs.transform(xs, ys)
            rings.append('(' + ', '.join(f'{a:.7f} {c:.7f} {z:.2f}' for a, c, z in zip(lo, la, zs)) + ')')
        clo, cla = to_wgs.transform(s[6], s[7])
        rows.append((s[1], kind, s[2], s[3], s[10], None if s[9] is None else COMPASS[int(((math.degrees(s[9]) % 360) + 22.5) // 45) % 8],
                     round(float(b[0][i]), 3), round(float(e[0][i]), 3), round(float(b[1][i]), 2), round(float(e[1][i]), 2),
                     round(float(b[2][i]), 3), round(float(e[2][i]), 3), cla, clo, 'POLYGON Z (' + ', '.join(rings) + ')'))
con.execute("""CREATE TABLE s (building_id VARCHAR, surface_type VARCHAR, height_m DOUBLE, height_from VARCHAR, piso INT,
  orientacion VARCHAR, svf_base DOUBLE, svf_esc DOUBLE, sol_h_base DOUBLE, sol_h_esc DOUBLE, sombra_base DOUBLE,
  sombra_esc DOUBLE, latitude DOUBLE, longitude DOUBLE, geometry VARCHAR)""")
con.executemany('INSERT INTO s VALUES (' + ', '.join('?' * 15) + ')', rows)
con.sql(f"COPY (SELECT * FROM s ORDER BY latitude, longitude) TO '{OUT}/superficies.parquet' (FORMAT parquet)")
print(con.sql("SELECT surface_type, count(*), round(avg(svf_base), 3), round(avg(sol_h_base), 2), round(avg(sol_h_esc - sol_h_base), 3) FROM s GROUP BY 1").fetchall())
