const {clock, isTradingDay, nextTradingDay, executionWindow} = require('./trade-time');

const DEFAULT_HORIZONS = [1, 3, 5, 10, 20, 60];
const TERMINAL_STATES = ['blocked','invalidated','expired','completed','cancelled','terminal'];

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

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && clock(`${value}T00:00:00+08:00`).date === value;
}

function nonnegative(value) {
  if (value === null || value === undefined || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

function mergeSavedReportCloses(histories, reports = [], {asOfDate = clock().date} = {}) {
  if (!validDate(asOfDate)) throw new Error('收盘合并需要有效的截至日期');
  const merged = new Map(histories);
  let added = 0;
  const conflicts = [];
  for (const report of reports) {
    const date = String(report?.tradeDate || '');
    if (!validDate(date) || date > asOfDate || report.generatedAt
      && Date.parse(report.generatedAt) > Date.parse(`${asOfDate}T23:59:59+08:00`)) continue;
    for (const row of [...(report.recommendations?.all || []),...(report.recommendations?.followUp || [])]) {
      const code = String(row.code || '');
      const close = price(row.closePrice);
      if (!merged.has(code) || row.dataStatus !== '完整' || !close) continue;
      const history = merged.get(code) || {source:'已存收盘报告',bars:[]};
      const bars = history.bars || [];
      const existing = bars.find(bar => bar.date === date);
      const observedAt = row.closeObservedAt || '';
      if (observedAt && (!Number.isFinite(Date.parse(observedAt)) || clock(observedAt).date !== date
        || clock(observedAt).minute < 900)) continue;
      const adjustment = row.adjustment || report.adjustment || 'none';
      const incompatible = adjustment !== (existing?.adjustment || history.adjustment || 'none')
        || existing?.isFinal === true && price(existing.close) && Math.abs(existing.close - close) > .0001
        || existing?.finalClose && Math.abs(existing.finalClose.close - close) > .0001
        || price(existing?.high) && close > existing.high + .0001
        || price(existing?.low) && close < existing.low - .0001;
      if (incompatible) {
        conflicts.push({code,date,close,source:'已存收盘报告',observedAt,adjustment,reason:'收盘或复权口径冲突'});
        continue;
      }
      if ((existing?.isFinal === true && price(existing.close)) || existing?.finalClose) continue;
      const finalClose = {date,close,isFinal:true,source:'已存收盘报告',observedAt,adjustment};
      merged.set(code,{...history,source:history.source || '已存收盘报告',lastDate:date > (history.lastDate || '') ? date : history.lastDate,
        bars:existing ? bars.map(bar => bar === existing ? {...bar,finalClose} : bar) : [...bars,finalClose]});
      added++;
    }
  }
  return {histories:merged,added,conflicts};
}

function assessForwardValidation(review, {freezeDate,modelVersion,asOfDate,routeHorizons = {A:20,B:5},requireAllRoutes = true}) {
  if (!validDate(freezeDate) || !validDate(asOfDate) || freezeDate > asOfDate || !modelVersion) {
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
    const mature = episodes.filter(row => {
      const entry = row.execution, observation = row.executionObservations?.[horizon];
      const target = advance(entry?.entryDate,horizon);
      return entry?.status === 'executable' && entry.verified === true
        && isTradingDay(entry.entryDate) === true && entry.entryDate > freezeDate
        && isTradingDay(entry.earliestSellDate) === true && entry.earliestSellDate >= nextTradingDay(entry.entryDate)
        && observation?.status === 'observed' && observation.date === target
        && target >= entry.earliestSellDate && target <= asOfDate
        && Number.isFinite(observation.netReturnPct);
    });
    const unique = new Set(mature.filter(row => row.episodeId).map(row => row.planId
      ? `${row.code}|${row.track}|${row.planId}` : row.episodeId));
    return [track,{horizon,published:episodes.length,mature:unique.size,required:30,
      readyForComparison:calendarComplete && tradingDays >= 20 && unique.size >= 30}];
  }));
  const allRoutesReadyForComparison = calendarComplete && tradingDays >= 20
    && Object.values(routes).length > 0 && Object.values(routes).every(row => row.readyForComparison);
  const readyForComparison = calendarComplete && tradingDays >= 20
    && (requireAllRoutes ? allRoutesReadyForComparison : Object.values(routes).some(row => row.readyForComparison));
  return {freezeDate,modelVersion,asOfDate,tradingDays,requiredTradingDays:20,calendarComplete,routes,
    readyForComparison,allRoutesReadyForComparison,requireAllRoutes,promotionAllowed:false,
    reason:!calendarComplete ? '交易日历未覆盖完整验证窗口'
      : !readyForComparison ? '新交易日或成熟可成交样本不足，仅作影子观察'
        : '达到样本门槛，仍需同成本风险对照和人工版本裁决'};
}

