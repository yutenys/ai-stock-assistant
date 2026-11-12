'use strict';

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 2) {
  const parsed = finite(value);
  return parsed === null ? null : Number(parsed.toFixed(digits));
}

function rowAvailableAt(row) {
  return row?.availableAt || row?.NOTICE_DATE || row?.noticeDate || row?.publishedAt || '';
}

function filterPointInTimeRows(rows = [], cutoffAt = new Date().toISOString()) {
  const cutoff = Date.parse(cutoffAt);
  if (!Number.isFinite(cutoff)) throw new Error('cutoffAt must be a valid timestamp');
  const accepted = [], future = [], unknown = [];
  for (const row of rows || []) {
    const availableAt = rowAvailableAt(row);
    const observed = Date.parse(availableAt);
    if (!availableAt || !Number.isFinite(observed)) unknown.push(row);
    else if (observed > cutoff) future.push(row);
    else accepted.push({...row,availableAt:new Date(observed).toISOString()});
  }
  return {accepted,future,unknown,cutoffAt:new Date(cutoff).toISOString(),
    coverage:{total:(rows || []).length,accepted:accepted.length,future:future.length,unknown:unknown.length}};
}

function longestStreak(values, direction) {
  let current = 0, longest = 0, start = null, best = null;
  for (let index = 1; index < values.length; index++) {
    const previous = finite(values[index - 1].close), price = finite(values[index].close);
    const matched = previous > 0 && price > 0 && (direction === 'up' ? price > previous : price < previous);
    if (matched) {
      if (!current) start = index - 1;
      current++;
      if (current > longest) {
        longest = current;
        best = {startDate:values[start]?.date || '',endDate:values[index]?.date || '',
          returnPct:round((price / finite(values[start].close) - 1) * 100)};
      }
    } else {
      current = 0;
      start = null;
    }
  }
  return {days:longest,...(best || {startDate:'',endDate:'',returnPct:null})};
}

function orderedMove(rows, mode) {
  if (rows.length < 2) return {returnPct:null,startDate:'',endDate:''};
  let anchor = finite(rows[0].close), anchorIndex = 0, best = mode === 'gain' ? -Infinity : Infinity;
  let result = null;
  for (let index = 1; index < rows.length; index++) {
    const price = finite(rows[index].close);
    if (!(price > 0) || !(anchor > 0)) continue;
    const change = (price / anchor - 1) * 100;
    if (mode === 'gain' ? change > best : change < best) {
      best = change;
      result = {returnPct:round(change),startDate:rows[anchorIndex].date || '',endDate:rows[index].date || ''};
    }
    if (mode === 'gain' ? price < anchor : price > anchor) {
      anchor = price;
      anchorIndex = index;
    }
  }
  return result || {returnPct:null,startDate:'',endDate:''};
}

function trueRange(rows, index) {
  const row = rows[index], previous = rows[index - 1];
  const high = finite(row?.high), low = finite(row?.low), previousClose = finite(previous?.close);
  if (!(high > 0) || !(low > 0)) return null;
  return index && previousClose > 0 ? Math.max(high-low,Math.abs(high-previousClose),Math.abs(low-previousClose)) : high-low;
}

function analyzePricePath(rows = [], {windows = [1,3,5,10,20,60,120,250]} = {}) {
  const valid = (rows || []).filter(row => finite(row?.close) > 0).sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  if (valid.length < 2) return {available:false,observations:valid.length,reason:'insufficient-history'};
  const latest = valid.at(-1), returns = {}, drawdowns = {}, runups = {};
  for (const window of windows) {
    const base = valid.at(-1-window);
    returns[window] = base ? {returnPct:round((latest.close/base.close-1)*100),startDate:base.date,endDate:latest.date,observations:window+1} : null;
    const windowRows = valid.slice(-(window + 1));
    drawdowns[window] = windowRows.length > window ? orderedMove(windowRows,'drawdown').returnPct : null;
    runups[window] = windowRows.length > window ? orderedMove(windowRows,'gain').returnPct : null;
  }
  const recent = valid.slice(-120);
  const ranges = recent.map((row,index)=>trueRange(recent,index)).filter(value=>value !== null);
  const atr14 = ranges.length ? ranges.slice(-14).reduce((sum,value)=>sum+value,0)/Math.min(14,ranges.length) : null;
  const amplitudes = recent.slice(1).map((row,index)=>{
    const previous = finite(recent[index]?.close), high=finite(row.high), low=finite(row.low);
    return previous>0 && high!==null && low!==null ? (high-low)/previous*100 : null;
  }).filter(value=>value!==null);
  const previousVolumes = valid.slice(-21,-1).map(row=>finite(row.volume)).filter(value=>value!==null);
  const volumeAverage20 = previousVolumes.length >= 15
    ? previousVolumes.reduce((sum,value)=>sum+value,0)/previousVolumes.length : null;
  const currentVolume = finite(latest.volume);
  return {available:true,observations:valid.length,startDate:valid[0].date || '',endDate:latest.date || '',returns,drawdowns,runups,
    longestUp:longestStreak(valid,'up'),longestDown:longestStreak(valid,'down'),
    maximumOrderedGain:orderedMove(recent,'gain'),maximumOrderedDrawdown:orderedMove(recent,'drawdown'),
    atr14:round(atr14),atrPct:atr14!==null?round(atr14/latest.close*100):null,
    averageAmplitude120:amplitudes.length?round(amplitudes.reduce((a,b)=>a+b,0)/amplitudes.length):null,
    maximumAmplitude120:amplitudes.length?round(Math.max(...amplitudes)):null,
    volumeRatio20:volumeAverage20>0&&currentVolume!==null?round(currentVolume/volumeAverage20):null,
    volumeRatioDefinition:'latest-complete-day / previous-20-valid-complete-days',
    volumeBaselineObservations:previousVolumes.length};
}

