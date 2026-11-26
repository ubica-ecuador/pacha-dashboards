# Landmarks as City Model surfaces, from landmarks.json and their OSM ways (footprints and building:part ways).
# Out: /work/landmarks.csv (osm, name, surface_type, tone, eave_m, top_m, face as POLYGON Z in WGS84)
#      /work/landmark_footprints.csv (osm, name, wkt in WGS84) for the build to leave out the generic block under each.
# Winding: every face is written so that its Newell normal points outward (roofs counter-clockwise from above).
import csv, json, math, sys, urllib.request, xml.etree.ElementTree as ET
from shapely.geometry import Polygon, MultiPolygon, box as sbox
from shapely.geometry.polygon import orient
from shapely.ops import transform, unary_union
from shapely import affinity
from pyproj import Transformer
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import roofs  # roof_faces: the generic hipped roof, for a landmark's lower parts

SPEC = sys.argv[1] if len(sys.argv) > 1 else '/build/landmarks.json'
SEG = 32          # segments around a dome or drum
BANDS = 7         # latitude bands of a dome
to_utm = Transformer.from_crs(4326, 32717, always_xy=True).transform
to_wgs = Transformer.from_crs(32717, 4326, always_xy=True)


def osm_way(wid):
    req = urllib.request.Request(f'https://api.openstreetmap.org/api/0.6/way/{wid}/full', headers={'User-Agent': 'pacha-dataset-build/1.0'})
    root = ET.fromstring(urllib.request.urlopen(req, timeout=60).read())
    nodes = {n.get('id'): (float(n.get('lon')), float(n.get('lat'))) for n in root.findall('node')}
    w = root.find('way')
    return orient(transform(to_utm, Polygon([nodes[nd.get('ref')] for nd in w.findall('nd')])), 1.0)


def wkt(ring):
    xs, ys = to_wgs.transform([p[0] for p in ring], [p[1] for p in ring])
    return ', '.join(f'{x:.7f} {y:.7f} {p[2]:.2f}' for x, y, p in zip(xs, ys, ring))


class Frame:
    """u along the long axis from the facade inward, v across from the facade's left as seen from outside."""
    def __init__(self, poly, facade_az):
        c = list(poly.minimum_rotated_rectangle.exterior.coords)[:4]
        cen = poly.centroid
        best = None
        for i in range(4):
            a, b = c[i], c[(i + 1) % 4]
            mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
            az = math.degrees(math.atan2(mx - cen.x, my - cen.y)) % 360
            d = abs((az - facade_az + 180) % 360 - 180)
            if best is None or d < best[0]:
                best = (d, a, b, i)
        _, a, b, i = best
        far = c[(i + 2) % 4]
        self.W = math.dist(a, b)
        # inward axis: from the facade side towards the opposite side
        mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        ox, oy = (far[0] + c[(i + 3) % 4][0]) / 2, (far[1] + c[(i + 3) % 4][1]) / 2
        self.L = math.dist((mx, my), (ox, oy))
        self.ax, self.ay = (ox - mx) / self.L, (oy - my) / self.L
        # facing the facade from outside means looking along +a; the viewer's right is a rotated clockwise
        self.rx, self.ry = self.ay, -self.ax
        # origin: the facade corner on the viewer's left
        left = [p for p in (a, b) if (p[0] - mx) * self.rx + (p[1] - my) * self.ry < 0][0]
        self.ox, self.oy = left

    def u(self, u):
        return self.L + u if u < 0 else u

    def v(self, v):
        return self.W + v if v < 0 else v

    def xy(self, u, v):
        return (self.ox + u * self.ax + v * self.rx, self.oy + u * self.ay + v * self.ry)

    def uv(self, x, y):
        dx, dy = x - self.ox, y - self.oy
        return (dx * self.ax + dy * self.ay, dx * self.rx + dy * self.ry)

    def rect(self, u0, u1, v0, v1):
        return orient(Polygon([self.xy(u0, v0), self.xy(u1, v0), self.xy(u1, v1), self.xy(u0, v1)]), 1.0)


rows = []


def face(kind, tone, ring, eave, top):
    rows.append((kind, tone, ring if isinstance(ring[0], list) else [ring], eave, top))


def walls(poly, z0, z1, tone):
    polys = poly.geoms if isinstance(poly, MultiPolygon) else [poly]
    for p in polys:
        p = orient(p, 1.0)
        for ring in [p.exterior, *p.interiors]:
            c = list(ring.coords)
            for (x0, y0), (x1, y1) in zip(c[:-1], c[1:]):
                face('WallSurface', tone, [(x0, y0, z0), (x1, y1, z0), (x1, y1, z1), (x0, y0, z1), (x0, y0, z0)], z1, z1)


