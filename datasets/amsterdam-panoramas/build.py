"""Dam Square, Amsterdam: panoramas, trees, buildings and the LiDAR as a 3D Tiles point cloud.

Run by build.sh in a Python container: python build.py <work dir> <out dir>. See build.sh for what
each file holds and where it comes from.

Coordinates: everything is read in RD New (EPSG:28992) or turned into it, measured there in metres,
and written in WGS 84 through one transformation (pyproj's default for RD, the 7-parameter Helmert,
as the city's API uses for its own WGS 84 output), so the panoramas, the city's registers and the
point cloud line up with each other to the decimetre. Heights are NAP; the point cloud is written
with the box's street level at height 0, where the map's ground is.
"""

import io
import json
import math
import os
import shutil
import sys
import time
import urllib.parse

import duckdb
import laspy
import numpy as np
import requests
import shapely
from PIL import Image
from pyproj import Transformer
from shapely.geometry import shape

WORK, OUT = sys.argv[1], sys.argv[2]

# The box, in RD New metres: Dam Square in the middle, the Royal Palace and the Nieuwe Kerk to the
# west, Damrak and the Beurs to the north, Rokin to the south, Warmoesstraat to the east. It lies
# inside AHN5's 1 km tile 121000_487000.
X0, Y0, X1, Y1 = 121090.0, 487140.0, 121540.0, 487590.0

PANORAMAS = 'https://api.data.amsterdam.nl/panorama/panoramas/'
CITY = 'https://api.data.amsterdam.nl/v1/'
COPC = 'https://fsn1.your-objectstorage.com/hwh-ahn/AHN5_KM/01_LAZ/AHN5_C_121000_487000.COPC.LAZ'
ORTHO = 'https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0'
UA = {'User-Agent': 'pacha-dataset-build'}

rd2wgs = Transformer.from_crs('EPSG:28992', 'EPSG:4326', always_xy=True)
wgs2rd = Transformer.from_crs('EPSG:4326', 'EPSG:28992', always_xy=True)


def get(url, **kw):
    """GET with three tries, a pause between them."""
    for attempt in range(3):
        try:
            r = requests.get(url, headers=UA, timeout=120, **kw)
            r.raise_for_status()
            return r
        except requests.RequestException as e:
            if attempt == 2:
                raise
            print(f'  retry after {e}', flush=True)
            time.sleep(5)


def cached_json(name, url):
    path = os.path.join(WORK, name)
    if not os.path.exists(path):
        body = get(url).json()
        with open(path, 'w') as f:
            json.dump(body, f)
        time.sleep(1)
    with open(path) as f:
        return json.load(f)


def box_wkt_wgs84():
    """The box as a WGS 84 polygon, for the city's API filters (a little wider; clipped after)."""
    m = 20
    xs = [X0 - m, X1 + m, X1 + m, X0 - m, X0 - m]
    ys = [Y0 - m, Y0 - m, Y1 + m, Y1 + m, Y0 - m]
    lon, lat = rd2wgs.transform(xs, ys)
    return 'POLYGON((' + ','.join(f'{a:.7f} {b:.7f}' for a, b in zip(lon, lat)) + '))'


def inside(x, y):
    return (X0 <= x <= X1) and (Y0 <= y <= Y1)


# --- Panoramas ------------------------------------------------------------------------------

def panoramas():
    print('Panoramas ...', flush=True)
    rows = []
    page = 1
    while True:
        q = urllib.parse.urlencode({'bbox': f'{X0},{Y1},{X1},{Y0}', 'srid': 28992,
                                    'page_size': 1000, 'page': page})
        body = cached_json(f'panoramas-{page:03d}.json', f'{PANORAMAS}?{q}')
        for p in body['_embedded']['panoramas']:
            lon, lat = p['geometry']['coordinates'][:2]
            links = p['_links']
            rows.append((
                p['pano_id'], p['timestamp'], int(p['mission_year']), p.get('mission_type'),
                p.get('surface_type'), lon, lat, float(p['heading'] or 0), float(p['pitch'] or 0),
                float(p['roll'] or 0), links['equirectangular_small']['href'],
                links['equirectangular_medium']['href'],
            ))
        print(f'  page {page}: {len(rows)} of {body["count"]}', flush=True)
        if not body['_links']['next']['href']:
            break
        page += 1
    return rows