function observations(anchorDate, referencePrice, horizons, byDate, history, asOfDate) {
  return Object.fromEntries(horizons.map(horizon => {
    const date = advance(anchorDate,horizon), bar = byDate.get(date);
    // Report overlays certify the close, never the rest of a partial daily bar.
    const overlay = bar?.finalClose;
    const overlayValid = overlay?.isFinal === true && overlay.date === date
      && (overlay.adjustment || 'none') === (bar?.adjustment || history?.adjustment || 'none')
      && (!overlay.observedAt || clock(overlay.observedAt).date === date && clock(overlay.observedAt).minute >= 900)
      && (bar?.isFinal !== true || !price(bar.close) || Math.abs(bar.close - overlay.close) <= .0001)
      && (!price(bar?.high) || overlay.close <= bar.high + .0001)
      && (!price(bar?.low) || overlay.close >= bar.low - .0001);
    const close = price(overlayValid ? overlay.close : bar?.close);
    const reliable = overlayValid || bar?.isFinal === true
      || Boolean(history?.source && date < asOfDate && bar?.isFinal !== false);
    const status = !date ? 'missing' : date > asOfDate ? 'immature'
      : reliable && close && referencePrice ? 'observed' : 'missing';
    return [horizon,{status,date,returnPct:status === 'observed' ? (close / referencePrice - 1) * 100 : null}];
  }));
}

function nextOpenProxy(episode, byDate, asOfDate) {
  const entryDate = advance(episode.tradeDate,1), entry = byDate.get(entryDate);
  const reliable = entry?.isFinal !== false && (entryDate < asOfDate || entry?.isFinal === true);
  let status = 'unverified', reason = '入场行情或限价证据不足';
  if (entryDate && entryDate > asOfDate) { status = 'immature'; reason = '尚未到次日开盘'; }
  else if (entry && !reliable) reason = '入场日线尚未收盘确认';
  else if (entry?.suspended || price(entry?.upperLimit) && price(entry?.open) >= price(entry.upperLimit)) {
    status = 'unfilled'; reason = entry?.suspended ? '停牌' : '开盘涨停，不能确认买入';
  } else if (price(entry?.open) && price(entry?.upperLimit)) { status = 'executable'; reason = '次日开盘反事实，不代表许可成交'; }
  return {status,reason,basis:'counterfactual-next-open',verified:false,entryDate,
    earliestSellDate:entryDate ? nextTradingDay(entryDate) : null,
    entryPrice:status === 'executable' ? price(entry.open) : null};
}

function historicalRules(bar, date) {
  const rules = bar?.tradeRules;
  return rules?.verified === true && rules.tradeDate === date && Boolean(rules.source)
    && rules.stale !== true && rules.tPlusOne === true && price(bar.upperLimit) && price(bar.lowerLimit)
    && price(bar.lowerLimit) < price(bar.upperLimit) && typeof bar.suspended === 'boolean';
}

