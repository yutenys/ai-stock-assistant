const {clock,nextTradingDay} = require('./trade-time');

function finite(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]);
}

function advanceTradingDays(date, count) {
  let value=date;
  for (let index=0;index<count && value;index++) value=nextTradingDay(value);
  return value;
}

function themeProfile(item, tradeDate) {
  return (item.rotationProfiles || []).find(profile => profile?.name
    && profile.capitalTradeDate === tradeDate
    && profile.capitalEstimated !== true
    && profile.capitalStale !== true
    && finite(profile.mainNetInflow) > 0
    && finite(profile.upRatio ?? profile.participation?.upRatio) >= .55
    && finite(profile.participation?.coverage) >= .5
    && finite(profile.exTop3UpRatio ?? profile.shadowRotation?.exTop3UpRatio
      ?? profile.participation?.exTop3UpRatio) >= .5) || null;
}

function firstResistance(item, price) {
  const levels = [
    item.shortRebound?.resistance,
    ...(Array.isArray(item.analysis?.resistanceLevels) ? item.analysis.resistanceLevels : []),
    item.analysis?.breakoutPotential?.targetPrice,
    item.targetPrice
  ].map(finite).filter(value => value !== null && value > price * 1.001).sort((a, b) => a - b);
  return levels[0] ?? null;
}

function providerKey(source) {
  const value = String(source || '');
  if (value.includes('东方财富')) return 'eastmoney';
  if (value.includes('新浪')) return 'sina';
  if (value.includes('腾讯')) return 'tencent';
  return value.trim().toLowerCase();
}

function aggregateFundWindows(fund) {
  const current = fund?.current || {};
  const latest = finite(current.mainNetInflow);
  const total3 = finite(current.mainNet3);
  const total5 = finite(current.mainNet5);
  const total10 = finite(current.mainNet10);
  if ([latest,total3,total5,total10].some(value => value === null)) return null;
  return {latest,prior2:total3-latest,previous2:total5-total3,previous5:total10-total5};
}

function riskEvidence(profile) {
  const clear = profile?.status === 'clear';
  return {
    status:String(profile?.status || 'unknown'),
    reasonCode:String(profile?.reasonCode || profile?.statusReason || (clear ? 'verified-clear' : 'not-confirmed')),
    summary:String(profile?.summary || profile?.reason || (clear ? '公司风险核验通过' : '公司风险未通过完整核验'))
  };
}

function routeTrigger(route, maxEntryPrice, invalidation) {
  if (route === 'R2') return `回踩支撑后缩量企稳并重新转强，入场不高于${maxEntryPrice?.toFixed?.(2) || '--'}元`;
  if (route === 'R1') return `低点不再下移并收复短线触发位，入场不高于${maxEntryPrice?.toFixed?.(2) || '--'}元`;
  return `首次有效离开整理区且量能温和确认，入场不高于${maxEntryPrice?.toFixed?.(2) || '--'}元`;
}

