const {createResearchAccount, executeResearchOrder, markResearchAccount} = require('./research-account');
const {clock, isTradingDay, nextTradingDay} = require('./trade-time');
const {VERSION: THEME_VERSION} = require('./theme-shadow-experiments');
const {isDeepStrictEqual} = require('node:util');

const PARAMETER_VERSION = 'plan10-08v2';
const QUALITY_VERSION = 'close-quality-20261103-shadow-v5';
const PERIODS = {short:5,swing:20,long:60};
const LIMITS = {maxSingleWeight:.2,maxGrossWeight:.8,maxThemeWeight:.4};
const copy = value => JSON.parse(JSON.stringify(value));
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const timestamp = value => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function createStrategyExperimentManifest({freezeDate,modelVersion,initialCapital = 100000,rules,frozenAt} = {}) {
  if (!validDate(freezeDate) || !modelVersion || typeof modelVersion !== 'string' || !positive(initialCapital)) {
    throw new Error('Explicit freezeDate, modelVersion and positive initialCapital required');
  }
  for (const key of ['commissionRate','minimumCommission','stampDutyRate','transferFeeRate','slippageBps','lotSize']) {
    if (typeof rules?.[key] !== 'number' || !Number.isFinite(rules[key]) || rules[key] < 0) throw new Error(`Invalid explicit rule: ${key}`);
  }
  if (!Number.isInteger(rules.lotSize) || rules.lotSize < 1 || rules.tPlusOne !== true
    || rules.slippageBps >= 10000 || ['commissionRate','stampDutyRate','transferFeeRate'].some(key=>rules[key] >= 1)) {
    throw new Error('Invalid lot size, T+1 or transaction assumptions');
  }
  for (const [key,limit] of Object.entries(LIMITS)) {
    if (rules[key] !== undefined && (!positive(rules[key]) || rules[key] > limit)) throw new Error(`Invalid risk budget: ${key}`);
  }
  const at = frozenAt || `${freezeDate}T00:00:00+08:00`;
  if (!Number.isFinite(timestamp(at)) || clock(at).date !== freezeDate) throw new Error('Invalid frozenAt');
  return freeze({schemaVersion:1,parameterVersion:PARAMETER_VERSION,freezeDate,frozenAt:at,modelVersion,initialCapital,
    shadowOnly:true,promotionAllowed:false,
    rules:{...copy(rules),...Object.fromEntries(Object.entries(LIMITS).map(([key,value])=>[key,rules[key] ?? value]))},
    parameters:{periods:PERIODS,minimumSectorCoverage:.6,minimumSectorMembers:10,minimumRewardRisk:2,
      targetFractions:[.3,.3,.4],protectionAtr:.5},
    validation:{minimumNewTradingDays:20,minimumMatureEpisodes:30,tailTolerancePct:2,
      drawdownTolerancePct:2,coverageFloorVsBaseline:.25,netExcessMustExceed:0},
    experiments:[{id:'baseline',baselineId:'baseline',change:'frozen structural stop and full first target'},
      {id:'H1',baselineId:'baseline',change:'market deceleration filter'},
      {id:'H2',baselineId:'baseline',change:'same-date sector diffusion filter'},
      {id:'H3',baselineId:'baseline',change:'frozen target and net RR >= 2'},
      {id:'H4',baselineId:'baseline',change:'declared time exit, 30/30/40 and cost protection'}]});
}

function createWeeklyQualityManifest({frozenAt,modelVersion} = {}) {
  if (!Number.isFinite(timestamp(frozenAt)) || !modelVersion) throw new Error('每周质量实验需要冻结时点和模型版本');
  return freeze({version:QUALITY_VERSION,frozenAt,firstTradeDate:nextTradingDay(clock(frozenAt).date),
    modelVersion,shadowOnly:true,promotionAllowed:false,
    validation:{minimumNewTradingDays:20,minimumMatureEpisodesPerRoute:30},
    experiments:[{id:'Q1',change:'B组可行首次回踩且业务主题已确认'},
      {id:'Q2',change:'风险释放隔夜重置及连续广度与板块衰减联合降级'},
      {id:'Q3',change:'新入场与原持仓退出分离'},
      {id:'S1',change:'Q1基础上验证现价未超过冻结最高入场价'},
      {id:'S2',change:'同口径多日板块资金方向确认'},
      {id:'S3',change:'独立否决当日已确认板块资金回撤'}]});
}

