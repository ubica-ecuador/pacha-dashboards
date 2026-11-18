"""Eraring Power Station as a schematic 3D model, for the aemo-eraring-live dashboard.

Run by build.sh (python -I build.py <out>) with DuckDB (spatial, httpfs), NumPy and mapbox_earcut installed.
Reads the buildings around the station from Overture Maps (OpenStreetMap and Microsoft's footprints) and writes
to <out>:

- model.glb: the main block (OpenStreetMap's "Turbine Hall" footprint) cut into its four units along its length,
  each a turbine house and a taller boiler house in one glTF node named by the unit's AEMO id (ER01 to ER04), the
  two 200 m chimneys, and every other building around as context, extruded to its height (6 m when it has none).
  Metres, Y up, -Z north, the origin at the centre of the main block.
- units.parquet: each unit's id, name, registered capacity and where its part of the block stands.

A schematic, not a survey: which end of the block is unit 1, the heights of the houses and where the chimneys stand
are drawn from the station's public description, not measured.
"""
import json
import math
import struct
import sys
from pathlib import Path

import duckdb
import numpy as np
from mapbox_earcut import triangulate_float64

RELEASE = '2026-10-21.0'
BBOX = (151.508, -33.072, 151.532, -33.052)
UNITS = ['ER01', 'ER02', 'ER03', 'ER04']
CAPACITY_MW = 720  # each, AEMO's registered capacity
TURBINE_H, BOILER_H, STACK_H, STACK_R = 32.0, 72.0, 200.0, 9.0
# Context light and plain, so a stopped unit (grey in the dashboard) does not read as one of them.
COLOUR = {'unit': '#b9bcc0', 'stack': '#d8d4cc', 'context': '#cfc8bb'}


def linear(hex_colour):
    return [((int(hex_colour[i:i + 2], 16) / 255) ** 2.2) for i in (1, 3, 5)] + [1.0]


def buildings():
    c = duckdb.connect()
    c.execute('INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs')
    c.execute("SET s3_region = 'us-west-2'; SET geometry_always_xy = true")
    xmin, ymin, xmax, ymax = BBOX
    return c.execute(f"""
        SELECT names.primary AS name, coalesce(height, num_floors * 3.5) AS height,
               ST_AsGeoJSON(geometry) AS geojson
        FROM read_parquet('s3://overturemaps-us-west-2/release/{RELEASE}/theme=buildings/type=building/*',
                          hive_partitioning = 1)
        WHERE bbox.xmin > {xmin} AND bbox.xmax < {xmax} AND bbox.ymin > {ymin} AND bbox.ymax < {ymax}""").fetchall()


class Local:
    """Longitude and latitude to metres east and north of an origin (equirectangular: a few hundred metres)."""

    def __init__(self, lon, lat):
        self.lon, self.lat = lon, lat
        self.kx = 111320 * math.cos(math.radians(lat))
        self.ky = 110574

    def __call__(self, ring):
        a = np.asarray(ring, dtype=float)
        return np.column_stack([(a[:, 0] - self.lon) * self.kx, (a[:, 1] - self.lat) * self.ky])

    def back(self, x, y):
        return self.lon + x / self.kx, self.lat + y / self.ky


def prism(ring, z0, z1):
    """A polygon (outer ring, metres) extruded from z0 to z1: (vertices east/north/up, triangle indices)."""
    ring = np.asarray(ring, dtype=float)
    if np.allclose(ring[0], ring[-1]):
        ring = ring[:-1]
    n = len(ring)
    if n < 3:
        return None
    tri = np.asarray(triangulate_float64(ring, np.array([n], dtype=np.uint32)), dtype=np.uint32).reshape(-1, 3)
    # Counter-clockwise from above, so the roof faces up and the walls out.
    if np.sum(ring[:, 0] * np.roll(ring[:, 1], -1) - np.roll(ring[:, 0], -1) * ring[:, 1]) < 0:
        ring = ring[::-1]
        tri = np.asarray(triangulate_float64(ring, np.array([n], dtype=np.uint32)), dtype=np.uint32).reshape(-1, 3)
    bottom = np.column_stack([ring, np.full(n, z0)])
    top = np.column_stack([ring, np.full(n, z1)])
    verts = [top, bottom]
    faces = [tri, tri[:, ::-1] + n]
    for i in range(n):
        j = (i + 1) % n
        a, b = ring[i], ring[j]
        base = 2 * n + 4 * i
        verts.append(np.array([[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]]))
        faces.append(np.array([[base, base + 1, base + 2], [base, base + 2, base + 3]], dtype=np.uint32))
    return np.vstack(verts), np.vstack(faces).astype(np.uint32)


