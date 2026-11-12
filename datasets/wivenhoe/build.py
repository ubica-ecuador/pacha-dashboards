"""Wivenhoe Power Station as a schematic 3D model, for the wivenhoe-pumped-hydro dashboard.

Run by build.sh (python build.py <osm.json> <out>) with DuckDB, NumPy and mapbox_earcut installed. Reads
OpenStreetMap's data around the station and writes to <out>:

- model.glb: the machine hall (OpenStreetMap's footprint, drawn as its frame), and under it the two concrete silos
  (drawn as their ribs and rings), one unit in each: the motor-generator, the shaft, the pump-turbine in its spiral case, the spherical valve where the
  penstock comes in, and the draft tube out to Lake Wivenhoe; the floors of each silo; each unit's penstock from its
  intake tower in Splityard Creek Dam (OpenStreetMap's two underground pipelines) and its transformer bay (the two
  substations beside the hall). All opaque, so nothing hides the machines. Every part of a unit is one glTF node named U<n>-<part>. Metres, Y up, -Z north,
  the origin at the centre of the hall.
- units.parquet: each unit's AEMO ids (generating and pumping), ratings, where its silo stands, the model's origin.
- parts.parquet: every named part: its unit, what it is, the floor it stands on.
- floors.parquet: the floors, for the map's floor picker: the ground over the station (round the hall and all that is
  drawn under it) and each silo's three floors round its machine pit, in longitude and latitude; the map lifts each
  to its level.
- water.parquet: each unit's water path from the intake to the outlet, in the model's metres (model_geometry).

A schematic, not a survey. The silos' size (about 32 m internal diameter) and the units' ratings are the station's
public description; how deep the silos go, the floors' levels, the machines' sizes, which silo is unit 1 and where
the silos stand under the hall are drawn, not measured. The map is flat (Splityard Creek Dam, about 100 m above Lake
Wivenhoe, lies at the same level), and nothing the map draws hides what is under it: a part drawn underground seems to
slide off its place when the map is tilted. So only the silos and the draft tubes, under the hall and the lake, are
drawn below ground; the penstocks lie on the ground along OpenStreetMap's routes, as their depth in the hill is not
known, and drop down a shaft beside the hall into their silos, and the intake towers stand from the water up.
"""
import json
import math
import struct
import sys
from pathlib import Path

import duckdb
import numpy as np
from mapbox_earcut import triangulate_float64

HALL_WAY = 1150669744  # building=yes: the machine hall over the lake's edge
BAY_WAYS = (1150669733, 1150669734)  # power=substation: the two transformer bays beside the hall
PIER_WAY = 1150669735  # man_made=pier: the walkway out to the intake towers
UNITS = [
    # unit, AEMO id generating, AEMO id pumping (a load), MW as a generator, MW as a motor (AEMO, Wikipedia)
    (1, 'W/HOE#1', 'PUMP1', 285, 240),
    (2, 'W/HOE#2', 'PUMP2', 285, 240),
]
# The floors of a silo, deck = 0 m: id, name, level of its slab.
FLOORS = [('0', 'Hall, transformers and intakes', 0.0), ('-1', 'Generator floor', -20.0),
          ('-2', 'Turbine floor', -32.0), ('-3', 'Draft tube floor', -44.0)]
SILO_R_IN, SILO_R_OUT, SILO_GAP = 16.0, 18.5, 9.0  # 32 m inside (Wikipedia); 2.5 m of wall; between the two
SILO_BOTTOM, HALL_H = -48.0, 22.0
PIPE_R = 3.5  # about 425 m3/s at full load through a 76 m head: a pipe some 7 m across
# Everything opaque: a see-through part writes depth and hides the machines inside it. The silos are cages of ribs
# and rings and the hall a frame of columns and beams, so the machines show; the floors are the dashboard's own
# (floors.parquet, drawn by the map's floor picker).
COLOUR = {'machine': ('#b9bcc0', 1.0), 'frame': ('#dcd6cb', 1.0), 'context': ('#d6d0c4', 1.0)}


