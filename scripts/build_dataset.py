"""Build data/chargers.json from the nap-dashboard pipeline outputs.

Reads (all produced by nap-dashboard's fetch_data.sh + nap_etl.py):
  <nap>/nap_static_sites.csv, nap_static_points.csv, nap_dynamic_pricing.csv,
  mobie_tarifas.csv

Status isn't here: the server reads it live from the NAP feed (src/live.js).

Why not nap_opc_points.csv: it pivots MOBI.E tariffs with aggfunc='first', so a
socket with tiered per-minute prices ("0 /min" + "0.18 /min após 30 min") keeps
only one of them. Cost math needs every tier, so we parse the raw tariff file.

Usage: python scripts/build_dataset.py <nap-dashboard>/data [out.json]
"""
import json
import re
import sys
from datetime import datetime, timezone

import pandas as pd

NAP = sys.argv[1] if len(sys.argv) > 1 else '../nap-dashboard/data'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'data/chargers.json'

S = pd.read_csv(f'{NAP}/nap_static_sites.csv', dtype=str)
P = pd.read_csv(f'{NAP}/nap_static_points.csv', dtype=str).drop_duplicates('point_id')
DP = pd.read_csv(f'{NAP}/nap_dynamic_pricing.csv', dtype=str)
M = pd.read_csv(f'{NAP}/mobie_tarifas.csv', sep=';', dtype=str).drop_duplicates()

NUM = r'([\d]+(?:[.,]\d+)?)'
RE_VAL = re.compile(r'€?\s*' + NUM + r'\s*/\s*(\w+)')
RE_FROM = re.compile(r'após\s+' + NUM + r'\s*min')
RE_TO = re.compile(r'até\s+' + NUM + r'\s*min')


def num(s):
    return float(s.replace(',', '.'))


def parse_tarifa(s):
    """'€ 0.2 /min após 60 min' -> {'eur': 0.2, 'unit': 'min', 'from': 60, 'to': None}"""
    s = str(s).strip()
    m = RE_VAL.search(s)
    if not m:
        return None
    f, t = RE_FROM.search(s), RE_TO.search(s)
    return {'eur': num(m.group(1)), 'unit': m.group(2).lower(),
            'from': num(f.group(1)) if f else 0, 'to': num(t.group(1)) if t else None}


def tom_key(x):
    try:
        return str(int(str(x)))
    except (TypeError, ValueError):
        return None


# Same join key as nap-dashboard/scripts/mobie_join.py: MOBI.E ID + tomada
# (second-to-last segment of UID_TOMADA) <-> NAP site_external_id + last
# segment of point_id.
M['tomada'] = M.UID_TOMADA.map(lambda x: tom_key(str(x).split('-')[-2]) if len(str(x).split('-')) >= 3 else None)
M['plan'] = M.TIPO_TARIFARIO.fillna('REGULAR')
M['p'] = M.TARIFA.map(parse_tarifa)
M = M[M.p.notna() & M.TIPO_TARIFA.isin(['FLAT', 'ENERGY', 'TIME', 'PARKING_TIME'])]

tariffs = {}  # (ID, tomada) -> {plan: {flat: [..], energy: [..], time: [..], parking: [..]}}
meta = {}     # (ID, tomada) -> voltage level
FIELD = {'FLAT': 'flat', 'ENERGY': 'energy', 'TIME': 'time', 'PARKING_TIME': 'parking'}
for r in M.itertuples(index=False):
    k = (r.ID, r.tomada)
    plan = tariffs.setdefault(k, {}).setdefault(r.plan, {})
    p = r.p
    if r.TIPO_TARIFA in ('FLAT', 'ENERGY'):
        v = plan.setdefault(FIELD[r.TIPO_TARIFA], [])
        if p['eur'] not in v:
            v.append(p['eur'])
    else:
        tier = {'eur': p['eur'], 'from': p['from'], 'to': p['to']}
        v = plan.setdefault(FIELD[r.TIPO_TARIFA], [])
        if tier not in v:
            v.append(tier)
    if isinstance(r.NIVELTENSAO, str) and r.NIVELTENSAO in ('BTN', 'BTE', 'MT'):
        meta[k] = r.NIVELTENSAO

nap_price = (DP[DP.pricing_policy == 'pricePerDeliveryUnit']
             .drop_duplicates('point_id').set_index('point_id').min_fee)


def region(lat, lon):
    if lon < -24:
        return 'AZO'
    if lat < 33.5 and lon < -15:
        return 'MAD'
    return 'CONT'


def connector(ct):
    ct = str(ct)
    return {'iec62196T2': 'T2', 'iec62196T2COMBO': 'CCS', 'chademo': 'CHADEMO',
            'domestic': 'SCHUKO', 'domesticF': 'SCHUKO', 'iec62196T1': 'T1',
            'iec62196T1COMBO': 'CCS1', 'iec60309x2three16': 'CEE'}.get(ct, ct)


def fnum(x):
    try:
        v = float(x)
        return v if v == v else None
    except (TypeError, ValueError):
        return None


sites = {}
for s in S.itertuples(index=False):
    lat, lon = fnum(s.latitude), fnum(s.longitude)
    if lat is None or lon is None:
        continue
    sites[s.site_id] = {
        'id': s.site_id, 'code': s.external_id, 'lat': round(lat, 6), 'lon': round(lon, 6),
        'region': region(lat, lon), 'city': s.city if isinstance(s.city, str) else None,
        'address': s.address_line if isinstance(s.address_line, str) else None,
        'operator': s.operator_name if isinstance(s.operator_name, str) else None,
        'points': [],
    }

for p in P.itertuples(index=False):
    site = sites.get(p.site_id)
    if site is None:
        continue
    mode = str(p.charging_mode)
    kw = fnum(p.max_power_w)
    has_ceme = isinstance(p.brands_accepted, str) and p.brands_accepted.strip() != ''
    k = (p.site_external_id, tom_key(str(p.point_id).split('-')[-1]))
    t = tariffs.get(k)
    pt = {
        'id': p.point_id,
        'kw': round(kw / 1000, 1) if kw else None,
        'connector': connector(p.connector_type),
        'dc': 'DC' in mode,
        'phases': 1 if mode.endswith('1p') else 3 if mode.endswith('3p') else None,
        'level': meta.get(k),
        # mobie: CEME + MOBI.E OPC tariff; mobie_sem_tarifa: CEME but no OPC
        # tariff in MOBI.E's file; sem_ceme: outside MOBI.E roaming, NAP has a
        # single price whose meaning (final? energy only?) isn't declared.
        'regime': ('mobie' if t else 'mobie_sem_tarifa') if has_ceme else 'sem_ceme',
    }
    if t:
        pt['opc'] = t
    # Fallback for when the live feed is down; live NAP fees win otherwise.
    if not has_ceme and p.point_id in nap_price.index:
        pt['napPrice'] = fnum(nap_price[p.point_id])
    site['points'].append(pt)

out = {
    'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
    'sites': [s for s in sites.values() if s['points']],
}
with open(OUT, 'w') as f:
    json.dump(out, f, ensure_ascii=False, separators=(',', ':'))

n_pts = sum(len(s['points']) for s in out['sites'])
n_opc = sum(1 for s in out['sites'] for p in s['points'] if 'opc' in p)
print(f'{len(out["sites"])} sites, {n_pts} points, {n_opc} with MOBI.E OPC tariff -> {OUT}')
