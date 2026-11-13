"""The DSN's antennas as one 3D model per complex, and the table that places them (build.sh says what and why).

Usage: build.py <in> <out>
  <in>  holds dsn34.glb (NASA's 34 m antenna), config.xml (DSN Now's configuration) and osm-<site>.json
        (OpenStreetMap around each complex);
  <out> receives <site>.glb for each complex and dishes.parquet.

NASA's antenna is rigged as the dashboard needs it: _root > azimuth (the alidade, turning about the vertical) >
elevation (the elevation wheel, tilting about its axle) > dish, dish_center, quad (the subreflector's legs),
truss_dish; base beside azimuth. At rest the dish points at the zenith and the elevation axle's front faces west
(_root is turned a quarter about the vertical). Each antenna here is that tree under a node of its own, turned a
quarter back so that its front faces north: a reading's azimuth (degrees clockwise from north) is then the
azimuth part's yaw as it is, and its elevation minus 90 the elevation part's pitch.

The model's meshes are Draco-compressed: they are decoded with DracoPy. A model already decoded (plain accessors)
is read as it is.
"""

import json
import math
import re
import struct
import sys
from pathlib import Path

import duckdb

R = 6_371_008.8  # mean Earth radius, m
QUARTER_BACK = [0.0, -math.sqrt(0.5), 0.0, math.sqrt(0.5)]  # −90° about glTF's Y
# NASA's model is a 34 m antenna; a 70 m one is drawn at twice its size.
SCALE = {'70M': 70 / 34}
DIAMETER = {'70M': 70, '34M': 34, '34MHEF': 34}
# Base colours by NASA's material (its textures are left out: the 4D Model reads base colours), linear.
COLOURS = {
    'tex_02.003': [0.9, 0.9, 0.88, 1],  # the dish's panels
    'tex_02': [0.82, 0.82, 0.8, 1],  # the dish's centre
    'tex_01': [0.72, 0.72, 0.7, 1],  # subreflector legs, axle housings
    'truss_dish_AO': [0.45, 0.46, 0.47, 1],  # the dish's back structure
    'truss_2': [0.5, 0.5, 0.5, 1],
    'frame_AO': [0.62, 0.62, 0.6, 1],  # the alidade
    'wheels_AO': [0.25, 0.25, 0.25, 1],
    'stairs_plt_AO': [0.4, 0.4, 0.4, 1],
    'base_AO': [0.55, 0.53, 0.5, 1],  # the concrete pedestal
}


def read_glb(path):
    data = Path(path).read_bytes()
    if data[:4] != b'glTF':
        raise SystemExit(f'{path}: not a glb')
    length = struct.unpack_from('<I', data, 12)[0]
    gltf = json.loads(data[20 : 20 + length])
    at = 20 + length
    binary = b''
    if at < len(data):
        size = struct.unpack_from('<I', data, at)[0]
        binary = data[at + 8 : at + 8 + size]
    return gltf, binary


def view_bytes(gltf, binary, index):
    view = gltf['bufferViews'][index]
    start = view.get('byteOffset', 0)
    return binary[start : start + view['byteLength']]


def primitive_geometry(gltf, binary, primitive):
    """A primitive's positions (float32 x, y, z) and triangle indices (uint32), as bytes."""
    draco = primitive.get('extensions', {}).get('KHR_draco_mesh_compression')
    if draco:
        import DracoPy  # only for a compressed model
        import numpy as np

        mesh = DracoPy.decode(view_bytes(gltf, binary, draco['bufferView']))
        points = np.ascontiguousarray(mesh.points, dtype='<f4')
        faces = np.ascontiguousarray(mesh.faces, dtype='<u4')
        return points.tobytes(), faces.tobytes(), len(points)
    position = gltf['accessors'][primitive['attributes']['POSITION']]
    if position.get('componentType') != 5126 or 'byteStride' in gltf['bufferViews'][position['bufferView']]:
        raise SystemExit('a plain model must have packed float positions')
    raw = view_bytes(gltf, binary, position['bufferView'])
    start = position.get('byteOffset', 0)
    points = raw[start : start + position['count'] * 12]
    index = gltf['accessors'][primitive['indices']]
    width = {5121: 'B', 5123: 'H', 5125: 'I'}[index['componentType']]
    raw = view_bytes(gltf, binary, index['bufferView'])
    start = index.get('byteOffset', 0)
    values = struct.unpack_from(f'<{index["count"]}{width}', raw, start)
    return points, struct.pack(f'<{len(values)}I', *values), position['count']


def bounds(points):
    xyz = struct.unpack(f'<{len(points) // 4}f', points)
    return [min(xyz[i::3]) for i in range(3)], [max(xyz[i::3]) for i in range(3)]


