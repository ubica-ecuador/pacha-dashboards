import duckdb, sys
con = duckdb.connect()
import os, string
sql = string.Template(open(sys.argv[1]).read()).safe_substitute(os.environ)
stmts = [s for s in sql.split(';\n') if s.strip()]
for s in stmts:
    r = con.execute(s)
    try:
        rows = r.fetchall()
        if rows and s.strip().upper().startswith('SELECT'):
            print([d[0] for d in r.description]); [print(x) for x in rows[:40]]
    except Exception: pass
