# The fronts of the houses round the centre's squares. Every footprint edge that faces a square across its street gets
# the front its pictures show (Mapillary, Wikimedia Commons): where the house has a portal, its ground floor is opened
# into an arcade (a wall of arches or of wooden posts on the street line, a polygon with the openings as holes, and the
# gallery behind it, DEPTH metres in); above it, or on a house without one, its windows, balconies and eave.
# Out: /work/arcades.csv (id, surface_type, tone, face as POLYGON Z in WGS84) and /work/arcade_edges.csv (id, edge as
# LINESTRING in WGS84), the edges whose plain wall step3c drops for these.
import csv, math, sys, urllib.request, xml.etree.ElementTree as ET
import shapely
from shapely.geometry import Polygon, LineString, Point
from shapely.geometry.polygon import orient
from shapely.ops import transform, polygonize, unary_union
from pyproj import Transformer

GROUND = 3.8                # the ground floor of a house without a portal
REACH = (4.0, 26.0)         # an edge's middle this far from the park (m): across its street
FACING = 0.8                # cosine between the edge's outward normal and the way to the park
MIN_EDGE = 2.5              # shorter edges are not opened
H = 4.5                     # the arcade's height (m): its ceiling
DEPTH = 3.0                 # the gallery's depth (m)
BAY = 3.3                   # an arch and its pillar
PILLAR = 0.7
SEG = 10                    # segments of an arch's half circle
FLOOR = 3.8                 # an upper floor of these houses (m); the ground floor is the arcade, H
PLINTH = 0.9                # the stone base of the pillars
# Houses drawn from a photo of their own (Wikimedia Commons): the Gobernación del Azuay's upper floor is a loggia of
# arches behind a balcony that runs its whole front (two Overture footprints at Bolívar and Luis Cordero).
LOGGIA = {'364d0828-', '3e6ecb79-'}
# Each house as Mapillary's pictures of the park show it (2025, CC BY-SA), by Overture id: what rims its arches, what
# its upper floors have, how its front ends at the roof, and whether its portal is arched or square (a modern block).
STYLES = {
    '364d0828-': dict(rim='Trim, ochre', upper='loggia'),                 # Gobernación del Azuay (Commons)
    '3e6ecb79-': dict(rim='Trim, ochre', upper='loggia'),
    '6210694e-': dict(rim=None, upper='framed', top='parapet'),           # neoclassical, on Benigno Malo
    'ee6c2322-': dict(rim=None, upper='grid', top='flat', opening='square'),  # concrete block on Sucre
    '7114dcb9-': dict(rim=None, upper='framed'),                          # Sucre: white pillars, dark plinths
    '64cb76fe-': dict(rim=None, upper='framed'),
    '826e2ccb-': dict(rim=None, upper='framed'),
}
DEFAULT = dict(rim='Trim, grey', upper='balconies')                       # Bolívar: iron balconies (Commons)
# The squares, by OSM element, and the front of each of their sides as its pictures show it (Mapillary, 2017-2025),
# by the way the wall faces (N: the houses on the square's south side). None: every side, by STYLES / DEFAULT (Parque
# Calderón, all arcaded). A side left out has no usable picture and keeps its plain walls.
SQUARES = {
    'way/302980838': ('Parque Calderón', None),
    'relation/14387893': ('Plaza de San Francisco', {
        'E': dict(opening='posts', upper='wood-balcony'),          # wooden posts, a wooden balcony along the front
        'N': dict(opening='posts', upper='wood-balcony'),
        'S': dict(opening='arch', rim=None, upper='framed'),       # arches on stone pillars
        'W': dict(opening='arch', rim=None, upper='framed')}),     # arches on white pillars
    'way/48591689': ('Parque de San Sebastián', {
        'E': dict(opening='none', upper='balconies'),
        'N': dict(opening='none', upper='framed', wall='Wall, white', frame='Window, blue frame'),   # Museo de Arte Moderno
        'W': dict(opening='none', upper='framed', wall='Wall, ochre')}),
    'way/832036831': ('Plaza de La Merced', {
        'E': dict(opening='none', upper='framed', wall='Wall, brick', top='flat'),   # republican brick fronts
        'N': dict(opening='none', upper='framed', wall='Wall, brick', top='flat')}),
    'way/48597773': ('Plaza 9 de Octubre', {
        'E': dict(opening='none', upper='balconies'),
        'S': dict(opening='none', upper='balconies')}),
}