function assessRequestedRange({requestedCount = 0, requestedFrom = '', requestedTo = '', rows = []} = {}) {
  const dates = [...new Set((rows || []).map(row=>String(row.tradeDate || row.date || '').slice(0,10))
    .filter(value=>/^\d{4}-\d{2}-\d{2}$/.test(value)))].sort();
  const actualCount = dates.length;
  const complete = requestedCount > 0 && actualCount >= requestedCount
    && (!requestedFrom || dates[0] <= requestedFrom) && (!requestedTo || dates.at(-1) >= requestedTo);
  return {requestedCount,requestedFrom,requestedTo,actualCount,actualFrom:dates[0] || '',actualTo:dates.at(-1) || '',
    status:complete?'complete':actualCount?'partial':'missing',missingCount:Math.max(0,requestedCount-actualCount)};
}

function coverageItem({expected = 0, received = 0, usable = received, tradeDate = '', observedAt = '', status, reason = ''} = {}) {
  const ratio = expected > 0 ? usable/expected : 0;
  return {expected,received,usable,ratio:round(ratio,4),tradeDate,observedAt,
    status:status || (!received?'missing':usable<expected?'partial':'fresh'),reason};
}

function buildCoverageMatrix(input = {}) {
  const expected = Number(input.expectedUniverse) || 0;
  return {
    universe:coverageItem({expected,received:Number(input.universeCount)||0,usable:Number(input.universeCount)||0,
      observedAt:input.observedAt,reason:input.universeReason||''}),
    quotes:coverageItem({expected,received:Number(input.quoteCount)||0,usable:Number(input.quoteUsable)||0,
      tradeDate:input.quoteTradeDate,observedAt:input.observedAt}),
    history:coverageItem({expected,received:Number(input.historyCount)||0,usable:Number(input.historyUsable)||0,
      tradeDate:input.historyTradeDate,observedAt:input.historyObservedAt}),
    financial:coverageItem({expected,received:Number(input.financialCount)||0,usable:Number(input.financialUsable)||0,
      tradeDate:input.financialReportDate,observedAt:input.financialObservedAt,reason:input.financialReason||''}),
    fundFlow:coverageItem({expected,received:Number(input.fundCount)||0,usable:Number(input.fundUsable)||0,
      tradeDate:input.fundTradeDate,observedAt:input.fundObservedAt,reason:input.fundReason||''}),
    sectors:coverageItem({expected:Number(input.sectorExpected)||0,received:Number(input.sectorCount)||0,
      usable:Number(input.sectorUsable)||0,tradeDate:input.sectorTradeDate,observedAt:input.sectorObservedAt}),
    news:coverageItem({expected:Number(input.newsExpected)||0,received:Number(input.newsCount)||0,
      usable:Number(input.newsUsable)||0,observedAt:input.newsObservedAt,reason:input.newsReason||''}),
    recommendations:{status:input.ledgerAvailable?'available':'missing',batches:Number(input.ledgerBatches)||0,
      reason:input.ledgerAvailable?'':input.ledgerReason || '未找到可信发布账本，不能计算正式推荐表现'}
  };
}

function markDuplicateSectorCapital(rows = []) {
  const groups = new Map();
  for (const row of rows || []) {
    const amount = finite(row.mainNetInflow), ratio = finite(row.mainNetPct), change = finite(row.changePct);
    const key = amount === null ? '' : [row.capitalTradeDate || '',Math.round(amount),ratio===null?'':ratio.toFixed(4),change===null?'':change.toFixed(4)].join('|');
    if (!key) continue;
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(row);
  }
  return (rows || []).map(row=>({...row,capitalIndependent:true,capitalDuplicateOf:'',capitalAliases:[]})).map((row,_index,all)=>{
    const amount=finite(row.mainNetInflow),ratio=finite(row.mainNetPct),change=finite(row.changePct);
    const key=amount===null?'':[row.capitalTradeDate||'',Math.round(amount),ratio===null?'':ratio.toFixed(4),change===null?'':change.toFixed(4)].join('|');
    const group=groups.get(key)||[];
    if (group.length<2) return row;
    const canonical=group.slice().sort((a,b)=>Number(a.boardType==='concept')-Number(b.boardType==='concept')
      || String(a.name||'').length-String(b.name||'').length || String(a.code||'').localeCompare(String(b.code||'')))[0];
    return {...row,capitalIndependent:row.code===canonical.code,capitalDuplicateOf:row.code===canonical.code?'':canonical.code,
      capitalAliases:group.filter(item=>item.code!==row.code).map(item=>item.name)};
  });
}

module.exports={filterPointInTimeRows,analyzePricePath,assessRequestedRange,buildCoverageMatrix,coverageItem,markDuplicateSectorCapital};
