-- Ancestry of every U.S. census tract, after the New York Times ancestry map of
-- July 2026, as the Parquet files the ancestry-esda dashboard reads through
-- the gateway (http://feeds/datasets/ancestry/...), with the spatial weights
-- it adds to them. Run by build.sh, which sets
-- `src` (the folder of downloaded Census files) and `year`, and runs this in
-- the folder the files are written to.
--
-- The NYT does not publish its derived dataset but names its source, the
-- American Community Survey. api.census.gov rejects keyless requests, so this
-- reads the table-based summary files off www2.census.gov instead.
--
-- A note on the data, repeated in the dashboard because it changes how the map
-- reads: ACS ancestry is a multiple-response, self-reported question, and not
-- the same universe as Hispanic origin or detailed race. Three tables are
-- stacked to reach the ~200 groups the NYT shows:
--   B04006 People Reporting Ancestry               -> source 'ancestry'
--   B03001 Hispanic or Latino Origin by Specific   -> source 'hispanic_origin'
--   B02015 Asian Alone by Selected Groups          -> source 'asian_group'
-- and per-tract totals are renormalised where they overlap.
--
-- Deterministic: the 1.35 million dots are scattered with hash(geoid, i), not
-- a random generator, and every output has a total ORDER BY.

INSTALL spatial;
LOAD spatial;
INSTALL h3 FROM community;
LOAD h3;

SET VARIABLE people_per_dot = 250;  -- set by the city view: Chicago ~38k dots, the country ~1.35M
SET VARIABLE dot_buckets = 4;       -- the dashboard keeps a share of buckets by zoom
SET VARIABLE simplify = 0.0015;     -- degrees, ~150 m: tract borders survive, the file halves
SET VARIABLE h3_res = 5;
SET VARIABLE esda_min_pop = 100;    -- smaller tracts are left out of the weights: a share of 30 people is noise
SET VARIABLE residual = 'Sin ascendencia reportada';
SET VARIABLE other = 'Otros grupos';
SET VARIABLE sf = getvariable('src') || '/acsdt5y' || getvariable('year') || '-';

-- The seven groups with a hue of their own on the map; everything else,
-- including the unreported remainder, is OTHER. Seven is the measured ceiling
-- for an all-pairs colour problem on a dark basemap; the dashboard's saved
-- colorRange carries the matching hues, so change both together.
CREATE MACRO color_group(g) AS
  CASE WHEN g IN ('German', 'Mexican', 'English', 'Irish', 'American', 'Italian', 'Puerto Rican')
       THEN g ELSE getvariable('other') END;

-- 1. Variable code -> label, leaves of each table's tree only: every parent
--    label ends in a colon, and summing parents with children double-counts.
--    Residual buckets are dropped (they fold into the unreported remainder),
--    and so is the Asian-alone copy of "Afghan", which B04006 already has.
CREATE TABLE groups AS
SELECT "Unique ID" AS varcode, "Table ID" AS tbl, Label AS ancestry,
       CASE "Table ID" WHEN 'B04006' THEN 'ancestry' WHEN 'B03001' THEN 'hispanic_origin'
                       ELSE 'asian_group' END AS source
FROM read_csv(getvariable('src') || '/ACS' || getvariable('year') || '5YR_Table_Shells.txt',
              delim = '|', header = true, quote = '', types = {'Line': 'VARCHAR', 'Indent': 'VARCHAR'})
WHERE "Table ID" IN ('B04006', 'B03001', 'B02015')
  AND "Unique ID" IS NOT NULL
  AND Label NOT LIKE '%:'
  AND "Unique ID" NOT IN ('B04006_108',   -- Other groups
                          'B04006_109',   -- Unclassified or not reported
                          'B03001_002',   -- Not Hispanic or Latino
                          'B02015_033',   -- Other Asian, specified
                          'B02015_034',   -- Other Asian, not specified
                          'B02015_035',   -- Two or more Asian
                          'B02015_029');  -- Afghan, already in B04006
SELECT count(*) AS groups FROM groups;

-- 2. (geoid, ancestry, source, estimate) for every tract, zeros dropped. Each
--    summary file holds every geography in one pipe-delimited table with a
--    column per variable (B04006_E002 is the API's B04006_002E); tracts are
--    the GEO_IDs that start 1400000US, followed by the 11-digit TIGER GEOID.
CREATE MACRO estimates(t) AS TABLE
  SELECT geoid, replace(col, '_E', '_') AS varcode, value
  FROM (SELECT substr(GEO_ID, 10) AS geoid, COLUMNS('_E\d+$')
        FROM read_csv(getvariable('sf') || t || '.dat', delim = '|', header = true, quote = '',
                      all_varchar = true)
        WHERE starts_with(GEO_ID, '1400000US'))
  UNPIVOT (value FOR col IN (COLUMNS('_E\d+$')));

CREATE TABLE tract_ancestry AS
SELECT e.geoid, g.ancestry, g.source, e.value::BIGINT AS estimate
FROM (SELECT * FROM estimates('b04006') UNION ALL SELECT * FROM estimates('b03001')
      UNION ALL SELECT * FROM estimates('b02015')) e
JOIN groups g USING (varcode)
WHERE e.value::BIGINT > 0;

-- Population is the ancestry table's own total line: the whole resident
-- population, not an ancestry-specific universe.
CREATE TABLE tract_pop AS
SELECT substr(GEO_ID, 10) AS geoid, "B04006_E001"::BIGINT AS total_pop
FROM read_csv(getvariable('sf') || 'b04006.dat', delim = '|', header = true, quote = '', all_varchar = true)
WHERE starts_with(GEO_ID, '1400000US');

SELECT (SELECT count(*) FROM tract_pop) AS tracts, (SELECT count(*) FROM tract_ancestry) AS group_rows,
       (SELECT sum(total_pop) FROM tract_pop) AS people;

-- 3. Simplified tract polygons with bounding boxes and an interior point. The
--    cartographic boundary file carries state and county names; it has no
--    interior point, hence ST_PointOnSurface (a centroid can fall outside a
--    crescent tract, and the dot fallback needs a point inside). Coordinates
--    are NAD83, about a metre from WGS84: not reprojected. The bbox columns let
--    the dashboard filter by viewport with row-group statistics.
CREATE TABLE tract_geom AS
SELECT GEOID AS geoid, NAMELSAD AS name, NAMELSADCO AS county, STATE_NAME AS state, STUSPS AS state_abbr,
       ST_SimplifyPreserveTopology(geom, getvariable('simplify')) AS geometry,
       ST_Y(ST_PointOnSurface(geom)) AS latitude, ST_X(ST_PointOnSurface(geom)) AS longitude,
       ST_XMin(geom) AS minx, ST_YMin(geom) AS miny, ST_XMax(geom) AS maxx, ST_YMax(geom) AS maxy,
       -- polygon area over bbox area: how hard rejection sampling has to work
       CASE WHEN (ST_XMax(geom) - ST_XMin(geom)) * (ST_YMax(geom) - ST_YMin(geom)) > 0
            THEN least(1.0, greatest(0.02, ST_Area(geom)
                 / ((ST_XMax(geom) - ST_XMin(geom)) * (ST_YMax(geom) - ST_YMin(geom)))))
            ELSE 1.0 END AS fill_ratio
FROM ST_Read('/vsizip/' || getvariable('src') || '/cb_' || getvariable('year') || '_us_tract_500k.zip');

-- 4. One row per tract: population, interior point, the three leading groups.
CREATE TABLE tracts AS
WITH ranked AS (
  SELECT geoid, ancestry, estimate,
         row_number() OVER (PARTITION BY geoid ORDER BY estimate DESC, ancestry) AS rnk
  FROM tract_ancestry
), wide AS (
  SELECT g.geoid, g.name, g.county, g.state, g.state_abbr, p.total_pop, g.latitude, g.longitude,
         max(CASE WHEN r.rnk = 1 THEN r.ancestry END) AS top1_ancestry,
         max(CASE WHEN r.rnk = 1 THEN r.estimate END) AS top1_people,
         max(CASE WHEN r.rnk = 2 THEN r.ancestry END) AS top2_ancestry,
         max(CASE WHEN r.rnk = 2 THEN r.estimate END) AS top2_people,
         max(CASE WHEN r.rnk = 3 THEN r.ancestry END) AS top3_ancestry,
         max(CASE WHEN r.rnk = 3 THEN r.estimate END) AS top3_people
  FROM tract_geom g
  JOIN tract_pop p USING (geoid)
  LEFT JOIN ranked r ON r.geoid = g.geoid AND r.rnk <= 3
  GROUP BY ALL
)
SELECT *,
       CASE WHEN total_pop > 0 THEN top1_people::DOUBLE / total_pop END AS top1_pct,
       CASE WHEN total_pop > 0 THEN top2_people::DOUBLE / total_pop END AS top2_pct,
       CASE WHEN total_pop > 0 THEN top3_people::DOUBLE / total_pop END AS top3_pct
FROM wide;

-- 5. One dot per 250 residents, scattered inside its tract: colour by ancestry
--    and neighbouring groups read as a blend. Placement is rejection sampling
--    against the real polygon (dots respect a coastline); the group of each dot
--    is a contiguous split of the tract's dot range, so proportions are exact.
CREATE TABLE tract_dots_plan AS
SELECT g.geoid, g.minx, g.miny, g.maxx, g.maxy, g.fill_ratio, g.latitude, g.longitude, g.state_abbr,
       greatest(1, round(p.total_pop / getvariable('people_per_dot')::DOUBLE)::INT) AS n_dots
FROM tract_geom g JOIN tract_pop p USING (geoid)
WHERE p.total_pop > 0;

-- Oversampled by the inverse fill ratio so enough candidates land inside;
-- capped at 40x so a few pathological tracts do not dominate the run.
CREATE TABLE dot_candidates AS
SELECT p.geoid, p.state_abbr,
       p.minx + (hash(p.geoid || 'x' || s.i) % 1000000) / 1000000.0 * (p.maxx - p.minx) AS longitude,
       p.miny + (hash(p.geoid || 'y' || s.i) % 1000000) / 1000000.0 * (p.maxy - p.miny) AS latitude,
       s.i
FROM tract_dots_plan p,
     generate_series(1, least(40 * p.n_dots, ceil(p.n_dots / p.fill_ratio * 1.6)::BIGINT) + 8) AS s(i);

CREATE TABLE dot_positions AS
SELECT geoid, state_abbr, longitude, latitude,
       row_number() OVER (PARTITION BY geoid ORDER BY i) AS rn
FROM (SELECT c.* FROM dot_candidates c JOIN tract_geom g USING (geoid)
      WHERE ST_Contains(g.geometry, ST_Point(c.longitude, c.latitude)));
DROP TABLE dot_candidates;

-- Tracts whose polygon every candidate missed (slivers, tiny islands) still
-- get their dots, at the interior point.
INSERT INTO dot_positions
SELECT geoid, state_abbr, longitude, latitude, placed + s.i
FROM (SELECT p.geoid, p.state_abbr, p.longitude, p.latitude,
             coalesce(d.placed, 0) AS placed, p.n_dots - coalesce(d.placed, 0) AS missing
      FROM tract_dots_plan p
      LEFT JOIN (SELECT geoid, count(*) AS placed FROM dot_positions GROUP BY geoid) d USING (geoid)
      WHERE p.n_dots > coalesce(d.placed, 0)),
     generate_series(1, missing) AS s(i);

-- Group shares per tract, with the unreported remainder explicit so the dots
-- add up to the population rather than to the sum of the groups.
CREATE TABLE tract_shares AS
WITH summed AS (
  SELECT geoid, sum(estimate) AS grouped FROM tract_ancestry GROUP BY geoid
), base AS (
  SELECT p.geoid, p.total_pop, coalesce(s.grouped, 0) AS grouped,
         greatest(p.total_pop, coalesce(s.grouped, 0)) AS denom
  FROM tract_pop p LEFT JOIN summed s USING (geoid)
  WHERE p.total_pop > 0
)
SELECT a.geoid, a.ancestry, a.estimate::DOUBLE / b.denom AS share
FROM tract_ancestry a JOIN base b USING (geoid)
UNION ALL
SELECT geoid, getvariable('residual'), (denom - grouped)::DOUBLE / denom
FROM base WHERE denom > grouped;

-- The upper bound of each group's range is rounded once and the lower bound
-- is the previous group's upper bound: no dot in two ranges, none in none.
CREATE TABLE dot_alloc AS
SELECT geoid, ancestry, coalesce(lag(hi) OVER (PARTITION BY geoid ORDER BY ord), 0) AS lo, hi
FROM (
  SELECT s.geoid, s.ancestry, row_number() OVER w AS ord,
         least(round(p.n_dots * (sum(s.share) OVER w)), p.n_dots) AS hi
  FROM tract_shares s JOIN tract_dots_plan p USING (geoid)
  WINDOW w AS (PARTITION BY s.geoid ORDER BY s.share DESC, s.ancestry
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
);

CREATE TABLE dots AS
SELECT d.latitude, d.longitude, a.ancestry, color_group(a.ancestry) AS color_group,
       ((d.rn - 1) % getvariable('dot_buckets'))::TINYINT AS bucket,
       d.geoid, d.state_abbr AS state
FROM dot_positions d
JOIN dot_alloc a ON a.geoid = d.geoid AND d.rn > a.lo AND d.rn <= a.hi;
SELECT count(*) AS dots FROM dots;

-- 6. The dots in H3 cells for the hexagon layer, so the dashboard needs no
--    community extension.
CREATE TABLE h3_cells AS
WITH per_group AS (
  SELECT h3, ancestry, count(*) * getvariable('people_per_dot') AS people,
         row_number() OVER (PARTITION BY h3 ORDER BY count(*) DESC, ancestry) AS rnk
  FROM (SELECT h3_latlng_to_cell_string(latitude, longitude, getvariable('h3_res')) AS h3, ancestry FROM dots)
  GROUP BY h3, ancestry
)
SELECT h3, sum(people)::BIGINT AS count,
       max(CASE WHEN rnk = 1 THEN ancestry END) AS dominant_ancestry,
       max(CASE WHEN rnk = 1 THEN people END)::BIGINT AS dominant_people
FROM per_group GROUP BY h3;

-- 7. Spatial weights for ancestry-esda: who neighbours whom, two ways, within
--    each state (the dashboard analyses one state at a time), among the tracts
--    of at least esda_min_pop residents. From the cartographic boundary
--    polygons as published, not the simplified ones: those are simplified one
--    by one, so neighbours stop touching. Both lists are directed (i, j) pairs.
--    queen: the polygons share a border or a corner. Symmetric; a tract with no
--           neighbour (an island) appears in neither column.
--    knn6:  the six nearest interior points, by great-circle distance. Every
--           tract has six; j being one of i's six does not make i one of j's.
--    The bounding-box test lets the join skip ST_Intersects on pairs far
--    apart: without it, every pair in a state, minutes instead of seconds.
CREATE TABLE esda_tracts AS
SELECT s.GEOID AS geoid, s.STUSPS AS state_abbr, s.geom,
       ST_XMin(s.geom) AS minx, ST_XMax(s.geom) AS maxx, ST_YMin(s.geom) AS miny, ST_YMax(s.geom) AS maxy,
       g.latitude, g.longitude
FROM ST_Read('/vsizip/' || getvariable('src') || '/cb_' || getvariable('year') || '_us_tract_500k.zip') s
JOIN tract_pop p ON p.geoid = s.GEOID
JOIN tract_geom g ON g.geoid = s.GEOID
WHERE p.total_pop >= getvariable('esda_min_pop');

CREATE TABLE weights AS
SELECT 'queen' AS kind, a.state_abbr AS state, a.geoid AS i, b.geoid AS j
FROM esda_tracts a JOIN esda_tracts b
  ON a.state_abbr = b.state_abbr AND a.geoid <> b.geoid
 AND a.minx <= b.maxx AND b.minx <= a.maxx AND a.miny <= b.maxy AND b.miny <= a.maxy
WHERE ST_Intersects(a.geom, b.geom)
UNION ALL
SELECT 'knn6', state, i, unnest(min_by(j, km, 6))
FROM (
  SELECT a.state_abbr AS state, a.geoid AS i, b.geoid AS j,
         2 * 6371.0088 * asin(sqrt(
           power(sin(radians(b.latitude - a.latitude) / 2), 2)
           + cos(radians(a.latitude)) * cos(radians(b.latitude))
             * power(sin(radians(b.longitude - a.longitude) / 2), 2))) AS km
  FROM esda_tracts a JOIN esda_tracts b ON a.state_abbr = b.state_abbr AND a.geoid <> b.geoid
)
GROUP BY state, i;
SELECT kind, count(*) AS links, count(DISTINCT i) AS tracts,
       (SELECT count(*) FROM esda_tracts) AS of_tracts
FROM weights GROUP BY kind ORDER BY kind;

-- 8. The files, sorted by H3 cell for spatial locality in the row groups.
COPY (
  SELECT geoid, name, county, state, state_abbr, total_pop, latitude, longitude,
         top1_ancestry, color_group(top1_ancestry) AS top1_color_group, top1_people, top1_pct,
         top2_ancestry, top2_people, top2_pct, top3_ancestry, top3_people, top3_pct
  FROM tracts ORDER BY h3_latlng_to_cell_string(latitude, longitude, 3), geoid
) TO 'tracts.parquet' (FORMAT parquet, COMPRESSION zstd);

COPY (
  SELECT g.geoid, g.geometry, g.minx, g.miny, g.maxx, g.maxy
  FROM tract_geom g JOIN tract_pop p USING (geoid)
  ORDER BY h3_latlng_to_cell_string(g.latitude, g.longitude, 3), g.geoid
) TO 'tracts-geom.parquet' (FORMAT parquet, COMPRESSION zstd);

COPY (
  SELECT a.geoid, a.ancestry, a.source, a.estimate,
         CASE WHEN p.total_pop > 0 THEN a.estimate::DOUBLE / p.total_pop END AS pct
  FROM tract_ancestry a JOIN tract_pop p USING (geoid)
  ORDER BY a.ancestry, a.geoid
) TO 'tract-ancestry.parquet' (FORMAT parquet, COMPRESSION zstd);

COPY (
  SELECT latitude, longitude, ancestry, color_group, bucket, geoid, state FROM dots
  ORDER BY h3_latlng_to_cell_string(latitude, longitude, 3), geoid, latitude, longitude, ancestry, bucket
) TO 'dots.parquet' (FORMAT parquet, COMPRESSION zstd);

COPY (
  SELECT h3, count, dominant_ancestry, color_group(dominant_ancestry) AS dominant_color_group, dominant_people
  FROM h3_cells ORDER BY h3
) TO 'h3.parquet' (FORMAT parquet, COMPRESSION zstd);

COPY (
  SELECT ancestry, any_value(source) AS source, sum(estimate)::BIGINT AS national_total,
         count(DISTINCT geoid) AS tracts_present
  FROM tract_ancestry GROUP BY ancestry ORDER BY national_total DESC, ancestry
) TO 'ancestries.parquet' (FORMAT parquet, COMPRESSION zstd);

-- By kind and state, so the dashboard's one state is a few row groups.
COPY (
  SELECT kind, state, i, j FROM weights ORDER BY kind, state, i, j
) TO 'weights.parquet' (FORMAT parquet, COMPRESSION zstd);
