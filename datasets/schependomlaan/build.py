"""Schependomlaan in 4D: the IFC model as glTF parts named by GlobalId, and its schedule as Parquet.

Run by build.sh (python -I build.py <src> <out>) with IfcOpenShell, NumPy and DuckDB installed. Reads from <src>:
planned.ifc (the as-planned IFC exported from Synchro, whose GlobalIds the event logs use), eventlog_planned.csv
and eventlog_asbuilt.csv. Writes to <out>:

- model.glb: one node per IFC element, named by its GlobalId, metres, Y up, -Z north of the model's own grid;
  origin at the centre of the model's plan, at the IFC's zero (the ground floor, "peil"). One material per kind
  of element (Synchro's export lost the architect's colours).
- parts.parquet: one row per element with its first task, the span of its tasks, its kind and whether the
  as-built log has one of its tasks finished late.
- tasks.parquet: one row per task with its span and how many elements it builds.

Task names are the contractor's Dutch ones, with an English name beside them.
"""
import json
import multiprocessing
import struct
import sys
from pathlib import Path

import duckdb
import ifcopenshell
import ifcopenshell.geom
import numpy as np

SKIP = {'IfcSpace', 'IfcOpeningElement', 'IfcSite', 'IfcAnnotation', 'IfcGrid', 'IfcVirtualElement'}

# What each IFC class is drawn as, and that kind's colour (sRGB).
KIND = {
    'IfcWall': 'Brickwork', 'IfcWallStandardCase': 'Brickwork',
    'IfcSlab': 'Concrete', 'IfcBeam': 'Concrete', 'IfcColumn': 'Concrete', 'IfcMember': 'Concrete',
    'IfcFooting': 'Concrete', 'IfcStair': 'Concrete', 'IfcStairFlight': 'Concrete',
    'IfcWindow': 'Windows and doors', 'IfcDoor': 'Windows and doors',
    'IfcRoof': 'Roof', 'IfcCovering': 'Finishes', 'IfcBuildingElementPart': 'Finishes',
}
COLOUR = {
    'Brickwork': '#9c5a44', 'Concrete': '#a3a29c', 'Windows and doors': '#5f7f95', 'Roof': '#4a4f57',
    'Finishes': '#c9c3b5', 'Other': '#7d8288',
}

ENGLISH = {
    'Stellen bruggetjes': 'Set up supports',
    'Bekisten liftwanden': 'Formwork, lift shaft walls',
    'Stellen funderingkist incl. poeren': 'Foundation formwork and footings',
    'Opstorten fundering': 'Pour foundations',
    'Stelwerk metselwerk onder peil': 'Masonry below grade',
    'Kanaalplaatvloer leggen (lev. week 16)': 'Lay hollow-core ground floor',
    'Afstorten kanaalplaat': 'Top pour, hollow-core floor',
    'Plaatsen stalen kolommen': 'Place steel columns',
    'Stelwerk kalkzandsteen': 'Sand-lime block walls',
    'Leggen breedplaat incl. Veiligheid': 'Lay precast floor plates',
    'Stalen balken': 'Steel beams',
    'Prefab trappen en bordes': 'Precast stairs and landings',
    'Lijmwerk kalkzandsteen elementen': 'Glue sand-lime elements',
    'Opstellen': 'Erect',
    'Stort': 'Concrete pour',
    'Stelwerk buitengevel': 'Outer facade',
    'Plaatsen kozijnen': 'Place window frames',
    'Metselwerk': 'Brickwork',
    'Prefab trappen en bordes 2e verd.': 'Precast stairs, 2nd floor',
    'Staalconstuctie dak': 'Roof steelwork',
    'Stelwerk /lijmwerk lift': 'Lift shaft blockwork',
    'Plaatsen scharnierkap incl. goot en platte daken': 'Pitched roof, gutters, flat roofs',
    'Dakramen': 'Roof windows',
    'Dakbedekking platte daken': 'Flat roof covering',
    'Afbouw': 'Fit-out',
    'Zinken bekleding dakkapelen': 'Zinc dormer cladding',
    'Zink goot': 'Zinc gutters',
}