def linear(hex_colour, alpha):
    return [((int(hex_colour[i:i + 2], 16) / 255) ** 2.2) for i in (1, 3, 5)] + [alpha]


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
    # Counter-clockwise from above, so the roof faces up and the walls out.
    if np.sum(ring[:, 0] * np.roll(ring[:, 1], -1) - np.roll(ring[:, 0], -1) * ring[:, 1]) < 0:
        ring = ring[::-1]
    tri = np.asarray(triangulate_float64(ring, np.array([n], dtype=np.uint32)), dtype=np.uint32).reshape(-1, 3)
    verts = [np.column_stack([ring, np.full(n, z1)]), np.column_stack([ring, np.full(n, z0)])]
    faces = [tri, tri[:, ::-1] + n]
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]
        base = 2 * n + 4 * i
        verts.append(np.array([[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]]))
        faces.append(np.array([[base, base + 1, base + 2], [base, base + 2, base + 3]], dtype=np.uint32))
    return np.vstack(verts), np.vstack(faces).astype(np.uint32)


def circle(cx, cy, r, sides):
    a = np.linspace(0, 2 * math.pi, sides, endpoint=False)
    return np.column_stack([cx + r * np.cos(a), cy + r * np.sin(a)])


def cylinder(cx, cy, r, z0, z1, sides=32):
    return prism(circle(cx, cy, r, sides), z0, z1)


def annulus(cx, cy, r_in, r_out, z0, z1, sides=64):
    """A ring (a silo's wall, a floor round the machine pit) from z0 to z1."""
    inner, outer = circle(cx, cy, r_in, sides), circle(cx, cy, r_out, sides)
    verts, faces = [], []

    def quad(a, b, c, d):
        base = sum(len(v) for v in verts)
        verts.append(np.array([a, b, c, d]))
        faces.append(np.array([[base, base + 1, base + 2], [base, base + 2, base + 3]], dtype=np.uint32))

    for i in range(sides):
        j = (i + 1) % sides
        oi, oj, ii, ij = outer[i], outer[j], inner[i], inner[j]
        quad([*ii, z1], [*oi, z1], [*oj, z1], [*ij, z1])  # top, facing up
        quad([*oi, z0], [*ii, z0], [*ij, z0], [*oj, z0])  # bottom, facing down
        quad([*oi, z0], [*oj, z0], [*oj, z1], [*oi, z1])  # outer wall, facing out
        quad([*ij, z0], [*ii, z0], [*ii, z1], [*ij, z1])  # inner wall, facing in
    return np.vstack(verts), np.vstack(faces)


def sphere(c, r, rings=10, sides=16):
    verts, faces = [], []
    for i in range(rings + 1):
        phi = math.pi * i / rings
        for j in range(sides):
            th = 2 * math.pi * j / sides
            verts.append([c[0] + r * math.sin(phi) * math.cos(th), c[1] + r * math.sin(phi) * math.sin(th),
                          c[2] + r * math.cos(phi)])
    for i in range(rings):
        for j in range(sides):
            a, b = i * sides + j, i * sides + (j + 1) % sides
            faces += [[a, a + sides, b], [b, a + sides, b + sides]]
    return np.asarray(verts, dtype=float), np.asarray(faces, dtype=np.uint32)


def tube(points, r, sides=16):
    """A pipe of radius r along a polyline of [x, y, z] points, with a ball at each bend."""
    pts = np.asarray(points, dtype=float)
    verts, faces = [], []
    for a, b in zip(pts[:-1], pts[1:]):
        t = (b - a) / np.linalg.norm(b - a)
        n1 = np.cross(t, [0, 0, 1.0])
        if np.linalg.norm(n1) < 1e-6:
            n1 = np.cross(t, [1.0, 0, 0])
        n1 /= np.linalg.norm(n1)
        n2 = np.cross(t, n1)
        ring = [np.cos(2 * math.pi * k / sides) * n1 + np.sin(2 * math.pi * k / sides) * n2 for k in range(sides)]
        base = sum(len(v) for v in verts)
        verts.append(np.array([a + r * d for d in ring] + [b + r * d for d in ring]))
        for k in range(sides):
            m = (k + 1) % sides
            faces.append([base + k, base + m, base + sides + m])
            faces.append([base + k, base + sides + m, base + sides + k])
    v, f = np.vstack(verts), np.asarray(faces, dtype=np.uint32)
    for p in pts[1:-1]:
        sv, sf = sphere(p, r * 1.02, 8, sides)
        f = np.vstack([f, sf + len(v)])
        v = np.vstack([v, sv])
    return v, f


