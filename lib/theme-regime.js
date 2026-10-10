'use strict';

const crypto = require('node:crypto');
const {nextTradingDay} = require('./trade-time');

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function missingTradingDays(from, to) {
  if (from === to) return 0;
  let date = from, missing = 0;
  for (let index = 0; index < 250; index++) {
    date = nextTradingDay(date);
    if (!date || date > to) return null;
    if (date === to) return missing;
    missing++;
  }
  return null;
}

function buildThemeRegimes({sectors = [],quotes = [],limits = {},previous = [],tradeDate = '',cutoffAt = ''} = {}) {
  const quoteByCode = new Map(quotes.filter(row => row?.code && row.tradeDate === tradeDate)
    .map(row => [String(row.code),row]));
  const upCodes = new Set((limits.upCodes || []).map(String));
  const priorByKey = new Map(previous.map(row => [`${row.boardType}:${row.code || row.themeId || row.name}`,row]));
  return sectors.map(sector => {
    const key = `${sector.boardType}:${sector.code || sector.name}`;
    const prior = priorByKey.get(key);
    const members = [...new Set((sector.memberCodes || []).map(String).filter(code => /^\d{6}$/.test(code)))];
    const observed = members.map(code => quoteByCode.get(code)).filter(Boolean);
    const ranked = observed.filter(row => finite(row.amount) !== null).sort((a,b) => b.amount-a.amount);
    const remaining = ranked.slice(3);
    const memberRevision = sector.memberSignature || (members.length
      ? crypto.createHash('sha256').update(members.sort().join(',')).digest('hex').slice(0,20) : null);
    const observedAt = Date.parse(sector.capitalObservedAt || '');
    const fetchedAt = Date.parse(sector.capitalFetchedAt || '');
    const cutoff = Date.parse(cutoffAt);
    const sourceCurrent = members.length > 0 && sector.capitalEstimated === false && !sector.capitalStale
      && sector.capitalTradeDate === tradeDate && finite(sector.mainNetInflow) !== null
      && sector.capitalSource && Number.isFinite(observedAt) && Number.isFinite(cutoff)
      && observedAt <= cutoff && (!sector.capitalFetchedAt || Number.isFinite(fetchedAt) && fetchedAt >= observedAt);
    const comparable = sourceCurrent && prior?.memberRevision === memberRevision
      && prior?.capital?.source === sector.capitalSource && prior.tradeDate === tradeDate
      && Date.parse(sector.capitalObservedAt) > Date.parse(prior.capital?.observedAt || '');
    const deltaNet = comparable ? Number(sector.mainNetInflow)-prior.capital.netInflow : null;
    const net = sourceCurrent ? Number(sector.mainNetInflow) : null;
    const direction = net === null ? 'unknown' : deltaNet === null ? '当前净额可见，变化待核验'
      : net < 0 && prior.capital.netInflow >= 0 ? '由正转负'
        : net < 0 && deltaNet < 0 ? '净流出扩大'
          : net > 0 && deltaNet < 0 ? '净流入回落'
            : net > 0 && deltaNet > 0 ? '净流入扩大' : '资金方向未变';
    const breadth = members.length && observed.length / members.length >= .6
      ? {status:'observed',coverage:observed.length/members.length,
        exTop3UpRatio:remaining.length ? remaining.filter(row => finite(row.changePct) > 0).length/remaining.length : null}
      : {status:'unknown',coverage:members.length ? observed.length/members.length : null,exTop3UpRatio:null};
    const limitUpMembers = members.filter(code => upCodes.has(code));
    const capital = {status:sourceCurrent ? 'observed' : 'unknown',netInflow:net,
      deltaNet, direction,source:sourceCurrent ? sector.capitalSource : '',
      observedAt:sourceCurrent ? sector.capitalObservedAt : '',comparable:Boolean(comparable)};
    const capacityTrack = {status:'unknown',reason:'缺少盘前冻结的20日真实成交额容量股及独立资金确认',
      amountLeaders:ranked.slice(0,3).map(row => ({code:row.code,amount:row.amount,source:row.source || ''}))};
    const ladderTrack = {status:limits.ladderStatus === 'complete' && members.length ? 'observed' : 'partial',
      limitUpCount:limitUpMembers.length,limitUpCodes:limitUpMembers,
      reason:limits.ladderStatus === 'complete' ? '' : '公开快照未提供完整连板高度与炸板路径'};
    const state = direction === '净流出扩大' || direction === '由正转负'
      ? limitUpMembers.length ? '资金与涨停背离' : '退潮风险'
      : net > 0 && breadth.status === 'observed' && breadth.exTop3UpRatio > .5
        ? '资金与广度同向（梯队待核验）' : '证据不足';
    const phase = state === '退潮风险' ? '退潮风险'
      : sourceCurrent && sector.shadowRotation?.phase === '扩散确认' && breadth.status === 'observed' ? '扩散确认'
        : sourceCurrent && sector.shadowRotation?.phase === '分歧仍有承接' ? '分歧修复'
          : net > 0 && breadth.status === 'observed' ? '扩散试探' : '催化待验';
    const gap = prior?.memberRevision === memberRevision && memberRevision
      ? missingTradingDays(prior.tradeDate,tradeDate) : null;
    const sameMembersAsPrior = Boolean(prior?.episodeId && prior.memberRevision === memberRevision && memberRevision
      && prior.tradeDate <= tradeDate);
    const continuing = sameMembersAsPrior;
    const episodeId = !memberRevision ? null : continuing ? prior.episodeId : crypto.createHash('sha256')
      .update(JSON.stringify([key,memberRevision,tradeDate])).digest('hex').slice(0,20);
    const runTradingDays = !episodeId ? null : continuing
      ? gap === null ? prior.runTradingDays : (prior.runTradingDays || 1) + Number(prior.tradeDate !== tradeDate) : 1;
    const missingDates = continuing ? gap === null || prior.missingDates === null
      ? null : (prior.missingDates || 0) + gap : 0;
    return {themeId:sector.code || sector.name,name:sector.name,boardType:sector.boardType,
      parentThemeId:sector.parentThemeId || null,memberRevision,memberCount:members.length,
      tradeDate,cutoffAt,episodeId,runTradingDays,missingDates,phase,state,
      transition:prior?.phase !== phase ? {from:prior?.phase || 'unknown',to:phase,at:cutoffAt} : null,
      capital,breadth,capacityTrack,ladderTrack,
      sourceRefs:[sector.capitalSource && sector.capitalObservedAt ? `${sector.capitalSource}@${sector.capitalObservedAt}` : '',
        members.length ? `board-members:${sector.code || sector.name}@${cutoffAt}` : ''].filter(Boolean),
      unknownReasons:[!members.length && '板块成员缺失',missingDates === null && '交易日历或中间快照缺失，连续天数待核验',
        gap > 0 && `中间缺少${gap}个交易日快照，轮次暂停计数`,
        !sourceCurrent && '同日真实板块资金待核验',
        capacityTrack.reason,ladderTrack.reason].filter(Boolean),shadowOnly:true};
  });
}

module.exports = {buildThemeRegimes};
