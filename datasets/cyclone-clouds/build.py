# Run by build.sh in a Python container: one ECMWF forecast run's relative
# humidity on eleven pressure levels and its sea-level pressure, every six hours
# to two days ahead, cut to a box around the storm, as two Parquet files in /out.
import os
import pandas as pd
import xarray as xr
from ecmwf.opendata import Client

DATE, TIME = os.environ['RUN_DATE'], int(os.environ['RUN_TIME'])
SOUTH, NORTH, WEST, EAST = (float(os.environ[k]) for k in ('SOUTH', 'NORTH', 'WEST', 'EAST'))
LEVELS = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150]
STEPS = list(range(0, 49, 6))
# The open data's copies keep past runs (ECMWF's own portal only the last few
# days); the first that answers wins.
SOURCES = os.environ.get('SOURCES', 'azure google aws ecmwf').split()


def grid(param, **kw):
    target = f'/work/{param}.grib2'
    for source in SOURCES:
        try:
            Client(source=source, model='ifs', resol='0p25').retrieve(
                date=DATE, time=TIME, type='fc', param=param, step=STEPS, target=target, **kw)
            print(param, 'from', source, flush=True)
            break
        except Exception as error:  # noqa: BLE001 - the next copy may answer
            print(param, 'not from', source, error, flush=True)
    else:
        raise SystemExit(f'No copy of the open data has {param} for {DATE} {TIME} UTC')
    ds = xr.open_dataset(target, engine='cfgrib', backend_kwargs={'indexpath': ''})
    return ds, ds[param].sel(latitude=slice(NORTH, SOUTH), longitude=slice(WEST, EAST))


# clouds.parquet: every cell and level at 60 % or more.
ds, r = grid('r', levtype='pl', levelist=LEVELS)
df = r.to_dataframe().reset_index()
df = df[df['r'] >= 60]
out = df[['valid_time', 'isobaricInhPa', 'latitude', 'longitude', 'r']].rename(columns={'isobaricInhPa': 'level_hpa', 'r': 'rh'})
out['valid_time'] = pd.to_datetime(out['valid_time'])
out['level_hpa'] = out['level_hpa'].astype('int16')
out['rh'] = out['rh'].round(0).astype('int16')
out.to_parquet('/out/clouds.parquet', index=False)
print(len(out), 'humid cells and levels', flush=True)

# centres.parquet: the storm's eye at each step, its lowest sea-level pressure
# inside the eye box.
ES, EN, EW, EE = (float(os.environ[k]) for k in ('EYE_SOUTH', 'EYE_NORTH', 'EYE_WEST', 'EYE_EAST'))
ds, msl = grid('msl')
msl = ds['msl'].sel(latitude=slice(EN, ES), longitude=slice(EW, EE))
rows = []
for i in range(msl.sizes['step']):
    f = msl.isel(step=i)
    at = f.argmin(dim=['latitude', 'longitude'])
    rows.append({'valid_time': pd.Timestamp(ds.valid_time.values[i]),
                 'latitude': float(f.latitude[at['latitude']]), 'longitude': float(f.longitude[at['longitude']]),
                 'msl_hpa': round(float(f.min()) / 100, 1)})
centres = pd.DataFrame(rows)
centres.to_parquet('/out/centres.parquet', index=False)
print(centres.to_string(index=False), flush=True)