def flat(poly, z, tone, kind='RoofSurface'):
    polys = poly.geoms if isinstance(poly, MultiPolygon) else [poly]
    for p in polys:
        if p.area < 1: continue
        p = orient(p, 1.0)
        face(kind, tone, [[(x, y, z) for x, y in r.coords] for r in [p.exterior, *p.interiors]], z, z)


def prism(poly, z0, z1, wall, roof, shape='flat'):
    """Walls from z0 to z1 and a roof: flat, or hipped as the generic buildings' (27 deg, capped 4 m)."""
    walls(poly, z0, z1, wall)
    if shape != 'hip':
        flat(poly, z1, roof)
        return z1
    top = z1
    for p in (poly.geoms if isinstance(poly, MultiPolygon) else [poly]):
        built = roofs.roof_faces(p)
        if not built:
            flat(p, z1, roof)
            continue
        faces, rise = built
        for rings in faces:
            face('RoofSurface', roof, [[(x, y, z1 + z) for x, y, z in r] for r in rings], z1, z1 + rise)
        top = max(top, z1 + rise)
    return top


def gable(fr, u0, u1, v0, v1, eave, ridge, wall, roof, along='u'):
    """A nave: walls to the eave, two roof planes meeting over the middle of v, gable ends at u0 and u1.
    along='v': the ridge runs across the frame (a nave along the street that the facade side faces)."""
    if along == 'v':
        P = lambda a, b, z: (*fr.xy(b, a), z)
        u0, u1, v0, v1 = v0, v1, u0, u1
    else:
        P = lambda u, v, z: (*fr.xy(u, v), z)
    vm = (v0 + v1) / 2
    corners = [P(u0, v0, 0), P(u1, v0, 0), P(u1, v1, 0), P(u0, v1, 0)]
    walls(orient(Polygon([c[:2] for c in corners]), 1.0), 0, eave, wall)
    mid = (sum(c[0] for c in corners) / 4, sum(c[1] for c in corners) / 4)
    for (va, vb) in ((v0, vm), (vm, v1)):
        za, zb = (eave, ridge) if va == v0 else (ridge, eave)
        ring = [P(u0, va, za), P(u1, va, za), P(u1, vb, zb), P(u0, vb, zb)]
        if signed_area(ring) < 0: ring.reverse()
        face('RoofSurface', roof, ring + [ring[0]], eave, ridge)
    for u, sgn in ((u0, -1), (u1, 1)):
        tri = [P(u, v0, eave), P(u, v1, eave), P(u, vm, ridge)]
        # outward: away from the nave's middle
        cx = sum(p[0] for p in tri) / 3 - mid[0]; cy = sum(p[1] for p in tri) / 3 - mid[1]
        if newell(tri)[0] * cx + newell(tri)[1] * cy < 0: tri.reverse()
        face('WallSurface', wall, tri + [tri[0]], eave, ridge)


def signed_area(ring):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:] + ring[:1])) / 2


def newell(ring):
    nx = ny = nz = 0.0
    for a, b in zip(ring, ring[1:] + ring[:1]):
        nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1])
    return nx, ny, nz


def drum(cx, cy, r, z0, z1, tone, n=SEG):
    walls(Polygon([(cx + r * math.cos(2 * math.pi * k / n), cy + r * math.sin(2 * math.pi * k / n)) for k in range(n)]), z0, z1, tone)


def dome(cx, cy, r, z0, rise, tone, lantern=None, lantern_tone='Wall, white'):
    """A half ellipsoid of radius r and height rise on z0, in latitude bands; a lantern (radius, height) and its small cap on top."""
    lat = [math.pi / 2 * k / BANDS for k in range(BANDS + 1)]
    ring = lambda t: [(cx + r * math.cos(t) * math.cos(2 * math.pi * k / SEG), cy + r * math.cos(t) * math.sin(2 * math.pi * k / SEG), z0 + rise * math.sin(t)) for k in range(SEG)]
    top = z0 + rise
    for t0, t1 in zip(lat[:-1], lat[1:]):
        lo, hi = ring(t0), ring(t1)
        if t1 >= math.pi / 2 - 1e-9:
            for k in range(SEG):
                tri = [lo[k], lo[(k + 1) % SEG], hi[0]]
                face('RoofSurface', tone, tri + [tri[0]], z0, top)
        else:
            for k in range(SEG):
                q = [lo[k], lo[(k + 1) % SEG], hi[(k + 1) % SEG], hi[k]]
                face('RoofSurface', tone, q + [q[0]], z0, top)
    if lantern:
        lr, lh = lantern
        base = z0 + rise * math.sin(math.acos(min(1, lr / r)))
        drum(cx, cy, lr, base, base + lh, lantern_tone)
        dome(cx, cy, lr * 1.1, base + lh, lr * 0.9, tone)
        return base + lh + lr * 0.9
    return top