function evaluateWeeklyQualityShadow(item = {},{manifest,tradeDate,cutoffAt,marketRegime,sector} = {}) {
  const decision = (id,status,reason) => ({id,version:QUALITY_VERSION,status,reasons:[reason],shadowOnly:true});
  const unknown = reason => ['Q1','Q2','Q3','S1','S2','S3'].map(id=>decision(id,'unknown',reason));
  if (!manifest || manifest.version !== QUALITY_VERSION || manifest.modelVersion !== item.modelVersion
    || tradeDate < manifest.firstTradeDate || !Number.isFinite(timestamp(cutoffAt))
    || timestamp(cutoffAt) < timestamp(manifest.frozenAt)) return unknown('before-prospective-start');
  const feasible = item.planState?.feasibility?.status;
  const relation = item.momentumDecision?.profile?.businessRelation;
  const relationEvidence = item.momentumDecision?.profile?.businessRelationEvidence;
  const relationObservedAt = timestamp(relationEvidence?.observedAt);
  const businessUnverified = !['confirmed-industry','confirmed-business'].includes(relation)
    || !relationEvidence?.source || !/^https:\/\//.test(relationEvidence?.url || '')
    || !relationEvidence?.excerpt || !Number.isFinite(relationObservedAt)
    || relationObservedAt > timestamp(cutoffAt);
  const q1 = item.track !== 'B' ? decision('Q1','pass','A-route-unchanged')
    : businessUnverified ? decision('Q1','unknown','business-theme-unverified')
      : feasible === 'feasible' && item.momentumDecision?.firstPullback && !item.momentumDecision?.noChase
      ? decision('Q1','pass','B-first-pullback-feasible')
      : feasible === 'unknown' || !feasible ? decision('Q1','unknown','B-price-evidence-missing')
        : decision('Q1','fail','B-observation-only');
  const path = marketRegime?.shadowPath;
  const marketCurrent = evidenceCurrent(marketRegime,{tradeDate,cutoffAt});
  const sectorCurrent = evidenceCurrent(sector,{tradeDate,cutoffAt});
  const premium = path?.priorLimitUpPremium;
  const retreat = sectorCurrent && sector?.rotationIntraday?.retreating === true;
  const premiumWeak = premium?.coverage >= .6 && Number.isFinite(premium.averageChangePct)
    && premium.averageChangePct < 0;
  const explicitRiskOff = marketCurrent && (marketRegime?.riskOff === true
    || ['risk-release','broad-weak'].includes(marketRegime?.key));
  const q2 = explicitRiskOff
    ? decision('Q2','fail','market-risk-off')
    : !marketCurrent || !Number.isFinite(path?.continuousPeakBreadthDropPp)
    ? decision('Q2','unknown','continuous-market-path-missing')
    : path.continuousPeakBreadthDropPp >= 8 && (retreat || premiumWeak)
      ? decision('Q2','fail','breadth-and-sector-or-premium-retreat')
      : !sectorCurrent && !premiumWeak ? decision('Q2','unknown','sector-and-premium-evidence-missing')
        : decision('Q2','pass','combined-retreat-not-observed');
  const multiDay = sectorCurrent && !sector?.capitalEstimated && !sector?.capitalStale
    && sector?.windowContract?.comparable === true
    && Number.isFinite(sector?.mainNet3) && Number.isFinite(sector?.mainNet5);
  const s2 = item.track !== 'B' ? decision('S2','pass','A-route-unchanged')
    : !multiDay ? decision('S2','unknown','comparable-multiday-funds-missing')
      : sector.mainNet3 > 0 && sector.mainNet5 > 0
        ? decision('S2','pass','multiday-funds-positive') : decision('S2','fail','single-day-rebound-not-confirmed');
  const entryCeiling = Number(item.planState?.tradePlan?.maxEntryPrice ?? item.planState?.maxEntryPrice);
  const price = Number(item.price);
  const s1 = q1.status !== 'pass' ? decision('S1',q1.status,q1.reasons[0])
    : item.track !== 'B' ? decision('S1','pass','A-route-unchanged')
      : !positive(entryCeiling) || !positive(price) ? decision('S1','unknown','frozen-entry-ceiling-or-price-missing')
        : price <= entryCeiling ? decision('S1','pass','below-frozen-entry-ceiling')
          : decision('S1','fail','price-above-frozen-entry-ceiling');
  const s3 = explicitRiskOff ? decision('S3','fail','market-risk-off')
    : !sectorCurrent ? decision('S3','unknown','current-sector-rotation-missing')
      : retreat ? decision('S3','fail','sector-intraday-retreat')
        : sector.rotationIntraday?.retreating === false ? decision('S3','pass','sector-retreat-not-observed')
          : decision('S3','unknown','sector-retreat-not-measured');
  return [q1,q2,decision('Q3','pass','independent-holding-exit-replay'),s1,s2,s3];
}

