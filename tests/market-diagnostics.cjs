// Read-only live diagnostics. Keep generated API evidence outside the repository.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'market-diagnostics-'));
const filename = path.resolve(__dirname, '../main.js');
const directoryFile=path.resolve(__dirname,'../cache/stock-directory.json');
// This is a classification cache, not a replacement for live prices or flows.
if (fs.existsSync(directoryFile)) fs.copyFileSync(directoryFile,path.join(output,'stock-directory.json'));
const loader = Module._load;
Module._load = function(name, parent, isMain) {
  if (name === 'electron') return {app:{isPackaged:false,whenReady:()=>({then(){}}),on(){}},ipcMain:{handle(){}},BrowserWindow:function(){},shell:{}};
  return loader.call(this,name,parent,isMain);
};
const runtime = new Module(filename, module);
runtime.filename=filename;
runtime.paths=Module._nodeModulePaths(path.dirname(filename));
try {
  runtime._compile(fs.readFileSync(filename,'utf8') + `
cacheFilePath = name => require('path').join(${JSON.stringify(output)}, name+'.json');
appendLogLine = () => {};
module.exports.diagnostics = {fetchTencentMarketSnapshot,fetchTencentMarketSectors,fetchSectorCapitalFlow,fetchMarketNews,fetchTencentHistory,fetchSinaHistory,fetchSinaFundFlowHistory,fetchSinaFinancialRows,fetchStockNews};`,filename);
} finally { Module._load=loader; }
const api=runtime.exports, live=api.diagnostics;
async function main(){
  console.log(JSON.stringify({output}));
  const [snapshot,capital,news]=await Promise.allSettled([live.fetchTencentMarketSnapshot(),live.fetchSectorCapitalFlow(true),live.fetchMarketNews(true)]);
  const quotes=snapshot.status==='fulfilled'?snapshot.value.quotes:[];
  const rotation=quotes.length?await live.fetchTencentMarketSectors(quotes):{sectors:[]};
  const sectors=api.mergeSectorCapitalRows(rotation,capital.status==='fulfilled'?capital.value.rows:[],quotes);
  const leaders=[...quotes].filter(q=>q.price>0 && q.amount>=5e7 && !/ST/.test(q.name)).sort((a,b)=>b.changePct-a.changePct).slice(0,12);
  const controls=[...quotes].filter(q=>q.price>0 && q.amount>=5e7 && !/ST/.test(q.name)).sort((a,b)=>a.changePct-b.changePct).slice(0,12);
  const samples=await api.settleWithConcurrency([...leaders,...controls],4,async stock=>{
    const history=await live.fetchTencentHistory(stock.code,120).catch(()=>live.fetchSinaHistory(stock.code,120));
    const funds=await live.fetchSinaFundFlowHistory(stock.code,10,true).catch(error=>({available:false,error:error.message}));
    const analysis=api.analyzeHistory(history);
    return {stock,analysis,funds,capitalWindows:api.analyzeCapitalWindows(funds,analysis.tradeDate)};
  });
  const report={fetchedAt:new Date().toISOString(),snapshot:snapshot.status==='fulfilled'?snapshot.value:{error:String(snapshot.reason)},capital:capital.status==='fulfilled'?capital.value:{error:String(capital.reason)},news:news.status==='fulfilled'?news.value:{error:String(news.reason)},sectors,samples};
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({scanned:quotes.length,tradeDates:[...new Set(quotes.map(q=>q.tradeDate))],breadth:report.snapshot.breadth,directorySource:fs.existsSync(directoryFile)?'local classification cache, live refresh attempted':'live only',capital:report.capital.source||report.capital.error,sectors:sectors.sectors.slice(0,8).map(s=>({name:s.name,change:s.changePct,flow:s.mainNetInflow,ratio:s.mainNetPct,score:s.rotationScore})),news:news.status==='fulfilled'?{count:news.value.news.length,summary:api.summarizeNews(news.value.news,'',news.value).summary}:report.news,samples:samples.map(r=>r.status==='fulfilled'?{code:r.value.stock.code,name:r.value.stock.name,change:r.value.stock.changePct,return20:r.value.analysis.return20,capitalWindows:r.value.capitalWindows}:String(r.reason))},null,2));
}
module.exports={api,live,output};
if(require.main===module) main().catch(error=>{console.error(error);process.exitCode=1;});
