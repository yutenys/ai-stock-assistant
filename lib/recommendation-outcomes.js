const {nextTradingDay} = require('./trade-time');

const DEFAULT_HORIZONS = [1, 3, 5, 10, 20, 60];

function price(value) {
  if (value === null || value === undefined || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : null;
}

function advance(date, days) {
  let result = date;
  for (let index = 0; index < days && result; index++) result = nextTradingDay(result);
  return result;
}

function mergeSavedReportCloses(histories, reports = []) {
  const merged = new Map(histories);
  let added = 0;
  for (const report of reports) {
    const date = String(report?.tradeDate || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    for (const row of [...(report.recommendations?.all || []),...(report.recommendations?.followUp || [])]) {
      const code = String(row.code || '');
      const close = price(row.closePrice);
      if (!merged.has(code) || row.dataStatus !== '完整' || !close) continue;
      const history = merged.get(code) || {source:'已存收盘报告',bars:[]};
      const bars = history.bars || [];
      if (bars.some(bar => bar.date === date && bar.isFinal === true)) continue;
      merged.set(code,{...history,source:history.source || '已存收盘报告',lastDate:date > (history.lastDate || '') ? date : history.lastDate,
        bars:[...bars.filter(bar => bar.date !== date),{date,close,isFinal:true,source:'已存收盘报告',observedAt:row.closeObservedAt || ''}]});
      added++;
    }
  }
  return {histories:merged,added};
}

function assessForwardValidation(review, {freezeDate,modelVersion,asOfDate,routeHorizons = {A:20,B:5}}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(freezeDate || ''))
    || !/^\d{4}-\d{2}-\d{2}$/.test(String(asOfDate || '')) || !modelVersion) {
    throw new Error('前瞻验证需要冻结日期、截至日期和模型版本');
  }
  let tradingDays = 0, date = freezeDate, calendarComplete = true;
  while (date < asOfDate && tradingDays <= 370) {
    date = nextTradingDay(date);
    if (!date) { calendarComplete = false; break; }
    if (date <= asOfDate) tradingDays++;
  }
  const routes = Object.fromEntries(Object.entries(routeHorizons).map(([track,horizon]) => {
    const episodes = (review?.episodes || []).filter(row => row.track === track
      && row.modelVersion === modelVersion && row.tradeDate > freezeDate);
    const mature = episodes.filter(row => row.execution?.status === 'executable'
      && row.observations?.[horizon]?.status === 'observed');
    return [track,{horizon,published:episodes.length,mature:mature.length,required:30}];
  }));
  const readyForComparison = calendarComplete && tradingDays >= 20
    && Object.values(routes).every(row => row.mature >= row.required);
  return {freezeDate,modelVersion,asOfDate,tradingDays,requiredTradingDays:20,calendarComplete,routes,
    readyForComparison,promotionAllowed:false,
    reason:!calendarComplete ? '交易日历未覆盖完整验证窗口'
      : !readyForComparison ? '新交易日或成熟可成交样本不足，仅作影子观察'
        : '达到样本门槛，仍需同成本风险对照和人工版本裁决'};
}

