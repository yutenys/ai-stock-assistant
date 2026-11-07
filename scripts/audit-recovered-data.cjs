'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {atomicWriteJson}=require('../lib/persistence');
const {reconcileFundSnapshots}=require('../lib/data-coverage-audit');
const root=path.resolve(__dirname,'..','data');
const date='2026-11-05';
const dates=['2026-10-29','2026-10-30','2026-11-02','2026-11-03','2026-11-04',date];
const minutes=[];
for(const [start,end] of [[571,690],[781,900]]) for(let t=start;t<=end;t++) minutes.push(`${date} ${String(Math.floor(t/60)).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`);
async function main(){
  const daily=[];
  for(const dir of fs.readdirSync(path.join(root,'market-history'),{withFileTypes:true}).filter(x=>x.isDirectory())){
    for(const file of fs.readdirSync(path.join(root,'market-history',dir.name)).filter(x=>/^\d{6}\.json$/.test(x))){
      const data=JSON.parse(await fs.promises.readFile(path.join(root,'market-history',dir.name,file),'utf8'));
      const bars=data.bars||[],seen=new Set(),issues=[];
      for(const row of bars){
        if(seen.has(row.date)) issues.push('duplicate-date');
        seen.add(row.date);
        if(!['open','high','low','close'].every(k=>Number.isFinite(row[k])&&row[k]>0)||row.high<Math.max(row.open,row.close,row.low)||row.low>Math.min(row.open,row.close)) issues.push('invalid-ohlc');
        if(row.adjustment&&row.adjustment!==data.adjustment) issues.push('mixed-adjustment');
        if(row.source&&row.source!==data.source) issues.push('mixed-source');
      }
      const missing=dates.filter(x=>!seen.has(x));
      daily.push({code:data.code,last:bars.at(-1)?.date,bars:bars.length,missing,issues:[...new Set(issues)],recentWindowComplete:missing.length===0&&issues.length===0});
    }
  }
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'minute-funds',date,'manifest.json'),'utf8'));
  const candidates=manifest.results.filter(x=>x.status==='raw-validated'),funds=[];
  let cursor=0;
  await Promise.all(Array.from({length:3},async()=>{
    while(cursor<candidates.length){
      const {code}=candidates[cursor++];
      const raw=JSON.parse(await fs.promises.readFile(path.join(root,'minute-funds',date,code+'.json'),'utf8'));
      const rows=raw.raw.data.klines.map(x=>x.split(','));
      const times=new Set(rows.map(x=>x[0]));
      const missing=minutes.filter(t=>!times.has(t)),unexpected=rows.filter(x=>!minutes.includes(x[0])).length;
      const last=rows.at(-1).slice(1).map(Number),sum=rows.reduce((a,r)=>a.map((v,i)=>v+Number(r[i+1])),[0,0,0,0,0]);
      const result={code,rows:rows.length,missing,unexpected,duplicate:rows.length-times.size,semantics:'unverified'};
      try{
        const url='https://push2.eastmoney.com/webguest/api/qt/stock/fflow/daykline/get?'+new URLSearchParams({secid:`${code.startsWith('6')?'1':'0'}.${code}`,klt:'101',lmt:'5',fields1:'f1,f2,f3',fields2:'f51,f52,f53,f54,f55,f56'});
        const response=await fetch(url,{signal:AbortSignal.timeout(10000)});
        if(!response.ok) throw new Error(`HTTP ${response.status}`);
        const json=await response.json();
        if(json.rc!==0||json.data?.code!==code) throw new Error('code mismatch');
        const end=json.data?.klines?.find(x=>x.startsWith(date+','));
        if(!end) throw new Error('same-date daily missing');
        result.dailyRaw=end;result.source=url;result.checkedAt=new Date().toISOString();
        const dailyValues=end.split(',').slice(1).map(Number);
        if(dailyValues.length!==5||dailyValues.some(x=>!Number.isFinite(x))) throw new Error('invalid daily fields');
        const lastCheck=reconcileFundSnapshots(last,dailyValues);
        const sumCheck=reconcileFundSnapshots(sum,dailyValues);
        result.lastMatches=lastCheck.status==='exact';result.sumMatches=sumCheck.status==='exact';
        result.lastReconciliation=lastCheck;result.sumReconciliation=sumCheck;
        result.semantics=['exact','within-provider-precision'].includes(lastCheck.status)&&sumCheck.status==='mismatch'?'cumulative-supported':lastCheck.status;
      }catch(error){result.error=error.cause?.code||error.message;}
      funds.push(result);
      if(funds.length%1000===0) console.log(`funds ${funds.length}/${candidates.length}`);
    }
  }));
  const counts={};for(const row of funds) counts[row.semantics]=(counts[row.semantics]||0)+1;
  const summary={date,dailyFiles:daily.length,dailyWindowComplete:daily.filter(x=>x.recentWindowComplete).length,dailyLatest:daily.filter(x=>x.last===date).length,
    dailyIssues:daily.filter(x=>x.issues.length).length,minuteFiles:funds.length,minuteGridComplete:funds.filter(x=>!x.missing.length&&!x.unexpected&&!x.duplicate).length,counts};
  await atomicWriteJson(path.join(root,'minute-funds',date,'audit.json'),{summary,daily,funds});
  console.log(JSON.stringify(summary));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