def linear(hex_colour):
    """glTF base colours are linear."""
    return [((int(hex_colour[i:i + 2], 16) / 255) ** 2.2) for i in (1, 3, 5)] + [1.0]


def elements(path):
    """(GlobalId, class, name, vertices (n, 3) IFC metres, faces (m, 3)) per element with geometry."""
    model = ifcopenshell.open(path)
    settings = ifcopenshell.geom.settings()
    settings.set('use-world-coords', True)
    it = ifcopenshell.geom.iterator(settings, model, multiprocessing.cpu_count())
    if not it.initialize():
        sys.exit('The IFC has no geometry')
    while True:
        shape = it.get()
        product = model.by_id(shape.id)
        if product.is_a() not in SKIP:
            v = np.asarray(shape.geometry.verts, dtype=np.float64).reshape(-1, 3)
            f = np.asarray(shape.geometry.faces, dtype=np.uint32).reshape(-1, 3)
            if len(f):
                yield product.GlobalId, product.is_a(), (product.Name or '').strip(), v, f
        if not it.next():
            break


def write_glb(path, parts):
    """parts: [(name, kind, positions float32 (n, 3) glTF frame, indices uint32 (m,))]. One mesh per part."""
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

    for name, kind, positions, indices in parts:
        pv = add(positions.astype(np.float32).tobytes(), 34962)
        accessors.append({'bufferView': pv, 'componentType': 5126, 'count': len(positions), 'type': 'VEC3',
                          'min': positions.min(axis=0).tolist(), 'max': positions.max(axis=0).tolist()})
        iv = add(indices.astype(np.uint32).tobytes(), 34963)
        accessors.append({'bufferView': iv, 'componentType': 5125, 'count': len(indices), 'type': 'SCALAR'})
        meshes.append({'primitives': [{'attributes': {'POSITION': len(accessors) - 2}, 'indices': len(accessors) - 1,
                                       'material': material_of[kind]}]})
        nodes.append({'name': name, 'mesh': len(meshes) - 1})
    doc = {
        'asset': {'version': '2.0', 'generator': 'pacha datasets/schependomlaan/build.py',
                  'copyright': 'Dataset Schependomlaan (TU Eindhoven, Hendriks Bouw en Ontwikkeling, ROOT, TNO, '
                               'RAAMAC), CC BY 4.0'},
        'scene': 0,
        'scenes': [{'nodes': list(range(len(nodes)))}],
        'nodes': nodes,
        'meshes': meshes,
        'materials': [{'name': kind, 'pbrMetallicRoughness': {'baseColorFactor': linear(COLOUR[kind]),
                                                              'metallicFactor': 0, 'roughnessFactor': 0.9}}
                      for kind in kinds],
        'accessors': accessors,
        'bufferViews': views,
        'buffers': [{'byteLength': len(blob)}],
    }
    text = json.dumps(doc, separators=(',', ':')).encode()
    text += b' ' * (-len(text) % 4)
    blob.extend(b'\0' * (-len(blob) % 4))
    with open(path, 'wb') as fh:
        fh.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(text) + 8 + len(blob)))
        fh.write(struct.pack('<II', len(text), 0x4E4F534A) + text)
        fh.write(struct.pack('<II', len(blob), 0x004E4942) + bytes(blob))


