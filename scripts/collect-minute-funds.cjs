'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {atomicWriteJson}=require('../lib/persistence');
const {isTradedBar}=require('../lib/data-coverage-audit');

async function main(){
  const root=path.resolve(__dirname,'..','data');
  const history=path.join(root,'market-history');
  const requestedDate=process.argv.find(arg=>arg.startsWith('--date='))?.slice(7);
  const date=requestedDate||new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
  const codes=[];
  let historyFiles=0;
  for(const dir of fs.readdirSync(history,{withFileTypes:true}).filter(x=>x.isDirectory())){
    for(const file of fs.readdirSync(path.join(history,dir.name))){
      if(!/^\d{6}\.json$/.test(file)) continue;
      historyFiles+=1;
      const data=JSON.parse(fs.readFileSync(path.join(history,dir.name,file),'utf8'));
      const bar=(data.bars||[]).find(row=>row.date===date);
      if(isTradedBar(bar)) codes.push(file.slice(0,6));
    }
  }
  const output=path.join(root,'minute-funds',date);
  const manifestFile=path.join(output,'manifest.json');
  let previous=null;
  try{previous=JSON.parse(fs.readFileSync(manifestFile,'utf8'));}catch{}
  const completed=new Map((previous?.tradeDate===date?previous.results:[])
    .filter(row=>row.status==='raw-validated'&&fs.existsSync(path.join(output,row.code+'.json')))
    .map(row=>[row.code,row]));
  const results=codes.filter(code=>completed.has(code)).map(code=>completed.get(code));
  const pendingCodes=codes.filter(code=>!completed.has(code));
  let cursor=0;
  await Promise.all(Array.from({length:3},async()=>{
    while(cursor<pendingCodes.length){
      const code=pendingCodes[cursor++];
      const url='https://push2.eastmoney.com/webguest/api/qt/stock/fflow/kline/get?'+new URLSearchParams({
        secid:`${code.startsWith('6')?'1':'0'}.${code}`,klt:'1',lmt:'0',fields1:'f1,f2,f3,f7',fields2:'f51,f52,f53,f54,f55,f56'});
      try{
        const response=await fetch(url,{headers:{Referer:'https://quote.eastmoney.com/','User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(10000)});
        if(!response.ok) throw new Error(`HTTP ${response.status}`);
        const raw=await response.json(),data=raw.data;
        if(raw.rc!==0||data?.code!==code||!data.klines?.length) throw new Error('empty or mismatched response');
        const seen=new Set();
        for(const line of data.klines){
          const cells=line.split(',');
          if(cells.length!==6||!cells[0].startsWith(date+' ')||seen.has(cells[0])||cells.slice(1).some(x=>x.trim()===''||!Number.isFinite(Number(x)))) throw new Error('invalid date or row');
          seen.add(cells[0]);
        }
        await atomicWriteJson(path.join(output,code+'.json'),{code,tradeDate:date,fetchedAt:new Date().toISOString(),source:url,
          semantics:'provider raw fields; cumulative versus interval not yet independently verified',raw});
        results.push({code,status:'raw-validated',rows:data.klines.length,first:data.klines[0].split(',')[0],last:data.klines.at(-1).split(',')[0]});
      }catch(error){results.push({code,status:'failed',error:error.cause?.code||error.message});}
      if(results.length%100===0){console.log(`${results.length}/${codes.length}`);await atomicWriteJson(manifestFile,{tradeDate:date,total:codes.length,historyFiles,tradedCandidates:codes.length,resumed:completed.size,complete:false,results});}
    }
  }));
  const summary={tradeDate:date,total:codes.length,historyFiles,tradedCandidates:codes.length,excludedWithoutPositiveTurnover:historyFiles-codes.length,resumed:completed.size,complete:true,rawValidated:results.filter(x=>x.status==='raw-validated').length,results};
  await atomicWriteJson(manifestFile,summary);
  console.log(JSON.stringify({...summary,results:undefined}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
