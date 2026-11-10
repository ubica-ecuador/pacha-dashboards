-- NUFORC's reports as planetsig geocoded them, column for column and as text. The CSV has no
-- header row and a few malformed lines: read with the options the dashboard's dataset used when it
-- read the URL itself, so the rows are the same: 80,332, of which it keeps the 80,331 with a date
-- and a place.
COPY (
  SELECT * FROM read_csv('nuforc.csv',
    header = false, ignore_errors = true, null_padding = true, strict_mode = false,
    columns = {'datetime': 'VARCHAR', 'city': 'VARCHAR', 'state': 'VARCHAR', 'country': 'VARCHAR', 'shape': 'VARCHAR',
               'duration_s': 'VARCHAR', 'duration_text': 'VARCHAR', 'comments': 'VARCHAR', 'date_posted': 'VARCHAR',
               'latitude': 'VARCHAR', 'longitude': 'VARCHAR'})
) TO 'nuforc.parquet' (FORMAT parquet, COMPRESSION zstd);
SELECT count(*) AS reports FROM 'nuforc.parquet';