def normals_of(verts, faces):
    """Per-vertex normals: smooth where faces share a vertex, flat where each face has its own."""
    n = np.zeros_like(verts)
    a, b, c = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
    fn = np.cross(b - a, c - a)
    for k in range(3):
        np.add.at(n, faces[:, k], fn)
    length = np.linalg.norm(n, axis=1, keepdims=True)
    return n / np.where(length == 0, 1, length)


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
    # The long axis points north (or east), so the first silo along it is the southern one.
    if u[1] < -1e-9 or (abs(u[1]) < 1e-9 and u[0] < 0):
        u, v = -u, -v
    centre = u * (pu.max() + pu.min()) / 2 + v * (pv.max() + pv.min()) / 2
    return centre, u, v, (pu.max() - pu.min()) / 2, (pv.max() - pv.min()) / 2


def write_glb(path, parts):
    """parts: [(name, kind, vertices east/north/up, indices)]; one mesh per name, glTF's Y up and -Z north."""
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
        normal = normals_of(verts, faces)
        gl = np.column_stack([verts[:, 0], verts[:, 2], -verts[:, 1]]).astype(np.float32)
        gn = np.column_stack([normal[:, 0], normal[:, 2], -normal[:, 1]]).astype(np.float32)
        pv = add(gl.tobytes(), 34962)
        accessors.append({'bufferView': pv, 'componentType': 5126, 'count': len(gl), 'type': 'VEC3',
                          'min': gl.min(axis=0).tolist(), 'max': gl.max(axis=0).tolist()})
        nv = add(gn.tobytes(), 34962)
        accessors.append({'bufferView': nv, 'componentType': 5126, 'count': len(gn), 'type': 'VEC3'})
        iv = add(faces.reshape(-1).tobytes(), 34963)
        accessors.append({'bufferView': iv, 'componentType': 5125, 'count': faces.size, 'type': 'SCALAR'})
        meshes.append({'primitives': [{'attributes': {'POSITION': len(accessors) - 3, 'NORMAL': len(accessors) - 2},
                                       'indices': len(accessors) - 1, 'material': material_of[kind]}]})
        nodes.append({'name': name, 'mesh': len(meshes) - 1})

    def material(kind):
        colour, alpha = COLOUR[kind]
        m = {'name': kind, 'pbrMetallicRoughness': {'baseColorFactor': linear(colour, alpha), 'metallicFactor': 0,
                                                     'roughnessFactor': 0.85}}
        if alpha < 1:
            m.update({'alphaMode': 'BLEND', 'doubleSided': True})
        return m

    doc = {
        'asset': {'version': '2.0', 'generator': 'pacha-dashboards datasets/wivenhoe/build.py',
                  'copyright': 'Hall, transformer bays, intake towers and penstock routes: OpenStreetMap contributors '
                               '(ODbL). Silos and machines: a schematic by Pacha.'},
        'scene': 0, 'scenes': [{'nodes': list(range(len(nodes)))}], 'nodes': nodes, 'meshes': meshes,
        'materials': [material(k) for k in kinds],
        'accessors': accessors, 'bufferViews': views, 'buffers': [{'byteLength': len(blob)}],
    }
    text = json.dumps(doc, separators=(',', ':')).encode()
    text += b' ' * (-len(text) % 4)
    blob.extend(b'\0' * (-len(blob) % 4))
    with open(path, 'wb') as fh:
        fh.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(text) + 8 + len(blob)))
        fh.write(struct.pack('<II', len(text), 0x4E4F534A) + text)
        fh.write(struct.pack('<II', len(blob), 0x004E4942) + bytes(blob))


def osm_ways(path):
    data = json.load(open(path))
    nodes = {e['id']: (e['lon'], e['lat']) for e in data['elements'] if e['type'] == 'node'}
    ways = {}
    for e in data['elements']:
        if e['type'] == 'way':
            ways[e['id']] = (e.get('tags', {}), [nodes[n] for n in e['nodes'] if n in nodes])
    return ways


def way(ways, wid, **tags):
    if wid not in ways or any(ways[wid][0].get(k) != v for k, v in tags.items()):
        sys.exit(f'OpenStreetMap way {wid} with {tags} is not around the station any more: check build.py')
    return ways[wid][1]


