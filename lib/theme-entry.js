function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function time(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function codeOf(value) {
  return String(typeof value === 'object' ? value?.code || '' : value || '').slice(-6);
}

function availableAt(row, cutoff, observedField) {
  const observed = time(row?.[observedField]);
  return observed !== null && observed <= cutoff;
}

function comparableContract(a, b) {
  if (!a && !b) return true;
  return a && b && a.unit === 'yuan' && b.unit === 'yuan'
    && a.currency === 'CNY' && b.currency === 'CNY'
    && a.provider && a.provider === b.provider && a.boardType === b.boardType;
}

function evaluateThemeEntry({members = [], frozenLeaders = [], snapshots = [], capital = {}, news = [], cutoffAt, candidateCode = ''} = {}) {
  const cutoff = time(cutoffAt);
  if (cutoff === null) throw new TypeError('cutoffAt must be a valid timestamp');
  const tradeDate = new Date(cutoff + 8 * 3600000).toISOString().slice(0, 10);
  const premarket = time(`${tradeDate}T09:15:00+08:00`);
  const unknownReasons = [];
  const sourceRefs = [];
  const memberByCode = new Map();
  const parentThemeIds = new Set();
  const themeIds = new Set();
  for (const member of members || []) {
    const code = codeOf(member);
    const relation = member?.relationEvidence;
    if (!code || !relation?.source || !relation?.url || !availableAt(relation, cutoff, 'firstSeenAt')
      || time(relation.publishedAt) === null || time(relation.publishedAt) > cutoff
      || relation.validUntil && (time(relation.validUntil) === null || time(relation.validUntil) < cutoff)) {
      unknownReasons.push(`成员${code || '未知'}业务关系未核验`);
      continue;
    }
    if (!memberByCode.has(code)) memberByCode.set(code, member);
    for (const id of member.parentThemeIds || []) parentThemeIds.add(id);
    if (member.themeId) themeIds.add(member.themeId);
    sourceRefs.push(relation.url);
  }
  const memberCodes = [...memberByCode.keys()].sort();
  const parents = [...parentThemeIds].sort();
  const themes = [...themeIds].sort();
  const frozen = Array.isArray(frozenLeaders) ? frozenLeaders : frozenLeaders?.leaders || [];
  const leaderRevision = frozenLeaders?.revision || null;
  const leaderByCode = new Map();
  for (const leader of frozen) {
    const code = codeOf(leader);
    if (!memberByCode.has(code) || leaderByCode.has(code) || leader?.hardRisk || leader?.suspended
      || !(number(leader?.median20Amount) > 0) || !(number(leader?.stableTradingDays) >= 20)
      || !availableAt(leader, premarket, 'frozenAt')) continue;
    leaderByCode.set(code, leader);
  }
  const leaderCodes = [...leaderByCode.values()]
    .sort((a, b) => b.median20Amount - a.median20Amount || codeOf(a).localeCompare(codeOf(b)))
    .slice(0, 3).map(codeOf).filter(code => code !== codeOf(candidateCode));
  if (leaderCodes.length < 2) unknownReasons.push('有效容量股不足2只（已剔除候选自身）');

  const quoteByCode = new Map();
  for (const row of snapshots || []) {
    const code = codeOf(row);
    if (!memberByCode.has(code) || row.tradeDate !== tradeDate || !row.source
      || !availableAt(row, cutoff, 'quoteObservedAt')) continue;
    if (!quoteByCode.has(code) || time(row.quoteObservedAt) > time(quoteByCode.get(code).quoteObservedAt)) quoteByCode.set(code, row);
  }
  const breadthCoverage = memberCodes.length ? quoteByCode.size / memberCodes.length : null;
  const ranked = [...quoteByCode.values()].filter(row => number(row.changePct) !== null)
    .sort((a, b) => b.changePct - a.changePct || codeOf(a).localeCompare(codeOf(b)));
  const exTop3 = ranked.slice(3);
  const exTop3UpRatio = exTop3.length ? exTop3.filter(row => row.changePct > 0).length / exTop3.length : null;
  const strongLeaders = leaderCodes.filter(code => {
    const row = quoteByCode.get(code);
    return row && row.hardRisk === false && number(row.price) !== null && number(row.vwap) !== null
      && number(row.indexChangePct) !== null && row.price > row.vwap && row.changePct > row.indexChangePct;
  });
  const leaderQuotesComplete = leaderCodes.every(code => {
    const row = quoteByCode.get(code);
    return row && row.hardRisk !== undefined && number(row.price) !== null && number(row.vwap) !== null
      && number(row.changePct) !== null && number(row.indexChangePct) !== null;
  });
  const breadthReady = breadthCoverage !== null && breadthCoverage >= .7 && exTop3.length > 0
    && ranked.length / memberCodes.length >= .7;
  if (!breadthReady) unknownReasons.push('去前三广度或有效行情覆盖不足');
  if (!leaderQuotesComplete) unknownReasons.push('容量股VWAP、指数收益或风险行情缺失');
  const priceStatus = leaderCodes.length < 2 || !breadthReady || !leaderQuotesComplete ? 'unknown'
    : strongLeaders.length >= Math.ceil(leaderCodes.length * 2 / 3) && exTop3UpRatio > .5 ? 'confirmed' : 'divergent';
  const priceConfirmation = {status:priceStatus,leaderCodes,leaderStrongCodes:strongLeaders,
    leaderRequired:Math.ceil(leaderCodes.length * 2 / 3),exTop3Count:exTop3.length,exTop3UpRatio,
    breadthCoverage,quoteObservedAt:[...quoteByCode.values()].map(row => row.quoteObservedAt).sort().at(-1) || null};

  const sameMembers = row => Array.isArray(row.memberCodes)
    && [...new Set(row.memberCodes.map(codeOf))].sort().join(',') === memberCodes.join(',');
  const funds = (capital?.themeSnapshots || []).filter(row =>
    (themes.includes(row.themeId) || (row.parentThemeIds || []).some(id => parentThemeIds.has(id)))
    && row.capitalTradeDate === tradeDate && row.capitalSource && !row.capitalEstimated && !row.capitalStale
    && number(row.mainNetInflow) !== null && number(row.amount) > 0 && sameMembers(row)
    && availableAt(row, cutoff, 'capitalObservedAt')
    && (!row.capitalFetchedAt || time(row.capitalFetchedAt) >= time(row.capitalObservedAt)));
  const latest = [...funds].sort((a, b) => time(b.capitalObservedAt) - time(a.capitalObservedAt))[0];
  const prior = latest && funds.find(row => row !== latest && row.capitalSource === latest.capitalSource
    && time(row.capitalObservedAt) <= time(latest.capitalObservedAt) - 15 * 60000
    && comparableContract(row.windowContract, latest.windowContract));
  const peers = (capital?.peers || []).filter(row => latest && row.capitalSource === latest.capitalSource
    && row.capitalTradeDate === tradeDate && row.capitalObservedAt === latest.capitalObservedAt
    && !row.capitalEstimated && !row.capitalStale && number(row.mainNetInflow) !== null
    && number(row.amount) > 0 && comparableContract(row.windowContract, latest.windowContract));
  const distinctPeers = new Map(peers.map(row => [row.themeId, row]));
  const intensity = latest ? latest.mainNetInflow / latest.amount : null;
  const intensities = [...distinctPeers.values()].map(row => row.mainNetInflow / row.amount);
  const intensityPercentile = intensity !== null && intensities.length >= 2
    ? intensities.filter(value => value <= intensity).length / intensities.length : null;
  const intensityRank = intensityPercentile === null ? null
    : 1 + intensities.filter(value => value > intensity).length;
  const flows = (latest?.stockFlows || []).filter(row => leaderCodes.includes(codeOf(row))
    && number(row.mainNetInflow) !== null && (!row.capitalSource || row.capitalSource === latest.capitalSource)
    && (!row.capitalObservedAt || row.capitalObservedAt === latest.capitalObservedAt));
  const flowByCode = new Map(flows.map(row => [codeOf(row), row]));
  const capitalCoverage = leaderCodes.length ? flowByCode.size / leaderCodes.length : null;
  const flowSum = [...flowByCode.values()].reduce((sum, row) => sum + row.mainNetInflow, 0);
  const positiveFlows = [...flowByCode.values()].filter(row => row.mainNetInflow > 0).length;
  const capitalReady = Boolean(prior && latest && intensityPercentile !== null
    && capitalCoverage >= 2 / 3 && leaderCodes.length >= 2);
  if (!prior) unknownReasons.push('缺少相隔15分钟的独立同口径资金源时点与成员快照');
  if (intensityPercentile === null) unknownReasons.push('同源题材资金强度排名缺失');
  if (!(capitalCoverage >= 2 / 3)) unknownReasons.push('容量股真实资金覆盖不足2/3');
  const capitalStatus = !capitalReady ? 'unknown'
    : latest.mainNetInflow > 0 && prior.mainNetInflow > 0 && intensityRank / intensities.length <= .3
      && positiveFlows >= Math.ceil(leaderCodes.length / 2) && flowSum >= 0 ? 'confirmed' : 'divergent';
  const capitalConfirmation = {status:capitalStatus,netInflow:latest?.mainNetInflow ?? null,
    intensityPercentile,intensityRank,peerCount:intensities.length,capitalCoverage,positiveLeaderCount:positiveFlows,
    leaderNetInflow:flowByCode.size ? flowSum : null,
    source:latest?.capitalSource || null,snapshots:[prior,latest].filter(Boolean).map(row => ({
      observedAt:row.capitalObservedAt,source:row.capitalSource,memberCodes:row.memberCodes,
      netInflow:row.mainNetInflow}))};
  const net3 = number(latest?.mainNet3);
  const persistence = {status:net3 === null ? 'unknown' : net3 < 0 ? 'warning' : 'observed',
    net3,net5:number(latest?.mainNet5),net10:number(latest?.mainNet10)};
  if (net3 === null) unknownReasons.push('3日真实资金持续性缺失');

  const newsItems = (news || []).filter(row => row?.source && (row.link || row.url)
    && time(row.publishedAt) !== null && time(row.publishedAt) <= cutoff
    && availableAt(row, cutoff, 'firstSeenAt')
    && (memberByCode.has(codeOf(row)) || themes.includes(row.themeId)
      || (row.parentThemeIds || []).some(id => parentThemeIds.has(id))));
  if (!newsItems.length) unknownReasons.push('截止时点无可核验的直接相关消息');
  for (const row of newsItems) sourceRefs.push(row.link || row.url);
  for (const row of quoteByCode.values()) sourceRefs.push(`${row.source}@${row.quoteObservedAt}`);
  for (const row of [prior,latest].filter(Boolean)) sourceRefs.push(`${row.capitalSource}@${row.capitalObservedAt}`);
  return {themeId:themes[0] || null,parentThemeIds:parents,memberRevision:capital?.memberRevision || null,
    cutoffAt,memberCodes,leaderCodes,leaderRevision,breadthCoverage,capitalCoverage,
    priceConfirmation,capitalConfirmation,persistence,
    news:{status:newsItems.length ? 'observed' : 'unknown',items:newsItems},
    sourceRefs:[...new Set(sourceRefs)],unknownReasons:[...new Set(unknownReasons)]};
}

module.exports = {evaluateThemeEntry};
