'use strict';

const {termDefinitions} = require('./term-definitions');

function finite(value) {
  if (value === null || value === undefined || typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function calculateRecommendationPerformance(input = {}) {
  const signalPrice = finite(input.signalPrice);
  const closePrice = finite(input.closePrice);
  const signalChangePct = finite(input.signalChangePct);
  const closeChangePct = finite(input.closeChangePct);
  const changeDeltaPoints = signalChangePct === null || closeChangePct === null
    ? null : round(closeChangePct - signalChangePct);
  const priceReturnPct = signalPrice && closePrice
    ? round((closePrice / signalPrice - 1) * 100)
    : null;
  return {priceReturnPct, changeDeltaPoints};
}

function selectPublishedBatchStatus(entries = [], targetAt, maxQuoteAgeMs = 2 * 60 * 1000) {
  const target = Date.parse(targetAt);
  if (!Number.isFinite(target)) return {batch:null,nearestPrior:null,status:'invalid',quoteAgeMs:null,reason:'检查点时间无效'};
  const nearestPrior = entries.filter(entry => {
    const published = Date.parse(entry?.publishedAt);
    const observed = Date.parse(entry?.quoteObservedAt || entry?.observedAt);
    return Number.isFinite(published) && Number.isFinite(observed)
      && published <= target && observed <= target;
  }).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))[0] || null;
  if (!nearestPrior) return {batch:null,nearestPrior:null,status:'missing',quoteAgeMs:null,reason:'检查点前没有已发布且有行情时间的批次'};
  const quoteAgeMs = target - Date.parse(nearestPrior.quoteObservedAt || nearestPrior.observedAt);
  if (quoteAgeMs > maxQuoteAgeMs) return {batch:null,nearestPrior,status:'stale',quoteAgeMs,
    reason:`最近批次行情距检查点${Math.round(quoteAgeMs / 1000)}秒，超过${Math.round(maxQuoteAgeMs / 1000)}秒严格时效`};
  return {batch:nearestPrior,nearestPrior,status:'covered',quoteAgeMs,reason:'检查点已覆盖'};
}

function selectPublishedBatch(entries = [], targetAt, maxQuoteAgeMs = 2 * 60 * 1000) {
  return selectPublishedBatchStatus(entries, targetAt, maxQuoteAgeMs).batch;
}

function classifyRecommendationRole(item = {}) {
  const analysis = item.analysis || {};
  const capital = item.capital || {};
  const sector = item.sector || {};
  const explicitPermission = ['watch','armed','allowed','blocked','expired'].includes(item.entryPermission)
    ? item.entryPermission : null;
  const result = (primaryRole, entryPermission, reasons) => ({primaryRole,
    entryPermission:explicitPermission || entryPermission, reasons});
  if (analysis.trendBroken) {
    return {primaryRole:'结构失效', entryPermission:'blocked', reasons:['价格结构已破坏']};
  }
  if (analysis.breakoutConfirmed && analysis.firstPullback && finite(analysis.volumeRatio) !== null
    && finite(analysis.volumeRatio) <= 1.2 && finite(capital.mainNetInflow) !== null && finite(capital.mainNetInflow) >= 0) {
    return result('首次回踩', 'watch', ['有效突破后的首次缩量回踩']);
  }
  if (analysis.boxStable && analysis.volumeCompressed && finite(capital.mainNetInflow) > 0) {
    return result('吸筹/洗盘观察', 'watch', ['箱体稳定、量能压缩且阶段资金为正']);
  }
  if (capital.available && finite(capital.netRatio) > 0
    && /扩散|流入/.test(String(sector.phase || '')) && finite(item.relativeStrength) >= 70) {
    return result('资金前排', 'watch', ['板块资金扩散且个股相对强度靠前']);
  }
  const relative = item.sectorRelative || {};
  if (analysis.supportIntact && relative.comparable === true
    && finite(relative.sectorChangePct) !== null && finite(relative.stockChangePct) !== null
    && finite(relative.sectorChangePct) > finite(relative.stockChangePct)
    && finite(relative.stockChangePct) >= 0 && finite(item.relativeStrength) >= 70
    && finite(item.distanceToResistancePct) >= 3
    && finite(capital.mainNetInflow) !== null && finite(capital.mainNetInflow) >= 0) {
    return result('健康滞涨', 'watch', ['同日板块涨幅领先，个股支撑完整且资金未背离']);
  }
  return result('趋势观察', 'watch', ['等待资金、趋势与入场位置形成一致证据']);
}

function stockKey(row) {
  return String(row?.code || '').trim();
}

function validClosingQuote(quote, tradeDate) {
  return quote && quote.tradeDate === tradeDate && quote.isFinal === true
    && finite(quote.price) > 0 && finite(quote.changePct) !== null;
}

function enrichRecommendation(row, closeByCode, tracks, tradeDate) {
  const candidate = closeByCode.get(stockKey(row));
  const close = validClosingQuote(candidate, tradeDate) ? candidate : null;
  const publishedAfterClose = row.publishedAt && Date.parse(row.publishedAt) >= Date.parse(`${tradeDate}T15:00:00+08:00`);
  const performance = calculateRecommendationPerformance({
    signalPrice:row.price,
    closePrice:close?.price,
    signalChangePct:row.changePct,
    closeChangePct:close?.changePct
  });
  const role = row.primaryRole ? {
    primaryRole:row.primaryRole,
    entryPermission:row.entryPermission || 'watch',
    reasons:row.secondaryRoles || []
  } : classifyRecommendationRole({
    ...row,
    capital:row.capital || row.recommendationContext?.capital,
    sector:row.sectorContext || row.recommendationContext?.sector,
    analysis:row.analysis || {}
  });
  return {
    ...row,
    tracks,
    primaryRole:role.primaryRole,
    entryPermission:row.entryPermission || role.entryPermission,
    roleReasons:role.reasons,
    closePrice:finite(close?.price),
    closeChangePct:finite(close?.changePct),
    closeSource:close?.source || '',
    closeObservedAt:close?.quoteObservedAt || close?.observedAt || '',
    ...performance,
    priceReturnPct:publishedAfterClose ? null : performance.priceReturnPct,
    dataStatus:publishedAfterClose ? '盘后发布，未进入当日评价窗' : close ? '完整' : candidate ? '收盘行情待核验' : '收盘行情缺失'
  };
}

