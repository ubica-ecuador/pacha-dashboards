"""The rooms, floors, walls and sensor points of Newcastle University's Urban Sciences Building.

Reads what build.sh downloads into <work>: the Urban Observatory's 3D viewer (its app.js, which
places 307 named room points, and two of its models as three.js JSON: the floor finishes and
slabs, and the internal walls) and the REST API's entities (every room's sensors and their BMS
points). Writes into <out>:

  rooms.parquet    every room and the rest of each floor, flat, in lon/lat (WKT), with its API entity
  floors.parquet   each floor's outline, the slab its rooms stand on
  walls.parquet    each floor's internal walls, one multipolygon per floor
  points.parquet   the BMS point of each room sensor (the stream's `point`), its entity and kind
  stream-empty.parquet  the recorder feed's columns with no rows, for a dashboard read before anything is recorded

How the model becomes a plan:
- The viewer merges each mesh with its position only (Matrix4().setPosition): a mesh's rotation is
  dropped, and the room points were clicked in that viewer, so the same is done here. Its group sits
  at (35.65, 0.9, -181.69) turned by -pi about x: world = (x + 35.65, -y + 0.9, -z - 181.69).
- A room is the top face of a floor finish; the parts of a slab no finish covers (raised floors,
  plant, risers) are units too. A finish holding several room points (an open plan's "Zone 1..n")
  is split among them by Voronoi.
- A wall is the union of its mesh's horizontal faces, kept where it is thinner than 0.45 m (a solid
  block, a shaft or a plinth, is not a wall line), on the floor its bottom stands on.
- The plan is placed by a rigid transform fitted once to OpenStreetMap's outline of the building
  (way 514605389): mirror the model's z, turn 179.85 degrees, shift; the ground floor covers that
  outline with an intersection over union of 0.86. Metres become degrees around the outline's centre.

Usage: python build.py <work> <out>
"""
import glob
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path

import duckdb
import numpy as np
import shapely
from shapely import affinity
from shapely.geometry import MultiPoint, Point, Polygon
from shapely.ops import unary_union

work, out = Path(sys.argv[1]), Path(sys.argv[2])
T = np.array([35.65, 0.9, -181.69])
# Floors by the viewer's world elevation of their finishes; level 0 is the ground floor.
FLOORS = [('G', -13.8), ('1', -7.9), ('2', -3.9), ('3', 0.1), ('4', 4.1), ('5', 8.1), ('6', 12.1)]
GROUND = FLOORS[0][1]
# The fit to OpenStreetMap (see above).
MIRROR, THETA, SHIFT = True, 179.85, (-9.0762, -10.4283)
LON0, LAT0 = -1.6252432444, 54.9737108333
KX, KY = 111320.0 * math.cos(math.radians(LAT0)), 110574.0  # metres per degree


def world(model, verts):
    return np.c_[verts[:, 0] + model['matrix'][12], -(verts[:, 1] + model['matrix'][13]),
                 -(verts[:, 2] + model['matrix'][14])] + T


def meshes(path, name_re):
    d = json.loads(path.read_text())
    geometries = {g['uuid']: g for g in d['geometries']}
    for c in d['object']['children']:
        if not re.search(name_re, c['name']):
            continue
        g = geometries[c['geometry']]['data']
        pos = np.array(g['attributes']['position']['array'], dtype=float).reshape(-1, 3)
        idx = (np.array(g['index']['array'], dtype=int).reshape(-1, 3) if 'index' in g
               else np.arange(len(pos)).reshape(-1, 3))
        yield c['name'], world(c, pos), idx


def flat_faces(v, idx):
    """The mesh's horizontal triangles, as (triangles, mean elevation of each)."""
    tris = v[idx]
    n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    ln = np.linalg.norm(n, axis=1)
    ok = ln > 1e-9
    ny = np.zeros(len(n))
    ny[ok] = np.abs(n[ok, 1]) / ln[ok]
    keep = ok & (ny > 0.99)
    return tris[keep], tris[keep][:, :, 1].mean(axis=1)


def plan_union(tris, min_area):
    polys = [Polygon(t[:, [0, 2]]) for t in tris]
    polys = [p for p in polys if p.is_valid and p.area > min_area]
    return unary_union(polys) if polys else None


def top_polygon(v, idx):
    tris, ys = flat_faces(v, idx)
    top = v[:, 1].max()
    p = plan_union(tris[np.abs(ys - top) < 0.03], 1e-6)
    return (p.buffer(0.01).buffer(-0.01) if p is not None else None), top


def to_plan(g):
    """The viewer's (x, z) to metres east and north of the outline's centre."""
    g = affinity.scale(g, 1, -1 if MIRROR else 1, origin=(0, 0))
    g = affinity.rotate(g, THETA, origin=(0, 0))
    return affinity.translate(g, *SHIFT)


def to_lonlat(g):
    return shapely.transform(g, lambda c: np.c_[LON0 + c[:, 0] / KX, LAT0 + c[:, 1] / KY])


def floor_of(y):
    below = [f for f in FLOORS if y >= f[1] - 0.6]
    return max(below, key=lambda f: f[1]) if below else None


