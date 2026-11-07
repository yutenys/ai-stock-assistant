'use strict';
const fs=require('node:fs'),path=require('node:path');
const {atomicWriteJson,StockHistoryStore}=require('../lib/persistence');
const root=path.resolve(__dirname,'..','data'),date='2026-11-05';
const folder=path.join(root,'minute-funds',date);
const audit=JSON.parse(fs.readFileSync(path.join(folder,'audit.json')));
const manifest=JSON.parse(fs.readFileSync(path.join(folder,'manifest.json')));
async function json(url){const r=await fetch(url,{signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();}
async function pool(items,task){let cursor=0;const rows=[];await Promise.all(Array.from({length:3},async()=>{while(cursor<items.length){const item=items[cursor++];try{rows.push(await task(item));}catch(e){rows.push({code:item.code,error:e.cause?.code||e.message});}}}));return rows;}
async function main(){
  const store=new StockHistoryStore(path.join(root,'market-history'));
  const daily=await pool(audit.daily.filter(x=>!x.recentWindowComplete),async item=>{
    const code=item.code,symbol=(code.startsWith('6')?'sh':/^[489]/.test(code)?'bj':'sz')+code;
    let source='https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param='+symbol+',day,,,320,qfq';
    const data=(await json(source)).data?.[symbol];
    let rows=data?.qfqday||data?.day||[],provider='腾讯补采日线',adjustment=data?.qfqday?'qfq':'none';
    if(item.missing.some(d=>!rows.some(r=>r[0]===d))){
      const url='https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20history=/CN_MarketDataService.getKLineData?symbol='+symbol+'&scale=240&ma=no&datalen=320';
      const response=await fetch(url,{signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error(`Sina HTTP ${response.status}`);
      const text=await response.text(),match=text.match(/=\s*\(([\s\S]*?)\);?\s*$/);
      const raw=match?JSON.parse(match[1]):null;
      if(Array.isArray(raw)){
        const candidate=raw.map(r=>[r.day,r.open,r.close,r.high,r.low,Number(r.volume)/100]);
        if(item.missing.filter(d=>!candidate.some(r=>r[0]===d)).length<item.missing.filter(d=>!rows.some(r=>r[0]===d)).length){
          rows=candidate;provider='新浪不复权日线补采';adjustment='none';source=url;
        }
      }
    }
    const dates=new Set(rows.map(x=>x[0]));
    const remaining=item.missing.filter(d=>!dates.has(d));
    const result={code,name:data?.qt?.[symbol]?.[1],source,provider,adjustment,received:rows.length,last:rows.at(-1)?.[0],remaining};
    if(remaining.length===0){
      const bars=rows.map(r=>({date:r[0],open:Number(r[1]),close:Number(r[2]),high:Number(r[3]),low:Number(r[4]),volume:Number(r[5])}));
      if(bars.some(r=>![r.open,r.close,r.high,r.low].every(n=>Number.isFinite(n)&&n>0)||r.high<Math.max(r.open,r.close)||r.low>Math.min(r.open,r.close)))throw new Error('invalid OHLC');
      await store.merge(code,bars,{source:provider,adjustment,volumeUnit:'手',fullRefresh:true,tradeDate:date});
      result.status='recovered';
    }else result.status=rows.length===1?'only-one-bar':rows.at(-1)?.[0]<'2026-10-29'?'historical-only-status-unverified':'partial';
    return result;
  });
  const targets=[...manifest.results.filter(x=>x.status==='failed'),...audit.funds.filter(x=>x.semantics==='mismatch')];
  const funds=await pool(targets,async({code})=>{
    const params=new URLSearchParams({secid:`${code.startsWith('6')?'1':'0'}.${code}`,klt:'1',lmt:'0',fields1:'f1,f2,f3,f7',fields2:'f51,f52,f53,f54,f55,f56'});
    const base='https://push2.eastmoney.com/webguest/api/qt/stock/fflow/';
    const minute=await json(base+'kline/get?'+params);
    if(minute.rc!==0||minute.data?.code!==code||!minute.data.klines?.length)return {code,status:'still-empty',raw:minute};
    params.set('klt','101');params.set('lmt','5');
    const day=await json(base+'daykline/get?'+params);
    const end=day.data?.code===code&&day.data.klines?.find(x=>x.startsWith(date+','));
    const last=minute.data.klines.at(-1).split(',');
    const deltas=end&&last[0]===date+' 15:00'?last.slice(1).map((x,i)=>Number(x)-Number(end.split(',')[i+1])):null;
    return {code,status:deltas?'rechecked':'date-unverified',deltas,minute,day,checkedAt:new Date().toISOString()};
  });
  const count=(rows,key)=>rows.reduce((r,x)=>(r[x[key]||'error']=(r[x[key]||'error']||0)+1,r),{});
  const summary={date,daily:count(daily,'status'),funds:count(funds,'status')};
  await atomicWriteJson(path.join(folder,'gap-recheck.json'),{summary,daily,funds});
  console.log(JSON.stringify(summary));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