# --- The city's registers ---------------------------------------------------------------------

def city(path, name):
    """Every record of a city API table whose geometry meets the box, in RD New."""
    print(f'{path} ...', flush=True)
    q = urllib.parse.urlencode({'_format': 'json', '_pageSize': 1000,
                                'geometrie[intersects]': box_wkt_wgs84()})
    url = f'{CITY}{path}/?{q}'
    out, page = [], 1
    while url:
        body = cached_json(f'{name}-{page:03d}.json', url)
        out += body['_embedded'][path.split('/')[-1]]
        url = body['_links'].get('next', {}).get('href')
        page += 1
    print(f'  {len(out)}', flush=True)
    return out


# --- LiDAR ------------------------------------------------------------------------------------

def lidar():
    print('LiDAR (AHN5, by ranges of the COPC tile) ...', flush=True)
    path = os.path.join(WORK, 'lidar.npz')
    if not os.path.exists(path):
        with laspy.CopcReader.open(COPC) as r:
            pts = r.query(bounds=laspy.copc.Bounds(mins=np.array([X0, Y0]), maxs=np.array([X1, Y1])))
        np.savez(path, x=np.asarray(pts.x), y=np.asarray(pts.y), z=np.asarray(pts.z),
                 c=np.asarray(pts.classification))
    d = np.load(path)
    x, y, z, c = d['x'], d['y'], d['z'], d['c']
    keep = (x >= X0) & (x <= X1) & (y >= Y0) & (y <= Y1) & (c != 7)
    print(f'  {keep.sum():,} points; classes {dict(zip(*np.unique(c[keep], return_counts=True)))}', flush=True)
    return x[keep], y[keep], z[keep], c[keep]


CELL = 1.0  # m


def grids(x, y, z, c):
    """1 m grids: the ground (class 2, holes under buildings filled from round them), the highest
    return of everything, and of vegetation (class 1) alone."""
    nx, ny = int((X1 - X0) / CELL) + 1, int((Y1 - Y0) / CELL) + 1
    ix = np.clip(((x - X0) / CELL).astype(int), 0, nx - 1)
    iy = np.clip(((Y1 - y) / CELL).astype(int), 0, ny - 1)
    flat = iy * nx + ix

    g = c == 2
    s = np.bincount(flat[g], weights=z[g], minlength=nx * ny)
    n = np.bincount(flat[g], minlength=nx * ny)
    dtm = np.where(n > 0, s / np.maximum(n, 1), np.nan).reshape(ny, nx)
    # Fill: each pass gives an empty cell the mean of its filled neighbours.
    for _ in range(200):
        if not np.isnan(dtm).any():
            break
        p = np.pad(dtm, 1, constant_values=np.nan)
        nb = np.stack([p[1 + dy:1 + dy + ny, 1 + dx:1 + dx + nx]
                       for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx])
        cnt = (~np.isnan(nb)).sum(0)
        fill = np.where(cnt > 0, np.nansum(nb, 0) / np.maximum(cnt, 1), np.nan)
        dtm = np.where(np.isnan(dtm), fill, dtm)

    dsm = np.full(nx * ny, -np.inf)
    np.maximum.at(dsm, flat, z)
    dsm = dsm.reshape(ny, nx)
    dsm = np.where(np.isinf(dsm), dtm, dsm)

    v = c == 1
    veg = np.full(nx * ny, -np.inf)
    np.maximum.at(veg, flat[v], z[v])
    veg = veg.reshape(ny, nx)
    return dtm, dsm, veg


def cell(xr, yr):
    return int((Y1 - yr) / CELL), int((xr - X0) / CELL)


