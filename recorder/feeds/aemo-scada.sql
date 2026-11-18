-- Every generating unit of Australia's National Electricity Market, its output
-- in MW every five minutes, as AEMO's SCADA reads it: the feed behind
-- aemo-eraring-live. AEMO publishes each dispatch interval as one small zipped
-- CSV on NEMweb (about 500 units), listed on a page that keeps three days; the
-- recorder (schedule: listing) reads each file once, through the gateway, sets
-- `source` (the CSV) and keeps what this returns. gateway/recordings/
-- aemo-scada-empty.parquet must match its columns (recorder/make-empty.sh).
--
-- The CSV is AEMO's MMS format: a C line, an I line naming the columns, then
-- D lines (D, DISPATCH, UNIT_SCADA, 1, SETTLEMENTDATE, DUID, SCADAVALUE,
-- LASTCHANGED) and a closing C line. Times are market time, AEST, UTC+10 all
-- year. SETTLEMENTDATE is the end of the interval the value stands for.
--
-- Data: AEMO, NEMweb, under AEMO's copyright permissions (free use with
-- attribution).
--
-- source: http://feeds/nemweb/Reports/Current/Dispatch_SCADA/
-- schedule: listing
-- files: PUBLIC_DISPATCHSCADA_\d{12}_\d+\.zip
-- interval: 60
-- order: duid, ts
SELECT to_timestamp(epoch(strptime(settlement, '%Y/%m/%d %H:%M:%S')) - 36000) AS ts,
       duid,
       try_cast(mw AS DOUBLE) AS mw
FROM read_csv(getvariable('source'), header = false, skip = 1, null_padding = true,
              auto_detect = false, delim = ',', quote = '"',
              columns = {kind: 'VARCHAR', report: 'VARCHAR', subtype: 'VARCHAR', version: 'VARCHAR',
                         settlement: 'VARCHAR', duid: 'VARCHAR', mw: 'VARCHAR', changed: 'VARCHAR'})
WHERE kind = 'D'
