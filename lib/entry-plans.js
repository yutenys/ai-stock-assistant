const crypto = require('node:crypto');
const {clock,executionWindow,nextTradingDay} = require('./trade-time');

const terminal = new Set(['blocked','expired','completed']);
const positive = value => value !== null && value !== '' && Number(value) > 0 && Number.isFinite(Number(value)) ? Number(value) : null;

function planFeasibility(plan = {}, setup = '') {
  const max = positive(plan.maxEntryPrice), stop = positive(plan.stressExitPrice || plan.invalidationPrice);
  const target = positive(plan.targetEvidence?.nearestResistance);
  const confirmation = positive(plan.confirmationPrice);
  const pullback = ['first-pullback','range-retest-60m-v1','回踩低吸','首次回踩','60分钟结构回踩'].includes(setup);
  const low = pullback ? positive(plan.entryLow) : confirmation && Math.ceil((confirmation + .000001) * 100) / 100;
  const costRate = Math.max(0,Number(plan.transactionCostPct) || 0) / 100;
  const rewardRiskCeiling = target && stop ? Math.floor((target + 2*stop)/(3 + 3*costRate)*100) / 100 : null;
  const high = pullback ? Math.min(max || Infinity,positive(plan.entryHigh) || Infinity,rewardRiskCeiling || Infinity)
    : Math.min(max || Infinity,rewardRiskCeiling || Infinity);
  if (!max || !stop || !target || plan.targetEvidence?.status !== 'verified' || !low || !Number.isFinite(high)) return {status:'unknown',reason:'入场区间、止损或结构目标缺少可核验证据'};
  if (low > high || pullback && confirmation && confirmation >= high || stop >= low || target <= low) return {
    status:'empty',reason:`买点区间无交集或目标/止损无空间：下限${low.toFixed(2)}，上限${high.toFixed(2)}，止损${stop.toFixed(2)}，目标${target.toFixed(2)}`,
    entryLow:low,entryHigh:high
  };
  return {status:'feasible',entryLow:low,entryHigh:high};
}

function summarizeEntryPlans(rows = []) {
  const plans = rows.filter(row => row?.planState);
  const available = plans.filter(row => ['empty','feasible'].includes(row.planState.feasibility?.status));
  const structured = available.filter(row => row.planState.checks?.structure === 'pass');
  const priced = structured.filter(row => row.planState.feasibility?.status === 'feasible');
  const riskPassed = priced.filter(row => row.planState.checks?.risk === 'pass');
  const reasons = {};
  for (const row of plans) {
    if (row.planState.currentPermission === 'allowed') continue;
    const reason = row.planState.reason || '原因待核验';
    reasons[reason] = (reasons[reason] || 0) + 1;
  }
  return {scope:'本轮展示计划',discovered:rows.length,dataAvailable:available.length,
    structureEstablished:structured.length,priceFeasible:priced.length,riskPassed:riskPassed.length,
    armed:plans.filter(row => row.planState.state === 'armed').length,
    triggered:plans.filter(row => row.planState.triggeredAt).length,
    currentlyAllowed:plans.filter(row => row.planState.currentPermission === 'allowed').length,
    verifiedFills:null,reasons};
}

function summarizeRecommendationPermissions(rows = []) {
  const currentPermissions = {allowed:0,armed:0,watch:0,blocked:0,expired:0};
  for (const row of rows) {
    const permission = row?.planState?.currentPermission;
    currentPermissions[Object.hasOwn(currentPermissions,permission) ? permission : 'watch']++;
  }
  return {discovered:rows.length,strictQualified:currentPermissions.allowed,
    watchQualified:rows.length-currentPermissions.allowed,armedQualified:currentPermissions.armed,
    blockedQualified:currentPermissions.blocked,expiredQualified:currentPermissions.expired,currentPermissions};
}

