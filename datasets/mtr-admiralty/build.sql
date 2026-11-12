-- The files of the mtr-admiralty dashboard, from the Lands Department's 3D
-- Indoor Map of Admiralty station (downloaded by build.sh into @IN@) and the
-- other MTR stations' outlines (to know which end of each platform a train
-- comes from). Written to @OUT@. Distances are worked in the Hong Kong 1980
-- Grid (EPSG:2326, metres); every geometry is written as 2D GeoJSON in WGS84,
-- its floor given by the level column (Kepler Plus Floors lifts it).
LOAD spatial;

CREATE MACRO to_grid(g) AS ST_Transform(g, 'EPSG:4326', 'EPSG:2326', always_xy := true);
CREATE MACRO to_wgs(g) AS ST_Transform(g, 'EPSG:2326', 'EPSG:4326', always_xy := true);

-- Levels: one floor per ordinal. Ordinal 0 is six small levels, one per street
-- exit, at slightly different heights; they make one floor.
CREATE TABLE lv AS
SELECT level_ordinal AS level, level_short_name_en AS short, level_name_en AS name,
       level_z_value AS z, ST_Force2D(geom) AS g
FROM ST_Read('@IN@/level.json');

CREATE TABLE floors AS
WITH f AS (
  SELECT level,
         CASE WHEN count(*) > 1 THEN 'G Street exits'
              ELSE any_value(short) || ' ' ||
                   regexp_replace(regexp_replace(any_value(name), '^Platform Level \((.*)\)$', 'Platforms, \1'),
                                  ' Level$', '')
         END AS floor_name,
         round(avg(z), 2) AS z_mpd,
         ST_Union_Agg(g) AS g
  FROM lv GROUP BY level
)
SELECT level, floor_name, z_mpd,
       round(lead(z_mpd) OVER (ORDER BY level) - z_mpd, 2) AS height_to_next_m, g
FROM f;

-- Units: platforms, tracks, escalators, stairs, lifts, concourses, toilets and
-- shops. A unit an occupant (a shop, a bank) stands in takes its name.
CREATE TABLE occ AS
SELECT occupant_name_en AS name, occupant_category AS category, unit_id, level_ordinal AS level,
       ST_X(geom) AS longitude, ST_Y(geom) AS latitude
FROM ST_Read('@IN@/occupant.json');

CREATE TABLE units AS
SELECT u.unit_id AS unit, u.level_ordinal AS level, f.floor_name,
       CASE WHEN u.unit_name_en = 'railway track' THEN 'Track'
            WHEN u.unit_category = 'platform' THEN 'Platform'
            WHEN u.unit_category IN ('escalator', 'movingwalkway') THEN 'Escalator'
            WHEN u.unit_category IN ('stairs', 'steps', 'ramp') THEN 'Stairs'
            WHEN u.unit_category = 'elevator' OR u.unit_name_en = 'Stairlift' THEN 'Lift'
            WHEN u.unit_category IN ('walkway', 'lobby') THEN 'Concourse'
            WHEN u.unit_category LIKE 'restroom%' OR u.unit_category = 'mothersroom' THEN 'Toilets'
            WHEN o.name IS NOT NULL THEN 'Shop'
            ELSE 'Station room'
       END AS kind,
       coalesce(o.name, CASE WHEN u.unit_name_en = 'railway track' THEN 'Railway track' ELSE u.unit_name_en END) AS name,
       round(ST_Area(to_grid(ST_Force2D(u.geom))), 0) AS area_m2,
       ST_Force2D(u.geom) AS g
FROM ST_Read('@IN@/unit.json') u
LEFT JOIN (SELECT unit_id, string_agg(name, ', ') AS name FROM occ GROUP BY unit_id) o USING (unit_id)
JOIN floors f ON f.level = u.level_ordinal;

