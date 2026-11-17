#!/usr/bin/env python3
"""Build a private report bundle for the dashboard. No credentials or network access.
Keep output outside this public checkout. NumPy is needed only for risk scenarios.
"""
import argparse,base64,collections,csv,datetime,json,re
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--output',required=True,type=Path)
p.add_argument('--risk-dir',type=Path);p.add_argument('--holdings-file',type=Path)
p.add_argument('--loss-report',type=Path);p.add_argument('--market-report',type=Path)
p.add_argument('--pdf-file',type=Path);p.add_argument('--title');p.add_argument('--key');p.add_argument('--date')
a=p.parse_args();reports=[]
def pdf(path):
    b=path.read_bytes()
    if len(b)>2000000 or not b.startswith(b'%PDF-'):raise RuntimeError('PDF must be valid and at most 2 MB')
    return base64.b64encode(b).decode()
if a.risk_dir:
    import numpy as np
    if not a.holdings_file:raise RuntimeError('--holdings-file is required with --risk-dir')
    r=json.loads((a.risk_dir/'risk-report.json').read_text());holdings=json.loads(a.holdings_file.read_text())
    with (a.risk_dir/'all-position-risk.csv').open() as f:rows=list(csv.DictReader(f))
    for row in rows:
        for k in ['value_usd','portfolio_weight_pct','annualized_standalone_vol_pct','variance_risk_contribution_pct','one_month_ES95_contribution_usd','one_month_ES95_contribution_pct']:row[k]=float(row[k])
    groups=collections.defaultdict(lambda:[0.,0.])
    for row in r['risk_contributions']:
        s=row['symbol'];name='ETH + wrapped ETH' if s in ['ETH','WETH','EETH'] else 'BTC + wrapped BTC' if s in ['BTC','BBTC','UBTC','WBTC'] else 'GOOGL + calls' if s.startswith('GOOGL') else s
        groups[name][0]+=row['portfolio_weight_pct'];groups[name][1]+=row['one_month_ES95_contribution_pct']
    keys=['created_at_utc','model_marked_value_usd','recorded_supabase_total_usd','annualized_market_vol_pct','paths','history_start','history_end','joint_daily_observations','metrics','stresses','whatifs','limitations']
    analysis={k:r[k] for k in keys};analysis.update({'version':1,'rows':rows,'groups':[{'name':k,'weight':round(v[0],4),'risk':round(v[1],4)} for k,v in sorted(groups.items(),key=lambda x:-x[1][1])],'baseline_positions':[{'id':x['id'],'quantity':float(x['quantity'])} for x in holdings],'histogram':{}})
    for h in ['21','63','252']:
        vals=np.load(a.risk_dir/f'scenarios-{h}d.npz')['portfolio_value'];loss=(r['model_marked_value_usd']-vals)/r['model_marked_value_usd']*100;counts,edges=np.histogram(loss,bins=55)
        analysis['histogram'][h]=[{'loss_pct':round(float((edges[i]+edges[i+1])/2),4),'scenarios_pct':round(float(n)/len(vals)*100,4)} for i,n in enumerate(counts)]
    date=r['created_at_utc'][:10]
    cols=[('symbol','Position','text'),('value_usd','Analysis value','money'),('portfolio_weight_pct','Portfolio weight','percent'),('annualized_standalone_vol_pct','Annual volatility','percent'),('one_month_ES95_contribution_pct','Monthly loss share','percent'),('one_month_ES95_contribution_usd','Monthly loss contribution','money'),('risk_note','Notes','text')]
    reports.append({'version':1,'key':'portfolio-risk-'+date,'title':'Portfolio risk · '+date,'created_at':r['created_at_utc'],'kind':'risk','summary':f'{r["paths"]:,} correlated scenarios, loss thresholds, risk contributions and stress comparisons. Historical model, not guaranteed probabilities.','analysis':analysis,'table':{'columns':[{'key':k,'label':label,'format':fmt} for k,label,fmt in cols],'rows':rows},'pdf_base64':pdf(a.risk_dir/'portfolio-risk-report.pdf')})
