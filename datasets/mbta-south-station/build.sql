-- The files of the mbta-south-station dashboard, from MBTA's GTFS (South Station's levels,
-- the nodes and pathways inside it, its elevators and escalators) and OpenStreetMap (the
-- platforms, the tracks, the indoor areas), both downloaded by build.sh into @IN@. Written to
-- @OUT@. Distances are worked in metres in NAD83 Massachusetts Mainland (EPSG:26986); every
-- geometry is written as 2D GeoJSON in WGS84, its floor given by the level column (Kepler Plus
-- Floors lifts it).
LOAD spatial;

CREATE MACRO to_m(g) AS ST_Transform(g, 'EPSG:4326', 'EPSG:26986', always_xy := true);
CREATE MACRO to_wgs(g) AS ST_Transform(g, 'EPSG:26986', 'EPSG:4326', always_xy := true);

-- GTFS: the station's levels, nodes, pathways and facilities.
CREATE TABLE stops AS FROM read_csv('@IN@/stops.txt', all_varchar = true);
CREATE TABLE levels AS FROM read_csv('@IN@/levels.txt', all_varchar = true);
CREATE TABLE pathways AS FROM read_csv('@IN@/pathways.txt', all_varchar = true);
CREATE TABLE facilities AS FROM read_csv('@IN@/facilities.txt', all_varchar = true);

CREATE TABLE nodes AS
SELECT s.stop_id, s.stop_name, s.platform_name, s.location_type,
       l.level_index::DOUBLE::INTEGER AS level, s.stop_lat::DOUBLE AS lat, s.stop_lon::DOUBLE AS lon
FROM stops s JOIN levels l USING (level_id)
WHERE s.parent_station = 'place-sstat';

-- The station's floors, by level index: the street, the Commuter Rail platforms and the
-- ground of the headhouse are one floor (0).
CREATE TABLE floor_names AS
SELECT * FROM (VALUES
  (-3, 'Red Line platforms'), (-2, 'Silver Line platforms'), (-1, 'Red Line and Silver Line lobby'),
  (0, 'Street and Commuter Rail tracks'), (1, 'Mezzanine'), (2, 'Bus Terminal')
) t(level, floor_name);

-- OpenStreetMap: ways from their nodes.
CREATE TABLE el AS
SELECT unnest(json_extract(elements, '$[*]')) AS e
FROM read_json('@IN@/osm.json', columns = {elements: 'JSON'}, maximum_object_size = 500000000);
CREATE TABLE osm_nodes AS
SELECT (e->>'id')::BIGINT AS id, (e->>'lon')::DOUBLE AS lon, (e->>'lat')::DOUBLE AS lat
FROM el WHERE (e->>'type') = 'node';
CREATE TABLE way_nodes AS
SELECT id, tags, unnest(ns) AS node, generate_subscripts(ns, 1) AS i
FROM (SELECT (e->>'id')::BIGINT AS id, e->'tags' AS tags, (e->'nodes')::BIGINT[] AS ns
      FROM el WHERE (e->>'type') = 'way');
CREATE TABLE ways AS
SELECT w.id, any_value(w.tags) AS tags,
       ST_MakeLine(list(ST_Point(n.lon, n.lat) ORDER BY w.i)) AS line,
       arg_min(w.node, w.i) = arg_max(w.node, w.i) AND count(*) > 3 AS closed
FROM way_nodes w JOIN osm_nodes n ON n.id = w.node
GROUP BY w.id;

-- Areas on a floor: the Commuter Rail platforms (on the street floor), the Red Line
-- platforms, the concourse, rooms, corridors and the Silver Line busway, by their level.
CREATE TABLE areas AS
WITH a AS (
  SELECT id,
         CASE WHEN (tags->>'railway') = 'platform' OR (tags->>'public_transport') = 'platform' THEN 'Platform'
              WHEN (tags->>'name') = 'Silver Line Busway' THEN 'Busway'
              WHEN (tags->>'indoor') IN ('area', 'corridor', 'level') THEN 'Concourse'
              WHEN (tags->>'indoor') = 'room' THEN 'Room'
         END AS kind,
         coalesce(tags->>'name', '') AS name, (tags->>'ref') AS ref,
         CASE WHEN regexp_matches(coalesce(tags->>'level', ''), '^-?\d+$') THEN (tags->>'level')::INTEGER
              WHEN (tags->>'railway') = 'platform' AND (tags->>'level') IS NULL THEN 0
         END AS level,
         CASE WHEN closed THEN ST_MakePolygon(line) ELSE to_wgs(ST_Buffer(to_m(line), 4)) END AS g
  FROM ways
  WHERE ((tags->>'indoor') IN ('area', 'corridor', 'level', 'room') OR (tags->>'railway') = 'platform'
         OR (tags->>'public_transport') = 'platform')
)
SELECT a.id, a.kind, a.name, a.ref, a.level, f.floor_name, a.g
FROM a JOIN floor_names f USING (level)
WHERE a.kind IS NOT NULL AND ST_IsValid(a.g);

