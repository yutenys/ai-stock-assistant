// Point-in-time replay helper. It never uses prices on or before a signal as an exit.
const fs = require('node:fs');

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function median(values) {
  if (!values.length) return null;
  const rows = [...values].sort((a,b)=>a-b);
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
}

function replayStrategies({signals=[], prices=[], horizons=[1,3,5,10,20,60], feeRate, slippageBps}={}) {
  if (!Number.isFinite(feeRate) || feeRate < 0 || !Number.isFinite(slippageBps) || slippageBps < 0) {
    throw new Error('feeRate与slippageBps必须显式提供非负数，不能隐含交易成本假设');
  }
  const byCode = new Map();
  for (const row of prices) {
    if (!/^\d{6}$/.test(String(row.code || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(row.date || ''))) continue;
    if (!byCode.has(row.code)) byCode.set(row.code, []);
    byCode.get(row.code).push(row);
  }
  byCode.forEach(rows=>rows.sort((a,b)=>a.date.localeCompare(b.date)));
  const trades=[];
  for (const signal of signals) {
    const signalDate=String(signal.tradeDate || '');
    const rows=(byCode.get(String(signal.code || '')) || []).filter(row=>row.date > signalDate);
    const entry=rows[0];
    const entryOpen=finite(entry?.open);
    if (!(entryOpen > 0)) continue;
    const entryPrice=entryOpen * (1 + slippageBps / 10000);
    const outcomes={};
    for (const horizon of horizons) {
      const exit=rows[horizon - 1];
      const exitClose=finite(exit?.close);
      if (!(exitClose > 0)) { outcomes[horizon]=null; continue; }
      const exitPrice=exitClose * (1 - slippageBps / 10000);
      outcomes[horizon]=(exitPrice * (1 - feeRate) / (entryPrice * (1 + feeRate)) - 1) * 100;
    }
    trades.push({code:signal.code,signal:signal.signal || '',modelVersion:signal.modelVersion || '',
      signalDate,entryDate:entry.date,entryPrice,outcomes});
  }
  const metrics={};
  for (const horizon of horizons) {
    const values=trades.map(row=>row.outcomes[horizon]).filter(Number.isFinite);
    let peak=0,equity=0,maxDrawdown=0;
    for (const value of values) { equity += value; peak=Math.max(peak,equity); maxDrawdown=Math.min(maxDrawdown,equity-peak); }
    metrics[horizon]={count:values.length,mean:values.length ? values.reduce((sum,v)=>sum+v,0)/values.length : null,
      median:median(values),winRate:values.length ? values.filter(value=>value>0).length/values.length : null,maxDrawdown};
  }
  return {schemaVersion:1,scope:'next-trading-day execution; point-in-time signals only',feeRate,slippageBps,horizons,metrics,trades,
    excluded:signals.length-trades.length};
}

function runCli() {
  const arg = name => { const index=process.argv.indexOf(name); return index >= 0 ? process.argv[index+1] : ''; };
  const signalsFile=arg('--signals'),pricesFile=arg('--prices'),outputFile=arg('--out');
  const feeRate=Number(arg('--fee-rate')),slippageBps=Number(arg('--slippage-bps'));
  if (!signalsFile || !pricesFile || !outputFile) throw new Error('用法：node tests/strategy-replay.cjs --signals <json> --prices <json> --out <json> --fee-rate <数值> --slippage-bps <数值>');
  const report=replayStrategies({signals:JSON.parse(fs.readFileSync(signalsFile,'utf8')),
    prices:JSON.parse(fs.readFileSync(pricesFile,'utf8')),feeRate,slippageBps});
  fs.writeFileSync(outputFile,JSON.stringify(report,null,2));
  console.log(JSON.stringify({trades:report.trades.length,excluded:report.excluded,metrics:report.metrics},null,2));
}

module.exports={replayStrategies};
if(require.main===module){try{runCli();}catch(error){console.error(error.message||error);process.exitCode=1;}}
