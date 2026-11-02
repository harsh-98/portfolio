#!/usr/bin/env python3
"""Reconstruct Plasma holdings discovered in a private Rabby history export.

No signing or transactions. USD marks use same-date Binance candle opens and
Historical global USDT/USD as a proxy for bridged USDT0. Receipt rates come from the
historical contract, never today's receipt-token price.
"""
import argparse, collections, datetime as dt, hashlib, json, os, re, statistics, time
import urllib.error, urllib.parse, urllib.request
from decimal import Decimal
from pathlib import Path
import subprocess, sys

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--key-file', default=os.environ.get('PORTFOLIO_SERVER_KEY_FILE'))
p.add_argument('--rabby-history', required=True)
p.add_argument('--wallet-prefix', required=True)
p.add_argument('--from', dest='start', default='2025-09-25')
p.add_argument('--to', default=(dt.date.today()-dt.timedelta(days=1)).isoformat())
p.add_argument('--monthly', action='store_true')
p.add_argument('--write', action='store_true')
p.add_argument('--report', required=True)
a = p.parse_args()
if not a.key_file: p.error('Missing --key-file or PORTFOLIO_SERVER_KEY_FILE')
config = {}
for raw in Path(a.key_file).read_text().splitlines():
    key, sep, value = raw.strip().removeprefix('export ').partition('=')
    if sep and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key.strip()):
        config[key.strip()] = value.strip().strip('\"\'')
def required(name):
    value = os.environ.get(name) or config.get(name)
    if not value: raise RuntimeError('Missing configuration: '+name)
    return value
wallets = [v.strip().lower() for v in required('PORTFOLIO_EVM_ADDRESSES').split(',') if v.strip().lower().startswith(a.wallet_prefix.lower())]
if len(wallets) != 1: p.error('Prefix must match exactly one configured wallet')
wallet = wallets[0]
wallet_hash = hashlib.sha256(wallet.encode()).hexdigest()[:12]

def request(url, headers=None, body=None, method=None):
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers=headers or {}, data=None if body is None else json.dumps(body).encode(), method=method)
            with urllib.request.urlopen(req, timeout=45) as response:
                return json.load(response) if response.status != 204 else None
        except urllib.error.HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 4:
                raise RuntimeError('Remote request failed: HTTP '+str(error.code)) from None
        except (TimeoutError, urllib.error.URLError):
            if attempt == 4: raise RuntimeError('Remote request timed out or unavailable') from None
        time.sleep(2 ** (attempt+1))
db_url = required('SUPABASE_URL').rstrip('/')
db_headers = {'apikey': required('SUPABASE_SECRET_KEY'), 'Authorization': 'Bearer '+required('SUPABASE_SECRET_KEY'), 'Content-Type':'application/json', 'Prefer':'resolution=merge-duplicates,return=representation'}
owner = config.get('PORTFOLIO_OWNER_ID','')
if not re.fullmatch(r'[0-9a-fA-F-]{36}', owner):
    users = request(db_url+'/auth/v1/admin/users?page=1&per_page=100', db_headers)['users']
    owner = next((u['id'] for u in users if u.get('email','').lower() == required('PORTFOLIO_OWNER_EMAIL').lower()), None)
    if not owner: raise RuntimeError('Configured owner not found')
def db(table, params=None, body=None, method=None):
    return request(db_url+'/rest/v1/'+table+'?'+urllib.parse.urlencode(params or {}), db_headers, body, method)
def rows(table, select, params=None):
    result=[]
    while True:
        page=db(table, {'owner_id':'eq.'+owner,'select':select,'offset':len(result),'limit':1000,**(params or {})})
        result+=page
        if len(page)<1000:return result

rpc_url = 'https://rpc.plasma.to'
def rpc(method, params):
    time.sleep(.10)
    result=request(rpc_url, {'Content-Type':'application/json'}, {'jsonrpc':'2.0','id':1,'method':method,'params':params})
    if 'result' not in result: raise RuntimeError('Plasma archive RPC rejected '+method)
    return result['result']
if int(rpc('eth_chainId', []),16) != 9745: raise RuntimeError('Unexpected RPC chain')
blocks={}
def block(number):
    if number not in blocks:
        raw=rpc('eth_getBlockByNumber',[hex(number),False])
        blocks[number]=(number,int(raw['timestamp'],16))
    return blocks[number]