function evaluatePublishedEpisodes(batches = [], histories = new Map(), {asOfDate, horizons = DEFAULT_HORIZONS} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOfDate || ''))) throw new Error('评价需要明确的截至交易日');
  const byBatch = new Map();
  let duplicateBatches = 0, excludedBatches = 0, excludedSignals = 0;
  for (const batch of batches) {
    const id = String(batch?.batchId || '');
    const published = Date.parse(batch?.publishedAt || '');
    const cutoff = Date.parse(batch?.inputCutoffAt || '');
    if (!id || !Number.isFinite(published) || !Number.isFinite(cutoff) || cutoff > published
      || published > Date.parse(`${asOfDate}T23:59:59+08:00`)
      || !batch.modelVersion || !/^\d{4}-\d{2}-\d{2}$/.test(String(batch.tradeDate || ''))
      || batch.tradeDate > asOfDate || batch.sourceType === 'external-report') {
      excludedBatches++;
      continue;
    }
    if (byBatch.has(id)) { duplicateBatches++; continue; }
    byBatch.set(id, batch);
  }
  const signals = [];
  for (const batch of byBatch.values()) {
    for (const [track, items] of [['A',batch.recommendations],['B',batch.momentumRecommendations]]) {
      for (const item of items || []) {
        const code = String(item?.code || '');
        const strategyId = String(item?.strategyId || item?.strategyDecision?.primaryStrategyId || '');
        if (!/^\d{6}$/.test(code) || !item?.signalId || !strategyId || !price(item.quote?.price ?? item.price)) {
          excludedSignals++;
          continue;
        }
        signals.push({code, track, strategyId, modelVersion:batch.modelVersion, signalId:item.signalId, batchId:batch.batchId,
          tradeDate:batch.tradeDate, publishedAt:batch.publishedAt,
          referencePrice:price(item.quote?.price ?? item.price), invalidated:Boolean(item.invalidated)});
      }
    }
  }
  signals.sort((a,b)=>a.tradeDate.localeCompare(b.tradeDate) || a.publishedAt.localeCompare(b.publishedAt));
  const episodes = [], open = new Map();
  for (const signal of signals) {
    const key = `${signal.code}|${signal.track}|${signal.strategyId}|${signal.modelVersion}`;
    const prior = open.get(key);
    if (prior && !signal.invalidated && (signal.tradeDate === prior.lastSeenDate
      || nextTradingDay(prior.lastSeenDate) === signal.tradeDate)) {
      prior.refreshCount++;
      if (prior.signalIds.length === 1) prior.signalIds.push(signal.signalId);
      else prior.signalIds[1] = signal.signalId;
      prior.lastBatchId = signal.batchId;
      prior.lastSeenDate = signal.tradeDate;
      continue;
    }
    const episode = {...signal, episodeId:signal.signalId, signalIds:[signal.signalId], lastSeenDate:signal.tradeDate,
      refreshCount:1,lastBatchId:signal.batchId,observations:{}, execution:{status:'unknown'}};
    episodes.push(episode);
    open.set(key,episode);
  }
  const counts = {publishedBatches:byBatch.size,publishedSignals:signals.length, episodes:episodes.length,
    observations:{observed:0,immature:0,missing:0},
    execution:{executable:0,unfilled:0,unverified:0,immature:0}};
  for (const episode of episodes) {
    const history = histories instanceof Map ? histories.get(episode.code) : histories[episode.code];
    const bars = Array.isArray(history) ? history : history?.bars || [];
    const byDate = new Map(bars.map(bar=>[String(bar.date || ''),bar]));
    for (const horizon of horizons) {
      const target = advance(episode.tradeDate, horizon);
      const bar = byDate.get(target);
      const reliable = bar?.isFinal === true || Boolean(history?.source && target < asOfDate && bar?.isFinal !== false);
      const status = !target ? 'missing' : target > asOfDate ? 'immature'
        : reliable && price(bar?.close) ? 'observed' : 'missing';
      episode.observations[horizon] = {status, date:target,
        returnPct:status === 'observed' ? (price(bar.close) / episode.referencePrice - 1) * 100 : null};
      counts.observations[status]++;
    }
    const entryDate = advance(episode.tradeDate,1);
    const entry = byDate.get(entryDate);
    const entryReliable = entry?.isFinal !== false && (entryDate < asOfDate || entry?.isFinal === true);
    let status = 'unverified', reason = '入场行情或限价证据不足';
    if (entryDate && entryDate > asOfDate) { status = 'immature'; reason = '尚未到最早买入日'; }
    else if (entry && !entryReliable) reason = '入场日线尚未收盘确认';
    else if (entry?.suspended || price(entry?.upperLimit) && price(entry?.open) >= price(entry.upperLimit)) {
      status = 'unfilled'; reason = entry?.suspended ? '停牌' : '开盘涨停，不能确认买入';
    } else if (price(entry?.open) && price(entry?.upperLimit)) { status = 'executable'; reason = '次日开盘可模拟成交'; }
    episode.execution = {status,reason,entryDate,earliestSellDate:entryDate ? nextTradingDay(entryDate) : null,
      entryPrice:status === 'executable' ? price(entry.open) : null};
    counts.execution[status]++;
  }
  return {schemaVersion:1,asOfDate,horizons,sourceType:'published-ledger',duplicateBatches,excludedBatches,
    excludedSignals,counts,episodes};
}

module.exports = {evaluatePublishedEpisodes,mergeSavedReportCloses,assessForwardValidation};