def cylinder(cx, cy, r, z0, z1, sides=24):
    angles = np.linspace(0, 2 * math.pi, sides, endpoint=False)
    return prism(np.column_stack([cx + r * np.cos(angles), cy + r * np.sin(angles)]), z0, z1)


def rectangle(centre, along, across, half_len, half_wid):
    c = np.asarray(centre)
    return np.array([c - along * half_len - across * half_wid, c + along * half_len - across * half_wid,
                     c + along * half_len + across * half_wid, c - along * half_len + across * half_wid])


def min_rectangle(ring):
    """The smallest rectangle around a ring: centre, long axis, short axis, half length, half width."""
    pts = np.asarray(ring, dtype=float)
    best = None
    for k in range(len(pts) - 1):
        edge = pts[k + 1] - pts[k]
        if np.hypot(*edge) == 0:
            continue
        u = edge / np.hypot(*edge)
        v = np.array([-u[1], u[0]])
        pu, pv = pts @ u, pts @ v
        area = (pu.max() - pu.min()) * (pv.max() - pv.min())
        if best is None or area < best[0]:
            best = (area, u, v, pu, pv)
    _, u, v, pu, pv = best
    if pu.max() - pu.min() < pv.max() - pv.min():
        u, v, pu, pv = v, -u, pv, -pu
    centre = u * (pu.max() + pu.min()) / 2 + v * (pv.max() + pv.min()) / 2
    # The long axis runs west to east (or south to north), so unit 1 is the western (southern) end.
    if u[0] < -1e-9 or (abs(u[0]) < 1e-9 and u[1] < 0):
        u, v = -u, -v
    return centre, u, v, (pu.max() - pu.min()) / 2, (pv.max() - pv.min()) / 2


def write_glb(path, parts):
    """parts: [(name, kind, vertices east/north/up, indices)]; one mesh per part, glTF's Y up and -Z north."""
    kinds = sorted({kind for _, kind, _, _ in parts})
    material_of = {kind: i for i, kind in enumerate(kinds)}
    blob = bytearray()
    views, accessors, meshes, nodes = [], [], [], []

    def add(data, target):
        while len(blob) % 4:
            blob.append(0)
        views.append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(data), 'target': target})
        blob.extend(data)
        return len(views) - 1

    by_name = {}
    for name, kind, verts, faces in parts:
        by_name.setdefault((name, kind), []).append((verts, faces))
    for (name, kind), pieces in by_name.items():
        verts = np.vstack([v for v, _ in pieces])
        offsets = np.cumsum([0] + [len(v) for v, _ in pieces[:-1]])
        faces = np.vstack([f + o for (_, f), o in zip(pieces, offsets)]).astype(np.uint32)
        gl = np.column_stack([verts[:, 0], verts[:, 2], -verts[:, 1]]).astype(np.float32)
        pv = add(gl.tobytes(), 34962)
        accessors.append({'bufferView': pv, 'componentType': 5126, 'count': len(gl), 'type': 'VEC3',
                          'min': gl.min(axis=0).tolist(), 'max': gl.max(axis=0).tolist()})
        iv = add(faces.reshape(-1).tobytes(), 34963)
        accessors.append({'bufferView': iv, 'componentType': 5125, 'count': faces.size, 'type': 'SCALAR'})
        meshes.append({'primitives': [{'attributes': {'POSITION': len(accessors) - 2}, 'indices': len(accessors) - 1,
                                       'material': material_of[kind]}]})
        nodes.append({'name': name, 'mesh': len(meshes) - 1})
    doc = {
        'asset': {'version': '2.0', 'generator': 'pacha datasets/eraring/build.py',
                  'copyright': 'Footprints: Overture Maps Foundation, OpenStreetMap contributors (ODbL), '
                               'Microsoft (ODbL). Schematic units and chimneys: Pacha.'},
        'scene': 0, 'scenes': [{'nodes': list(range(len(nodes)))}], 'nodes': nodes, 'meshes': meshes,
        'materials': [{'name': k, 'pbrMetallicRoughness': {'baseColorFactor': linear(COLOUR[k]), 'metallicFactor': 0,
                                                            'roughnessFactor': 0.9}} for k in kinds],
        'accessors': accessors, 'bufferViews': views, 'buffers': [{'byteLength': len(blob)}],
    }
    text = json.dumps(doc, separators=(',', ':')).encode()
    text += b' ' * (-len(text) % 4)
    blob.extend(b'\0' * (-len(blob) % 4))
    with open(path, 'wb') as fh:
        fh.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(text) + 8 + len(blob)))
        fh.write(struct.pack('<II', len(text), 0x4E4F534A) + text)
        fh.write(struct.pack('<II', len(blob), 0x004E4942) + bytes(blob))