to_utm = Transformer.from_crs(4326, 32717, always_xy=True).transform
to_wgs = Transformer.from_crs(32717, 4326, always_xy=True)


def square(ref):
    """A square's outline in UTM, from an OSM way or a multipolygon relation (its ways polygonised)."""
    req = urllib.request.Request(f'https://api.openstreetmap.org/api/0.6/{ref}/full', headers={'User-Agent': 'pacha-dataset-build/1.0'})
    root = ET.fromstring(urllib.request.urlopen(req, timeout=60).read())
    nodes = {n.get('id'): (float(n.get('lon')), float(n.get('lat'))) for n in root.findall('node')}
    lines = [[nodes[nd.get('ref')] for nd in w.findall('nd')] for w in root.findall('way')]
    if ref.startswith('way/'):
        return transform(to_utm, Polygon(lines[0]))
    return transform(to_utm, unary_union(list(polygonize(unary_union([LineString(l) for l in lines])))))


def wkt(rings):
    out = []
    for r in rings:
        xs, ys = to_wgs.transform([p[0] for p in r], [p[1] for p in r])
        out.append('(' + ', '.join(f'{x:.7f} {y:.7f} {p[2]:.2f}' for x, y, p in zip(xs, ys, r)) + ')')
    return 'POLYGON Z (' + ', '.join(out) + ')'


def newell(ring):
    nx = ny = nz = 0.0
    for a, b in zip(ring, ring[1:] + ring[:1]):
        nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1])
    return nx, ny, nz


def facing(ring, nx, ny):
    """The ring wound so that its normal points along (nx, ny) (seen from that side, counter-clockwise)."""
    n = newell(ring)
    return ring if n[0] * nx + n[1] * ny >= 0 else ring[::-1]


def closed(r):
    return r + [r[0]]


def wall_tone(roof):
    return 'Wall, lime-washed' if roof.startswith('Clay') else 'Wall, ochre' if roof == 'Weathered tile' else 'Wall, plaster'


def ring_facing(pts, ox, oy):
    return closed(facing(pts, ox, oy))


