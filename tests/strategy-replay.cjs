// Point-in-time replay helpers. Observation returns and executable portfolio returns are kept separate.
const fs = require('node:fs');

function finite(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function median(values) {
  if (!values.length) return null;
  const rows = [...values].sort((a,b)=>a-b);
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
}

function validateCosts(feeRate, slippageBps) {
  if (!Number.isFinite(feeRate) || feeRate < 0 || !Number.isFinite(slippageBps) || slippageBps < 0) {
    throw new Error('feeRate与slippageBps必须显式提供非负数，不能隐含交易成本假设');
  }
}

function priceRowsByCode(prices) {
  const byCode = new Map();
  for (const row of prices || []) {
    const code=String(row.code || ''), date=String(row.date || '');
    if (!/^\d{6}$/.test(code) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push({...row,code,date});
  }
  byCode.forEach(rows=>rows.sort((a,b)=>a.date.localeCompare(b.date)));
  return byCode;
}

function buildObservationTrades({signals=[], prices=[], horizons, feeRate, slippageBps}) {
  const byCode=priceRowsByCode(prices), trades=[];
  for (const signal of signals) {
    const code=String(signal.code || ''), signalDate=String(signal.tradeDate || '');
    const rows=(byCode.get(code) || []).filter(row=>row.date > signalDate);
    const entry=rows[0], entryOpen=finite(entry?.open);
    if (!(entryOpen > 0)) continue;
    const entryPrice=entryOpen * (1 + slippageBps / 10000), outcomes={};
    for (const horizon of horizons) {
      const observation=rows[horizon - 1], close=finite(observation?.close);
      outcomes[horizon]=close > 0
        ? (close * (1 - slippageBps / 10000) * (1 - feeRate) / (entryPrice * (1 + feeRate)) - 1) * 100
        : null;
    }
    trades.push({code,signal:signal.signal || '',modelVersion:signal.modelVersion || '',signalDate,
      entryDate:entry.date,entryPrice,outcomes});
  }
  return {byCode,trades};
}

function replayStrategies({signals=[], prices=[], horizons=[1,3,5,10,20,60], feeRate, slippageBps}={}) {
  validateCosts(feeRate, slippageBps);
  const normalizedHorizons=[...new Set(horizons.map(Number).filter(value=>Number.isInteger(value) && value > 0))].sort((a,b)=>a-b);
  if (!normalizedHorizons.length) throw new Error('horizons必须至少包含一个正整数');
  const {trades}=buildObservationTrades({signals,prices,horizons:normalizedHorizons,feeRate,slippageBps});
  const metrics={};
  for (const horizon of normalizedHorizons) {
    const values=trades.map(row=>row.outcomes[horizon]).filter(Number.isFinite);
    metrics[horizon]={count:values.length,mean:values.length ? values.reduce((sum,v)=>sum+v,0)/values.length : null,
      median:median(values),winRate:values.length ? values.filter(value=>value>0).length/values.length : null,
      worstReturn:values.length ? Math.min(...values) : null};
  }
  return {schemaVersion:2,scope:'next-trading-day entry; close-price observations, not an account equity curve',
    feeRate,slippageBps,horizons:normalizedHorizons,metrics,trades,excluded:signals.length-trades.length};
}

function replayPortfolio({signals=[], prices=[], feeRate, slippageBps, initialCapital, maxPositions, holdingDays}={}) {
  validateCosts(feeRate, slippageBps);
  if (!(Number.isFinite(initialCapital) && initialCapital > 0)) throw new Error('initialCapital必须显式提供正数');
  if (!(Number.isInteger(maxPositions) && maxPositions > 0)) throw new Error('maxPositions必须显式提供正整数');
  if (!(Number.isInteger(holdingDays) && holdingDays >= 1)) throw new Error('holdingDays必须显式提供且至少为1个交易日');
  const byCode=priceRowsByCode(prices), orders=[];
  for (const signal of signals) {
    const code=String(signal.code || ''), rows=(byCode.get(code) || []).filter(row=>row.date > String(signal.tradeDate || ''));
    const entry=rows[0], exit=rows[holdingDays], entryOpen=finite(entry?.open), exitClose=finite(exit?.close);
    if (!(entryOpen > 0) || !(exitClose > 0)) continue;
    orders.push({code,signalDate:String(signal.tradeDate || ''),entryDate:entry.date,exitDate:exit.date,
      entryPrice:entryOpen * (1 + slippageBps / 10000),exitPrice:exitClose * (1 - slippageBps / 10000)});
  }
  orders.sort((a,b)=>a.entryDate.localeCompare(b.entryDate) || a.code.localeCompare(b.code));
  const dates=[...new Set([...byCode.values()].flatMap(rows=>rows.map(row=>row.date)))].sort();
  const closeByCodeDate=new Map([...byCode].flatMap(([code,rows])=>rows.map(row=>[`${code}|${row.date}`,finite(row.close)])));
  let cash=initialCapital, peak=initialCapital, maxDrawdown=0;
  const positions=[], fills=[], rejected=[], equityCurve=[];
  for (const date of dates) {
    for (const order of orders.filter(row=>row.entryDate===date)) {
      if (positions.length >= maxPositions) { rejected.push({...order,reason:'position-limit'}); continue; }
      const allocation=Math.min(initialCapital / maxPositions,cash);
      const quantity=Math.floor(allocation / (order.entryPrice * (1 + feeRate)) / 100) * 100;
      if (quantity < 100) { rejected.push({...order,reason:'insufficient-cash'}); continue; }
      const cost=quantity * order.entryPrice * (1 + feeRate);
      cash-=cost;
      positions.push({...order,quantity,lastClose:order.entryPrice});
      fills.push({date,side:'buy',code:order.code,price:order.entryPrice,quantity,cost});
    }
    for (const position of positions) {
      const close=closeByCodeDate.get(`${position.code}|${date}`);
      if (close > 0) position.lastClose=close;
    }
    for (let index=positions.length-1;index>=0;index--) {
      const position=positions[index];
      if (position.exitDate !== date) continue;
      const proceeds=position.quantity * position.exitPrice * (1 - feeRate);
      cash+=proceeds;
      fills.push({date,side:'sell',code:position.code,price:position.exitPrice,quantity:position.quantity,proceeds});
      positions.splice(index,1);
    }
    const equity=cash+positions.reduce((sum,row)=>sum+row.quantity*row.lastClose,0);
    peak=Math.max(peak,equity);
    const drawdown=peak > 0 ? (equity / peak - 1) * 100 : 0;
    maxDrawdown=Math.min(maxDrawdown,drawdown);
    equityCurve.push({date,equity,cash,positions:positions.length,drawdown});
  }
  const finalEquity=equityCurve.at(-1)?.equity ?? initialCapital;
  return {schemaVersion:1,scope:'cash-constrained A-share research account; buy next trading-day open, sell after holdingDays at close',
    feeRate,slippageBps,initialCapital,maxPositions,holdingDays,finalEquity,
    totalReturn:(finalEquity / initialCapital - 1) * 100,maxDrawdown,equityCurve,fills,rejected,
    excluded:signals.length-orders.length};
}

function runCli() {
  const arg = name => { const index=process.argv.indexOf(name); return index >= 0 ? process.argv[index+1] : null; };
  const signalsFile=arg('--signals'),pricesFile=arg('--prices'),outputFile=arg('--out');
  const feeText=arg('--fee-rate'),slippageText=arg('--slippage-bps');
  if (!signalsFile || !pricesFile || !outputFile || feeText === null || slippageText === null) {
    throw new Error('用法：node tests/strategy-replay.cjs --signals <json> --prices <json> --out <json> --fee-rate <数值> --slippage-bps <数值>');
  }
  const input={signals:JSON.parse(fs.readFileSync(signalsFile,'utf8')),prices:JSON.parse(fs.readFileSync(pricesFile,'utf8')),
    feeRate:Number(feeText),slippageBps:Number(slippageText)};
  const report={observations:replayStrategies(input)};
  const capitalText=arg('--initial-capital'),positionsText=arg('--max-positions'),holdingText=arg('--holding-days');
  if ([capitalText,positionsText,holdingText].some(value=>value !== null)) {
    if ([capitalText,positionsText,holdingText].some(value=>value === null)) throw new Error('账户回放必须同时提供initial-capital、max-positions和holding-days');
    report.portfolio=replayPortfolio({...input,initialCapital:Number(capitalText),maxPositions:Number(positionsText),holdingDays:Number(holdingText)});
  }
  fs.writeFileSync(outputFile,JSON.stringify(report,null,2));
  console.log(JSON.stringify({trades:report.observations.trades.length,excluded:report.observations.excluded,
    metrics:report.observations.metrics,portfolio:report.portfolio ? {totalReturn:report.portfolio.totalReturn,maxDrawdown:report.portfolio.maxDrawdown} : null},null,2));
}

module.exports={replayStrategies,replayPortfolio};
if(require.main===module){try{runCli();}catch(error){console.error(error.message||error);process.exitCode=1;}}