function assess(item, {tradeDate, marketRegime, transactionCostPct = .2, priorPublication = null} = {}) {
  const reasons = [];
  const signal = item.shortRebound || {};
  const price = finite(item.price);
  const invalidation = finite(priorPublication?.invalidationPrice ?? signal.invalidation);
  const profile = themeProfile(item, tradeDate);
  const fund = item.fundFlowPeriod || {};
  const current = fund.current || {};
  const fundWindows = aggregateFundWindows(fund);
  const completeDailyFunds = fund.available && fund.complete && !fund.estimated
    && finite(fund.mainNetInflow) > 0 && finite(fund.positiveDays) >= 6;
  const sameSourceAggregate = fund.available && fund.aggregateOnly && !fund.estimated
    && providerKey(fund.source) && providerKey(fund.source) === providerKey(current.source)
    && fundWindows && Object.values(fundWindows).every(value => value > 0);
  if (!/^\d{6}$/.test(String(item.code || '')) || !validDate(tradeDate)) reasons.push('证券代码或交易日期无效');
  if (!signal.matched || ['invalid', 'overheated'].includes(signal.state)) reasons.push('修复结构已失效或过热');
  if (!tradeDate || item.tradeDate !== tradeDate || signal.tradeDate !== tradeDate) reasons.push('行情与结构不是同一交易日');
  if (marketRegime?.allowNewEntry !== true) reasons.push('大盘环境不允许新增入场');
  const risk = riskEvidence(item.riskProfile);
  if (risk.status !== 'clear') reasons.push(`公司风险尚未明确通过（${risk.reasonCode}）`);
  if (!profile) reasons.push('同交易日真实板块资金与扩散未确认');
  if (!completeDailyFunds && !sameSourceAggregate) {
    reasons.push(fund.aggregateOnly ? '阶段个股资金未形成非重叠窗口持续流入证据' : '阶段个股资金未形成完整持续流入证据');
  }
  if (!(current.tradeDate === tradeDate && !current.estimated && finite(current.mainNetInflow) > 0)) {
    reasons.push('当日个股主力资金未确认流入');
  }
  if (item.newsLabel === '消息谨慎') reasons.push('消息面存在谨慎信号');
  const requestedMaxEntry = finite(priorPublication?.maxEntryPrice ?? signal.tradePlan?.maxEntryPrice
    ?? signal.entryRange?.max ?? signal.maxEntryPrice ?? price);
  const maxLossPct = 3;
  const riskBoundEntry = invalidation && invalidation > 0
    ? invalidation / (1 - (maxLossPct - transactionCostPct) / 100) : null;
  const maxEntryPrice = requestedMaxEntry && riskBoundEntry
    ? Math.min(requestedMaxEntry,riskBoundEntry) : requestedMaxEntry;
  if (price !== null && maxEntryPrice !== null && price > maxEntryPrice * 1.001) {
    reasons.push(priorPublication ? '现价超过首次发布冻结入场上限' : '现价超过风险约束入场上限，等待回踩');
  }
  const resistance = finite(priorPublication?.targetPrice) ?? (price === null ? null : firstResistance(item, price));
  const targetSpacePct = maxEntryPrice && resistance ? (resistance / maxEntryPrice - 1) * 100 - transactionCostPct : null;
  const pressureLossPct = maxEntryPrice && invalidation && invalidation < maxEntryPrice
    ? Number((((maxEntryPrice - invalidation) / maxEntryPrice) * 100 + transactionCostPct).toFixed(4)) : null;
  const rewardRisk = targetSpacePct !== null && pressureLossPct > 0 ? targetSpacePct / pressureLossPct : null;
  if (targetSpacePct === null) reasons.push('未找到可核验的上方首个阻力');
  else if (targetSpacePct < 3) reasons.push('扣除成本后的首阻力空间不足3%');
  if (pressureLossPct === null) reasons.push('失效价无法形成有效止损区间');
  else if (pressureLossPct > 3) reasons.push('压力测试止损幅度超过3%');
  if (rewardRisk === null || rewardRisk < 2) reasons.push('扣除成本后的收益风险比不足2');
  const hardInvalid = !signal.matched || ['invalid', 'overheated'].includes(signal.state);
  const qualityScore = (finite(signal.executionScore) || 0) + Math.min(20, Math.max(0, (rewardRisk || 0) * 5))
    + Math.min(10, finite(fund.positiveDays) || 0);
  return {
    item,
    eligible:reasons.length === 0,
    hardInvalid,
    theme:profile?.name || item.industry || '主题待确认',
    reasons:[...new Set(reasons)],
    metrics:{resistance,maxEntryPrice,requestedMaxEntryPrice:requestedMaxEntry,riskBoundEntryPrice:riskBoundEntry,
      invalidationPrice:invalidation,targetSpacePct,pressureLossPct,rewardRisk,
      transactionCostPct,costModelVersion:'cn-a-share-shadow-cost-v1',fundWindows,riskEvidence:risk},
    qualityScore
  };
}

function annotate(row, tier, extraReasons = []) {
  const reasons = [...new Set([...row.reasons, ...extraReasons])];
  const label = tier === 'selected' ? '精选影子' : tier === 'watch' ? '观察层' : '失效/过热';
  const tradePlan = {...(row.item.shortRebound?.tradePlan || {}),maxEntryPrice:row.metrics.maxEntryPrice,
    expectedEntryPrice:row.metrics.maxEntryPrice,targetPrice:row.metrics.resistance,
    invalidationPrice:row.metrics.invalidationPrice,rewardRisk:row.metrics.rewardRisk,
    transactionCostPct:row.metrics.transactionCostPct,costModelVersion:row.metrics.costModelVersion,
    planVersion:'short-rebound-selective-v31',
    trigger:routeTrigger(row.item.shortRebound?.route,row.metrics.maxEntryPrice,row.metrics.invalidationPrice),
    enabled:false,researchEntryEligible:false,shadowOnly:true};
  return {...row.item,recommendationTier:`短线修复${label}`,verdict:'仅观察，不构成买入许可',
    entryAssessment:{...(row.item.entryAssessment || {}),allowed:false,status:label,
      summary:reasons.length ? reasons.join('；') : row.item.shortRebound?.summary || '证据完整，进入精选影子验证。'},
    shortRebound:{...row.item.shortRebound,tradePlan},
    shortReboundSelection:{tier,theme:row.theme,qualityScore:row.qualityScore,reasons,...row.metrics}};
}