def main(out):
    out = Path(out)
    found = buildings()
    halls = [b for b in found if b[0] == 'Turbine Hall']
    if len(halls) != 1:
        sys.exit(f'expected one "Turbine Hall" around Eraring, found {len(halls)}')
    hall_ring = json.loads(halls[0][2])['coordinates'][0]
    hall_lonlat = np.asarray(hall_ring)
    origin = Local(*hall_lonlat[:-1].mean(axis=0))
    hall = origin(hall_ring)
    centre, along, across, half_len, half_wid = min_rectangle(hall)
    centre_lon, centre_lat = origin.back(*centre)
    origin = Local(centre_lon, centre_lat)
    hall = origin(hall_ring)
    centre, along, across, half_len, half_wid = min_rectangle(hall)

    parts, units = [], []
    cell = 2 * half_len / len(UNITS)
    for i, duid in enumerate(UNITS):
        mid = centre + along * (-half_len + cell * (i + 0.5))
        # The turbine house along one long side, the boiler house, taller, behind it.
        turbine = rectangle(mid - across * half_wid * 0.55, along, across, cell / 2 * 0.94, half_wid * 0.45)
        boiler = rectangle(mid + across * half_wid * 0.45, along, across, cell / 2 * 0.80, half_wid * 0.55)
        for ring, h in ((turbine, TURBINE_H), (boiler, BOILER_H)):
            parts.append((duid, 'unit', *prism(ring, 0, h)))
        lon, lat = origin.back(*mid)
        units.append((duid, f'Eraring unit {i + 1}', CAPACITY_MW, lat, lon))
    # One chimney for each pair of units, behind the boiler houses.
    for k, between in enumerate((1, 3)):
        at = centre + along * (-half_len + cell * between) + across * (half_wid + 25)
        parts.append((f'chimney-{k + 1}', 'stack', *cylinder(at[0], at[1], STACK_R, 0, STACK_H)))
    for n, (name, height, geojson) in enumerate(found):
        if name == 'Turbine Hall':
            continue
        geom = json.loads(geojson)
        polygons = geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]
        for poly in polygons:
            made = prism(origin(poly[0]), 0, float(height) if height and height > 1 else 6.0)
            if made:
                parts.append((f'building-{n}', 'context', *made))
    write_glb(out / 'model.glb', parts)
    c = duckdb.connect()
    c.execute('CREATE TABLE units (duid VARCHAR, name VARCHAR, capacity_mw DOUBLE, latitude DOUBLE, longitude DOUBLE)')
    c.executemany('INSERT INTO units VALUES (?, ?, ?, ?, ?)', units)
    c.execute(f"COPY (SELECT *, {centre_lat} AS origin_latitude, {centre_lon} AS origin_longitude FROM units "
              f"ORDER BY duid) TO '{out / 'units.parquet'}' (FORMAT parquet)")
    print(f'{len(parts)} pieces in model.glb ({(out / "model.glb").stat().st_size / 1e3:.0f} kB); block '
          f'{2 * half_len:.0f} x {2 * half_wid:.0f} m, its long axis {math.degrees(math.atan2(along[0], along[1])):.0f} '
          f'deg from north; origin {centre_lat:.6f}, {centre_lon:.6f}')


if __name__ == '__main__':
    main(sys.argv[1])