def arcade(a, b, out, eave, tone, style=DEFAULT, roof=''):
    """The faces of one opened edge a-b, whose outward normal is out: the arcade and its gallery, then the front above
    it as the photos of the park show it: an ochre rim round each arch on a stone plinth, a cornice over the arcade,
    each upper floor a tall window over each arch with an iron balcony (style 'balconies') or one loggia of arches
    behind a balcony along the front ('loggia'), and the wooden eave (a stone cornice on the tall houses)."""
    L = math.dist(a, b)
    ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
    ox, oy = out
    P = lambda s, z, d=0.0: (a[0] + s * ux - d * ox, a[1] + s * uy - d * oy, z)
    opening = style.get('opening', 'arch')
    tone = style.get('wall', tone)
    if opening == 'none':
        return front(P, L, ox, oy, eave, tone, style, roof)
    posts = opening == 'posts'
    n = max(1, round(L / (3.0 if posts else BAY)))
    bay = L / n
    w = bay - (0.3 if posts else PILLAR)
    spring = H - 0.35 - w / 2
    if spring < 1.8 and not posts:   # a short edge: one narrower arch
        w = 2 * (H - 0.35 - 1.8); spring = 1.8
    holes = []
    for i in range(n):
        c = (i + 0.5) * bay
        r = w / 2
        if opening in ('square', 'posts'):
            hole = [P(c - r, 0.0), P(c + r, 0.0), P(c + r, H - 0.45), P(c - r, H - 0.45)]
        else:
            hole = [P(c - r, 0.0), P(c + r, 0.0)] + [P(c + r * math.cos(math.pi * k / SEG), spring + r * math.sin(math.pi * k / SEG)) for k in range(SEG + 1)]
        holes.append(hole)
    # The arched wall: its outer ring towards the street, its holes the other way round.
    outer = facing([P(0, 0), P(L, 0), P(L, H), P(0, H)], ox, oy)
    holes = [facing(h_, -ox, -oy) for h_ in holes]
    faces = [('WallSurface', tone, [closed(outer)] + [closed(h_) for h_ in holes])]
    # The pillars' sides: each opening's jambs and soffit, DEPTH_J deep.
    dj = 0.45
    for h_ in holes:
        pts = h_ if newell(h_)[0] * ox + newell(h_)[1] * oy < 0 else h_[::-1]
        for p, q in zip(pts, pts[1:] + pts[:1]):
            if p[2] == 0 and q[2] == 0:
                continue        # the threshold: none
            quad = [p, q, (q[0] - dj * ox, q[1] - dj * oy, q[2]), (p[0] - dj * ox, p[1] - dj * oy, p[2])]
            # facing into the opening: towards its axis
            mx = sum(v[0] for v in pts) / len(pts); my = sum(v[1] for v in pts) / len(pts); mz = sum(v[2] for v in pts) / len(pts)
            nq = newell(quad)
            cx = sum(v[0] for v in quad) / 4; cy = sum(v[1] for v in quad) / 4; cz = sum(v[2] for v in quad) / 4
            if nq[0] * (mx - cx) + nq[1] * (my - cy) + nq[2] * (mz - cz) < 0:
                quad = quad[::-1]
            faces.append(('WallSurface', tone, [closed(quad)]))
    # Above the arcade, up to the eave.
    if eave > H + 0.2:
        faces.append(('WallSurface', tone, [closed(facing([P(0, H), P(L, H), P(L, eave), P(0, eave)], ox, oy))]))
    # The gallery: its back wall (towards the street) and its ceiling (facing down).
    # In the shade of the gallery: darker than the street wall, so the arches read whatever the sun.
    faces.append(('WallSurface', 'Gallery, in shade', [closed(facing([P(0, 0, DEPTH), P(L, 0, DEPTH), P(L, H, DEPTH), P(0, H, DEPTH)], ox, oy))]))
    ceil = [P(0, H - 0.01, 0), P(L, H - 0.01, 0), P(L, H - 0.01, DEPTH), P(0, H - 0.01, DEPTH)]
    if newell(ceil)[2] > 0:
        ceil = ceil[::-1]
    faces.append(('RoofSurface', 'Gallery ceiling' if opening == 'square' else 'Gallery, wooden beams', [closed(ceil)]))
    proud, slab = drawers(P, ox, oy, faces)

    r = w / 2
    centres = [(i + 0.5) * bay for i in range(n)]
    # Rims round the arches, from the plinth up (a U of stone), and the plinths of the pillars between them.
    for c in (centres if style.get('rim') and style.get('opening') != 'square' else []):
        R = r + 0.22
        outer_ = [(c - R, PLINTH), (c - R, spring)] + [(c - R * math.cos(math.pi * k / SEG), spring + R * math.sin(math.pi * k / SEG)) for k in range(1, SEG)] + [(c + R, spring), (c + R, PLINTH)]
        inner_ = [(c + r, PLINTH), (c + r, spring)] + [(c + r * math.cos(math.pi * k / SEG), spring + r * math.sin(math.pi * k / SEG)) for k in range(1, SEG)] + [(c - r, spring), (c - r, PLINTH)]
        proud(outer_ + inner_, 0.04, style['rim'])
    edges_ = [0.0] + [x for c in centres for x in (c - r, c + r)] + [L]
    for s0, s1 in zip(edges_[::2], edges_[1::2]):
        if s1 - s0 > 0.05:
            if posts:       # a wooden post on a stone base
                proud([(s0, 0.5), (s1, 0.5), (s1, H - 0.45), (s0, H - 0.45)], 0.05, 'Wood, posts')
                proud([(s0 - 0.05, 0), (s1 + 0.05, 0), (s1 + 0.05, 0.5), (s0 - 0.05, 0.5)], 0.07, 'Stone, dark')
            else:
                proud([(s0, 0), (s1, 0), (s1, PLINTH), (s0, PLINTH)], 0.05, 'Stone, dark')
    # The cornice over the arcade (a wooden beam over posts).
    if posts:
        proud([(0, H - 0.45), (L, H - 0.45), (L, H), (0, H)], 0.06, 'Wood, posts')
    else:
        proud([(0, H), (L, H), (L, H + 0.35), (0, H + 0.35)], 0.08, style.get('rim') or 'Trim, grey')
        slab(0, L, H + 0.35, 0, 0.2)
    upper_floors(proud, slab, L, H + (0 if posts else 0.35), eave, bay, centres, tone, style)
    eave_of(proud, slab, faces, P, L, ox, oy, eave, tone, style, roof)
    return faces


