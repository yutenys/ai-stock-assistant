function finite(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function average(values) {
  const rows = values.map(finite).filter(value => value !== null);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}

function pct(from, to) {
  return from > 0 && to > 0 ? (to / from - 1) * 100 : null;
}

function ema(values, period) {
  const alpha = 2 / (period + 1);
  return values.reduce((rows, value, index) => {
    rows.push(index ? rows[index - 1] + alpha * (value - rows[index - 1]) : value);
    return rows;
  }, []);
}

function round(value, digits = 2) {
  return finite(value) === null ? null : Number(Number(value).toFixed(digits));
}

function evaluateShortRebound({ bars = [], quote = {}, analysis = {}, observationPhase = {}, observedAt = '' } = {}) {
  const rows = bars.filter(row => row && [row.open, row.high, row.low, row.close, row.volume].every(value => finite(value) !== null)).slice(-80);
  if (rows.length < 60) return {matched:false,state:'invalid',reasonCode:'history-insufficient',missingEvidence:['至少60根有效日线']};
  const latest = rows.at(-1);
  const closes = rows.map(row => row.close);
  const volumes = rows.map(row => row.volume);
  const ma = days => average(closes.slice(-days));
  const ma5 = ma(5), ma20 = ma(20), ma30 = ma(30), ma60 = ma(60);
  const recent20 = rows.slice(-20);
  const recent10 = rows.slice(-10);
  const prior3High = Math.max(...rows.slice(-4, -1).map(row => row.high));
  const high20 = Math.max(...recent20.map(row => row.high));
  const low20 = Math.min(...recent20.map(row => row.low));
  const high10 = Math.max(...recent10.map(row => row.high));
  const low10 = Math.min(...recent10.map(row => row.low));
  const drawdown20 = pct(high20, latest.close);
  const pullback10 = pct(high10, latest.close);
  const return5 = pct(rows.at(-6)?.close, latest.close);
  const volume20 = average(volumes.slice(-21, -1));
  const volumeRatio = observationPhase.phase === 'intraday' ? null : volume20 ? latest.volume / volume20 : null;
  const volume5Ratio = volume20 ? average(volumes.slice(-5)) / volume20 : null;
  const ema12 = ema(closes, 12), ema26 = ema(closes, 26);
  const dif = closes.map((_value, index) => ema12[index] - ema26[index]);
  const dea = ema(dif, 9);
  const histogram = dif.map((value, index) => (value - dea[index]) * 2);
  const macdImproving = histogram.at(-1) > histogram.at(-4);
  const last3Lows = rows.slice(-3).map(row => row.low);
  const lowStabilizing = Math.min(...last3Lows.slice(1)) >= last3Lows[0] * .985
    && latest.close >= rows.at(-2).close;
  const reclaimShort = latest.close >= ma5 || latest.close >= prior3High;
  const profile = (quote.rotationProfiles || []).find(item => item && item.name) || null;
  const sectorUpRatio = finite(profile?.upRatio ?? profile?.participation?.upRatio);
  const sectorFlow = finite(profile?.mainNetInflow);
  const relativePositive = finite(quote.changePct) !== null && finite(profile?.averageChangePct) !== null
    && Number(quote.changePct) > Number(profile.averageChangePct);

  const routes = [];
  const r1Evidence = [drawdown20 <= -8, lowStabilizing, reclaimShort, macdImproving, latest.close >= low20 * 1.025];
  if (r1Evidence.every(Boolean)) routes.push({
    id:'R1', name:'超跌首修复', score:r1Evidence.filter(Boolean).length * 12,
    evidence:[`20日高点回撤${Math.abs(drawdown20).toFixed(1)}%`, lowStabilizing && '近3日低点停止下移', reclaimShort && '重新站上短均线或前三日高点', macdImproving && 'MACD绿柱收敛'].filter(Boolean),
    missing:[!lowStabilizing && '低点尚未稳定', !reclaimShort && '尚未收复短线触发位', !macdImproving && 'MACD未改善'].filter(Boolean)
  });
  const trendIntact = ma20 >= ma30 * .99 && ma30 >= ma60 * .99;
  const shrinkingPullback = pullback10 <= -2 && pullback10 >= -15 && volume5Ratio !== null && volume5Ratio <= 1.05;
  const supportHeld = latest.close >= Math.min(ma20, ma30) * .97;
  const r2Evidence = [trendIntact, shrinkingPullback, supportHeld, reclaimShort];
  if (r2Evidence.filter(Boolean).length >= 3) routes.push({
    id:'R2', name:'强趋势回踩修复', score:r2Evidence.filter(Boolean).length * 15,
    evidence:[trendIntact && 'MA20/30/60趋势结构未破坏', shrinkingPullback && `10日回撤${Math.abs(pullback10).toFixed(1)}%且近5日缩量`, supportHeld && '中期均线支撑仍有效', reclaimShort && '短线重新转强'].filter(Boolean),
    missing:[!shrinkingPullback && '回踩缩量证据不足', !reclaimShort && '尚未收复短线触发位'].filter(Boolean)
  });
  const themeBroad = sectorUpRatio !== null && sectorUpRatio >= .55;
  const themeFunded = sectorFlow !== null && sectorFlow > 0
    && !profile?.capitalEstimated && !profile?.capitalStale
    && Boolean(profile?.capitalTradeDate) && profile.capitalTradeDate === quote.tradeDate;
  const exitsBase = latest.close >= average(closes.slice(-10)) && latest.close >= low10 * 1.04;
  const r3Evidence = [Boolean(profile), themeBroad, themeFunded, relativePositive, exitsBase];
  if (r3Evidence.every(Boolean)) routes.push({
    id:'R3', name:'题材共振首启动', score:r3Evidence.filter(Boolean).length * 12,
    evidence:[profile && `轮动题材${profile.name}`, themeBroad && `板块上涨覆盖${(sectorUpRatio * 100).toFixed(0)}%`, themeFunded && '同交易日真实板块资金流入', relativePositive && '个股当日跑赢板块', exitsBase && '价格离开低位整理区'].filter(Boolean),
    missing:[!themeBroad && '板块扩散不足', !themeFunded && '板块资金未确认', !relativePositive && '个股相对强度未转正'].filter(Boolean)
  });

  const best = routes.sort((left, right) => right.score - left.score)[0];
  if (!best) return {matched:false,state:'none',reasonCode:'no-repair-structure',missingEvidence:['R1/R2/R3均未形成']};
  const resistance = best.id === 'R2' ? Math.max(prior3High, ma5) : Math.max(prior3High, average(closes.slice(-10)));
  const invalidation = best.id === 'R2' ? Math.min(ma30, low10) * .97 : low10 * .98;
  const explosive = volumeRatio !== null && volumeRatio > 4;
  const limitOrHot = finite(quote.changePct) >= 8 || finite(quote.upperLimit) > 0 && latest.close >= Number(quote.upperLimit) - .005;
  const controlledVolume = volumeRatio !== null && volumeRatio >= 1.5 && volumeRatio <= 4;
  const closed = observationPhase.phase !== 'intraday';
  const brokeResistance = latest.close >= resistance;
  const broken = latest.close < invalidation;
  let state = 'observation';
  let reasonCode = 'repair-observation';
  if (broken) { state = 'invalid'; reasonCode = 'structure-invalidated'; }
  else if (explosive || limitOrHot) { state = 'overheated'; reasonCode = explosive ? 'explosive-volume' : 'no-chase'; }
  else if (closed && brokeResistance && controlledVolume) { state = 'verified-trigger'; reasonCode = 'close-volume-confirmed'; }
  else if (latest.close >= resistance * .97 || reclaimShort) { state = 'condition-pending'; reasonCode = 'near-trigger'; }
  const missingEvidence = [...best.missing, '历史分钟资金未取得，不据此确认盘中资金持续性'];
  if (!closed) missingEvidence.push('等待收盘确认');
  if (!brokeResistance) missingEvidence.push(`收盘站上${resistance.toFixed(2)}元`);
  if (!controlledVolume) missingEvidence.push(volumeRatio === null ? '完整日量能待确认' : '量比需处于1.5-4.0倍');
  const detectionScore = Math.min(100, Math.round(best.score + (relativePositive ? 8 : 0)));
  const executionScore = Math.max(0, Math.min(100, Math.round((state === 'verified-trigger' ? 75
    : state === 'condition-pending' ? 58 : state === 'observation' ? 42 : 10)
    + (controlledVolume ? 10 : 0) - (explosive || limitOrHot ? 30 : 0))));
  return {
    matched:true, shadowOnly:true, route:best.id, type:best.name, state, reasonCode,
    score:detectionScore, detectionScore, executionScore,
    evidence:best.evidence, missingEvidence:[...new Set(missingEvidence)],
    resistance:round(resistance), invalidation:round(invalidation), volumeRatio:round(volumeRatio),
    drawdown20:round(drawdown20, 1), pullback10:round(pullback10, 1), return5:round(return5, 1),
    detectedChangePct:round(quote.changePct, 2),
    observedAt:observedAt || quote.quoteObservedAt || quote.fetchedAt || '', tradeDate:latest.date,
    summary:`${best.name}：${best.evidence.join('；')}。${state === 'verified-trigger' ? '收盘价与1.5-4.0倍量能已确认，仍仅作影子观察。' : `待补：${[...new Set(missingEvidence)].join('；') || '下一交易日延续性'}`}`
  };
}

function mergeShortReboundLifecycle(current = [], previous = []) {
  const prior = new Map(previous.map(item => [String(item.code || ''), item]));
  const merged = current.map(item => {
    const old = prior.get(String(item.code || ''));
    const oldSignal = old?.shortRebound || {};
    const changed = oldSignal.state && oldSignal.state !== item.shortRebound?.state;
    return {...item, shortRebound:{...item.shortRebound,
      firstDetectedAt:oldSignal.firstDetectedAt || item.shortRebound?.observedAt || '',
      firstDetectedChangePct:oldSignal.firstDetectedChangePct ?? item.shortRebound?.detectedChangePct ?? null,
      stateChangedAt:changed ? item.shortRebound?.observedAt || '' : oldSignal.stateChangedAt || item.shortRebound?.observedAt || ''}};
  });
  const currentCodes = new Set(current.map(item => String(item.code || '')));
  for (const old of previous) {
    if (currentCodes.has(String(old.code || '')) || ['invalid','overheated'].includes(old.shortRebound?.state)) continue;
    merged.push({...old,entryPermission:'shadow-only',planState:null,
      entryAssessment:{...(old.entryAssessment || {}),allowed:false,status:'结构失效',summary:'当前刷新不再满足原短线修复结构。'},
      shortRebound:{...old.shortRebound,state:'invalid',reasonCode:'setup-no-longer-matched',
        stateChangedAt:current[0]?.shortRebound?.observedAt || new Date().toISOString(),
        missingEvidence:[...new Set([...(old.shortRebound?.missingEvidence || []),'当前刷新不再满足原修复结构'])],
        summary:`${old.shortRebound?.type || '短线修复'}已失效：当前刷新不再满足原修复结构。`}});
  }
  return merged;
}

module.exports = {evaluateShortRebound, mergeShortReboundLifecycle};