-- The tracks: Commuter Rail tracks 1 to 13 (their ways merged per track), from the bumpers
-- under the headhouse to 450 m south; the Red Line's two tracks, 230 m either way of its
-- platforms. Each oriented so x grows towards the bumpers (Commuter Rail) or north (Red Line),
-- each with the GTFS stop its trains stop at: a Commuter Rail track's own (NEC-2287-NN), a Red
-- Line track's nearest platform (70080 Alewife, northbound; 70079 Ashmont/Braintree).
CREATE TABLE station_c AS
SELECT to_m(ST_Centroid(ST_Union_Agg(g))) AS c FROM areas WHERE kind = 'Platform' AND level = 0;
CREATE TABLE red_c AS
SELECT to_m(ST_Centroid(ST_Union_Agg(g))) AS c FROM areas WHERE kind = 'Platform' AND level = -3;
CREATE TABLE tracks AS
WITH t AS (
  SELECT 'CR-' || lpad(tags->>'railway:track_ref', 2, '0') AS track, 0 AS level, 'Commuter Rail' AS mode,
         to_m(line) AS l
  FROM ways WHERE (tags->>'railway') = 'rail' AND regexp_matches(coalesce(tags->>'railway:track_ref', ''), '^(1[0-3]|[1-9])$')
  UNION ALL
  SELECT 'RL-' || (tags->>'railway:track_ref'), -3, 'Red Line', to_m(line)
  FROM ways WHERE (tags->>'railway') = 'subway' AND (tags->>'name') = 'Red Line'
    AND (tags->>'railway:track_ref') IN ('1', '2')
), merged AS (
  SELECT track, any_value(level) AS level, any_value(mode) AS mode, ST_LineMerge(ST_Union_Agg(l)) AS l
  FROM t GROUP BY track
), pieces AS (
  -- the longest piece, should a track's ways not join up
  SELECT track, level, mode, arg_max(d.geom, ST_Length(d.geom)) AS l
  FROM merged, unnest(ST_Dump(l)) AS u(d) GROUP BY track, level, mode
), clipped AS (
  SELECT p.track, p.level, p.mode,
         ST_Intersection(p.l, ST_Buffer(CASE WHEN p.mode = 'Red Line' THEN r.c ELSE s.c END,
                                        CASE WHEN p.mode = 'Red Line' THEN 230 ELSE 330 END)) AS l
  FROM pieces p, station_c s, red_c r
), longest AS (
  SELECT track, level, mode, arg_max(d.geom, ST_Length(d.geom)) AS l
  FROM clipped, unnest(ST_Dump(l)) AS u(d) GROUP BY track, level, mode
)
SELECT track, level, mode,
       CASE WHEN mode = 'Commuter Rail' THEN 'NEC-2287-' || right(track, 2)
            ELSE (SELECT arg_min(a.ref, ST_Distance(to_m(a.g), longest.l)) FROM areas a
                  WHERE a.kind = 'Platform' AND a.level = -3 AND a.ref IS NOT NULL) END AS stop,
       CASE WHEN ST_Y(ST_EndPoint(l)) >= ST_Y(ST_StartPoint(l)) THEN l ELSE ST_Reverse(l) END AS l
FROM longest WHERE ST_Length(l) > 50;

-- Each track cut every metre along it, 3 m wide: a train is drawn as the slices it covers.
-- x_m, y_m: the slice's middle in metres, where a vehicle is matched to its track.
CREATE TABLE slices AS
WITH s AS (
  SELECT t.track, t.level, t.mode, t.stop, t.l, ST_Length(t.l) AS len, x
  FROM tracks t, range(0, floor(ST_Length(t.l))::INTEGER) r(x)
), c AS (
  SELECT track, level, mode, stop, x,
         ST_LineSubstring(l, x / len, least(x + 1, len) / len) AS seg
  FROM s
)
SELECT track, level, mode, stop, x,
       round(ST_X(ST_Centroid(seg)), 2) AS x_m, round(ST_Y(ST_Centroid(seg)), 2) AS y_m,
       round(degrees(ST_Azimuth(ST_StartPoint(seg), ST_EndPoint(seg))), 1) AS azimuth,
       to_wgs(ST_Buffer(seg, 1.5, 2, 'CAP_FLAT', 'JOIN_MITRE', 2)) AS g
FROM c;

-- The pathways inside the station: on one floor (walkways, fare and exit gates) as lines;
-- between floors (stairs, escalators, elevators) as the facilities below.
CREATE TABLE walks AS
SELECT p.pathway_id AS pathway,
       CASE p.pathway_mode WHEN '1' THEN 'Walkway' WHEN '3' THEN 'Moving walkway' WHEN '6' THEN 'Fare gate'
                           WHEN '7' THEN 'Exit gate' WHEN '2' THEN 'Stairs' WHEN '4' THEN 'Escalator'
                           WHEN '5' THEN 'Elevator' END AS kind,
       a.level, f.floor_name, coalesce(p.pathway_name, '') AS name,
       ST_MakeLine(ST_Point(a.lon, a.lat), ST_Point(b.lon, b.lat)) AS g
