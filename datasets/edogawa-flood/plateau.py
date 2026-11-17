"""PLATEAU's CityGML of Edogawa, one 1 km tile at a time, for edogawa-flood (standard library only).

Usage:
  plateau.py list <zip url> <out file>                 the building tiles in the zip: "<mesh> <entry>" a line
  plateau.py extract <zip url> <dir> <entry>...        those entries, read by HTTP ranges, into <dir>
  plateau.py inject <attrs.json> <in.json> <out.json>  a citygml-tools CityJSON made light, with our attributes
  plateau.py attrs <attrs.json> <dir>                  every CityJSON in <dir> given the attributes again

The zip is 578 MB with every theme of the ward (buildings, bridges, roads, flood zones, terrain);
its central directory is read first and then only the bytes of the files asked for.
"""
import io
import json
import re
import sys
import urllib.request
import zipfile


class HttpFile(io.RawIOBase):
    """A remote file read by HTTP ranges, enough for zipfile."""

    def __init__(self, url):
        self.url = url
        self.pos = 0
        head = urllib.request.urlopen(urllib.request.Request(url, method='HEAD'), timeout=60)
        self.size = int(head.headers['Content-Length'])

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        return self.pos

    def readinto(self, buffer):
        n = min(len(buffer), self.size - self.pos)
        if n <= 0:
            return 0
        request = urllib.request.Request(self.url, headers={'Range': f'bytes={self.pos}-{self.pos + n - 1}'})
        data = urllib.request.urlopen(request, timeout=300).read()
        buffer[: len(data)] = data
        self.pos += len(data)
        return len(data)


def open_zip(url):
    return zipfile.ZipFile(io.BufferedReader(HttpFile(url), buffer_size=4 << 20))


def list_tiles(url, out):
    tiles = []
    for info in open_zip(url).infolist():
        m = re.search(r'udx/bldg/(\d{8})_bldg_6697_op\.gml$', info.filename)
        if m:
            tiles.append(f'{m.group(1)} {info.filename}')
    with open(out, 'w') as f:
        f.write('\n'.join(sorted(tiles)) + '\n')
    print(f'{len(tiles)} building tiles')


def extract(url, folder, entries):
    z = open_zip(url)
    for entry in entries:
        mesh = re.search(r'(\d{8})_bldg', entry).group(1)
        with z.open(entry) as src, open(f'{folder}/{mesh}.gml', 'wb') as dst:
            while chunk := src.read(4 << 20):
                dst.write(chunk)


def inject(attrs_path, src, out):
    """
    Keeps each building's LoD 1 block and LoD 2 model (LoD 0's roof edge is the block's outline again), drops the
    textures (the pictures are not served), keeps only the vertices still used, and gives each building the
    attributes the dashboard shows: its key in the rows, storeys, height, use, and the water PLATEAU expects there.
    citygml-tools leaves PLATEAU's own attributes out (no i-UR extension), so they come from Flateau (attrs.json).
    """
    attrs = json.load(open(attrs_path))
    names = attrs['columns']
    rows = attrs['rows']
    doc = json.load(open(src))
    used = {}
    vertices = doc['vertices']
    kept = []

    def remap(boundary):
        if isinstance(boundary, list):
            return [remap(b) for b in boundary]
        if boundary not in used:
            used[boundary] = len(kept)
            kept.append(vertices[boundary])
        return used[boundary]

    # A tile on the ward's edge also holds the neighbouring wards' buildings (Koto's, Katsushika's): Flateau's
    # Edogawa has only the ward's own, so a building it lacks is left out.
    outside = [oid for oid in doc['CityObjects'] if oid not in rows]
    for oid in outside:
        del doc['CityObjects'][oid]
    for obj in doc['CityObjects'].values():
        obj['children'] = [c for c in obj.get('children', []) if c in doc['CityObjects']] or None
        if obj['children'] is None:
            del obj['children']
    for oid, obj in doc['CityObjects'].items():
        geometry = []
        for g in obj.get('geometry', []):
            if str(g.get('lod', '')).startswith('0'):
                continue
            g.pop('texture', None)
            g.pop('material', None)
            g['boundaries'] = remap(g['boundaries'])
            geometry.append(g)
        obj['geometry'] = geometry
        obj['attributes'] = {k: v for k, v in zip(names, rows[oid]) if v is not None}
    doc['vertices'] = kept
    doc.pop('appearance', None)
    doc.pop('geometry-templates', None)
    with open(out, 'w') as f:
        json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{out}: {len(doc["CityObjects"])} buildings, {len(kept)} vertices, {len(outside)} outside the ward left out')


def reattribute(attrs_path, folder):
    """The attributes of attrs.json written again on every building of the tiles already made (a new column, a fix)."""
    import glob
    attrs = json.load(open(attrs_path))
    names = attrs['columns']
    rows = attrs['rows']
    files = sorted(glob.glob(f'{folder}/*.json'))
    for path in files:
        doc = json.load(open(path))
        for oid, obj in doc['CityObjects'].items():
            obj['attributes'] = {k: v for k, v in zip(names, rows[oid]) if v is not None}
        with open(path, 'w') as f:
            json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
    print(f'attributes written on {len(files)} tiles')


if __name__ == '__main__':
    command, *args = sys.argv[1:]
    if command == 'list':
        list_tiles(*args)
    elif command == 'extract':
        extract(args[0], args[1], args[2:])
    elif command == 'inject':
        inject(*args)
    elif command == 'attrs':
        reattribute(*args)
    else:
        sys.exit(f'unknown command {command}')