const result = (status,reason) => ({status,reasons:[reason]});
const planOf = item => item?.planState?.tradePlan || item?.analysis?.tradePlan || item?.tradePlan || item?.plan || {};
const periodOf = plan => PERIODS[plan.horizon || plan.period] || ([5,20,60].includes(plan.holdingPeriodTradingDays) ? plan.holdingPeriodTradingDays : null);
const planIdOf = item => item.planId || item.planState?.planId || planOf(item).planId;
const themesOf = item => Array.isArray(item?.themes) ? [...new Set(item.themes.filter(theme=>typeof theme === 'string' && theme.trim()))].sort() : [];
function entryGate(item,context) {
  const plan = planOf(item), event = item.triggerEvent || item.decisionEvent || item.planState?.decisionEvent;
  const assessment = item.entryAssessment || item.analysis?.entryAssessment;
  if (item.entryPermission !== 'allowed') return result('fail','not-allowed');
  if (assessment?.allowed === false || assessment?.contextRisks?.length || item.invalidated
    || ['invalidated','expired','completed','cancelled','blocked'].includes(item.planState?.state || item.planState || plan.state)
    || plan.enabled === false) return result('fail','plan-terminal-or-blocked');
  if (!validDate(context.tradeDate) || isTradingDay(context.tradeDate) !== true || !Number.isFinite(timestamp(context.cutoffAt))
    || clock(context.cutoffAt).date !== context.tradeDate) return result('unknown','decision-clock-missing');
  if (!planIdOf(item) || plan.planId && plan.planId !== planIdOf(item) || !event?.id || event.planId !== planIdOf(item)
    || event.verified !== true || !event.source || event.type !== 'entry-allowed' || !positive(event.referencePrice)
    || !Number.isFinite(timestamp(event.occurredAt)) || clock(event.occurredAt).date !== context.tradeDate
    || timestamp(event.occurredAt) > timestamp(context.cutoffAt)
    || event.revision != null && plan.revision != null && String(event.revision) !== String(plan.revision)) {
    return result('unknown','validated-trigger-missing');
  }
  if (!Number.isFinite(timestamp(plan.frozenAt)) || timestamp(plan.frozenAt) > timestamp(event.occurredAt)
    || !positive(plan.maxEntryPrice) || !positive(plan.entryLow ?? plan.minEntryPrice)
    || (plan.entryLow ?? plan.minEntryPrice) > plan.maxEntryPrice || !positive(plan.invalidationPrice)
    || !positive(plan.targets?.[0]?.price) || plan.invalidationPrice >= plan.maxEntryPrice
    || !validDate(plan.entryExpiryDate) || plan.earliestBuyDate && isTradingDay(plan.earliestBuyDate) !== true) return result('unknown','frozen-plan-missing');
  if (context.tradeDate > plan.entryExpiryDate) return result('fail','plan-expired');
  if (event.referencePrice > plan.maxEntryPrice || event.referencePrice < (plan.entryLow ?? plan.minEntryPrice)
    || event.referencePrice <= plan.invalidationPrice || event.referencePrice >= plan.targets[0].price) {
    return result('fail','trigger-outside-price-bounds');
  }
  return result('pass','validated-frozen-trigger');
}
function evidenceCurrent(row,context) {
  const date = row?.tradeDate || row?.date;
  return row && date === context.tradeDate && !row.stale && !row.cached && !row.estimated
    && row.status !== 'unknown' && row.available !== false
    && Number.isFinite(timestamp(row.observedAt)) && timestamp(row.observedAt) <= timestamp(context.cutoffAt);
}
function h3Gate(plan,event) {
  const target = plan.targetEvidence;
  if (target?.status !== 'verified' || !target.source || target.observedAt && (!Number.isFinite(timestamp(target.observedAt)) || timestamp(target.observedAt) > timestamp(event.occurredAt))
    || !Number.isFinite(plan.rewardRisk)) return result('unknown','verified-target-or-RR-missing');
  return plan.rewardRisk >= 2 ? result('pass','frozen-RR2') : result('fail','RR-below-2');
}
function h4Gate(plan) {
  const period = periodOf(plan);
  if (!period || !Number.isInteger(plan.timeExitTradingDays) || !positive(plan.atr ?? plan.atr14)
    || !positive(plan.targets?.[1]?.price)) return result('unknown','declared-exit-missing');
  if (period !== plan.timeExitTradingDays || plan.targets[1].price <= plan.targets[0].price) return result('fail','invalid-declared-exit');
  return result('pass','declared-period-exit');
}
function evaluateStrategyExperiments(item = {},context = {}) {
  const base = entryGate(item,context), plan = planOf(item);
  let market = result('unknown','market-evidence-missing');
  if (evidenceCurrent(context.marketRegime,context)) {
    const row = context.marketRegime;
    market = row.riskOff === true || row.breadthTrend === '\u660e\u663e\u8d70\u5f31'
      || row.shadowPath?.continuousPeakBreadthDropPp >= 8 ? result('fail','market-deceleration')
      : row.shadowPath && row.shadowPath.continuousPeakBreadthDropPp == null ? result('unknown','market-path-missing')
      : row.riskOff === false && ['\u57fa\u672c\u7a33\u5b9a','\u660e\u663e\u8d70\u5f3a'].includes(row.breadthTrend)
        ? result('pass','market-not-decelerating') : result('unknown','market-deceleration-unknown');
  }
  const sector = context.sector || item.rotationProfiles?.[0], rotation = sector?.shadowRotation;
  const coverage = sector?.participation || sector?.coverage || {};
  let diffusion = result('unknown','sector-diffusion-missing');
  if (evidenceCurrent(sector,context) && evidenceCurrent({...rotation,tradeDate:rotation?.tradeDate || sector.tradeDate},context)
    && Number.isFinite(coverage.coverage) && coverage.coverage >= .6
    && (coverage.memberCount ?? coverage.breadthCount ?? sector.count) >= 10
    && !coverage.sampleLimited && !rotation.sampleLimited) {
    diffusion = ['\u6269\u6563\u786e\u8ba4','\u5206\u6b67\u4ecd\u6709\u627f\u63a5'].includes(rotation.phase || rotation.state)
      ? result('pass','same-date-diffusion') : ['unknown','\u5f85\u786e\u8ba4',undefined].includes(rotation.phase || rotation.state)
        ? result('unknown','sector-phase-unknown') : result('fail','sector-not-diffusing');
  }
  const gates = [base,market,diffusion,h3Gate(plan,item.triggerEvent || item.decisionEvent || item.planState?.decisionEvent || {}),h4Gate(plan)];
  const shadowBase = context.shadowEntry ? entryGate(context.shadowEntry,context) : base;
  const shadowTarget = context.shadowEntry ? h3Gate(planOf(context.shadowEntry),context.shadowEntry.planState?.decisionEvent || {}) : gates[3];
  return ['baseline','H1','H2','H3','H4'].map((id,index)=>({id,baselineId:'baseline',
    ...(id === 'H3' ? shadowBase.status !== 'pass' ? shadowBase : shadowTarget : base.status !== 'pass' ? base : gates[index]),shadowOnly:true}));
}