head=block(int(rpc('eth_blockNumber',[]),16))
first=block(1)  # Genesis block zero has a placeholder timestamp.
def before(timestamp):
    low,high=first,head
    if timestamp<low[1]:return None
    if timestamp>=high[1]:raise RuntimeError('Snapshot is newer than chain head')
    while high[0]-low[0]>1:
        guess=low[0]+(timestamp-low[1])*(high[0]-low[0])//max(1,high[1]-low[1])
        middle=block(max(low[0]+1,min(high[0]-1,guess)))
        if middle[1]<=timestamp:low=middle
        else:high=middle
    return low

data=json.loads(Path(a.rabby_history).read_text())
if any(e.get('tx',{}).get('from_addr','').lower() == wallet for e in data['history_list'] if e.get('tx')) is False:
    raise RuntimeError('Rabby history does not belong to the configured wallet')
ids={t['token_id'] for e in data['history_list'] if not e.get('is_scam') for kind in ('sends','receives') for t in e.get(kind,[])}
tokens=[]
for token_id in ids:
    t=data['token_dict'].get(token_id,{})
    if t.get('chain')!='plasma' or not t.get('is_verified') or t.get('is_suspicious'):continue
    if token_id!='plasma' and not re.fullmatch(r'0x[0-9a-fA-F]{40}',token_id):raise RuntimeError('Invalid token contract')
    tokens.append(t)
if not tokens:raise RuntimeError('No verified Rabby tokens found')
start,end=dt.date.fromisoformat(a.start),dt.date.fromisoformat(a.to)
cursor=start+dt.timedelta(days=(1-start.weekday())%7)
dates=[]
while cursor<=end:
    dates.append(cursor);cursor+=dt.timedelta(days=7)
if a.monthly:
    months={d.strftime('%Y-%m'):d for d in dates};dates=list(months.values())
if not dates:raise RuntimeError('No historical Tuesday snapshots in range')

# USD proxy marks must have a historical timestamp close to the snapshot.
def historical_usd(coin, timestamp):
    mark=request('https://coins.llama.fi/prices/historical/'+str(timestamp)+'/'+coin).get('coins',{}).get(coin)
    if not mark or abs(mark.get('timestamp',0)-timestamp)>86400 or mark.get('confidence',0)<.99:
        raise RuntimeError('No reliable historical USD mark for '+coin)
    return Decimal(str(mark['price']))
market={}
for pair in ('ETHUSDT','XPLUSDT'):
    candles=request('https://api.binance.com/api/v3/klines?'+urllib.parse.urlencode({'symbol':pair,'interval':'1d','startTime':int(dt.datetime.combine(dates[0],dt.time(),dt.timezone.utc).timestamp()*1000),'endTime':int(dt.datetime.combine(dates[-1]+dt.timedelta(days=1),dt.time(),dt.timezone.utc).timestamp()*1000)-1,'limit':1000}))
    if not isinstance(candles,list):raise RuntimeError('Historical candle source unavailable')
    market[pair]={dt.datetime.fromtimestamp(r[0]/1000,dt.timezone.utc).date().isoformat():Decimal(r[1]) for r in candles}
account_id=None
assets={}
def account():
    global account_id
    if account_id:return account_id
    name='Wallet · '+wallet+' · Plasma'
    found=db('accounts',{'owner_id':'eq.'+owner,'name':'eq.'+name,'institution':'eq.Plasma Archive RPC','select':'id'})
    account_id=found[0]['id'] if found else db('accounts',body={'owner_id':owner,'name':name,'institution':'Plasma Archive RPC','account_type':'wallet','currency':'USD','source':'plasma-rpc-backfill'},method='POST')[0]['id']
    return account_id
def asset(t):
    key=t['id']
    if key in assets:return assets[key]
    symbol=t['symbol'].upper().replace(' ','-')[:32]
    contract=None if key=='plasma' else key.lower()
    found=db('assets',{'owner_id':'eq.'+owner,'symbol':'eq.'+symbol,'network':'eq.Plasma','select':'id,contract_address'})
    found=next((r for r in found if r['contract_address']==contract),None)
    asset_id=found['id'] if found else db('assets',body={'owner_id':owner,'symbol':symbol,'name':t.get('name') or symbol,'asset_class':'stablecoin' if 'USDT' in symbol else 'crypto','currency':'USD','network':'Plasma','contract_address':contract,'metadata':{'provider':'Rabby-discovered archive reconstruction','chain_id':9745}},method='POST')[0]['id']
    assets[key]=asset_id
    return asset_id
