-- GloBI's flower visits (parts/*.parquet, as build.sh read them) to visits.parquet, visitors.parquet
-- and plants.parquet.
--
-- Kept: a record with a place on the Earth (not 0, 0), a visitor of a pollinating group and a
-- plant. The groups follow the visitor's class, order and family as GloBI matched the name; bees
-- are the families of Anthophila. A plant is of the plant kingdom in the taxonomy GloBI matched
-- (Plantae, Archaeplastida or Viridiplantae) with a family. A visitor or a plant is named by its
-- species, or by its genus when the species is unknown ("Bombus sp."); a record whose visitor or
-- plant is known only to its family or above is left out (2 % of the records).
--
-- visits.parquet holds numbers only, so the server hands it to the browser quickly: one row per
-- place (to 0.01°, about 1 km), visitor, plant and month, with its records. A date before 1800 is a
-- placeholder and a date of 1 January a year alone (DoPI, CropPol and a dozen studies give every
-- record of a year that day): their month is empty. The names are in visitors.parquet (with the
-- visitor's group, the one most of its records give) and plants.parquet (with the plant's family,
-- likewise), numbered in alphabetical order.
CREATE TABLE r AS
SELECT
  try_cast(decimalLatitude AS DOUBLE) AS lat,
  try_cast(decimalLongitude AS DOUBLE) AS lon,
  CASE
    WHEN sourceTaxonClassName = 'Insecta' AND sourceTaxonFamilyName IN
      ('Apidae', 'Halictidae', 'Andrenidae', 'Megachilidae', 'Colletidae', 'Melittidae', 'Stenotritidae') THEN 'Bees'
    WHEN sourceTaxonClassName = 'Insecta' AND sourceTaxonOrderName = 'Hymenoptera' THEN 'Wasps and ants'
    WHEN sourceTaxonClassName = 'Insecta' AND sourceTaxonFamilyName = 'Syrphidae' THEN 'Hoverflies'
    WHEN sourceTaxonClassName = 'Insecta' AND sourceTaxonOrderName = 'Diptera' THEN 'Other flies'
    WHEN sourceTaxonClassName = 'Insecta' AND sourceTaxonOrderName = 'Lepidoptera' THEN 'Butterflies and moths'
    WHEN sourceTaxonClassName = 'Insecta' AND sourceTaxonOrderName = 'Coleoptera' THEN 'Beetles'
    WHEN sourceTaxonClassName = 'Insecta' THEN 'Other insects'
    WHEN sourceTaxonClassName = 'Aves' THEN 'Birds'
    WHEN sourceTaxonOrderName = 'Chiroptera' THEN 'Bats'
  END AS visitor_group,
  coalesce(sourceTaxonSpeciesName, sourceTaxonGenusName || ' sp.') AS visitor,
  sourceTaxonFamilyName AS visitor_family,
  coalesce(targetTaxonSpeciesName, targetTaxonGenusName || ' sp.') AS plant,
  targetTaxonFamilyName AS plant_family,
  targetTaxonKingdomName AS plant_kingdom,
  try_cast(left(eventDate, 10) AS DATE) AS day,
  CASE sourceNamespace
    WHEN 'JoseBSL/EuPPollNet' THEN 'EuPPollNet'
    WHEN 'globalbioticinteractions/inaturalist' THEN 'iNaturalist'
    WHEN 'globalbioticinteractions/gbif-us-bees' THEN 'GBIF-US bee collections'
    WHEN 'globalbioticinteractions/dopi' THEN 'DoPI'
    WHEN 'ibartomeus/CropPol' THEN 'CropPol'
    WHEN 'globalbioticinteractions/web-of-life' THEN 'Web of Life'
    ELSE 'Other datasets'
  END AS source
FROM 'parts/*.parquet';

CREATE TABLE k AS
SELECT round(lat, 2) AS latitude, round(lon, 2) AS longitude, visitor_group, visitor, plant, plant_family,
       CASE WHEN year(day) >= 1800 AND strftime(day, '%m-%d') <> '01-01' THEN month(day) END AS month
FROM r
WHERE lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180 AND NOT (lat = 0 AND lon = 0)
  AND visitor_group IS NOT NULL AND visitor IS NOT NULL AND plant IS NOT NULL AND plant_family IS NOT NULL
  AND plant_kingdom IN ('Plantae', 'Archaeplastida', 'Viridiplantae');

CREATE TABLE visitors AS
SELECT row_number() OVER (ORDER BY visitor)::INTEGER AS v, visitor, visitor_group
FROM (SELECT visitor, mode(visitor_group) AS visitor_group FROM k GROUP BY visitor);

CREATE TABLE plants AS
SELECT row_number() OVER (ORDER BY plant)::INTEGER AS p, plant, plant_family
FROM (SELECT plant, mode(plant_family) AS plant_family FROM k GROUP BY plant);

COPY (
  SELECT k.latitude, k.longitude, visitors.v, plants.p, k.month::TINYINT AS month, count(*)::INTEGER AS records
  FROM k JOIN visitors USING (visitor) JOIN plants USING (plant)
  GROUP BY ALL
  ORDER BY visitors.v, plants.p
) TO 'visits.parquet' (FORMAT parquet, COMPRESSION zstd);
COPY visitors TO 'visitors.parquet' (FORMAT parquet, COMPRESSION zstd);
COPY plants TO 'plants.parquet' (FORMAT parquet, COMPRESSION zstd);

SELECT count(*) AS rows, sum(records) AS records, count(DISTINCT (v, p)) AS pairs, count(DISTINCT (latitude, longitude)) AS places,
       (SELECT count(*) FROM visitors) AS visitors, (SELECT count(*) FROM plants) AS plants
FROM 'visits.parquet';
