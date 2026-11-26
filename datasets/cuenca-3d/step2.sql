INSTALL spatial; LOAD spatial;
CREATE TABLE b AS SELECT * EXCLUDE (g_utm, g_wgs), ST_GeomFromWKB(g_utm) geom FROM '/work/buildings.parquet';
CREATE TABLE px AS SELECT *, ST_Point(x, y) p FROM read_csv('/work/pixels.csv', columns = {'col': 'INTEGER', 'row': 'INTEGER', 'x': 'DOUBLE', 'y': 'DOUBLE', 'r': 'INTEGER', 'g': 'INTEGER', 'b': 'INTEGER', 'scene': 'INTEGER'}, header = true);
-- Pixels whose centre falls in the footprint; else the pixel under the centroid (the TCI's 10 m grid: centres at x5).
CREATE TABLE inside AS SELECT b.id, avg(px.r) r, avg(px.g) gg, avg(px.b) bb, count(*) n FROM b JOIN px ON ST_Contains(b.geom, px.p) GROUP BY b.id;
CREATE TABLE col AS
SELECT b.id, coalesce(i.r, c.r) r, coalesce(i.gg, c.g) g, coalesce(i.bb, c.b) bl, coalesce(i.n, 0) n
FROM b LEFT JOIN inside i USING (id)
LEFT JOIN px c ON c.x = floor(b.cx / 10) * 10 + 5 AND c.y = floor(b.cy / 10) * 10 + 5;
COPY col TO '/work/colours.parquet' (FORMAT parquet);
SELECT count(*) n, count(r) coloured, count(*) FILTER (n > 0) by_inside, round(avg(r)) r, round(avg(g)) g, round(avg(bl)) b FROM col;
SELECT round((r - bl) / (r + g + bl + 1), 2) AS redness, count(*) n, round(avg((r+g+bl)/3)) bright FROM col GROUP BY 1 ORDER BY 1;
SELECT round((r+g+bl)/3 / 20) * 20 AS bright, count(*) n FROM col GROUP BY 1 ORDER BY 1;