def drawers(P, ox, oy, faces):
    def proud(pts2, d, tone_):   # a flat shape (s, z) d metres in front of the wall
        faces.append(('WallSurface', tone_, [ring_facing([P(s_, z_, -d) for s_, z_ in pts2], ox, oy)]))

    def slab(s0, s1, z, d0, d1, up=True, tone_='Trim, grey'):   # a horizontal plate from d0 to d1 in front
        r_ = [P(s0, z, -d0), P(s1, z, -d0), P(s1, z, -d1), P(s0, z, -d1)]
        if (newell(r_)[2] > 0) != up:
            r_ = r_[::-1]
        faces.append(('RoofSurface' if up else 'WallSurface', tone_, [closed(r_)]))
    return proud, slab


def front(P, L, ox, oy, eave, tone, style, roof):
    """A house without a portal: its wall stays; on it, a stone plinth, doors and windows on the ground floor, its upper
    floors and its eave. A colour of its own (brick, ochre, white) covers the wall a centimetre in front."""
    faces = []
    proud, slab = drawers(P, ox, oy, faces)
    if style.get('wall'):
        proud([(0, 0), (L, 0), (L, eave), (0, eave)], 0.015, tone)
    n = max(1, round(L / BAY))
    bay = L / n
    centres = [(i + 0.5) * bay for i in range(n)]
    g = min(eave, GROUND)
    proud([(0, 0), (L, 0), (L, 0.6), (0, 0.6)], 0.03, 'Stone, dark')
    frame = style.get('frame', 'Window, wood frame')
    for i, c in enumerate(centres):
        if i % 2 == 0:     # a door
            proud([(c - 0.7, 0), (c + 0.7, 0), (c + 0.7, min(2.7, g - 0.5)), (c - 0.7, min(2.7, g - 0.5))], 0.04, 'Door, wood')
        else:              # a window
            proud([(c - 0.6, 1.0), (c + 0.6, 1.0), (c + 0.6, min(2.6, g - 0.6)), (c - 0.6, min(2.6, g - 0.6))], 0.03, frame)
            proud([(c - 0.48, 1.1), (c + 0.48, 1.1), (c + 0.48, min(2.5, g - 0.7)), (c - 0.48, min(2.5, g - 0.7))], 0.05, 'Glass')
    if eave > g + 2.0:
        proud([(0, g), (L, g), (L, g + 0.2), (0, g + 0.2)], 0.05, 'Trim, grey')
    upper_floors(proud, slab, L, g, eave, bay, centres, tone, style)
    eave_of(proud, slab, faces, P, L, ox, oy, eave, tone, style, roof)
    return faces