# --- the model: finishes, slabs, room points
flooring = work / 'flooring.json'
pieces, slabs = [], defaultdict(list)
for name, v, idx in meshes(flooring, r'FloorFinish'):
    p, y = top_polygon(v, idx)
    if p is not None and not p.is_empty:
        pieces.append((re.sub(r'^Floor:RB_FloorFinish_|:\d+$', '', name), round(float(y), 2), p))
for name, v, idx in meshes(flooring, r'Build_?[Uu]p'):
    p, y = top_polygon(v, idx)
    if p is not None and not p.is_empty:
        slabs[round(float(y), 1)].append(p)
js = (work / 'app.js').read_text()
points = [{'name': m[1], 'x': float(m[2]), 'y': float(m[3]), 'z': float(m[4])}
          for m in re.finditer(r'"?([^",{}:]+)"?:\{x:(-?[0-9.]+),y:(-?[0-9.]+),z:(-?[0-9.]+)', js)]
viewer = dict(re.findall(r'"?([^",{}:]+?)"?:"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"', js))
print(f'model: {len(pieces)} finishes, {sum(map(len, slabs.values()))} slabs, {len(points)} room points')

# --- the API's entities
entities = []
for f in sorted(glob.glob(str(work / 'entities-*.json'))):
    entities += json.loads(Path(f).read_text())['items']
by_name = {e['name']: e for e in entities}
by_id = {e['entityId']: e for e in entities}
by_room = defaultdict(list)  # a room may have two entities, one filed on the wrong floor
for e in entities:
    if 'roomNumber' in e['meta']:
        by_room[(e['meta']['roomNumber'], e['meta'].get('roomZone'))].append(e)
print(f'API: {len(entities)} entities')


def entity_for(fl, name):
    """By room number and zone first (an entity's floor label is sometimes wrong: "Floor G: Room
    1.014"), then by "Floor <f> <name>", then by the viewer's own map if that entity is on the floor."""
    m = re.match(r'^([G0-9]\.\d+[A-Za-z]?)(?: Zone (\d+))?$', name)
    if m:
        es = by_room.get((m[1], m[2])) or (by_room.get((m[1], None)) if m[2] else None)
        if es:  # the one filed on this floor, else the one with more feeds
            return max(es, key=lambda e: (e['meta'].get('buildingFloor') == fl, len(e['feed']), e['entityId']))
    e = by_name.get(f'Urban Sciences Building: Floor {fl} {name}')
    if e:
        return e
    e = by_id.get(viewer.get(name))
    return e if e and e['meta'].get('buildingFloor') == fl else None


# --- rooms and floors
rooms, floors = [], []
for level, (fl, elev) in enumerate(FLOORS):
    finishes = [(p.buffer(0), kind) for kind, y, p in pieces if abs(y - elev) < 0.5]
    plates = [g.buffer(0) for k, v in slabs.items() if abs(k - elev) < 0.3 for g in v]
    regions = list(finishes)
    covered = unary_union([g for g, _ in finishes]) if finishes else shapely.Polygon()
    rest = unary_union(plates).difference(covered.buffer(0.05)) if plates else shapely.Polygon()
    regions += [(g, 'slab') for g in getattr(rest, 'geoms', [rest]) if g.area > 4]  # not the slivers between finishes
    floors.append((fl, level, round(elev - GROUND, 2), unary_union([g for g, _ in regions]).buffer(0.3).buffer(-0.3)))

    held = defaultdict(list)
    for p in (p for p in points if (floor_of(p['y']) or [None])[0] == fl):
        pt = Point(p['x'], p['z'])
        hit = [i for i, (g, _) in enumerate(regions) if g.contains(pt)]
        if not hit:  # a point just outside its room: the nearest region within 1.5 m
            near = min(((g.distance(pt), i) for i, (g, _) in enumerate(regions)), default=(99, None))
            hit = [near[1]] if near[0] < 1.5 else []
        if hit:
            held[min(hit, key=lambda i: regions[i][0].area)].append(p)  # the smallest region holding it

    for i, (g, kind) in enumerate(regions):
        ps = held.get(i, [])
        if len(ps) <= 1:
            parts = [(g, ps[0] if ps else None)]
        else:
            cells = shapely.voronoi_polygons(MultiPoint([(p['x'], p['z']) for p in ps]), extend_to=g.envelope.buffer(50))
            parts = [(c.intersection(g), next(p for p in ps if c.contains(Point(p['x'], p['z'])))) for c in cells.geoms]
        for part, p in parts:
            if part.is_empty or part.area < 0.5:
                continue
            e = entity_for(fl, p['name']) if p else None
            rooms.append({'floor': fl, 'level': level, 'base_m': round(elev - GROUND, 2), 'room': p['name'] if p else None,
                          'kind': kind, 'entity_id': e['entityId'] if e else None, 'area_m2': round(part.area, 1),
                          'wkt': to_lonlat(to_plan(part)).wkt})