-- Points: the exits, the platforms, gates, help, toilets, defibrillators and
-- the shops by name.
CREATE TABLE points AS
SELECT a.level_ordinal AS level, f.floor_name,
       CASE a.amenity_category
            WHEN 'entry' THEN 'Exit' WHEN 'platform' THEN 'Platform' WHEN 'faregate' THEN 'Gate'
            WHEN 'information' THEN 'Customer service' WHEN 'defibrillator' THEN 'Defibrillator'
            WHEN 'restroom.female' THEN 'Toilets' WHEN 'restroom.male' THEN 'Toilets'
            WHEN 'restroom.unisex' THEN 'Toilets' WHEN 'mothersroom' THEN 'Baby care'
       END AS kind,
       a.amenity_name_en AS name,
       CASE WHEN a.amenity_category = 'entry' THEN replace(a.amenity_name_en, 'Exit ', '')
            WHEN a.amenity_category = 'platform' THEN regexp_extract(a.amenity_name_en, '^Platform (\d+)', 1)
       END AS label,
       ST_Y(a.geom) AS latitude, ST_X(a.geom) AS longitude
FROM ST_Read('@IN@/amenity.json') a
JOIN floors f ON f.level = a.level_ordinal
WHERE a.amenity_category IN ('entry', 'faregate', 'information', 'defibrillator', 'restroom.female',
                             'restroom.male', 'restroom.unisex', 'mothersroom')
   OR (a.amenity_category = 'platform' AND regexp_matches(a.amenity_name_en, '^Platform \d'))
UNION ALL
SELECT o.level, f.floor_name, 'Shop', o.name, NULL, o.latitude, o.longitude
FROM occ o JOIN floors f USING (level);

-- The platforms. Which line stops at each, where its trains come from and go
-- to (the neighbouring stations, by their outlines), and its trains' length:
-- the Island and Tsuen Wan lines run 8 cars, the East Rail line 9, the South
-- Island line 3 (lengths approximate). Admiralty ends the East Rail and South
-- Island lines: their trains come in and go back out the same end.
CREATE TABLE plat_cfg AS
SELECT * FROM (VALUES
  (1, 'TWL', 'Tsuen Wan Line',    '#E2231A', 'Tsuen Wan',           'Central Station',          'Tsim Sha Tsui Station',     8, 22.5),
  (2, 'ISL', 'Island Line',       '#007DC5', 'Kennedy Town',        'Wan Chai Station',         'Central Station',           8, 22.5),
  (3, 'ISL', 'Island Line',       '#007DC5', 'Chai Wan',            'Central Station',          'Wan Chai Station',          8, 22.5),
  (4, 'TWL', 'Tsuen Wan Line',    '#E2231A', 'Central',             'Tsim Sha Tsui Station',    'Central Station',           8, 22.5),
  (5, 'SIL', 'South Island Line', '#B5BD00', 'South Horizons',      'Ocean Park Station',       'Ocean Park Station',        3, 22.5),
  (6, 'SIL', 'South Island Line', '#B5BD00', 'South Horizons',      'Ocean Park Station',       'Ocean Park Station',        3, 22.5),
  (7, 'EAL', 'East Rail Line',    '#5EB7E8', 'Lo Wu / Lok Ma Chau', 'Exhibition Centre Station', 'Exhibition Centre Station', 9, 24.4),
  (8, 'EAL', 'East Rail Line',    '#5EB7E8', 'Arrivals',            'Exhibition Centre Station', 'Exhibition Centre Station', 9, 24.4)
) t(plat, line, line_name, colour, toward, from_station, to_station, cars, car_m);

CREATE TABLE stations AS
SELECT venue_name_en AS station, to_grid(ST_Centroid(ST_Force2D(geom))) AS c
FROM ST_Read('@IN@/mtr_venues.json');

-- Each platform level has one island platform: its long axis, from its
-- minimum rotated rectangle, is the direction trains run along it.
CREATE TABLE island AS
WITH p AS (
  SELECT level, to_grid(g) AS pg, ST_MinimumRotatedRectangle(to_grid(g)) AS r
  FROM units WHERE kind = 'Platform'
), e AS (
  SELECT level, pg,
         ST_X(ST_PointN(ST_ExteriorRing(r), 2)) - ST_X(ST_PointN(ST_ExteriorRing(r), 1)) AS ax,
         ST_Y(ST_PointN(ST_ExteriorRing(r), 2)) - ST_Y(ST_PointN(ST_ExteriorRing(r), 1)) AS ay,
         ST_X(ST_PointN(ST_ExteriorRing(r), 3)) - ST_X(ST_PointN(ST_ExteriorRing(r), 2)) AS qx,
         ST_Y(ST_PointN(ST_ExteriorRing(r), 3)) - ST_Y(ST_PointN(ST_ExteriorRing(r), 2)) AS qy
  FROM p
)
SELECT level, pg, ST_X(ST_Centroid(pg)) AS cx, ST_Y(ST_Centroid(pg)) AS cy,
       CASE WHEN ax * ax + ay * ay >= qx * qx + qy * qy THEN ax / sqrt(ax * ax + ay * ay) ELSE qx / sqrt(qx * qx + qy * qy) END AS ux,
       CASE WHEN ax * ax + ay * ay >= qx * qx + qy * qy THEN ay / sqrt(ax * ax + ay * ay) ELSE qy / sqrt(qx * qx + qy * qy) END AS uy
