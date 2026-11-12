'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {evaluateFavoriteBatchPerformance} = require('../lib/favorite-batch-performance');

function history(code, rows) {
  return [code,{source:'fixture',adjustment:'none',bars:rows.map(([date,close])=>({date,close,isFinal:true,adjustment:'none'}))}];
}

test('收藏批次按交易日输出D+1/D+3并区分未成熟与缺失', () => {
  const result=evaluateFavoriteBatchPerformance([{
    code:'600001',name:'样本',label:'1106-盘中积极',addedAt:'2026-11-06T02:00:00.000Z',
    referencePrice:10,referenceAdjustment:'none',modelVersion:'v1',attribution:'recommendation',favoriteEventId:'event-one'
  }],new Map([history('600001',[
    ['2026-11-06',10.2],['2026-11-09',10.5],['2026-11-10',11],['2026-11-11',9.5]
  ])]),{asOfDate:'2026-11-11',horizons:[1,2,3,5]});
  assert.equal(result.episodes.length,1);
  assert.equal(result.episodes[0].observations[1].date,'2026-11-09');
  assert.equal(result.episodes[0].observations[1].returnPct,5);
  assert.equal(result.episodes[0].observations[3].returnPct,-5);
  assert.equal(result.episodes[0].observations[5].status,'immature');
  assert.equal(result.horizons[3].medianReturnPct,-5);
  assert.equal(result.horizons[5].immature,1);
});

test('同一推荐跨标签去重并保留全部标签', () => {
  const base={code:'600001',addedAt:'2026-11-10T01:30:00.000Z',referencePrice:10,
    modelVersion:'v1',attribution:'recommendation',favoriteEventId:'same'};
  const result=evaluateFavoriteBatchPerformance([
    {...base,label:'1110-盘中积极'},
    {...base,label:'重点关注'}
  ],new Map([history('600001',[['2026-11-10',10],['2026-11-11',10.5]])]),
  {asOfDate:'2026-11-11',horizons:[1]});
  assert.equal(result.episodes.length,1);
  assert.deepEqual(result.episodes[0].labels,['1110-盘中积极','重点关注']);
  assert.equal(result.counts.rawFavorites,2);
  assert.equal(result.counts.dedupedEpisodes,1);
  assert.equal(result.counts.duplicates,1);
  assert.equal(result.counts.invalid,0);
});

test('同一冻结计划在不同标签产生不同收藏事件时仍只计一次', () => {
  const base={code:'600001',addedAt:'2026-11-10T01:30:00.000Z',referencePrice:10,
    modelVersion:'v1',attribution:'recommendation',planId:'plan-1'};
  const result=evaluateFavoriteBatchPerformance([
    {...base,label:'标签A',favoriteEventId:'event-a'},
    {...base,label:'标签B',favoriteEventId:'event-b'}
  ],new Map([history('600001',[['2026-11-10',10],['2026-11-11',10.5]])]),
  {asOfDate:'2026-11-11',horizons:[1]});
  assert.equal(result.counts.dedupedEpisodes,1);
  assert.deepEqual(result.episodes[0].labels,['标签A','标签B']);
});

test('盘后收藏不把当日收盘当可获得表现且缺收盘不填零', () => {
  const rows=[
    {code:'600001',label:'1109-盘后积极',addedAt:'2026-11-09T07:10:00.000Z',referencePrice:10,
      referenceAdjustment:'none',modelVersion:'v1',favoriteEventId:'after-close'},
    {code:'600002',label:'1109-盘后积极',addedAt:'2026-11-09T07:10:00.000Z',referencePrice:20,
      modelVersion:'v1',favoriteEventId:'missing'}
  ];
  const result=evaluateFavoriteBatchPerformance(rows,new Map([
    history('600001',[['2026-11-09',9],['2026-11-10',11]])
  ]),{asOfDate:'2026-11-10',horizons:[0,1]});
  assert.equal(result.episodes[0].phase,'盘后');
  assert.equal(result.episodes[0].observations[0].status,'not-applicable');
  assert.equal(result.episodes[0].observations[1].returnPct,10);
  assert.equal(result.horizons[1].missing,1);
  assert.equal(result.horizons[1].averageReturnPct,10);
});

test('当前累计与今日涨跌分别使用基准价和前一有效收盘', () => {
  const result=evaluateFavoriteBatchPerformance([{
    code:'600001',label:'1106-盘中积极',addedAt:'2026-11-06T02:00:00.000Z',referencePrice:10,
    referenceAdjustment:'none',modelVersion:'v1',favoriteEventId:'one'
  }],new Map([history('600001',[
    ['2026-11-09',10.2],['2026-11-10',10.5],['2026-11-11',11]
  ])]),{asOfDate:'2026-11-11',horizons:[1]});
  assert.equal(result.episodes[0].current.returnPct,10);
  assert.equal(result.episodes[0].current.todayChangePct,4.76);
  assert.equal(result.cohorts[0].current.averageReturnPct,10);
});