function barError(bar,date) {
  if (!bar || (bar.tradeDate || bar.date) !== date || bar.quoteDate && bar.quoteDate !== date
    || bar.isFinal !== true || !bar.source || bar.stale || bar.cached || bar.estimated || bar.error || bar.adjustment !== 'none'
    || !['open','high','low','close'].every(key=>positive(bar[key])) || !(positive(bar.volume) || bar.suspended === true && bar.volume === 0)
    || bar.low > Math.min(bar.open,bar.close) || bar.high < Math.max(bar.open,bar.close) || bar.low > bar.high) return 'completed-source-or-quote-date-missing';
  const rules = bar.tradeRules;
  if (rules?.verified !== true || rules.tradeDate !== date || !rules.source || rules.tPlusOne !== true
    || !positive(bar.lowerLimit) || !positive(bar.upperLimit) || bar.lowerLimit >= bar.upperLimit
    || bar.low < bar.lowerLimit || bar.high > bar.upperLimit || typeof bar.suspended !== 'boolean') return 'historical-limits-missing';
  return '';
}
function evaluateShadowExit(position,plan,bar,{tradeDate,heldTradingDays,baseline = false} = {}) {
  const answer = (status,reason,quantity = 0,price = null) => ({status,exit:status === 'exit',conditional:true,reason,quantity,price,shadowOnly:true});
  if (isTradingDay(tradeDate) !== true || !Number.isInteger(heldTradingDays) || heldTradingDays < 0) return answer('unknown','holding-clock-missing');
  const error = barError(bar,tradeDate);
  if (error) return answer('unknown',error);
  if (bar.suspended) return answer('blocked','suspended');
  if (bar.open <= bar.lowerLimit && bar.high <= bar.lowerLimit) return answer('blocked','lower-limit-locked');
  if (!positive(position?.quantity) || !Array.isArray(position.lots) || !position.lots.length
    || position.lots.some(lot=>!validDate(lot.tradeDate) || isTradingDay(lot.tradeDate) !== true || lot.tradeDate > tradeDate || !Number.isInteger(lot.remaining) || lot.remaining < 0)
    || position.lots.reduce((sum,lot)=>sum+lot.remaining,0) !== position.quantity) return answer('unknown','position-lots-missing');
  const available = position.lots.filter(lot=>lot.tradeDate < tradeDate).reduce((sum,lot)=>sum+lot.remaining,0);
  if (!available) return answer('blocked','T+1');
  if (!positive(plan?.invalidationPrice) || !positive(plan.targets?.[0]?.price)) return answer('unknown','exit-plan-missing');
  if (!baseline && h4Gate(plan).status !== 'pass') return answer('unknown','declared-exit-missing');
  const lotSize = position.lotSize || 100;
  const initial = position.initialQuantity || position.quantity;
  const tranche = Math.min(initial,Math.max(lotSize,Math.floor(initial * .3 / lotSize) * lotSize));
  const firstSold = position.firstTargetSoldQuantity ?? (position.firstTargetFilled ? tranche : 0);
  const secondSold = position.secondTargetSoldQuantity ?? (position.secondTargetFilled ? tranche : 0);
  const stage = tranche > 0 && secondSold >= tranche ? 2 : tranche > 0 && firstSold >= tranche ? 1 : 0;
  let stop = plan.invalidationPrice, protectedCost = false;
  if (!baseline && firstSold > 0) {
    const cost = position.weightedCostPrice ?? position.costPrice;
    if (!positive(cost)) return answer('unknown','actual-weighted-cost-missing');
    const protection = cost + .5 * (plan.atr ?? plan.atr14);
    protectedCost = protection > stop;
    stop = Math.max(stop,protection);
  }
  const target = plan.targets[baseline ? 0 : stage]?.price;
  let reason,price,quantity = available;
  if (bar.open <= stop) { reason = 'gap-stop'; price = bar.open; }
  else if (bar.low <= stop) {
    reason = positive(target) && bar.high >= target ? 'ambiguous-stop-first' : protectedCost ? 'cost-protection' : 'structural-stop';
    price = stop;
  } else if (!baseline && heldTradingDays >= plan.timeExitTradingDays) { reason = 'time-exit'; price = bar.close; }
  else if (positive(target) && bar.high >= target) {
    reason = `target-${(baseline ? 0 : stage) + 1}`;
    price = target;
    if (!baseline && stage < 2) quantity = Math.min(available,tranche-(stage === 0 ? firstSold : secondSold));
  } else return answer('hold','no-exit');
  if (price <= bar.lowerLimit) return answer('blocked','lower-limit-no-fill');
  quantity = Math.floor(quantity / lotSize) * lotSize;
  if (!quantity) return answer('blocked','quantity-below-lot-size');
  return answer('exit',reason,quantity,price);
}

function daysBetween(start,end) {
  let date = start,days = 0;
  while (date < end) {
    date = nextTradingDay(date);
    if (!date) return null;
    if (date <= end) days++;
  }
  return days;
}
function fees(amount,side,rules) {
  return Math.max(rules.minimumCommission,amount * rules.commissionRate)
    + amount * rules.transferFeeRate + (side === 'sell' ? amount * rules.stampDutyRate : 0);
}
// Account helpers use wall clocks; replace only their audit timestamps, not global time.
function deterministicAccount(account,date) {
  account.orders.forEach(row=>{ if (row.filledAt) row.filledAt = `${row.tradeDate}T15:00:00+08:00`; if (row.recordedAt) row.recordedAt = `${row.tradeDate}T15:00:00+08:00`; });
  account.fills.forEach(row=>{ row.filledAt = `${row.tradeDate}T15:00:00+08:00`; });
  if (account.markedAt) account.markedAt = `${date}T15:00:00+08:00`;
  return account;
}
function quantileTail(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b)=>a-b);
  return sorted[Math.floor((sorted.length - 1) * .05)];
}
function drawdown(curve,initialCapital) {
  let peak = initialCapital,max = 0;
  for (const row of curve) { peak = Math.max(peak,row.equity); max = Math.max(max,(peak-row.equity)/peak*100); }
  return max;
}

function buildExperimentReplayInput(entries,histories,{manifest,asOfDate}) {
  const signals = (entries || []).flatMap(batch=>[...(batch.recommendations || []),...(batch.momentumRecommendations || [])]
    .map(row=>row.shadowDecisionInput).filter(row=>row && timestamp(row.cutoffAt) <= timestamp(`${asOfDate}T23:59:59+08:00`)));
  const codes = new Set(signals.map(row=>row.code));
  const prices = [...histories.entries()].filter(([code])=>codes.has(code)).flatMap(([code,history])=>
    (history?.bars || []).filter(row=>(row.date || row.tradeDate) >= manifest.freezeDate && (row.date || row.tradeDate) <= asOfDate)
      .map(row=>({...row,code,tradeDate:row.date || row.tradeDate,source:row.source || history.source})));
  return {manifest,asOfDate,signals,prices};
}

