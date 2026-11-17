#!/usr/bin/env python3
"""Publish a completed private risk analysis using the existing authenticated asset policies.
Requires NumPy. This publisher does not run simulations or alter holdings/history.
"""
import argparse,collections,csv,datetime,json,math,os,re,urllib.request,urllib.parse,urllib.error
from pathlib import Path
import numpy as np
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--report-dir',required=True,type=Path)
p.add_argument('--holdings-file',required=True,type=Path)
a=p.parse_args()
def required(k):
    v=os.environ.get(k)
    if not v:raise RuntimeError('Missing approved process environment: '+k+'. Credential files are not read; use the Reports page uploader or an approved environment connection.')
    return v
base=required('SUPABASE_URL').rstrip('/')
headers={'apikey':required('SUPABASE_SECRET_KEY'),'Authorization':'Bearer '+required('SUPABASE_SECRET_KEY'),'Content-Type':'application/json','Prefer':'return=representation'}
def request(path,params=None,body=None,method='GET'):
    url=base+path+('?' + urllib.parse.urlencode(params) if params else '')
    try:
        req=urllib.request.Request(url,headers=headers,method=method,data=None if body is None else json.dumps(body,allow_nan=False).encode())
        with urllib.request.urlopen(req,timeout=45) as response:return json.load(response)
    except urllib.error.HTTPError as e:raise RuntimeError('Supabase request failed: HTTP '+str(e.code)) from None
owner=os.environ.get('PORTFOLIO_OWNER_ID','')
if not re.fullmatch(r'[0-9a-fA-F-]{36}',owner):
    users=request('/auth/v1/admin/users',{'page':1,'per_page':100})['users']
    owner=next((u['id'] for u in users if u.get('email','').lower()==required('PORTFOLIO_OWNER_EMAIL').lower()),None)
    if not owner:raise RuntimeError('Configured portfolio owner not found')
r=json.loads((a.report_dir/'risk-report.json').read_text());baseline=json.loads(a.holdings_file.read_text())
bq={x['id']:float(x['quantity']) for x in baseline}
def quantities_match(rows):return len(rows)==len(bq) and all(x['id'] in bq and math.isclose(float(x['quantity']),bq[x['id']],rel_tol=1e-9,abs_tol=1e-8) for x in rows)
current=request('/rest/v1/positions',{'owner_id':'eq.'+owner,'select':'id,quantity','limit':1000})
if not quantities_match(current):raise RuntimeError('Holdings changed since simulation. Recalculate before publishing.')
with (a.report_dir/'all-position-risk.csv').open() as f:rows=list(csv.DictReader(f))
for row in rows:
    for k in ['value_usd','portfolio_weight_pct','annualized_standalone_vol_pct','variance_risk_contribution_pct','one_month_ES95_contribution_usd','one_month_ES95_contribution_pct']:row[k]=float(row[k])
groups=collections.defaultdict(lambda:[0.,0.])
for row in r['risk_contributions']:
    s=row['symbol'];name='ETH + wrapped ETH' if s in ['ETH','WETH','EETH'] else 'BTC + wrapped BTC' if s in ['BTC','BBTC','UBTC','WBTC'] else 'GOOGL + calls' if s.startswith('GOOGL') else s
    groups[name][0]+=row['portfolio_weight_pct'];groups[name][1]+=row['one_month_ES95_contribution_pct']
keys=['created_at_utc','model_marked_value_usd','recorded_supabase_total_usd','annualized_market_vol_pct','paths','history_start','history_end','joint_daily_observations','metrics','stresses','whatifs','limitations']
analysis={k:r[k] for k in keys}
analysis.update({'version':1,'rows':rows,'groups':[{'name':k,'weight':round(v[0],4),'risk':round(v[1],4)} for k,v in sorted(groups.items(),key=lambda x:-x[1][1])],'baseline_positions':[{'id':k,'quantity':v} for k,v in bq.items()],'histogram':{}})
for h in ['21','63','252']:
    vals=np.load(a.report_dir/f'scenarios-{h}d.npz')['portfolio_value'];loss=(r['model_marked_value_usd']-vals)/r['model_marked_value_usd']*100;counts,edges=np.histogram(loss,bins=55)
    analysis['histogram'][h]=[{'loss_pct':round(float((edges[i]+edges[i+1])/2),4),'scenarios_pct':round(float(n)/len(vals)*100,4)} for i,n in enumerate(counts)]
metadata={'analysis':analysis,'published_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat()};size=len(json.dumps(metadata,allow_nan=False).encode())
if size>250000:raise RuntimeError('Analysis cache exceeds size limit')
params={'owner_id':'eq.'+owner,'symbol':'eq._RISK_ANALYSIS_CACHE','network':'eq.risk-analysis:v1','select':'id,updated_at'};existing=request('/rest/v1/assets',params)
if len(existing)>1:raise RuntimeError('Ambiguous risk cache')
if existing:
    e=existing[0];saved=request('/rest/v1/assets',{'id':'eq.'+e['id'],'owner_id':'eq.'+owner,'updated_at':'eq.'+e['updated_at']},{'metadata':metadata},'PATCH')
else:saved=request('/rest/v1/assets',None,{'owner_id':owner,'symbol':'_RISK_ANALYSIS_CACHE','name':'Private portfolio risk analysis','asset_class':'alternative','currency':'USD','network':'risk-analysis:v1','metadata':metadata},'POST')
if len(saved)!=1:raise RuntimeError('Cache changed concurrently; publish again')
check=request('/rest/v1/assets',{'id':'eq.'+saved[0]['id'],'owner_id':'eq.'+owner,'select':'metadata'})
if check[0]['metadata']!=metadata:raise RuntimeError('Saved analysis differs on read-back')
if not quantities_match(request('/rest/v1/positions',{'owner_id':'eq.'+owner,'select':'id,quantity','limit':1000})):raise RuntimeError('Holdings changed while publishing; saved analysis is stale')
print(json.dumps({'published':True,'analysis_date':analysis['created_at_utc'][:10],'positions':len(current),'symbols':len(rows),'payload_bytes':size,'financial_positions_added':0,'quantity_changes':0}))
