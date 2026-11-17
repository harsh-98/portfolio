#!/usr/bin/env python3
"""Upload approved report bundles using credentials already in the process environment.
Never opens credential/config/authentication files. Alternative: import through the signed-in Reports page.
"""
import argparse,datetime,json,os,re,urllib.request,urllib.parse,urllib.error
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--bundle',required=True,type=Path);a=p.parse_args()
def required(k):
    v=os.environ.get(k)
    if not v:raise RuntimeError('Missing approved process environment: '+k+'. Do not paste credentials into chat; use a configured environment or the signed-in website uploader.')
    return v
base=required('SUPABASE_URL').rstrip('/');secret=required('SUPABASE_SECRET_KEY')
headers={'apikey':secret,'Authorization':'Bearer '+secret,'Content-Type':'application/json','Prefer':'return=representation'}
def request(path,params=None,body=None,method='GET'):
    url=base+path+('?' + urllib.parse.urlencode(params) if params else '')
    try:
        with urllib.request.urlopen(urllib.request.Request(url,headers=headers,method=method,data=None if body is None else json.dumps(body,allow_nan=False).encode()),timeout=45) as r:return json.load(r)
    except urllib.error.HTTPError as e:raise RuntimeError('Upload request failed: HTTP '+str(e.code)) from None
owner=os.environ.get('PORTFOLIO_OWNER_ID','')
if not re.fullmatch(r'[0-9a-fA-F-]{36}',owner):
    users=request('/auth/v1/admin/users',{'page':1,'per_page':100})['users'];owner=next((x['id'] for x in users if x.get('email','').lower()==required('PORTFOLIO_OWNER_EMAIL').lower()),None)
    if not owner:raise RuntimeError('Portfolio owner not found')
bundle=json.loads(a.bundle.read_text())
if bundle.get('version')!=1 or not 0<len(bundle.get('reports',[]))<=50:raise RuntimeError('Unsupported bundle')
def save(symbol,network,name,metadata):
    existing=request('/rest/v1/assets',{'owner_id':'eq.'+owner,'symbol':'eq.'+symbol,'network':'eq.'+network,'select':'id,updated_at'})
    if len(existing)>1:raise RuntimeError('Ambiguous report identity')
    if existing:
        x=existing[0];saved=request('/rest/v1/assets',{'id':'eq.'+x['id'],'owner_id':'eq.'+owner,'updated_at':'eq.'+x['updated_at']},{'metadata':metadata},'PATCH')
    else:saved=request('/rest/v1/assets',None,{'owner_id':owner,'symbol':symbol,'network':network,'name':name,'asset_class':'alternative','currency':'USD','metadata':metadata},'POST')
    if len(saved)!=1:raise RuntimeError('Concurrent report edit; retry')
    check=request('/rest/v1/assets',{'id':'eq.'+saved[0]['id'],'owner_id':'eq.'+owner,'select':'metadata'})
    if check[0]['metadata']!=metadata:raise RuntimeError('Report read-back mismatch')
for report in bundle['reports']:
    if not re.fullmatch(r'[a-z0-9-]{1,90}',report['key']) or report['version']!=1:raise RuntimeError('Invalid report identity')
    manifest={k:report[k] for k in ['key','title','created_at','kind','summary']};manifest.update({'has_pdf':bool(report.get('pdf_base64')),'row_count':len(report.get('table',{}).get('rows',[]))})
    if report['kind']=='risk':
        r=report['analysis'];manifest['risk_summary']={'value':r['model_marked_value_usd'],'volatility':r['annualized_market_vol_pct'],'monthly_var95':r['metrics']['21']['loss_95_usd'],'monthly_es95':r['metrics']['21']['expected_shortfall_95_usd']}
    save('_PORTFOLIO_REPORT','report:'+report['key'],report['title'],{'report_manifest':manifest,'report':report})
    if report['kind']=='risk':
        cached=request('/rest/v1/assets',{'owner_id':'eq.'+owner,'symbol':'eq._RISK_ANALYSIS_CACHE','network':'eq.risk-analysis:v1','select':'metadata'})
        previous=cached[0]['metadata'].get('analysis',{}).get('created_at_utc','') if cached else ''
        if previous<=report['analysis']['created_at_utc']:save('_RISK_ANALYSIS_CACHE','risk-analysis:v1','Private portfolio risk analysis',{'analysis':report['analysis'],'published_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat()})
print(json.dumps({'published_reports':len(bundle['reports']),'financial_positions_modified':0}))