def main(osm_path, out):
    out = Path(out)
    ways = osm_ways(osm_path)
    hall_lonlat = way(ways, HALL_WAY, building='yes')
    bays_lonlat = [way(ways, w, power='substation') for w in BAY_WAYS]
    pier_lonlat = way(ways, PIER_WAY, man_made='pier')
    penstocks = [pts for tags, pts in ways.values()
                 if tags.get('man_made') == 'pipeline' and tags.get('substance') == 'water'
                 and tags.get('location') == 'underground']
    if len(penstocks) != 2:
        sys.exit(f'expected two underground water pipelines between the dams, found {len(penstocks)}')

    first = Local(*np.asarray(hall_lonlat[:-1]).mean(axis=0))
    centre, _, _, _, _ = min_rectangle(first(hall_lonlat))
    origin = Local(*first.back(*centre))
    hall = origin(hall_lonlat)
    centre, along, across, half_len, half_wid = min_rectangle(hall)

    # Each pipeline runs from an intake tower (the end in the upper dam, north-east) to the hall.
    pipes = []
    for pts in penstocks:
        a, b = origin(pts[:1])[0], origin(pts[-1:])[0]
        intake, plant = (a, b) if np.hypot(*a) > np.hypot(*b) else (b, a)
        pipes.append((intake, plant))
    # The silos stand on the hall's long axis, side by side, centred where the two penstocks arrive.
    arrive = np.mean([p for _, p in pipes], axis=0)
    t = float((arrive - centre) @ along)
    step = SILO_R_OUT + SILO_GAP / 2
    silos = [centre + along * (t - step), centre + along * (t + step)]  # south first: unit 1
    # Each penstock to the silo nearer its end; each transformer bay to the silo nearer its centre.
    pipe_of = sorted(range(2), key=lambda k: np.hypot(*(pipes[k][1] - silos[0])))
    bays = [origin(r) for r in bays_lonlat]
    bay_of = sorted(range(2), key=lambda k: np.hypot(*(bays[k][:-1].mean(axis=0) - silos[0])))

    parts, part_rows, water_rows, unit_rows, floor_rows = [], [], [], [], []
    below = [hall]  # what the ground over the station covers: the hall, and all that is drawn under it
    level_name = {f: name for f, name, _ in FLOORS}

    def part(name, kind, label, floor, mesh, unit):
        verts, faces = mesh
        parts.append((name, 'machine', verts, faces))
        part_rows.append((name, unit, f'Unit {unit}', kind, label, floor, level_name[floor]))

    for k, (unit, gen_id, pump_id, gen_mw, pump_mw) in enumerate(UNITS):
        s = silos[k]
        intake, _ = pipes[pipe_of[k]]
        towards = (intake - s) / np.hypot(*(intake - s))  # from the silo to its intake, up the hill
        name = f'U{unit}'
        # The silo, as its ribs and rings; its floors round the machine pit are floors.parquet's.
        parts.append((f'silo-{unit}', 'frame', *cage(s)))
        for floor, floor_name, _ in FLOORS[1:]:
            outer = annulus_ring(origin, s, SILO_R_IN)
            pit = annulus_ring(origin, s, 10.5)[::-1]
            floor_rows.append((floor, floor_name, unit, f'Unit {unit} silo, {floor_name.lower()}',
                               json.dumps({'type': 'Polygon', 'coordinates': [outer, pit]})))
        # Motor-generator over the generator floor; the shaft down to the pump-turbine in its spiral case.
        stator = cylinder(*s, 8.0, -20.0, -12.0, 40)
        rotor = cylinder(*s, 6.0, -12.0, -10.0, 40)
        part(f'{name}-generator', 'Motor-generator', f'Unit {unit} motor-generator', '-1', merge(stator, rotor), unit)
        shaft = cylinder(*s, 1.2, -29.0, -20.0, 16)
        case = cylinder(*s, 10.0, -33.0, -29.0, 48)
        runner = cylinder(*s, 3.6, -36.0, -33.0, 32)
        part(f'{name}-turbine', 'Pump-turbine', f'Unit {unit} pump-turbine', '-2', merge(shaft, case, runner), unit)
        valve_at = np.array([*(s + towards * 13.0), -31.0])
        part(f'{name}-valve', 'Spherical valve', f'Unit {unit} inlet valve', '-2', sphere(valve_at, 4.6, 12, 20), unit)
        # The penstock: from the intake tower on the ground along its route, down a shaft beside the hall, into the
        # silo at the valve.
        outside = s + towards * (SILO_R_OUT + 6.0)
        pen_path = [[*intake, PIPE_R], [*outside, PIPE_R], [*outside, -31.0], valve_at.tolist()]
        part(f'{name}-penstock', 'Penstock', f'Unit {unit} penstock', '-2', tube(pen_path, PIPE_R), unit)
        # The draft tube: down from the runner, then out under the lake's edge, away from the hill.
        lake = -towards
        draft_path = [[*s, -36.0], [*s, -42.0], [*(s + lake * (SILO_R_OUT + 10.0)), -42.0],
                      [*(s + lake * (SILO_R_OUT + 30.0)), -16.0]]
        part(f'{name}-draft', 'Draft tube', f'Unit {unit} draft tube', '-3', tube(draft_path, PIPE_R + 0.8), unit)
        below += [circle(*s, SILO_R_OUT + 4, 32), circle(*outside, PIPE_R + 4, 12),
                  circle(*draft_path[-1][:2], PIPE_R + 5, 12)]
        # The intake tower in Splityard Creek Dam, and the transformer bay beside the hall.
        part(f'{name}-intake', 'Intake tower', f'Unit {unit} intake tower', '0', cylinder(*intake, 8.2, 0.0, 14.0, 40),
             unit)
        part(f'{name}-transformer', 'Transformer', f'Unit {unit} transformer', '0', prism(bays[bay_of[k]], 0, 9.0),
             unit)
        # The water's whole way, for the Pipeline layer: generating it runs this way, pumping the other.
        path = [*pen_path, [*(s + towards * 9.0), -31.0],
                [*s, -34.5], *draft_path[1:]]
        length = sum(math.dist(a, b) for a, b in zip(path[:-1], path[1:]))
        water_rows.append((unit, f'Unit {unit}', json.dumps({'type': 'LineString',
                                                             'coordinates': [[round(c, 2) for c in p] for p in path]}),
                           round(length)))
        lon, lat = origin.back(*s)
        unit_rows.append((unit, f'Unit {unit}', gen_id, pump_id, gen_mw, pump_mw, lat, lon,
                          round(float(s[0]), 2), round(float(s[1]), 2)))

    # The hall over both silos as its frame; the pier out to the intake towers. The hall's floor is the ground over
    # the station (floors.parquet), drawn dark and see-through over all that lies under it: the map itself hides
    # nothing below ground, and without it the silos seem to hang in the air when the map is tilted.
    parts.append(('hall', 'frame', *frame(hall, HALL_H)))
    ground = [[round(x, 8), round(y, 8)] for x, y in (origin.back(*p) for p in hull(np.vstack(below)))]
    floor_rows.append(('0', FLOORS[0][1], None, 'Ground and lake over the silos',
                       json.dumps({'type': 'Polygon', 'coordinates': [ground]})))
    pier = origin(pier_lonlat)
    parts.append(('pier', 'context', *prism(pier, 8.0, 9.5)))
    write_glb(out / 'model.glb', parts)

    olon, olat = origin.lon, origin.lat
    c = duckdb.connect()
    c.execute('CREATE TABLE units (unit INTEGER, name VARCHAR, gen_duid VARCHAR, pump_duid VARCHAR, gen_mw DOUBLE, '
              'pump_mw DOUBLE, latitude DOUBLE, longitude DOUBLE, silo_x DOUBLE, silo_y DOUBLE)')
    c.executemany('INSERT INTO units VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', unit_rows)
    c.execute(f"COPY (SELECT *, {olat} AS origin_latitude, {olon} AS origin_longitude FROM units ORDER BY unit) "
              f"TO '{out / 'units.parquet'}' (FORMAT parquet)")
    c.execute('CREATE TABLE parts (part VARCHAR, unit INTEGER, unit_name VARCHAR, kind VARCHAR, label VARCHAR, '
              'level VARCHAR, floor_name VARCHAR)')
    c.executemany('INSERT INTO parts VALUES (?, ?, ?, ?, ?, ?, ?)', part_rows)
    c.execute(f"COPY (SELECT * FROM parts ORDER BY unit, part) TO '{out / 'parts.parquet'}' (FORMAT parquet)")
    c.execute('CREATE TABLE water (unit INTEGER, name VARCHAR, model_geometry VARCHAR, length_m DOUBLE)')
    c.executemany('INSERT INTO water VALUES (?, ?, ?, ?)', water_rows)
    c.execute(f"COPY (SELECT * FROM water ORDER BY unit) TO '{out / 'water.parquet'}' (FORMAT parquet)")
    c.execute('CREATE TABLE floors (level VARCHAR, floor_name VARCHAR, unit INTEGER, name VARCHAR, geojson VARCHAR)')
    c.executemany('INSERT INTO floors VALUES (?, ?, ?, ?, ?)', floor_rows)
    c.execute(f"COPY (SELECT * FROM floors ORDER BY level DESC, unit) TO '{out / 'floors.parquet'}' (FORMAT parquet)")
    print(f'{len(parts)} pieces in model.glb ({(out / "model.glb").stat().st_size / 1e3:.0f} kB); hall '
          f'{2 * half_len:.0f} x {2 * half_wid:.0f} m, its long axis '
          f'{math.degrees(math.atan2(along[0], along[1])):.0f} deg from north; silos at '
          f'{[tuple(round(float(v), 1) for v in s) for s in silos]}; penstocks {[r[3] for r in water_rows]} m; '
          f'origin {olat:.6f}, {olon:.6f}')


