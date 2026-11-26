"""Hipped roofs from footprints: the straight skeleton's roof, the wavefront of the footprint moving inwards at the
same speed from every edge, which is a negative buffer with mitred corners. Rings every STEP metres (finer near the
top), the bands between them triangulated (GEOS constrained Delaunay), each triangle given to the edge whose plane it
lies on, the triangles of an edge joined into its roof face, every corner's height from that plane: exact planar
faces, ridges and hips where the faces meet, faces sloping into patios. A roof rising past MAX_RISE is cut flat there.

  in:  /work/roofin.csv   id, roof, height_m, height_from, wkt (footprint, UTM metres)
  out: /work/roofs.csv    id, eave_m, ridge_m, face (POLYGON Z, WGS84 lon/lat, z in metres over the ground)
"""
import csv
import os
import math
import sys

import shapely
from pyproj import Transformer
from shapely.geometry import MultiPolygon, Polygon

TO_WGS84 = Transformer.from_crs('EPSG:32717', 'EPSG:4326', always_xy=True)
from shapely.geometry.polygon import orient

PITCH = float(sys.argv[1]) if __name__ == '__main__' and len(sys.argv) > 1 else 27.0
TAN = math.tan(math.radians(PITCH))
MAX_RISE = 4.0
STEP, FINE = 0.5, 0.05
PITCHED = {'Clay tile', 'Clay tile, dark', 'Clay tile, light', 'Weathered tile'}
MIN_AREA = 12.0


def edges_of(poly):
    """Each edge with the footprint on its left: a, b and its inward unit normal."""
    poly = orient(poly, 1.0)
    out = []
    for ring in [poly.exterior, *poly.interiors]:
        c = list(ring.coords)
        for a, b in zip(c[:-1], c[1:]):
            dx, dy = b[0] - a[0], b[1] - a[1]
            n = math.hypot(dx, dy)
            if n > 1e-6:
                out.append((a, b, (-dy / n, dx / n)))
    return out


def line_d(e, p):
    a, _, n = e
    return n[0] * (p[0] - a[0]) + n[1] * (p[1] - a[1])


def seg_d(e, p):
    a, b, _ = e
    dx, dy = b[0] - a[0], b[1] - a[1]
    t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)


def inset(poly, t):
    return poly.buffer(-t, join_style='mitre', mitre_limit=1000) if t > 0 else poly


def wavefront(poly, tcap):
    """The fronts and their times, finer as the footprint closes, up to tcap."""
    shapes, times, t = [poly], [0.0], 0.0
    while t < tcap:
        nt = min(t + STEP, tcap)
        s = inset(poly, nt)
        if s.is_empty:
            # Closes between t and nt: walk it in fine steps to its last front.
            ft = t + FINE
            while ft < nt:
                s = inset(poly, ft)
                if s.is_empty:
                    break
                shapes.append(s)
                times.append(ft)
                ft += FINE
            return shapes, times, False
        shapes.append(s)
        times.append(nt)
        t = nt
    return shapes, times, True


def time_of(p, shapes, k):
    """A band corner's time: on front k, else on front k+1."""
    if k + 1 < len(shapes) and not shapes[k + 1].is_empty and shapes[k + 1].boundary.distance(shapely.Point(p)) < 1e-3:
        return k + 1
    return k


def roof_faces(poly):
    poly = poly.simplify(0.05)
    if poly.is_empty or poly.area < MIN_AREA:
        return None
    edges = edges_of(poly)
    tcap = MAX_RISE / TAN
    shapes, times, capped = wavefront(poly, tcap)
    tris_by_edge = {}
    for k in range(len(shapes)):
        inner = shapes[k + 1] if k + 1 < len(shapes) else None
        band = shapes[k].difference(inner) if inner is not None and not inner.is_empty else shapes[k]
        if k == len(shapes) - 1 and capped:
            break  # the flat top, below
        if band.is_empty:
            continue
        for tri in shapely.get_parts(shapely.constrained_delaunay_triangles(band)):
            pts = list(tri.exterior.coords)[:3]
            ts = [times[time_of(p, shapes, k)] for p in pts]
            c = ((pts[0][0] + pts[1][0] + pts[2][0]) / 3, (pts[0][1] + pts[1][1] + pts[2][1]) / 3)
            best, key = None, None
            for i, e in enumerate(edges):
                err = sum(abs(line_d(e, p) - t) for p, t in zip(pts, ts))
                k2 = (round(err, 2), seg_d(e, c))
                if key is None or k2 < key:
                    best, key = i, k2
            tris_by_edge.setdefault(best, []).append(tri)
    faces = []
    for i, tris in tris_by_edge.items():
        e = edges[i]
        # The band corners along a hip are on one line: simplified away (the face is planar, z comes from its plane).
        merged = shapely.union_all(tris).buffer(0).simplify(0.02)
        for part in shapely.get_parts(merged):
            if not isinstance(part, Polygon) or part.area < 0.05:
                continue
            # Counter-clockwise seen from above: the face's normal points up (City Model lights it by its normal).
            part = orient(part, 1.0)
            faces.append([[(x, y, max(0.0, min(MAX_RISE, TAN * line_d(e, (x, y))))) for x, y in r.coords]
                          for r in [part.exterior, *part.interiors]])
    top_rise = TAN * times[-1]
    if capped and not shapes[-1].is_empty:
        for part in shapely.get_parts(shapes[-1]):
            part = orient(part.simplify(0.02), 1.0)
            faces.append([[(x, y, MAX_RISE) for x, y in r.coords] for r in [part.exterior, *part.interiors]])
        top_rise = MAX_RISE
    return faces, top_rise


def wkt_z(rings, base):
    """WGS84 lon/lat (7 decimals, about a centimetre) and z in metres."""
    out = []
    for r in rings:
        lon, lat = TO_WGS84.transform([p[0] for p in r], [p[1] for p in r])
        out.append('(' + ', '.join(f'{x:.7f} {y:.7f} {base + p[2]:.2f}' for x, y, p in zip(lon, lat, r)) + ')')
    return 'POLYGON Z (' + ', '.join(out) + ')'


if __name__ == '__main__':
    n_in = n_pitched = n_faces = 0
    with open(os.environ.get('ROOF_IN', '/work/roofin.csv')) as fin, open(os.environ.get('ROOF_OUT', '/work/roofs.csv'), 'w', newline='') as fout:
        w = csv.writer(fout)
        w.writerow(['id', 'eave_m', 'ridge_m', 'face'])
        for row in csv.DictReader(fin):
            n_in += 1
            if row['roof'] not in PITCHED:
                continue
            geom = shapely.from_wkt(row['wkt'])
            parts = [g for g in shapely.get_parts(geom) if isinstance(g, Polygon)]
            built = [r for r in (roof_faces(p) for p in parts) if r]
            if not built:
                continue
            rise = max(r[1] for r in built)
            h = float(row['height_m'])
            # OSM's height is the top of the roof; floors and estimates are taken as the eave.
            eave = max(2.5, h - rise) if row['height_from'] == 'height (OSM)' else h
            n_pitched += 1
            for faces, _ in built:
                for rings in faces:
                    w.writerow([row['id'], f'{eave:.2f}', f'{eave + rise:.2f}', wkt_z(rings, eave)])
                    n_faces += 1
    print(f'{n_in} buildings, {n_pitched} pitched, {n_faces} roof faces, pitch {PITCH} deg')
