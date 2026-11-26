INSTALL spatial; LOAD spatial;
CREATE TABLE b AS
SELECT bd.id, bd.source, bd.height_m, bd.height_from, bd.area_m2, ST_GeomFromWKB(bd.g_wgs) AS geom,
  c.r, c.g, c.bl, (c.r - c.bl) / (c.r + c.g + c.bl + 1) AS redness, (c.r + c.g + c.bl) / 3 AS bright
FROM '/work/buildings.parquet' bd JOIN '/work/colours.parquet' c USING (id);
CREATE TABLE cls AS
SELECT *, CASE
  WHEN redness >= 0.13 AND bright < 125 THEN 'Clay tile, dark'
  WHEN redness >= 0.13 AND bright < 150 THEN 'Clay tile'
  WHEN redness >= 0.13 THEN 'Clay tile, light'
  WHEN redness >= 0.07 THEN 'Weathered tile'
  WHEN bright >= 190 THEN 'Light roof'
  WHEN bright >= 120 THEN 'Grey roof'
  ELSE 'Dark roof' END AS roof
FROM b;
CREATE TABLE roofs AS SELECT * FROM read_csv('/work/roofs.csv', header = true, columns = {'id': 'VARCHAR', 'eave_m': 'DOUBLE', 'ridge_m': 'DOUBLE', 'face': 'VARCHAR'});
CREATE TABLE eaves AS SELECT id, any_value(eave_m) AS eave_m, any_value(ridge_m) AS ridge_m FROM roofs GROUP BY id;
CREATE OR REPLACE TABLE cls AS SELECT cls.*, coalesce(e.eave_m, cls.height_m) AS eave_m, coalesce(e.ridge_m, cls.height_m) AS top_m, e.id IS NOT NULL AS pitched FROM cls LEFT JOIN eaves e USING (id);
CREATE TABLE rings AS
SELECT id, part, ring_no, ring
FROM (SELECT id, unnest(ST_Dump(geom)) AS d FROM cls) t,
LATERAL (SELECT d.path[1] AS part) p,
LATERAL (SELECT unnest(ST_Dump(ST_Boundary(d.geom))) AS rr) q,
LATERAL (SELECT coalesce(rr.path[1], 1) AS ring_no, rr.geom AS ring) s;
CREATE TABLE pts AS
SELECT id, part, ring_no, i, ST_X(ST_PointN(ring, i::INTEGER)) x, ST_Y(ST_PointN(ring, i::INTEGER)) y
FROM rings, LATERAL generate_series(1, ST_NPoints(ring)) AS gs(i);
CREATE TABLE surf AS
-- Roofs: each part's rings at the building's height.
SELECT id, 'RoofSurface' AS surface_type,
  'POLYGON Z (' || string_agg(rt, ', ' ORDER BY ring_no) || ')' AS geometry
FROM (SELECT id, part, ring_no, '(' || string_agg(printf('%.7f %.7f %.1f', x, y, h), ', ' ORDER BY i) || ')' AS rt
      FROM pts JOIN (SELECT id, height_m h FROM cls WHERE NOT pitched) USING (id) GROUP BY id, part, ring_no)
GROUP BY id, part
UNION ALL
-- Pitched roofs: each face of roofs.py, already in WGS84.
SELECT id, 'RoofSurface', face
FROM roofs
UNION ALL
-- Walls: one quad per edge of every ring, ground to roof.
SELECT id, 'WallSurface',
  printf('POLYGON Z ((%.7f %.7f 0, %.7f %.7f 0, %.7f %.7f %.1f, %.7f %.7f %.1f, %.7f %.7f 0))', x0, y0, x1, y1, x1, y1, h, x0, y0, h, x0, y0)
FROM (SELECT p.id, p.x x0, p.y y0, lead(p.x) OVER w x1, lead(p.y) OVER w y1, c.eave_m h
      FROM pts p JOIN cls c USING (id) WINDOW w AS (PARTITION BY p.id, p.part, p.ring_no ORDER BY p.i))
WHERE x1 IS NOT NULL;
COPY (
SELECT s.id AS building_id, s.surface_type,
  CASE WHEN s.surface_type = 'RoofSurface' THEN c.roof
       WHEN c.roof LIKE 'Clay%' THEN 'Wall, lime-washed'
       WHEN c.roof = 'Weathered tile' THEN 'Wall, ochre'
       ELSE 'Wall, plaster' END AS tone,
  c.roof, c.height_m, round(c.eave_m, 1) AS eave_m, round(c.top_m, 1) AS top_m, c.pitched, c.height_from, c.source, c.area_m2,
  round(ST_Y(ST_Centroid(c.geom)), 6) AS latitude, round(ST_X(ST_Centroid(c.geom)), 6) AS longitude,
  s.geometry
FROM surf s JOIN cls c USING (id)
ORDER BY latitude, longitude, building_id, surface_type
) TO '/work/surfaces-base.parquet' (FORMAT parquet, COMPRESSION zstd);
SELECT surface_type, count(*) n, count(DISTINCT building_id) b FROM '/work/surfaces-base.parquet' GROUP BY 1;
SELECT roof, count(*) n FROM cls GROUP BY 1 ORDER BY 2 DESC;
SELECT geometry FROM '/work/surfaces-base.parquet' WHERE surface_type='RoofSurface' AND pitched LIMIT 2;
SELECT pitched, count(DISTINCT building_id) b, round(median(top_m - eave_m), 2) med_rise, max(top_m - eave_m) max_rise FROM '/work/surfaces-base.parquet' GROUP BY 1;
SELECT geometry FROM '/work/surfaces-base.parquet' WHERE surface_type='WallSurface' LIMIT 1;
