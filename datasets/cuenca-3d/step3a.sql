INSTALL spatial; LOAD spatial;
CREATE TABLE b AS
SELECT bd.id, bd.source, bd.height_m, bd.height_from, bd.area_m2, ST_GeomFromWKB(bd.g_wgs) AS geom, ST_GeomFromWKB(bd.g_utm) AS g_utm,
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
COPY (SELECT id, roof, height_m, height_from, ST_AsText(g_utm) AS wkt FROM cls) TO '/work/roofin.csv' (HEADER);
SELECT roof, count(*) n FROM cls GROUP BY 1 ORDER BY 2 DESC;