function verifiedExecution(episode, byDate, asOfDate) {
  const result = {status:'unverified',verified:false,reason:'有效许可、触发或冻结计划证据不足',
    entryDate:null,entryPrice:null,earliestSellDate:null};
  const trigger = episode.triggerEvents[0], plan = episode.plan;
  if (!trigger || episode.planConflict || !episode.planId || episode.revision === null
    || episode.revision === '' || !Number.isInteger(Number(episode.revision)) || Number(episode.revision) < 0
    || isTradingDay(plan.earliestBuyDate) !== true || !validDate(plan.entryExpiryDate)
    || !price(plan.maxEntryPrice) || plan.expiresAt && !Number.isFinite(Date.parse(plan.expiresAt))) return result;
  const evidence = episode.executionEvidence;
  let entryDate, at, entryPrice, basis;
  if (evidence) {
    at = evidence.at || evidence.filledAt || evidence.observedAt;
    entryDate = clock(at).date;
    entryPrice = price(evidence.price);
    basis = `verified-${evidence.type}`;
    if (!['fill','quote'].includes(evidence.type) || evidence.verified !== true || !evidence.source
      || evidence.planId !== episode.planId || String(evidence.revision) !== String(episode.revision)
      || evidence.triggerEventId !== trigger.id || !entryPrice || !executionWindow(at).tradable
      || Date.parse(at) <= Date.parse(trigger.occurredAt) || entryDate < plan.earliestBuyDate
      || Date.parse(at) > Date.parse(evidence.inputCutoffAt) || entryDate > asOfDate
      || evidence.type === 'quote' && (evidence.executable !== true || evidence.liquidityVerified !== true
        || evidence.capitalAvailable !== true)
      || evidence.type === 'fill' && (evidence.status !== 'filled' || !evidence.orderId || !price(evidence.quantity))) {
      result.reason = '报价或成交证据未满足触发后普通时段契约';
      return result;
    }
  } else {
    const next = nextTradingDay(clock(trigger.occurredAt).date);
    entryDate = next && (next < plan.earliestBuyDate ? plan.earliestBuyDate : next);
    at = entryDate ? `${entryDate}T09:30:00+08:00` : '';
    entryPrice = price(byDate.get(entryDate)?.open);
    basis = 'next-session-open';
  }
  Object.assign(result,{entryDate,basis});
  if (!entryDate) return result;
  if (entryDate > plan.entryExpiryDate || plan.expiresAt && Date.parse(at) > Date.parse(plan.expiresAt)
    || episode.terminalAt && Date.parse(at) >= Date.parse(episode.terminalAt)) {
    return {...result,status:'unfilled',reason:'计划过期或已终止'};
  }
  if (entryDate > asOfDate) return {...result,status:'immature',reason:'尚未到许可买入日'};
  const permission = episode.permissionEvents.filter(row => Date.parse(row.at) >= Date.parse(trigger.occurredAt)
    && Date.parse(row.at) <= Date.parse(at)).at(-1);
  if (permission && permission.permission !== 'allowed') return {...result,status:'unfilled',reason:'入场前许可已撤销'};
  const bar = byDate.get(entryDate);
  if (!historicalRules(bar,entryDate) || !evidence && (bar?.isFinal !== true
    || !price(bar.open) || !price(bar.high) || !price(bar.low) || !price(bar.close)
    || price(bar.low) > Math.min(price(bar.open),price(bar.close))
    || price(bar.high) < Math.max(price(bar.open),price(bar.close))
    || !(price(bar.volume)) || bar.tradeRules.capitalAvailable !== true)) {
    return {...result,reason:'历史限价、交易规则、资金或完整最终日线未核验'};
  }
  if (bar.suspended || entryPrice >= bar.upperLimit || entryPrice < bar.lowerLimit
    || entryPrice > plan.maxEntryPrice) return {...result,status:'unfilled',reason:'停牌、限价或计划最高入场价限制'};
  const minimumSellDate = nextTradingDay(entryDate);
  const earliestSellDate = evidence?.earliestSellDate || (plan.earliestSellDate > minimumSellDate ? plan.earliestSellDate : minimumSellDate);
  if (!minimumSellDate || isTradingDay(earliestSellDate) !== true || earliestSellDate < minimumSellDate) {
    return {...result,reason:'可卖日期未满足实际入场的T+1约束'};
  }
  if (evidence?.fees && nonnegative(evidence.fees.total) === null) return {...result,reason:'实际成交费用未核验'};
  return {...result,status:'executable',verified:true,reason:'许可成交证据已核验',at,entryPrice,earliestSellDate,
    entryFeePerShare:evidence?.type === 'fill' && evidence.fees ? nonnegative(evidence.fees.total) / evidence.quantity : null,
    costs:evidence?.costs || plan.costs || null};
}