# Keys: the entity, or the floor and room name; a zone of a room that reports through the room's one entity
# gets the room's key and its own name.
seen, n_units = set(), defaultdict(int)
for r in rooms:
    if r['room']:
        key = r['entity_id'] or f"{r['floor']}:{r['room']}"
        if key in seen:
            key = f"{key}:{r['room']}"
        r['label'] = ('Room ' + r['room']) if re.match(r'^[G0-9]\.\d', r['room']) else r['room']
    else:
        n_units[r['floor']] += 1
        key, r['label'] = f"{r['floor']}:unit-{n_units[r['floor']]:03d}", None
    seen.add(key)
    r['room_key'] = key
print(f"rooms: {len(rooms)} units, {sum(1 for r in rooms if r['room'])} named, "
      f"{sum(1 for r in rooms if r['entity_id'])} with an API entity")

# --- walls
by_floor = defaultdict(list)
for name, v, idx in meshes(work / 'walls-internal.json', r'^(Basic_Wall|Walls_\d)'):
    tris, _ = flat_faces(v, idx)
    foot = plan_union(tris, 1e-7)
    if foot is None:
        continue
    foot = foot.buffer(0.002).buffer(-0.002)
    parts = [q for q in getattr(foot, 'geoms', [foot]) if q.area > 0.005 and 2 * q.area / q.length < 0.45]
    fl = floor_of(float(v[:, 1].min()))
    if parts and fl:
        by_floor[fl[0]].append(unary_union(parts))
walls = []
for level, (fl, _) in enumerate(FLOORS):
    if by_floor[fl]:
        u = unary_union(by_floor[fl]).buffer(0.005).buffer(-0.005)
        walls.append((fl, level, to_lonlat(to_plan(u).simplify(0.02)).wkt))
print('walls by floor:', {fl: len(v) for fl, v in by_floor.items()})

# --- sensor points: each room entity's BMS points by kind, from the metric's name, which the BMS
# spells many ways. An air handler's CO2 ("AHU Max CO2") is not a room's.
KINDS = [('co2', r'co2', r'max|min|ahu|average'), ('temp', r'^room temp', None),
         ('rh', r'relative humidity|^room humidity', None), ('lux', r'^room brightness|^brightnessvalue', None),
         ('occupancy', r'^occupancy sensor|^room occupied', None)]
room_entities = {r['entity_id'] for r in rooms if r['entity_id']}
point_rows = []
for e in entities:
    if e['entityId'] not in room_entities:
        continue
    for feed in e['feed']:
        metric = feed['metric'].lower()
        kind = next((k for k, yes, no in KINDS if re.search(yes, metric) and not (no and re.search(no, metric))), None)
        if kind:
            for b in feed.get('brokerage') or []:
                if b.get('sourceId'):
                    point_rows.append((b['sourceId'], e['entityId'], feed['metric'], kind))
print('points:', len(point_rows), dict(sorted(defaultdict(int, {k: sum(1 for p in point_rows if p[3] == k)
                                                                   for k, *_ in KINDS}).items())))

# --- Parquet
con = duckdb.connect()
con.execute('''CREATE TABLE rooms (room_key VARCHAR, floor VARCHAR, level INTEGER, base_m DOUBLE, room VARCHAR,
  label VARCHAR, kind VARCHAR, entity_id VARCHAR, area_m2 DOUBLE, wkt VARCHAR)''')
con.executemany('INSERT INTO rooms VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [(r['room_key'], r['floor'], r['level'], r['base_m'], r['room'], r['label'], r['kind'], r['entity_id'],
                  r['area_m2'], r['wkt']) for r in rooms])
con.execute('CREATE TABLE floors (floor VARCHAR, level INTEGER, base_m DOUBLE, wkt VARCHAR)')
con.executemany('INSERT INTO floors VALUES (?, ?, ?, ?)', [(f, l, b, to_lonlat(to_plan(g)).wkt) for f, l, b, g in floors])
con.execute('CREATE TABLE walls (floor VARCHAR, level INTEGER, wkt VARCHAR)')
con.executemany('INSERT INTO walls VALUES (?, ?, ?)', walls)
con.execute('CREATE TABLE points (point VARCHAR, entity_id VARCHAR, metric VARCHAR, kind VARCHAR)')
con.executemany('INSERT INTO points VALUES (?, ?, ?, ?)', sorted(set(point_rows)))
# The columns of recorder/feeds/urban-sciences-building.sql; the dataset's test checks they match.
con.execute('''CREATE TABLE stream (ts TIMESTAMPTZ, point VARCHAR, metric VARCHAR, value DOUBLE, unit VARCHAR,
  entity VARCHAR, floor VARCHAR, room_number VARCHAR, room_zone VARCHAR, room_description VARCHAR, broker VARCHAR)''')
for table, order in (('rooms', 'level, room_key'), ('floors', 'level'), ('walls', 'level'), ('points', 'point'),
                     ('stream', 'point, ts')):
    name = 'stream-empty' if table == 'stream' else table
    con.execute(f"COPY (SELECT * FROM {table} ORDER BY {order}) TO '{out / name}.parquet' (FORMAT parquet)")
