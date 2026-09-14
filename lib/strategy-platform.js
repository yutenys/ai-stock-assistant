const crypto = require('node:crypto');

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function createDataEnvelope({value = null, source = '', observedAt = null, tradeDate = '', partial = false, stale = false, missing = [], errors = []} = {}) {
  const status = value === null || value === undefined ? 'missing'
    : partial && stale ? 'partial-stale'
      : partial ? 'partial' : stale ? 'stale' : 'fresh';
  return {value, source, observedAt, tradeDate, status, partial:Boolean(partial), stale:Boolean(stale), missing:[...missing], errors:[...errors]};
}

function percentile(values, value) {
  const valid = values.map(number).filter(item => item !== null).sort((a, b) => a - b);
  const target = number(value);
  if (valid.length < 2 || target === null) return null;
  if (valid[0] === valid.at(-1)) return 50;
  const below = valid.filter(item => item < target).length;
  const equal = valid.filter(item => item === target).length;
  const rank = below + (Math.max(1, equal) + 1) / 2;
  return clamp(((rank - 1) / (valid.length - 1)) * 100);
}

function mean(values) {
  const valid = values.map(number).filter(item => item !== null);
  return valid.length ? valid.reduce((sum, item) => sum + item, 0) / valid.length : null;
}

function movingAverage(history, days) {
  return mean(history.slice(-days).map(item => item.close));
}

function periodReturn(history, days) {
  if (history.length <= days) return null;
  const base = number(history.at(-(days + 1))?.close);
  const close = number(history.at(-1)?.close);
  return base > 0 && close !== null ? (close / base - 1) * 100 : null;
}

function factorBase(row) {
  const history = Array.isArray(row.history) ? row.history.filter(item => number(item?.close) !== null) : [];
  const close = number(history.at(-1)?.close ?? row.close ?? row.price);
  const recent20 = history.slice(-20);
  const previous20 = history.slice(-21, -1);
  const high20 = recent20.length ? Math.max(...recent20.map(item => Number(item.close))) : null;
  const previousHigh20 = previous20.length ? Math.max(...previous20.map(item => Number(item.close))) : null;
  const low20 = recent20.length ? Math.min(...recent20.map(item => Number(item.close))) : null;
  const averageVolume20 = mean(recent20.slice(0, -1).map(item => item.volume));
  const currentVolume = number(recent20.at(-1)?.volume);
  const changes = recent20.slice(1).map((item, index) => {
    const previous = number(recent20[index]?.close);
    return previous > 0 ? (Number(item.close) / previous - 1) * 100 : null;
  }).filter(item => item !== null);
  const changeMean = mean(changes) || 0;
  const volatility20 = changes.length ? Math.sqrt(mean(changes.map(item => (item - changeMean) ** 2))) : null;
  return {
    code:String(row.code || '').slice(-6), close, high20, previousHigh20, low20,
    ma20:movingAverage(history, 20), ma30:movingAverage(history, 30),
    volumeRatio:averageVolume20 > 0 && currentVolume !== null ? currentVolume / averageVolume20 : null,
    drawdown20:high20 > 0 && close !== null ? (close / high20 - 1) * 100 : null,
    volatility20,
    returns:{d20:periodReturn(history, 20), d60:periodReturn(history, 60), d120:periodReturn(history, 120), d250:periodReturn(history, 250)},
    dataCoverage:{history:Math.min(1, history.length / 250), bars:history.length},
    source:row.source || '', history
  };
}

function buildFactorSnapshot(rows = [], {analysisId = '', tradeDate = '', universeSize = rows.length, complete = false} = {}) {
  const factors = rows.map(row => row?.factor ? {...row.factor} : factorBase(row)).filter(item => item.code && item.close !== null);
  const fullMarket = complete && factors.length === Number(universeSize) && factors.length >= 2;
  for (const days of [20, 60, 120, 250]) {
    const values = factors.map(item => item.returns[`d${days}`]);
    for (const item of factors) item[`rps${days}`] = percentile(values, item.returns[`d${days}`]);
  }
  for (const item of factors) item.rpsScope = fullMarket ? 'full-market' : factors.length >= 2 ? 'sample' : 'unavailable';
  return {analysisId, tradeDate, universeSize:Number(universeSize) || 0, evaluated:factors.length, complete:fullMarket, factors};
}

function result(id, matched, score, stage, horizon, reasons, evidenceIds) {
  return {id, matched:Boolean(matched), score:clamp(score), stage, horizon, reasons:reasons.filter(Boolean), evidenceIds:evidenceIds.filter(Boolean)};
}