def around(grid, xr, yr, r):
    iy, ix = cell(xr, yr)
    k = int(math.ceil(r / CELL))
    return grid[max(iy - k, 0):iy + k + 1, max(ix - k, 0):ix + k + 1]


# --- The aerial photograph and the 3D tiles ---------------------------------------------------

PIX = 0.25  # m per pixel of the aerial photograph


def ortho():
    path = os.path.join(WORK, 'ortho.jpg')
    w, h = int((X1 - X0) / PIX), int((Y1 - Y0) / PIX)
    if not os.path.exists(path):
        print('Aerial photograph ...', flush=True)
        q = urllib.parse.urlencode({
            'SERVICE': 'WMS', 'VERSION': '1.3.0', 'REQUEST': 'GetMap', 'LAYERS': 'Actueel_orthoHR',
            'STYLES': '', 'CRS': 'EPSG:28992', 'BBOX': f'{X0},{Y0},{X1},{Y1}', 'WIDTH': w,
            'HEIGHT': h, 'FORMAT': 'image/jpeg'})
        with open(path, 'wb') as f:
            f.write(get(f'{ORTHO}?{q}').content)
    img = np.asarray(Image.open(path).convert('RGB'))
    return img


def ecef(lon, lat, h):
    a, e2 = 6378137.0, 6.69437999014e-3
    lo, la = np.radians(lon), np.radians(lat)
    n = a / np.sqrt(1 - e2 * np.sin(la) ** 2)
    return np.stack([(n + h) * np.cos(la) * np.cos(lo), (n + h) * np.cos(la) * np.sin(lo),
                     (n * (1 - e2) + h) * np.sin(la)], axis=1)


def pnts(path, pos, rgb):
    """A 3D Tiles 1.0 point cloud tile: float32 positions about RTC_CENTER, and RGB."""
    centre = pos.mean(axis=0)
    rel = (pos - centre).astype('<f4')
    n = len(pos)
    table = {'POINTS_LENGTH': n, 'RTC_CENTER': [float(v) for v in centre],
             'POSITION': {'byteOffset': 0}, 'RGB': {'byteOffset': rel.nbytes}}
    js = json.dumps(table, separators=(',', ':')).encode()
    js += b' ' * ((8 - (28 + len(js)) % 8) % 8)
    body = rel.tobytes() + rgb.astype(np.uint8).tobytes()
    body += b'\0' * ((8 - len(body) % 8) % 8)
    head = b'pnts' + np.array([1, 28 + len(js) + len(body), len(js), len(body), 0, 0], '<u4').tobytes()
    with open(path, 'wb') as f:
        f.write(head + js + body)