test('复权口径未知时保留不可比状态', () => {
  const result=evaluateFavoriteBatchPerformance([{
    code:'600001',label:'1110-盘中积极',addedAt:'2026-11-10T01:30:00.000Z',referencePrice:10,
    modelVersion:'v1',favoriteEventId:'one',referenceAdjustment:'qfq'
  }],new Map([history('600001',[['2026-11-11',11]])]),{asOfDate:'2026-11-11',horizons:[1]});
  assert.equal(result.episodes[0].observations[1].status,'incomparable');
  assert.equal(result.horizons[1].incomparable,1);
});

test('任一端复权口径缺失时不计入可比收益', () => {
  const [code,value]=history('600001',[['2026-11-11',11]]);
  delete value.bars[0].adjustment;
  delete value.adjustment;
  const result=evaluateFavoriteBatchPerformance([{code,addedAt:'2026-11-10T01:30:00.000Z',referencePrice:10,
    referenceAdjustment:'none',favoriteEventId:'unknown-adjustment'}],new Map([[code,value]]),
  {asOfDate:'2026-11-11',horizons:[1]});
  assert.equal(result.episodes[0].observations[1].status,'unverified-adjustment');
  assert.equal(result.horizons[1].observed,0);
});

test('目标日K线缺失时不用旧收盘冒充今日', () => {
  const result=evaluateFavoriteBatchPerformance([{code:'600001',addedAt:'2026-11-09T01:30:00.000Z',referencePrice:10,
    referenceAdjustment:'none',favoriteEventId:'stale'}],new Map([history('600001',[['2026-11-10',11]])]),
  {asOfDate:'2026-11-11',horizons:[1]});
  assert.equal(result.episodes[0].current.status,'missing');
  assert.equal(result.episodes[0].current.lastAvailableDate,'2026-11-10');
  assert.equal(result.episodes[0].current.todayChangePct,null);
});

test('同episode基准冲突不采用第一条且来源分组', () => {
  const base={code:'600001',addedAt:'2026-11-10T01:30:00.000Z',referenceAdjustment:'none',planId:'p1'};
  const result=evaluateFavoriteBatchPerformance([
    {...base,label:'A',referencePrice:10,attribution:'recommendation'},
    {...base,label:'B',referencePrice:11,attribution:'recommendation'}
  ],new Map([history('600001',[['2026-11-11',12]])]),{asOfDate:'2026-11-11',horizons:[1]});
  assert.equal(result.episodes[0].observations[1].status,'base-conflict');
  assert.equal(result.sourceSummaries.algorithm.count,1);
  assert.equal(result.sourceSummaries.manual.count,0);
});

test('非交易日按前一交易日锚定且未知日历单列', () => {
  const weekend=evaluateFavoriteBatchPerformance([{code:'600001',addedAt:'2026-11-08T02:00:00.000Z',
    referencePrice:10,referenceAdjustment:'none',favoriteEventId:'weekend'}],
  new Map([history('600001',[['2026-11-09',11]])]),{asOfDate:'2026-11-09',horizons:[1]});
  assert.equal(weekend.episodes[0].baseDate,'2026-11-06');
  assert.equal(weekend.episodes[0].observations[1].returnPct,10);
  const unknown=evaluateFavoriteBatchPerformance([{code:'600001',addedAt:'2027-01-04T02:00:00.000Z',
    referencePrice:10,referenceAdjustment:'none',favoriteEventId:'unknown'}],new Map(),
  {asOfDate:'2027-01-05',horizons:[1]});
  assert.equal(unknown.episodes[0].observations[1].status,'calendar-unknown');
});

test('跨日收藏保留独立基准但推荐episode只计一次', () => {
  const result=evaluateFavoriteBatchPerformance([
    {code:'600001',addedAt:'2026-11-09T01:30:00.000Z',referencePrice:10,referenceAdjustment:'none',planId:'p1',favoriteEventId:'a'},
    {code:'600001',addedAt:'2026-11-10T01:30:00.000Z',referencePrice:11,referenceAdjustment:'none',planId:'p1',favoriteEventId:'b'}
  ],new Map([history('600001',[['2026-11-10',11],['2026-11-11',12]])]),{asOfDate:'2026-11-11',horizons:[1]});
  assert.equal(result.counts.dedupedEpisodes,2);
  assert.equal(result.counts.recommendationEpisodes,1);
});
