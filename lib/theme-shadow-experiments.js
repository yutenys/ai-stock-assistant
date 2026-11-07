'use strict';

const {clock,nextTradingDay} = require('./trade-time');

const VERSION = 'theme-regime-20261010-shadow-v1';

function createThemeShadowManifest({frozenAt,modelVersion} = {}) {
  if (!Number.isFinite(Date.parse(frozenAt || '')) || !modelVersion) throw new Error('题材实验需要冻结时点和模型版本');
  const firstTradeDate = nextTradingDay(clock(frozenAt).date);
  return {version:VERSION,frozenAt,firstTradeDate,modelVersion,shadowOnly:true,promotionAllowed:false,
    minimumNewTradingDays:20,minimumMatureEpisodesPerRoute:30,
    experiments:[{id:'H5',change:'冻结容量与梯队双轨验证'},
      {id:'H6',change:'60分钟结构回踩后独立触发'},
      {id:'H7',change:'H5与H6组合验证'}]};
}

function evaluateThemeShadowExperiments(item, {manifest,tradeDate,cutoffAt,theme} = {}) {
  const decision = (id,status,reason) => ({id,version:VERSION,status,reasons:[reason],shadowOnly:true});
  const pending = reason => ['H5','H6','H7'].map(id => decision(id,'unknown',reason));
  const validEvent = event => event?.type === 'entry-allowed' && event.verified === true && Boolean(event.source)
    && Number.isFinite(Date.parse(event.occurredAt || '')) && clock(event.occurredAt).date === tradeDate
    && Date.parse(event.occurredAt) <= Date.parse(cutoffAt);
  if (!manifest || manifest.version !== VERSION || !manifest.firstTradeDate || !tradeDate || tradeDate < manifest.firstTradeDate
    || !Number.isFinite(Date.parse(cutoffAt || '')) || Date.parse(cutoffAt) < Date.parse(manifest.frozenAt))
    return pending('before-prospective-start');
  const base = item.entryPermission === 'blocked' || item.planState?.currentPermission === 'blocked' ? 'blocked'
    : item.entryPermission === 'allowed' && item.planState?.currentPermission === 'allowed' ? 'allowed' : 'watch';
  if (item.invalidated || item.terminal) return ['H5','H6','H7'].map(id => decision(id,'fail','plan-terminal'));
  const validTheme = theme?.tradeDate === tradeDate && Number.isFinite(Date.parse(theme.cutoffAt || ''))
    && clock(theme.cutoffAt).date === tradeDate && Date.parse(theme.cutoffAt) <= Date.parse(cutoffAt)
    && theme.memberRevision && theme.memberCount > 0;
  const themeGate = !validTheme || theme.capacityTrack?.status === 'unknown' || theme.ladderTrack?.status !== 'observed'
    || theme.capital?.status !== 'observed' ? {status:'unknown',reason:'capacity-ladder-or-capital-missing'}
    : theme.capacityTrack.status === 'confirmed' && theme.capital.netInflow > 0
      && theme.state !== '资金与涨停背离' && theme.state !== '退潮风险'
      ? {status:'pass',reason:'dual-track-confirmed'} : {status:'fail',reason:'theme-dual-track-divergent'};
  const h5 = base === 'blocked' ? decision('H5','fail','formal-plan-blocked')
    : base !== 'allowed' ? decision('H5','unknown','formal-trigger-not-allowed')
      : !validEvent(item.planState?.decisionEvent || item.decisionEvent)
        ? decision('H5','unknown','verified-formal-trigger-missing')
        : decision('H5',themeGate.status,themeGate.reason);
  const intraday = item.intradayPlanState, structure = item.intradayStructure;
  const h6 = !intraday || !structure || structure.state === 'unknown'
    ? decision('H6','unknown','complete-60m-and-later-5m-missing')
    : structure.state === 'invalid' || intraday.currentPermission === 'blocked'
      ? decision('H6','fail','intraday-structure-invalid')
      : structure.state === 'retest-confirmed' && intraday.currentPermission === 'allowed'
        && validEvent(intraday.decisionEvent)
        ? decision('H6','pass','independent-retest-trigger')
        : decision('H6','unknown','later-verified-trigger-missing');
  const h7 = h5.status === 'fail' || h6.status === 'fail' ? decision('H7','fail','component-rejected')
    : h5.status === 'pass' && h6.status === 'pass' ? decision('H7','pass','combined-evidence-confirmed')
      : decision('H7','unknown','component-evidence-missing');
  return [h5,h6,h7];
}

module.exports = {VERSION,createThemeShadowManifest,evaluateThemeShadowExperiments};
