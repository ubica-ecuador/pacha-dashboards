-- build.sh runs this in its work folder: samples/<year>.csv from Socrata (one row per sample and analyte) and
-- stations.csv. Writes samples.parquet (one row per sample) and stations.parquet.

-- DEP writes "<1" for coliform it did not find, ">200.5" past what the test counts, and plain numbers otherwise.
CREATE TABLE raw AS
SELECT sampleid, sampledatetime::TIMESTAMP AS time, site, nullif(borough, '') AS borough, analyte,
       CASE WHEN final LIKE '<%' THEN 0 ELSE TRY_CAST(regexp_replace(final, '[^0-9.]', '', 'g') AS DOUBLE) END AS value
FROM read_csv('samples/*.csv', all_varchar = true, header = true);

COPY (
  -- the tunnel shafts, where water from the aqueducts enters the city's mains, have no borough in DEP's rows
  SELECT site, coalesce(max(borough), CASE WHEN site LIKE 'SHAFT%' THEN 'Tunnel shafts' ELSE 'Other' END) AS borough,
         min(time) AS time,
         round(max(value) FILTER (analyte = 'Chlorine - Free Residual'), 2)::FLOAT AS chlorine,
         round(max(value) FILTER (analyte = 'Temperature'), 1)::FLOAT AS temperature,
         round(max(value) FILTER (analyte = 'Turbidity'), 2)::FLOAT AS turbidity,
         max(value) FILTER (analyte = 'Total Coliform')::FLOAT AS coliform,
         max(value) FILTER (analyte = 'E. Coli (Enumeration)')::FLOAT AS ecoli
  FROM raw
  GROUP BY sampleid, site
  HAVING chlorine IS NOT NULL OR temperature IS NOT NULL OR coliform IS NOT NULL
  ORDER BY time
) TO 'samples.parquet' (FORMAT parquet, COMPRESSION zstd);

COPY (
  SELECT s.site, s.borough, s.description, s.latitude, s.longitude, s.located,
         count(p.site)::INTEGER AS samples, min(p.time) AS first_sample, max(p.time) AS last_sample
  FROM read_csv('stations.csv', header = true, types = {'site': 'VARCHAR', 'latitude': 'DOUBLE', 'longitude': 'DOUBLE'}) s
  LEFT JOIN read_parquet('samples.parquet') p USING (site)
  GROUP BY ALL
  ORDER BY s.site
) TO 'stations.parquet' (FORMAT parquet, COMPRESSION zstd);