def upper_floors(proud, slab, L, base, eave, bay, centres, tone, style):
    """The floors from base up to the eave: a loggia, a grid, framed windows, iron balconies, or a wooden balcony."""
    H = base     # (the floors start here)
    if eave > H + 2.0:
        nf = max(1, round((eave - H) / FLOOR))
        fh = (eave - H) / nf
        upper = style['upper']
        frame = style.get('frame', 'Window, wood frame')
        if upper == 'loggia':
            top = eave - 0.6
            # The balcony along the front, its parapet carrying the name, over a thin slab.
            slab(0, L, H, 0.2, 0.9, up=False, tone_='Trim, grey')
            slab(0, L, H, 0.2, 0.9, up=True, tone_='Trim, grey')
            proud([(0, H), (L, H), (L, H + 0.95), (0, H + 0.95)], 0.9, tone)
            for c in centres:
                ww = bay - 0.45
                proud(arch_outline(c, H + 0.95, ww, top - (H + 0.95)), 0.06, 'Opening')
                proud([(c - ww / 2 - 0.02, H + 0.95), (c - ww / 2 + 0.12, H + 0.95), (c - ww / 2 + 0.12, top - ww / 2), (c - ww / 2 - 0.02, top - ww / 2)], 0.1, 'Trim, ochre')
        elif upper == 'wood-balcony':   # a wooden balcony along the whole front, tall wooden windows behind it
            z0 = H + 0.15
            slab(0, L, z0, 0, 0.9, up=True, tone_='Eave, wood')
            slab(0, L, z0, 0, 0.9, up=False, tone_='Eave, wood')
            proud([(0, z0 + 0.95), (L, z0 + 0.95), (L, z0 + 1.05), (0, z0 + 1.05)], 0.9, 'Wood, balustrade')
            proud([(0, z0 + 0.08), (L, z0 + 0.08), (L, z0 + 0.16), (0, z0 + 0.16)], 0.9, 'Wood, balustrade')
            for j in range(int(L / 0.2)):
                x = 0.1 + j * 0.2
                proud([(x - 0.03, z0), (x + 0.03, z0), (x + 0.03, z0 + 0.95), (x - 0.03, z0 + 0.95)], 0.9, 'Wood, balustrade')
            hh = min(2.5, fh - 0.9)
            for c in centres:
                proud([(c - 0.65, z0), (c + 0.65, z0), (c + 0.65, z0 + hh), (c - 0.65, z0 + hh)], 0.03, frame)
                for qx in (-1, 1):
                    x0 = c + (0.06 if qx > 0 else -0.56)
                    proud([(x0, z0 + 0.1), (x0 + 0.5, z0 + 0.1), (x0 + 0.5, z0 + hh - 0.1), (x0, z0 + hh - 0.1)], 0.05, 'Glass')
            for k in range(1, nf):
                zz = H + k * fh + 0.7
                hk = min(2.3, fh - 1.2)
                for c in centres:
                    proud([(c - 0.62, zz), (c + 0.62, zz), (c + 0.62, zz + hk), (c - 0.62, zz + hk)], 0.03, frame)
                    proud([(c - 0.5, zz + 0.1), (c + 0.5, zz + 0.1), (c + 0.5, zz + hk - 0.1), (c - 0.5, zz + hk - 0.1)], 0.05, 'Glass')
        elif upper == 'grid':     # a modern block: plain windows, two to a bay
            for k in range(nf):
                z0 = H + k * fh + 0.8
                for c in centres:
                    for dx in (-bay / 4, bay / 4):
                        proud([(c + dx - 0.6, z0), (c + dx + 0.6, z0), (c + dx + 0.6, z0 + 1.5), (c + dx - 0.6, z0 + 1.5)], 0.04, 'Glass')
        elif upper == 'framed':   # tall wooden-framed windows, a sill and a moulded hood, no balcony
            for k in range(nf):
                z0 = H + k * fh + (0.55 if k == 0 else 0.7)
                hh = min(2.3, fh - 1.2)
                for c in centres:
                    proud([(c - 0.62, z0), (c + 0.62, z0), (c + 0.62, z0 + hh), (c - 0.62, z0 + hh)], 0.03, frame)
                    for qx, qz in ((-1, 0), (1, 0), (-1, 1), (1, 1)):   # four panes
                        x0 = c + (0.06 if qx > 0 else -0.54); zz = z0 + 0.08 + qz * (hh - 0.16) / 2
                        proud([(x0, zz), (x0 + 0.48, zz), (x0 + 0.48, zz + (hh - 0.16) / 2 - 0.06), (x0, zz + (hh - 0.16) / 2 - 0.06)], 0.05, 'Glass')
                    slab(c - 0.8, c + 0.8, z0 - 0.02, 0, 0.18, up=True, tone_='Trim, grey')
                    proud([(c - 0.8, z0 - 0.5), (c + 0.8, z0 - 0.5), (c + 0.8, z0 - 0.02), (c - 0.8, z0 - 0.02)], 0.04, 'Trim, grey')
                    proud([(c - 0.85, z0 + hh + 0.12), (c + 0.85, z0 + hh + 0.12), (c, z0 + hh + 0.55)], 0.06, 'Trim, grey')
        else:
            for k in range(nf):
                z0 = H + k * fh + (0.45 if k == 0 else 0.6)
                hh = min(2.5, fh - 1.1)
                for c in centres:
                    proud([(c - 0.75, z0 - 0.15), (c + 0.75, z0 - 0.15), (c + 0.75, z0 + hh + 0.15), (c - 0.75, z0 + hh + 0.15)], 0.04, 'Trim, grey')
                    proud([(c - 0.6, z0), (c + 0.6, z0), (c + 0.6, z0 + hh), (c - 0.6, z0 + hh)], 0.07, 'Opening')
                    slab(c - 0.95, c + 0.95, z0 - 0.05, 0, 0.45, up=True)
                    slab(c - 0.95, c + 0.95, z0 - 0.05, 0, 0.45, up=False)
                    # The railing: a handrail and bars, the window seen between them.
                    proud([(c - 0.95, z0 + 0.88), (c + 0.95, z0 + 0.88), (c + 0.95, z0 + 0.96), (c - 0.95, z0 + 0.96)], 0.45, 'Railing, iron')
                    proud([(c - 0.95, z0 + 0.1), (c + 0.95, z0 + 0.1), (c + 0.95, z0 + 0.16), (c - 0.95, z0 + 0.16)], 0.45, 'Railing, iron')
                    for j in range(9):
                        x = c - 0.9 + j * 0.225
                        proud([(x - 0.02, z0 - 0.05), (x + 0.02, z0 - 0.05), (x + 0.02, z0 + 0.88), (x - 0.02, z0 + 0.88)], 0.45, 'Railing, iron')