def main(src, out):
    src, out = Path(src), Path(out)
    found = list(elements(str(src / 'planned.ifc')))
    lo = np.min([v.min(axis=0) for *_, v, _ in found], axis=0)
    hi = np.max([v.max(axis=0) for *_, v, _ in found], axis=0)
    # The plan's centre; heights stay the IFC's, whose zero is the ground floor.
    centre = np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, 0.0])
    parts = []
    rows = []
    for guid, cls, name, v, f in found:
        local = v - centre
        # IFC x east, y north, z up -> glTF x, z up as y, north as -z.
        gl = np.column_stack([local[:, 0], local[:, 2], -local[:, 1]])
        kind = KIND.get(cls, 'Other')
        parts.append((guid, kind, gl, f.reshape(-1)))
        rows.append((guid, cls.removeprefix('Ifc'), kind, name))
    write_glb(out / 'model.glb', parts)

    c = duckdb.connect()
    c.execute('CREATE TABLE el (guid VARCHAR, ifc_class VARCHAR, kind VARCHAR, name VARCHAR)')
    c.executemany('INSERT INTO el VALUES (?, ?, ?, ?)', rows)
    c.execute('CREATE TABLE en (task_nl VARCHAR, task VARCHAR)')
    c.executemany('INSERT INTO en VALUES (?, ?)', list(ENGLISH.items()))
    c.execute(f"""
        CREATE TABLE planned AS
        SELECT GUID AS guid, Task AS task_id, trim(TaskName) AS task_nl,
               strptime(TaskStart, '%-d-%-m-%Y')::DATE AS start_date,
               strptime(TaskFinish, '%-d-%-m-%Y')::DATE AS finish_date
        FROM read_csv('{src / 'eventlog_planned.csv'}', all_varchar = true)""")
    c.execute(f"""
        CREATE TABLE asbuilt AS
        SELECT GUID AS guid, TaskID AS task_id, "Element on time or not" AS on_time
        FROM read_csv('{src / 'eventlog_asbuilt.csv'}', all_varchar = true)
        WHERE coalesce("Element on time or not", '') <> ''""")
    # Fit-out (Afbouw) names every element from September to December: an element's own work is its other tasks.
    c.execute("""
        CREATE TABLE parts AS
        WITH t AS (
          SELECT p.*, coalesce(en.task, p.task_nl) AS task, a.on_time,
                 count(*) FILTER (WHERE p.task_nl <> 'Afbouw') OVER (PARTITION BY p.guid) AS own
          FROM planned p LEFT JOIN en USING (task_nl) LEFT JOIN asbuilt a USING (guid, task_id)
        )
        SELECT guid, ifc_class, kind, name,
               arg_min(task, start_date) FILTER (WHERE own = 0 OR task_nl <> 'Afbouw') AS task,
               arg_min(task_nl, start_date) FILTER (WHERE own = 0 OR task_nl <> 'Afbouw') AS task_nl,
               min(start_date) FILTER (WHERE own = 0 OR task_nl <> 'Afbouw') AS start_date,
               max(finish_date) FILTER (WHERE own = 0 OR task_nl <> 'Afbouw') AS finish_date,
               count(*) FILTER (WHERE own = 0 OR task_nl <> 'Afbouw') AS tasks,
               CASE WHEN bool_or(on_time = 'Too late') THEN 'Finished late'
                    WHEN bool_or(on_time = 'On time') THEN 'On time'
                    ELSE 'No as-built record' END AS as_built
        FROM t JOIN el USING (guid)
        GROUP BY ALL
        ORDER BY start_date, guid""")
    c.execute(f"COPY parts TO '{out / 'parts.parquet'}' (FORMAT parquet, COMPRESSION zstd)")
    c.execute(f"""
        COPY (
          SELECT task, task_nl, min(start_date) AS start_date, max(finish_date) AS finish_date,
                 count(*) AS elements, count(*) FILTER (WHERE as_built = 'Finished late') AS late
          FROM parts GROUP BY ALL ORDER BY start_date, finish_date, task
        ) TO '{out / 'tasks.parquet'}' (FORMAT parquet, COMPRESSION zstd)""")
    n, unscheduled = c.execute('SELECT count(*), count(*) FILTER (WHERE start_date IS NULL) FROM parts').fetchone()
    print(f'{len(parts)} parts in model.glb ({(out / "model.glb").stat().st_size / 1e6:.1f} MB), '
          f'{n} in parts.parquet ({unscheduled} unscheduled)')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