function selectShortReboundCandidates(candidates = [], {
  tradeDate = '', marketRegime = null, observedAt = new Date().toISOString(), previousState = null,
  maxActive = 3, maxNewPerDay = 5
} = {}) {
  const state = {schemaVersion:3,tradeDate,published:(previousState?.published || []).map(item => {
    const publishedDate=clock(item.firstPublishedAt).date;
    const expiresOn=item.expiresOn || advanceTradingDays(publishedDate,5);
    const priorStatus=item.status || 'active';
    return {...item,expiresOn,status:priorStatus === 'active' && expiresOn && tradeDate > expiresOn ? 'expired' : priorStatus};
  })};
  const activePublications=state.published.filter(item=>item.status === 'active');
  const priorByCode = new Map(activePublications.map(item => [String(item.code), item]));
  const uniqueByCode = new Map();
  candidates.forEach((item, index) => {
    const key = /^\d{6}$/.test(String(item?.code || '')) ? String(item.code) : `invalid:${index}`;
    if (!uniqueByCode.has(key)) uniqueByCode.set(key, item);
  });
  const uniqueCandidates = [...uniqueByCode.values()];
  const evaluated = uniqueCandidates.map(item => assess(item, {tradeDate, marketRegime,
    priorPublication:priorByCode.get(String(item.code || '')) || null}));
  const publishedCodes = new Set(activePublications.map(item => String(item.code)));
  const dailyPublishedCodes = new Set(state.published.filter(item => clock(item.firstPublishedAt).date === tradeDate)
    .map(item => String(item.code)));
  let newBudget = Math.max(0, maxNewPerDay - dailyPublishedCodes.size);
  const selected = [];
  const watch = [];
  const history = [];
  const activeThemes = new Set();
  const ranked = evaluated.sort((left, right) => right.qualityScore - left.qualityScore
    || String(left.item.code).localeCompare(String(right.item.code)));

  for (const row of ranked) {
    if (row.hardInvalid) {
      const publication=priorByCode.get(String(row.item.code || ''));
      if (publication) publication.status='invalidated';
      history.push(annotate(row, 'history'));
      continue;
    }
    if (!row.eligible) {
      watch.push(annotate(row, 'watch'));
      continue;
    }
    const code = String(row.item.code || '');
    const alreadyPublished = publishedCodes.has(code);
    if (selected.length >= maxActive) {
      watch.push(annotate(row, 'watch', ['精选观察席已满']));
      continue;
    }
    if (activeThemes.has(row.theme)) {
      watch.push(annotate(row, 'watch', ['同一真实主题仅保留一只']));
      continue;
    }
    if (!alreadyPublished && newBudget <= 0) {
      watch.push(annotate(row, 'watch', ['当日新增发布预算已用完']));
      continue;
    }
    selected.push(annotate(row, 'selected'));
    activeThemes.add(row.theme);
    if (!alreadyPublished) {
      state.published.push({code,theme:row.theme,route:row.item.shortRebound?.route || '',firstPublishedAt:observedAt,
        maxEntryPrice:row.metrics.maxEntryPrice,targetPrice:row.metrics.resistance,
        invalidationPrice:row.metrics.invalidationPrice,planVersion:'short-rebound-selective-v31',
        expiresOn:advanceTradingDays(tradeDate,5),status:'active'});
      publishedCodes.add(code);
      dailyPublishedCodes.add(code);
      newBudget--;
    }
  }
  state.activeCodes = selected.map(item => String(item.code));
  state.dailyPublishedCodes = [...dailyPublishedCodes];
  state.updatedAt = observedAt;
  const publishedByCode = new Map(state.published.filter(item=>item.status === 'active').map(item => [String(item.code), item]));
  const selectedWithPublication = selected.map(item => ({...item,shortReboundSelection:{...item.shortReboundSelection,
    firstPublishedAt:publishedByCode.get(String(item.code))?.firstPublishedAt || ''}}));
  const dataReason = reason => /风险尚未明确|数据|未确认|完整持续流入证据|非重叠窗口持续流入证据|行情与结构不是同一交易日/.test(reason);
  const funnel = evaluated.reduce((value,row) => {
    value.total++;
    if (row.hardInvalid) value.invalid++;
    else if (row.eligible) value.eligible++;
    else {
      const hasDataReason = row.reasons.some(dataReason);
      const hasOpportunityReason = row.reasons.some(reason => !dataReason(reason));
      if (hasDataReason && hasOpportunityReason) value.mixed++;
      else if (hasDataReason) value.dataPending++;
      else value.opportunityRejected++;
    }
    row.reasons.forEach(reason => { value.reasons[reason]=(value.reasons[reason] || 0)+1; });
    return value;
  },{total:0,eligible:0,dataPending:0,opportunityRejected:0,mixed:0,invalid:0,reasons:{}});
  return {
    selected:selectedWithPublication, watch, history, publicationState:state,
    summary:{selected:selected.length,watch:watch.length,history:history.length,publishedToday:dailyPublishedCodes.size,
      maxActive,maxNewPerDay,funnel,forwardValidation:{status:'pending',requiredTradingDays:40,requiredMatureEpisodes:100}}
  };
}

module.exports = {selectShortReboundCandidates};
