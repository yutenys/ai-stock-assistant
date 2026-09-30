// Read-only API coverage audit. No favorites, positions or live profile writes.
const fs = require('node:fs');
const path = require('node:path');
const {api, live} = require('./market-diagnostics.cjs');
const stocks = [
  {code:'603567',name:'珍宝岛'}, {code:'603186',name:'华正新材'},
  {code:'002708',name:'光洋股份'}, {code:'601872',name:'招商轮船'},
  {code:'688981',name:'中芯国际'}, {code:'920970',name:'大禹生物'}
];
async function main() {
  const startedAt = new Date().toISOString();
  const results = await api.settleWithConcurrency(stocks,2,async stock=>{
    const calls = {
      quotes:()=>live.fetchTencentQuotes([stock.code]),
      funds:()=>live.fetchStockFundFlow({...stock,force:true}),
      dailyFunds:()=>live.fetchDailyFundFlowHistory(stock.code,10,true),
      profile:()=>live.fetchCompanyProfile({...stock,force:true}),
      financial:()=>live.fetchStockFinancials({...stock,force:true}),
      risks:()=>live.fetchFutureRiskProfile({...stock,force:true}),
      news:()=>live.fetchStockNews({...stock,force:true})
    };
    const checks = {};
    for (const [key,call] of Object.entries(calls)) {
      try {
        const value = await call();
        let missing = [];
        if (key === 'quotes') missing = ['price','changePct','totalMarketCap','floatMarketCap','amount'].filter(field=>api.finiteNumber(value[0]?.[field]) === null);
        if (key === 'funds') missing = ['mainInflow','mainOutflow','mainNetInflow','mainNetPct'].filter(field=>api.finiteNumber(value[field]) === null);
        if (key === 'dailyFunds' && !value.complete) missing = [`dailyRows:${value.days}/10`];
        if (key === 'profile') missing = value.missingFields || [];
        if (key === 'financial' && value.analysis?.available < 3) missing = ['financialFactors'];
        if (key === 'risks' && value.status === 'unknown') missing = ['unverifiedRisks'];
        if (key === 'news' && !value.news?.length) missing = ['news'];
        if (value.stale || value.estimated) missing.push(value.stale ? 'stale' : 'estimated');
        checks[key] = {status:missing.length ? 'partial' : 'ok',missing,value};
      } catch (error) { checks[key] = {status:'failed',error:error.message}; }
    }
    console.log(JSON.stringify({code:stock.code,checks:Object.fromEntries(Object.entries(checks).map(([key,row])=>[key,{status:row.status,missing:row.missing,error:row.error}]))}));
    return {stock,checks};
  });
  const charts = {};
  for (const period of ['minute','five-day','day','week','month']) {
    try {const value=await live.fetchStockChart({code:'603567',period,force:true}); charts[period]={status:value.stale?'partial':'ok',count:value.rows.length,source:value.source};}
    catch (error) {charts[period]={status:'failed',error:error.message};}
  }
  const market = {};
  for (const [key,call] of Object.entries({overseas:()=>live.fetchGlobalMarketContext(),news:()=>live.fetchMarketNews(true),capital:()=>live.fetchSectorCapitalFlow(true)})) {
    try {
      const value = await call();
      const usable = key === 'overseas' ? value.available && value.indices?.length >= 3 : key === 'news' ? value.news?.length > 0 : value.rows?.length > 0;
      market[key] = {status:usable && !value.stale ? 'ok' : 'partial',value};
    } catch(error) {market[key]={status:'failed',error:error.message};}
  }
  const report = {startedAt,finishedAt:new Date().toISOString(),stocks:results.map(row=>row.status==='fulfilled'?row.value:{error:String(row.reason)}),charts,market};
  const filename = path.resolve(__dirname,'../cache/live-data-audit.json');
  fs.writeFileSync(filename,JSON.stringify(report,null,2));
  console.log(JSON.stringify({filename,charts,market:Object.fromEntries(Object.entries(market).map(([key,row])=>[key,{status:row.status,error:row.error,source:row.value?.source,stale:row.value?.stale}]))}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