function evaluateStrategyRegistry(factor, context = {}) {
  const rps20 = number(factor?.rps20);
  const rps60 = number(factor?.rps60);
  const rps120 = number(factor?.rps120);
  const volumeRatio = number(factor?.volumeRatio);
  const nearHigh = factor?.high20 > 0 && factor?.close >= factor.high20 * .98;
  const confirmedBreakout = factor?.previousHigh20 > 0 && factor?.close > factor.previousHigh20
    && context.observationPhase?.phase === 'closed';
  const volumeControlled = volumeRatio !== null && volumeRatio >= 1.5 && volumeRatio <= 4;
  const trend = factor?.close >= factor?.ma20 && factor?.ma20 >= factor?.ma30;
  const stableBox = number(factor?.drawdown20) >= -5 && number(factor?.volatility20) !== null && factor.volatility20 <= 3;
  const rotation = context.sectorRotation || {};
  const quality = number(context.qualityScore);
  return [
    result('trend-breakout', confirmedBreakout && volumeControlled && trend && rps20 >= 80,
      55 + (rps20 || 0) * .25 + (rps60 || 0) * .1, '突破确认', '短线', ['收盘突破此前20日高点', '量比处于1.5至4倍', '均线趋势向上'], ['price-20d','volume-20d','ma-20-30']),
    result('consolidation-breakout', stableBox && nearHigh && volumeRatio >= 1 && volumeRatio <= 4 && rps20 >= 70,
      48 + (rps20 || 0) * .3 + (rotation.score || 0) * .08, '接近突破', '波段', ['20日波动收敛', '价格接近箱体上沿'], ['box-20d','price-20d']),
    result('first-pullback', trend && factor?.close <= factor?.high20 * .97 && factor?.close >= factor?.ma20 * .98 && rps60 >= 75,
      48 + (rps60 || 0) * .35, '首次回踩', '波段', ['趋势保持', '回踩20日均线附近'], ['ma-20','rps-60']),
    result('rebound', factor?.close >= factor?.ma20 && number(factor?.returns?.d60) < -8 && number(factor?.returns?.d20) > 3,
      55 + Math.max(0, number(factor?.returns?.d20) || 0), '反弹确认', '短线', ['中期超跌后站回20日均线'], ['return-20-60','ma-20']),
    result('sector-rotation', rotation.confirmed && rotation.score >= 65 && trend,
      50 + Number(rotation.score || 0) * .35 + (rps20 || 0) * .1, '板块轮动', '短线', ['板块资金与广度确认', '个股趋势未破坏'], ['sector-capital','sector-breadth','ma-20']),
    result('growth-quality', quality >= 70 && trend && rps120 >= 60,
      45 + quality * .35 + (rps120 || 0) * .15, '质量成长', '中长线', ['财务质量达标', '中长期相对强度达标'], ['financial-quality','rps-120']),
    result('high-tight-flag-shadow', stableBox && rps20 >= 75,
      40 + (rps20 || 0) * .3, '影子观察', '波段', ['高位窄幅整理，仅作影子记录'], ['box-20d','rps-20'])
  ];
}

function arbitrateStrategyResults(evaluations = [], {hardRisk = false, hardRiskReason = '', marketRisk = false} = {}) {
  const matches = evaluations.filter(item => item.matched).sort((a, b) => b.score - a.score);
  if (hardRisk) return {status:'rejected', primaryStrategyId:null, stage:'风险排除', score:0, reason:hardRiskReason || '存在硬风险', matches};
  if (!matches.length) return {status:'excluded', primaryStrategyId:null, stage:'未通过', score:null, reason:'没有策略通过当前条件', matches};
  const primary = matches[0];
  const status = primary.score >= 75 && !marketRisk ? 'strict' : 'watch';
  return {status, primaryStrategyId:primary.id, stage:primary.stage, horizon:primary.horizon, score:primary.score,
    reason:primary.reasons.join('；'), matches};
}

function buildAnalysisViewModel(item = {}, {decision = null, evaluations = [], view = 'recommendation'} = {}) {
  const analysisId = item.analysisId || item.scoreCard?.snapshotId || '';
  const analysis = {
    analysisId,
    scoreCard:item.scoreCard || null,
    decision:decision ? JSON.parse(JSON.stringify(decision)) : null,
    strategies:JSON.parse(JSON.stringify(evaluations)),
    dataState:item.dataState || null,
    evidence:item.evidence || []
  };
  return {analysisId, code:item.code, name:item.name, view, analysis};
}

function eventId(item) {
  return crypto.createHash('sha256').update([item.title, item.link, item.publishedAt].join('|')).digest('hex').slice(0, 20);
}

function mergeEventLifecycle(existing = [], incoming = [], seenAt = new Date().toISOString()) {
  const byId = new Map(existing.map(item => [item.eventId || eventId(item), {...item}]));
  for (const item of incoming) {
    const id = eventId(item);
    const previous = byId.get(id);
    byId.set(id, {...item, eventId:id, firstSeenAt:previous?.firstSeenAt || seenAt, lastSeenAt:seenAt});
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.publishedAt || b.firstSeenAt) - Date.parse(a.publishedAt || a.firstSeenAt));
}

module.exports = {createDataEnvelope, percentile, buildFactorSnapshot, evaluateStrategyRegistry, arbitrateStrategyResults, buildAnalysisViewModel, mergeEventLifecycle};
