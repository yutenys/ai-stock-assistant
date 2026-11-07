// Offline analysis: current financial/news data is never used to label past decisions.
const fs=require('node:fs');
const path=require('node:path');
const {api}=require('./market-diagnostics.cjs');
const root=path.resolve(__dirname,'../cache/full-market-research');
const progress=JSON.parse(fs.readFileSync(path.join(root,'progress.json'),'utf8'));
const snapshot=JSON.parse(fs.readFileSync(path.join(root,'snapshot.json'),'utf8'));
const universe=new Set(snapshot.quotes.map(row=>row.code));
const files=fs.readdirSync(root).filter(name=>/^\d{6}\.json$/.test(name) && universe.has(name.slice(0,6)));
const directory=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../cache/stock-directory.json'),'utf8')).data;
const byCode=new Map(directory.map(row=>[row.code,row]));
const coverage={collected:0,history:0,long250:0,financial:0,funds:0,newsMatched:0,shortOutflowDespiteLongInflow:0,missingPE:0};
const sectors=new Map(), leaders=[], rows=[], retrospective=[], candidates=[];
for(const file of files){
  const record=JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
  if(record.tradeDate!==progress.tradeDate || !record.complete) continue;
  coverage.collected++;
  const stock=record.stock;
  const history=record.history?.ok?record.history.value.rows:[];
  const analysis=history.length>=20?api.analyzeHistory(history):null;
  const industry=api.resolveRecommendationIndustry(stock,byCode);
  const funds=record.funds?.ok?record.funds.value:null;
  const windows=api.analyzeCapitalWindows(funds,analysis?.tradeDate);
  const financial=record.financial?.ok?record.financial.value.analysis:null;
  const news=record.news?.ok?api.summarizeNews(record.news.value.news,'',{...record.news.value,subject:stock.name,code:stock.code}):null;
  if(analysis)coverage.history++;
  if(analysis?.pathMetrics.returns[250]!==null && analysis?.pathMetrics.available)coverage.long250++;
  if(financial?.available>0)coverage.financial++;
  if(funds?.available)coverage.funds++;
  if(news?.available)coverage.newsMatched++;
  if(windows.weakening && funds?.mainNetInflow>0)coverage.shortOutflowDespiteLongInflow++;
  if(stock.peRatio==null)coverage.missingPE++;
  const item={code:stock.code,name:stock.name,industry,changePct:stock.changePct,path:analysis?.pathMetrics,
    setup:analysis?.entryAssessment,financialScore:financial?.score??null,financialReport:financial?.latestReport,
    capitalWindows:windows,newsSignal:news?.signal,newsAvailable:news?.available??false};
  rows.push(item);
  if(stock.amount>0 && item.path?.returns[60]!==null && item.path?.available)leaders.push(item);
  if(stock.amount>=3e7 && !/ST|退/.test(stock.name) && analysis && analysis.score>=65 && (analysis.accumulationSetup?.passed || analysis.consolidationBreakout?.isConsolidating || analysis.reboundSignal)
    && !windows.weakening && !(financial?.hardRisks?.length>=2 && financial.score<45)) candidates.push({code:stock.code,score:analysis.score});
  if(!sectors.has(industry))sectors.set(industry,{industry,count:0,up:0,changeSum:0,flowCovered:0,flowNet:0,positiveFlow:0,weakening:0});
  const sector=sectors.get(industry);sector.count++;sector.up+=stock.changePct>0?1:0;sector.changeSum+=Number(stock.changePct)||0;
  if(funds?.available && !funds.estimated && funds.endDate===record.tradeDate){sector.flowCovered++;sector.flowNet+=funds.mainNetInflow;sector.positiveFlow+=funds.mainNetInflow>0?1:0;sector.weakening+=windows.weakening?1:0;}
  // Fixed common observation date. Missing exact trading dates are excluded, not shifted.
  const cutoff='2026-08-07';
  const index=history.findIndex(row=>row.date===cutoff);
  if(index>=120 && history.at(-1).date===record.tradeDate){
    const atEntry=api.analyzeHistory(history.slice(0,index+1));
    retrospective.push({code:stock.code,entryDate:cutoff,exitDate:record.tradeDate,
      returnPct:(history.at(-1).close/history[index].close-1)*100,
      washout:atEntry.entryAssessment.setupType==='sideways-washout',lowBuy:atEntry.entryAssessment.lowBuyCandidate===true});
  }
}
const stats=values=>({count:values.length,meanReturn:values.length?values.reduce((sum,v)=>sum+v.returnPct,0)/values.length:null,upRatio:values.length?values.filter(v=>v.returnPct>0).length/values.length:null});
const report={asOf:new Date().toISOString(),coverage,
  sectorFunds:[...sectors.values()].map(s=>({...s,upRatio:s.up/s.count,averageChange:s.changeSum/s.count,flowCoverage:s.flowCovered/s.count,scope:'covered member stocks, 10-day sum; not official board capital'})).sort((a,b)=>b.flowNet-a.flowNet),
  leaders60:leaders.sort((a,b)=>b.path.returns[60]-a.path.returns[60]).slice(0,20),
  retrospective:{scope:'price-only fixed-date diagnostic; survivor bias, no historical financial/news or transaction costs',all:stats(retrospective),washout:stats(retrospective.filter(v=>v.washout)),lowBuy:stats(retrospective.filter(v=>v.lowBuy))}};
fs.writeFileSync(path.join(root,'analysis.json'),JSON.stringify(report,null,2));
fs.writeFileSync(path.join(root,'features.json'),JSON.stringify(rows));
if(progress.complete===progress.coverage.total && coverage.collected===progress.coverage.total){
  const data={complete:true,tradeDate:progress.tradeDate,generatedAt:new Date().toISOString(),modelVersion:api.RECOMMENDATION_MODEL_VERSION,
    universe:files.length,historyCovered:coverage.history,codes:candidates.sort((a,b)=>b.score-a.score).map(row=>row.code)};
  fs.writeFileSync(path.resolve(root,'../full-market-screening.json'),JSON.stringify({savedAt:Date.now(),data}));
}
console.log(JSON.stringify({coverage,retrospective:report.retrospective,sectorFunds:report.sectorFunds.slice(0,6)},null,2));