FROM e;

-- Per platform: the travel direction (U, pointing from the station trains come
-- from towards the one they go to; at a terminus, away from the line, into the
-- station), the side of the island it is on (from its marker), and x, the
-- distance along U from the island's centre.
CREATE TABLE plat AS
WITH m AS (
  SELECT label::INTEGER AS plat, level, floor_name, latitude, longitude,
         to_grid(ST_Point(longitude, latitude)) AS pt
  FROM points WHERE kind = 'Platform'
), d AS (
  SELECT c.*, m.level, m.floor_name, m.latitude, m.longitude, m.pt, i.pg, i.cx, i.cy, i.ux, i.uy,
         CASE WHEN c.from_station = c.to_station THEN i.cx - ST_X(s1.c) ELSE ST_X(s2.c) - ST_X(s1.c) END AS dx,
         CASE WHEN c.from_station = c.to_station THEN i.cy - ST_Y(s1.c) ELSE ST_Y(s2.c) - ST_Y(s1.c) END AS dy
  FROM plat_cfg c
  JOIN m USING (plat)
  JOIN island i ON i.level = m.level
  JOIN stations s1 ON s1.station = c.from_station
  JOIN stations s2 ON s2.station = c.to_station
), o AS (
  SELECT *, CASE WHEN ux * dx + uy * dy >= 0 THEN 1 ELSE -1 END AS sgn FROM d
)
SELECT plat, line, line_name, colour, toward, from_station, to_station, cars, car_m,
       level, floor_name, latitude, longitude, pg, cx, cy,
       sgn * ux AS tx, sgn * uy AS ty,
       -- left of travel is (-ty, tx); the platform's side of the island
       CASE WHEN (-(sgn * uy)) * (ST_X(pt) - cx) + (sgn * ux) * (ST_Y(pt) - cy) >= 0 THEN 1 ELSE -1 END AS side
FROM o;

-- The track beside each platform: the level's tracks on the platform's side of
-- the island's axis, narrowed by 0.7 m each side to a train's width.
CREATE TABLE lane AS
WITH t AS (
  SELECT level, ST_Union_Agg(to_grid(g)) AS tg FROM units WHERE kind = 'Track' GROUP BY level
), h AS (
  SELECT p.*, t.tg,
         -- the half plane on the platform's side: 2 km along, 2 km across
         ST_MakePolygon(ST_MakeLine([
           ST_Point(cx - 2000 * tx, cy - 2000 * ty),
           ST_Point(cx + 2000 * tx, cy + 2000 * ty),
           ST_Point(cx + 2000 * tx + side * 2000 * (-ty), cy + 2000 * ty + side * 2000 * tx),
           ST_Point(cx - 2000 * tx + side * 2000 * (-ty), cy - 2000 * ty + side * 2000 * tx),
           ST_Point(cx - 2000 * tx, cy - 2000 * ty)])) AS half
  FROM plat p JOIN t USING (level)
)
SELECT plat, cx, cy, tx, ty, ST_Buffer(ST_Intersection(tg, half), -0.7) AS lg FROM h;

-- Along x: the platform's ends and the track's, where a train stops (its front
-- 3 m short of the platform's far end) and how long it is (no longer than the
-- platform, less 6 m).
CREATE TABLE extents AS
WITH pp AS (
  SELECT p.plat, (ST_X(q.geom) - p.cx) * p.tx + (ST_Y(q.geom) - p.cy) * p.ty AS x
  FROM plat p, unnest(ST_Dump(ST_Points(p.pg))) AS d(q)
), lp AS (
  SELECT l.plat, (ST_X(q.geom) - l.cx) * l.tx + (ST_Y(q.geom) - l.cy) * l.ty AS x
  FROM lane l, unnest(ST_Dump(ST_Points(l.lg))) AS d(q)
)
SELECT plat, pmin, pmax, tmin, tmax
FROM (SELECT plat, min(x) AS pmin, max(x) AS pmax FROM pp GROUP BY plat)
JOIN (SELECT plat, min(x) AS tmin, max(x) AS tmax FROM lp GROUP BY plat) USING (plat);