def config_sites(path):
    """DSN Now's complexes: [(site, name, [(dish, type)])], in its order."""
    text = Path(path).read_text()
    sites = []
    for match in re.finditer(r'<site ([^>]*)>(.*?)</site>', text, re.S):
        attrs = dict(re.findall(r'(\w+)="([^"]*)"', match.group(1)))
        dishes = []
        for dish in re.finditer(r'<dish ([^>]*)>', match.group(2)):
            d = dict(re.findall(r'(\w+)="([^"]*)"', dish.group(1)))
            dishes.append((d['name'], d.get('type', '34M')))
        sites.append((attrs['name'], attrs.get('friendlyName', attrs['name']), dishes))
    if not sites:
        raise SystemExit('config.xml: no site')
    return sites


def osm_dishes(path):
    """Where each DSS-nn stands in OpenStreetMap: a way's footprint centre over a node's point."""
    elements = json.loads(Path(path).read_text())['elements']
    nodes = {e['id']: e for e in elements if e['type'] == 'node'}
    found = {}
    for e in elements:
        tags = e.get('tags', {})
        match = re.search(r'DSS[- ]?(\d+)', f"{tags.get('ref', '')} {tags.get('name', '')}")
        if not match:
            continue
        key = f'DSS{int(match.group(1))}'
        if e['type'] == 'node':
            place = (e['lat'], e['lon'])
        elif e['type'] == 'way':
            ring = [nodes[n] for n in dict.fromkeys(e.get('nodes', [])) if n in nodes]
            if not ring:
                continue
            place = (sum(n['lat'] for n in ring) / len(ring), sum(n['lon'] for n in ring) / len(ring))
        else:
            continue
        # A way (the dish's footprint) wins over a node (often an old tower point).
        if key not in found or e['type'] == 'way':
            found[key] = place
    return found