def cone(cx, cy, r, z0, rise, tone, n=8):
    """A spire: an n-sided pyramid."""
    lo = [(cx + r * math.cos(2 * math.pi * (k + 0.5) / n), cy + r * math.sin(2 * math.pi * (k + 0.5) / n), z0) for k in range(n)]
    for k in range(n):
        tri = [lo[k], lo[(k + 1) % n], (cx, cy, z0 + rise)]
        face('RoofSurface', tone, tri + [tri[0]], z0, z0 + rise)
    return z0 + rise


def tower_box(fr, cx, cy, w, d):
    """A w (across, v) by d (along, u) rectangle centred on cx, cy, square to the frame."""
    hu, hv = d / 2, w / 2
    pts = [(cx + a * fr.ax + b * fr.rx, cy + a * fr.ay + b * fr.ry) for a, b in ((-hu, -hv), (hu, -hv), (hu, hv), (-hu, hv))]
    return orient(Polygon(pts), 1.0)


def tower(fr, cx, cy, t):
    """Stages (each optionally narrower), then a flat top, a dome with a lantern, or a spire.
    side: width across the frame (v); depth: along it (u), = side when not given (a square tower)."""
    z = 0
    w = t['side']; d = t.get('depth', w)
    t['_centre'] = fr.uv(cx, cy)
    t['_boxes'] = []
    for st in t['stages']:
        z0, z1 = st[0], st[1]
        if len(st) > 2:
            d, w = d * st[2] / w, st[2]
        box = tower_box(fr, cx, cy, w, d)
        t['_boxes'].append((w, d))
        walls(box, z0, z1, t['wall'])
        flat(box, z1, t['wall'] if t.get('cap') in ('dome', 'spire') else t.get('cap_tone', t['wall']))
        z = z1
    if t.get('cap') == 'dome':
        return dome(cx, cy, min(w, d) / 2 * 0.92, z, t['cap_rise'], t['cap_tone'], t.get('lantern'))
    if t.get('cap') == 'spire':
        return cone(cx, cy, min(w, d) / 2 * 1.05, z, t['cap_rise'], t['cap_tone'])
    return z


def tower_plane(fr, t, stage, face):
    """A face of a tower's stage: origin, direction, outward normal, and how an offset from the face's middle (c) becomes
    the distance along it."""
    uc, vc = t['_centre']
    w, d = t['_boxes'][stage]
    if face == 'front':
        return fr.xy(uc - d / 2, vc - w / 2), (fr.rx, fr.ry), (-fr.ax, -fr.ay), lambda c: w / 2 + c
    if face == 'back':
        return fr.xy(uc + d / 2, vc + w / 2), (-fr.rx, -fr.ry), (fr.ax, fr.ay), lambda c: w / 2 - c
    if face == 'left':
        return fr.xy(uc + d / 2, vc - w / 2), (-fr.ax, -fr.ay), (-fr.rx, -fr.ry), lambda c: d / 2 - c
    if face == 'right':
        return fr.xy(uc - d / 2, vc + w / 2), (fr.ax, fr.ay), (fr.rx, fr.ry), lambda c: d / 2 + c
    raise ValueError(face)


def plane(fr, wall, inset):
    """A wall plane of the frame: origin, direction along it (left to right seen from outside), outward normal,
    and how a frame coordinate (v on the front, u on a side) becomes the distance along it."""
    if wall == 'front':
        return fr.xy(inset, 0), (fr.rx, fr.ry), (-fr.ax, -fr.ay), lambda c: fr.v(c)
    if wall == 'left':   # v = 0, seen from outside its left end is the back
        return fr.xy(fr.L, inset), (-fr.ax, -fr.ay), (-fr.rx, -fr.ry), lambda c: fr.L - fr.u(c)
    if wall == 'right':  # v = W
        return fr.xy(0, fr.W - inset), (fr.ax, fr.ay), (fr.rx, fr.ry), lambda c: fr.u(c)
    raise ValueError(wall)