function executionObservations(execution, plan, horizons, byDate, history, asOfDate) {
  if (execution.status !== 'executable') return {};
  const rows = observations(execution.entryDate,execution.entryPrice,horizons,byDate,history,asOfDate);
  for (const row of Object.values(rows)) {
    row.netReturnPct = null;
    row.priceStatus = row.status;
    row.basis = 'fixed-close-observation';
    row.realized = false;
    if (row.status !== 'observed') continue;
    const bar = byDate.get(row.date);
    const close = execution.entryPrice * (1 + row.returnPct / 100);
    const entryBps = nonnegative(execution.costs?.entryBps), exitBps = nonnegative(execution.costs?.exitBps);
    row.exitAmbiguity = Boolean(plan.invalidationPrice && plan.targetPrice && [...byDate.values()].some(day =>
      day.date >= execution.entryDate && day.date <= row.date
      && price(day.low) && price(day.high) && day.low <= plan.invalidationPrice && day.high >= plan.targetPrice));
    if (row.date < execution.earliestSellDate || !historicalRules(bar,row.date)
      || bar.isFinal !== true || bar.suspended || !price(bar.volume) || close <= bar.lowerLimit
      || close > bar.upperLimit || execution.entryFeePerShare === null && entryBps === null
      || exitBps === null || exitBps >= 10000 || row.exitAmbiguity) {
      row.status = 'unverified';
      row.reason = row.exitAmbiguity ? '日线止盈止损先后顺序不明' : '可卖时间、最终退出行情或冻结成本未核验';
      continue;
    }
    const entryCost = execution.entryFeePerShare ?? execution.entryPrice * entryBps / 10000;
    row.netReturnPct = (close * (1 - exitBps / 10000) / (execution.entryPrice + entryCost) - 1) * 100;
  }
  return rows;
}