def build(inp, out):
    nasa, nasa_bin = read_glb(inp / 'dsn34.glb')
    # Decode once: every antenna shares the meshes.
    meshes = []
    for mesh in nasa['meshes']:
        meshes.append([(primitive_geometry(nasa, nasa_bin, p), p.get('material')) for p in mesh['primitives']])
    materials = []
    for material in nasa.get('materials', []):
        colour = COLOURS.get(material.get('name'), [0.7, 0.7, 0.7, 1])
        materials.append(
            {
                'name': material.get('name', ''),
                'pbrMetallicRoughness': {'baseColorFactor': colour, 'metallicFactor': 0, 'roughnessFactor': 1},
            }
        )
    roots = nasa['scenes'][nasa.get('scene', 0)]['nodes']
    if len(roots) != 1 or nasa['nodes'][roots[0]].get('name') != '_root':
        raise SystemExit('dsn34.glb: not the rig this script knows (_root > azimuth > elevation > dish)')

    rows = []
    for site, site_name, dishes in config_sites(inp / 'config.xml'):
        places = osm_dishes(inp / f'osm-{site}.json')
        placed = [(d, t, places[d]) for d, t in dishes if d in places]
        for d, _ in dishes:
            if d not in places:
                print(f'{site}: {d} is not in OpenStreetMap, left out', file=sys.stderr)
        if not placed:
            raise SystemExit(f'{site}: no antenna found')
        # The model's origin: the complex's 70 m antenna, else its first.
        origin = next((p for d, t, p in placed if t == '70M'), placed[0][2])
        lat0, lon0 = origin

        # The glTF: buffers and accessors for the shared meshes, then a tree per antenna.
        chunks, views, accessors, out_meshes = [], [], [], []
        offset = 0

        def push(data, target):
            nonlocal offset
            pad = (-len(data)) % 4
            views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(data), 'target': target})
            chunks.append(data + b'\0' * pad)
            offset += len(data) + pad
            return len(views) - 1

        for mesh, source in zip(meshes, nasa['meshes']):
            primitives = []
            for (points, faces, count), material in mesh:
                low, high = bounds(points)
                accessors.append(
                    {
                        'bufferView': push(points, 34962),
                        'componentType': 5126,
                        'count': count,
                        'type': 'VEC3',
                        'min': low,
                        'max': high,
                    }
                )
                accessors.append(
                    {'bufferView': push(faces, 34963), 'componentType': 5125, 'count': len(faces) // 4, 'type': 'SCALAR'}
                )
                primitive = {'attributes': {'POSITION': len(accessors) - 2}, 'indices': len(accessors) - 1, 'mode': 4}
                if material is not None:
                    primitive['material'] = material
                primitives.append(primitive)
            out_meshes.append({'name': source.get('name', ''), 'primitives': primitives})

        nodes = []

        def copy(index, dish):
            """NASA's node `index` and its children, named <dish>.<name>; _root keeps no mesh (a helper box)."""
            source = nasa['nodes'][index]
            name = source.get('name', '')
            node = {'name': f'{dish}.{"root" if name == "_root" else name}'}
            for key in ('translation', 'rotation', 'scale', 'matrix'):
                if key in source:
                    node[key] = source[key]
            if 'mesh' in source and name != '_root':
                node['mesh'] = source['mesh']
            nodes.append(node)
            at = len(nodes) - 1
            children = [copy(child, dish) for child in source.get('children', [])]
            if children:
                nodes[at]['children'] = children
            return at

        scene = []
        for dish, kind, (lat, lon) in placed:
            east = R * math.cos(math.radians(lat0)) * math.radians(lon - lon0)
            north = R * math.radians(lat - lat0)
            scale = SCALE.get(kind, 1.0)
            tree = copy(roots[0], dish)
            nodes.append(
                {
                    'name': dish,
                    'translation': [round(east, 3), 0.0, round(-north, 3)],
                    'rotation': QUARTER_BACK,
                    'scale': [scale, scale, scale],
                    'children': [tree],
                }
            )
            scene.append(len(nodes) - 1)
            rows.append(
                {
                    'dish': dish,
                    'name': f'DSS-{dish[3:]}',
                    'site': site,
                    'site_name': site_name,
                    'type': kind,
                    'diameter_m': DIAMETER.get(kind, 34),
                    'latitude': round(lat, 7),
                    'longitude': round(lon, 7),
                    'east_m': round(east, 1),
                    'north_m': round(north, 1),
                    'origin_latitude': round(lat0, 7),
                    'origin_longitude': round(lon0, 7),
                }
            )

        body = b''.join(chunks)
        gltf = {
            'asset': {
                'version': '2.0',
                'generator': 'pacha-dashboards datasets/dsn-antennas/build.py',
                'copyright': "Antenna: NASA (science.nasa.gov 3D resources); places: © OpenStreetMap contributors",
            },
            'scene': 0,
            'scenes': [{'name': site_name, 'nodes': scene}],
            'nodes': nodes,
            'meshes': out_meshes,
            'materials': materials,
            'accessors': accessors,
            'bufferViews': views,
            'buffers': [{'byteLength': len(body)}],
        }
        text = json.dumps(gltf, separators=(',', ':')).encode()
        text += b' ' * ((-len(text)) % 4)
        glb = b''.join(
            [
                struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(text) + 8 + len(body)),
                struct.pack('<I4s', len(text), b'JSON'),
                text,
                struct.pack('<I4s', len(body), b'BIN\0'),
                body,
            ]
        )
        (out / f'{site}.glb').write_bytes(glb)
        print(f'{site}.glb: {len(placed)} antennas, {len(glb) / 1e6:.1f} MB')

    con = duckdb.connect()
    con.execute(
        'CREATE TABLE dishes (dish VARCHAR, name VARCHAR, site VARCHAR, site_name VARCHAR, type VARCHAR, '
        'diameter_m INTEGER, latitude DOUBLE, longitude DOUBLE, east_m DOUBLE, north_m DOUBLE, '
        'origin_latitude DOUBLE, origin_longitude DOUBLE)'
    )
    con.executemany(
        'INSERT INTO dishes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
            [
                r['dish'],
                r['name'],
                r['site'],
                r['site_name'],
                r['type'],
                r['diameter_m'],
                r['latitude'],
                r['longitude'],
                r['east_m'],
                r['north_m'],
                r['origin_latitude'],
                r['origin_longitude'],
            ]
            for r in rows
        ],
    )
    con.execute(f"COPY (SELECT * FROM dishes ORDER BY site, dish) TO '{out / 'dishes.parquet'}' (FORMAT parquet)")
    print(f'dishes.parquet: {len(rows)} antennas')
    # The recorder's feed (recorder/feeds/dsn-now.sql) with no rows: the dashboard reads it beside the recording, so a
    # time range with nothing recorded reads as no rows, not as an error.
    con.execute(
        'COPY (SELECT NULL::TIMESTAMPTZ AS ts, NULL::VARCHAR AS hex, NULL::DOUBLE AS azimuth, NULL::DOUBLE AS elevation, '
        'NULL::DOUBLE AS wind, NULL::VARCHAR AS activity, NULL::VARCHAR AS targets, NULL::DOUBLE AS down_bps, '
        'NULL::DOUBLE AS up_kw, NULL::VARCHAR AS band, NULL::DOUBLE AS range_km, NULL::DOUBLE AS rtlt_s WHERE false) '
        f"TO '{out / 'recording-empty.parquet'}' (FORMAT parquet)"
    )


if __name__ == '__main__':
    build(Path(sys.argv[1]), Path(sys.argv[2]))