def eave_of(proud, slab, faces, P, L, ox, oy, eave, tone, style, roof):
    """The wooden rafters under a deep overhang on the tiled houses, a stone cornice on the tall ones, or the style's."""
    top = style.get('top')
    if top == 'parapet':          # a moulded cornice and a white parapet over it
        slab(0, L, eave - 0.4, 0, 0.35, up=False, tone_='Trim, grey')
        proud([(0, eave - 0.4), (L, eave - 0.4), (L, eave), (0, eave)], 0.35, 'Trim, grey')
        faces.append(('WallSurface', tone, [ring_facing([P(0, eave), P(L, eave), P(L, eave + 0.9), P(0, eave + 0.9)], ox, oy)]))
        faces.append(('WallSurface', tone, [ring_facing([P(0, eave, 0.25), P(L, eave, 0.25), P(L, eave + 0.9, 0.25), P(0, eave + 0.9, 0.25)], -ox, -oy)]))
        slab(0, L, eave + 0.9, 0.25, -0.05, up=True, tone_='Trim, grey')
    elif top == 'flat':
        proud([(0, eave - 0.3), (L, eave - 0.3), (L, eave), (0, eave)], 0.1, 'Trim, grey')
    elif roof.startswith(('Clay', 'Weathered')) and eave <= 13:
        slab(0, L, eave - 0.02, 0, 1.0, up=False, tone_='Eave, wood')
        proud([(0, eave - 0.22), (L, eave - 0.22), (L, eave), (0, eave)], 1.0, 'Eave, wood')
    else:
        slab(0, L, eave - 0.45, 0, 0.45, up=False, tone_='Trim, grey')
        proud([(0, eave - 0.45), (L, eave - 0.45), (L, eave), (0, eave)], 0.45, 'Trim, grey')