def arch_pts(sc, z0, w, h, m=0.0, seg=14):
    """A round-headed opening w wide and h high (to the top of its arch), grown by m on every side, counter-clockwise."""
    r = w / 2 + m
    zs = z0 + h - w / 2
    base = max(0.0, z0 - m)
    return [(sc - r, base), (sc + r, base), (sc + r, zs)] + \
           [(sc + r * math.cos(math.pi * k / seg), zs + r * math.sin(math.pi * k / seg)) for k in range(1, seg)] + [(sc - r, zs)]


def pointed_pts(sc, z0, w, h, m=0.0, seg=8):
    """A pointed (equilateral) arch w wide and h high to its apex, grown by m, counter-clockwise."""
    r = w / 2 + m
    zs = z0 + h - math.sqrt(3) * w / 2
    base = max(0.0, z0 - m)
    up = [(sc - r + 2 * r * math.cos(math.pi / 3 * k / seg), zs + 2 * r * math.sin(math.pi / 3 * k / seg)) for k in range(seg + 1)]
    down = [(sc + r - 2 * r * math.cos(math.pi / 3 * (seg - k) / seg), zs + 2 * r * math.sin(math.pi / 3 * (seg - k) / seg)) for k in range(1, seg)]
    return [(sc - r, base), (sc + r, base)] + up + down


def rect_pts(sc, z0, w, h, m=0.0):
    return [(sc - w / 2 - m, max(0.0, z0 - m)), (sc + w / 2 + m, max(0.0, z0 - m)), (sc + w / 2 + m, z0 + h + m), (sc - w / 2 - m, z0 + h + m)]


def circle_pts(sc, zc, r, n=24):
    return [(sc + r * math.cos(2 * math.pi * k / n), zc + r * math.sin(2 * math.pi * k / n)) for k in range(n)]


TRIM, OPENING = 0.05, 0.10   # metres in front of the wall: the stone trim, then the opening on it


def on_wall(P, off, pts, tone):
    (ax, ay), (dx, dy), (nx, ny), _ = P
    ring = [(ax + s_ * dx + off * nx, ay + s_ * dy + off * ny, z) for s_, z in pts]
    face('WallSurface', tone, ring + [ring[0]], 0, max(z for _, z in pts))


def details(fr, items, trim_tone, opening_tone, wall_tone, towers=()):
    """Arches, pointed arches, paired arched windows (bifora), square windows and round windows drawn on the walls, a
    few centimetres proud of them: the trim in a lighter stone, the opening dark. Each item: wall (front, left, right;
    or with tower: an index into the towers, stage, and front/back/left/right; a list draws it on each), c (its centre:
    a frame coordinate, or on a tower an offset from the face's middle), z, w, h, shape (arch, pointed, bifora, rect,
    circle), m (trim margin), inset (a narrower stage's wall), blind (trim only; with band, a moulding of that width
    around the wall), n/step (a row)."""
    shapes = {'arch': arch_pts, 'pointed': pointed_pts, 'rect': rect_pts}
    for e in items:
        faces = e['wall'] if isinstance(e['wall'], list) else [e['wall']]
        for wall in faces:
            if 'tower' in e:
                P = tower_plane(fr, towers[e['tower']], e.get('stage', 0), wall)
            else:
                P = plane(fr, wall, e.get('inset', 0.0))
            tr = P[3]
            m = e.get('m', 0.0)
            for i in range(e.get('n', 1)):
                sc = tr(e['c'] + i * e.get('step', 0))
                z, w = e['z'], e['w']
                if e['shape'] == 'circle':
                    if m or e.get('blind'): on_wall(P, TRIM, circle_pts(sc, z, w / 2 + m), trim_tone)
                    if e.get('blind'): continue
                    on_wall(P, OPENING, circle_pts(sc, z, w / 2), opening_tone)
                    if e.get('hub'): on_wall(P, OPENING + 0.05, circle_pts(sc, z, w / 8, 12), trim_tone)
                    continue
                outline = pointed_pts if e['shape'] == 'pointed' else rect_pts if e['shape'] == 'rect' else arch_pts
                if m or e.get('blind'):
                    on_wall(P, TRIM, outline(sc, z, w, e['h'], m), trim_tone)
                if e.get('blind'):
                    b = e.get('band')
                    if b:
                        on_wall(P, TRIM + 0.025, outline(sc, z + b, w - 2 * b, e['h'] - 2 * b), wall_tone)
                    continue
                if e['shape'] == 'bifora':   # two lights and the column between them
                    wl = w * 0.42
                    for k in (-1, 1):
                        on_wall(P, OPENING, arch_pts(sc + k * w * 0.27, z, wl, e['h'] - (w - wl) / 2), opening_tone)
                else:
                    on_wall(P, OPENING, shapes[e['shape']](sc, z, w, e['h']), opening_tone)


