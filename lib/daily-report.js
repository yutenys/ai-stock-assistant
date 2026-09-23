'use strict';

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

function selectPublishedBatch(entries = [], targetAt, maxQuoteAgeMs = 2 * 60 * 1000) {
  const target = Date.parse(targetAt);
  if (!Number.isFinite(target)) return null;
  return entries.filter(entry => {
    const published = Date.parse(entry?.publishedAt);
    const observed = Date.parse(entry?.quoteObservedAt || entry?.observedAt);
    return Number.isFinite(published) && Number.isFinite(observed)
      && published <= target && observed <= target && target - observed <= maxQuoteAgeMs;
  }).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))[0] || null;
}

function classifyRecommendationRole(item = {}) {
  const analysis = item.analysis || {};
  const capital = item.capital || {};
  const sector = item.sector || {};
  if (analysis.trendBroken) {
    return {primaryRole:'结构失效', entryPermission:'blocked', reasons:['价格结构已破坏']};
  }
  if (analysis.breakoutConfirmed && analysis.firstPullback && finite(analysis.volumeRatio) !== null
    && finite(analysis.volumeRatio) <= 1.2 && finite(capital.mainNetInflow) !== null && finite(capital.mainNetInflow) >= 0) {
    return {primaryRole:'首次回踩', entryPermission:'watch', reasons:['有效突破后的首次缩量回踩']};
  }
  if (analysis.boxStable && analysis.volumeCompressed && finite(capital.mainNetInflow) > 0) {
    return {primaryRole:'吸筹/洗盘观察', entryPermission:'watch', reasons:['箱体稳定、量能压缩且阶段资金为正']};
  }
  if (capital.available && finite(capital.netRatio) > 0
    && /扩散|流入/.test(String(sector.phase || '')) && finite(item.relativeStrength) >= 70) {
    return {primaryRole:'资金前排', entryPermission:'watch', reasons:['板块资金扩散且个股相对强度靠前']};
  }
  if (analysis.supportIntact && finite(item.distanceToResistancePct) !== null && finite(item.distanceToResistancePct) >= 3
    && finite(capital.mainNetInflow) !== null && finite(capital.mainNetInflow) >= 0) {
    return {primaryRole:'健康滞涨', entryPermission:'watch', reasons:['支撑完整、资金未背离且仍有上行空间']};
  }
  return {primaryRole:'趋势观察', entryPermission:'watch', reasons:['等待资金、趋势与入场位置形成一致证据']};
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
    dataStatus:close ? '完整' : candidate ? '收盘行情待核验' : '收盘行情缺失'
  };
}

