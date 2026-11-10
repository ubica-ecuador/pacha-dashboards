-- SONYC-UST v2's annotations: one row per annotation of a recording. annotator_id > 0 are the
-- Zooniverse volunteers (three per recording); 0 and below, the SONYC team's verified subset.
CREATE TABLE annotations AS SELECT * FROM read_csv('annotations.csv');

-- One row per recording: each coarse class is present when most of its volunteers tagged it.
CREATE TABLE clips AS
SELECT row_number() OVER (ORDER BY audio_filename) AS id,
       any_value(sensor_id) AS sensor_id,
       CASE any_value(borough) WHEN 1 THEN 'Manhattan' WHEN 3 THEN 'Brooklyn' WHEN 4 THEN 'Queens' END AS borough,
       any_value(block) AS block, any_value(latitude) AS latitude, any_value(longitude) AS longitude,
       any_value("year") AS "year", any_value("week") AS week, any_value("day") AS day_num, any_value("hour") AS "hour",
       -- The hour it was recorded, back from SONYC's year, week of the year (ISO, Monday first: no
       -- year has a week 0) and day of the week. Local clock time, kept as a plain TIMESTAMP.
       ((make_date(any_value("year")::INTEGER, 1, 4) - (isodow(make_date(any_value("year")::INTEGER, 1, 4)) - 1)::INTEGER
         + ((any_value("week")::INTEGER - 1) * 7 + any_value("day")::INTEGER))::TIMESTAMP
         + to_hours(any_value("hour")::BIGINT)) AS "time",
       bool_or(annotator_id = 0) AS verified,
       (avg("1_engine_presence") FILTER (WHERE annotator_id > 0) > 0.5)::INTEGER AS c1,
       (avg("2_machinery-impact_presence") FILTER (WHERE annotator_id > 0) > 0.5)::INTEGER AS c2,
       (avg("3_non-machinery-impact_presence") FILTER (WHERE annotator_id > 0) > 0.5)::INTEGER AS c3,
       (avg("4_powered-saw_presence") FILTER (WHERE annotator_id > 0) > 0.5)::INTEGER AS c4,
       (avg("5_alert-signal_presence") FILTER (WHERE annotator_id > 0) > 0.5)::INTEGER AS c5,
       (avg("6_music_presence") FILTER (WHERE annotator_id > 0) > 0.5)::INTEGER AS c6,
       (avg("7_human-voice_presence") FILTER (WHERE annotator_id > 0) > 0.5)::INTEGER AS c7,
       (avg("8_dog_presence") FILTER (WHERE annotator_id > 0) > 0.5)::INTEGER AS c8
FROM annotations
GROUP BY audio_filename;

-- The eight coarse classes of SONYC's taxonomy, in its order, named by what they hold.
CREATE TABLE classes(ord INTEGER, col VARCHAR, sound VARCHAR);
INSERT INTO classes VALUES (1, 'c1', 'Engines'), (2, 'c2', 'Jackhammers, drills'), (3, 'c3', 'Other impacts'),
  (4, 'c4', 'Powered saws'), (5, 'c5', 'Sirens, horns, alarms'), (6, 'c6', 'Music'), (7, 'c7', 'Voices'), (8, 'c8', 'Dogs');

-- One row per recording, for the filters, the cards and the hour brush.
COPY (
  SELECT id, sensor_id, borough, block, latitude, longitude, "time", "year", week, day_num,
         ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][day_num + 1] AS "day", day_num >= 5 AS weekend, "hour", verified,
         c1 AS engines, c2 AS jackhammers, c3 AS impacts, c4 AS saws, c5 AS alerts, c6 AS music, c7 AS voices, c8 AS dogs
  FROM clips ORDER BY id
) TO 'recordings.parquet' (FORMAT parquet, COMPRESSION zstd);

-- One row per recording and sound class, for the shares: present is 1 or 0.
COPY (
  SELECT u.id, k.sound, k.ord, u.present, u.sensor_id, u.borough, u.block, u.latitude, u.longitude,
         u."time", u."year", u.week, u.day_num,
         ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][u.day_num + 1] AS "day",
         u.day_num >= 5 AS weekend, u."hour", u.verified
  FROM (UNPIVOT clips ON c1, c2, c3, c4, c5, c6, c7, c8 INTO NAME col VALUE present) AS u
  JOIN classes AS k USING (col)
  ORDER BY u.id, k.ord
) TO 'sounds.parquet' (FORMAT parquet, COMPRESSION zstd);

SELECT count(*) AS recordings, count(DISTINCT sensor_id) AS sensors, min("time") AS first, max("time") AS last,
       (SELECT count(*) FROM 'sounds.parquet') AS sound_rows FROM 'recordings.parquet';