def beam(a, b, z0, z1, half=0.35):
    """A straight beam of square section along a-b (metres), from z0 to z1."""
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    u = (b - a) / np.hypot(*(b - a))
    v = np.array([-u[1], u[0]]) * half
    return prism(np.array([a - v, b - v, b + v, a + v]), z0, z1)


def cage(s):
    """A silo drawn as its ribs and rings: the wall's 16 ribs, a ring at the top, at each floor and at the bottom."""
    pieces = []
    r = (SILO_R_IN + SILO_R_OUT) / 2
    for k in range(16):
        a = 2 * math.pi * k / 16
        c = s + r * np.array([math.cos(a), math.sin(a)])
        t = np.array([-math.sin(a), math.cos(a)])
        pieces.append(beam(c - t * 0.5, c + t * 0.5, SILO_BOTTOM, 0, 0.5))
    for z in [0.0] + [f[2] for f in FLOORS[1:]] + [SILO_BOTTOM + 0.8]:
        pieces.append(annulus(*s, SILO_R_IN, SILO_R_OUT, z - 0.8, z))
    pieces.append(cylinder(*s, SILO_R_OUT, SILO_BOTTOM - 2, SILO_BOTTOM, 64))
    return merge(*pieces)


def frame(ring, h):
    """A building drawn as its frame: a column at each corner, a beam along each edge of the roof."""
    ring = np.asarray(ring, dtype=float)
    pieces, last = [], None
    for p in ring[:-1]:
        if last is None or np.hypot(*(p - last)) > 4:
            pieces.append(cylinder(*p, 0.45, 0, h, 8))
            last = p
    for a, b in zip(ring[:-1], ring[1:]):
        if np.hypot(*(b - a)) > 0.5:
            pieces.append(beam(a, b, h - 0.8, h, 0.3))
    return merge(*pieces)