report=[]
for date in dates:
    date=date.isoformat();timestamp=int(dt.datetime.fromisoformat(date).replace(tzinfo=dt.timezone.utc).timestamp());point=before(timestamp)
    if point is None:continue
    usd=historical_usd('coingecko:tether',timestamp);entries=[];writes=[]
    for t in tokens:
        token=t['id'];tag=hex(point[0]);decimals=int(t['decimals'])
        raw=rpc('eth_getBalance',[wallet,tag]) if token=='plasma' else rpc('eth_call',[{'to':token,'data':'0x70a08231'+wallet[2:].rjust(64,'0')},tag])
        balance=int(raw,16) if raw!='0x' else 0
        quantity=Decimal(balance)/(10**decimals)
        underlying=token;amount=quantity
        receipt=t.get('protocol_id') in ('plasma_fluid','plasma_gearbox')
        if balance and receipt:
            underlying='0x'+rpc('eth_call',[{'to':token,'data':'0x38d52e0f'},tag])[-40:]
            d=rpc('eth_call',[{'to':underlying,'data':'0x313ce567'},tag]);underlying_decimals=int(d,16)
            redeem=rpc('eth_call',[{'to':token,'data':'0x07a2d13a'+hex(balance)[2:].rjust(64,'0')},tag])
            amount=Decimal(int(redeem,16))/(10**underlying_decimals)
        value=Decimal(0)
        if balance:
            if underlying.lower()=='0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb':value=amount*usd
            elif underlying.lower()=='0x9895d81bb462a195b4922ed7de0e3acd007c32cb':value=amount*market['ETHUSDT'][date]*usd
            elif underlying.lower() in ('plasma','0x6100e367285b01f48d07953803a2d8dca5d19873'):value=amount*market['XPLUSDT'][date]*usd
            elif t['symbol'].upper()=='FLUID':
                value=amount*historical_usd('coingecko:instadapp',timestamp)
            else:raise RuntimeError('Unpriced Rabby asset: '+t['symbol'])
        metadata={'snapshot_kind':'reconstructed','provider':'Rabby-discovered Plasma archive','history_complete':True,'history_authority':'archive-rpc','wallet_hash':wallet_hash,'chain_id':9745,'block_number':point[0],'block_timestamp':point[1],'discovery_source':'Rabby verified historical transactions','price_source':'Binance UTC daily open; historical DefiLlama global USDT/USD proxy for Plasma USDT0 and USD for FLUID','underlying_contract':underlying,'redeemable_underlying':str(amount),'protocol_name':t.get('protocol_id') or None,'coverage_scope':'Verified tokens and receipts in the supplied Rabby history'}
        if balance:entries.append({'symbol':t['symbol'],'quantity':str(quantity),'redeemable_underlying':str(amount),'value_usd':float(value.quantize(Decimal('.01')))})
        if a.write:
            writes.append({'owner_id':owner,'snapshot_date':date,'source_key':'rpc-history:'+wallet_hash+':9745:'+hashlib.sha256(token.encode()).hexdigest()[:12],'account_id':account(),'asset_id':asset(t),'quantity':str(quantity),'price_usd':str((value/quantity if quantity else Decimal(0)).quantize(Decimal('.00000001'))),'value_usd':str(value.quantize(Decimal('.01'))),'metadata':metadata})
    entry={'date':date,'block':point[0],'missing_plasma_value_usd':round(sum(r['value_usd'] for r in entries),2),'positions':entries};report.append(entry)
    if a.write:
        # All verified token rows, including explicit zero balances, publish atomically.
        db('position_snapshots',{'on_conflict':'owner_id,snapshot_date,source_key'},writes,'POST')
        db('crypto_backfill_checkpoints',{'on_conflict':'owner_id,wallet_hash,chain_name,snapshot_date'},{'owner_id':owner,'wallet_hash':wallet_hash,'chain_name':'plasma-rpc-v1','snapshot_date':date,'status':'success','records_written':len(writes),'message':'Rabby-discovered tokens; historical archive balances and vault conversion','completed_at':dt.datetime.now(dt.timezone.utc).isoformat()},'POST')
    print(json.dumps({'date':date,'mode':'write' if a.write else 'read-only','plasma_value_usd':entry['missing_plasma_value_usd'],'nonzero_positions':len(entries)}),flush=True)
    fd=os.open(a.report,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w') as f:json.dump(report,f,indent=2)

if a.write:
    subprocess.run([sys.executable, str(Path(__file__).with_name("build-history-charts.py")), "--key-file", a.key_file], check=True)