def tiles(x, y, z, ground):
    """The cloud as a quadtree of tiles with additive refinement: the root holds an even sample of
    the whole box, each level below adds more points in quarters of its parent, the last level the
    rest. A viewer far away loads the root; close up, the tiles in view down to full density."""
    print('3D tiles ...', flush=True)
    img = ortho()
    col = np.clip(((x - X0) / PIX).astype(int), 0, img.shape[1] - 1)
    row = np.clip(((Y1 - y) / PIX).astype(int), 0, img.shape[0] - 1)
    rgb = img[row, col]

    lon, lat = rd2wgs.transform(x, y)
    h = z - ground
    pos = ecef(np.asarray(lon), np.asarray(lat), h)

    rng = np.random.default_rng(42)
    order = rng.permutation(len(x))
    per_tile, depth = 60000, 3
    counts = [per_tile * 4 ** lv for lv in range(depth)]
    starts = np.cumsum([0] + counts)
    level = np.full(len(x), depth)
    for lv in range(depth):
        level[order[starts[lv]:starts[lv + 1]]] = lv
    # Each point's quarter at the deepest level; its tile at its own level is that, shifted.
    side = X1 - X0
    n = 2 ** depth
    qi = np.clip(((x - X0) / side * n).astype(int), 0, n - 1)
    qj = np.clip(((y - Y0) / side * n).astype(int), 0, n - 1)
    shift = depth - level
    key = (level * n + (qi >> shift)) * n + (qj >> shift)
    by_key = np.argsort(key, kind='stable')
    keys, first = np.unique(key[by_key], return_index=True)
    groups = dict(zip(keys.tolist(), np.split(by_key, first[1:])))

    tmp = os.path.join(OUT, 'lidar.tmp')
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    area = side * (Y1 - Y0)

    def node(lv, i, j):
        idx = groups.get((lv * n + i) * n + j, np.array([], dtype=int))
        children = []
        if lv < depth:
            for ci in (0, 1):
                for cj in (0, 1):
                    ch = node(lv + 1, 2 * i + ci, 2 * j + cj)
                    if ch:
                        children.append(ch)
        if len(idx) == 0 and not children:
            return None
        s = side / 2 ** lv
        x0, y0 = X0 + i * s, Y0 + j * s
        lons, lats = rd2wgs.transform([x0, x0 + s, x0 + s, x0], [y0, y0, y0 + s, y0 + s])
        lows = ([float(h[idx].min())] if len(idx) else []) + [ch['boundingVolume']['region'][4] for ch in children]
        highs = ([float(h[idx].max())] if len(idx) else []) + [ch['boundingVolume']['region'][5] for ch in children]
        # How far apart the points drawn down to this level lie, over the whole box, times 20: a
        # viewer asks for the next level once this one's gaps would show (at deck's 16 px of
        # error, the full density from about 300 m away).
        drawn = sum(counts[:lv + 1]) if lv < depth else len(x)
        tile = {
            'boundingVolume': {'region': [math.radians(min(lons)), math.radians(min(lats)),
                                          math.radians(max(lons)), math.radians(max(lats)),
                                          min(lows), max(highs)]},
            'geometricError': 0.0 if lv == depth else round(20 * math.sqrt(area / drawn), 3),
            'refine': 'ADD',
        }
        if len(idx):
            name = f'{lv}-{i}-{j}.pnts'
            pnts(os.path.join(tmp, name), pos[idx], rgb[idx])
            tile['content'] = {'uri': name}
        if children:
            tile['children'] = children
        return tile

    root = node(0, 0, 0)
    tileset = {'asset': {'version': '1.0'},
               'geometricError': round(40 * math.sqrt(area / counts[0]), 3), 'root': root}
    with open(os.path.join(tmp, 'tileset.json'), 'w') as f:
        json.dump(tileset, f, separators=(',', ':'))
    final = os.path.join(OUT, 'lidar')
    old = os.path.join(OUT, 'lidar.old')
    shutil.rmtree(old, ignore_errors=True)
    if os.path.exists(final):
        os.rename(final, old)
    os.rename(tmp, final)
    shutil.rmtree(old, ignore_errors=True)
    n = sum(1 for f in os.listdir(final) if f.endswith('.pnts'))
    print(f'  {n} tiles, {len(x):,} points', flush=True)


# --- Assembly ---------------------------------------------------------------------------------

HEIGHT_CLASS = {'a': 3, 'b': 7.5, 'c': 10.5, 'd': 13.5, 'e': 16.5, 'f': 21, 'g': 27}


