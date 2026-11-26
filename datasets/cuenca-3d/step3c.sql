INSTALL spatial; LOAD spatial;
-- Landmarks (landmarks.py) in place of the generic blocks whose centroid falls in their footprint.
CREATE TABLE fp AS SELECT osm, name, ST_GeomFromText(wkt) AS g FROM read_csv('/work/landmark_footprints.csv', header = true, all_varchar = true);
CREATE TABLE lm AS SELECT * FROM read_csv('/work/landmarks.csv', header = true, all_varchar = true);
CREATE TABLE base0 AS SELECT * FROM '/work/surfaces-lifted.parquet';
-- Portals (arcades.py): the plain wall on each opened edge goes (both its ground corners on the edge), the arcade comes.
CREATE TABLE ae AS SELECT id AS building_id, ST_GeomFromText(edge) AS e FROM read_csv('/work/arcade_edges.csv', header = true, all_varchar = true);
CREATE TABLE ac AS SELECT id AS building_id, surface_type, tone, face FROM read_csv('/work/arcades.csv', header = true, all_varchar = true);
CREATE TABLE dropped AS
SELECT DISTINCT b.building_id, b.geometry FROM base0 b JOIN ae USING (building_id)
WHERE b.surface_type = 'WallSurface'
  AND ST_DWithin(ST_Force2D(ST_PointN(ST_ExteriorRing(ST_GeomFromText(b.geometry)), 1)), ae.e, 0.000003)
  AND ST_DWithin(ST_Force2D(ST_PointN(ST_ExteriorRing(ST_GeomFromText(b.geometry)), 2)), ae.e, 0.000003);
CREATE TABLE base AS
SELECT * FROM base0 WHERE (building_id, geometry) NOT IN (SELECT building_id, geometry FROM dropped)
UNION ALL
SELECT ac.building_id, ac.surface_type, ac.tone, k.roof, k.height_m, k.eave_m, k.top_m, k.pitched, k.height_from, k.source, k.area_m2, k.latitude, k.longitude, ac.face
FROM ac JOIN (SELECT DISTINCT ON (building_id) * FROM base0) k USING (building_id);
SELECT (SELECT count(*) FROM dropped) AS walls_dropped, (SELECT count(*) FROM ac) AS arcade_faces, (SELECT count(DISTINCT building_id) FROM ac) AS buildings;
CREATE TABLE gone AS
SELECT DISTINCT b.building_id FROM base b JOIN fp ON ST_Contains(ST_Buffer(fp.g, 0.00001), ST_Point(b.longitude, b.latitude));
COPY (
SELECT building_id, NULL::VARCHAR AS name, surface_type, tone, roof, height_m, eave_m, top_m, pitched, height_from, source, area_m2, latitude, longitude, geometry
FROM base WHERE building_id NOT IN (SELECT building_id FROM gone)
UNION ALL
SELECT 'osm:way/' || lm.osm, lm.name, lm.surface_type, lm.tone, 'Landmark', lm.top_m::DOUBLE, lm.eave_m::DOUBLE, lm.top_m::DOUBLE, true,
  'landmark spec', 'OpenStreetMap', round(ST_Area_Spheroid(ST_FlipCoordinates(fp.g)), 1),
  round(ST_Y(ST_Centroid(fp.g)), 6), round(ST_X(ST_Centroid(fp.g)), 6), lm.face
FROM lm JOIN fp USING (osm)
ORDER BY latitude, longitude, building_id, surface_type
) TO '/work/surfaces.parquet' (FORMAT parquet, COMPRESSION zstd);
SELECT (SELECT count(*) FROM gone) AS replaced, count(*) FILTER (WHERE name IS NOT NULL) AS landmark_rows, count(*) AS rows FROM '/work/surfaces.parquet';
SELECT name, count(*) n, max(top_m) top FROM '/work/surfaces.parquet' WHERE name IS NOT NULL GROUP BY 1;