def annulus_ring(origin, s, r, sides=48):
    """A circle round a silo in longitude and latitude, counter-clockwise (a GeoJSON outer ring)."""
    pts = [origin.back(*(s + r * np.array([math.cos(a), math.sin(a)])))
           for a in np.linspace(0, 2 * math.pi, sides, endpoint=False)]
    return [[round(x, 8), round(y, 8)] for x, y in pts + pts[:1]]


def hull(points):
    """The convex hull of points (metres), counter-clockwise, closed."""
    pts = sorted(map(tuple, np.round(np.asarray(points, dtype=float), 3)))

    def half(seq):
        out = []
        for p in seq:
            while len(out) >= 2 and ((out[-1][0] - out[-2][0]) * (p[1] - out[-2][1])
                                     - (out[-1][1] - out[-2][1]) * (p[0] - out[-2][0])) <= 0:
                out.pop()
            out.append(p)
        return out

    lower, upper = half(pts), half(reversed(pts))
    ring = lower[:-1] + upper[:-1]
    return np.array(ring + ring[:1])


def merge(*meshes):
    verts = np.vstack([v for v, _ in meshes])
    offsets = np.cumsum([0] + [len(v) for v, _ in meshes[:-1]])
    return verts, np.vstack([f + o for (_, f), o in zip(meshes, offsets)]).astype(np.uint32)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