function favoriteSummary(rows = []) {
  const excluded = new Set(['重点关注', 'personal']);
  const deduped = new Map();
  for (const row of rows) {
    if (!row?.code || excluded.has(String(row.label || '').trim())) continue;
    const key = `${row.code}|${row.addedAt || row.referencePrice || ''}`;
    if (!deduped.has(key)) deduped.set(key, row);
  }
  const observations = [...deduped.values()].map(row => {
    const referencePrice = finite(row.referencePrice);
    const currentPrice = finite(row.currentPrice ?? row.price);
    return {...row, returnPct:referencePrice && currentPrice ? round((currentPrice / referencePrice - 1) * 100) : null};
  });
  const valid = observations.map(row => row.returnPct).filter(Number.isFinite);
  return {
    count:observations.length,
    validCount:valid.length,
    averageReturnPct:valid.length ? round(valid.reduce((sum, value) => sum + value, 0) / valid.length) : null,
    rows:observations
  };
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
  for (const row of [...stable, ...momentum]) {
    const code = stockKey(row);
    if (code && !allByCode.has(code)) allByCode.set(code, enrichRecommendation(row, closeByCode, tracksByCode.get(code) || [], input.tradeDate));
  }
  const all = [...allByCode.values()];
  const followUp = (input.followUp || []).filter(row => row.originalTradeDate && row.originalTradeDate < input.tradeDate)
    .map(row => enrichRecommendation({...row,checkpoint:`${row.originalTradeDate} ${row.checkpoint || ''}`.trim()},
      closeByCode, row.tracks || [], input.tradeDate));
  const ranked = all.filter(row => Number.isFinite(row.priceReturnPct));
  const best = [...ranked].sort((a, b) => b.priceReturnPct - a.priceReturnPct).slice(0, 10);
  const worst = [...ranked].sort((a, b) => a.priceReturnPct - b.priceReturnPct).slice(0, 10);
  const missingCloseCount = all.filter(row => row.dataStatus !== '完整').length;
  const missingFollowUpCount = followUp.filter(row => row.dataStatus !== '完整').length;
  const report = {
    schemaVersion:2,
    tradeDate:String(input.tradeDate || ''),
    generatedAt:input.generatedAt || new Date().toISOString(),
    cutoffAt:input.cutoffAt || '',
    modelVersion:input.modelVersion || '',
    status:missingCloseCount || missingFollowUpCount || input.market?.warnings?.length || input.warnings?.length ? 'partial' : 'complete',
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
      overlapCount:[...tracksByCode.values()].filter(tracks => tracks.length > 1).length
    },
    favorites:favoriteSummary(input.favorites),
    portfolio:input.portfolio || {positions:[]},
    news:Array.isArray(input.news) ? input.news : [],
    dataQuality:{
      missingCloseCount,
      missingFollowUpCount,
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

function renderDailyReportHtml(report = {}) {
  const breadth = report.market?.breadth || {};
  const news = (report.news || []).map(item => {
    const url = safeUrl(item.url);
    const title = escapeHtml(item.title || '未命名资讯');
    return `<li>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${title}</a>` : title}</li>`;
  }).join('') || '<li>无可核验资讯</li>';
  const warnings = (report.dataQuality?.warnings || []).map(value => `<li>${escapeHtml(value)}</li>`).join('') || '<li>无</li>';
  const sectors = (report.sectors || []).slice(0, 20).map(item => `<tr><td>${escapeHtml(item.name)}</td><td class="${pctClass(item.changePct)}">${pct(item.changePct)}</td><td>${escapeHtml(item.rotationPhase?.phase || item.rotationState || item.capitalTrend?.phase || '待确认')}</td><td class="${pctClass(item.mainNetInflow)}">${escapeHtml(item.mainNetInflow ?? '接口未提供')}</td></tr>`).join('') || '<tr><td colspan="4">板块历史快照缺失</td></tr>';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(report.tradeDate)} 全局收盘报告</title><style>body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:24px;color:#172033;background:#f5f7fb}main{max-width:1440px;margin:auto;background:#fff;padding:24px;border:1px solid #d9e0ea;border-radius:8px}h1,h2{margin:0 0 12px}section{margin:24px 0}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #d9e0ea;padding:8px;text-align:left;white-space:nowrap}th{background:#f1f5f9}.up{color:#dc2626}.down{color:#16a34a}.meta{color:#64748b}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.grid div{padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px}.scroll{overflow:auto}@media(max-width:760px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}main{padding:12px;margin:0}}</style></head><body><main><h1>${escapeHtml(report.tradeDate)} 全局收盘报告</h1><p class="meta">修订 r${String(report.revision || 1).padStart(3, '0')} · ${escapeHtml(report.status || 'partial')} · ${escapeHtml(report.generatedAt || '')}</p><p>${escapeHtml(report.summary || '')}</p><section><h2>大盘</h2><div class="grid"><div>上涨<br><b>${escapeHtml(breadth.up ?? '--')}</b></div><div>下跌<br><b>${escapeHtml(breadth.down ?? '--')}</b></div><div>平盘<br><b>${escapeHtml(breadth.flat ?? '--')}</b></div><div>成交额<br><b>${escapeHtml(report.market?.turnover ?? '--')}</b></div></div></section><section><h2>板块轮动</h2><div class="scroll"><table><thead><tr><th>板块</th><th>涨跌幅</th><th>阶段</th><th>主力净额</th></tr></thead><tbody>${sectors}</tbody></table></div></section><section><h2>推荐复盘</h2><p>A ${report.recommendations?.stable?.length || 0}只，B ${report.recommendations?.momentum?.length || 0}只，重叠 ${report.recommendations?.overlapCount || 0}只；最佳/最差榜只统计收盘数据完整的样本。</p><div class="scroll"><table><thead><tr><th>代码</th><th>名称</th><th>板块</th><th>方案</th><th>角色</th><th>周期</th><th>信号时点</th><th>最早可买</th><th>最早可卖</th><th>推荐时价格</th><th>当时涨幅</th><th>当日收盘</th><th>收盘涨幅</th><th>推荐后表现</th><th>数据</th></tr></thead><tbody>${renderRecommendationRows(report.recommendations?.all)}</tbody></table></div></section><section><h2>历史推荐跟踪</h2><p>保留原推荐日期；推荐后表现为从原参考价到本日收盘的观察涨幅，不等于已成交收益。</p><div class="scroll"><table><thead><tr><th>代码</th><th>名称</th><th>板块</th><th>方案</th><th>角色</th><th>周期</th><th>信号时点</th><th>最早可买</th><th>最早可卖</th><th>推荐时价格</th><th>当时涨幅</th><th>当日收盘</th><th>收盘涨幅</th><th>推荐后表现</th><th>数据</th></tr></thead><tbody>${renderRecommendationRows(report.recommendations?.followUp)}</tbody></table></div></section><section><h2>最佳 10</h2><div class="scroll"><table><thead><tr><th>代码</th><th>名称</th><th>板块</th><th>方案</th><th>角色</th><th>周期</th><th>信号时点</th><th>最早可买</th><th>最早可卖</th><th>推荐时价格</th><th>当时涨幅</th><th>当日收盘</th><th>收盘涨幅</th><th>推荐后表现</th><th>数据</th></tr></thead><tbody>${renderRecommendationRows(report.recommendations?.best)}</tbody></table></div></section><section><h2>最差 10</h2><div class="scroll"><table><thead><tr><th>代码</th><th>名称</th><th>板块</th><th>方案</th><th>角色</th><th>周期</th><th>信号时点</th><th>最早可买</th><th>最早可卖</th><th>推荐时价格</th><th>当时涨幅</th><th>当日收盘</th><th>收盘涨幅</th><th>推荐后表现</th><th>数据</th></tr></thead><tbody>${renderRecommendationRows(report.recommendations?.worst)}</tbody></table></div></section><section><h2>收藏与模拟账户</h2><p>排除重点关注和personal后 ${report.favorites?.count || 0} 条，有效 ${report.favorites?.validCount || 0} 条，等权平均 ${pct(report.favorites?.averageReturnPct)}。收藏观察不等于实际成交收益。</p><p>持仓 ${report.portfolio?.positions?.length || 0} 只。${escapeHtml(report.portfolio?.unavailableReason || '模拟账户按实际记录展示。')}</p></section><section><h2>消息</h2><ul>${news}</ul></section><section><h2>数据异常</h2><ul>${warnings}</ul></section></main></body></html>`;
}

module.exports = {
  calculateRecommendationPerformance,
  selectPublishedBatch,
  classifyRecommendationRole,
  buildDailyReport,
  renderDailyReportHtml,
  escapeHtml,
  safeUrl
};