function favoriteSummary(rows = []) {
  const deduped = new Map();
  for (const row of rows) {
    if (!row?.code) continue;
    const key = JSON.stringify([row.code,row.label || '',row.addedAt || '',row.referencePrice]);
    if (!deduped.has(key)) deduped.set(key, row);
  }
  const observations = [...deduped.values()].map(row => {
    const referencePrice = finite(row.referencePrice);
    const currentPrice = finite(row.currentPrice ?? row.price);
    const snapshot = row.favoriteEntrySnapshot;
    const originalPlan = row.originalPlan || snapshot?.plan || snapshot?.tradePlan || null;
    return {...row, originalPlanStatus:originalPlan ? '已保存' : '原始计划缺失',
      modelVersion:row.modelVersion || snapshot?.modelVersion || originalPlan?.modelVersion || 'unknown',
      attribution:row.attribution || snapshot?.sourceType || originalPlan?.sourceType || 'unknown',
      returnPct:referencePrice > 0 && currentPrice > 0 ? round((currentPrice / referencePrice - 1) * 100) : null};
  });
  const permissions = ['blocked','expired','watch','armed','allowed'];
  const codes = [...new Set(observations.map(row => stockKey(row)))];
  const byCode = codes.map(code => {
    const tagged = observations.filter(row => stockKey(row) === code);
    const latest = [...tagged].sort((a,b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')))[0];
    return {...latest, labels:[...new Set(tagged.map(row => row.label || '未标记'))],
      entryPermission:permissions.find(permission => tagged.some(row => row.entryPermission === permission)) || 'unknown',
      riskReasons:[...new Set(tagged.flatMap(row => row.riskReasons || []))],
      tagCount:tagged.length};
  });
  const summarize = selected => {
    const values = selected.map(row => row.returnPct).filter(Number.isFinite);
    return {count:selected.length,validCount:values.length,
      averageReturnPct:values.length ? round(values.reduce((sum,value) => sum + value,0) / values.length) : null};
  };
  return {
    ...summarize(byCode),
    count:observations.length,
    codeCount:byCode.length,
    tagValidCount:observations.filter(row => Number.isFinite(row.returnPct)).length,
    missingOriginalCount:observations.filter(row => row.originalPlanStatus === '原始计划缺失').length,
    unknownVersionCount:observations.filter(row => row.modelVersion === 'unknown').length,
    caveats:['全部当前保存收藏，已删除收藏历史不可核验，存在幸存者偏差',
      '手工与自动归因、原始计划、模型版本及复权/公司行为未核验时保持unknown；不用于策略调权'],
    rows:observations,byCode,
    byLabel:[...new Set(observations.map(row => row.label || '未标记'))].map(label => ({label,
      ...summarize(observations.filter(row => (row.label || '未标记') === label))})),
    byCohort:[...new Set(observations.map(row => String(row.addedAt || 'unknown').slice(0,10)))].map(date => ({date,
      ...summarize(observations.filter(row => String(row.addedAt || 'unknown').slice(0,10) === date))}))
  };
}

function performanceSummary(rows = []) {
  const values = rows.map(row => finite(row.priceReturnPct)).filter(value => value !== null).sort((a, b) => a - b);
  if (!values.length) return {count:0,averageReturnPct:null,medianReturnPct:null,positive:0,negative:0,flat:0,
    worstReturnPct:null,bestReturnPct:null,averageExBestPct:null,topPositiveContributionPct:null};
  const middle = Math.floor(values.length / 2);
  const positiveSum = values.filter(value=>value > 0).reduce((sum,value)=>sum+value,0);
  return {
    count:values.length,
    averageReturnPct:round(values.reduce((sum, value) => sum + value, 0) / values.length),
    medianReturnPct:round(values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2),
    positive:values.filter(value => value > 0).length,
    negative:values.filter(value => value < 0).length,
    flat:values.filter(value => value === 0).length,
    worstReturnPct:round(values[0]),
    bestReturnPct:round(values.at(-1)),
    averageExBestPct:values.length > 1 ? round(values.slice(0,-1).reduce((sum,value)=>sum+value,0)/(values.length-1)) : null,
    topPositiveContributionPct:positiveSum > 0 ? round(Math.max(0,values.at(-1))/positiveSum*100) : null
  };
}

function portfolioSummary(portfolio = {}, closeByCode = new Map(), tradeDate = '') {
  if (portfolio.unavailableReason) return {positions:[],unavailableReason:portfolio.unavailableReason};
  const legacyPositions = (portfolio.legacy?.positions || []).filter(row => finite(row.quantity) > 0).map(row => {
    const close = closeByCode.get(stockKey(row));
    const valid = validClosingQuote(close,tradeDate);
    const quantity = Number(row.quantity), costPrice = finite(row.costPrice);
    return {code:row.code,name:row.name,quantity,costPrice,closePrice:valid ? Number(close.price) : null,
      costValue:costPrice !== null ? quantity*costPrice : null,
      marketValue:valid ? quantity*Number(close.price) : null,
      unrealizedPnl:valid && costPrice !== null ? quantity*(Number(close.price)-costPrice) : null,
      quoteStatus:valid ? 'final' : 'missing-final',quoteSource:valid ? close.source || '' : '',
      holdingPeriod:row.entrySnapshot?.holdingPeriod || '旧仓未采集'};
  });
  const coveredLegacy = legacyPositions.filter(row => row.unrealizedPnl !== null);
  const legacy = {type:'historical-manual',positions:legacyPositions,
    valuationStatus:coveredLegacy.length === legacyPositions.length ? 'complete' : 'partial',
    coveredCost:coveredLegacy.reduce((sum,row) => sum+row.costValue,0),
    coveredUnrealizedPnl:coveredLegacy.reduce((sum,row) => sum+row.unrealizedPnl,0),
    missingCodes:legacyPositions.filter(row => row.quoteStatus !== 'final').map(row => row.code),
    accountEquity:null,reason:'旧手工账户缺初始资金和费用，仅计算有最终收盘价的持仓浮盈亏'};
  const source = portfolio.research;
  const research = source ? {type:'rule-simulated',accountId:source.accountId,cash:source.cash,
    equity:source.valuationStatus === 'complete' && source.finalized ? source.equity : null,
    marketValue:source.marketValue,realizedPnl:source.realizedPnl,
    unrealizedPnl:source.valuationStatus === 'complete' && source.finalized ? source.unrealizedPnl : null,
    feesPaid:source.feesPaid,dayPnl:source.dayPnl,maxDrawdownPct:source.maxDrawdownPct,
    valuationStatus:source.valuationStatus === 'complete' && source.finalized ? 'complete' : 'partial',
    missingQuotes:source.missingQuotes || [],equityHistory:source.equityHistory || [],
    positions:(source.positions || []).map(row => ({code:row.code,name:row.name,industry:row.industry,
      quantity:row.quantity,availableQuantity:row.availableQuantity,costPrice:row.costPrice,
      currentPrice:row.currentPrice,peakObservedPrice:row.peakObservedPrice,
      observedGivebackPct:finite(row.peakObservedPrice) > 0 && finite(row.currentPrice) !== null
        ? (Number(row.currentPrice)/Number(row.peakObservedPrice)-1)*100 : null,
      marketValue:row.marketValue,quoteStatus:row.quoteStatus,
      tradeDate:row.tradeDate,lots:(row.lots || []).map(lot => ({tradeDate:lot.tradeDate,remaining:lot.remaining,
        availableQuantity:lot.availableQuantity}))}))} : null;
  return {legacy,research,positions:[...legacyPositions,...(research?.positions || [])]};
}

function buildDailyReport(input = {}) {
  const stable = Array.isArray(input.stable) ? input.stable : [];
  const momentum = Array.isArray(input.momentum) ? input.momentum : [];
  const closeByCode = new Map((input.closingQuotes || []).filter(row => row?.code).map(row => [stockKey(row), row]));
  const tracksByCode = new Map();
  for (const [track, rows] of [['A', stable], ['B', momentum]]) {
    for (const row of rows) {
      const code = stockKey(row);
      if (!code) continue;
      const tracks = tracksByCode.get(code) || [];
      if (!tracks.includes(track)) tracks.push(track);
      tracksByCode.set(code, tracks);
    }
  }
  const allByCode = new Map();
  for (const row of [...stable, ...momentum].sort((a, b) => Date.parse(a.publishedAt || 0) - Date.parse(b.publishedAt || 0))) {
    const code = stockKey(row);
    if (code && !allByCode.has(code)) allByCode.set(code, enrichRecommendation(row, closeByCode, tracksByCode.get(code) || [], input.tradeDate));
  }
  const all = [...allByCode.values()];
  const triggered = (input.triggered || stable.filter(row => row.entryPermission === 'allowed' && row.triggeredAt)
    .concat(momentum.filter(row => row.entryPermission === 'allowed' && row.triggeredAt)))
    .filter(row => row.entryPermission === 'allowed' && row.triggeredAt && !row.invalidated && !row.terminal
      && row.triggerEvent?.type === 'entry-allowed' && row.triggerEvent?.verified === true
      && row.triggerEvent?.id && row.triggerEvent?.source)
    .map(row => enrichRecommendation({...row,price:finite(row.triggerEvent?.referencePrice ?? row.triggerEvent?.price),
      publishedAt:row.triggeredAt}, closeByCode, row.tracks || [row.track].filter(Boolean), input.tradeDate));
  const followUp = (input.followUp || []).filter(row => row.originalTradeDate && row.originalTradeDate < input.tradeDate)
    .map(row => enrichRecommendation({...row,checkpoint:`${row.originalTradeDate} ${row.checkpoint || ''}`.trim()},
      closeByCode, row.tracks || [], input.tradeDate));
  const ranked = all.filter(row => Number.isFinite(row.priceReturnPct));
  const best = [...ranked].sort((a, b) => b.priceReturnPct - a.priceReturnPct).slice(0, 10);
  const worst = [...ranked].sort((a, b) => a.priceReturnPct - b.priceReturnPct).slice(0, 10);
  const missingCloseCount = all.filter(row => row.dataStatus !== '完整' && row.dataStatus !== '盘后发布，未进入当日评价窗').length;
  const missingFollowUpCount = followUp.filter(row => row.dataStatus !== '完整').length;
  const marketComponents = input.dataQuality?.components || input.market?.components || {};
  const componentIssues = Object.values(marketComponents).filter(item => item && !['fresh','empty','not-applicable'].includes(item.status));
  const report = {
    schemaVersion:2,
    tradeDate:String(input.tradeDate || ''),
    generatedAt:input.generatedAt || new Date().toISOString(),
    cutoffAt:input.cutoffAt || '',
    modelVersion:input.modelVersion || '',
    implementationVersion:input.implementationVersion || '',
    parameterVersion:input.parameterVersion || '',
    dataContractVersion:input.dataContractVersion || '',
    planContractVersion:input.planContractVersion || '',
    termDefinitions:termDefinitions(),
    status:missingCloseCount || missingFollowUpCount || componentIssues.length || input.market?.warnings?.length || input.warnings?.length
      || input.dataQuality?.missing?.length || input.publishedOutcomes?.dataStatus === 'failed' ? 'partial' : 'complete',
    summary:input.summary || `共复盘 ${all.length} 只推荐，${missingCloseCount} 只缺少收盘行情。`,
    market:input.market || {breadth:{}},
    sectors:Array.isArray(input.sectors) ? input.sectors : [],
    recommendations:{
      stable:stable.map(row => enrichRecommendation(row, closeByCode, ['A'], input.tradeDate)),
      momentum:momentum.map(row => enrichRecommendation(row, closeByCode, ['B'], input.tradeDate)),
      all,
      followUp,
      best,
      worst,
      overlapCount:[...tracksByCode.values()].filter(tracks => tracks.length > 1).length,
      performance:{
        published:performanceSummary(all),
        triggered:performanceSummary(triggered)
      }
    },
    publishedOutcomes:input.publishedOutcomes || null,
    strategyExperiments:input.strategyExperiments || null,
    legacyBroadList:Array.isArray(input.legacyBroadList) ? {count:input.legacyBroadList.length,rows:input.legacyBroadList,
      sourceType:'legacy-broad-list',excludedFromStrategyStats:true} : input.legacyBroadList || {count:0,rows:[],excludedFromStrategyStats:true},
    nextDayConditions:Array.isArray(input.nextDayConditions) ? input.nextDayConditions : all.map(row => {
      const plan = row.planState?.tradePlan || row.plan || row.tradePlan || row.analysis?.tradePlan || {};
      return {code:row.code,planId:row.planId || plan.planId || '',entryPermission:row.entryPermission,
        trigger:plan.feasibility && plan.feasibility.status !== 'feasible'
          ? `当前无合格买点：${plan.feasibility.reason || '价格区间待核验'}`
          : plan.trigger || row.buyCondition || (plan.confirmationPrice > 0 ? `${row.planState?.confirmationTimeframe || '冻结买点'}确认价格 ${plan.confirmationPrice}` : '触发证据待核验'),
        invalidation:plan.invalidation || row.invalidation || (plan.invalidationPrice > 0 ? `失效价 ${plan.invalidationPrice}` : '失效价待核验'),
        expiresAt:row.expiresAt || plan.expiresAt || row.entryExpiryDate || plan.entryExpiryDate || '',
        maxEntryPrice:row.maxEntryPrice ?? plan.maxEntryPrice,
        dataPrerequisites:[...(plan.dataPrerequisites || row.dataPrerequisites || []),
          ...(plan.feasibility?.status !== 'feasible' && plan.feasibility?.reason ? [plan.feasibility.reason] : [])]};
    }),
    favorites:favoriteSummary(input.favorites),
    favoriteHistory:{removedCount:input.removedFavoriteEvents?.length || 0,
      removedEvents:input.removedFavoriteEvents || []},
    portfolio:portfolioSummary(input.portfolio,closeByCode,input.tradeDate),
    news:Array.isArray(input.news) ? input.news : [],
    checkpoints:Array.isArray(input.checkpoints) ? input.checkpoints : [],
    dataQuality:{
      ...(input.dataQuality || {}),
      missingCloseCount,
      missingFollowUpCount,
      missing:input.dataQuality?.missing || input.market?.missing || [],
      sourceSwitches:input.dataQuality?.sourceSwitches || input.market?.sourceSwitches || [],
      components:marketComponents,
      warnings:[...(input.market?.warnings || []), ...(input.warnings || [])]
    }
  };
  return report;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function pct(value) {
  const number = finite(value);
  return number === null ? '--' : Math.abs(number) < .005 ? '0.00%' : `${number > 0 ? '+' : ''}${number.toFixed(2)}%`;
}

function pctClass(value) {
  const number = finite(value);
  return number === null || Math.abs(number) < .005 ? '' : number > 0 ? 'up' : 'down';
}

function price(value) {
  const number = finite(value);
  return number !== null && number > 0 ? number.toFixed(2) : '--';
}

function renderRecommendationRows(rows = []) {
  if (!rows.length) return '<tr><td colspan="15">无可复盘推荐</td></tr>';
  return rows.map(row => `<tr><td>${escapeHtml(row.code)}</td><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.industry || '待确认')}</td><td>${escapeHtml((row.tracks || []).join('/'))}</td><td>${escapeHtml(row.primaryRole)}</td><td>${escapeHtml(row.holdingPeriod || '待确认')}</td><td>${escapeHtml(row.checkpoint || row.publishedAt || '发布时间待核验')}</td><td>${escapeHtml(row.earliestBuyDate || '待核验')}</td><td>${escapeHtml(row.earliestSellDate || '待核验')}</td><td>${price(row.price)}</td><td class="${pctClass(row.changePct)}">${pct(row.changePct)}</td><td>${price(row.closePrice)}</td><td class="${pctClass(row.closeChangePct)}">${pct(row.closeChangePct)}</td><td class="${pctClass(row.priceReturnPct)}">${pct(row.priceReturnPct)}</td><td>${escapeHtml(row.dataStatus)}</td></tr>`).join('');
}

function renderDailyReportBaseHtml(report = {}) {
  const breadth = report.market?.breadth || {};
  const news = (report.news || []).map(item => {
    const url = safeUrl(item.url);
    const title = escapeHtml(item.title || '未命名资讯');
    return `<li>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${title}</a>` : title}</li>`;
  }).join('') || '<li>无可核验资讯</li>';
  const warnings = (report.dataQuality?.warnings || []).map(value => `<li>${escapeHtml(value)}</li>`).join('') || '<li>无</li>';
  const componentRows = Object.entries(report.dataQuality?.components || {}).map(([name,item]) =>
    `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(item?.status || 'unknown')}</td><td>${escapeHtml(item?.source || '')}</td><td>${escapeHtml(item?.sourceObservedAt || item?.fetchedAt || '')}</td><td>${escapeHtml(item?.reason || '')}</td></tr>`).join('');
  const sectors = (report.sectors || []).slice(0, 20).map(item => `<tr><td>${escapeHtml(item.name)}</td><td class="${pctClass(item.changePct)}">${pct(item.changePct)}</td><td>${escapeHtml(item.themeRegime?.state ? `双轨影子：${item.themeRegime.state}` : item.rotationPhase?.phase || item.rotationState || item.capitalTrend?.phase || '待确认')}</td><td class="${pctClass(item.mainNetInflow)}">${escapeHtml(item.mainNetInflow ?? '接口未提供')}</td></tr>`).join('') || '<tr><td colspan="4">板块历史快照缺失</td></tr>';
  const performance = report.recommendations?.performance || {};
  const checkpoints = (report.checkpoints || []).map(item => `<li>${escapeHtml(item.label)}：${escapeHtml(item.status === 'covered' ? '已覆盖' : item.status === 'stale' ? '最近快照过期' : '缺失')}${item.publishedAt ? `，发布 ${escapeHtml(item.publishedAt)}` : ''}${item.reason ? `；${escapeHtml(item.reason)}` : ''}</li>`).join('') || '<li>无检查点记录</li>';
  const performanceHtml = `<p>全天首次发布观察 ${performance.published?.count || 0}只，平均 ${pct(performance.published?.averageReturnPct)}，中位数 ${pct(performance.published?.medianReturnPct)}，最差 ${pct(performance.published?.worstReturnPct)}，剔除最大赢家 ${pct(performance.published?.averageExBestPct)}，最大赢家占正收益 ${pct(performance.published?.topPositiveContributionPct)}；已记录真实触发 ${performance.triggered?.count || 0}只，平均 ${pct(performance.triggered?.averageReturnPct)}。观察表现不等于账户收益。</p><ul>${checkpoints}</ul>`;
  const versions = `实现 ${report.implementationVersion || 'unknown'} · 参数 ${report.parameterVersion || 'unknown'} · 数据契约 ${report.dataContractVersion || 'unknown'} · 计划契约 ${report.planContractVersion || 'unknown'}`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(report.tradeDate)} 全局收盘报告</title><style>body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:24px;color:#172033;background:#f5f7fb}main{max-width:1440px;margin:auto;background:#fff;padding:24px;border:1px solid #d9e0ea;border-radius:8px}h1,h2{margin:0 0 12px}section{margin:24px 0}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #d9e0ea;padding:8px;text-align:left;white-space:nowrap}th{background:#f1f5f9}.up{color:#dc2626}.down{color:#16a34a}.meta{color:#64748b}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.grid div{padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px}.scroll{overflow:auto}@media(max-width:760px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}main{padding:12px;margin:0}}</style></head><body><main><h1>${escapeHtml(report.tradeDate)} 全局收盘报告</h1><p class="meta">修订 r${String(report.revision || 1).padStart(3, '0')} · ${escapeHtml(report.status || 'partial')} · ${escapeHtml(report.generatedAt || '')}<br>${escapeHtml(versions)}</p><p>${escapeHtml(report.summary || '')}</p><section><h2>大盘</h2><div class="grid"><div>上涨<br><b>${escapeHtml(breadth.up ?? '--')}</b></div><div>下跌<br><b>${escapeHtml(breadth.down ?? '--')}</b></div><div>平盘<br><b>${escapeHtml(breadth.flat ?? '--')}</b></div><div>成交额<br><b>${escapeHtml(report.market?.turnover ?? '--')}</b></div></div></section><section><h2>板块轮动</h2><div class="scroll"><table><thead><tr><th>板块</th><th>涨跌幅</th><th>阶段</th><th>主力净额</th></tr></thead><tbody>${sectors}</tbody></table></div></section><section><h2>推荐复盘</h2><p>A ${report.recommendations?.stable?.length || 0}只，B ${report.recommendations?.momentum?.length || 0}只，重叠 ${report.recommendations?.overlapCount || 0}只；最佳/最差榜只统计收盘数据完整的样本。</p>${performanceHtml}<div class="scroll"><table><thead><tr><th>代码</th><th>名称</th><th>板块</th><th>方案</th><th>角色</th><th>周期</th><th>信号时点</th><th>最早可买</th><th>最早可卖</th><th>推荐时价格</th><th>当时涨幅</th><th>当日收盘</th><th>收盘涨幅</th><th>推荐后表现</th><th>数据</th></tr></thead><tbody>${renderRecommendationRows(report.recommendations?.all)}</tbody></table></div></section><section><h2>历史推荐跟踪</h2><p>保留原推荐日期；推荐后表现为从原参考价到本日收盘的观察涨幅，不等于已成交收益。</p><div class="scroll"><table><thead><tr><th>代码</th><th>名称</th><th>板块</th><th>方案</th><th>角色</th><th>周期</th><th>信号时点</th><th>最早可买</th><th>最早可卖</th><th>推荐时价格</th><th>当时涨幅</th><th>当日收盘</th><th>收盘涨幅</th><th>推荐后表现</th><th>数据</th></tr></thead><tbody>${renderRecommendationRows(report.recommendations?.followUp)}</tbody></table></div></section><section><h2>最佳 10</h2><div class="scroll"><table><thead><tr><th>代码</th><th>名称</th><th>板块</th><th>方案</th><th>角色</th><th>周期</th><th>信号时点</th><th>最早可买</th><th>最早可卖</th><th>推荐时价格</th><th>当时涨幅</th><th>当日收盘</th><th>收盘涨幅</th><th>推荐后表现</th><th>数据</th></tr></thead><tbody>${renderRecommendationRows(report.recommendations?.best)}</tbody></table></div></section><section><h2>最差 10</h2><div class="scroll"><table><thead><tr><th>代码</th><th>名称</th><th>板块</th><th>方案</th><th>角色</th><th>周期</th><th>信号时点</th><th>最早可买</th><th>最早可卖</th><th>推荐时价格</th><th>当时涨幅</th><th>当日收盘</th><th>收盘涨幅</th><th>推荐后表现</th><th>数据</th></tr></thead><tbody>${renderRecommendationRows(report.recommendations?.worst)}</tbody></table></div></section>${renderFavoriteSection(report)}<section><h2>消息</h2><ul>${news}</ul></section><section><h2>数据质量</h2><div class="scroll"><table><thead><tr><th>组件</th><th>状态</th><th>来源</th><th>来源时间</th><th>原因</th></tr></thead><tbody>${componentRows || '<tr><td colspan="5">旧报告未保存组件状态</td></tr>'}</tbody></table></div></section><section><h2>数据异常</h2><ul>${warnings}</ul></section></main></body></html>`;
}

function detail(value) {
  return escapeHtml(value === null || value === undefined || value === '' ? 'unknown'
    : typeof value === 'object' ? JSON.stringify(value) : value);
}

function renderFavoriteSection(report) {
  const favorites = report.favorites || {};
  const legacy = report.portfolio?.legacy || {};
  const research = report.portfolio?.research;
  const tagRows = (favorites.rows || []).map(row => `<tr><td>${escapeHtml(row.label)}</td><td>${escapeHtml(row.code)}</td><td>${escapeHtml(row.name)}</td><td>${detail(row.addedAt)}</td><td>${price(row.referencePrice)}</td><td>${price(row.currentPrice)}</td><td class="${pctClass(row.returnPct)}">${pct(row.returnPct)}</td><td>${detail(row.attribution)}</td><td>${detail(row.originalPlanStatus)}</td><td>${detail(row.modelVersion)}</td></tr>`).join('');
  const codeRows = (favorites.byCode || []).map(row => `<tr><td>${escapeHtml(row.code)}</td><td>${detail(row.labels)}</td><td>${detail(row.entryPermission)}</td><td>${detail(row.riskReasons)}</td><td class="${pctClass(row.returnPct)}">${pct(row.returnPct)}</td></tr>`).join('');
  const summaries = [...(favorites.byLabel || []).map(row => ({...row,key:`标签 ${row.label}`})),
    ...(favorites.byCohort || []).map(row => ({...row,key:`加入队列 ${row.date}`}))]
    .map(row => `<tr><td>${escapeHtml(row.key)}</td><td>${row.count}</td><td>${row.validCount}</td><td class="${pctClass(row.averageReturnPct)}">${pct(row.averageReturnPct)}</td></tr>`).join('');
  const legacyRows = (legacy.positions || []).map(row => `<tr><td>${detail(row.code)}</td><td>${detail(row.name)}</td><td>${detail(row.quantity)}</td><td>${price(row.costPrice)}</td><td>${price(row.closePrice)}</td><td class="${pctClass(row.unrealizedPnl)}">${detail(row.unrealizedPnl)}</td><td>${detail(row.quoteStatus)}</td></tr>`).join('');
  const researchRows = (research?.positions || []).map(row => `<tr><td>${detail(row.code)}</td><td>${detail(row.quantity)} / ${detail(row.availableQuantity)}</td><td>${price(row.costPrice)}</td><td>${price(row.currentPrice)}</td><td>${detail(row.tradeDate)}</td><td>${detail(row.quoteStatus)}</td></tr>`).join('');
  return `<section><h2>收藏与模拟账户</h2><p>全部标签 ${favorites.count || 0} 条，代码去重 ${favorites.codeCount || 0} 只，有效 ${favorites.validCount || 0} 只，代码等权平均 ${pct(favorites.averageReturnPct)}。重复标签不新增股票敞口；收藏观察不等于实际成交收益。</p><p>原始计划缺失 ${favorites.missingOriginalCount || 0} 条；已移除事件 ${report.favoriteHistory?.removedCount || 0} 条，仅保留最小审计引用。${(favorites.caveats || ['当前保存收藏存在幸存者偏差']).map(escapeHtml).join('；')}</p><div class="scroll"><table><thead><tr><th>标签</th><th>代码</th><th>名称</th><th>加入时点</th><th>原参考价</th><th>观察价</th><th>观察涨幅</th><th>归因</th><th>原计划</th><th>版本</th></tr></thead><tbody>${tagRows || '<tr><td colspan="10">无收藏观察</td></tr>'}</tbody></table><table><thead><tr><th>代码汇总</th><th>全部标签</th><th>聚合许可/风险</th><th>风险原因</th><th>最新加入观察</th></tr></thead><tbody>${codeRows || '<tr><td colspan="5">无代码观察</td></tr>'}</tbody></table><table><thead><tr><th>范围</th><th>条数</th><th>有效</th><th>平均观察涨幅</th></tr></thead><tbody>${summaries || '<tr><td colspan="4">无标签/加入队列</td></tr>'}</tbody></table></div><h3>历史手工模拟</h3><p>持仓 ${legacy.positions?.length || 0} 只，核验 ${(legacy.positions?.length || 0) - (legacy.missingCodes?.length || 0)} 只；已核验成本 ${detail(legacy.coveredCost)}，部分持仓浮盈亏 <span class="${pctClass(legacy.coveredUnrealizedPnl)}">${detail(legacy.coveredUnrealizedPnl)}</span>。${escapeHtml(legacy.reason || '历史仓位未采集')}</p><div class="scroll"><table><thead><tr><th>代码</th><th>名称</th><th>数量</th><th>成本</th><th>收盘价</th><th>浮盈亏</th><th>状态</th></tr></thead><tbody>${legacyRows || '<tr><td colspan="7">无历史手工持仓</td></tr>'}</tbody></table></div><h3>规则模拟</h3><p>${research ? `估值${research.valuationStatus === 'complete' ? '完整' : '部分缺失'}；现金 ${detail(research.cash)}，权益 ${detail(research.equity)}，已实现 ${detail(research.realizedPnl)}，未实现 ${detail(research.unrealizedPnl)}，费用 ${detail(research.feesPaid)}，当日损益 ${detail(research.dayPnl)}，最大回撤 ${pct(research.maxDrawdownPct)}` : '尚未创建规则模拟账户'}</p><div class="scroll"><table><thead><tr><th>代码</th><th>持仓/可卖</th><th>成本</th><th>现价</th><th>行情日期</th><th>状态</th></tr></thead><tbody>${researchRows || '<tr><td colspan="6">无规则模拟持仓</td></tr>'}</tbody></table></div></section>`;
}

function renderEvidenceSections(report) {
  const path = report.market?.path;
  const anchors = Array.isArray(path) ? path : [
    ...(path?.peakBreadth ? [{...path.peakBreadth,label:'含竞价全天峰值'}] : []),
    ...(path?.continuousPeakBreadth ? [{...path.continuousPeakBreadth,label:'连续交易峰值'}] : []),
    ...Object.entries(path?.anchors || report.market?.anchors || {}).map(([label,row])=>({...row,label}))];
  const pathRows = anchors.map(row => `<tr><td>${detail(row.label || row.phase)}</td><td>${detail(row.observedAt || row.fetchedAt)}</td><td>${detail(row.state || row.marketRegime)}</td><td>${detail(row.breadth)}</td><td>${detail(row.indices)}</td><td>${detail(row.limits)}</td><td>${detail(row.turnover)}</td><td>${detail(row.source)}</td><td>${detail(row.scope || row.dataQuality)}</td></tr>`).join('');
  const sectorRows = (report.sectors || []).map(row => `<tr><td>${escapeHtml(row.name)}</td><td>${detail(row.stateTransitions || row.transitions || row.shadowRotation)}</td><td>${detail(row.evidence || {diffusion:row.participation,capital:row.capitalTrend || {net1:row.mainNetInflow,net3:row.mainNet3,net5:row.mainNet5,net10:row.mainNet10},ladder:row.ladder,structureCoverage:row.structureCoverage})}</td><td>${detail(row.dataQuality || {source:row.capitalSource,date:row.capitalTradeDate,stale:row.capitalStale,missing:row.shadowRotation?.missing})}</td></tr>`).join('');
  const conditions = (report.nextDayConditions || []).map(row => `<tr><td>${escapeHtml(row.code)}</td><td>${detail(row.planId)}</td><td>${detail(row.entryPermission)}</td><td>${detail(row.trigger)}</td><td>${detail(row.invalidation)}</td><td>${detail(row.expiresAt)}</td><td>${price(row.maxEntryPrice)}</td><td>${detail(row.dataPrerequisites)}</td></tr>`).join('');
  const funnel=report.market?.planFunnel;
  const publishedFunnel=report.market?.publishedPlanFunnel;
  const funnelText=[publishedFunnel ? `全天发布批次 ${detail(publishedFunnel.publishedBatches)}，快照信号 ${detail(publishedFunnel.publishedSignals)}，合并生命周期 ${detail(publishedFunnel.episodes)}，冻结计划 ${detail(publishedFunnel.frozenPlans)}，价格可行 ${detail(publishedFunnel.priceFeasible)}，发布许可 ${detail(publishedFunnel.publishedAllowed)}，核验触发 ${detail(publishedFunnel.verifiedTriggers)}，核验成交 ${detail(publishedFunnel.verifiedFills)}；原因 ${detail(publishedFunnel.reasons)}。` : '全天已发布决策漏斗缺失。',
    funnel ? `最终快照展示计划 ${detail(funnel.discovered)}，数据可用 ${detail(funnel.dataAvailable ?? '--')}，结构成立 ${detail(funnel.structureEstablished ?? '--')}，价格可行 ${detail(funnel.priceFeasible)}，风险通过 ${detail(funnel.riskPassed ?? '--')}，等待触发 ${detail(funnel.armed)}，当前许可 ${detail(funnel.currentlyAllowed)}；原因 ${detail(funnel.reasons)}。` : '最终快照计划漏斗缺失。'].join(' ');
  return `<section><h2>大盘状态路径</h2><div class="scroll"><table><thead><tr><th>锚点</th><th>时点</th><th>状态</th><th>广度</th><th>指数</th><th>涨跌停</th><th>成交额</th><th>来源</th><th>范围/质量</th></tr></thead><tbody>${pathRows || '<tr><td colspan="9">盘中路径缺失，不用收盘快照补造</td></tr>'}</tbody></table></div><p>源切换 ${detail(report.dataQuality?.sourceSwitches)}；缺失清单 ${detail(report.dataQuality?.missing)}。跨源不相减。</p></section><section><h2>板块证据与状态转移</h2><p>扩散、资金与梯队分别核验；重叠证据不重复计分。</p><div class="scroll"><table><thead><tr><th>板块</th><th>状态转移</th><th>证据</th><th>数据质量</th></tr></thead><tbody>${sectorRows || '<tr><td colspan="4">缺少板块证据</td></tr>'}</tbody></table></div></section><section><h2>推荐计划漏斗</h2><p>${funnelText}</p></section><section><h2>次日条件清单</h2><p>盘后条件不是次日已触发；过期不续期，失效优先，跳空越过最高入场价放弃。</p><div class="scroll"><table><thead><tr><th>代码</th><th>计划</th><th>许可</th><th>触发条件</th><th>失效条件</th><th>有效期限</th><th>最高入场价</th><th>数据前提</th></tr></thead><tbody>${conditions || '<tr><td colspan="8">无冻结次日计划</td></tr>'}</tbody></table></div></section><section><h2>兼容广泛名单</h2><p>${report.legacyBroadList?.count || 0} 条，单列兼容统计，不纳入正式策略样本。${detail(report.legacyBroadList?.reason || report.legacyBroadList?.sourceType)}</p></section>`;
}

function renderDailyReportHtml(report = {}) {
  let html = renderDailyReportBaseHtml(report).replace('<section><h2>数据异常</h2>',
    `${renderEvidenceSections(report)}<section><h2>数据异常</h2>`);
  const termRows = (report.termDefinitions || []).map(row => `<tr><td>${escapeHtml(row.id)}</td><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.version)}</td><td>${escapeHtml(row.definition)}</td><td>${escapeHtml(row.limit)}</td></tr>`).join('');
  html = html.replace('<section><h2>数据异常</h2>',`<section id="report-terms"><h2>术语与规则</h2><div class="scroll"><table><thead><tr><th>命名空间</th><th>术语</th><th>状态</th><th>版本</th><th>定义</th><th>限制</th></tr></thead><tbody>${termRows || '<tr><td colspan="6">旧版报告未保存术语字典</td></tr>'}</tbody></table></div></section><section><h2>数据异常</h2>`);
  if (report.strategyExperiments) {
    const experiment = report.strategyExperiments;
    const rows = ['baseline','H1','H2','H3','H4',...(experiment.themeManifest ? ['H5','H6','H7'] : []),
      ...(experiment.qualityManifest ? experiment.qualityManifest.experiments.map(row=>row.id) : [])].map(id=>{
      const decisions = (experiment.decisions || []).filter(row=>row.id === id);
      return `<tr><td>${id}</td><td>${decisions.filter(row=>row.status === 'pass').length}</td><td>${decisions.filter(row=>row.status === 'fail').length}</td><td>${decisions.filter(row=>row.status === 'unknown').length}</td></tr>`;
    }).join('');
    html = html.replace('<section><h2>数据异常</h2>',`<section><h2>预注册影子实验</h2><p>版本 ${detail(experiment.manifest?.parameterVersion)}，冻结时点 ${detail(experiment.manifest?.frozenAt)}。H1市场减速、H2板块扩散、H3冻结买点、H4持有退出；H5容量与梯队、H6独立60分钟回踩、H7组合采用独立冻结版本 ${detail(experiment.themeManifest?.version)}，最早观察交易日 ${detail(experiment.themeManifest?.firstTradeDate)}。Q1买点排序、Q2路径联合降级、Q3独立退出；S1买点、S2多日资金、S3市场风险均为独立影子对照，使用版本 ${detail(experiment.qualityManifest?.version)}，最早观察交易日 ${detail(experiment.qualityManifest?.firstTradeDate)}。通过条件不等于成交或收益提升，未满足前瞻样本门槛，不自动升级正式策略。</p><table><thead><tr><th>实验</th><th>条件通过</th><th>未通过</th><th>证据未知</th></tr></thead><tbody>${rows}</tbody></table></section><section><h2>数据异常</h2>`);
  }
  const review = report.publishedOutcomes;
  const episodeLinks = (review?.episodeChunks || []).filter(row => /^outcome-details\/[a-f0-9]{64}\.jsonl$/.test(row.file)
    && row.file.slice(16,80) === row.sha256).map((row,index) => `<li><a href="${row.file}" target="_blank" rel="noopener noreferrer">明细块 ${index + 1}</a>：${row.count} 条，SHA-256 ${row.sha256}</li>`).join('');
  if (episodeLinks) html = html.replace('<section><h2>数据异常</h2>',
    `<section><h2>冻结评价明细</h2><p>应用内可分页查看；离线浏览器可打开同目录下的原始JSONL明细块。</p><ul>${episodeLinks}</ul></section><section><h2>数据异常</h2>`);
  if (!review) return reportHtmlWithViews(html);
  if (review.shadowReplay) {
    const replay = review.shadowReplay;
    const rows = (replay.variants || []).map(row=>`<tr><td>${detail(row.id)}</td><td>${row.coverage?.executed || 0}</td><td>${row.coverage?.missing || 0}</td><td>${row.coverage?.unexecuted || 0}</td><td class="${pctClass(row.netReturnPct)}">${pct(row.netReturnPct)}</td><td>${detail(row.valuationStatus)}</td><td>${detail(row.validation)}</td></tr>`).join('');
    html = html.replace('<section><h2>数据异常</h2>',`<section><h2>同资金影子回放</h2><p>保守次日开盘模拟，不等于实际成交。原基线是冻结结构止损/第一目标退出，题材基线从H5–H7冻结日重新起算且使用相同资金、费用与仓位约束；都不冒充旧版所有历史交易。缺少历史限价、停牌或最终日线时不成交；A/B共享个股归属不能相加成组合收益。${detail(replay.reason)}</p><div class="scroll"><table><thead><tr><th>方案</th><th>模拟入场</th><th>未知</th><th>未成交</th><th>扣费净值收益</th><th>估值</th><th>分路线验证</th></tr></thead><tbody>${rows || '<tr><td colspan="7">回放尚未可用</td></tr>'}</tbody></table></div></section><section><h2>数据异常</h2>`);
  }
  if (!review.counts) {
    const scope = review.scope === 'report-date-only' ? '仅含报告当日发布账本' : '已核验发布账本';
    const section = `<section><h2>已发布推荐评价</h2><p>${escapeHtml(scope)}的决策漏斗已保留；收益、触发观察及成交统计未知，等待补齐行情后重试。</p>${review.reason ? `<p>${escapeHtml(review.reason)}</p>` : ''}</section>`;
    return reportHtmlWithViews(html.replace('<section><h2>数据异常</h2>',`${section}<section><h2>数据异常</h2>`));
  }
  const verified = item => ['executable','filled','verified'].includes(item.execution?.status)
    && item.execution?.verified === true;
  const rows = (review.horizons || []).map(horizon => {
    const cells = ['observations','triggerObservations','nextOpenProxyObservations','executionObservations'].map(field => {
      const saved = review.horizonSummaries?.[horizon]?.[field];
      if (saved) return `<td>${saved.count}</td><td class="${pctClass(saved.meanReturnPct)}">${pct(saved.meanReturnPct)}</td>`;
      const values = (review.episodes || []).filter(item => field !== 'executionObservations' || verified(item))
        .map(item => field === 'nextOpenProxyObservations' ? item.nextOpenProxy?.observations?.[horizon] : item[field]?.[horizon]).filter(item => item?.status === 'observed')
        .map(item => finite(field === 'executionObservations' ? item.netReturnPct : item.returnPct)).filter(value => value !== null);
      const average = values.length ? values.reduce((sum,value) => sum + value,0) / values.length : null;
      return `<td>${values.length}</td><td class="${pctClass(average)}">${pct(average)}</td>`;
    }).join('');
    return `<tr><td>${escapeHtml(horizon)}日</td>${cells}</tr>`;
  }).join('');
  const counts = review.counts || {};
  const forward = review.forwardValidation;
  const forwardHtml = forward ? `<p>前瞻验证：冻结后 ${forward.tradingDays}/${forward.requiredTradingDays} 个交易日；A ${forward.routes?.A?.mature || 0}/30，B ${forward.routes?.B?.mature || 0}/30 个成熟可成交episode。${escapeHtml(forward.reason)}；不会自动调权。</p>` : '';
  const executionCount = review.verifiedExecutionCount ?? (review.episodes || []).filter(verified).length;
  const proxyCounts = counts.nextOpenProxy || (Number(review.schemaVersion || 1) < 2 ? counts.execution : {}) || {};
  const section = `<section><h2>已发布推荐评价</h2><p>发布批次 ${counts.publishedBatches || 0}，快照记录 ${counts.publishedSignals || 0} 条，合并后 ${counts.episodes || 0} 个观察episode；可观察 ${counts.observations?.observed || 0}，未到期 ${counts.observations?.immature || 0}，到期缺行情 ${counts.observations?.missing || 0}；nextOpenProxy 次日开盘反事实代理 ${proxyCounts.executable || 0}，未成交 ${proxyCounts.unfilled || 0}，证据不足 ${proxyCounts.unverified || 0}；已核验成交 ${executionCount}。参考涨幅不等于账户净收益；watch代理不计正式成交，unknown/未成交/未到期不填0。</p>${forwardHtml}${review.reason ? `<p>${escapeHtml(review.reason)}</p>` : ''}<div class="scroll"><table><thead><tr><th>窗口</th><th>发布后观察数</th><th>发布后观察</th><th>触发后观察数</th><th>触发后观察</th><th>nextOpenProxy数</th><th>开盘代理观察</th><th>成交后成熟数</th><th>已核验成交后表现</th></tr></thead><tbody>${rows || '<tr><td colspan="9">尚无成熟样本</td></tr>'}</tbody></table></div><p class="meta">本地历史及已存报告收盘最新 ${escapeHtml(review.historyLatestDate || '待核验')}；历史日线为事后读取，复权与公司行为仍需核验，不等于真实成交。跨版本和未知版本单列，缺少可比基准不计算超额，不据开发集收益自动调权。</p></section>`;
  return reportHtmlWithViews(html.replace('<section><h2>数据异常</h2>', `${section}<section><h2>数据异常</h2>`));
}

function reportHtmlWithViews(html) {
  return html.replace('<section><h2>次日条件清单</h2>', '<section id="next-day-plan"><h2>次日条件清单</h2>')
    .replace('</h1><p class="meta">','</h1><nav class="report-page-tabs"><label><input id="page-review" type="radio" name="report-page" checked>每日复盘</label><label><input id="page-plan" type="radio" name="report-page">次日预案</label><label><input id="page-terms" type="radio" name="report-page">术语与规则</label></nav><p class="meta">')
    .replace('</style>',' .report-page-tabs{display:flex;gap:8px;margin:14px 0}.report-page-tabs label{padding:8px 12px;border:1px solid #d9e0ea;background:#fff;cursor:pointer}.report-page-tabs label:has(input:checked){border-color:#0f766e;color:#0f766e;font-weight:bold}main:has(#page-review:checked)>#next-day-plan,main:has(#page-review:checked)>#report-terms,main:has(#page-plan:checked)>section:not(#next-day-plan),main:has(#page-terms:checked)>section:not(#report-terms){display:none}</style>');
}

module.exports = {
  calculateRecommendationPerformance,
  selectPublishedBatch,
  selectPublishedBatchStatus,
  classifyRecommendationRole,
  favoriteSummary,
  buildDailyReport,
  renderDailyReportHtml,
  escapeHtml,
  safeUrl
};
