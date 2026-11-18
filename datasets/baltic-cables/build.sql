-- The cables and pipelines on the floor of the Baltic, each with its fence, as
-- one Parquet file for the baltic-cable-watch dashboard and its alert rule
-- (http://feeds/datasets/baltic-cables/cables.parquet). Run by build.sh, which
-- downloads the sources into `dir` and runs this in the folder the file is
-- written to.
--
-- One row per cable, its parts merged: name (unique: it is the alert's `cable`
-- label and the zone the map colours), kind (telecom, power, gas), operator,
-- km on the Baltic, a link, the line and the fence. Geometries are clipped to
-- the Baltic, the Kattegat to the Bothnian Bay (9–33° E, 53–67° N).

INSTALL spatial;
LOAD spatial;
SET geometry_always_xy = true;

CREATE MACRO baltic() AS ST_MakeEnvelope(9, 53, 33, 67);
-- Metres for buffers: ETRS89 Lambert equal-area, Europe's own.
CREATE MACRO to_m(g) AS ST_Transform(g, 'EPSG:4326', 'EPSG:3035');
CREATE MACRO to_deg(g) AS ST_Transform(g, 'EPSG:3035', 'EPSG:4326');

-- Telecom: TeleGeography's cables, by their names, linked to their page.
CREATE TABLE parts AS
SELECT name AS cable, 'telecom' AS kind, NULL::VARCHAR AS operator,
       'https://www.submarinecablemap.com/submarine-cable/' || id AS url, geom
FROM ST_Read(getvariable('dir') || '/telecom.json');

-- Gas: EMODnet's named gas pipelines, and Balticconnector, which EMODnet lists
-- without a medium. Water and sewage pipes near the shores stay out, and so do
-- a few short gas pipes with no name. EMODnet's status is left out: it still
-- has Nord Stream 1 active and Nord Stream 2 planned. EMODnet draws Nord
-- Stream 2 three times (the whole line and its two strings off Sweden): one
-- name, so a ship over it is one alert.
INSERT INTO parts
SELECT CASE WHEN name ILIKE 'NORD STREAM 2%' THEN 'Nord Stream 2'
            WHEN name ILIKE 'NORD STREAM 1%' THEN 'Nord Stream 1'
            ELSE trim(name) END,
       'gas', nullif(trim(operator), ''), 'https://emodnet.ec.europa.eu/en/human-activities', geom
FROM ST_Read(getvariable('dir') || '/pipelines.json')
WHERE (medium = 'Gas' AND nullif(trim(name), '') IS NOT NULL) OR name = 'Balticconnector';

-- Power: OpenStreetMap's underwater power cables. A cable is drawn as several
-- ways that share its name; one with no name keeps its way's id, and only if
-- it is 5 km or longer (dozens of short island links otherwise).
INSERT INTO parts
WITH ways AS (
  SELECT w.id, w.tags, ST_MakeLine(list_transform(w.geometry, lambda p: ST_Point(p.lon, p.lat))) AS geom
  FROM (SELECT unnest(elements) AS w FROM read_json(getvariable('dir') || '/power.json',
        columns = {elements: 'STRUCT(id BIGINT, tags MAP(VARCHAR, VARCHAR), geometry STRUCT(lat DOUBLE, lon DOUBLE)[])[]'}))
)
SELECT coalesce(tags['name'], 'Power cable, OSM way ' || id), 'power', tags['operator'],
       'https://www.openstreetmap.org/way/' || id, geom
FROM ways
WHERE tags['name'] IS NOT NULL OR ST_Length_Spheroid(geom) >= 5000;

-- Where ships are expected to stop: ports and cable landings, 5 km around.
CREATE TABLE harbours AS
SELECT ST_Union_Agg(ST_Buffer(to_m(geom), 5000, 16)) AS area
FROM (
  SELECT geom FROM ST_Read(getvariable('dir') || '/ports.json')
  UNION ALL
  SELECT geom FROM ST_Read(getvariable('dir') || '/landings.json')
)
WHERE ST_Intersects(geom, baltic());

CREATE TABLE cables AS
SELECT cable, kind, any_value(operator) AS operator, any_value(url) AS url,
       ST_Intersection(ST_Union_Agg(geom), baltic()) AS line
FROM parts
WHERE ST_Intersects(geom, baltic())
GROUP BY cable, kind;

COPY (
  SELECT cable, kind, operator, url,
         round(ST_Length_Spheroid(line) / 1000, 1) AS km,
         line,
         -- A kilometre each side, ports and landings cut out, simplified to 25 m.
         to_deg(ST_SimplifyPreserveTopology(
           ST_Difference(ST_Buffer(to_m(line), 1000, 4), (SELECT area FROM harbours)), 25)) AS fence
  FROM cables
  WHERE NOT ST_IsEmpty(line)
  ORDER BY kind, cable
) TO 'cables.parquet' (FORMAT parquet, COMPRESSION zstd);

SELECT kind, count(*) AS cables, round(sum(km)) AS km,
       count(*) FILTER (WHERE ST_IsEmpty(fence)) AS no_fence
FROM 'cables.parquet' GROUP BY kind ORDER BY kind;

-- A ship's flag from its MMSI: the first three digits are the ITU's Maritime
-- Identification Digits. The flags of Europe and of the open registries seen
-- in the Baltic; any other reads as its digits.
COPY (
  SELECT * FROM (VALUES
    (201, 'Albania'), (203, 'Austria'), (204, 'Portugal'), (205, 'Belgium'), (206, 'Belarus'), (207, 'Bulgaria'),
    (209, 'Cyprus'), (210, 'Cyprus'), (211, 'Germany'), (212, 'Cyprus'), (213, 'Georgia'), (214, 'Moldova'),
    (215, 'Malta'), (218, 'Germany'), (219, 'Denmark'), (220, 'Denmark'), (224, 'Spain'), (225, 'Spain'),
    (226, 'France'), (227, 'France'), (228, 'France'), (229, 'Malta'), (230, 'Finland'), (231, 'Faroe Islands'),
    (232, 'United Kingdom'), (233, 'United Kingdom'), (234, 'United Kingdom'), (235, 'United Kingdom'),
    (236, 'Gibraltar'), (237, 'Greece'), (238, 'Croatia'), (239, 'Greece'), (240, 'Greece'), (241, 'Greece'),
    (244, 'Netherlands'), (245, 'Netherlands'), (246, 'Netherlands'), (247, 'Italy'), (248, 'Malta'),
    (249, 'Malta'), (250, 'Ireland'), (251, 'Iceland'), (253, 'Luxembourg'), (254, 'Monaco'), (255, 'Portugal'),
    (256, 'Malta'), (257, 'Norway'), (258, 'Norway'), (259, 'Norway'), (261, 'Poland'), (263, 'Portugal'),
    (264, 'Romania'), (265, 'Sweden'), (266, 'Sweden'), (269, 'Switzerland'), (271, 'Türkiye'), (272, 'Ukraine'),
    (273, 'Russia'), (275, 'Latvia'), (276, 'Estonia'), (277, 'Lithuania'),
    (304, 'Antigua and Barbuda'), (305, 'Antigua and Barbuda'), (308, 'Bahamas'), (309, 'Bahamas'),
    (311, 'Bahamas'), (312, 'Belize'), (314, 'Barbados'), (316, 'Canada'), (319, 'Cayman Islands'),
    (338, 'United States'), (341, 'Saint Kitts and Nevis'), (351, 'Panama'), (352, 'Panama'), (353, 'Panama'),
    (354, 'Panama'), (355, 'Panama'), (356, 'Panama'), (357, 'Panama'), (366, 'United States'),
    (367, 'United States'), (368, 'United States'), (369, 'United States'), (370, 'Panama'), (371, 'Panama'),
    (372, 'Panama'), (373, 'Panama'), (374, 'Panama'), (375, 'Saint Vincent and the Grenadines'),
    (376, 'Saint Vincent and the Grenadines'), (377, 'Saint Vincent and the Grenadines'),
    (378, 'British Virgin Islands'), (412, 'China'), (413, 'China'), (414, 'China'), (416, 'Taiwan'),
    (419, 'India'), (422, 'Iran'), (431, 'Japan'), (432, 'Japan'), (440, 'South Korea'), (441, 'South Korea'),
    (457, 'Mongolia'), (470, 'United Arab Emirates'), (471, 'United Arab Emirates'), (477, 'Hong Kong'),
    (511, 'Palau'), (518, 'Cook Islands'), (538, 'Marshall Islands'), (563, 'Singapore'), (564, 'Singapore'),
    (565, 'Singapore'), (566, 'Singapore'), (572, 'Tuvalu'), (576, 'Vanuatu'), (577, 'Vanuatu'),
    (613, 'Cameroon'), (620, 'Comoros'), (626, 'Gabon'), (636, 'Liberia'), (637, 'Liberia'),
    (667, 'Sierra Leone'), (671, 'Togo'), (677, 'Tanzania')
  ) AS t(mid, flag)
) TO 'flags.parquet' (FORMAT parquet);