function evaluatePublishedEpisodes(batches = [], histories = new Map(), {asOfDate, horizons = DEFAULT_HORIZONS} = {}) {
  if (!validDate(asOfDate)) throw new Error('评价需要明确的截至交易日');
  const byBatch = new Map();
  let duplicateBatches = 0, excludedBatches = 0, excludedSignals = 0;
  for (const batch of batches) {
    const id = String(batch?.batchId || '');
    const published = Date.parse(batch?.publishedAt || '');
    const cutoff = Date.parse(batch?.inputCutoffAt || '');
    if (!id || !Number.isFinite(published) || !Number.isFinite(cutoff) || cutoff > published
      || published > Date.parse(`${asOfDate}T23:59:59+08:00`)
      || !batch.modelVersion || !validDate(batch.tradeDate)
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
        const entryPermission = String(item.entryPermission || item.strategyDecision?.entryPermission || 'watch');
        const setupType = String(item.setupType || '未分类');
        const triggered = entryPermission === 'allowed' && Boolean(item.triggeredAt || item.decisionEventType === 'entry-allowed');
        const evaluationGroup = track === 'B' ? `B:${triggered ? '触发' : '观察'}` : `A:${setupType}`;
        const container = item.plan || item.tradePlan || item.analysis?.tradePlan || item;
        const rawPlan = container.tradePlan ? {...container.tradePlan,...container} : container;
        const planId = String(item.planId || rawPlan.planId || '');
        const revision = item.planRevision ?? item.revision ?? rawPlan.planRevision ?? rawPlan.revision ?? null;
        const expiresAt = rawPlan.expiresAt || item.expiresAt || '';
        const plan = {earliestBuyDate:rawPlan.earliestBuyDate || item.earliestBuyDate || '',
          earliestSellDate:rawPlan.earliestSellDate || item.earliestSellDate || '',
          entryExpiryDate:rawPlan.entryExpiryDate || item.entryExpiryDate || clock(expiresAt).date,expiresAt,
          maxEntryPrice:price(rawPlan.maxEntryPrice ?? item.maxEntryPrice),
          invalidationPrice:price(rawPlan.invalidationPrice ?? item.invalidationPrice),
          targetPrice:price(rawPlan.targetPrice ?? rawPlan.target1 ?? rawPlan.targets?.[0]?.price ?? item.targetPrice),
          costs:rawPlan.costs || rawPlan.costAssumptions || item.costAssumptions || null};
        const rawEvent = item.triggerEvent || item.decisionEvent;
        const event = rawEvent ? {...rawEvent,occurredAt:rawEvent.occurredAt || rawEvent.observedAt,
          referencePrice:price(rawEvent.referencePrice ?? rawEvent.price)} : null;
        const state = [item.terminalState,item.planState,rawPlan.state,item.entryPermission,
          String(item.decisionEvent?.type || '').replace(/^entry-/, '')].find(value => TERMINAL_STATES.includes(value));
        const terminalState = item.invalidated ? 'invalidated'
          : TERMINAL_STATES.includes(state) ? state : item.terminal === true ? 'terminal' : '';
        signals.push({code, track, strategyId, modelVersion:batch.modelVersion, signalId:item.signalId, batchId:batch.batchId,
          tradeDate:batch.tradeDate, publishedAt:batch.publishedAt,inputCutoffAt:batch.inputCutoffAt,
          referencePrice:price(item.quote?.price ?? item.price), invalidated:Boolean(item.invalidated),
          entryPermission, triggeredAt:item.triggeredAt || '', setupType, evaluationGroup,
          planId,revision,plan,terminalState,terminalAt:item.invalidatedAt || item.decisionEvent?.occurredAt || batch.inputCutoffAt,
          riskRejected:item.riskChecks?.allowed === false,triggerEvent:event,
          executionEvidence:item.executionEvidence ? {...item.executionEvidence,inputCutoffAt:batch.inputCutoffAt} : null});
      }
    }
  }
  signals.sort((a,b)=>Date.parse(a.publishedAt) - Date.parse(b.publishedAt)
    || Number(Boolean(b.terminalState)) - Number(Boolean(a.terminalState)));
  // Revisions retain separate research epochs, but cannot reopen a terminal plan.
  const episodes = [], open = new Map(), terminalPlans = new Map(), planExpiries = new Map();
  const planTriggers = new Set(), permissions = new Map();
  for (const signal of signals) {
    const base = `${signal.code}|${signal.track}|${signal.strategyId}|${signal.modelVersion}`;
    const key = `${base}|${signal.planId ? `plan:${signal.planId}:${signal.revision}` : signal.evaluationGroup}`;
    const lifecycle = signal.planId ? `${signal.code}|${signal.track}|${signal.planId}` : key;
    const prior = open.get(key);
    const merge = prior && (signal.planId || signal.tradeDate === prior.lastSeenDate
      || nextTradingDay(prior.lastSeenDate) === signal.tradeDate);
    let episode = merge ? prior : null;
    if (!episode) {
      episode = {...signal,episodeId:signal.planId ? key : signal.signalId,lifecycle,
        signalIds:[],lastSeenDate:signal.tradeDate,refreshCount:0,lastBatchId:signal.batchId,
        triggerEvents:[],executionEvidence:null,terminalState:'',terminalAt:null,planConflict:false};
      episodes.push(episode);
      open.set(key,episode);
    }
    const permissionKey = signal.planId ? lifecycle : episode.episodeId;
    if (!permissions.has(permissionKey)) permissions.set(permissionKey,[]);
    episode.permissionEvents = permissions.get(permissionKey);
    episode.permissionEvents.push({at:signal.publishedAt,permission:signal.riskRejected ? 'blocked' : signal.entryPermission});
    episode.refreshCount++;
    if (!episode.signalIds.includes(signal.signalId)) episode.signalIds.push(signal.signalId);
    episode.lastBatchId = signal.batchId;
    episode.lastSeenDate = signal.tradeDate;
    if (signal.planId && JSON.stringify(episode.plan) !== JSON.stringify(signal.plan)) episode.planConflict = true;
    if (signal.planId && !planExpiries.has(lifecycle) && validDate(episode.plan.entryExpiryDate)) {
      planExpiries.set(lifecycle,episode.plan.expiresAt || `${episode.plan.entryExpiryDate}T23:59:59+08:00`);
    }
    const expiry = signal.planId ? planExpiries.get(lifecycle)
      : episode.plan.expiresAt || (validDate(episode.plan.entryExpiryDate) ? `${episode.plan.entryExpiryDate}T23:59:59+08:00` : null);
    const expired = expiry && Date.parse(signal.publishedAt) > Date.parse(expiry);
    const terminal = signal.planId ? terminalPlans.get(lifecycle)
      : episode.terminalState ? {state:episode.terminalState,at:episode.terminalAt} : null;
    if (terminal || signal.terminalState || expired) {
      const terminalTimeValid = Number.isFinite(Date.parse(signal.terminalAt))
        && Date.parse(signal.terminalAt) <= Date.parse(signal.publishedAt);
      const state = terminal || {state:signal.terminalState || 'expired',
        at:expired ? expiry : terminalTimeValid ? signal.terminalAt : signal.inputCutoffAt};
      episode.terminalState = state.state;
      episode.terminalAt = state.at;
      if (signal.planId) terminalPlans.set(lifecycle,state);
    }
    const event = signal.triggerEvent;
    const time = Date.parse(event?.occurredAt || '');
    const eventDate = clock(event?.occurredAt).date;
    const validTrigger = signal.entryPermission === 'allowed' && !signal.riskRejected && !episode.terminalState && event?.type === 'entry-allowed'
      && event.id && event.verified === true && event.source && Number.isFinite(time)
      && time <= Date.parse(signal.inputCutoffAt) && eventDate >= episode.tradeDate
      && isTradingDay(eventDate) === true && price(event.referencePrice)
      && (!event.planId || event.planId === episode.planId)
      && (event.revision == null || String(event.revision) === String(episode.revision))
      && (!validDate(episode.plan.entryExpiryDate) || eventDate <= episode.plan.entryExpiryDate)
      && (!episode.plan.expiresAt || time <= Date.parse(episode.plan.expiresAt));
    if (validTrigger && !episode.triggerEvents.length && (!signal.planId || !planTriggers.has(lifecycle))) {
      episode.triggerEvents.push({...event});
      if (signal.planId) planTriggers.add(lifecycle);
      episode.triggeredAt = event.occurredAt;
      episode.entryPermission = 'allowed';
      if (episode.track === 'B') episode.evaluationGroup = 'B:触发';
    }
    // A fill may be recorded after invalidation; its actual time still governs validity.
    if (signal.executionEvidence && (!episode.executionEvidence
      || episode.executionEvidence.type === 'quote' && signal.executionEvidence.type === 'fill')) {
      episode.executionEvidence = signal.executionEvidence;
    }
  }
  for (const episode of episodes) {
    const terminal = episode.planId && terminalPlans.get(episode.lifecycle);
    if (terminal) { episode.terminalState = terminal.state; episode.terminalAt = terminal.at; }
    else if (!episode.terminalState && validDate(episode.plan.entryExpiryDate) && asOfDate > episode.plan.entryExpiryDate) {
      episode.terminalState = 'expired';
      episode.terminalAt = episode.plan.expiresAt || `${episode.plan.entryExpiryDate}T23:59:59+08:00`;
    }
  }
  const counts = {publishedBatches:byBatch.size,publishedSignals:signals.length, episodes:episodes.length,
    observations:{observed:0,immature:0,missing:0},
    execution:{executable:0,unfilled:0,unverified:0,immature:0},
    nextOpenProxy:{executable:0,unfilled:0,unverified:0,immature:0},
    triggerObservations:{observed:0,immature:0,missing:0},
    executionObservations:{observed:0,immature:0,missing:0,unverified:0},
    triggers:episodes.reduce((sum,row) => sum + row.triggerEvents.length,0),
    groups:Object.fromEntries([...new Set(episodes.map(row => row.evaluationGroup))]
      .map(group => [group,episodes.filter(row => row.evaluationGroup === group).length]))};
  for (const episode of episodes) {
    const history = histories instanceof Map ? histories.get(episode.code) : histories[episode.code];
    const bars = Array.isArray(history) ? history : history?.bars || [];
    const byDate = new Map(bars.map(bar=>[String(bar.date || ''),bar]));
    episode.observations = observations(episode.tradeDate,episode.referencePrice,horizons,byDate,history,asOfDate);
    episode.publicationObservations = episode.observations;
    const trigger = episode.triggerEvents[0];
    episode.triggerObservations = trigger
      ? observations(clock(trigger.occurredAt).date,price(trigger.referencePrice),horizons,byDate,history,asOfDate) : {};
    episode.nextOpenProxy = nextOpenProxy(episode,byDate,asOfDate);
    episode.nextOpenProxy.observations = episode.nextOpenProxy.status === 'executable'
      ? observations(episode.nextOpenProxy.entryDate,episode.nextOpenProxy.entryPrice,horizons,byDate,history,asOfDate) : {};
    episode.execution = verifiedExecution(episode,byDate,asOfDate);
    episode.executionObservations = executionObservations(episode.execution,episode.plan,horizons,byDate,history,asOfDate);
    for (const field of ['observations','triggerObservations','executionObservations']) {
      for (const row of Object.values(episode[field])) counts[field][row.status]++;
    }
    counts.execution[episode.execution.status]++;
    counts.nextOpenProxy[episode.nextOpenProxy.status]++;
  }
  const cohorts = Object.fromEntries([['publication','observations'],['trigger','triggerObservations'],['execution','executionObservations']]
    .map(([name,field]) => {
      const mature = episodes.filter(row => horizons.length && horizons.every(horizon => row[field][horizon]?.status === 'observed'));
      return [name,{count:mature.length,episodeIds:mature.map(row => row.episodeId),
        horizons:Object.fromEntries(horizons.map(horizon => [horizon,{count:mature.length,
          meanReturnPct:mature.length ? mature.reduce((sum,row) => sum + row[field][horizon].returnPct,0) / mature.length : null,
          meanNetReturnPct:name === 'execution' && mature.length
            ? mature.reduce((sum,row) => sum + row[field][horizon].netReturnPct,0) / mature.length : null}]))}];
    }));
  const evaluationFields = ['observations','triggerObservations','nextOpenProxyObservations','executionObservations'];
  const horizonSummaries = {};
  for (const horizon of horizons) {
    horizonSummaries[horizon] = {};
    for (const field of evaluationFields) {
      const values = episodes.filter(row => field !== 'executionObservations' || row.execution?.verified === true)
        .map(row => field === 'nextOpenProxyObservations' ? row.nextOpenProxy?.observations?.[horizon] : row[field]?.[horizon]);
      const returns = values.filter(row => row?.status === 'observed')
        .map(row => field === 'executionObservations' ? row.netReturnPct : row.returnPct)
        .filter(Number.isFinite).sort((a,b) => a-b);
      horizonSummaries[horizon][field] = {count:returns.length,
        immature:values.filter(row => row?.status === 'immature').length,
        missing:values.filter(row => row?.status === 'missing').length,
        meanReturnPct:returns.length ? returns.reduce((sum,value) => sum + value,0)/returns.length : null,
        medianReturnPct:returns.length ? returns[Math.floor((returns.length-1)/2)] : null};
    }
  }
  const pairedWindows = Object.fromEntries([[1,3,5],[1,3,5,10],[20,60]].filter(window => window.every(horizon => horizons.includes(horizon)))
    .map(window => {
      const fields = Object.fromEntries([['publication','observations'],['trigger','triggerObservations'],['execution','executionObservations']]
        .map(([name,field]) => {
          const mature = episodes.filter(row => window.every(horizon => row[field]?.[horizon]?.status === 'observed'));
          return [name,{count:mature.length,notMature:episodes.length-mature.length,
            episodeIds:mature.map(row => row.episodeId),
            horizons:Object.fromEntries(window.map(horizon => [horizon,{
              meanReturnPct:mature.length ? mature.reduce((sum,row) => sum + row[field][horizon].returnPct,0)/mature.length : null,
              meanNetReturnPct:name === 'execution' && mature.length
                ? mature.reduce((sum,row) => sum + row[field][horizon].netReturnPct,0)/mature.length : null}]))}];
        }));
      return [window.join('/'),fields];
    }));
  return {schemaVersion:2,asOfDate,horizons,sourceType:'published-ledger',duplicateBatches,excludedBatches,
    excludedSignals,counts,episodes,cohorts,horizonSummaries,pairedWindows};
}

module.exports = {evaluatePublishedEpisodes,mergeSavedReportCloses,assessForwardValidation};
