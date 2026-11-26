# The arcaded houses raised to their taller floors (arcades.py, arcade_lift.csv): every point of their surfaces above
# the ground goes up by dz, so walls stretch and roofs rise. surfaces-base.parquet -> surfaces-lifted.parquet.
import csv, re, duckdb
lift = {r['id']: float(r['dz']) for r in csv.DictReader(open('/work/arcade_lift.csv'))}
con = duckdb.connect()
con.execute("CREATE TABLE s AS SELECT * FROM '/work/surfaces-base.parquet'")
num = re.compile(r'(-?\d+\.\d+) (-?\d+\.\d+) (-?\d+(?:\.\d+)?)')
def up(g, dz):
    return num.sub(lambda m: f'{m.group(1)} {m.group(2)} {float(m.group(3)) + dz:.2f}' if float(m.group(3)) > 0.01 else m.group(0), g)
rows = con.execute("SELECT rowid, building_id, geometry FROM s WHERE building_id IN (SELECT unnest(?))", [list(lift)]).fetchall()
con.execute("CREATE TABLE fix (r BIGINT, g VARCHAR)")
con.executemany("INSERT INTO fix VALUES (?, ?)", [(r, up(g, lift[b])) for r, b, g in rows])
con.execute("UPDATE s SET geometry = fix.g, eave_m = eave_m + 0, top_m = top_m FROM fix WHERE s.rowid = fix.r")
for b, dz in lift.items():
    con.execute("UPDATE s SET eave_m = round(eave_m + ?, 1), top_m = round(top_m + ?, 1), height_m = round(height_m + ?, 1) WHERE building_id = ?", [dz, dz, dz, b])
con.execute("COPY s TO '/work/surfaces-lifted.parquet' (FORMAT parquet, COMPRESSION zstd)")
print(f'{len(lift)} buildings raised, {len(rows)} surfaces')