def main():
    pano = panoramas()
    trees = city('bomen/stamgegevens', 'trees')
    panden = city('bag/panden', 'buildings')
    monuments = city('monumenten/monumenten', 'monuments')
    x, y, z, c = lidar()
    dtm, dsm, veg = grids(x, y, z, c)
    ground = float(np.median(z[c == 2]))
    print(f'Street level: {ground:.2f} m NAP', flush=True)

    con = duckdb.connect()

    # Panoramas, with the ground under each.
    rows = []
    for p in pano:
        xr, yr = wgs2rd.transform(p[5], p[6])
        if not inside(xr, yr):
            continue
        g = float(np.nanmedian(around(dtm, xr, yr, 1.5)))
        rows.append(p + (round(g, 2),))
    con.execute("""CREATE TABLE p (pano_id VARCHAR, taken VARCHAR, year INTEGER, mission VARCHAR,
        surface VARCHAR, longitude DOUBLE, latitude DOUBLE, heading DOUBLE, pitch DOUBLE,
        roll DOUBLE, url_2000 VARCHAR, url_4000 VARCHAR, ground_nap DOUBLE)""")
    con.executemany('INSERT INTO p VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', rows)
    con.execute(f"""COPY (SELECT pano_id, taken::TIMESTAMPTZ AS taken, year, mission, surface,
        longitude, latitude, heading, pitch, roll, url_2000, url_4000, ground_nap
        FROM p ORDER BY taken) TO '{OUT}/panoramas.parquet.tmp' (FORMAT parquet)""")
    print(f'panoramas.parquet: {len(rows)}', flush=True)

    # Trees, with the height the LiDAR measures.
    rows = []
    for t in trees:
        xr, yr = t['geometrie']['coordinates'][:2]
        if not inside(xr, yr):
            continue
        g = float(np.nanmedian(around(dtm, xr, yr, 1.5)))
        crown = around(veg, xr, yr, 3.0)
        top = float(crown.max()) if np.isfinite(crown).any() else float('nan')
        h_lidar = round(top - g, 1) if np.isfinite(top) and top - g > 2 else None
        cls = t.get('boomhoogteklasseActueel') or ''
        lon, lat = rd2wgs.transform(xr, yr)
        rows.append((str(t['id']), t.get('soortnaam'), t.get('soortnaamTop'), cls,
                     HEIGHT_CLASS.get(cls[:1]), t.get('jaarVanAanleg'), lon, lat, round(g, 2), h_lidar))
    con.execute("""CREATE TABLE t (tree_id VARCHAR, species VARCHAR, genus VARCHAR,
        height_class VARCHAR, class_m DOUBLE, planted INTEGER, longitude DOUBLE, latitude DOUBLE,
        ground_nap DOUBLE, height_lidar DOUBLE)""")
    con.executemany('INSERT INTO t VALUES (?,?,?,?,?,?,?,?,?,?)', rows)
    con.execute(f"COPY t TO '{OUT}/trees.parquet.tmp' (FORMAT parquet)")
    print(f'trees.parquet: {len(rows)}', flush=True)

    # Monuments by footprint, to name the buildings they stand on.
    mons = []
    for m in monuments:
        if not m.get('geometrie') or m.get('type') not in ('Pand', None):
            continue
        try:
            mons.append((shape(m['geometrie']), m))
        except Exception:
            continue

    # Buildings, with the height the LiDAR measures and the monument on most of the footprint.
    rows = []
    ny, nx = dsm.shape
    cx = X0 + (np.arange(nx) + 0.5) * CELL
    cy = Y1 - (np.arange(ny) + 0.5) * CELL
    for b in panden:
        try:
            geom = shape(b['geometrie'])
        except Exception:
            continue
        if geom.is_empty or not geom.intersects(shapely.box(X0, Y0, X1, Y1)):
            continue
        bx0, by0, bx1, by1 = geom.bounds
        i0, i1 = max(int((bx0 - X0) / CELL), 0), min(int((bx1 - X0) / CELL) + 1, nx)
        j0, j1 = max(int((Y1 - by1) / CELL), 0), min(int((Y1 - by0) / CELL) + 1, ny)
        h_lidar = roof = None
        g = None
        if i1 > i0 and j1 > j0:
            gx, gy = np.meshgrid(cx[i0:i1], cy[j0:j1])
            inb = shapely.contains_xy(geom, gx, gy)
            if inb.sum() >= 4:
                # The ground beside the building: the filled ground model just outside it.
                ring = shapely.contains_xy(geom.buffer(3).difference(geom), gx, gy)
                g = float(np.median(dtm[j0:j1, i0:i1][ring])) if ring.any() else float(np.median(dtm[j0:j1, i0:i1][inb]))
                tops = dsm[j0:j1, i0:i1][inb]
                roof = float(np.percentile(tops, 90))
                h_lidar = round(roof - g, 1)
        name = status = architect = None
        for mg, m in mons:
            try:
                if mg.intersects(geom) and mg.intersection(geom).area > 0.5 * geom.area:
                    name = m.get('naam') or m.get('weergavenaam')
                    status = m.get('status')
                    architect = m.get('architectOntwerp')
                    break
            except Exception:
                continue
        ring_rd = shapely.get_coordinates(geom.exterior if geom.geom_type == 'Polygon' else geom.convex_hull.exterior)
        lon, lat = rd2wgs.transform(ring_rd[:, 0], ring_rd[:, 1])
        wkt = 'POLYGON((' + ','.join(f'{a:.7f} {b:.7f}' for a, b in zip(lon, lat)) + '))'
        built = b.get('oorspronkelijkBouwjaar')
        rows.append((b['identificatie'], int(built) if built else None, b.get('statusOmschrijving'),
                     name, status, architect, wkt, round(g, 2) if g is not None else None, h_lidar,
                     round(geom.area, 1)))
    con.execute("""CREATE TABLE b (building_id VARCHAR, built INTEGER, status VARCHAR,
        monument VARCHAR, monument_status VARCHAR, architect VARCHAR, geometry VARCHAR,
        ground_nap DOUBLE, height_lidar DOUBLE, area_m2 DOUBLE)""")
    con.executemany('INSERT INTO b VALUES (?,?,?,?,?,?,?,?,?,?)', rows)
    con.execute(f"COPY b TO '{OUT}/buildings.parquet.tmp' (FORMAT parquet)")
    print(f'buildings.parquet: {len(rows)}, {sum(1 for r in rows if r[3])} with a monument', flush=True)

    # Monuments that are not a building (a statue, a bridge, a pump), where they stand.
    rows = []
    for m in monuments:
        if m.get('type') == 'Pand':
            continue
        pt = m.get('puntCoordinaten') or {}
        xy = pt.get('coordinates')
        if not xy or not inside(xy[0], xy[1]):
            continue
        g = float(np.nanmedian(around(dtm, xy[0], xy[1], 1.5)))
        top = float(np.max(around(dsm, xy[0], xy[1], 2.0)))
        lon, lat = rd2wgs.transform(xy[0], xy[1])
        rows.append((m.get('monumentnummer'), m.get('naam') or m.get('weergavenaam'), m.get('type'),
                     m.get('status'), m.get('architectOntwerp'), lon, lat, round(g, 2),
                     round(max(top - g, 0), 1)))
    con.execute("""CREATE TABLE m (monument_id VARCHAR, name VARCHAR, kind VARCHAR, status VARCHAR,
        architect VARCHAR, longitude DOUBLE, latitude DOUBLE, ground_nap DOUBLE, height_lidar DOUBLE)""")
    con.executemany('INSERT INTO m VALUES (?,?,?,?,?,?,?,?,?)', rows)
    con.execute(f"COPY m TO '{OUT}/monuments.parquet.tmp' (FORMAT parquet)")
    print(f'monuments.parquet: {len(rows)}', flush=True)

    tiles(x, y, z, ground)

    w0, s0 = rd2wgs.transform(X0, Y0)
    e0, n0 = rd2wgs.transform(X1, Y1)
    con.execute(f"""COPY (SELECT now() AS built_at, {w0} AS west, {s0} AS south, {e0} AS east,
        {n0} AS north, {ground} AS street_nap, {len(x)} AS lidar_points)
        TO '{OUT}/meta.parquet.tmp' (FORMAT parquet)""")
    for name in ('panoramas', 'trees', 'buildings', 'monuments', 'meta'):
        os.replace(f'{OUT}/{name}.parquet.tmp', f'{OUT}/{name}.parquet')


main()