def arch_outline(c, z0, w, h):
    """A round-headed opening w wide, from z0 to z0 + h at its top, as (s, z) points."""
    r = w / 2
    zs = z0 + h - r
    return [(c - r, z0), (c + r, z0)] + [(c + r * math.cos(math.pi * k / SEG), zs + r * math.sin(math.pi * k / SEG)) for k in range(SEG + 1)]


def side_of(nx, ny):
    """The way a wall faces, N E S W."""
    return 'NESW'[int(((math.degrees(math.atan2(nx, ny)) + 45) % 360) // 90)]


if __name__ == '__main__':
    squares = [(name, sides, square(ref)) for ref, (name, sides) in SQUARES.items()]
    eaves = {}
    with open('/work/roofs.csv') as f:
        for row in csv.DictReader(f):
            eaves.setdefault(row['id'], float(row['eave_m']))
    out = csv.writer(open('/work/arcades.csv', 'w', newline=''))
    out.writerow(['id', 'surface_type', 'tone', 'face'])
    edges = csv.writer(open('/work/arcade_edges.csv', 'w', newline=''))
    edges.writerow(['id', 'edge'])
    lift = csv.writer(open('/work/arcade_lift.csv', 'w', newline=''))
    lift.writerow(['id', 'dz'])
    count = {}
    with open('/work/roofin.csv') as f:
        for row in csv.DictReader(f):
            g = shapely.from_wkt(row['wkt'])
            for name, sides, pk in squares:
                if not g.intersects(pk.buffer(REACH[1] + 60)):
                    continue
                hits = []
                for poly in shapely.get_parts(g):
                    c = list(orient(poly, 1.0).exterior.coords)
                    for a, b in zip(c[:-1], c[1:]):
                        L = math.dist(a, b)
                        if L < MIN_EDGE:
                            continue
                        out_n = ((b[1] - a[1]) / L, -(b[0] - a[0]) / L)     # counter-clockwise ring: outward on the right
                        m = Point((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
                        d = pk.boundary.distance(m)
                        if pk.contains(m) or not (REACH[0] <= d <= REACH[1]):
                            continue
                        q = pk.boundary.interpolate(pk.boundary.project(m))
                        vx, vy = q.x - m.x, q.y - m.y
                        if (vx * out_n[0] + vy * out_n[1]) / math.hypot(vx, vy) < FACING:
                            continue
                        style = STYLES.get(row['id'][:9], DEFAULT) if sides is None else sides.get(side_of(*out_n))
                        if style:
                            hits.append((a, b, out_n, style))
                if not hits:
                    continue
                portal = any(h_[3].get('opening', 'arch') != 'none' for h_ in hits)
                ground = H if portal else GROUND
                eave = eave0 = eaves.get(row['id'], float(row['height_m']))
                # Floors from OpenStreetMap were taken as 3 m each; these houses' floors are taller.
                if row['height_from'] == 'floors (OSM)':
                    eave = max(eave, ground + (round(float(row['height_m']) / 3.0) - 1) * FLOOR)
                elif row['height_from'] != 'height (OSM)':
                    eave = max(eave, ground + FLOOR)
                if portal and eave < H + 1.5:
                    continue        # a single low storey: no portal
                for a, b, out_n, style in hits:
                    for st, tone, rings in arcade(a, b, out_n, eave, wall_tone(row['roof']), style, row['roof']):
                        out.writerow([row['id'], st, tone, wkt(rings)])
                    if style.get('opening', 'arch') != 'none':
                        xs, ys = to_wgs.transform([a[0], b[0]], [a[1], b[1]])
                        edges.writerow([row['id'], f'LINESTRING ({xs[0]:.7f} {ys[0]:.7f}, {xs[1]:.7f} {ys[1]:.7f})'])
                if eave > eave0 + 0.05:
                    lift.writerow([row['id'], f'{eave - eave0:.2f}'])
                count[name] = count.get(name, 0) + 1
                break
    print(', '.join(f'{k}: {v} houses' for k, v in count.items()))
