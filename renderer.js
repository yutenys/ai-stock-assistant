const nowText = () => new Date().toLocaleString('zh-CN', { hour12: false });
const $ = (id) => document.getElementById(id);

let stocks = [];

let selected = new Set();
let view = 'card';
let labels = [];
let activeLabel = '';
let labelSorts = {};
let portfolio = [];
let simulatedTrades = [];
let activeDetailCode = null;
let isRefreshing = false;
let labelEditMode = false;
let labelNameDraft = '';
let stockLabelEditCode = null;
let stockLabelReturnFocus = null;
let contextLabelStockCode = null;
let forceDetailRefreshCode = null;
let onlineSearchResults = [];
let searchStatus = '';
let searchTimer = null;
let searchSeq = 0;
let logs = [];
let currentViewSource = 'empty';
let marketOverviewRefreshing = false;
let latestMarketRecommendations = [];
let latestMarketOverview = null;
let liveNewsItems = [];
let liveNewsMeta = null;
let liveNewsPage = 0;
let liveNewsRefreshing = false;
const detailProfileCache = new Map();
const detailNewsCache = new Map();
const detailHistoryCache = new Map();
const detailHistoryPending = new Map();
const detailFundFlowCache = new Map();
const detailChartCache = new Map();
const detailRequestPending = new Map();
const activeChartPeriod = new Map();
const STORAGE_KEY = 'ai-stock-assistant-state-v1';
const LIVE_NEWS_PAGE_SIZE = 8;