function advanceEntryPlan(previous, input) {
  const {code,track,modelVersion,tradeDate,cutoffAt,analysis = {},quote = {},marketRegime,riskProfile,minuteBars = []} = input;
  const cutoff = Date.parse(cutoffAt);
  if (!Number.isFinite(cutoff)) throw new Error('计划需要明确的数据截止时间');
  const candidate = analysis.tradePlan || {};
  const setup = analysis.firstPullback ? 'first-pullback' : candidate.setupType || '观察';
  const intraday = setup === 'range-retest-60m-v1' ? input.intradayStructure : null;
  const formationDate = setup === 'range-retest-60m-v1' && intraday?.structureReadyAt
    ? clock(intraday.structureReadyAt).date : analysis.tradeDate || tradeDate;
  if (previous && terminal.has(previous.state) && setup === 'range-retest-60m-v1'
    && intraday?.evidenceHash === previous.tradePlan?.structureEvidenceHash) return previous;
  if (previous && terminal.has(previous.state) && previous.terminalDate >= formationDate
    && !(setup === 'range-retest-60m-v1' && intraday?.state === 'retest-confirmed'
      && intraday.evidenceHash && intraday.evidenceHash !== previous.tradePlan?.structureEvidenceHash)) return previous;
  let plan = previous && !terminal.has(previous.state) ? JSON.parse(JSON.stringify(previous)) : null;
  if (!plan) {
    const frozen = {...candidate};
    if (setup === 'first-pullback') {
      frozen.confirmationPrice = positive(input.signalBar?.high);
      frozen.invalidationPrice = Math.max(positive(analysis.supportPrice) || 0,positive(analysis.breakoutContext?.breakoutLevel) || 0);
      frozen.setupType = '首次回踩';
    }
    if (setup === 'range-retest-60m-v1' && intraday?.state === 'retest-confirmed' && intraday.basis === 'raw') {
      frozen.confirmationPrice = positive(intraday.confirmationPrice);
      frozen.invalidationPrice = positive(intraday.invalidationPrice);
      frozen.structureEvidenceHash = intraday.evidenceHash;
      frozen.setupType = '60分钟结构回踩';
      frozen.entryExpiryDate = null;
      const stress = Math.min(positive(frozen.stressExitPrice) || Infinity,
        frozen.invalidationPrice || Infinity);
      frozen.stressExitPrice = Number.isFinite(stress) ? stress : null;
    }
    const horizon = analysis.holdingPeriod || analysis.holdingProfile?.primary;
    const days = {短线:5,波段:20,中长线:60}[horizon] || frozen.holdingPeriodTradingDays;
    if (days) { frozen.holdingPeriodTradingDays = days; frozen.timeExitTradingDays = days; }
    frozen.atr = positive(analysis.atr14) || frozen.atr || null;
    const identity = [code,track,modelVersion,setup,formationDate,frozen.confirmationPrice,frozen.invalidationPrice,
      setup === 'range-retest-60m-v1' ? intraday?.structureReadyAt : '',frozen.structureEvidenceHash || ''];
    const planId = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0,24);
    const buyDate = ['first-pullback','range-retest-60m-v1'].includes(setup)
      ? executionWindow(setup === 'range-retest-60m-v1' ? intraday.structureReadyAt : cutoffAt).buyDate
      : nextTradingDay(formationDate);
    const sellDate = buyDate && nextTradingDay(buyDate);
    plan = {schemaVersion:1,planId,revision:1,code,track,modelVersion,setup,formationDate,
      createdAt:cutoffAt,state:'watch',tradePlan:frozen,earliestBuyDate:buyDate,earliestSellDate:sellDate,
      entryExpiryDate:frozen.entryExpiryDate || sellDate && nextTradingDay(sellDate),
      structureReadyAt:setup === 'range-retest-60m-v1' ? intraday?.structureReadyAt || null : null,
      confirmationTimeframe:['first-pullback','range-retest-60m-v1'].includes(setup) ? '5-minute-completed' : 'daily-final',
      events:[],triggeredAt:'',triggerReferencePrice:null};
    plan.tradePlan = {...frozen,planId,revision:1,frozenAt:cutoffAt,
      earliestBuyDate:buyDate,earliestSellDate:sellDate,entryExpiryDate:plan.entryExpiryDate};
  }
  if (Date.parse(plan.updatedAt || '') >= cutoff) return plan;
  const oldState = plan.state;
  const currentPrice = positive(quote.price ?? analysis.latestPrice);
  const support = positive(plan.tradePlan.invalidationPrice);
  const quoteDate = quote.tradeDate || analysis.tradeDate;
  const quoteTime = Date.parse(quote.quoteObservedAt || quote.observedAt || '');
  const phase = analysis.observationPhase?.phase;
  const quoteFresh = quoteDate === tradeDate && !quote.stale && Number.isFinite(quoteTime)
    && quoteTime <= cutoff && (cutoff - quoteTime <= 120000
      || phase === 'closed' && quoteTime >= Date.parse(`${tradeDate}T15:00:00+08:00`));
  const risk = riskProfile?.status === 'risk' || /破位|失效|公司风险/.test(analysis.entryAssessment?.status || '')
    || plan.setup === 'range-retest-60m-v1' && ['invalid','expired'].includes(intraday?.state);
  plan.feasibility = planFeasibility(plan.tradePlan,plan.setup);
  plan.checks = {
    structure:plan.setup === 'first-pullback' || plan.setup === 'range-retest-60m-v1'
      ? plan.setup === 'first-pullback' || intraday?.state === 'retest-confirmed' ? 'pass' : 'unknown'
      : phase === 'closed' && analysis.entryAssessment?.allowed === true ? 'pass' : 'unknown',
    risk:riskProfile?.status === 'clear' && marketRegime?.allowNewEntry === true && input.contextAllowed !== false
      ? 'pass' : risk || riskProfile?.status === 'risk' || marketRegime?.allowNewEntry === false || input.contextAllowed === false
        ? 'fail' : 'unknown',
    quote:quoteFresh ? 'pass' : 'unknown'
  };
  let reason = '等待形态、行情与公司风险证据';
  if (risk || quoteFresh && currentPrice && support && currentPrice < support) {
    plan.state = 'blocked'; reason = '结构失效或公司硬风险';
  } else if (plan.entryExpiryDate && tradeDate > plan.entryExpiryDate) {
    plan.state = 'expired'; reason = '入场期限已过，重新分析后建立新计划';
  } else if (plan.feasibility.status !== 'feasible'
    || plan.tradePlan.enabled === false && !['first-pullback','range-retest-60m-v1'].includes(plan.setup)) {
    plan.state = 'watch'; plan.currentPermission = 'watch';
    reason = plan.feasibility.status !== 'feasible' ? plan.feasibility.reason : '当前计划未通过入场前置条件';
  } else {
    const maxEntry = positive(plan.tradePlan.maxEntryPrice);
    const target = positive(plan.tradePlan.targetEvidence?.nearestResistance);
    const stress = positive(plan.tradePlan.stressExitPrice);
    const cost = currentPrice ? currentPrice * Number(plan.tradePlan.transactionCostPct || 0) / 100 : null;
    const riskAmount = currentPrice && stress ? currentPrice - stress + cost : null;
    const rewardRisk = target && riskAmount > 0 ? (target - currentPrice - cost) / riskAmount : null;
    plan.currentRewardRisk = rewardRisk;
    const common = quoteFresh && input.contextAllowed !== false && marketRegime?.allowNewEntry === true && riskProfile?.status === 'clear'
      && currentPrice && maxEntry && currentPrice <= maxEntry && rewardRisk >= 2;
    const completed = minuteBars.filter(bar => {
      const at = Date.parse(bar.closedAt || bar.time);
      return bar.isFinal === true && bar.tradeDate === tradeDate && at <= cutoff
        && cutoff - at <= 10*60000 && at > Date.parse(plan.structureReadyAt || plan.createdAt) && positive(bar.close);
    }).sort((a,b)=>Date.parse(a.closedAt || a.time)-Date.parse(b.closedAt || b.time));
    const confirmedBar = completed.at(-1);
    const barConfirmed = confirmedBar && positive(confirmedBar.close) > positive(plan.tradePlan.confirmationPrice)
      && currentPrice > positive(plan.tradePlan.confirmationPrice)
      && !completed.some(bar=>positive(bar.low) < support)
      && positive(confirmedBar.low) >= support;
    const pullbackTrigger = plan.setup === 'first-pullback' && executionWindow(cutoffAt).tradable
      && tradeDate >= plan.earliestBuyDate && barConfirmed;
    const intradayTrigger = plan.setup === 'range-retest-60m-v1' && intraday?.state === 'retest-confirmed'
      && intraday.evidenceHash === plan.tradePlan.structureEvidenceHash && intraday.basis === 'raw'
      && (tradeDate === plan.formationDate || tradeDate === nextTradingDay(plan.formationDate))
      && executionWindow(cutoffAt).tradable && tradeDate >= plan.earliestBuyDate && barConfirmed;
    const dailyTrigger = !['first-pullback','range-retest-60m-v1'].includes(plan.setup) && phase === 'closed'
      && analysis.entryAssessment?.allowed === true && candidate.researchEntryEligible === true
      && currentPrice >= positive(plan.tradePlan.confirmationPrice);
    if (common && (pullbackTrigger || intradayTrigger || dailyTrigger)) {
      plan.state = 'allowed';
      if (!plan.triggeredAt) {
        plan.triggeredAt = cutoffAt;
        plan.confirmedAt = confirmedBar?.closedAt || cutoffAt;
        plan.triggerReferencePrice = currentPrice;
        const timing = executionWindow(plan.triggeredAt);
        plan.earliestBuyDate = timing.buyDate;
        plan.earliestSellDate = timing.sellDate;
      }
      plan.currentPermission = 'allowed';
      reason = pullbackTrigger || intradayTrigger ? '完整5分钟K线越过冻结回踩高点，支撑及风险收益核验通过' : '收盘确认通过，下一交易日重新核验成交';
    } else {
      plan.state = plan.tradePlan.targetEvidence?.status === 'verified' && support && positive(plan.tradePlan.confirmationPrice) ? 'armed' : 'watch';
      plan.currentPermission = 'watch';
      reason = !quoteFresh ? '行情时点待核验' : !maxEntry || currentPrice > maxEntry ? '价格超过冻结入场上限或上限待核验'
        : !(rewardRisk >= 2) ? '最近结构目标净收益风险比未达到2.0'
          : riskProfile?.status !== 'clear' ? '公司风险证据待核验'
            : !marketRegime?.allowNewEntry ? '市场环境未通过'
              : input.contextAllowed === false ? '板块、资金或量能承接条件未通过'
                : plan.setup === 'range-retest-60m-v1' && intraday?.state !== 'retest-confirmed' ? '60分钟结构证据待核验'
                  : plan.setup === 'range-retest-60m-v1' && !barConfirmed ? '等待结构完成后的完整5分钟K线确认'
                    : plan.setup === 'first-pullback' && !barConfirmed ? '等待形态形成后的完整5分钟K线确认，缺数据不伪造触发' : '等待冻结买点确认';
    }
  }
  plan.reason = reason;
  plan.updatedAt = cutoffAt;
  if (terminal.has(plan.state)) { plan.terminalDate = tradeDate; plan.currentPermission = plan.state; }
  if (oldState !== plan.state || !plan.events.length) {
    const type = plan.state === 'allowed' ? 'entry-allowed' : `entry-${plan.state}`;
    const event = {id:`${plan.planId}:${plan.revision}:${type}:${plan.events.filter(row=>row.type===type).length + 1}`,
      type,from:oldState,to:plan.state,occurredAt:cutoffAt,reason,planId:plan.planId,revision:plan.revision,
      referencePrice:plan.state === 'allowed' ? plan.triggerReferencePrice : currentPrice,
      source:quote.source || minuteBars.at(-1)?.source || '',
      verified:plan.state === 'allowed' && Boolean(quote.source || minuteBars.at(-1)?.source),
      snapshotId:input.snapshotId || '',confirmationTimeframe:plan.confirmationTimeframe};
    plan.events.push(event);
    plan.decisionEvent = event;
  }
  return plan;
}

module.exports = {advanceEntryPlan,planFeasibility,summarizeEntryPlans,summarizeRecommendationPermissions};