CREATE TABLE platforms AS
SELECT p.plat, 'Platform ' || p.plat AS platform, p.line, p.line_name, p.colour, p.toward,
       p.from_station, p.to_station, p.level, p.floor_name, p.latitude, p.longitude,
       round(e.pmax - e.pmin, 1) AS platform_m,
       round(e.pmax - 3, 1) AS x_stop,
       round(least(p.cars * p.car_m, e.pmax - e.pmin - 6), 1) AS train_m,
       round(least(p.cars * p.car_m, e.pmax - e.pmin - 6) / p.cars, 2) AS car_m,
       p.cars,
       round(e.tmin, 1) AS x_track_start, round(e.tmax, 1) AS x_track_end,
       p.from_station = p.to_station AS terminus
FROM plat p JOIN extents e USING (plat);

-- The track beside each platform cut across every metre along x: a train is
-- the slices between its tail and its front.
CREATE TABLE slices AS
WITH s AS (
  SELECT l.plat, l.lg, l.cx, l.cy, l.tx, l.ty, x
  FROM lane l JOIN extents e USING (plat), range(floor(e.tmin)::INTEGER, ceil(e.tmax)::INTEGER) r(x)
), c AS (
  SELECT plat, x,
         ST_Intersection(lg, ST_MakePolygon(ST_MakeLine([
           ST_Point(cx + x * tx - 60 * ty, cy + x * ty + 60 * tx),
           ST_Point(cx + (x + 1) * tx - 60 * ty, cy + (x + 1) * ty + 60 * tx),
           ST_Point(cx + (x + 1) * tx + 60 * ty, cy + (x + 1) * ty - 60 * tx),
           ST_Point(cx + x * tx + 60 * ty, cy + x * ty - 60 * tx),
           ST_Point(cx + x * tx - 60 * ty, cy + x * ty + 60 * tx)]))) AS g
  FROM s
)
SELECT c.plat, c.x, p.level, p.floor_name, to_wgs(c.g) AS g
FROM c JOIN plat p USING (plat)
WHERE NOT ST_IsEmpty(c.g) AND ST_Area(c.g) > 0.2;

-- Walls: each floor's outline, 0.3 m thick and 1.4 m high (low enough to see over).
CREATE TABLE walls AS
SELECT level, floor_name, 1.4 AS height_m,
       to_wgs(ST_Buffer(ST_Boundary(to_grid(g)), 0.15)) AS g
FROM floors;

COPY (SELECT level, floor_name, z_mpd, height_to_next_m, ST_AsGeoJSON(g)::VARCHAR AS geometry FROM floors ORDER BY level)
  TO '@OUT@/floors.parquet' (FORMAT parquet, COMPRESSION zstd);
COPY (SELECT unit, level, floor_name, kind, name, area_m2, ST_AsGeoJSON(g)::VARCHAR AS geometry FROM units ORDER BY level, kind, name)
  TO '@OUT@/units.parquet' (FORMAT parquet, COMPRESSION zstd);
COPY (SELECT level, floor_name, kind, name, label, latitude, longitude FROM points ORDER BY level, kind, name)
  TO '@OUT@/points.parquet' (FORMAT parquet, COMPRESSION zstd);
COPY (SELECT * FROM platforms ORDER BY plat)
  TO '@OUT@/platforms.parquet' (FORMAT parquet, COMPRESSION zstd);
COPY (SELECT plat, x, level, floor_name, ST_AsGeoJSON(g)::VARCHAR AS geometry FROM slices ORDER BY plat, x)
  TO '@OUT@/slices.parquet' (FORMAT parquet, COMPRESSION zstd);
COPY (SELECT level, floor_name, height_m, ST_AsGeoJSON(g)::VARCHAR AS geometry FROM walls ORDER BY level)
  TO '@OUT@/walls.parquet' (FORMAT parquet, COMPRESSION zstd);