async function settleWithConcurrency(items, limit, task){
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({length:Math.min(limit, items.length)}, async () => {
    while(cursor < items.length){
      const index = cursor++;
      try{
        results[index] = {status:'fulfilled', value:await task(items[index], index)};
      }catch(reason){
        results[index] = {status:'rejected', reason};
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function withDetailPending(key, task){
  if(detailRequestPending.has(key)) return detailRequestPending.get(key);
  const pending = Promise.resolve().then(task).finally(() => detailRequestPending.delete(key));
  detailRequestPending.set(key, pending);
  return pending;
}

function escapeHtml(value){
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHttpUrl(value){
  try{
    const url = new URL(String(value || ''));
    return /^https?:$/.test(url.protocol) ? url.href : '';
  }catch{
    return '';
  }
}

function saveState(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify({labels, activeLabel, labelSorts, portfolio, simulatedTrades}));
    addLog('info', '已保存本地数据');
  }catch(err){
    addLog('error', `保存本地数据失败：${err.message || err}`);
  }
}

function favoriteOutcomeRows(){
  return labels.flatMap(label => (label.stocks || []).map(stock => ({
    code:stock.code,
    label:label.name,
    favoriteBasePrice:stock.favoriteBasePrice,
    favoriteAddedAt:stock.favoriteAddedAt,
    price:stock.price,
    signal:stock.marketSignal || stock.signal || stock.type || stock.status,
    signalScore:stock.signalScore,
    technicalScore:stock.technicalScore
  })));
}

function labelStockSnapshot(stock, existingStock=null){
  const {favoriteBasePrice: ignoredBase, favoriteAddedAt: ignoredTime, ...snapshot} = stock;
  const existingBase = Number(existingStock?.favoriteBasePrice);
  const currentPrice = Number(stock.price);
  return {
    ...snapshot,
    pinned:Boolean(existingStock?.pinned),
    favoriteBasePrice:Number.isFinite(existingBase) && existingBase > 0
      ? existingBase
      : Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : null,
    favoriteAddedAt:existingStock?.favoriteAddedAt || new Date().toISOString()
  };
}

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return false;
    const state = JSON.parse(raw);
    if(Array.isArray(state.labels)) labels = state.labels;
    if(state.labelSorts && typeof state.labelSorts === 'object') labelSorts = state.labelSorts;
    if(Array.isArray(state.portfolio)) portfolio = state.portfolio.filter(item => /^\d{6}$/.test(String(item.code || '')));
    if(Array.isArray(state.simulatedTrades)) simulatedTrades = state.simulatedTrades.slice(0, 500);
    activeLabel = state.activeLabel || labels[0]?.name || '';
    labels = labels.filter(label => label.name !== '本次生成股票池').map(label => ({
      ...label,
      stocks: (label.stocks || []).map(ls => ({
        ...labelStockSnapshot(ls, ls),
        name: cleanDisplayName(ls.name),
        type: ls.marketSignal || ls.type,
        status: ls.marketSignal ? (ls.newsLabel || ls.focus || '消息中性') : (ls.status === '已突破' ? '待分析' : ls.status),
        focus: ls.marketSignal && ls.newsLabel ? ls.newsLabel : ls.focus
      })).filter(ls => /^\d{6}$/.test(String(ls.code || '')) && ls.name)
    }));
    if(!labels.some(label => label.name === activeLabel)) activeLabel = labels[0]?.name || '';
    return true;
  }catch(err){
    addLog('error', `读取本地数据失败：${err.message || err}`);
    return false;
  }
}

function addLog(type, message, detail){
  const entry = {type, message, detail, time: nowText()};
  logs.unshift(entry);
  logs = logs.slice(0, 80);
  renderLogs();
  window.stockApi?.appendLog?.(entry).catch(() => {});
}

function renderLogs(){
  const box = $('logList');
  if(!box) return;
  box.innerHTML = logs.length ? logs.map(log => `<div class="log-row ${log.type}">
    <time>${escapeHtml(log.time)}</time><span>${escapeHtml(log.message)}</span>
  </div>`).join('') : '<div class="note">暂无操作记录</div>';
}

function notify(message, type='info'){
  const box = $('statusNotice');
  if(box){
    box.textContent = message;
    box.className = `status-notice ${type}`;
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => box.classList.add('hidden'), 5000);
  }
  addLog(type, message);
}

function marketRow(item, value, detail=''){
  return `<div class="market-row"><b>${escapeHtml(item.name || '--')}</b><span class="${pctClass(item.changePct)}">${escapeHtml(value)}${detail ? ` · ${escapeHtml(detail)}` : ''}</span></div>`;
}

function recommendationIndustry(item){
  const candidates = [item?.industry, item?.factorAnalysis?.sectorProfile?.name, item?.sector];
  return candidates.map(value => String(value || '').trim()).find(value => value && !['行业待确认','未分类','线上搜索','-','--'].includes(value)) || '行业待确认';
}

function recommendationFactorText(item){
  const factors = item?.factorAnalysis;
  if(!factors || !Number.isFinite(Number(factors.score))) return '多因子数据不足';
  return `多因子 ${Math.round(Number(factors.score))} · ${Number(factors.available) || 0}/${Number(factors.total) || 0}项`;
}

function recommendationCanslimText(item){
  const model = item?.canslim;
  if(!model || !Number.isFinite(Number(model.score))) return 'CANSLIM待补充';
  return `CANSLIM ${Math.round(Number(model.score))} · ${Number(model.available) || 0}/${Number(model.total) || 7}维`;
}

function recommendationCardHtml(item, selectable=false){
  const industry = recommendationIndustry(item);
  const sectorLabel = item.factorAnalysis?.sectorProfile?.label || '板块待确认';
  const changeClass = Number.isFinite(item.changePct) ? pctClass(item.changePct) : 'neutral';
  const content = `<span class="market-stock-content"><b class="market-stock-head"><span class="market-stock-name">${escapeHtml(item.name)}</span><span class="code">${escapeHtml(item.code)}</span><span class="market-signal ${badgeClass(item.signal)}">${escapeHtml(item.signal || '待突破')}</span><span class="market-signal ${badgeClass(item.newsLabel)}">${escapeHtml(item.newsLabel || '消息中性')}</span><span class="market-current-price">${yuan(item.price)}</span><span class="market-current-change ${changeClass}">${formatPct(item.changePct)}</span></b>
    <span>${escapeHtml(sectorLabel)} · ${escapeHtml(item.verdict || '等待确认')} · 推荐评分 ${escapeHtml(item.signalScore ?? item.score)} · ${escapeHtml(recommendationCanslimText(item))} · ${escapeHtml(recommendationFactorText(item))} · MA30 ${yuan(item.ma30)} · 突破价 ${yuan(item.breakoutPrice)}</span>
    <small>${escapeHtml(item.reason || '')}</small></span>`;
  if(selectable) return `<label class="market-recommendation market-stock-choice" data-market-industry="${escapeHtml(industry)}"><input type="checkbox" data-market-stock-choice="${escapeHtml(item.code)}" checked />${content}</label>`;
  return `<button class="market-recommendation" data-market-recommendation="${escapeHtml(item.code)}" data-market-industry="${escapeHtml(industry)}">${content}</button>`;
}

function groupedRecommendationHtml(items, selectable=false){
  const groups = new Map();
  (items || []).forEach(item => {
    const industry = recommendationIndustry(item);
    if(!groups.has(industry)) groups.set(industry, []);
    groups.get(industry).push(item);
  });
  return [...groups.entries()].map(([industry, group]) => {
    const profile = group.find(item => item.factorAnalysis?.sectorProfile)?.factorAnalysis?.sectorProfile;
    const meta = profile ? `${profile.label} · 板块评分 ${profile.score} · ${group.length}只` : `${group.length}只`;
    return `<section class="market-industry-group" data-market-industry-group="${escapeHtml(industry)}"><div class="market-industry-head"><b>${escapeHtml(industry)}</b><span>${escapeHtml(meta)}</span></div>${group.map(item => recommendationCardHtml(item, selectable)).join('')}</section>`;
  }).join('');
}

function renderMarketOverview(result){
  latestMarketOverview = result;
  $('marketAnalysis').textContent = result.analysis || '市场分析暂不可用。';
  $('marketUpdated').textContent = result.fetchedAt
    ? `${new Date(result.fetchedAt).toLocaleTimeString('zh-CN', {hour12:false})} · 自动刷新60秒`
    : '等待更新';
  $('marketIndices').innerHTML = (result.indices || []).map(index => `<div class="market-index">
    <div><b>${escapeHtml(index.name)}</b><span> ${escapeHtml(index.code)}</span></div>
    <div class="${pctClass(index.changePct)}"><b>${formatNumber(index.price)}</b><span> ${formatPct(index.changePct)}</span></div>
  </div>`).join('') || '<div class="market-row"><span>指数行情暂不可用</span></div>';
  $('marketUp').textContent = result.breadth?.up || '--';
  $('marketDown').textContent = result.breadth?.down || '--';
  $('marketFlat').textContent = result.breadth?.flat || '--';
  $('marketTurnover').textContent = money(result.turnover);
  const strong = (result.sectors || []).slice(0, 4).map(item => marketRow(item, formatPct(item.changePct), item.leader ? `领涨 ${item.leader}` : '')).join('');
  const weak = (result.weakSectors || []).slice(0, 2).map(item => marketRow(item, formatPct(item.changePct), '回落')).join('');
  $('marketSectors').innerHTML = strong + weak || '<div class="market-row"><span>板块轮动暂不可用</span></div>';
  $('marketFunds').innerHTML = (result.fundSectors || []).slice(0, 5).map(item => marketRow(item, money(item.amount ?? item.mainNet), item.leader ? `代表 ${item.leader}` : '')).join('') || '<div class="market-row"><span>板块成交资金暂不可用</span></div>';
  const activeStocks = (result.activeStocks || []).slice(0, 6).map(item => `${item.name} ${money(item.amount)}`).join('、');
  $('marketActiveStocks').innerHTML = activeStocks ? `<b>成交活跃个股：</b>${escapeHtml(activeStocks)}` : '';
  const limits = result.limits || {};
  const upStocks = (limits.upStocks || []).slice(0, 6).map(item => `${item.name}${item.industry ? `(${item.industry})` : ''}`).join('、');
  const downStocks = (limits.downStocks || []).slice(0, 4).map(item => item.name).join('、');
  $('marketLimits').innerHTML = `<div class="market-limit-summary"><span class="up">涨停 ${limits.upCount ?? '--'}</span><span class="down">跌停 ${limits.downCount ?? '--'}</span></div>
    ${upStocks ? `<div class="market-stocks"><b>涨停代表：</b>${escapeHtml(upStocks)}</div>` : ''}
    ${downStocks ? `<div class="market-stocks"><b>跌停代表：</b>${escapeHtml(downStocks)}</div>` : ''}`;
  const recommendations = result.recommendations || [];
  latestMarketRecommendations = recommendations;
  const coverage = result.recommendationCoverage || {};
  const fallbackNote = coverage.cachedFallback ? `；沿用${coverage.cachedAt ? new Date(coverage.cachedAt).toLocaleString('zh-CN', {hour12:false}) : '最近一次'}成功推荐` : '';
  const signals = recommendations.reduce((counts, item) => {
    if(item.signal === '底部待反弹') counts.bottomWaiting += 1;
    else if(item.signal === '已反弹') counts.rebounded += 1;
    else if(['底部吸筹','震荡洗盘'].includes(item.signal)) counts.structure += 1;
    else if(['待突破','横盘观察','突破蓄势','接近突破','突破确认'].includes(item.signal)) counts.breakout += 1;
    else counts.other += 1;
    return counts;
  }, {bottomWaiting:0, rebounded:0, breakout:0, structure:0, other:0});
  const riskCoverage = Number.isFinite(Number(coverage.riskChecked))
    ? `；未来半年风险核验 ${coverage.riskChecked} 只，排除 ${coverage.riskRejected || 0} 只，未确认 ${coverage.riskUnknown || 0} 只${coverage.riskUnverifiedIncluded ? `（降分保留 ${coverage.riskUnverifiedIncluded} 只）` : ''}`
    : '';
  const structureCounts = [];
  if(Number.isFinite(Number(coverage.accumulationCandidates))) structureCounts.push(`蓄势结构 ${coverage.accumulationCandidates} 只`);
  if(Number.isFinite(Number(coverage.consolidationCandidates))) structureCounts.push(`横盘候选 ${coverage.consolidationCandidates} 只`);
  if(Number.isFinite(Number(coverage.fundFlowAvailable))) structureCounts.push(`阶段资金可用 ${coverage.fundFlowAvailable} 只`);
  const accumulationCoverage = structureCounts.length ? `；${structureCounts.join('，')}` : '';
  const outcomeCoverage = coverage.outcomeFeedback?.sampleSize
    ? `；本地推荐复盘 ${coverage.outcomeFeedback.sampleSize} 条（最近${coverage.outcomeFeedback.recentCohortCount || '--'}个版本，实时行情重算，已排除重点关注/personal及不足1天样本）${coverage.outcomeFeedback.marketRisk?.status === 'drawdown' ? '，近期策略处于回撤并已收紧筛选' : ''}`
    : '';
  const unresolvedIndustryCoverage = Number(coverage.industryUnresolved) > 0 ? `，${coverage.industryUnresolved} 只行业待补充` : '';
  const signalSummary = [`待反弹 ${signals.bottomWaiting}`, `已反弹 ${signals.rebounded}`, `突破类 ${signals.breakout}`, `吸筹/洗盘 ${signals.structure}`];
  if(signals.other) signalSummary.push(`其他 ${signals.other}`);
  $('marketRecommendationCoverage').textContent = coverage.scanned
    ? `全市场扫描 ${coverage.scanned} 只，初筛 ${coverage.prefiltered || 0} 只，历史精筛 ${coverage.analyzed || 0} 只，覆盖 ${coverage.industries || 0} 个已确认行业${unresolvedIndustryCoverage}${accumulationCoverage}${riskCoverage}${outcomeCoverage}；实际推荐 ${recommendations.length} 只（${signalSummary.join('，')}）${fallbackNote}`
    : '等待全市场扫描';
  const visibleRecommendations = recommendations.slice(0, 10);
  $('marketRecommendations').innerHTML = visibleRecommendations.length ? groupedRecommendationHtml(visibleRecommendations) : '<div class="market-row"><span>当前未筛出满足条件的候选</span></div>';
  $('addMarketRecommendations').textContent = `查看更多（${recommendations.length}）`;
  const marketNews = result.newsContext?.items || [];
  $('marketNews').innerHTML = `<div class="market-stocks">${escapeHtml(result.newsContext?.summary || '消息面暂不可用')}</div>${marketNews.slice(0, 5).map(item => `<a class="market-news-row" href="#" data-market-news-link="${escapeHtml(safeHttpUrl(item.link))}">${escapeHtml(item.title)}<span>${escapeHtml(item.source || '')} · ${escapeHtml(item.publishedAt || '')}</span></a>`).join('')}`;
  document.querySelectorAll('[data-market-recommendation]').forEach(button => button.onclick = () => {
    const item = recommendations.find(candidate => candidate.code === button.dataset.marketRecommendation);
    if(!item) return;
    const stock = normalizedMarketRecommendation(item);
    stocks = [stock];
    currentViewSource = 'market';
    activeDetailCode = stock.code;
    forceDetailRefreshCode = stock.code;
    onlineSearchResults = [];
    renderStocks();
    $('detailPanel')?.scrollIntoView({behavior:'smooth', block:'start'});
  });
  document.querySelectorAll('[data-market-news-link]').forEach(link => link.onclick = (event) => {
    event.preventDefault();
    if(link.dataset.marketNewsLink) window.stockApi?.openExternal?.(link.dataset.marketNewsLink);
  });
  const errorBox = $('marketError');
  const errors = result.errors || [];
  const warnings = result.warnings || [];
  errorBox.classList.toggle('hidden', !errors.length && !warnings.length);
  errorBox.textContent = errors.length ? `部分数据异常：${errors.join('；')}` : warnings.length ? `数据提示：${warnings.join('；')}` : '';
  const detailStock = findStockByCode(activeDetailCode);
  const historyResult = detailHistoryCache.get(activeDetailCode);
  if(detailStock && historyResult) renderHistoryAnalysis(detailStock, historyResult);
}

async function loadMarketOverview(force=false, silent=false){
  if(marketOverviewRefreshing || !window.stockApi?.fetchMarketOverview) return latestMarketOverview;
  marketOverviewRefreshing = true;
  $('refreshMarketOverview').disabled = true;
  $('refreshMarketOverview').textContent = '刷新中';
  try{
    const result = await window.stockApi.fetchMarketOverview({force, favoriteOutcomes:favoriteOutcomeRows()});
    renderMarketOverview(result);
    if(force && !silent) {
      const errors = result.errors || [];
      const warnings = result.warnings || [];
      notify(errors.length ? '大盘核心数据部分更新失败，详情已标注' : warnings.length ? '大盘数据已更新，部分备用来源已切换' : '大盘数据已更新', errors.length ? 'warn' : warnings.length ? 'info' : 'success');
    }
    return result;
  }catch(err){
    $('marketError').classList.remove('hidden');
    $('marketError').textContent = `大盘数据更新失败：${err.message || err}`;
    $('marketUpdated').textContent = '更新失败，保留当前显示';
    if(force && !silent) notify(`大盘数据更新失败：${err.message || err}`, 'error');
    return null;
  }finally{
    marketOverviewRefreshing = false;
    $('refreshMarketOverview').disabled = false;
    $('refreshMarketOverview').textContent = '刷新';
  }
}

function describeClickTarget(target){
  const data = {...target.dataset};
  const text = (target.innerText || target.value || target.placeholder || target.id || target.className || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return {
    id: target.id || '',
    tag: target.tagName,
    className: String(target.className || '').slice(0, 80),
    text,
    data
  };
}

function badgeClass(v){
  if(['龙头','已突破','重点关注','消息确认'].includes(v)) return 'b-red';
  if(['趋势关注','突破后运行','已反弹'].includes(v)) return 'b-green';
  if(['待突破','等待确认','观察关注','中线关注','底部待反弹'].includes(v)) return 'b-amber';
  if(['待观察','待分析','待刷新','核心候选','产业链候选'].includes(v)) return 'b-blue';
  if(['待回调','高弹性关注','消息谨慎'].includes(v)) return 'b-purple';
  return 'b-gray';
}

function stockTagValues(stock){
  const values = stock.marketSignal
    ? [stock.marketSignal, stock.newsLabel || stock.focus]
    : [stock.type, stock.status, stock.focus];
  return [...new Set(values.filter(Boolean))];
}

function stockTagsHtml(stock, className='badge'){
  return stockTagValues(stock).map(value => `<span class="${className} ${badgeClass(value)}">${escapeHtml(value)}</span>`).join('');
}

function closeMarketLabelPanel(){
  $('marketLabelPanel')?.classList.add('hidden');
}

function updateMarketStockToggleText(){
  const choices = [...document.querySelectorAll('[data-market-stock-choice]')];
  const allSelected = choices.length > 0 && choices.every(choice => choice.checked);
  $('toggleMarketStocks').textContent = allSelected ? '取消全选' : '全选';
}

function normalizedMarketRecommendation(item){
  const hasSignalScore = item.signalScore !== null && item.signalScore !== '' && Number.isFinite(Number(item.signalScore));
  const recommendationScore = hasSignalScore ? Number(item.signalScore) : Number(item.score);
  return {
    ...defaultStockFromSearch(item),
    ...item,
    technicalScore: Number.isFinite(Number(item.technicalScore)) ? Number(item.technicalScore) : Number(item.score),
    score: Number.isFinite(recommendationScore) ? recommendationScore : item.score,
    type:item.signal || '市场推荐', status:item.newsLabel || '消息中性', focus:item.newsLabel || '消息中性',
    marketSignal:item.signal, reason:item.reason, news:item.newsContext?.summary || ''
  };
}

function openMarketLabelPanel(){
  if(!latestMarketRecommendations.length){ notify('当前没有可添加的推荐股', 'warn'); return; }
  $('marketLabelPanel').classList.remove('hidden');
  $('newMarketLabelName').value = '';
  $('marketRecommendationListTitle').innerHTML = `推荐股票 <em>${latestMarketRecommendations.length} 只</em>`;
  $('marketStockChoices').innerHTML = groupedRecommendationHtml(latestMarketRecommendations, true);
  $('marketLabelChoices').innerHTML = labels.length ? labels.map(label => `<label class="label-choice">
    <input type="checkbox" data-market-target-label="${escapeHtml(label.name)}" />
    <span>${escapeHtml(label.name)}<small class="market-label-count">${label.stocks.length}只</small></span>
  </label>`).join('') : '<div class="note">暂无标签，请在下方创建新标签。</div>';
  document.querySelectorAll('[data-market-stock-choice]').forEach(choice => choice.onchange = updateMarketStockToggleText);
  updateMarketStockToggleText();
  setTimeout(() => document.querySelector('[data-market-stock-choice]')?.focus({preventScroll:true}), 0);
}

function saveMarketRecommendations(){
  const selectedCodes = new Set([...document.querySelectorAll('[data-market-stock-choice]:checked')].map(item => item.dataset.marketStockChoice));
  const targetLabels = new Set([...document.querySelectorAll('[data-market-target-label]:checked')].map(item => item.dataset.marketTargetLabel));
  const newName = $('newMarketLabelName').value.trim();
  if(newName) targetLabels.add(newName);
  if(!selectedCodes.size){ notify('请至少选择一只推荐股', 'warn'); return; }
  if(!targetLabels.size){ notify('请选择标签或输入新标签名称', 'warn'); return; }
  targetLabels.forEach(name => {
    if(!labels.some(label => label.name === name)) labels.push({name, stocks:[]});
  });
  const selectedStocks = latestMarketRecommendations.filter(item => selectedCodes.has(item.code)).map(normalizedMarketRecommendation);
  labels = labels.map(label => {
    if(!targetLabels.has(label.name)) return label;
    const byCode = new Map(label.stocks.map(stock => [stock.code, stock]));
    selectedStocks.forEach(stock => byCode.set(stock.code, labelStockSnapshot(stock, byCode.get(stock.code))));
    return {...label, stocks:[...byCode.values()]};
  });
  activeLabel ||= [...targetLabels][0];
  saveState();
  renderLabels();
  closeMarketLabelPanel();
  notify(`已将 ${selectedStocks.length} 只推荐股添加到 ${targetLabels.size} 个标签`, 'success');
}
function pctClass(v){ return Number(v) >= 0 ? 'up' : 'down'; }
function checked(code){ return selected.has(code) ? 'checked' : ''; }
function formatNumber(v, digits=2){ return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '--'; }
function formatPct(v){ return typeof v === 'number' ? `${v > 0 ? '+' : ''}${v.toFixed(2)}%` : '--'; }
function yuan(v){ return typeof v === 'number' ? `¥${v.toFixed(2)}` : '--'; }
function money(v){
  if(typeof v !== 'number' || !Number.isFinite(v)) return '--';
  const abs = Math.abs(v);
  if(abs >= 1e8) return `${(v/1e8).toFixed(2)}亿`;
  if(abs >= 1e4) return `${(v/1e4).toFixed(2)}万`;
  return v.toFixed(0);
}
function metricValue(v, formatter = (x) => x){
  return typeof v === 'number' && Number.isFinite(v) ? formatter(v) : '接口未提供';
}
function marketCapValue(v){ return metricValue(v, money); }
function volume(v){
  if(typeof v !== 'number' || !Number.isFinite(v)) return '--';
  return `${(v/10000).toFixed(2)}万手`;
}

function portfolioPosition(code){
  return portfolio.find(item => item.code === code);
}

function portfolioStock(position){
  if(!position) return null;
  const known = stocks.find(stock => stock.code === position.code)
    || labels.flatMap(label => label.stocks || []).find(stock => stock.code === position.code)
    || position.stock || {};
  return {
    ...known,
    code: position.code,
    name: position.name || known.name || position.code,
    sector: position.sector || known.sector || '模拟持仓',
    type: known.type || '模拟持仓',
    status: known.status || '待分析',
    focus: known.focus || '持仓跟踪',
    price: Number(position.lastPrice) || Number(known.price) || Number(position.costPrice) || null,
    changePct: position.changePct ?? known.changePct,
    source: position.source || known.source
  };
}

function portfolioMetrics(position){
  const quantity = Math.max(0, Number(position?.quantity) || 0);
  const costPrice = Math.max(0, Number(position?.costPrice) || 0);
  const currentPrice = Math.max(0, Number(position?.lastPrice) || costPrice);
  const realizedPnl = Number(position?.realizedPnl) || 0;
  const costValue = quantity * costPrice;
  const marketValue = quantity * currentPrice;
  const floatingPnl = marketValue - costValue;
  return {
    quantity, costPrice, currentPrice, realizedPnl, costValue, marketValue, floatingPnl,
    floatingPct: costValue ? floatingPnl / costValue * 100 : 0,
    totalPnl: floatingPnl + realizedPnl
  };
}

function simulatedTradePanel(s){
  const position = portfolioPosition(s.code);
  const metrics = portfolioMetrics(position);
  const trades = simulatedTrades.filter(trade => trade.code === s.code).slice(0, 5);
  const tradeRows = trades.length ? trades.map(trade => `<tr><td>${escapeHtml(trade.time)}</td><td class="${trade.side === '买入' ? 'up' : 'down'}">${trade.side}</td><td>${trade.quantity}股</td><td>${yuan(trade.price)}</td><td>${money(trade.amount)}</td><td class="${pctClass(trade.realizedPnl)}">${trade.side === '卖出' ? money(trade.realizedPnl) : '--'}</td></tr>`).join('') : '<tr><td colspan="6">暂无模拟成交</td></tr>';
  return `<section class="simulation-trade">
    <div class="simulation-title"><div><h3>模拟交易</h3><small>按100股整数手直接模拟成交，不含手续费</small></div><span class="simulation-holding">持仓 ${metrics.quantity} 股</span></div>
    <div class="simulation-position-grid">
      <div><span>成本价</span><b>${yuan(metrics.costPrice || null)}</b></div><div><span>当前市值</span><b>${money(metrics.marketValue)}</b></div>
      <div><span>持仓盈亏</span><b class="${pctClass(metrics.floatingPnl)}">${money(metrics.floatingPnl)} / ${formatPct(metrics.floatingPct)}</b></div>
      <div><span>已实现收益</span><b class="${pctClass(metrics.realizedPnl)}">${money(metrics.realizedPnl)}</b></div>
    </div>
    <div class="simulation-order">
      <label>成交价格<input data-sim-price="${s.code}" type="number" min="0.01" step="0.01" value="${Number(s.price || metrics.currentPrice || 0).toFixed(2)}" /></label>
      <label>买入金额<input data-sim-amount="${s.code}" type="number" min="0" step="100" value="10000" /></label>
      <label>卖出数量<input data-sim-sell-quantity="${s.code}" type="number" min="0" step="100" value="${metrics.quantity}" /></label>
      <button class="sim-buy" data-sim-trade="buy" data-sim-code="${s.code}">模拟买入</button>
      <button class="sim-sell" data-sim-trade="sell" data-sim-code="${s.code}" ${metrics.quantity ? '' : 'disabled'}>模拟卖出</button>
    </div>
    <div class="simulation-quick-sell"><span>快速卖出</span>${[['1/4',.25],['1/3',1/3],['1/2',.5],['全部',1]].map(([label, ratio]) => `<button class="small" data-sim-sell-ratio="${ratio}" data-sim-code="${s.code}" ${metrics.quantity ? '' : 'disabled'}>${label}</button>`).join('')}</div>
    <div class="simulation-history table-wrap"><table><thead><tr><th>时间</th><th>方向</th><th>数量</th><th>价格</th><th>金额</th><th>实现收益</th></tr></thead><tbody>${tradeRows}</tbody></table></div>
  </section>`;
}

function executeSimulatedTrade(code, side, options={}){
  const stock = findStockByCode(code);
  const price = Number(options.price ?? document.querySelector(`[data-sim-price="${code}"]`)?.value ?? stock?.price);
  const requestedAmount = Number(options.amount ?? document.querySelector(`[data-sim-amount="${code}"]`)?.value);
  const requestedQuantity = Number(options.quantity ?? document.querySelector(`[data-sim-sell-quantity="${code}"]`)?.value);
  if(!stock || !Number.isFinite(price) || price <= 0){
    if(!options.quiet) notify('模拟交易失败：请输入有效成交价格', 'error');
    return false;
  }
  let position = portfolioPosition(code);
  let quantity = 0;
  if(side === 'sell'){
    const held = Math.max(0, Number(position?.quantity) || 0);
    if(!held){ if(!options.quiet) notify('模拟卖出失败：当前没有持仓', 'error'); return false; }
    if(!Number.isFinite(requestedQuantity) || requestedQuantity <= 0){ if(!options.quiet) notify('模拟卖出失败：请输入有效卖出数量', 'error'); return false; }
    quantity = requestedQuantity >= held ? held : Math.min(Math.floor(requestedQuantity / 100) * 100, held);
  }else{
    if(!Number.isFinite(requestedAmount) || requestedAmount <= 0){ if(!options.quiet) notify('模拟买入失败：请输入有效买入金额', 'error'); return false; }
    quantity = Math.floor(requestedAmount / price / 100) * 100;
  }
  if(quantity < 100){ if(!options.quiet) notify('模拟交易失败：数量不足100股', 'error'); return false; }

  if(!position){
    position = {code, name:stock.name, sector:stock.sector, quantity:0, costPrice:0, realizedPnl:0, lastPrice:Number(stock.price) || price, changePct:stock.changePct, source:stock.source, stock:{...stock}};
    portfolio.push(position);
  }
  const amount = quantity * price;
  let realizedPnl = 0;
  if(side === 'buy'){
    const oldCost = position.quantity * position.costPrice;
    position.quantity += quantity;
    position.costPrice = (oldCost + amount) / position.quantity;
  }else{
    realizedPnl = (price - position.costPrice) * quantity;
    position.quantity -= quantity;
    position.realizedPnl = (Number(position.realizedPnl) || 0) + realizedPnl;
    if(!position.quantity) position.costPrice = 0;
  }
  position.name = stock.name;
  position.sector = stock.sector;
  position.lastPrice = Number(stock.price) || position.lastPrice || price;
  position.changePct = stock.changePct;
  position.source = stock.source;
  position.stock = {...position.stock, ...stock};
  position.updatedAt = new Date().toISOString();
  simulatedTrades.unshift({id:`${Date.now()}-${code}`, time:nowText(), side:side === 'buy' ? '买入' : '卖出', code, name:stock.name, price, quantity, amount, realizedPnl});
  simulatedTrades = simulatedTrades.slice(0, 500);
  saveState();
  addLog('action', `模拟${side === 'buy' ? '买入' : '卖出'}成交`, {code, name:stock.name, price, quantity, amount, realizedPnl});
  if(!options.quiet) notify(`模拟${side === 'buy' ? '买入' : '卖出'}成功：${stock.name} ${quantity}股，成交金额${money(amount)}`, 'success');
  if(options.render !== false) renderStocks();
  return true;
}
function updateStatusByQuote(s){
  if(s.marketSignal) return s.newsLabel || s.focus || '消息中性';
  const historyResult = detailHistoryCache.get(s.code);
  const analysis = historyResult?.analysis;
  if(!analysis) return s.status === '已突破' ? '待分析' : (s.status || '待分析');
  const price = Number(s.price ?? historyResult?.history?.at(-1)?.close);
  const breakout = Number(analysis.breakoutPrice);
  const score = Number(analysis.score);
  if(!Number.isFinite(price) || !Number.isFinite(breakout) || !Number.isFinite(score)) return '待分析';

  const trendUp = price >= Number(analysis.ma20) && Number(analysis.ma5) >= Number(analysis.ma10);
  const breakoutDistance = (price / breakout - 1) * 100;
  const volumeRatio = Number(analysis.volumeRatio);
  if(volumeRatio > 4) return '爆量观察';
  const confirmed = breakoutDistance >= .3 && breakoutDistance <= 12
    && score >= 65 && trendUp && Number(analysis.return5) >= -1 && volumeRatio >= 1.5 && volumeRatio <= 4;
  if(confirmed) return '已突破';
  if(score < 45 || price < Number(analysis.ma30) && Number(analysis.ma5) < Number(analysis.ma10)) return '趋势偏弱';
  if(breakoutDistance > 12 && score >= 60 && trendUp) return '突破后运行';
  if(breakoutDistance >= -5 && breakoutDistance < .3 && score >= 55 && price >= Number(analysis.ma20)) return '待突破';
  if(Number(analysis.return5) <= -4 || price < Number(analysis.ma20)) return '调整中';
  return '等待确认';
}

function applyAnalysisClassification(code){
  const historyResult = detailHistoryCache.get(code);
  const analysis = historyResult?.analysis;
  if(!analysis) return;
  const update = stock => stock.code === code ? {
    ...stock,
    technicalScore: analysis.score,
    score: Number.isFinite(Number(stock.signalScore)) ? Number(stock.signalScore) : analysis.score,
    canslim: historyResult?.investmentAnalysis?.canslim || stock.canslim,
    status: updateStatusByQuote(stock),
    focus: stock.marketSignal && stock.newsLabel ? stock.newsLabel : analysis.score >= 72 ? '重点关注' : analysis.score >= 55 ? '趋势关注' : '观察关注'
  } : stock;
  stocks = stocks.map(update);
  labels = labels.map(label => ({...label, stocks:label.stocks.map(update)}));

  if(currentViewSource !== 'generated') return;
  const leaders = new Set();
  Object.values(stocks.reduce((groups, stock) => {
    (groups[stock.sector] ||= []).push(stock);
    return groups;
  }, {})).forEach(group => {
    if(group.length < 3) return;
    const ranked = [...group].filter(stock => Number(stock.totalMarketCap || stock.amount) > 0)
      .sort((a, b) => Number(b.totalMarketCap || b.amount) - Number(a.totalMarketCap || a.amount));
    if(ranked[0]) leaders.add(ranked[0].code);
  });
  stocks = stocks.map(stock => ({
    ...stock,
    type: leaders.has(stock.code) ? '龙头' : Number(stock.relevanceScore) >= 100 ? '核心候选' : '产业链候选'
  }));
  const byCode = new Map(stocks.map(stock => [stock.code, stock]));
  labels = labels.map(label => ({...label, stocks:label.stocks.map(stock => byCode.has(stock.code) ? {...stock, type:byCode.get(stock.code).type} : stock)}));
}

function filteredStocks(){
  const q = $('searchInput').value.trim();
  if(!q) return stocks;
  return stocks.filter(s => [s.name,s.code,s.sector,s.type,s.status,s.focus].some(x => String(x).includes(q)));
}

function defaultStockFromSearch(item){
  const relation = String(item.relationEvidence || item.relation || '').trim();
  return {
    ...item,
    sector: item.sector || '线上搜索',
    name: cleanDisplayName(item.name),
    code: item.code,
    type: relation ? '产业链候选' : '待观察',
    status: '待刷新',
    focus: relation ? '关系待核验' : '搜索添加',
    price: null,
    changePct: null,
    reason: relation
      ? `${relation}。需结合公司公告核验具体项目关系。`
      : '通过线上股票搜索添加，需结合基本面和行情进一步确认。',
    news: '等待刷新实际行情。'
  };
}

function cleanDisplayName(name){
  return String(name || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9*ＳＴST.-]/g, '').trim();
}

function labelNamesForStock(code){
  return labels.filter(l => l.stocks.some(s => s.code === code)).map(l => l.name);
}

function stockLabelHtml(s){
  const names = labelNamesForStock(s.code);
  const buttonText = names.length ? '编辑标签' : '添加到标签';
  const labelHtml = names.length ? names.map(name => `<span class="label-pill">${escapeHtml(name)}</span>`).join('') : '<span>未加入标签</span>';
  return `<div class="stock-labels">${labelHtml}<button class="small" data-edit-stock-labels="${s.code}">${buttonText}</button></div>`;
}

function stockAnalysisScore(s){
  if(s.signalScore !== null && s.signalScore !== '' && Number.isFinite(Number(s.signalScore))) return Number(s.signalScore);
  return Number.isFinite(Number(s.score)) ? Number(s.score) : (detailHistoryCache.get(s.code)?.analysis?.score ?? null);
}

function stockCanslimScore(s){
  const saved = s?.canslim?.score;
  if(saved !== null && saved !== '' && Number.isFinite(Number(saved))) return Math.round(Number(saved));
  const analyzed = detailHistoryCache.get(s.code)?.investmentAnalysis?.canslim?.score;
  return analyzed !== null && analyzed !== '' && Number.isFinite(Number(analyzed)) ? Math.round(Number(analyzed)) : null;
}

function scoreBadge(s){
  const score = stockAnalysisScore(s);
  return `${s.pinned ? '<span class="badge pinned-badge">置顶</span>' : ''}<span class="badge score-badge">评分 ${score == null ? '待分析' : escapeHtml(score)}</span>`;
}

function favoriteChangePct(s){
  const base = Number(s.favoriteBasePrice);
  const price = Number(s.price);
  return Number.isFinite(base) && base > 0 && Number.isFinite(price) && price > 0 ? (price / base - 1) * 100 : null;
}

function stockCard(s, compact=false, showCheck=true){
  const checkHtml = showCheck ? `<input class="check stock-check" data-code="${s.code}" type="checkbox" ${checked(s.code)} />` : '';
  const labelHtml = compact ? '' : stockLabelHtml(s);
  if(compact){
    const score = stockAnalysisScore(s);
    const canslimScore = stockCanslimScore(s);
    const cumulativeChange = favoriteChangePct(s);
    return `<article class="stock-card compact-card label-stock-card ${s.pinned ? 'pinned-stock-card' : ''}" data-detail-code="${s.code}">
      <div class="stock-top">
        <div class="compact-stock-main">
          <div class="stock-title">${checkHtml}<h3>${escapeHtml(s.name)}</h3><span class="code">${s.code}</span></div>
        </div>
        <div class="price">${yuan(s.price)}</div>
      </div>
      <div class="compact-returns"><span class="compact-rating-group"><span class="compact-rating">评分 ${score == null ? '--' : escapeHtml(score)}</span><span class="compact-rating">CAN ${canslimScore == null ? '--' : escapeHtml(canslimScore)}</span></span><span class="compact-change-group"><span class="${cumulativeChange == null ? 'neutral' : pctClass(cumulativeChange)}" title="从加入当前标签时开始计算">累 ${formatPct(cumulativeChange)}</span><span class="${pctClass(s.changePct)}">今 ${formatPct(s.changePct)}</span></span></div>
      <div class="compact-score">${s.pinned ? '<span class="compact-pinned">置顶</span>' : ''}${stockTagsHtml(s, 'compact-state')}</div>
    </article>`;
  }
  return `<article class="stock-card ${compact ? 'compact-card label-stock-card' : ''}" data-detail-code="${s.code}">
    <div class="stock-top">
      <div>
        <div class="stock-title">
          ${checkHtml}
          <h3>${escapeHtml(s.name)}</h3><span class="code">${s.code}</span>
        </div>
        <div class="sector-line">${escapeHtml(s.sector)}</div>
      </div>
      <div class="price">${yuan(s.price)}<div class="pct ${pctClass(s.changePct)}">${formatPct(s.changePct)}</div></div>
    </div>
    <div class="badges">${stockTagsHtml(s)}${scoreBadge(s)}</div>
    <p><b>原因：</b>${escapeHtml(s.reason)}</p><p><b>最新情况：</b>${escapeHtml(s.news || '--')}</p>
    ${labelHtml}
  </article>`;
}

function tableRow(s){
  const names = labelNamesForStock(s.code);
  const labelText = names.length ? names.map(escapeHtml).join('、') : '未加入标签';
  const buttonText = names.length ? '编辑' : '添加';
  const score = stockAnalysisScore(s);
  return `<tr data-detail-code="${s.code}"><td><input class="stock-check" data-code="${s.code}" type="checkbox" ${checked(s.code)} /></td><td><b>${escapeHtml(s.name)}</b></td><td>${s.code}</td><td>${escapeHtml(s.type)}</td><td>${escapeHtml(s.status)}</td><td>${score ?? '待分析'}</td><td>${yuan(s.price)}</td><td class="${pctClass(s.changePct)}"><b>${formatPct(s.changePct)}</b></td><td>${labelText}<br><button class="small" data-edit-stock-labels="${s.code}">${buttonText}</button></td><td class="reason">${escapeHtml(s.reason)}</td></tr>`;
}

function renderLiveNewsView(){
  const totalPages = Math.max(1, Math.ceil(liveNewsItems.length / LIVE_NEWS_PAGE_SIZE));
  liveNewsPage = Math.max(0, Math.min(liveNewsPage, totalPages - 1));
  const start = liveNewsPage * LIVE_NEWS_PAGE_SIZE;
  const rows = liveNewsItems.slice(start, start + LIVE_NEWS_PAGE_SIZE).map((item, index) => {
    const absoluteIndex = start + index;
    return `<button class="live-news-row" data-live-news-index="${absoluteIndex}">
      <span class="live-news-title">${escapeHtml(item.title || item.summary || '--')}</span>
      <span class="live-news-row-meta"><b>${escapeHtml(item.source || '--')}</b><small>${escapeHtml(item.publishedAt || '--')}</small></span>
    </button>`;
  }).join('');
  const fetchedAt = liveNewsMeta?.fetchedAt ? new Date(liveNewsMeta.fetchedAt).toLocaleString('zh-CN', {hour12:false}) : '--';
  const status = liveNewsRefreshing ? '刷新中' : liveNewsMeta?.stale ? '缓存' : liveNewsItems.length ? '实时' : '待刷新';
  return `<section class="portfolio-view live-news-view">
    <div class="portfolio-head"><div><h2>24小时实时新闻</h2><p>展示金十、财经滚动等公开来源的最新市场消息</p></div><div class="portfolio-head-actions"><button class="small" data-live-news-refresh>${liveNewsRefreshing ? '刷新中' : '刷新'}</button><span>${liveNewsItems.length} 条</span></div></div>
    <div class="portfolio-summary live-news-summary">
      <div><span>新闻数量</span><b>${liveNewsItems.length}</b></div><div><span>当前页</span><b>${liveNewsPage + 1}/${totalPages}</b></div>
      <div><span>状态</span><b>${escapeHtml(status)}</b></div><div><span>更新时间</span><b>${escapeHtml(fetchedAt)}</b></div>
    </div>
    <div class="portfolio-batch-toolbar live-news-toolbar"><button class="small" data-live-news-page="prev" ${liveNewsPage <= 0 ? 'disabled' : ''}>上一页</button><button class="small" data-live-news-page="next" ${liveNewsPage >= totalPages - 1 ? 'disabled' : ''}>下一页</button><span>${escapeHtml(liveNewsMeta?.source || '等待获取来源')}</span></div>
    ${rows ? `<div class="live-news-list">${rows}</div>` : `<div class="portfolio-empty">${liveNewsRefreshing ? '正在获取实时新闻...' : '暂无实时新闻，点击刷新重试。'}</div>`}
    ${liveNewsMeta?.errors?.length ? `<div class="note inline-note">部分来源异常：${escapeHtml(liveNewsMeta.errors.join('；'))}</div>` : ''}
  </section>`;
}

function bindLiveNewsInteractions(root){
  root.querySelector('[data-live-news-refresh]')?.addEventListener('click', () => refreshLiveNews(true));
  root.querySelectorAll('[data-live-news-page]').forEach(button => {
    button.onclick = () => {
      liveNewsPage += button.dataset.liveNewsPage === 'next' ? 1 : -1;
      renderStocks();
    };
  });
  root.querySelectorAll('[data-live-news-index]').forEach(row => {
    row.onclick = () => openLiveNewsModal(Number(row.dataset.liveNewsIndex));
  });
}

function openLiveNewsModal(index){
  const item = liveNewsItems[index];
  if(!item) return;
  $('liveNewsModalTitle').textContent = item.title || '实时新闻详情';
  $('liveNewsModalMeta').textContent = [item.source, item.publishedAt].filter(Boolean).join(' · ');
  $('liveNewsModalContent').textContent = item.summary || item.title || '暂无完整内容';
  const link = safeHttpUrl(item.link);
  const openButton = $('openLiveNewsOriginal');
  openButton.classList.toggle('hidden', !link);
  openButton.dataset.liveNewsLink = link;
  $('liveNewsModal').classList.remove('hidden');
}

function closeLiveNewsModal(){
  $('liveNewsModal')?.classList.add('hidden');
}

async function refreshLiveNews(force=true){
  if(liveNewsRefreshing || !window.stockApi?.fetchLiveNews) return;
  liveNewsRefreshing = true;
  renderStocks();
  try{
    const result = await window.stockApi.fetchLiveNews({force, limit:24});
    liveNewsItems = result.news || [];
    liveNewsMeta = result;
    liveNewsPage = 0;
    notify(result.errors?.length ? `实时新闻已更新 ${liveNewsItems.length} 条，部分来源异常` : `实时新闻已更新 ${liveNewsItems.length} 条`, result.errors?.length ? 'warn' : 'success');
  }catch(err){
    liveNewsMeta = {news:liveNewsItems, errors:[err.message || String(err)], fetchedAt:new Date().toISOString(), source:liveNewsMeta?.source || '', stale:true};
    notify(`实时新闻刷新失败：${err.message || err}`, 'error');
  }finally{
    liveNewsRefreshing = false;
    renderStocks();
  }
}

async function openLiveNewsView(){
  currentViewSource = 'liveNews';
  activeDetailCode = null;
  stocks = [];
  selected.clear();
  onlineSearchResults = [];
  searchStatus = '';
  $('searchInput').value = '';
  $('addPanel')?.classList.add('hidden');
  closeStockLabelPanel();
  renderStocks();
  await refreshLiveNews(true);
}

function renderPortfolioView(){
  const holdings = portfolio.filter(position => Number(position.quantity) > 0);
  const holdingMetrics = holdings.map(position => ({position, stock:portfolioStock(position), metrics:portfolioMetrics(position)}));
  const costValue = holdingMetrics.reduce((sum, item) => sum + item.metrics.costValue, 0);
  const marketValue = holdingMetrics.reduce((sum, item) => sum + item.metrics.marketValue, 0);
  const floatingPnl = holdingMetrics.reduce((sum, item) => sum + item.metrics.floatingPnl, 0);
  const realizedPnl = portfolio.reduce((sum, position) => sum + (Number(position.realizedPnl) || 0), 0);
  const totalPnl = floatingPnl + realizedPnl;
  const allSelected = holdings.length > 0 && holdings.every(position => selected.has(position.code));
  const rows = holdingMetrics.map(({stock, metrics}) => `<tr data-detail-code="${stock.code}" data-portfolio-code="${stock.code}">
    <td><input type="checkbox" data-portfolio-choice="${stock.code}" ${selected.has(stock.code) ? 'checked' : ''} /></td><td><b>${escapeHtml(stock.name)}</b><small>${stock.code}</small></td>
    <td>${metrics.quantity}股</td><td>${yuan(metrics.currentPrice)} / ${yuan(metrics.costPrice)}</td>
    <td>${money(metrics.marketValue)}</td><td class="${pctClass(metrics.floatingPnl)}"><b>${money(metrics.floatingPnl)}</b><small>${formatPct(metrics.floatingPct)}</small></td>
    <td class="${pctClass(metrics.realizedPnl)}">${money(metrics.realizedPnl)}</td><td class="${pctClass(metrics.totalPnl)}"><b>${money(metrics.totalPnl)}</b></td>
  </tr>`).join('');
  const trades = simulatedTrades.slice(0, 20).map(trade => `<tr><td>${escapeHtml(trade.time)}</td><td>${escapeHtml(trade.name)}<small>${trade.code}</small></td><td class="${trade.side === '买入' ? 'up' : 'down'}">${trade.side}</td><td>${trade.quantity}股</td><td>${yuan(trade.price)}</td><td>${money(trade.amount)}</td><td class="${pctClass(trade.realizedPnl)}">${trade.side === '卖出' ? money(trade.realizedPnl) : '--'}</td></tr>`).join('');
  return `<section class="portfolio-view">
    <div class="portfolio-head"><div><h2>模拟持仓</h2><p>行情刷新后，持仓市值和浮动盈亏会按最新价格更新</p></div><div class="portfolio-head-actions"><button class="small" data-portfolio-refresh>刷新</button><span>${holdings.length} 只持仓</span></div></div>
    <div class="portfolio-summary">
      <div><span>持仓成本</span><b>${money(costValue)}</b></div><div><span>当前市值</span><b>${money(marketValue)}</b></div>
      <div><span>持仓盈亏</span><b class="${pctClass(floatingPnl)}">${money(floatingPnl)}</b></div><div><span>已实现收益</span><b class="${pctClass(realizedPnl)}">${money(realizedPnl)}</b></div>
      <div><span>累计收益</span><b class="${pctClass(totalPnl)}">${money(totalPnl)}</b></div>
    </div>
    ${rows ? `<div class="portfolio-batch-toolbar"><button class="small" data-portfolio-toggle>${allSelected ? '取消全选' : '全选'}</button><span>已选 ${holdings.filter(position => selected.has(position.code)).length} 只</span><label>每只买入金额<input data-portfolio-buy-amount type="number" min="100" step="100" value="10000" /></label><button class="sim-buy" data-portfolio-batch="buy">批量买入</button><label>卖出比例<select data-portfolio-sell-ratio><option value="0.25">1/4</option><option value="0.3333333333">1/3</option><option value="0.5">1/2</option><option value="1" selected>全部</option></select></label><button class="sim-sell" data-portfolio-batch="sell">批量卖出</button></div><div class="table-wrap"><table class="portfolio-table"><thead><tr><th>选</th><th>股票</th><th>持仓数量</th><th>现价 / 成本</th><th>市值</th><th>持仓盈亏</th><th>已实现</th><th>累计收益</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="portfolio-empty">暂无模拟持仓，可在个股详情中设置价格和金额后模拟买入。</div>'}
    <div class="portfolio-trades"><h3>最近模拟成交</h3>${trades ? `<div class="table-wrap"><table><thead><tr><th>时间</th><th>股票</th><th>方向</th><th>数量</th><th>价格</th><th>金额</th><th>实现收益</th></tr></thead><tbody>${trades}</tbody></table></div>` : '<div class="portfolio-empty">暂无模拟成交记录</div>'}</div>
  </section>`;
}

function bindPortfolioInteractions(root){
  root.querySelectorAll('[data-portfolio-choice]').forEach(choice => {
    choice.onclick = event => event.stopPropagation();
    choice.onchange = () => {
      choice.checked ? selected.add(choice.dataset.portfolioChoice) : selected.delete(choice.dataset.portfolioChoice);
      renderStocks();
    };
  });
  root.querySelector('[data-portfolio-toggle]')?.addEventListener('click', () => {
    const holdings = portfolio.filter(position => Number(position.quantity) > 0);
    const allSelected = holdings.length > 0 && holdings.every(position => selected.has(position.code));
    holdings.forEach(position => allSelected ? selected.delete(position.code) : selected.add(position.code));
    renderStocks();
  });
  root.querySelector('[data-portfolio-refresh]')?.addEventListener('click', refreshPortfolioHoldings);
  root.querySelectorAll('[data-portfolio-batch]').forEach(button => button.onclick = () => executePortfolioBatch(button.dataset.portfolioBatch));
}

function executePortfolioBatch(side){
  const targets = portfolio.filter(position => Number(position.quantity) > 0 && selected.has(position.code));
  if(!targets.length){ notify(`请先选择需要批量${side === 'buy' ? '买入' : '卖出'}的持仓`, 'warn'); return; }
  const amount = Number(document.querySelector('[data-portfolio-buy-amount]')?.value);
  const ratio = Number(document.querySelector('[data-portfolio-sell-ratio]')?.value || 1);
  let completed = 0;
  targets.forEach(position => {
    const stock = portfolioStock(position);
    const price = Number(stock?.price || position.lastPrice || position.costPrice);
    const quantity = ratio >= 1 ? Number(position.quantity) : Math.floor(Number(position.quantity) * ratio / 100) * 100;
    if(executeSimulatedTrade(position.code, side, {price, amount, quantity, quiet:true, render:false})) completed += 1;
  });
  selected = new Set([...selected].filter(code => Number(portfolioPosition(code)?.quantity) > 0));
  notify(`批量${side === 'buy' ? '买入' : '卖出'}完成：${completed}/${targets.length} 只`, completed ? 'success' : 'warn');
  renderStocks();
}

async function refreshPortfolioHoldings(){
  const codes = portfolio.filter(position => Number(position.quantity) > 0).map(position => position.code);
  const button = document.querySelector('[data-portfolio-refresh]');
  if(!codes.length || !window.stockApi?.fetchQuotes) return;
  if(button){ button.disabled = true; button.textContent = '刷新中'; }
  try{
    const result = parseQuoteResponse(await window.stockApi.fetchQuotes(codes));
    recordQuoteMessages(result);
    if(result.quotes.length){ applyQuoteData(result.quotes); saveState(); notify(`持仓行情已刷新 ${result.quotes.length} 只`, 'success'); }
    else notify('模拟持仓行情刷新失败，当前显示上次价格', 'error');
  }catch(err){
    addLog('error', `模拟持仓行情刷新失败：${err.message || err}`);
    notify(`模拟持仓行情刷新失败：${err.message || err}`, 'error');
  }finally{
    renderStocks();
  }
}

async function openSimulationPortfolio(){
  currentViewSource = 'portfolio';
  activeDetailCode = null;
  stocks = [];
  selected.clear();
  onlineSearchResults = [];
  searchStatus = '';
  $('searchInput').value = '';
  $('addPanel')?.classList.add('hidden');
  closeStockLabelPanel();
  renderStocks();
  await refreshPortfolioHoldings();
}

function renderStocks(){
  $('selectedCount').textContent = selected.size;
  renderDetailPanel();
  $('simulationView')?.classList.toggle('active', currentViewSource === 'portfolio');
  $('liveNewsView')?.classList.toggle('active', currentViewSource === 'liveNews');
  if(currentViewSource === 'liveNews'){
    $('stockContainer').innerHTML = renderLiveNewsView();
    bindLiveNewsInteractions($('stockContainer'));
    renderAddStockList();
    renderLabels();
    return;
  }
  if(currentViewSource === 'portfolio'){
    $('stockContainer').innerHTML = renderPortfolioView();
    bindStockInteractions($('stockContainer'));
    bindPortfolioInteractions($('stockContainer'));
    renderAddStockList();
    renderLabels();
    return;
  }
  const list = filteredStocks();
  const grouped = list.reduce((a,s)=>{ (a[s.sector] ||= []).push(s); return a; }, {});
  let html = Object.entries(grouped).map(([sector, arr]) => {
    if(view === 'card') return `<section class="sector"><h2 class="sector-title">${escapeHtml(sector)}</h2><div class="grid">${arr.map(s=>stockCard(s)).join('')}</div></section>`;
    return `<section class="sector"><h2 class="sector-title">${escapeHtml(sector)}</h2><div class="table-wrap"><table class="stock-table"><thead><tr><th>选</th><th>名称</th><th>代码</th><th>定位</th><th>状态</th><th>评分</th><th>价格</th><th>涨跌</th><th>标签</th><th>原因</th></tr></thead><tbody>${arr.map(tableRow).join('')}</tbody></table></div></section>`;
  }).join('');
  if(onlineSearchResults.length){
    const localCodes = new Set(stocks.map(s => s.code));
    html += `<section class="sector"><h2 class="sector-title">线上搜索结果</h2><div class="online-results">${onlineSearchResults.map(item => {
      const exists = localCodes.has(item.code);
      return `<div class="online-row">
        <div><b>${escapeHtml(item.name)}</b> <span class="code">${item.code}</span><small>${escapeHtml(item.securityType || '')}</small></div>
        <button class="small ${exists ? '' : 'primary'}" data-add-online-stock="${item.code}" ${exists ? 'disabled' : ''}>${exists ? '已在股票池' : '添加到股票池'}</button>
      </div>`;
    }).join('')}</div></section>`;
  }else if(searchStatus){
    html += `<section class="sector"><h2 class="sector-title">线上搜索结果</h2><div class="card search-status">${escapeHtml(searchStatus)}</div></section>`;
  }
  $('stockContainer').innerHTML = html || '';
  bindStockInteractions($('stockContainer'));
  renderAddStockList();
  renderLabels();
}

function renderAddStockList(){
  $('selectedCount').textContent = selected.size;
  $('openAddPanel')?.classList.toggle('hidden', !(stocks.length && currentViewSource === 'generated'));
}

function activeLabelSort(){
  const sort = labelSorts[activeLabel];
  return ['score','changePct','price'].includes(sort?.field) && ['asc','desc'].includes(sort?.direction)
    ? sort : {field:'', direction:'none'};
}

function sortedLabelStocks(label){
  const list = [...(label?.stocks || [])];
  const pinned = list.filter(stock => stock.pinned);
  const regular = list.filter(stock => !stock.pinned);
  const sort = activeLabelSort();
  if(sort.direction === 'none') return [...pinned, ...regular];
  const valueOf = stock => {
    const value = sort.field === 'score' ? stockAnalysisScore(stock) : stock[sort.field];
    return value === null || value === undefined || value === '' ? null : Number(value);
  };
  const sorted = regular.map((stock, index) => ({stock, index})).sort((a, b) => {
    const av = valueOf(a.stock);
    const bv = valueOf(b.stock);
    const aMissing = !Number.isFinite(av);
    const bMissing = !Number.isFinite(bv);
    if(aMissing || bMissing) return aMissing === bMissing ? a.index - b.index : (aMissing ? 1 : -1);
    const compared = sort.direction === 'asc' ? av - bv : bv - av;
    return compared || a.index - b.index;
  }).map(item => item.stock);
  return [...pinned, ...sorted];
}

function renderLabelSortControls(label){
  const sort = activeLabelSort();
  const controls = {
    score:$('labelScoreSort'),
    changePct:$('labelChangeSort'),
    price:$('labelPriceSort')
  };
  Object.entries(controls).forEach(([field, select]) => {
    if(!select) return;
    select.value = sort.field === field ? sort.direction : 'none';
    select.disabled = !label?.stocks?.length;
  });
}

function updateLabelSort(field, direction){
  if(!activeLabel) return;
  if(direction === 'none') delete labelSorts[activeLabel];
  else labelSorts[activeLabel] = {field, direction};
  addLog('action', `标签排序：${activeLabel}`, {field, direction});
  saveState();
  renderLabels();
}

function startLabelEditing(){
  if(!activeLabel) return;
  labelEditMode = true;
  labelNameDraft = activeLabel;
  selected.clear();
  renderStocks();
  setTimeout(() => {
    const input = $('activeLabelNameInput');
    input?.focus({preventScroll:true});
    input?.select();
  }, 0);
}

function finishLabelEditing(){
  const label = labels.find(item => item.name === activeLabel);
  if(!label){
    labelEditMode = false;
    labelNameDraft = '';
    renderStocks();
    return;
  }
  const oldName = label.name;
  const newName = labelNameDraft.trim();
  if(!newName){
    notify('标签名称不能为空', 'warn');
    $('activeLabelNameInput')?.focus({preventScroll:true});
    return;
  }
  if(newName !== oldName && labels.some(item => item.name === newName)){
    notify(`标签「${newName}」已存在`, 'warn');
    $('activeLabelNameInput')?.focus({preventScroll:true});
    return;
  }
  if(newName !== oldName){
    label.name = newName;
    if(Object.prototype.hasOwnProperty.call(labelSorts, oldName)){
      labelSorts[newName] = labelSorts[oldName];
      delete labelSorts[oldName];
    }
    activeLabel = newName;
    notify(`标签已重命名为「${newName}」`, 'success');
  }
  labelEditMode = false;
  labelNameDraft = '';
  selected.clear();
  saveState();
  renderStocks();
}

function cancelLabelEditing(){
  labelEditMode = false;
  labelNameDraft = '';
  selected.clear();
  renderStocks();
}

function renderLabels(){
  const label = labels.find(l => l.name === activeLabel) || labels[0];
  if(label && activeLabel !== label.name) activeLabel = label.name;
  $('labelList').innerHTML = labels.map(l => {
    const active = l.name === activeLabel ? 'active' : '';
    return `<div class="label-item ${active}">
      <button class="label-name" data-active-label="${escapeHtml(l.name)}">${escapeHtml(l.name)} <small>${l.stocks.length}只</small></button>
      <button class="small danger" data-delete-label="${escapeHtml(l.name)}">删除</button>
    </div>`;
  }).join('');
  $('activeLabelTitle').innerHTML = labelEditMode && label
    ? `<input id="activeLabelNameInput" class="active-label-name-input" value="${escapeHtml(labelNameDraft || label.name)}" maxlength="40" aria-label="标签名称" />`
    : escapeHtml(label ? label.name : '暂无标签');
  const labelNameInput = $('activeLabelNameInput');
  if(labelNameInput){
    labelNameInput.oninput = event => { labelNameDraft = event.target.value; };
    labelNameInput.onkeydown = event => {
      if(event.key === 'Enter'){ event.preventDefault(); finishLabelEditing(); }
      if(event.key === 'Escape'){ event.preventDefault(); cancelLabelEditing(); }
    };
  }
  renderLabelSortControls(label);
  const activeLabelCodes = new Set(label?.stocks.map(s => s.code) || []);
  const hasSelectedInLabel = [...selected].some(code => activeLabelCodes.has(code));
  const editBtn = $('editLabelStocks');
  const selectBtn = $('selectLabelAll');
  const deleteBtn = $('deleteSelectedFromLabel');
  if(editBtn) editBtn.textContent = labelEditMode ? '完成' : '编辑';
  if(selectBtn) selectBtn.classList.toggle('hidden', !labelEditMode);
  if(deleteBtn){
    deleteBtn.classList.toggle('hidden', !labelEditMode);
    deleteBtn.disabled = !hasSelectedInLabel;
  }
  const displayedStocks = sortedLabelStocks(label);
  $('labelStocks').innerHTML = displayedStocks.length ? displayedStocks.map(s => stockCard(s,true,labelEditMode)).join('') : '<div class="note">暂无股票，先从左侧选择并添加。</div>';

  document.querySelectorAll('[data-active-label]').forEach(b => b.onclick = () => { activeLabel = b.dataset.activeLabel; selected.clear(); labelEditMode = false; labelNameDraft = ''; addLog('info', `切换标签：${activeLabel}`); renderLabels(); });
  document.querySelectorAll('[data-delete-label]').forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    const name = b.dataset.deleteLabel;
    if(b.dataset.confirmDelete !== 'true'){
      b.dataset.confirmDelete = 'true';
      b.textContent = '确认删除';
      const timerButton = b;
      setTimeout(() => {
        if(timerButton.isConnected && timerButton.dataset.confirmDelete === 'true'){
          timerButton.dataset.confirmDelete = '';
          timerButton.textContent = '删除';
        }
      }, 3000);
      return;
    }
    labels = labels.filter(l => l.name !== name);
    delete labelSorts[name];
    activeLabel = labels[0]?.name || '';
    selected.clear();
    labelEditMode = false;
    labelNameDraft = '';
    notify(`已删除标签「${name}」`, 'success');
    saveState();
    renderStocks();
    setTimeout(() => {
      window.focus();
      $('searchInput')?.focus({preventScroll:true});
    }, 0);
  });
  bindStockInteractions($('labelStocks'));
  $('labelStocks').querySelectorAll('[data-detail-code]').forEach(card => card.oncontextmenu = event => {
    event.preventDefault();
    openLabelStockMenu(card.dataset.detailCode, event.clientX, event.clientY);
  });
  if(label?.stocks.length) void ensureLabelScores(label.stocks);
}

function closeLabelStockMenu(){
  contextLabelStockCode = null;
  $('labelStockMenu')?.classList.add('hidden');
}

function openLabelStockMenu(code, x, y){
  const label = labels.find(item => item.name === activeLabel);
  const stock = label?.stocks.find(item => item.code === code);
  if(!stock) return;
  contextLabelStockCode = code;
  const menu = $('labelStockMenu');
  $('pinLabelStock').textContent = stock.pinned ? '取消置顶' : '置顶';
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
}

function togglePinnedLabelStock(){
  const code = contextLabelStockCode;
  const label = labels.find(item => item.name === activeLabel);
  const stock = label?.stocks.find(item => item.code === code);
  if(!stock) return closeLabelStockMenu();
  stock.pinned = !stock.pinned;
  notify(`${stock.name} 已${stock.pinned ? '置顶' : '取消置顶'}`, 'success');
  saveState();
  closeLabelStockMenu();
  renderLabels();
}

function removeContextLabelStock(){
  const code = contextLabelStockCode;
  const label = labels.find(item => item.name === activeLabel);
  const stock = label?.stocks.find(item => item.code === code);
  if(!stock) return closeLabelStockMenu();
  label.stocks = label.stocks.filter(item => item.code !== code);
  selected.delete(code);
  notify(`已从标签「${label.name}」删除 ${stock.name}`, 'success');
  saveState();
  closeLabelStockMenu();
  renderLabels();
}

function closeStockLabelPanel(){
  stockLabelEditCode = null;
  $('stockLabelPanel')?.classList.add('hidden');
  stockLabelReturnFocus?.focus?.({preventScroll:true});
  stockLabelReturnFocus = null;
}

function openStockLabelPanel(code){
  const stock = findStockByCode(code);
  if(!stock) return;
  stockLabelReturnFocus = document.activeElement;
  stockLabelEditCode = code;
  $('addPanel')?.classList.add('hidden');
  $('stockLabelPanel').classList.remove('hidden');
  $('stockLabelTitle').textContent = `${stock.name} ${stock.code} 的标签`;
  $('newStockLabelName').value = '';
  const current = new Set(labelNamesForStock(code));
  $('stockLabelChoices').innerHTML = labels.length ? labels.map(l => `<label class="label-choice">
    <input type="checkbox" data-stock-label-name="${escapeHtml(l.name)}" ${current.has(l.name) ? 'checked' : ''} />
    <span>${escapeHtml(l.name)} <small>${l.stocks.length}只</small></span>
  </label>`).join('') : '<div class="note">暂无标签，可在下方输入新标签名称。</div>';
  setTimeout(() => (document.querySelector('[data-stock-label-name]') || $('newStockLabelName'))?.focus({preventScroll:true}), 0);
}

function saveStockLabels(){
  const stock = findStockByCode(stockLabelEditCode);
  if(!stock) return;
  const chosen = new Set([...document.querySelectorAll('[data-stock-label-name]:checked')].map(el => el.dataset.stockLabelName));
  const newName = $('newStockLabelName').value.trim();
  if(newName) chosen.add(newName);
  chosen.forEach(name => {
    if(!labels.some(l => l.name === name)) labels.push({name, stocks: []});
  });
  labels = labels.map(label => {
    const existingStock = label.stocks.find(s => s.code === stock.code);
    if(!chosen.has(label.name)) return label;
    const withoutStock = label.stocks.filter(s => s.code !== stock.code);
    const savedStock = labelStockSnapshot(stock, existingStock);
    return {...label, stocks: [...withoutStock, savedStock]};
  });
  if(!activeLabel && labels.length) activeLabel = labels[0].name;
  notify(`已保存 ${stock.name} 的标签`, 'success');
  saveState();
  closeStockLabelPanel();
  renderStocks();
}

function bindStockInteractions(root){
  root.querySelectorAll('.stock-check').forEach(el => {
    el.onclick = (e) => e.stopPropagation();
    el.onchange = (e) => toggle(e.target.dataset.code);
  });
  root.querySelectorAll('[data-edit-stock-labels]').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      openStockLabelPanel(el.dataset.editStockLabels);
    };
  });
  root.querySelectorAll('[data-add-online-stock]').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      addOnlineStock(el.dataset.addOnlineStock);
    };
  });
  root.querySelectorAll('[data-detail-code]').forEach(el => {
    el.onclick = (e) => {
      if(e.target.closest('input,button')) return;
      activeDetailCode = el.dataset.detailCode;
      forceDetailRefreshCode = activeDetailCode;
      if(root.id === 'labelStocks'){
        const stock = findStockByCode(activeDetailCode);
        stocks = stock ? [stock] : [];
        currentViewSource = stock ? 'label' : 'empty';
        selected.clear();
        onlineSearchResults = [];
        searchStatus = '';
        $('searchInput').value = '';
        renderStocks();
      }else{
        renderDetailPanel();
      }
      $('detailPanel')?.scrollIntoView({ behavior:'smooth', block:'start' });
    };
  });
}

function addOnlineStock(code){
  const item = onlineSearchResults.find(x => x.code === code);
  if(!item || stocks.some(s => s.code === code)) return;
  const stock = defaultStockFromSearch(item);
  stocks.push(stock);
  currentViewSource = 'search';
  notify(`已添加 ${stock.name} ${stock.code} 到股票池`, 'success');
  saveState();
  selected = new Set([code]);
  activeDetailCode = code;
  renderStocks();
  openStockLabelPanel(code);
  refreshCodes([code]);
}

function findStockByCode(code){
  return stocks.find(x => x.code === code)
    || labels.flatMap(l => l.stocks || []).find(x => x.code === code)
    || portfolioStock(portfolioPosition(code));
}

function analysisText(s){
  const pct = typeof s.changePct === 'number' ? s.changePct : null;
  if(pct == null || typeof s.price !== 'number') return `${s.name} 行情尚未刷新，暂不能判断当日走势和资金状态。`;
  const trend = pct >= 3 ? '短线表现强势' : pct <= -3 ? '短线明显承压' : pct > 0 ? '当日小幅走强' : pct < 0 ? '当日小幅走弱' : '当日价格持平';
  const range = typeof s.high === 'number' && typeof s.low === 'number' && s.high > s.low
    ? (s.price - s.low) / (s.high - s.low)
    : null;
  const position = range == null ? '' : range >= .7 ? '现价位于日内区间偏高位置' : range <= .3 ? '现价位于日内区间偏低位置' : '现价位于日内区间中部';
  let capital = '主力资金接口暂未返回有效数据';
  if(typeof s.mainNetInflow === 'number'){
    const direction = s.mainNetInflow >= 0 ? '净流入' : '净流出';
    const divergence = pct < 0 && s.mainNetInflow > 0
      ? '，股价收跌但资金净流入，显示有承接但尚未带动价格转强'
      : pct > 0 && s.mainNetInflow < 0
        ? '，股价上涨但资金净流出，需留意上涨持续性'
        : '';
    capital = `主力${direction}${money(Math.abs(s.mainNetInflow))}${typeof s.mainNetPct === 'number' ? `，占成交额${formatPct(Math.abs(s.mainNetPct))}` : ''}${divergence}`;
  }
  return `${s.name} 今日${formatPct(pct)}，${trend}${position ? `，${position}` : ''}。${capital}。成交额${money(s.amount)}，流通市值${marketCapValue(s.floatMarketCap)}。`;
}

function reliableIndustry(value){
  const text = String(value || '').trim();
  return /^(线上搜索|待确认|其他\s*\/\s*待确认|命令指定代码)?$/.test(text) ? '' : text;
}

function labelNameFromCommand(command){
  const input = String(command || '').trim();
  const match = input.match(/(?:查找|寻找|搜索|生成)?\s*A?股?\s*(?:整个)?\s*([\u4e00-\u9fa5A-Za-z0-9]{2,16}?)(?:整个)?(?:行业|板块|概念|产业链)/i);
  const raw = match?.[1] || input;
  const cleaned = raw
    .replace(/A股|股票|整个|全行业|行业|板块|概念|产业链|产业|相关|公司|标的/g, '')
    .replace(/查找|寻找|搜索|生成|更新|按照|类型|分区|列出|龙头|待突破|已突破|重点关注|待回调|当前价格|最新情况|原因/g, '')
    .replace(/[，。、“”‘’：:；;,.!?！？\s]/g, '')
    .trim();
  return cleaned.slice(0, 12) || '自定义关注';
}

function renderCompanyProfile(code, result, fallbackStock){
  const box = document.querySelector(`[data-profile-for="${code}"]`);
  if(!box) return;
  const profile = result?.profile || {};
  const industry = reliableIndustry(profile.industry) || reliableIndustry(fallbackStock.sector) || '暂未获取到可靠行业数据';
  const tags = (profile.tags || []).filter(tag => tag && tag !== industry).slice(0, 8);
  const industryBox = document.querySelector(`[data-industry-for="${code}"]`);
  const sectorBox = document.querySelector(`[data-detail-sector="${code}"]`);
  if(industryBox) industryBox.innerHTML = `<b>行业 / 分类：</b>${escapeHtml(industry)}`;
  if(sectorBox) sectorBox.textContent = industry === '暂未获取到可靠行业数据' ? '' : industry;
  box.innerHTML = `<p><b>所属行业：</b>${escapeHtml(industry)}</p>
    ${tags.length ? `<p><b>产业 / 概念：</b>${tags.map(escapeHtml).join('、')}</p>` : ''}
    ${profile.business ? `<p><b>主营/产业：</b>${escapeHtml(profile.business)}</p>` : ''}
    ${profile.products ? `<p><b>主营构成：</b>${escapeHtml(profile.products)}</p>` : ''}
    ${profile.summary ? `<p><b>公司情况：</b>${escapeHtml(profile.summary)}</p>` : ''}
    ${!profile.business && !profile.products && !profile.summary ? '<div class="note inline-note">已获取实际行业和产业板块；公司主营明细源当前不可用，不展示推测内容。</div>' : ''}
    <p><b>资料来源：</b>${escapeHtml(profile.source || '本地分析/接口补充')}</p>`;
}

function stockMarketContext(s){
  const market = latestMarketOverview;
  if(!market) return '大盘实时数据正在加载，完成后将自动补充联动分析。';
  const indices = market.indices || [];
  const validChanges = indices.map(item => Number(item.changePct)).filter(Number.isFinite);
  const indexAverage = validChanges.length ? validChanges.reduce((sum, value) => sum + value, 0) / validChanges.length : null;
  const stockChange = Number(s.changePct);
  const relative = Number.isFinite(stockChange) && indexAverage != null
    ? stockChange >= indexAverage + 1 ? '明显强于大盘' : stockChange <= indexAverage - 1 ? '明显弱于大盘' : '与大盘表现接近'
    : '相对强弱待行情补充';
  const profileIndustry = reliableIndustry(detailProfileCache.get(s.code)?.profile?.industry);
  const industry = profileIndustry || reliableIndustry(s.sector);
  const relatedSector = [...(market.sectors || []), ...(market.weakSectors || [])].find(item => {
    const name = String(item.name || '');
    return industry && name && (name.includes(industry) || industry.includes(name));
  });
  const recommendation = (market.recommendations || []).find(item => String(item.code) === String(s.code));
  const breadth = market.breadth || {};
  const indexText = indices.slice(0, 3).map(item => `${item.name || item.code || '指数'}${formatPct(item.changePct)}`).join('、') || '指数数据暂缺';
  const sectorText = relatedSector ? `${relatedSector.name}${formatPct(relatedSector.changePct)}${relatedSector.leader ? `，领涨 ${relatedSector.leader}` : ''}` : `${industry || '所属行业'}暂未进入板块轮动前列`;
  const signalText = recommendation ? `全市场筛选信号为${recommendation.signal || '待确认'}，评分${recommendation.signalScore ?? recommendation.score ?? '--'}，${recommendation.verdict || '等待确认'}` : '当前未进入大盘技术形态推荐名单';
  const marketNews = String(market.newsContext?.summary || '市场消息面暂未返回有效摘要').replace(/[。；;]+$/, '');
  const updatedAt = market.fetchedAt ? new Date(market.fetchedAt).toLocaleString('zh-CN', {hour12:false}) : '--';
  return `${indexText}；上涨${breadth.up ?? '--'}家、下跌${breadth.down ?? '--'}家。个股${relative}；板块表现：${sectorText}；${signalText}。市场消息：${marketNews}。大盘更新时间：${updatedAt}。`;
}

function investmentAnalysisHtml(result){
  const investment = result?.investmentAnalysis;
  const financial = result?.financialAnalysis;
  if(!investment && !financial) return '<div class="note inline-note">财务与 CANSLIM 数据源不可用，本次仅展示技术分析，不补造财务评分。</div>';
  const canslim = investment?.canslim;
  const dimensions = canslim?.dimensions || [];
  const dimensionRows = dimensions.map(item => `<tr><td><b>${escapeHtml(item.key)} · ${escapeHtml(item.label)}</b></td><td>${item.available ? `${escapeHtml(item.score)}/${escapeHtml(item.max)}` : '数据不足'}</td><td>${escapeHtml(item.evidence || '--')}</td></tr>`).join('');
  const value = investment?.value || {};
  const quality = value.quality || financial?.quality || {};
  const financialRows = (financial?.rows || []).map(row => `<tr><td>${escapeHtml(row.report || '--')}</td><td>${row.eps == null ? '--' : formatNumber(row.eps,2)}</td><td>${row.epsGrowth == null ? '--' : formatPct(row.epsGrowth)}</td><td>${row.revenueGrowth == null ? '--' : formatPct(row.revenueGrowth)}</td><td>${row.profitGrowth == null ? '--' : formatPct(row.profitGrowth)}</td><td>${row.roe == null ? '--' : formatPct(row.roe)}</td><td>${row.cashPerShare == null ? '--' : formatNumber(row.cashPerShare,2)}</td></tr>`).join('');
  const risks = financial?.hardRisks || [];
  const qualityScore = quality.score !== null && quality.score !== '' && Number.isFinite(Number(quality.score))
    ? `${escapeHtml(quality.score)}/100` : '未评分';
  const financialRiskHtml = !financial
    ? '<p><b>财务红旗：</b>未核验，财务接口暂时不可用。</p>'
    : risks.length
      ? `<p class="financial-risk"><b>财务红旗：</b>${risks.map(escapeHtml).join('；')}。</p>`
      : '<p><b>财务红旗：</b>当前已获取指标未触发硬性恶化条件；仍不等于财务无风险。</p>';
  return `<section class="investment-framework">
    <h3>CANSLIM 与价值质量分析</h3>
    <div class="analysis-verdict"><div class="analysis-score"><b>${escapeHtml(canslim?.score ?? '--')}</b><span>CANSLIM / 100</span></div><div><p><b>评分口径：</b>${escapeHtml(canslim?.scope || '个股实时分析')}；<b>可验证覆盖：</b>${escapeHtml(canslim?.available ?? 0)}/${escapeHtml(canslim?.total ?? 7)}维，原始得分 ${escapeHtml(canslim?.rawScore ?? '--')}/${escapeHtml(canslim?.availableMax ?? '--')}。</p><p>${escapeHtml(canslim?.note || '缺失项不推测。')}</p></div></div>
    <div class="framework-table-wrap"><table class="framework-table"><thead><tr><th>维度</th><th>得分</th><th>真实数据依据</th></tr></thead><tbody>${dimensionRows || '<tr><td colspan="3">CANSLIM数据不足</td></tr>'}</tbody></table></div>
    <div class="value-summary"><p><b>价值综合分：</b>${escapeHtml(value.score ?? '--')}/100；<b>财务质量：</b>${qualityScore}；<b>估值分：</b>${escapeHtml(value.valuationScore ?? '--')}/100。</p>
      <p><b>PE / PB：</b>${value.pe == null ? '--' : formatNumber(value.pe,1)} / ${value.pb == null ? '--' : formatNumber(value.pb,1)}；<b>质量依据：</b>${escapeHtml(quality.evidence || '财务接口暂时不可用，本次不生成财务质量评分')}。</p>
      <p><b>DCF：</b>${escapeHtml(value.dcf?.evidence || '数据不可用')}。</p><p><b>护城河：</b>${escapeHtml(value.moat?.evidence || '数据不可用')}。</p>
      ${financialRiskHtml}
      <p><b>数据源：</b>${escapeHtml(financial?.source || value.source || '--')}；<b>最新报告期：</b>${escapeHtml(financial?.latestReport || '--')}。</p></div>
    <div class="framework-table-wrap"><table class="framework-table financial-table"><thead><tr><th>报告期</th><th>EPS</th><th>EPS同比</th><th>营收同比</th><th>净利同比</th><th>ROE</th><th>经营现金流/股</th></tr></thead><tbody>${financialRows || '<tr><td colspan="7">季度财务序列不可用</td></tr>'}</tbody></table></div>
  </section>`;
}

function renderHistoryAnalysis(s, result){
  const box = document.querySelector(`[data-history-for="${s.code}"]`);
  const analysisBox = document.querySelector(`[data-analysis-for="${s.code}"]`);
  if(!box || !analysisBox) return;
  const a = result?.analysis;
  if(!a){
    box.innerHTML = '<div class="note inline-note">近3个月行情不足，暂不能生成趋势分析。</div>';
    return;
  }
  const capital = typeof s.mainNetInflow === 'number'
    ? `当前主力流入${metricValue(s.mainInflow, money)}、流出${metricValue(s.mainOutflow, money)}，${s.mainNetInflow >= 0 ? '净流入' : '净流出'}${money(Math.abs(s.mainNetInflow))}${typeof s.mainNetPct === 'number' ? `，净占比${formatPct(s.mainNetPct)}` : ''}。`
    : '当前主力资金接口未返回有效数据，不沿用历史资金值。';
  const hasRecommendationScore = s.signalScore !== null && s.signalScore !== '' && Number.isFinite(Number(s.signalScore));
  const displayedScore = a.score;
  const scoreLabel = '当前技术评分 / 100';
  const conclusion = a.combinedConclusion || a.summary;
  const displayedVerdict = a.verdict;
  const recommendationSnapshotHtml = hasRecommendationScore
    ? `<p><b>大盘推荐快照：</b>${escapeHtml(s.signal || s.marketSignal || '待确认')}，推荐评分 ${escapeHtml(Math.round(Number(s.signalScore)))} / 100，推荐时判断 ${escapeHtml(s.verdict || '等待确认')}。该评分保留用于推荐列表排序，不替代本次个股技术评分。</p>`
    : '';
  const marketContext = stockMarketContext(s);
  const corporateRisk = result?.riskProfile;
  const reductionText = corporateRisk?.reduction?.status === 'risk'
    ? corporateRisk.reduction.events.map(event => `${event.startDate}至${event.endDate}${event.estimated ? '（估算）' : ''}`).join('、')
    : corporateRisk?.reduction?.status === 'clear' ? '未发现计划' : '未确认';
  const unlockText = corporateRisk?.unlock?.status === 'risk'
    ? corporateRisk.unlock.events.map(event => `${event.date}${event.type ? `（${event.type}）` : ''}`).join('、')
    : corporateRisk?.unlock?.status === 'clear' ? '未发现安排' : '未确认';
  const corporateRiskHtml = corporateRisk ? `<p class="corporate-risk"><b>未来半年公司风险：</b>${escapeHtml(corporateRisk.summary || '未确认')}；ST：${escapeHtml(corporateRisk.st?.status === 'risk' ? '有当前标记' : '无当前标记')}；减持：${escapeHtml(reductionText)}；解禁：${escapeHtml(unlockText)}。<br><b>核验窗口：</b>${escapeHtml(corporateRisk.windowStart || '--')} 至 ${escapeHtml(corporateRisk.windowEnd || '--')}；<b>数据源：</b>${escapeHtml(corporateRisk.source || '公开公司公告与限售解禁数据')}</p>`
    : '<p class="corporate-risk"><b>未来半年公司风险：</b>未确认。</p>';
  const plan = a.tradePlan;
  const breakout = a.breakoutPotential || a.consolidationBreakout;
  const entryAssessment = a.entryAssessment;
  const entryAssessmentHtml = entryAssessment
    ? `<p class="entry-assessment ${escapeHtml(entryAssessment.tone || 'neutral')}"><b>当前入场结论：${escapeHtml(entryAssessment.status || '等待确认')}</b><span>${escapeHtml(entryAssessment.summary || '')}</span>${entryAssessment.structureSummary ? `<span><strong>吸筹 / 洗盘评估：</strong>${escapeHtml(entryAssessment.structureSummary)}</span>` : ''}<small>${(entryAssessment.evidence || []).map(escapeHtml).join(' · ')}</small></p>`
    : '<p class="entry-assessment neutral"><b>当前入场结论：数据待补充</b><span>关键价格、均线或量能数据不足，暂不形成入场结论。</span></p>';
  const breakoutHtml = breakout?.available
    ? `<p><b>横盘突破评估：</b>${escapeHtml(breakout.status || '横盘观察')}，评分 ${escapeHtml(breakout.score ?? breakout.technicalScore ?? '--')}/100；横盘 ${escapeHtml(breakout.boxDays)} 日，箱顶 ${yuan(breakout.boxHigh)}，箱底 ${yuan(breakout.boxLow)}，箱体宽度 ${formatPct(breakout.rangePct)}；放量试压 ${escapeHtml(breakout.pressureTestCount || 0)} 次${breakout.failedPressureCount ? `，冲高回落 ${escapeHtml(breakout.failedPressureCount)} 次` : ''}。<br><b>确认条件：</b>${escapeHtml(breakout.trigger || '--')}；<b>失效条件：</b>${escapeHtml(breakout.invalidation || '--')}。</p>`
    : '<p><b>横盘突破评估：</b>历史行情不足，暂不能形成箱体判断。</p>';
  const tradePlanHtml = plan ? `<div class="trade-plan">
      <h4>条件化操作参考</h4>
      <p><b>低吸区间：</b>${yuan(plan.entryLow)}-${yuan(plan.entryHigh)}。${plan.enabled ? '仅在价格进入区间并出现缩量企稳时分批执行。' : '当前趋势条件不合格，暂不执行低吸，先等待趋势修复。'}</p>
      <p><b>分批建仓：</b>${(plan.entrySteps || []).map((step, index) => `第${index + 1}笔${step.buyPct}%：${escapeHtml(step.condition)}`).join('；')}</p>
      <p><b>确认价：</b>${yuan(plan.confirmationPrice)}。未满足收盘与量比条件，不执行最后一笔。</p>
      <p><b>失效 / 止损：</b>${yuan(plan.invalidationPrice)}，按低吸区中值测算风险约${formatPct(-Number(plan.stopPct))}；收盘有效跌破时退出，不用盘中瞬时触价替代收盘确认。</p>
      <p><b>分批止盈：</b>${(plan.targets || []).map((target, index) => `第${index + 1}档 ${yuan(target.price)} 卖出${target.sellPct}%`).join('；')}。</p>
      <p><b>移动保护：</b>${(plan.targetNotes || []).map(escapeHtml).join('；')}。</p>
      <p><b>仓位上限示例：</b>若账户单笔最大可承受损失限定为总资金1%，按当前止损距离反推，计划总仓位不超过${formatNumber(plan.maxPositionPct, 1)}%。</p>
      <p><b>计算依据：</b>${escapeHtml(plan.rationale || '')}。价格均为动态参考，刷新行情后会重算。</p>
    </div>` : '';
  analysisBox.innerHTML = `<b>股票分析：</b>${escapeHtml(`${conclusion}${capital}${marketContext}`)}`;
  box.innerHTML = `<h3>综合实时行情、资金、趋势、消息与大盘分析</h3>
    <div class="analysis-verdict">
      <div class="analysis-score"><b>${escapeHtml(displayedScore ?? '--')}</b><span>${scoreLabel}</span></div>
      <div><p><b>当前判断：</b>${escapeHtml(displayedVerdict || '等待确认')}</p><p>${escapeHtml(conclusion)}</p>${recommendationSnapshotHtml}</div>
    </div>
    <div class="analysis-grid">
      ${entryAssessmentHtml}
      <p><b>趋势：</b>${escapeHtml(a.summary)}</p>
      <p><b>涨跌表现：</b>近5日 ${formatPct(a.return5)}；近20日 ${formatPct(a.return20)}；近60日 ${formatPct(a.return60)}</p>
      <p><b>均线综合：</b>${escapeHtml(a.maAlignment || '--')}；MA5 ${yuan(a.ma5)}；MA10 ${yuan(a.ma10)}；MA20 ${yuan(a.ma20)}；MA30 ${yuan(a.ma30)}；MA60 ${yuan(a.ma60)}；RSI14 ${formatNumber(a.rsi14)}</p>
      <p><b>MACD：</b>DIF ${formatNumber(a.macdDif,3)}；DEA ${formatNumber(a.macdDea,3)}；柱值 ${formatNumber(a.macdHistogram,3)}</p>
      <p><b>布林带：</b>上轨 ${yuan(a.bollUpper)}；中轨 ${yuan(a.bollMiddle)}；下轨 ${yuan(a.bollLower)}</p>
      <p><b>当前放量：</b>${escapeHtml(a.volume)} 当前量比 ${formatNumber(a.volumeRatio)}。</p>
      <p><b>阶段主力资金：</b>${escapeHtml(a.capitalSetupAssessment?.summary || '阶段主力资金数据不可用，本次不据此调整评分。')}</p>
      ${a.historicalOutcomeAssessment?.summary ? `<p><b>本地推荐复盘：</b>${escapeHtml(a.historicalOutcomeAssessment.summary)}</p>` : ''}
      <p><b>底部蓄势结构：</b>${escapeHtml(a.accumulationSetup?.summary || '历史行情不足，暂不能评估五线粘合与三次放量。')} ${a.capitalSetupAssessment?.status ? `<b>综合状态：</b>${escapeHtml(a.capitalSetupAssessment.status)}。` : ''}</p>
      ${breakoutHtml}
      <p><b>突破 / 支撑：</b>突破确认价 ${yuan(a.breakoutPrice)}；距突破位 ${formatPct(a.distanceToBreakout)}；支撑参考 ${yuan(a.supportPrice)}。</p>
      <p><b>波动风险：</b>${escapeHtml(a.risk || '--')}</p>
      <p><b>是否适合购买：</b>${escapeHtml(a.buyCondition || a.entry)}</p>
      <p><b>入场观察：</b>${escapeHtml(a.entry)}</p>
      <p><b>离场 / 风控：</b>${escapeHtml(a.exit)}</p>
      <p><b>消息面：</b>${escapeHtml(a.newsImpact || result.newsContext?.summary || '未获取到有效消息')}</p>
      ${corporateRiskHtml}
      <p class="market-context"><b>大盘与消息联动：</b>${escapeHtml(marketContext)}</p>
    </div>
    ${investmentAnalysisHtml(result)}
    ${tradePlanHtml}
    <p><b>预计观察窗口：</b>${escapeHtml(a.entryWindow)} <b>持仓观察：</b>${escapeHtml(a.exitWindow)}</p>
    <p><b>历史数据源：</b>${escapeHtml(a.source || result.source || '--')}；<b>最新交易日：</b>${escapeHtml(a.latestTradeDate || result.latestTradeDate || '--')}；<b>分析时间：</b>${a.analyzedAt ? escapeHtml(new Date(a.analyzedAt).toLocaleString('zh-CN', {hour12:false})) : '--'}</p>
    <div class="note inline-note">以上价格为历史行情、均线和波动率的条件演算，不考虑个人持仓成本、资金用途与风险承受能力，不保证触发价成交或获得收益。</div>`;
}

function mergeFundFlow(code, result){
  const merge = stock => stock.code === code ? {
    ...stock,
    mainInflow: result.mainInflow,
    mainOutflow: result.mainOutflow,
    mainNetInflow: result.mainNetInflow,
    mainNetPct: result.mainNetPct,
    fundFlowSource: result.source,
    fundFlowDate: result.tradeDate,
    fundFlowEstimated: Boolean(result.estimated)
  } : stock;
  stocks = stocks.map(merge);
  labels = labels.map(label => ({...label, stocks:label.stocks.map(merge)}));
  return findStockByCode(code);
}

function renderFundFlow(s){
  const values = [
    ['fund-in', s.mainInflow, money],
    ['fund-out', s.mainOutflow, money],
    ['fund-net', s.mainNetInflow, money],
    ['fund-pct', s.mainNetPct, formatPct]
  ];
  values.forEach(([name, value, formatter]) => {
    const node = document.querySelector(`[data-${name}-for="${s.code}"]`);
    if(node) node.textContent = metricValue(value, formatter);
  });
  const source = document.querySelector(`[data-fund-source-for="${s.code}"]`);
  if(source) source.innerHTML = `<b>资金数据：</b>${escapeHtml(s.fundFlowSource || '接口未提供')}${s.fundFlowDate ? `；<b>交易日：</b>${escapeHtml(s.fundFlowDate)}` : ''}${s.fundFlowEstimated ? '；按公开逐笔成交方向及金额估算，不等同于 Level-2 机构账户数据。' : ''}`;
}

async function loadStockFundFlow(s, force=false){
  const source = document.querySelector(`[data-fund-source-for="${s.code}"]`);
  if(!window.stockApi?.fetchStockFundFlow || !source) return;
  if(!force && detailFundFlowCache.has(s.code)){
    const cached = detailFundFlowCache.get(s.code);
    const updated = mergeFundFlow(s.code, cached);
    renderFundFlow(updated);
    return cached;
  }
  return withDetailPending(`fund:${s.code}`, async () => {
    source.innerHTML = '<b>资金数据：</b>正在汇总主力流入/流出...';
    try{
      const result = await window.stockApi.fetchStockFundFlow({code:s.code, force});
      detailFundFlowCache.set(s.code, result);
      const updated = mergeFundFlow(s.code, result);
      renderFundFlow(updated);
      if(detailHistoryCache.has(s.code)) renderHistoryAnalysis(updated, detailHistoryCache.get(s.code));
      saveState();
      (result.errors || []).forEach(message => addLog('warn', `资金源切换：${message}`));
      return result;
    }catch(err){
      if(source.isConnected) source.innerHTML = `<b>资金数据：</b>获取失败：${escapeHtml(err.message || err)}`;
      addLog('error', `资金汇总失败：${s.name} ${err.message || err}`);
      return null;
    }
  });
}

async function loadLatestDetailQuote(s){
  if(!window.stockApi?.fetchQuotes) return;
  return withDetailPending(`quote:${s.code}`, async () => {
    try{
      const result = parseQuoteResponse(await window.stockApi.fetchQuotes([s.code]));
      recordQuoteMessages(result);
      if(!result.quotes.length) throw new Error(result.errors.join('；') || '未获取到最新行情');
      applyQuoteData(result.quotes);
      const updated = findStockByCode(s.code);
      const values = {
        price: yuan(updated.price), changePct: formatPct(updated.changePct), change: formatNumber(updated.change),
        open: yuan(updated.open), high: yuan(updated.high), low: yuan(updated.low), prevClose: yuan(updated.prevClose),
        volume: volume(updated.volume), amount: money(updated.amount), totalMarketCap: marketCapValue(updated.totalMarketCap),
        floatMarketCap: metricValue(updated.floatMarketCap, money),
        turnoverRate: metricValue(updated.turnoverRate, value => `${formatNumber(value,2)}%`),
        peRatio: metricValue(updated.peRatio, value => formatNumber(value,2)),
        pbRatio: metricValue(updated.pbRatio, value => formatNumber(value,2)),
        snapshotVolumeRatio: metricValue(updated.snapshotVolumeRatio, value => formatNumber(value,2)),
        amplitude: metricValue(updated.amplitude, value => `${formatNumber(value,2)}%`),
        upperLimit: metricValue(updated.upperLimit, yuan), lowerLimit: metricValue(updated.lowerLimit, yuan)
      };
      Object.entries(values).forEach(([name, value]) => {
        const node = document.querySelector(`[data-quote-${name}-for="${s.code}"]`);
        if(node) node.textContent = value;
      });
      const pctNode = document.querySelector(`[data-quote-changePct-for="${s.code}"]`);
      if(pctNode) pctNode.parentElement.className = pctClass(updated.changePct);
      const current = document.querySelector(`[data-current-for="${s.code}"]`);
      if(current) current.innerHTML = `<b>当前情况：</b>${escapeHtml(updated.news || '--')}`;
      const source = document.querySelector(`[data-quote-source-for="${s.code}"]`);
      if(source) source.innerHTML = `<b>行情数据源：</b>${escapeHtml(updated.source || '--')}；<b>更新时间：</b>${updated.fetchedAt ? escapeHtml(new Date(updated.fetchedAt).toLocaleString('zh-CN', {hour12:false})) : '--'}`;
      if(detailHistoryCache.has(s.code)) renderHistoryAnalysis(updated, detailHistoryCache.get(s.code));
      saveState();
      renderLabels();
      return updated;
    }catch(err){
      const source = document.querySelector(`[data-quote-source-for="${s.code}"]`);
      if(source) source.innerHTML = `<b>行情更新失败：</b>${escapeHtml(err.message || err)}；当前保留原数据。`;
      notify(`个股最新行情获取失败：${err.message || err}`, 'error');
      return null;
    }
  });
}

async function fetchStockAnalysis(s, force=false){
  if(!force && detailHistoryCache.has(s.code)) return detailHistoryCache.get(s.code);
  if(!window.stockApi?.fetchStockHistory) return null;
  const pendingKey = s.code;
  if(detailHistoryPending.has(pendingKey)) return detailHistoryPending.get(pendingKey);
  const pending = window.stockApi.fetchStockHistory({code:s.code, name:s.name, force, favoriteOutcomes:favoriteOutcomeRows()})
    .then(result => {
      detailHistoryCache.set(s.code, result);
      applyAnalysisClassification(s.code);
      saveState();
      return result;
    })
    .finally(() => detailHistoryPending.delete(pendingKey));
  detailHistoryPending.set(pendingKey, pending);
  return pending;
}

async function ensureLabelScores(labelStocks){
  const missing = (labelStocks || []).filter(stock => !detailHistoryCache.has(stock.code)
    && !detailHistoryPending.has(stock.code));
  if(!missing.length) return;
  const results = await settleWithConcurrency(missing, 3, stock => fetchStockAnalysis(stock));
  const changed = results.some(result => result.status === 'fulfilled' && result.value);
  results.filter(result => result.status === 'rejected').forEach(result => addLog('error', `收藏评分计算失败：${result.reason?.message || result.reason}`));
  if(changed) renderLabels();
}

async function refreshAnalysisScores(codes){
  const targets = [...new Set(codes || [])].map(findStockByCode).filter(Boolean);
  const results = await settleWithConcurrency(targets, 3, stock => {
    const cached = detailHistoryCache.get(stock.code);
    const analyzedAt = Date.parse(cached?.analyzedAt || cached?.analysis?.analyzedAt || '');
    if(cached && Number.isFinite(analyzedAt) && Date.now() - analyzedAt < 5 * 60 * 1000){
      applyAnalysisClassification(stock.code);
      return cached;
    }
    return fetchStockAnalysis(stock, Boolean(cached));
  });
  results.forEach((result, index) => {
    const stock = targets[index];
    if(result.status === 'fulfilled' && result.value && stock.code === activeDetailCode) renderHistoryAnalysis(stock, result.value);
    if(result.status === 'rejected') addLog('error', `刷新评分失败：${stock.name} ${result.reason?.message || result.reason}`);
  });
  renderLabels();
}

async function refreshActiveFundFlow(codes){
  if(!activeDetailCode || !(codes || []).includes(activeDetailCode)) return;
  const stock = findStockByCode(activeDetailCode);
  if(stock) await loadStockFundFlow(stock, true);
}

function refreshSecondaryData(codes){
  const activeCodes = activeDetailCode && (codes || []).includes(activeDetailCode) ? [activeDetailCode] : [];
  if(!activeCodes.length) return;
  Promise.allSettled([refreshAnalysisScores(activeCodes), refreshActiveFundFlow(activeCodes)])
    .then(() => {
      saveState();
      renderStocks();
    });
}

async function loadStockHistory(s, force=false){
  const box = document.querySelector(`[data-history-for="${s.code}"]`);
  if(!box || !window.stockApi?.fetchStockHistory) return;
  if(!force && detailHistoryCache.has(s.code)){
    const cached = detailHistoryCache.get(s.code);
    renderHistoryAnalysis(s, cached);
    return cached;
  }
  box.innerHTML = '<div class="note inline-note">正在分析近3个月行情...</div>';
  try{
    const result = await fetchStockAnalysis(s, force);
    renderHistoryAnalysis(s, result);
    renderLabels();
    (result?.errors || []).forEach(msg => addLog('error', msg));
    return result;
  }catch(err){
    box.innerHTML = `<div class="note inline-note">近3个月行情分析失败：${escapeHtml(err.message || err)}</div>`;
    addLog('error', `近3个月行情分析失败：${s.name} ${err.message || err}`);
    return null;
  }
}

function formatChartDate(row){
  const raw = String(row?.time || row?.date || '');
  if(/^\d{12}/.test(raw)) return `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)} ${raw.slice(8,10)}:${raw.slice(10,12)}`;
  if(/^\d{8}/.test(raw)) return `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`;
  return raw.replace('T', ' ').slice(0, 16) || '--';
}

function formatChartVolume(value){
  const number = Number(value);
  if(!Number.isFinite(number)) return '--';
  if(Math.abs(number) >= 1e8) return `${(number / 1e8).toFixed(2)}亿`;
  if(Math.abs(number) >= 1e4) return `${(number / 1e4).toFixed(2)}万`;
  return number.toFixed(0);
}

function chartLegendHtml(period){
  if(period === 'minute') return `<span><i class="legend-price"></i>价格</span><span><i class="legend-average"></i>成交均价</span><span><i class="legend-zero"></i>昨收 / 0%线</span><span><i class="legend-volume"></i>成交量</span>`;
  if(period === 'five-day') return `<span><i class="legend-price"></i>价格</span><span><i class="legend-volume"></i>成交量</span>`;
  return `<span><i class="legend-up"></i>上涨K线</span><span><i class="legend-down"></i>下跌K线</span><span><i class="legend-volume"></i>成交量</span><span><i class="legend-ma5"></i>MA5 短线</span><span><i class="legend-ma10"></i>MA10 短中期</span><span><i class="legend-ma20"></i>MA20 月度趋势</span><span><i class="legend-ma30"></i>MA30 中期趋势</span><span><i class="legend-ma60"></i>MA60 中长期趋势</span>`;
}

function chartChangePct(rows, index, period, referencePrice){
  const close = Number(rows[index]?.close);
  if(!Number.isFinite(close)) return null;
  let base = null;
  if(period === 'minute') base = Number(referencePrice);
  else if(period === 'five-day'){
    const date = String(rows[index]?.time || '').slice(0, 8);
    const firstOfDay = rows.findIndex(row => String(row.time || '').startsWith(date));
    base = firstOfDay > 0 ? Number(rows[firstOfDay - 1]?.close) : null;
  }else base = index > 0 ? Number(rows[index - 1]?.close) : null;
  return Number.isFinite(base) && base > 0 ? (close / base - 1) * 100 : null;
}

function renderStockChart(canvas, rows, period, selectedIndex=null, referencePrice=null){
  if(!canvas || !rows.length) return;
  const width = Math.max(520, Math.floor(canvas.getBoundingClientRect().width || 760));
  const height = 360;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const margin = {left:54, right:14, top:18, bottom:26};
  const volumeHeight = 68;
  const priceBottom = height - margin.bottom - volumeHeight - 14;
  const plotWidth = width - margin.left - margin.right;
  const validReference = Number(referencePrice) > 0 ? Number(referencePrice) : null;
  const prices = rows.flatMap(row => [Number(row.low) || Number(row.close), Number(row.high) || Number(row.close)]);
  if(period === 'minute' && validReference) prices.push(validReference);
  let minPrice = Math.min(...prices);
  let maxPrice = Math.max(...prices);
  const padding = Math.max((maxPrice - minPrice) * .08, maxPrice * .002);
  minPrice -= padding;
  maxPrice += padding;
  const priceSpan = Math.max(maxPrice - minPrice, .01);
  const maxVolume = Math.max(...rows.map(row => Number(row.volume) || 0), 1);
  const xAt = index => margin.left + (rows.length === 1 ? plotWidth / 2 : index * plotWidth / (rows.length - 1));
  const yAt = price => margin.top + (maxPrice - price) / priceSpan * (priceBottom - margin.top);
  const volumeTop = priceBottom + 14;

  ctx.font = '11px "Microsoft YaHei", sans-serif';
  ctx.lineWidth = 1;
  for(let i = 0; i <= 4; i += 1){
    const y = margin.top + (priceBottom - margin.top) * i / 4;
    const value = maxPrice - priceSpan * i / 4;
    ctx.strokeStyle = '#e5e7eb';
    ctx.beginPath(); ctx.moveTo(margin.left, y); ctx.lineTo(width - margin.right, y); ctx.stroke();
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'right';
    ctx.fillText(value.toFixed(2), margin.left - 7, y + 4);
  }

  const isLine = period === 'minute' || period === 'five-day';
  if(period === 'minute' && validReference){
    const zeroY = yAt(validReference);
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = '#94a3b8';
    ctx.beginPath(); ctx.moveTo(margin.left, zeroY); ctx.lineTo(width - margin.right, zeroY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'right';
    ctx.fillText(`昨收 ${validReference.toFixed(2)} / 0.00%`, width - margin.right - 3, zeroY - 4);
    ctx.restore();
  }
  if(isLine){
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    rows.forEach((row, index) => {
      const x = xAt(index);
      const y = yAt(Number(row.close));
      index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
    if(period === 'minute'){
      let weightedPrice = 0;
      let totalVolume = 0;
      const averages = rows.map(row => {
        const rowVolume = Math.max(0, Number(row.volume) || 0);
        if(rowVolume > 0){
          weightedPrice += Number(row.close) * rowVolume;
          totalVolume += rowVolume;
        }
        return totalVolume > 0 ? weightedPrice / totalVolume : Number(row.close);
      });
      ctx.strokeStyle = '#d97706';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      averages.forEach((average, index) => index ? ctx.lineTo(xAt(index), yAt(average)) : ctx.moveTo(xAt(index), yAt(average)));
      ctx.stroke();
      ctx.fillStyle = '#2563eb';
      ctx.textAlign = 'left';
      ctx.fillText('价格', margin.left + 8, margin.top + 12);
      ctx.fillStyle = '#d97706';
      ctx.fillText('均价', margin.left + 40, margin.top + 12);
    }
  }else{
    const step = plotWidth / Math.max(rows.length, 1);
    const bodyWidth = Math.max(2, Math.min(8, step * .62));
    rows.forEach((row, index) => {
      const open = Number(row.open) || Number(row.close);
      const close = Number(row.close);
      const high = Number(row.high) || Math.max(open, close);
      const low = Number(row.low) || Math.min(open, close);
      const x = xAt(index);
      const color = close >= open ? '#dc2626' : '#16a34a';
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(x, yAt(high)); ctx.lineTo(x, yAt(low)); ctx.stroke();
      const top = Math.min(yAt(open), yAt(close));
      const bodyHeight = Math.max(1, Math.abs(yAt(open) - yAt(close)));
      ctx.fillRect(x - bodyWidth / 2, top, bodyWidth, bodyHeight);
    });

    const drawMa = (days, color) => {
      if(rows.length < days) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let started = false;
      rows.forEach((_, index) => {
        if(index < days - 1) return;
        const average = rows.slice(index - days + 1, index + 1).reduce((sum, row) => sum + Number(row.close), 0) / days;
        const x = xAt(index);
        const y = yAt(average);
        started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        started = true;
      });
      ctx.stroke();
    };
    drawMa(5, '#2563eb');
    drawMa(10, '#d97706');
    drawMa(20, '#7c3aed');
    drawMa(30, '#0891b2');
    drawMa(60, '#475569');
  }

  const barStep = plotWidth / Math.max(rows.length, 1);
  const barWidth = Math.max(1, Math.min(6, barStep * .65));
  rows.forEach((row, index) => {
    const open = Number(row.open) || Number(row.close);
    const close = Number(row.close);
    const barHeight = (Number(row.volume) || 0) / maxVolume * volumeHeight;
    ctx.fillStyle = close >= open ? 'rgba(220,38,38,.55)' : 'rgba(22,163,74,.55)';
    ctx.fillRect(xAt(index) - barWidth / 2, height - margin.bottom - barHeight, barWidth, barHeight);
  });
  ctx.strokeStyle = '#cbd5e1';
  ctx.beginPath(); ctx.moveTo(margin.left, volumeTop); ctx.lineTo(width - margin.right, volumeTop); ctx.stroke();

  const labelIndexes = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])];
  labelIndexes.forEach(index => {
    const raw = String(rows[index]?.time || rows[index]?.date || '');
    const label = raw.length >= 12 ? `${raw.slice(4,6)}-${raw.slice(6,8)} ${raw.slice(8,10)}:${raw.slice(10,12)}` : raw.slice(5);
    ctx.fillStyle = '#64748b';
    ctx.textAlign = index === 0 ? 'left' : index === rows.length - 1 ? 'right' : 'center';
    ctx.fillText(label, xAt(index), height - 7);
  });

  if(Number.isInteger(selectedIndex) && rows[selectedIndex]){
    const row = rows[selectedIndex];
    const open = Number(row.open) || Number(row.close);
    const close = Number(row.close);
    const high = Number(row.high) || Math.max(open, close);
    const low = Number(row.low) || Math.min(open, close);
    const closeChangePct = chartChangePct(rows, selectedIndex, period, validReference);
    const x = xAt(selectedIndex);
    const y = yAt(close);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, margin.top); ctx.lineTo(x, height - margin.bottom); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(margin.left, y); ctx.lineTo(width - margin.right, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#0f172a';
    ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();

    const infoWidth = Math.min(438, plotWidth - 12);
    const infoLeft = x > width * .58 ? margin.left + 6 : width - margin.right - infoWidth - 6;
    ctx.fillStyle = 'rgba(15,23,42,.94)';
    ctx.fillRect(infoLeft, margin.top + 4, infoWidth, 48);
    ctx.font = '11px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(`${formatChartDate(row)}   开 ${open.toFixed(2)}   高 ${high.toFixed(2)}   低 ${low.toFixed(2)}`, infoLeft + 9, margin.top + 22);
    ctx.fillStyle = close >= open ? '#fca5a5' : '#86efac';
    ctx.fillText(`收 ${close.toFixed(2)}   涨跌幅 ${formatPct(closeChangePct)}   成交量 ${formatChartVolume(row.volume)}`, infoLeft + 9, margin.top + 42);

    const priceLabel = close.toFixed(2);
    ctx.font = '10px "Microsoft YaHei", sans-serif';
    const priceWidth = Math.max(42, ctx.measureText(priceLabel).width + 10);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(margin.left - priceWidth, y - 9, priceWidth, 18);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(priceLabel, margin.left - priceWidth / 2, y + 4);
    ctx.restore();
  }
  canvas.dataset.rendered = 'true';
}

function chartIndexFromPointer(canvas, event){
  const state = canvas._stockChartState;
  if(!state?.rows?.length) return null;
  const rect = canvas.getBoundingClientRect();
  const logicalX = (event.clientX - rect.left) * state.width / Math.max(rect.width, 1);
  const ratio = Math.max(0, Math.min(1, (logicalX - state.marginLeft) / state.plotWidth));
  return Math.round(ratio * (state.rows.length - 1));
}

function selectStockChartPoint(canvas, index){
  const state = canvas._stockChartState;
  if(!state || !Number.isInteger(index) || !state.rows[index]) return;
  state.selectedIndex = index;
  const row = state.rows[index];
  canvas.dataset.selectedIndex = String(index);
  canvas.dataset.selectedDate = formatChartDate(row);
  canvas.dataset.selectedClose = String(row.close);
  const closeChangePct = chartChangePct(state.rows, index, state.period, state.referencePrice);
  canvas.dataset.selectedChangePct = closeChangePct == null ? '' : String(closeChangePct);
  canvas.title = `${formatChartDate(row)} 开 ${formatNumber(Number(row.open))} 高 ${formatNumber(Number(row.high))} 低 ${formatNumber(Number(row.low))} 收 ${formatNumber(Number(row.close))} 涨跌幅 ${formatPct(closeChangePct)} 成交量 ${formatChartVolume(row.volume)}`;
  renderStockChart(canvas, state.rows, state.period, index, state.referencePrice);
}

function clearStockChartPoint(canvas){
  const state = canvas._stockChartState;
  if(!state) return;
  state.selectedIndex = null;
  delete canvas.dataset.selectedIndex;
  delete canvas.dataset.selectedDate;
  delete canvas.dataset.selectedClose;
  delete canvas.dataset.selectedChangePct;
  canvas.title = '';
  renderStockChart(canvas, state.rows, state.period, null, state.referencePrice);
}

function bindStockChartInteraction(canvas){
  if(canvas.dataset.interactive === 'true') return;
  canvas.dataset.interactive = 'true';
  canvas.addEventListener('pointermove', event => {
    const state = canvas._stockChartState;
    if(!state || event.pointerType !== 'mouse' && !state.dragging) return;
    selectStockChartPoint(canvas, chartIndexFromPointer(canvas, event));
  });
  canvas.addEventListener('pointerdown', event => {
    const state = canvas._stockChartState;
    if(!state) return;
    const index = chartIndexFromPointer(canvas, event);
    const unlock = state.locked && state.selectedIndex === index;
    state.locked = !unlock;
    state.dragging = true;
    canvas.dataset.locked = String(state.locked);
    if(unlock) clearStockChartPoint(canvas);
    else selectStockChartPoint(canvas, index);
    if(event.pointerType !== 'mouse'){
      event.preventDefault();
      canvas.setPointerCapture?.(event.pointerId);
    }
  });
  canvas.addEventListener('pointerup', () => {
    if(canvas._stockChartState) canvas._stockChartState.dragging = false;
  });
  canvas.addEventListener('pointercancel', () => {
    if(canvas._stockChartState) canvas._stockChartState.dragging = false;
  });
  canvas.addEventListener('pointerleave', () => {
    const state = canvas._stockChartState;
    if(state && !state.locked) clearStockChartPoint(canvas);
  });
  canvas.addEventListener('keydown', event => {
    const state = canvas._stockChartState;
    if(!state || !['ArrowLeft','ArrowRight','Escape'].includes(event.key)) return;
    event.preventDefault();
    if(event.key === 'Escape'){
      state.locked = false;
      canvas.dataset.locked = 'false';
      clearStockChartPoint(canvas);
      return;
    }
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    const index = Math.max(0, Math.min(state.rows.length - 1, (state.selectedIndex ?? state.rows.length - 1) + direction));
    state.locked = true;
    canvas.dataset.locked = 'true';
    selectStockChartPoint(canvas, index);
  });
}

function drawStockChart(canvas, inputRows, period, referencePrice=null){
  if(!canvas) return;
  const rows = (inputRows || []).filter(row => Number.isFinite(Number(row.close)) && Number(row.close) > 0);
  if(!rows.length) return;
  const width = Math.max(520, Math.floor(canvas.getBoundingClientRect().width || 760));
  const validReference = Number(referencePrice) > 0 ? Number(referencePrice) : null;
  canvas._stockChartState = { rows, period, referencePrice:validReference, selectedIndex:null, locked:false, dragging:false, width, marginLeft:54, plotWidth:width - 68 };
  canvas.dataset.locked = 'false';
  canvas.dataset.hasAverageLine = String(period === 'minute');
  canvas.dataset.hasZeroLine = String(period === 'minute' && validReference != null);
  bindStockChartInteraction(canvas);
  renderStockChart(canvas, rows, period, null, validReference);
}

async function loadStockChart(s, period = 'day', force=false){
  activeChartPeriod.set(s.code, period);
  const canvas = document.querySelector(`[data-chart-for="${s.code}"]`);
  const meta = document.querySelector(`[data-chart-meta="${s.code}"]`);
  const legend = document.querySelector(`[data-chart-legend="${s.code}"]`);
  const refreshButton = document.querySelector(`[data-chart-refresh="${s.code}"]`);
  document.querySelectorAll(`[data-chart-period][data-chart-code="${s.code}"]`).forEach(button => button.classList.toggle('active', button.dataset.chartPeriod === period));
  if(legend) legend.innerHTML = chartLegendHtml(period);
  if(!canvas || !meta || !window.stockApi?.fetchStockChart) return;
  const cacheKey = `${s.code}-${period}`;
  if(!force && detailChartCache.has(cacheKey)){
    const result = detailChartCache.get(cacheKey);
    const referencePrice = result.previousClose ?? s.prevClose;
    drawStockChart(canvas, result.rows, period, referencePrice);
    const latestIndex = result.rows.length - 1;
    const closeSummary = period === 'minute' ? '' : ` · 收盘 ${yuan(Number(result.rows[latestIndex]?.close))} · 涨跌 ${formatPct(chartChangePct(result.rows, latestIndex, period, referencePrice))}`;
    meta.textContent = `${result.source || '行情接口'} · ${result.rows.length} 个数据点${period === 'day' || period === 'week' || period === 'month' ? ' · 均线 MA5 / MA10 / MA20 / MA30 / MA60' : ''}${closeSummary}`;
    return result;
  }
  if(detailRequestPending.has(`chart:${cacheKey}`)) return detailRequestPending.get(`chart:${cacheKey}`);
  delete canvas.dataset.rendered;
  meta.textContent = '正在加载走势数据...';
  if(refreshButton){
    refreshButton.disabled = true;
    refreshButton.textContent = '刷新中';
  }
  return withDetailPending(`chart:${cacheKey}`, async () => {
    try{
      let result = null;
      result = await window.stockApi.fetchStockChart({code:s.code, period, force});
      detailChartCache.set(cacheKey, result);
      if(activeChartPeriod.get(s.code) !== period || !canvas.isConnected) return result;
      const referencePrice = result.previousClose ?? s.prevClose;
      drawStockChart(canvas, result.rows, period, referencePrice);
      const latestIndex = result.rows.length - 1;
      const closeSummary = period === 'minute' ? '' : ` · 收盘 ${yuan(Number(result.rows[latestIndex]?.close))} · 涨跌 ${formatPct(chartChangePct(result.rows, latestIndex, period, referencePrice))}`;
      meta.textContent = `${result.source || '行情接口'} · ${result.rows.length} 个数据点${period === 'day' || period === 'week' || period === 'month' ? ' · 均线 MA5 / MA10 / MA20 / MA30 / MA60' : ''}${closeSummary}`;
      return result;
    }catch(err){
      meta.textContent = `走势加载失败：${err.message || err}`;
      addLog('error', `走势加载失败：${s.name} ${period} ${err.message || err}`);
      return null;
    }finally{
      if(refreshButton?.isConnected){
        refreshButton.disabled = false;
        refreshButton.textContent = '刷新';
      }
    }
  });
}

async function loadCompanyProfile(s, force=false){
  const box = document.querySelector(`[data-profile-for="${s.code}"]`);
  if(!box || !window.stockApi?.fetchCompanyProfile) return;
  if(!force && detailProfileCache.has(s.code)){
    const cached = detailProfileCache.get(s.code);
    renderCompanyProfile(s.code, cached, s);
    return cached;
  }
  return withDetailPending(`profile:${s.code}`, async () => {
    box.innerHTML = '<p><b>公司产业：</b>正在加载公司资料...</p>';
    try{
      const result = await window.stockApi.fetchCompanyProfile({code:s.code, name:s.name, sector:s.sector, force});
      detailProfileCache.set(s.code, result);
      renderCompanyProfile(s.code, result, s);
      (result?.errors || []).forEach(msg => addLog('error', msg));
      return result;
    }catch(err){
      renderCompanyProfile(s.code, {}, s);
      addLog('error', `公司资料加载失败：${s.name} ${err.message || err}`);
      return null;
    }
  });
}

function renderStockNews(code, result){
  const box = document.querySelector(`[data-news-for="${code}"]`);
  if(!box) return;
  const news = [...(result?.news || [])].sort((a, b) => {
    const timestamp = value => {
      const text = String(value || '').trim().replace(/^(\d{4}-\d{2}-\d{2})\s+/, '$1T');
      const parsed = Date.parse(text);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return timestamp(b.publishedAt) - timestamp(a.publishedAt);
  });
  if(!news.length){
    box.innerHTML = '<div class="note inline-note">暂未获取到最新资讯，稍后可重新打开详情刷新。</div>';
    return;
  }
  box.innerHTML = news.map(item => {
    const link = safeHttpUrl(item.link);
    if(!link) return '';
    return `<a class="news-row" href="${escapeHtml(link)}" data-news-link="${escapeHtml(link)}">
      <b>${escapeHtml(item.title)}</b>
      <span>${escapeHtml(item.source || '')}${item.publishedAt ? ` · ${escapeHtml(item.publishedAt)}` : ''}</span>
      ${item.summary ? `<em>${escapeHtml(item.summary)}</em>` : ''}
    </a>`;
  }).join('');
  box.querySelectorAll('[data-news-link]').forEach(a => {
    a.onclick = (e) => {
      e.preventDefault();
      window.stockApi?.openExternal?.(a.dataset.newsLink);
    };
  });
}

async function loadStockNews(s, force=false){
  const box = document.querySelector(`[data-news-for="${s.code}"]`);
  if(!box || !window.stockApi?.fetchStockNews) return;
  if(!force && detailNewsCache.has(s.code)){
    const cached = detailNewsCache.get(s.code);
    renderStockNews(s.code, cached);
    return cached;
  }
  return withDetailPending(`news:${s.code}`, async () => {
    box.innerHTML = '<div class="note inline-note">正在加载最新资讯...</div>';
    try{
      const result = await window.stockApi.fetchStockNews({code:s.code, name:s.name, force});
      detailNewsCache.set(s.code, result);
      renderStockNews(s.code, result);
      (result?.errors || []).forEach(msg => addLog('error', msg));
      return result;
    }catch(err){
      if(box.isConnected) box.innerHTML = `<div class="note inline-note">资讯加载失败：${escapeHtml(err.message || err)}</div>`;
      addLog('error', `资讯加载失败：${s.name} ${err.message || err}`);
      return null;
    }
  });
}

async function refreshStockDetail(s){
  const button = document.querySelector(`[data-detail-refresh="${s.code}"]`);
  if(!button || button.disabled) return;
  button.disabled = true;
  button.textContent = '刷新分析中';
  addLog('info', `开始刷新个股综合分析：${s.name} ${s.code}`);
  const period = activeChartPeriod.get(s.code) || 'day';
  try{
    const results = await Promise.allSettled([
      loadLatestDetailQuote(s),
      loadStockHistory(s, true)
    ]);
    const updated = findStockByCode(s.code) || s;
    const historyResult = detailHistoryCache.get(s.code)
      || (results[1].status === 'fulfilled' ? results[1].value : null);
    if(activeDetailCode === s.code && historyResult) renderHistoryAnalysis(updated, historyResult);
    const failed = results.filter(result => result.status === 'rejected' || !result.value).length;
    const partialErrors = results.flatMap(result => result.status === 'fulfilled' ? result.value?.errors || [] : []).length;
    void Promise.allSettled([
      loadStockFundFlow(updated, false),
      loadCompanyProfile(updated, false),
      loadStockChart(updated, period, false),
      loadStockNews(updated, false),
      latestMarketOverview || loadMarketOverview(false, true)
    ]);
    if(failed) notify(`个股综合分析部分刷新失败（${failed}项），已保留可用数据`, 'warn');
    else notify(partialErrors ? '个股综合分析已更新，部分数据源已自动切换' : '个股最新行情与技术分析已更新', partialErrors ? 'warn' : 'success');
    addLog(failed ? 'warn' : 'success', `个股综合分析刷新完成：${s.name}`, {failed, partialErrors, period});
  }catch(err){
    notify(`个股综合分析刷新失败：${err.message || err}`, 'error');
    addLog('error', `个股综合分析刷新失败：${s.name}`, {message:err.message || String(err)});
  }finally{
    if(button.isConnected){
      button.disabled = false;
      button.textContent = '刷新分析';
    }
  }
}

function renderDetailPanel(){
  const panel = $('detailPanel');
  if(!panel) return;
  const s = findStockByCode(activeDetailCode);
  if(!s){ panel.classList.add('hidden'); panel.innerHTML = ''; return; }
  panel.classList.remove('hidden');
  const initialIndustry = reliableIndustry(s.sector);
  const chartPeriod = activeChartPeriod.get(s.code) || 'day';
  const forceLatest = forceDetailRefreshCode === s.code;
  if(forceLatest) forceDetailRefreshCode = null;
  panel.innerHTML = `<div class="detail-head">
      <div><h2>${escapeHtml(s.name)} <span>${s.code}</span></h2><p data-detail-sector="${s.code}">${escapeHtml(initialIndustry)}</p></div>
      <div class="detail-head-actions"><button class="small detail-refresh" data-detail-refresh="${s.code}">刷新分析</button><button class="small" data-detail-add-label="${s.code}">添加到标签</button><button id="closeDetail" class="small">关闭</button></div>
    </div>
    <div class="detail-metrics">
      <div><b data-quote-price-for="${s.code}">${yuan(s.price)}</b><span>当前价</span></div>
      <div class="${pctClass(s.changePct)}"><b data-quote-changePct-for="${s.code}">${formatPct(s.changePct)}</b><span>涨跌幅</span></div>
      <div><b data-quote-change-for="${s.code}">${formatNumber(s.change)}</b><span>涨跌额</span></div>
      <div><b data-quote-open-for="${s.code}">${yuan(s.open)}</b><span>今开</span></div>
      <div><b data-quote-high-for="${s.code}">${yuan(s.high)}</b><span>最高</span></div>
      <div><b data-quote-low-for="${s.code}">${yuan(s.low)}</b><span>最低</span></div>
      <div><b data-quote-prevClose-for="${s.code}">${yuan(s.prevClose)}</b><span>昨收</span></div>
      <div><b data-quote-volume-for="${s.code}">${volume(s.volume)}</b><span>成交量</span></div>
      <div><b data-quote-amount-for="${s.code}">${money(s.amount)}</b><span>成交额</span></div>
      <div><b data-quote-turnoverRate-for="${s.code}">${metricValue(s.turnoverRate, value => `${formatNumber(value,2)}%`)}</b><span>换手率</span></div>
      <div><b data-quote-snapshotVolumeRatio-for="${s.code}">${metricValue(s.snapshotVolumeRatio, value => formatNumber(value,2))}</b><span>量比</span></div>
      <div><b data-quote-amplitude-for="${s.code}">${metricValue(s.amplitude, value => `${formatNumber(value,2)}%`)}</b><span>振幅</span></div>
      <div><b data-quote-peRatio-for="${s.code}">${metricValue(s.peRatio, value => formatNumber(value,2))}</b><span>动态 PE</span></div>
      <div><b data-quote-pbRatio-for="${s.code}">${metricValue(s.pbRatio, value => formatNumber(value,2))}</b><span>PB</span></div>
      <div><b data-quote-upperLimit-for="${s.code}">${metricValue(s.upperLimit, yuan)}</b><span>涨停价</span></div>
      <div><b data-quote-lowerLimit-for="${s.code}">${metricValue(s.lowerLimit, yuan)}</b><span>跌停价</span></div>
      <div><b data-fund-in-for="${s.code}">${metricValue(s.mainInflow, money)}</b><span>主力流入</span></div>
      <div><b data-fund-out-for="${s.code}">${metricValue(s.mainOutflow, money)}</b><span>主力流出</span></div>
      <div><b data-fund-net-for="${s.code}">${metricValue(s.mainNetInflow, money)}</b><span>主力净额</span></div>
      <div><b data-fund-pct-for="${s.code}">${metricValue(s.mainNetPct, formatPct)}</b><span>主力净占比</span></div>
      <div><b data-quote-totalMarketCap-for="${s.code}">${marketCapValue(s.totalMarketCap)}</b><span>总市值</span></div>
      <div><b data-quote-floatMarketCap-for="${s.code}">${metricValue(s.floatMarketCap, money)}</b><span>流通市值</span></div>
    </div>
    <div class="detail-tags">${stockTagsHtml(s)}</div>
    ${simulatedTradePanel(s)}
    <div class="detail-chart">
      <div class="chart-head"><div class="chart-title"><h3>个股走势</h3><button class="small chart-refresh" data-chart-refresh="${s.code}" title="重新加载当前周期走势" aria-label="刷新个股走势">刷新</button></div><div class="chart-tabs">
        ${[['minute','分时'],['five-day','五日'],['day','日K'],['week','周K'],['month','月K']].map(([key,label]) => `<button class="small ${chartPeriod === key ? 'active' : ''}" data-chart-period="${key}" data-chart-code="${s.code}">${label}</button>`).join('')}
      </div></div>
      <div class="chart-legend" data-chart-legend="${s.code}">${chartLegendHtml(chartPeriod)}</div>
      <canvas class="stock-chart" data-chart-for="${s.code}" aria-label="${escapeHtml(s.name)}走势图" tabindex="0"></canvas>
      <div class="chart-meta" data-chart-meta="${s.code}">正在加载走势数据...</div>
    </div>
    <div class="detail-text">
      <p data-analysis-for="${s.code}"><b>股票分析：</b>${escapeHtml(analysisText(s))}</p>
      <p data-industry-for="${s.code}"><b>行业 / 分类：</b>${escapeHtml(initialIndustry || '正在加载行业资料...')}</p>
      <div data-profile-for="${s.code}"><p><b>公司产业：</b>正在加载公司资料...</p></div>
      <p data-current-for="${s.code}"><b>当前情况：</b>${escapeHtml(s.news || '--')}</p>
      <p data-fund-source-for="${s.code}"><b>资金数据：</b>正在汇总主力流入/流出...</p>
      <p data-quote-source-for="${s.code}"><b>行情数据源：</b>${escapeHtml(s.source || '本地初始数据')}；<b>更新时间：</b>${s.fetchedAt ? escapeHtml(new Date(s.fetchedAt).toLocaleString('zh-CN', {hour12:false})) : '--'}</p>
    </div>
    <div class="detail-news" data-history-for="${s.code}"><div class="note inline-note">正在分析近3个月行情...</div></div>
    <div class="detail-news"><h3>最新资讯</h3><div data-news-for="${s.code}"></div></div>
    <div class="detail-sticky-actions"><button class="primary" data-detail-add-label="${s.code}">添加到标签</button></div>`;
  $('closeDetail').onclick = () => {
    activeDetailCode = null;
    if(currentViewSource === 'label'){
      stocks = [];
      currentViewSource = 'empty';
      renderStocks();
      return;
    }
    renderDetailPanel();
  };
  panel.querySelectorAll('[data-detail-refresh]').forEach(button => button.onclick = () => refreshStockDetail(s));
  panel.querySelectorAll('[data-detail-add-label]').forEach(button => button.onclick = () => openStockLabelPanel(s.code));
  panel.querySelectorAll('[data-sim-trade]').forEach(button => button.onclick = () => executeSimulatedTrade(button.dataset.simCode, button.dataset.simTrade));
  panel.querySelectorAll('[data-sim-sell-ratio]').forEach(button => button.onclick = () => {
    const position = portfolioPosition(button.dataset.simCode);
    const held = Math.max(0, Number(position?.quantity) || 0);
    const ratio = Number(button.dataset.simSellRatio);
    const quantity = ratio >= 1 ? held : Math.min(held, Math.max(100, Math.floor(held * ratio / 100) * 100));
    const input = panel.querySelector(`[data-sim-sell-quantity="${button.dataset.simCode}"]`);
    if(input) input.value = String(quantity);
  });
  panel.querySelectorAll('[data-chart-period]').forEach(button => button.onclick = () => loadStockChart(s, button.dataset.chartPeriod, false));
  panel.querySelectorAll('[data-chart-refresh]').forEach(button => button.onclick = () => loadStockChart(s, activeChartPeriod.get(s.code) || chartPeriod, true));
  loadCompanyProfile(s);
  loadStockHistory(s, false);
  loadStockNews(s, false);
  loadStockChart(s, chartPeriod, false);
  loadStockFundFlow(s, false);
  if(forceLatest) loadLatestDetailQuote(s);
}

function toggle(code){
  if(!code) return;
  selected.has(code) ? selected.delete(code) : selected.add(code);
  addLog('info', `${selected.has(code) ? '选中' : '取消选中'} ${code}`);
  renderStocks();
}
function refreshTime(extra=''){
  $('lastUpdated').textContent = `最后刷新：${nowText()}${extra ? '；' + extra : ''}`;
}

function parseQuoteResponse(response){
  if(Array.isArray(response)) return {quotes: response, errors: [], warnings: [], requested: response.length, updated: response.length, cached: 0, failed: 0};
  return {
    quotes: response?.quotes || [],
    errors: response?.errors || [],
    warnings: response?.warnings || [],
    requested: response?.requested || 0,
    updated: response?.updated ?? response?.quotes?.filter(q => !q.stale).length ?? 0,
    cached: response?.cached ?? response?.quotes?.filter(q => q.stale).length ?? 0,
    failed: response?.failed ?? 0
  };
}

function recordQuoteMessages(result){
  result.warnings.forEach(msg => addLog('warn', msg));
  result.errors.forEach(msg => addLog('error', msg));
}

function quoteResultMessage(prefix, result){
  const parts = [`实时更新 ${result.updated}/${result.requested} 只`];
  if(result.cached) parts.push(`缓存 ${result.cached} 只`);
  if(result.failed) parts.push(`失败 ${result.failed} 只`);
  return `${prefix}：${parts.join('，')}`;
}

function quoteResultType(result){
  if(!result.updated) return 'error';
  return result.cached || result.failed ? 'warn' : 'success';
}

function applyQuoteData(quotes){
  const map = new Map(quotes.map(q => [q.code, q]));
  const mergeStockQuote = (s) => {
    const q = map.get(s.code);
    if(!q || q.price == null) return s;
    const merged = {
      ...s,
      name: q.name || s.name,
      price: q.price,
      changePct: q.changePct ?? s.changePct,
      change: q.change ?? s.change,
      volume: q.volume ?? s.volume,
      amount: q.amount ?? s.amount,
      high: q.high ?? s.high,
      low: q.low ?? s.low,
      open: q.open ?? s.open,
      prevClose: q.prevClose ?? s.prevClose,
      amplitude: q.amplitude ?? s.amplitude,
      turnoverRate: q.turnoverRate ?? s.turnoverRate,
      peRatio: q.peRatio ?? s.peRatio,
      snapshotVolumeRatio: q.snapshotVolumeRatio ?? s.snapshotVolumeRatio,
      pbRatio: q.pbRatio ?? s.pbRatio,
      upperLimit: q.upperLimit ?? s.upperLimit,
      lowerLimit: q.lowerLimit ?? s.lowerLimit,
      totalMarketCap: q.totalMarketCap ?? s.totalMarketCap,
      floatMarketCap: q.floatMarketCap ?? s.floatMarketCap,
      mainNetInflow: q.mainNetInflow ?? s.mainNetInflow,
      mainNetPct: q.mainNetPct ?? s.mainNetPct,
      source: q.source || s.source,
      fetchedAt: q.fetchedAt || s.fetchedAt,
      stale: Boolean(q.stale),
      news: q.stale
        ? `实时接口未返回数据，当前显示缓存行情（${q.fetchedAt ? new Date(q.fetchedAt).toLocaleString('zh-CN', {hour12:false}) : '时间未知'}）。`
        : `实际行情已刷新：${formatPct(q.changePct)}，成交额${money(q.amount)}，主力净流入${metricValue(q.mainNetInflow, money)}。`
    };
    return {...merged, status: updateStatusByQuote(merged)};
  };
  stocks = stocks.map(mergeStockQuote);
  labels = labels.map(label => ({...label, stocks: label.stocks.map(stock => {
    const updated = mergeStockQuote(stock);
    return updated.favoriteBasePrice == null && Number(updated.price) > 0
      ? {...updated, favoriteBasePrice:Number(updated.price), favoriteAddedAt:updated.favoriteAddedAt || new Date().toISOString()}
      : updated;
  })}));
  portfolio = portfolio.map(position => {
    const q = map.get(position.code);
    if(!q || q.price == null) return position;
    const snapshot = mergeStockQuote({...portfolioStock(position), ...position.stock});
    return {
      ...position,
      name:q.name || position.name,
      lastPrice:q.price,
      changePct:q.changePct ?? position.changePct,
      source:q.source || position.source,
      fetchedAt:q.fetchedAt || position.fetchedAt,
      stock:snapshot
    };
  });
}

async function refreshMarket(){
  if(isRefreshing) return;
  const codes = [...new Set([...stocks, ...labels.flatMap(label => label.stocks || []), ...portfolio.filter(position => Number(position.quantity) > 0)].map(s => s.code))];
  if(!codes.length){
    notify('当前没有股票可刷新', 'warn');
    return;
  }
  isRefreshing = true;
  $('refreshAll').textContent = '刷新中...';
  $('refreshLabel').textContent = '刷新中';
  notify(`开始刷新主显示区和全部标签，共 ${codes.length} 只`, 'info');
  try{
    if(!window.stockApi?.fetchQuotes){
      throw new Error('行情接口未加载。请通过 npm start 启动 Electron 应用，不要直接用浏览器打开 index.html。');
    }
    const result = parseQuoteResponse(await window.stockApi.fetchQuotes(codes));
    const quotes = result.quotes;
    recordQuoteMessages(result);
    if(!quotes.length){
      refreshTime('本次未获取到新行情，已保留当前数据');
      notify(`刷新失败：未获取到新行情${result.errors.length ? '，请查看日志' : ''}`, 'error');
      saveState();
      return;
    }
    applyQuoteData(quotes);
    saveState();
    refreshSecondaryData(codes);
    refreshTime(`多源行情：实时 ${result.updated} 只，缓存 ${result.cached} 只`);
    notify(quoteResultMessage('全量刷新完成', result), quoteResultType(result));
  }catch(err){
    console.error(err);
    refreshTime('行情刷新失败，请检查网络或稍后重试');
    notify(`刷新失败：${err.message || err}`, 'error');
  }finally{
    isRefreshing = false;
    $('refreshAll').textContent = '刷新实际行情';
    $('refreshLabel').textContent = '刷新';
    renderStocks();
  }
}

async function refreshActiveLabel(){
  if(isRefreshing) return;
  const label = labels.find(x => x.name === activeLabel);
  const codes = [...new Set(label?.stocks.map(s => s.code) || [])];
  if(!codes.length){
    notify('当前标签没有股票可刷新', 'warn');
    return;
  }
  isRefreshing = true;
  $('refreshLabel').textContent = '刷新中';
  notify(`开始刷新标签「${label.name}」，共 ${codes.length} 只`, 'info');
  try{
    if(!window.stockApi?.fetchQuotes){
      throw new Error('行情接口未加载。请通过 npm start 启动 Electron 应用。');
    }
    const result = parseQuoteResponse(await window.stockApi.fetchQuotes(codes));
    recordQuoteMessages(result);
    if(!result.quotes.length){
      refreshTime(`标签「${label.name}」刷新失败`);
      notify(`标签「${label.name}」刷新失败：未获取到新行情`, 'error');
      saveState();
      return;
    }
    applyQuoteData(result.quotes);
    saveState();
    refreshSecondaryData(codes);
    refreshTime(`标签「${label.name}」实时更新 ${result.updated} 只`);
    notify(quoteResultMessage(`标签「${label.name}」刷新完成`, result), quoteResultType(result));
  }catch(err){
    console.error(err);
    refreshTime(`标签「${label.name}」刷新失败`);
    notify(`标签「${label.name}」刷新失败：${err.message || err}`, 'error');
  }finally{
    isRefreshing = false;
    $('refreshLabel').textContent = '刷新';
    renderStocks();
  }
}

async function refreshCodes(codes){
  try{
    if(!window.stockApi?.fetchQuotes) return;
    const result = parseQuoteResponse(await window.stockApi.fetchQuotes(codes));
    const quotes = result.quotes;
    recordQuoteMessages(result);
    if(!quotes.length) return;
    applyQuoteData(quotes);
    saveState();
    refreshSecondaryData(codes);
    notify(quoteResultMessage('新增股票行情刷新完成', result), quoteResultType(result));
    renderStocks();
  }catch(err){
    console.warn('单只股票行情刷新失败，已保留占位数据', err);
    notify(`新增股票行情刷新失败：${err.message || err}`, 'warn');
  }
}

async function generateStockPool(){
  const command = $('commandInput').value.trim();
  if(!command){
    notify('生成/更新股票池失败：命令为空', 'error');
    return;
  }
  $('searchInput').value = '';
  clearTimeout(searchTimer);
  searchSeq++;
  stocks = [];
  currentViewSource = 'empty';
  selected.clear();
  activeDetailCode = null;
  onlineSearchResults = [];
  searchStatus = '';
  renderStocks();
  addLog('action', '执行生成股票池', { command });
  notify('开始按通用行业脚本查找股票：解析命令 -> 多源搜索 -> 行业兜底 -> 分类生成', 'info');
  try{
    if(!window.stockApi?.runIndustryWorkflow){
      throw new Error('通用行业查找接口未加载。请通过 npm start 启动 Electron 应用。');
    }
    const response = await window.stockApi.runIndustryWorkflow(command);
    (response?.errors || []).forEach(msg => addLog('error', msg));
    const generatedStocks = (response?.stocks || []).map(s => ({
      ...s,
      name: cleanDisplayName(s.name),
      reason: s.reason || '所属产业链 + 行情表现 + 关注理由待确认。',
      news: s.news || '等待刷新实际行情。'
    })).filter(s => /^\d{6}$/.test(String(s.code || '')) && s.name);
    if(!generatedStocks.length){
      notify('生成/更新股票池失败：本次流程没有找到股票，主显示区已清空', 'error');
      return;
    }
    stocks = generatedStocks;
    currentViewSource = 'generated';
    if($('tagName')) $('tagName').value = response?.subject || labelNameFromCommand(command);
    selected.clear();
    activeDetailCode = null;
    onlineSearchResults = [];
    searchStatus = '';
    renderStocks();
    refreshTime(`命令查找完成，生成 ${generatedStocks.length} 只`);
    notify(`生成/更新股票池完成：已清空旧主列表，显示本次生成的 ${generatedStocks.length} 只股票；未自动保存为标签`, generatedStocks.length ? 'success' : 'warn');
    if(generatedStocks.length) await refreshCodes(generatedStocks.map(s => s.code));
  }catch(err){
    notify(`生成/更新股票池失败：${err.message || err}`, 'error');
  }
}

async function runOnlineSearch(seq, keyword){
  if(!window.stockApi?.searchStocks || keyword.length < 2){
    if(seq === searchSeq){
      onlineSearchResults = [];
      renderStocks();
    }
    return;
  }
  try{
    addLog('action', '执行线上搜索股票', { keyword });
    stocks = [];
    currentViewSource = 'empty';
    selected.clear();
    activeDetailCode = null;
    onlineSearchResults = [];
    searchStatus = `正在搜索「${keyword}」...`;
    renderStocks();
    const response = await window.stockApi.searchStocks(keyword);
    if(seq !== searchSeq) return;
    const results = Array.isArray(response) ? response : (response?.results || []);
    (response?.errors || []).forEach(msg => addLog('error', msg));
    const cleaned = results.map(item => ({...item, name: cleanDisplayName(item.name)})).filter(item => item.name && /^\d{6}$/.test(String(item.code || '')));
    stocks = cleaned.map(defaultStockFromSearch);
    currentViewSource = cleaned.length ? 'search' : 'empty';
    onlineSearchResults = [];
    searchStatus = cleaned.length ? '' : `未找到「${keyword}」的线上结果`;
    if(cleaned.length){
      notify(`线上搜索完成：${keyword}，找到 ${cleaned.length} 个结果${response?.source ? `（${response.source}）` : ''}`, 'success');
      refreshCodes(stocks.map(s => s.code));
    }else{
      notify(`线上搜索无结果：${keyword}${response?.errors?.length ? '，请查看日志；可能是网络接口不可用' : ''}`, 'warn');
    }
  }catch(err){
    if(seq !== searchSeq) return;
    onlineSearchResults = [];
    searchStatus = `线上搜索失败：${err.message || err}`;
    notify(`线上搜索失败：${err.message || err}`, 'error');
  }
  renderStocks();
}

function handleSearchInput(){
  const keyword = $('searchInput').value.trim();
  clearTimeout(searchTimer);
  const seq = ++searchSeq;
  if(keyword.length < 2){
    onlineSearchResults = [];
    searchStatus = '';
    renderStocks();
    return;
  }
  stocks = [];
  currentViewSource = 'empty';
  selected.clear();
  activeDetailCode = null;
  onlineSearchResults = [];
  searchStatus = `准备搜索「${keyword}」...`;
  renderStocks();
  searchTimer = setTimeout(() => runOnlineSearch(seq, keyword), 350);
}

function toggleFilteredSelection(){
  const fs = filteredStocks();
  if(!fs.length) return;
  const allSelected = fs.every(s => selected.has(s.code));
  fs.forEach(s => allSelected ? selected.delete(s.code) : selected.add(s.code));
  renderStocks();
}
function toggleActiveLabelSelection(){
  const l = labels.find(x => x.name === activeLabel);
  const list = l?.stocks || [];
  if(!list.length) return;
  const allSelected = list.every(s => selected.has(s.code));
  list.forEach(s => allSelected ? selected.delete(s.code) : selected.add(s.code));
  renderStocks();
}

$('refreshAll').onclick = refreshMarket;
$('backToTop').onclick = () => {
  window.scrollTo(0, 0);
  document.querySelectorAll('.market,.right').forEach(panel => { panel.scrollTop = 0; });
};
$('refreshLabel').onclick = refreshActiveLabel;
$('refreshMarketOverview').onclick = () => loadMarketOverview(true);
$('liveNewsView').onclick = openLiveNewsView;
$('generateBtn').onclick = generateStockPool;
$('searchInput').oninput = handleSearchInput;
if($('selectAll')) $('selectAll').onclick = toggleFilteredSelection;
$('openAddPanel').onclick = () => { closeStockLabelPanel(); $('addPanel').classList.remove('hidden'); renderAddStockList(); };
$('closeAddPanel').onclick = () => $('addPanel').classList.add('hidden');
$('closeStockLabelPanel').onclick = closeStockLabelPanel;
$('saveStockLabels').onclick = saveStockLabels;
$('addMarketRecommendations').onclick = openMarketLabelPanel;
$('closeMarketLabelPanel').onclick = closeMarketLabelPanel;
$('toggleMarketStocks').onclick = () => {
  const choices = [...document.querySelectorAll('[data-market-stock-choice]')];
  const selectAll = !choices.length || !choices.every(choice => choice.checked);
  choices.forEach(choice => { choice.checked = selectAll; });
  updateMarketStockToggleText();
};
$('saveMarketRecommendations').onclick = saveMarketRecommendations;
$('pinLabelStock').onclick = togglePinnedLabelStock;
$('removeLabelStock').onclick = removeContextLabelStock;
$('stockLabelPanel').onclick = event => {
  if(event.target === event.currentTarget) closeStockLabelPanel();
};
$('marketLabelPanel').onclick = event => {
  if(event.target === event.currentTarget) closeMarketLabelPanel();
};
$('liveNewsModal').onclick = event => {
  if(event.target === event.currentTarget) closeLiveNewsModal();
};
$('closeLiveNewsModal').onclick = closeLiveNewsModal;
$('openLiveNewsOriginal').onclick = event => {
  const link = event.currentTarget.dataset.liveNewsLink;
  if(link) window.stockApi?.openExternal?.(link);
};
$('modalSelectAll').onclick = toggleFilteredSelection;
$('confirmAdd').onclick = () => {
  const name = $('tagName').value.trim();
  const picked = stocks.filter(s => selected.has(s.code));
  if(!name || picked.length === 0){
    notify('添加到关注失败：请先选择股票并填写标签名称', 'error');
    return;
  }
  const existing = labels.find(l => l.name === name);
  if(existing){
    const map = new Map(existing.stocks.map(s => [s.code, s]));
    picked.forEach(s => {
      const previous = map.get(s.code);
      map.set(s.code, labelStockSnapshot(s, previous));
    });
    existing.stocks = [...map.values()];
  }else{
    labels.push({name, stocks:picked.map(stock => labelStockSnapshot(stock))});
  }
  notify(`已将 ${picked.length} 只股票增量添加到标签「${name}」`, 'success');
  activeLabel = name; selected.clear(); $('addPanel').classList.add('hidden'); saveState(); renderStocks(); $('searchInput').focus();
};
$('cardView').onclick = () => { view='card'; renderStocks(); };
$('tableView').onclick = () => { view='table'; renderStocks(); };
$('simulationView').onclick = openSimulationPortfolio;
$('editLabelStocks').onclick = () => labelEditMode ? finishLabelEditing() : startLabelEditing();
$('labelScoreSort').onchange = event => updateLabelSort('score', event.target.value);
$('labelChangeSort').onchange = event => updateLabelSort('changePct', event.target.value);
$('labelPriceSort').onchange = event => updateLabelSort('price', event.target.value);
$('selectLabelAll').onclick = toggleActiveLabelSelection;
$('deleteSelectedFromLabel').onclick = () => {
  const l = labels.find(x => x.name === activeLabel);
  const hasSelectedInLabel = (l?.stocks || []).some(s => selected.has(s.code));
  if(!labelEditMode || !hasSelectedInLabel) return;
  labels = labels.map(l => l.name === activeLabel ? {...l, stocks:l.stocks.filter(s => !selected.has(s.code))} : l);
  selected.clear();
  notify(`已从标签「${activeLabel}」删除选中股票`, 'success');
  saveState();
  renderStocks();
};
if($('clearLogs')){
  $('clearLogs').onclick = () => {
    logs = [];
    renderLogs();
    const box = $('statusNotice');
    if(box){
      box.textContent = '操作日志已清空';
      box.className = 'status-notice info';
      clearTimeout(notify.timer);
      notify.timer = setTimeout(() => box.classList.add('hidden'), 3000);
    }
  };
}

document.addEventListener('click', (event) => {
  if(!event.target.closest('#labelStockMenu')) closeLabelStockMenu();
  const target = event.target.closest('button,input,textarea,.stock-card,.label-item,tr[data-detail-code]');
  if(!target) return;
  addLog('action', '点击界面', describeClickTarget(target));
}, true);
document.addEventListener('keydown', event => {
  if(event.key !== 'Escape') return;
  closeLabelStockMenu();
  if(!$('stockLabelPanel')?.classList.contains('hidden')) closeStockLabelPanel();
  if(!$('marketLabelPanel')?.classList.contains('hidden')) closeMarketLabelPanel();
  if(!$('liveNewsModal')?.classList.contains('hidden')) closeLiveNewsModal();
});
window.addEventListener('scroll', closeLabelStockMenu, true);

refreshTime('等待刷新实际行情');
const restored = loadState();
addLog('info', restored ? '应用已启动，已加载上次保存的标签；主显示区保持为空' : '应用已启动；主显示区为空');
renderStocks();
loadMarketOverview();
setInterval(() => loadMarketOverview(), 60 * 1000);
