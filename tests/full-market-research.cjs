// Resumable full-universe collection. Evidence is ignored by Git; no favorite data is changed.
const fs=require('node:fs');
const path=require('node:path');
const {api,live}=require('./market-diagnostics.cjs');
const root=path.resolve(__dirname,'../cache/full-market-research');
fs.mkdirSync(root,{recursive:true});
const write=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value));
const read=name=>{try{return JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));}catch{return null;}};
const retryFailed=process.argv.includes('--retry-failed');
const capture=async task=>{try{return {ok:true,fetchedAt:new Date().toISOString(),value:await task()};}catch(error){return {ok:false,fetchedAt:new Date().toISOString(),error:String(error.message||error)};}};
async function run(){
  const snapshot=await live.fetchTencentMarketSnapshot();
  const tradeDate=snapshot.quotes.map(row=>row.tradeDate).filter(Boolean).sort().at(-1);
  if(!tradeDate) throw new Error('No trade date in market snapshot');
  write('snapshot.json',{fetchedAt:new Date().toISOString(),...snapshot});
  const [capital,news,rotation]=await Promise.all([
    capture(()=>live.fetchSectorCapitalFlow(true)),capture(()=>live.fetchMarketNews(true)),capture(()=>live.fetchTencentMarketSectors(snapshot.quotes))
  ]);
  write('market-context.json',{tradeDate,capital,news,rotation});
  let complete=0, resumed=0;
  const coverage={total:snapshot.quotes.length,history:0,financial:0,funds:0,news:0,newsWithItems:0};
  const progress=()=>{
    const status={tradeDate,complete,resumed,coverage,updatedAt:new Date().toISOString(),root};
    write('progress.json',status);console.log(JSON.stringify(status));
  };
  progress();
  const results=await api.settleWithConcurrency(snapshot.quotes,8,async stock=>{
    const filename=`${stock.code}.json`;
    let item=read(filename);
    if(item?.tradeDate===tradeDate && item.complete && (!retryFailed || ['history','financial','funds','news'].every(key=>item[key]?.ok))) resumed++;
    else {
      const component=(key,task)=>retryFailed && item?.tradeDate===tradeDate && item[key]?.ok ? Promise.resolve(item[key]) : capture(task);
      const [history,financial,funds,stockNews]=await Promise.all([component('history',async()=>{
        try {
          const rows=await live.fetchTencentHistory(stock.code,320);
          return {rows,analysis:api.analyzeHistory(rows)};
        } catch {
          const rows=await live.fetchSinaHistory(stock.code,320);
          return {rows,analysis:api.analyzeHistory(rows)};
        }
      }),component('financial',async()=>{
        const rows=await live.fetchSinaFinancialRows(stock.code);
        return {...rows,analysis:api.buildFinancialAnalysis(rows.quarters,rows.annuals,'新浪财务主要指标')};
      }),component('funds',()=>live.fetchSinaFundFlowHistory(stock.code,10,true)),
        component('news',()=>live.fetchStockNews({code:stock.code,name:stock.name,force:true}))]);
      item={tradeDate,complete:true,stock,history,financial,funds,news:stockNews};
      write(filename,item);
      await new Promise(resolve=>setTimeout(resolve,80));
    }
    for(const key of ['history','financial','funds','news']) if(item[key]?.ok) coverage[key]++;
    if(item.news?.value?.news?.length) coverage.newsWithItems++;
    complete++;
    if(complete%100===0 || complete===snapshot.quotes.length) progress();
  });
  const failures=results.filter(result=>result.status==='rejected').map(result=>String(result.reason));
  if(failures.length) {write('worker-errors.json',failures);throw new Error(`${failures.length} workers failed; resume the collection to retry`);}
  progress();
}
run().catch(error=>{console.error(error);process.exitCode=1;});
