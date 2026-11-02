#!/usr/bin/env python3
"""Publish private bounded chart summaries; retain raw snapshots unchanged.

The reserved metadata-only asset has no positions or financial value. Existing
asset read policies protect the cache; the browser projects only one dataset.
"""
import argparse, collections, datetime as dt, hashlib, json, os, re, time
import urllib.error, urllib.parse, urllib.request
from pathlib import Path

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--key-file',default=os.environ.get('PORTFOLIO_SERVER_KEY_FILE'))
a=p.parse_args()
config={}
if a.key_file:
    for raw in Path(a.key_file).read_text().splitlines():
        key,sep,value=raw.strip().removeprefix('export ').partition('=')
        if sep and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*',key.strip()):config[key.strip()]=value.strip().strip('\"\'')
def required(key):
    value=os.environ.get(key) or config.get(key)
    if not value:raise RuntimeError('Missing '+key)
    return value
base=required('SUPABASE_URL').rstrip('/')
headers={'apikey':required('SUPABASE_SECRET_KEY'),'Authorization':'Bearer '+required('SUPABASE_SECRET_KEY'),'Content-Type':'application/json','Prefer':'return=representation'}
def request(path,params=None,body=None,method=None):
    url=base+path+('?' + urllib.parse.urlencode(params) if params else '')
    for attempt in range(4):
        try:
            req=urllib.request.Request(url,headers=headers,data=None if body is None else json.dumps(body,separators=(',',':')).encode(),method=method)
            with urllib.request.urlopen(req,timeout=60) as response:return json.load(response) if response.status!=204 else None
        except urllib.error.HTTPError as error:
            if error.code not in (429,500,502,503,504) or attempt==3:raise RuntimeError('Chart cache request failed: HTTP '+str(error.code)) from None
        time.sleep(2**attempt)
owner=os.environ.get('PORTFOLIO_OWNER_ID') or config.get('PORTFOLIO_OWNER_ID','')
if not re.fullmatch(r'[0-9a-fA-F-]{36}',owner):
    users=request('/auth/v1/admin/users',{'page':1,'per_page':100})['users']
    owner=next((u['id'] for u in users if u.get('email','').lower()==required('PORTFOLIO_OWNER_EMAIL').lower()),None)
    if not owner:raise RuntimeError('Configured portfolio owner not found')
raw=[]
while True:
    page=request('/rest/v1/position_snapshots',{'owner_id':'eq.'+owner,'select':'snapshot_date,source_key,quantity,value_usd,metadata,account:accounts(name,institution),asset:assets(symbol,asset_class,network)','order':'snapshot_date,source_key','offset':len(raw),'limit':1000})
    raw+=page
    if len(page)<1000:break

def short_address(text):
    m=re.search(r'0x[0-9a-fA-F]{40}',text)
    return m[0][:6].lower()+'…'+m[0][-4:].lower() if m else None

def wallet_hash(row):
    m=re.match(r'^(?:backfill|oneinch|rabby|debank|history:oneinch):([a-f0-9]{12}):',row['source_key'],re.I)
    return str(row['metadata'].get('wallet_hash') or (m[1] if m else ''))
def platform(row):
    account=row['account'];identity=account['name']+' '+account['institution']+' '+row['source_key']
    address=short_address(identity)
    if address:return address
    if re.search(r'rabby|hyperliquid',identity,re.I):return re.sub(r'^Hyperliquid\s*[·:-]?\s*','',account['name'].split(' · ')[0],flags=re.I) or 'Self-custody'
    for expression,label in [('schwab|charles','Charles Schwab'),('wio','Wio'),('xtb','XTB'),('binance','Binance'),('india|inr','India cash'),(r'ether\.fi|etherfi|gbp','Ether.fi UK'),('kast','KAST')]:
        if re.search(expression,identity,re.I):return label
    return account['institution'] or account['name']
def week(date):
    day=dt.date.fromisoformat(date)
    return (day-dt.timedelta(days=(day.weekday()-1)%7)).isoformat()
aliases={}
for canonical,variants in {
    'ethereum':['eth-mainnet','eth','1'], 'arbitrum':['arbitrum-mainnet','arb','42161'],
    'optimism':['optimism-mainnet','op','10'], 'base':['base-mainnet','8453'],
    'linea':['linea-mainnet','59144'], 'polygon':['matic-mainnet','matic','137'],
    'bnb chain':['bsc-mainnet','bsc','56'], 'gnosis':['gnosis-mainnet','xdai','100'],
    'avalanche':['avax-mainnet','avax','43114'], 'zksync':['zksync-mainnet','324'],
    'plasma':['plasma-mainnet','9745']}.items():
    aliases.update({v:canonical for v in variants})