def pinnacles(fr, items, wall_tone, cap_tone):
    """Small octagonal turrets with a conical top, at frame points: u, v, r, z0, z1, rise; n/du/dv for a row."""
    tops = []
    for e in items:
        for i in range(e.get('n', 1)):
            cx, cy = fr.xy(fr.u(e['u']) + i * e.get('du', 0), fr.v(e['v']) + i * e.get('dv', 0))
            drum(cx, cy, e['r'], e['z0'], e['z1'], wall_tone, 8)
            tops.append(cone(cx, cy, e['r'] * 1.15, e['z1'], e['rise'], cap_tone))
    return tops


spec = json.load(open(SPEC))
out = csv.writer(open('/work/landmarks.csv', 'w', newline=''))
out.writerow(['osm', 'name', 'surface_type', 'tone', 'eave_m', 'top_m', 'face'])
fp = csv.writer(open('/work/landmark_footprints.csv', 'w', newline=''))
fp.writerow(['osm', 'name', 'wkt'])
for lm in spec['landmarks']:
    rows.clear()
    foot = osm_way(lm['osm'])
    fr = Frame(foot, lm['facade_az'])
    print(f"{lm['name']}: footprint {foot.area:.0f} m2, {fr.L:.1f} x {fr.W:.1f} m")
    solids = []
    naves = []
    for n in lm.get('naves', []):
        if 'osm_part' in n:
            uv = [fr.uv(x, y) for x, y in osm_way(n['osm_part']).exterior.coords]
            u0, u1 = min(p[0] for p in uv), max(p[0] for p in uv)
            v0, v1 = min(p[1] for p in uv), max(p[1] for p in uv)
        else:
            u0, u1 = sorted(fr.u(x) for x in n['u'])
            v0, v1 = sorted(fr.v(x) for x in n['v'])
        gable(fr, u0, u1, v0, v1, n['eave'], n['ridge'], n['wall'], n['roof'], n.get('along', 'u'))
        solids.append(fr.rect(u0, u1, v0, v1))
    tops = []
    for t in lm.get('towers', []):
        if 'osm_part' in t:
            c = osm_way(t['osm_part']).centroid
            cx, cy = c.x, c.y
        else:
            cx, cy = fr.xy(fr.u(t['u']), fr.v(t['v']))
        tops.append(tower(fr, cx, cy, t))
        solids.append(tower_box(fr, cx, cy, t['side'], t.get('depth', t['side'])))
    for d in lm.get('domes', []):
        if 'osm_part' in d:
            c = osm_way(d['osm_part']).centroid
            cx, cy = c.x, c.y
        else:
            cx, cy = fr.xy(fr.u(d['u']), fr.v(d['v']))
        drum(cx, cy, d['r'], d['drum'][0], d['drum'][1], lm.get('drum_tone', 'Wall, white'))
        tops.append(dome(cx, cy, d['r'], d['drum'][1], d['rise'], lm.get('dome_tone', 'Cupola, white'), d.get('lantern')))
    if lm.get('details'):
        details(fr, lm['details'], lm.get('trim_tone', 'Stone trim'), lm.get('opening_tone', 'Opening'), lm['body']['wall'], lm.get('towers', []))
    if lm.get('pinnacles'):
        tops += pinnacles(fr, lm['pinnacles'], lm['pinnacle_wall'], lm['pinnacle_cap'])
    b = lm['body']
    rest = foot.difference(unary_union(solids)) if solids else foot
    rest = rest.buffer(-0.05, join_style='mitre').buffer(0.05, join_style='mitre')
    if not rest.is_empty:
        tops.append(prism(rest, 0, b['top'], b['wall'], b['roof'], b.get('shape', 'flat')))
    top = max([b['top'], *tops, *[n['ridge'] for n in lm.get('naves', [])]])
    print(f"  {len(rows)} faces, top {top:.1f} m")
    for kind, tone, rings, eave, t in rows:
        out.writerow([lm['osm'], lm['name'], kind, tone, round(b['top'], 1), round(top, 1), 'POLYGON Z (' + ', '.join(f'({wkt(r)})' for r in rings) + ')'])
    fp.writerow([lm['osm'], lm['name'], transform(lambda x, y: to_wgs.transform(x, y), foot).wkt])