FROM pathways p
JOIN nodes a ON a.stop_id = p.from_stop_id
JOIN nodes b ON b.stop_id = p.to_stop_id
JOIN floor_names f ON f.level = a.level
WHERE a.level = b.level AND (a.lat <> b.lat OR a.lon <> b.lon);

-- Elevators and escalators, one row per floor they reach: their name, the floors they join,
-- their place on that floor (the middle of their pathways' ends there).
CREATE TABLE lifts AS
WITH ends AS (
  SELECT p.facility_id, n.level, n.lat, n.lon
  FROM pathways p JOIN nodes n ON n.stop_id IN (p.from_stop_id, p.to_stop_id)
  WHERE p.facility_id IS NOT NULL AND p.pathway_mode IN ('4', '5')
), per AS (
  SELECT facility_id, level, avg(lat) AS latitude, avg(lon) AS longitude FROM ends GROUP BY ALL
)
SELECT per.facility_id AS facility, upper(left(f.facility_type, 1)) || substr(f.facility_type, 2) AS kind, f.facility_long_name AS name,
       per.level, fn.floor_name, per.latitude, per.longitude,
       (SELECT string_agg(DISTINCT x.level::VARCHAR, ' ↔ ' ORDER BY x.level::VARCHAR)
        FROM per x WHERE x.facility_id = per.facility_id) AS floors
FROM per
JOIN facilities f ON f.facility_id = per.facility_id
JOIN floor_names fn ON fn.level = per.level;

-- Points: the platforms (GTFS stops, by name) and the entrances.
CREATE TABLE points AS
SELECT CASE n.location_type WHEN '0' THEN 'Platform' WHEN '2' THEN 'Entrance' END AS kind,
       coalesce(n.platform_name, n.stop_name) AS name, n.stop_id AS stop, n.level, f.floor_name,
       n.lat AS latitude, n.lon AS longitude
FROM nodes n JOIN floor_names f USING (level)
WHERE n.location_type IN ('0', '2') AND n.stop_id <> 'NEC-2287';

-- Each floor's outline: everything on it, 3 m around, merged.
CREATE TABLE floors AS
WITH parts AS (
  SELECT level, to_m(g) AS g FROM areas
  UNION ALL SELECT level, ST_Buffer(to_m(g), 3) FROM walks
  UNION ALL SELECT level, ST_Buffer(to_m(ST_Point(longitude, latitude)), 4) FROM lifts
  UNION ALL SELECT level, ST_Buffer(to_m(ST_Point(longitude, latitude)), 4) FROM points
  UNION ALL SELECT level, ST_Buffer(l, 3) FROM tracks
)
SELECT p.level, f.floor_name, to_wgs(ST_SimplifyPreserveTopology(ST_Union_Agg(ST_MakeValid(p.g)), 0.5)) AS g
FROM parts p JOIN floor_names f USING (level)
GROUP BY p.level, f.floor_name;

COPY (SELECT level, floor_name, ST_AsGeoJSON(g)::VARCHAR AS geometry FROM floors ORDER BY level)
  TO '@OUT@/floors.parquet' (FORMAT parquet, COMPRESSION zstd);
COPY (SELECT kind, name, coalesce(ref, '') AS ref, level, floor_name, ST_AsGeoJSON(g)::VARCHAR AS geometry FROM areas ORDER BY level, kind)
  TO '@OUT@/areas.parquet' (FORMAT parquet, COMPRESSION zstd);
COPY (SELECT * FROM lifts ORDER BY level, kind, facility)
  TO '@OUT@/lifts.parquet' (FORMAT parquet, COMPRESSION zstd);
COPY (SELECT * FROM points ORDER BY level, kind, name)
  TO '@OUT@/points.parquet' (FORMAT parquet, COMPRESSION zstd);
-- A track as its bed, 1.5 m wide: a line would be drawn wider the further the map zooms out.
COPY (SELECT track, level, mode, stop, round(ST_Length(l), 1) AS length_m,
             ST_AsGeoJSON(to_wgs(ST_Buffer(l, 0.75, 2, 'CAP_FLAT', 'JOIN_ROUND', 2)))::VARCHAR AS geometry
      FROM tracks ORDER BY track)
  TO '@OUT@/tracks.parquet' (FORMAT parquet, COMPRESSION zstd);
COPY (SELECT track, level, mode, stop, x, x_m, y_m, azimuth, ST_AsGeoJSON(g)::VARCHAR AS geometry FROM slices ORDER BY track, x)
  TO '@OUT@/slices.parquet' (FORMAT parquet, COMPRESSION zstd);