/** prices: flat completed OHLCV rows with code/tradeDate/source and verified historical tradeRules.
 * signals: immutable decision snapshots with cutoffAt, frozen tradePlan and verified triggerEvent.
 * Replay is a conservative next-session-open simulation, never proof of an actual broker fill. */
function replayStrategyExperiments({manifest,themeManifest,qualityManifest,signals,prices,asOfDate} = {}) {
  if (!manifest || !Array.isArray(signals) || !Array.isArray(prices) || !validDate(asOfDate) || asOfDate < manifest.freezeDate) throw new Error('Invalid offline replay inputs');
  const checked = createStrategyExperimentManifest(manifest);
  if (!isDeepStrictEqual(checked,manifest)) throw new Error('Manifest differs from frozen parameter contract');
  if (themeManifest && (themeManifest.version !== THEME_VERSION || themeManifest.modelVersion !== manifest.modelVersion
    || !Number.isFinite(timestamp(themeManifest.frozenAt)) || themeManifest.firstTradeDate && !validDate(themeManifest.firstTradeDate)))
    throw new Error('Invalid frozen theme experiment manifest');
  if (qualityManifest && !isDeepStrictEqual(qualityManifest,createWeeklyQualityManifest(qualityManifest)))
    throw new Error('Invalid frozen weekly quality manifest');
  const themeActive = Boolean(themeManifest?.firstTradeDate && themeManifest.firstTradeDate <= asOfDate);
  const qualityActive = Boolean(qualityManifest?.firstTradeDate && qualityManifest.firstTradeDate <= asOfDate);
  const experiments = [...manifest.experiments,
    ...(themeActive ? [{id:'themeBaseline',baselineId:'themeBaseline'},
      ...['H5','H6','H7'].map(id=>({id,baselineId:'themeBaseline'}))] : []),
    ...(qualityActive ? [{id:'qualityBaseline',baselineId:'qualityBaseline'},
      ...['Q1','Q2','Q3','S1','S2','S3'].map(id=>({id,baselineId:'qualityBaseline'}))] : [])];
  const endAt = timestamp(`${asOfDate}T23:59:59+08:00`), rules = manifest.rules;
  const byBar = new Map(), conflicts = new Set();
  for (const row of prices) {
    const date = row.tradeDate || row.date;
    if (!validDate(date) || date > asOfDate || row.observedAt && (!Number.isFinite(timestamp(row.observedAt)) || timestamp(row.observedAt) > endAt)) continue;
    const key = `${row.code}|${date}`;
    if (byBar.has(key) && JSON.stringify(byBar.get(key)) !== JSON.stringify(row)) conflicts.add(key);
    else byBar.set(key,row);
  }
  conflicts.forEach(key=>byBar.delete(key));
  const snapshots = [...signals].sort((a,b)=>(timestamp(a.cutoffAt || a.inputCutoffAt) || 0)-(timestamp(b.cutoffAt || b.inputCutoffAt) || 0)
    || String(a.code).localeCompare(String(b.code)) || String(a.signalId).localeCompare(String(b.signalId)));
  const dates = [];
  for (let date = manifest.freezeDate; date && date <= asOfDate; date = nextTradingDay(date)) {
    if (isTradingDay(date) === true) dates.push(date);
    else if (isTradingDay(date) === null) throw new Error('Replay calendar unavailable');
  }
  const variants = experiments.map(experiment=>{
    let account = createResearchAccount({accountId:`shadow-${experiment.id}`,initialCash:manifest.initialCapital,rules});
    const records = [], queue = [], episodes = [], seen = new Map(), terminal = new Set();
    for (const item of snapshots) {
      const context = {...item.context,tradeDate:item.tradeDate,cutoffAt:item.cutoffAt || item.inputCutoffAt,
        marketRegime:item.context?.marketRegime || item.marketRegime,sector:item.context?.sector || item.sector,shadowEntry:item.shadowEntry};
      const themeVariant = experiment.baselineId === 'themeBaseline';
      const qualityVariant = experiment.baselineId === 'qualityBaseline';
      const effective = ['H6','H7'].includes(experiment.id) && item.intradayPlanState
        ? {...item,planId:item.intradayPlanState.planId,entryPermission:item.intradayPlanState.currentPermission,
          planState:item.intradayPlanState,
          triggerEvent:item.intradayPlanState.decisionEvent,decisionEvent:item.intradayPlanState.decisionEvent,
          entryAssessment:{allowed:true}} : item;
      const key = `${item.code}|${planIdOf(effective) || item.signalId}`;
      const route = item.track === 'A' ? 'A' : item.track === 'B' ? 'B' : null;
      if (Number.isFinite(timestamp(context.cutoffAt)) && timestamp(context.cutoffAt) <= endAt
        && (item.invalidated || ['invalidated','expired','cancelled','completed','blocked'].includes(item.planState?.state || item.planState))) {
        terminal.add(key);
        queue.filter(row=>row.key === key).forEach(row=>{ row.terminalAt = context.cutoffAt; });
      }
      let gate;
      if (['Q1','Q2','Q3','S1','S2','S3'].includes(experiment.id)) {
        const frozen = item.shadowExperiments?.find(row=>row.id === experiment.id && row.version === qualityManifest.version);
        gate = frozen && ['pass','fail','unknown'].includes(frozen.status)
          ? {status:frozen.status,reasons:Array.isArray(frozen.reasons) && frozen.reasons.length ? frozen.reasons : ['frozen-decision']}
          : result('unknown','frozen-quality-decision-missing');
        if (gate.status === 'pass') {
          const entry = entryGate(item,context);
          if (entry.status !== 'pass') gate = entry;
        }
      } else if (['H5','H6','H7'].includes(experiment.id)) {
        const frozen = item.shadowExperiments?.find(row=>row.id === experiment.id && row.version === themeManifest.version);
        gate = frozen && ['pass','fail','unknown'].includes(frozen.status)
          ? {status:frozen.status,reasons:Array.isArray(frozen.reasons) && frozen.reasons.length ? frozen.reasons : ['frozen-decision']}
          : result('unknown','frozen-theme-decision-missing');
        if (gate.status === 'pass') {
          if (['H6','H7'].includes(experiment.id) && !item.intradayPlanState)
            gate = result('unknown','frozen-intraday-plan-missing');
          else {
            const formal = experiment.id === 'H7' ? entryGate(item,context) : result('pass','not-required');
            const entry = entryGate(effective,context);
            if (formal.status !== 'pass') gate = formal;
            else if (entry.status !== 'pass') gate = entry;
          }
        }
      } else gate = evaluateStrategyExperiments(item,context).find(row=>row.id === (themeVariant || qualityVariant ? 'baseline' : experiment.id));
      let status = gate.status,reason = gate.reasons[0];
      if (!/^\d{6}$/.test(String(item.code)) || !route || !item.signalId) { status = 'unknown'; reason = 'signal-identity-missing'; }
      if (!Number.isFinite(timestamp(context.cutoffAt)) || timestamp(context.cutoffAt) > endAt) { status = 'unknown'; reason = 'input-after-asof'; }
      if (timestamp(context.cutoffAt) < timestamp(manifest.frozenAt)) { status = 'fail'; reason = 'pre-freeze-development-data'; }
      if (themeVariant && (item.tradeDate < themeManifest.firstTradeDate
        || timestamp(context.cutoffAt) < timestamp(themeManifest.frozenAt))) { status = 'fail'; reason = 'pre-theme-freeze-data'; }
      if (qualityVariant && (item.tradeDate < qualityManifest.firstTradeDate
        || timestamp(context.cutoffAt) < timestamp(qualityManifest.frozenAt))) { status = 'fail'; reason = 'pre-quality-freeze-data'; }
      if (terminal.has(key)) { status = 'fail'; reason = 'plan-terminal-or-blocked'; }
      if (status !== 'pass') { records.push({code:item.code,signalId:item.signalId,route,status:status === 'fail' ? 'not-executed' : 'unknown',reason}); continue; }
      if (seen.has(key)) {
        const existing = seen.get(key);
        const beforeEntry = timestamp(context.cutoffAt) <= timestamp(`${existing.entryDate}T09:30:00+08:00`);
        if (beforeEntry && !existing.routes.includes(route)) existing.routes.push(route);
        if (beforeEntry) existing.themes = themesOf({themes:[...existing.themes,...themesOf(item)]});
        if (beforeEntry && !isDeepStrictEqual(existing.plan,planOf(item))) existing.conflict = true;
        records.push({code:item.code,signalId:item.signalId,route,status:'not-executed',reason:'duplicate-plan'});
        continue;
      }
      const selected = experiment.id === 'H3' && item.shadowEntry ? item.shadowEntry : effective;
      const event = selected.triggerEvent || selected.decisionEvent || selected.planState?.decisionEvent;
      const next = nextTradingDay(clock(event.occurredAt).date), plan = copy(planOf(selected));
      const entryDate = plan.earliestBuyDate && plan.earliestBuyDate > next ? plan.earliestBuyDate : next;
      const pending = {key,item,plan,planId:planIdOf(selected),entryDate,routes:[route],themes:themesOf(item)};
      seen.set(key,pending);
      queue.push(pending);
    }
    const active = new Map(), curve = [], missingMarks = [];
    for (const date of dates) {
      // Value at the session open for buy budgets; never spend closing-bar gains at the open.
      const openValues = new Map();
      let unknownBudget = false;
      for (const position of account.positions) {
        const row = byBar.get(`${position.code}|${date}`);
        if (barError(row,date)) unknownBudget = true;
        else openValues.set(position.code,position.quantity * row.open);
      }
      for (const pending of queue.filter(row=>row.entryDate === date)) {
        const {item,plan,routes} = pending, row = byBar.get(`${item.code}|${date}`);
        const record = {code:item.code,signalId:item.signalId,planId:pending.planId,routes,tradeDate:date,status:'not-executed'};
        let reason = '';
        const error = barError(row,date);
        if (pending.conflict) reason = 'conflicting-plan';
        else if (pending.terminalAt && timestamp(pending.terminalAt) <= timestamp(`${date}T09:30:00+08:00`)) reason = 'plan-terminal-or-blocked';
        else if (date > plan.entryExpiryDate) reason = 'plan-expired';
        else if (error) { reason = error; record.status = 'unknown'; }
        else if (row.suspended || row.open >= row.upperLimit || row.open <= row.lowerLimit) reason = 'suspension-or-limit';
        else if (active.has(item.code)) reason = 'same-code-already-funded';
        else if (unknownBudget) { reason = 'portfolio-mark-missing'; record.status = 'unknown'; }
        const price = row?.open * (1 + rules.slippageBps / 10000);
        if (!reason && (price > plan.maxEntryPrice || price < (plan.entryLow ?? plan.minEntryPrice) || price >= row.upperLimit
          || price <= plan.invalidationPrice || price >= plan.targets[0].price)) reason = 'entry-price-bounds';
        const themes = pending.themes;
        if (!reason && (!themes.length || account.positions.some(position=>!position.themes?.length))) { reason = 'theme-classification-missing'; record.status = 'unknown'; }
        const gross = [...openValues.values()].reduce((sum,value)=>sum+value,0),equity = account.cash + gross;
        let quantity = 0;
        if (!reason) {
          const themeValue = Math.max(...themes.map(theme=>account.positions.reduce((sum,position)=>sum+(position.themes.includes(theme) ? openValues.get(position.code) : 0),0)));
          let capacity = Math.min(account.cash,rules.maxSingleWeight*equity,
            rules.maxGrossWeight*equity-gross,rules.maxThemeWeight*equity-themeValue);
          if (positive(item.quantity)) capacity = Math.min(capacity,item.quantity*price);
          quantity = Math.max(0,Math.floor(capacity/price/rules.lotSize)*rules.lotSize);
          for (;quantity > 0;quantity -= rules.lotSize) {
            const amount = quantity*price,cost = fees(amount,'buy',rules),netEquity = equity-cost;
            if (amount+cost <= account.cash && amount <= rules.maxSingleWeight*netEquity
              && gross+amount <= rules.maxGrossWeight*netEquity && themeValue+amount <= rules.maxThemeWeight*netEquity) break;
          }
          if (!quantity) reason = 'risk-budget';
          if (!reason && ['H3','H6','H7'].includes(experiment.id)) {
            const entryCost = price + fees(quantity*price,'buy',rules)/quantity;
            const target = plan.targets[0].price*(1-rules.slippageBps/10000);
            const stop = (plan.stressExitPrice || plan.invalidationPrice)*(1-rules.slippageBps/10000);
            const reward = target-fees(quantity*target,'sell',rules)/quantity-entryCost;
            const risk = entryCost-stop+fees(quantity*stop,'sell',rules)/quantity;
            if (!(risk > 0 && reward/risk >= 2)) reason = 'actual-fill-RR-below-2';
          }
        }
        if (reason) { records.push({...record,reason}); continue; }
        const order = {orderId:`${experiment.id}:${pending.key}:buy`,side:'buy',code:item.code,name:item.name,
          quantity,price,tradeDate:date,themes};
        const executed = executeResearchOrder(account,order);
        if (!executed.ok) { records.push({...record,reason:executed.reason}); continue; }
        account = deterministicAccount(executed.account,date);
        openValues.set(item.code,quantity*row.open);
        const episode = {code:item.code,planId:pending.planId,routes,entryDate:date,quantity,
          cost:quantity*price+executed.fill.fees.total,proceeds:0,remaining:quantity,plan,
          period:periodOf(plan) || (routes.includes('A') ? 20 : 5),firstTargetSoldQuantity:0,secondTargetSoldQuantity:0};
        active.set(item.code,episode);
        episodes.push(episode);
        records.push({...record,status:'executed',reason:'verified-next-session-open',quantity,price,
          partial:positive(item.quantity) && quantity < item.quantity,fees:executed.fill.fees});
      }
      for (const [code,episode] of active) {
        const position = account.positions.find(row=>row.code === code);
        const decision = evaluateShadowExit({...position,initialQuantity:episode.quantity,lotSize:rules.lotSize,
          firstTargetSoldQuantity:episode.firstTargetSoldQuantity,secondTargetSoldQuantity:episode.secondTargetSoldQuantity},episode.plan,
        byBar.get(`${code}|${date}`),{tradeDate:date,heldTradingDays:daysBetween(episode.entryDate,date),
          baseline:!['H4','Q3'].includes(experiment.id)});
        if (decision.status === 'hold') continue;
        if (decision.status !== 'exit') { records.push({code,tradeDate:date,side:'sell',status:decision.status,reason:decision.reason}); continue; }
        const price = decision.price*(1-rules.slippageBps/10000),row = byBar.get(`${code}|${date}`);
        if (price <= row.lowerLimit) { records.push({code,tradeDate:date,side:'sell',status:'blocked',reason:'slippage-below-limit'}); continue; }
        const executed = executeResearchOrder(account,{orderId:`${experiment.id}:${code}:${episode.planId}:${episode.entryDate}:${date}:sell`,
          code,side:'sell',quantity:decision.quantity,price,tradeDate:date});
        if (!executed.ok) { records.push({code,tradeDate:date,side:'sell',status:'blocked',reason:executed.reason}); continue; }
        account = deterministicAccount(executed.account,date);
        episode.proceeds += decision.quantity*price-executed.fill.fees.total;
        episode.remaining -= decision.quantity;
        if (decision.reason === 'target-1') episode.firstTargetSoldQuantity += decision.quantity;
        if (decision.reason === 'target-2') episode.secondTargetSoldQuantity += decision.quantity;
        if (!episode.remaining) { episode.exitDate = date; active.delete(code); }
        records.push({code,tradeDate:date,side:'sell',status:'executed',reason:decision.reason,quantity:decision.quantity,price,fees:executed.fill.fees});
      }
      const quotes = account.positions.flatMap(position=>{
        const row = byBar.get(`${position.code}|${date}`);
        if (barError(row,date)) { missingMarks.push({code:position.code,tradeDate:date}); return []; }
        return [{code:position.code,price:row.close,tradeDate:date,status:'final'}];
      });
      account = deterministicAccount(markResearchAccount(account,quotes,date),date);
      const routeEquity = Object.fromEntries(['A','B'].map(route=>[route,manifest.initialCapital+episodes.filter(row=>row.routes.includes(route)).reduce((sum,row)=>{
        const position = account.positions.find(position=>position.code === row.code);
        return sum+row.proceeds+(row.remaining ? (position?.currentPrice || 0)*row.remaining : 0)-row.cost;
      },0)]));
      curve.push({tradeDate:date,equity:account.equity,complete:account.positions.every(row=>row.quoteStatus === 'fresh'),routeEquity});
    }
    for (const pending of queue.filter(row=>!row.entryDate || row.entryDate > asOfDate || !dates.includes(row.entryDate))) {
      records.push({code:pending.item.code,signalId:pending.item.signalId,routes:pending.routes,status:'unknown',reason:'next-session-not-available'});
    }
    const trades = episodes.map(row=>{
      const elapsed = daysBetween(row.entryDate,asOfDate);
      const mature = !row.remaining && elapsed !== null && elapsed >= row.period;
      return {code:row.code,planId:row.planId,routes:row.routes,period:row.period,entryDate:row.entryDate,exitDate:row.exitDate || null,
        quantity:row.quantity,remaining:row.remaining,heldTradingDays:elapsed,mature,pnl:!row.remaining ? row.proceeds-row.cost : null,
        returnPct:!row.remaining ? (row.proceeds/row.cost-1)*100 : null};
    });
    const executedRecords = records.filter(row=>row.status === 'executed' && row.side !== 'sell');
    const valuationComplete = account.positions.every(row=>row.quoteStatus === 'fresh' && row.tradeDate === asOfDate);
    const completeCurve = !missingMarks.length;
    return {id:experiment.id,baselineId:experiment.baselineId || 'baseline',shadowOnly:true,promotionAllowed:false,account,records,trades,equityCurve:curve,missingMarks,
      valuationStatus:valuationComplete ? 'complete' : 'unknown',
      coverage:{candidates:signals.length,allowed:signals.filter(row=>row.entryPermission === 'allowed').length,
        executed:executedRecords.length,missing:records.filter(row=>row.status === 'unknown').length,
        unexecuted:records.filter(row=>row.status === 'not-executed').length,
        fillRate:seen.size ? executedRecords.length/seen.size : null,
        zeroTradeDayRatio:dates.length ? 1-new Set(executedRecords.map(row=>row.tradeDate)).size/dates.length : null,
        capitalUsage:account.equity ? account.marketValue/account.equity : null},
      tradePnL:trades.filter(row=>row.pnl !== null).map(row=>row.pnl),
      portfolioEquity:valuationComplete ? account.equity ?? manifest.initialCapital : null,
      estimatedPortfolioEquity:account.equity ?? manifest.initialCapital,
      netReturnPct:valuationComplete ? ((account.equity ?? manifest.initialCapital)/manifest.initialCapital-1)*100 : null,
      maxDrawdown:completeCurve ? drawdown(curve,manifest.initialCapital) : null,
      tailReturnPct:quantileTail(trades.filter(row=>row.mature).map(row=>row.returnPct))};
  });
  const baseline = variants[0],themeBaseline = variants.find(row=>row.id === 'themeBaseline');
  const qualityBaseline = variants.find(row=>row.id === 'qualityBaseline');
  for (const variant of variants) {
    const reference = variant.baselineId === 'themeBaseline' ? themeBaseline
      : variant.baselineId === 'qualityBaseline' ? qualityBaseline : baseline;
    const newDays = dates.filter(date=>variant.baselineId === 'themeBaseline'
      ? date >= themeManifest.firstTradeDate : variant.baselineId === 'qualityBaseline'
        ? date >= qualityManifest.firstTradeDate : date > manifest.freezeDate).length;
    variant.excessVsBaseline = variant.netReturnPct !== null && reference.netReturnPct !== null ? variant.netReturnPct-reference.netReturnPct : null;
    variant.validation = Object.fromEntries(['A','B'].map(route=>{
      const trades = variant.trades.filter(row=>row.routes.includes(route)),baseTrades = reference.trades.filter(row=>row.routes.includes(route));
      const routeMature = row=>row.mature && row.heldTradingDays >= (route === 'A' ? 20 : 5);
      const mature = trades.filter(routeMature),baseMature = baseTrades.filter(routeMature);
      const coverage = baseTrades.length ? trades.length/baseTrades.length : null;
      const curve = variant.equityCurve.map(row=>({equity:row.routeEquity[route]}));
      const baseCurve = reference.equityCurve.map(row=>({equity:row.routeEquity[route]}));
      const excess = ((curve.at(-1)?.equity || manifest.initialCapital)-(baseCurve.at(-1)?.equity || manifest.initialCapital))/manifest.initialCapital*100;
      const tail = quantileTail(mature.map(row=>row.returnPct)),baseTail = quantileTail(baseMature.map(row=>row.returnPct));
      const missing = variant.missingMarks.length || reference.missingMarks.length;
      const ready = newDays >= 20 && mature.length >= 30 && baseMature.length >= 30 && !missing;
      const checks = {netExcessPositive:excess > 0,tailNonWorsened:tail !== null && baseTail !== null && tail >= baseTail-2,
        drawdownNonWorsened:drawdown(curve,manifest.initialCapital) <= drawdown(baseCurve,manifest.initialCapital)+2,
        coverageFloor:coverage !== null && coverage >= .25};
      return [route,{status:!ready ? 'pending' : Object.values(checks).every(Boolean) ? 'eligible-for-review' : 'failed',
        promotionAllowed:false,newTradingDays:newDays,matureEpisodes:mature.length,baselineMatureEpisodes:baseMature.length,
        coverageVsBaseline:coverage,netExcessPct:excess,checks,
        periods:Object.fromEntries([5,20,60].map(period=>[period,{matureEpisodes:mature.filter(row=>row.period === period).length,
          status:newDays >= 20 && mature.filter(row=>row.period === period).length >= 30 && !missing ? 'review-only' : 'pending'}]))}];
    }));
  }
  return {schemaVersion:1,parameterVersion:PARAMETER_VERSION,manifest,
    themeManifest:themeActive ? themeManifest : null,qualityManifest:qualityActive ? qualityManifest : null,
    asOfDate,shadowOnly:true,promotionAllowed:false,
    basis:'offline-verified-next-session-open',marketExcess:null,variants};
}

module.exports = {createStrategyExperimentManifest,createWeeklyQualityManifest,evaluateWeeklyQualityShadow,
  evaluateStrategyExperiments,evaluateShadowExit,replayStrategyExperiments,buildExperimentReplayInput};