if a.loss_report:
    r=json.loads(a.loss_report.read_text());match=re.search(r'(\d{4}-\d{2}-\d{2})',a.loss_report.name);date=a.date[:10] if a.date else match[1] if match else None
    if not date:raise RuntimeError('Loss review needs a dated filename or --date')
    sections=[{'title':'Recorded balance change','text':f'October-end recorded value: ${r["baseline_daily_total"]:,.2f}. Review value: ${r["current_saved_total"]:,.2f}. Recorded decline: ${-r["recorded_decline"]:,.2f} ({-r["recorded_decline_pct"]:.2f}%). This is not a cash-flow-adjusted investment return.'},{'title':'Accounting corrections','text':f'rUSDC prior recorded value removed: ${r["rusdc_prior_value_removed"]:,.2f}, following the owner-reported hack loss. Stale Wio cash removed: ${r["wio_stale_cash_removed"]:,.2f}. These should not be treated as ordinary market-price losses.'},{'title':'Scope and limits','text':r['note']+' The table is an approximate price-only attribution on continuing positions, not exact realised trading performance.'}]
    reports.append({'version':1,'key':'november-loss-review-'+date,'title':'November loss review · '+date,'created_at':date+'T14:42:41Z','kind':'review','summary':'Market losses versus balance corrections and stale marks. Dated review; not current portfolio performance.','sections':sections,'table':{'columns':[{'key':'symbol','label':'Position','format':'text'},{'key':'price_effect_usd','label':'Approximate price effect','format':'money'}],'rows':[{'symbol':s,'price_effect_usd':v} for s,v in sorted(r['price_effect_by_symbol'].items(),key=lambda x:x[1])]}})
if a.market_report:
    r=json.loads(a.market_report.read_text());rows=[{'symbol':x['symbol'],'price_usd':x.get('price_usd'),'model_chance_up_pct':x.get('model_chance_up_pct'),'quote_time_utc':x.get('quote_time_utc'),'daily_returns':x.get('daily_returns')} for x in r['rows']]
    reports.append({'version':1,'key':'stock-market-review-'+r['retrieved_at_utc'][:10],'title':'Stock market review · '+r['retrieved_at_utc'][:10],'created_at':r['retrieved_at_utc'],'kind':'table','summary':'Archived prices and one-month historical-model outputs. These unvalidated directional estimates are not risk scores or current forecasts.','sections':[{'title':'Method and caution','text':r['method']+' Prices and outputs belong to the original report date and are not updated when the live dashboard refreshes.'}],'table':{'columns':[{'key':'symbol','label':'Position','format':'text'},{'key':'price_usd','label':'Archived USD price','format':'money'},{'key':'model_chance_up_pct','label':'Historical model output','format':'percent'},{'key':'quote_time_utc','label':'Quote time UTC','format':'text'},{'key':'daily_returns','label':'Observations','format':'number'}],'rows':rows}})
if a.pdf_file:
    if not all([a.title,a.key,a.date]):raise RuntimeError('PDF upload requires --title, --key and --date')
    reports.append({'version':1,'key':a.key,'title':a.title,'created_at':a.date,'kind':'pdf','summary':'Saved document report','pdf_base64':pdf(a.pdf_file)})
if not reports:raise RuntimeError('Choose at least one report input')
output=a.output.resolve();checkout=Path(__file__).resolve().parents[1]
if output.is_relative_to(checkout) and not output.is_relative_to(checkout/'reports') and not output.is_relative_to(checkout/'imports'):raise RuntimeError('Keep private report bundles in ignored reports/imports or outside the public checkout')
output.parent.mkdir(parents=True,exist_ok=True);output.touch(mode=0o600);output.write_text(json.dumps({'version':1,'reports':reports},allow_nan=False));output.chmod(0o600)
print(json.dumps({'reports':len(reports),'bytes':output.stat().st_size,'file':str(output)}))