labels={wallet_hash(r):short_address(r['account']['name']) for r in raw if r.get('account') and wallet_hash(r) and short_address(r['account']['name'])}
published={(r['metadata'].get('history_batch'),r['metadata'].get('chain_id')) for r in raw if r['metadata'].get('coverage_only') and r['metadata'].get('history_batch')}
observations={}
for r in raw:
    m=r['metadata'];asset=r.get('asset');account=r.get('account')
    if not asset or not account:continue
    if m.get('history_batch') and (m['history_batch'],m.get('chain_id')) not in published:continue
    if asset['asset_class'] not in ('crypto','stablecoin','nft') and asset['symbol'].upper() not in ('XAUT','XAUT0','PAXG') and not (asset['asset_class']=='liability' and wallet_hash(r)):continue
    identity=wallet_hash(r) or (re.search(r'0x[0-9a-fA-F]{40}',account['name'])[0].lower() if re.search(r'0x[0-9a-fA-F]{40}',account['name']) else platform(r))
    network=str(m.get('chain_id') or asset.get('network') or 'unknown').lower()
    key=(week(r['snapshot_date']),identity,aliases.get(network,network))
    priority=2.5 if m.get('history_authority')=='archive-rpc' else 0 if r['source_key'].startswith('backfill:') else 2 if m.get('history_complete') else 3
    rank=(priority,r['snapshot_date']);previous=observations.get(key)
    if not previous or rank>previous[0]:observations[key]=(rank,[r])
    elif rank==previous[0]:previous[1].append(r)
points={}
for rank,records in observations.values():
    for r in records:
        if r['metadata'].get('coverage_only'):continue
        date=week(r['snapshot_date']);name=labels.get(wallet_hash(r)) or platform(r)
        point=points.setdefault(date,{'date':date,'total':0,'platforms':{},'assets':{}})
        value=float(r['value_usd']);quantity=float(r.get('quantity') or 0)
        point['total']+=value;point['platforms'][name]=point['platforms'].get(name,0)+value
        if not value and not quantity:continue
        network=r['asset'].get('network');label=r['asset']['symbol']+(' · '+network if network else '')
        asset=point['assets'].setdefault(name,{}).setdefault(label,{'label':label,'value':0,'quantity':0})
        asset['value']+=value;asset['quantity']+=quantity
series=sorted(points.values(),key=lambda r:r['date'])
if not series:raise RuntimeError('No history to summarize; existing cache preserved')
platforms=sorted({name for point in series for name in point['platforms']})
keys={'all':'all',**{name:'s_'+hashlib.sha256(name.encode()).hexdigest()[:12] for name in platforms}}

def downsample(data,maximum=200):
    if len(data)<=maximum:return data
    # Two extrema per bucket preserve peaks/troughs, plus exact endpoints.
    bins=(maximum-2)//2;selected={0,len(data)-1};n=len(data)-2
    for bucket in range(bins):
        start=1+bucket*n//bins;end=1+(bucket+1)*n//bins
        indices=range(start,end)
        selected.add(min(indices,key=lambda i:data[i]['total']))
        selected.add(max(indices,key=lambda i:data[i]['total']))
    return [data[i] for i in sorted(selected)]
def composition(point):return {'platforms':point['platforms'],'assets':point['assets']}
def round_values(point):
    point['total']=round(point['total'],2)
    point['platforms']={k:round(v,2) for k,v in point['platforms'].items()}
    for assets in point['assets'].values():
        for item in assets.values():item['value']=round(item['value'],2)
    return point
series=[round_values(r) for r in series]
datasets={}
for name,scope in keys.items():
    scoped=series if name=='all' else [{'date':r['date'],'total':r['platforms'][name],'platforms':{name:r['platforms'][name]},'assets':{name:r['assets'].get(name,{})}} for r in series if name in r['platforms']]
    first,last=scoped[0],scoped[-1]
    stats={'first_date':first['date'],'last_date':last['date'],'first_total':first['total'],'last_total':last['total'],'week_count':len(scoped),'previous_date':scoped[-2]['date'] if len(scoped)>1 else None,'latest_change':round(last['total']-scoped[-2]['total'],2) if len(scoped)>1 else 0}
    datasets[scope]={}
    for range_name,days in [('3M',92),('6M',183),('1Y',365),('3Y',1096),('ALL',None)]:
        cutoff=(dt.date.fromisoformat(last['date'])-dt.timedelta(days=days)).isoformat() if days else first['date']
        ranged=[r for r in scoped if r['date']>=cutoff]
        sampled=downsample(ranged)
        datasets[scope]['r_'+range_name]={'points':[{'date':r['date'],'total':r['total'],'platforms':r['platforms']} for r in sampled],'start':composition(ranged[0]),'latest':composition(ranged[-1]),'stats':stats}
metadata={'manifest':{'built_at':dt.datetime.now(dt.timezone.utc).isoformat(),'platforms':platforms,'keys':keys,'max_points':200},'datasets':datasets}
existing=request('/rest/v1/assets',{'owner_id':'eq.'+owner,'symbol':'eq._HISTORY_CHART_CACHE','network':'eq.chart-cache:v1','select':'id'})
body={'metadata':metadata}
if existing:request('/rest/v1/assets',{'owner_id':'eq.'+owner,'id':'eq.'+existing[0]['id']},body,'PATCH')
else:request('/rest/v1/assets',body={'owner_id':owner,'symbol':'_HISTORY_CHART_CACHE','name':'Private chart summary cache (no holdings)','asset_class':'alternative','currency':'USD','network':'chart-cache:v1','metadata':metadata},method='POST')
print(json.dumps({'source_rows':len(raw),'weeks':len(series),'platforms':len(platforms),'max_points':max(len(d['points']) for ranges in datasets.values() for d in ranges.values()),'cache_bytes':len(json.dumps(metadata,separators=(',',':')))}))
