const test = require('node:test');
const assert = require('node:assert/strict');
const {evaluatePublishedEpisodes,mergeSavedReportCloses,assessForwardValidation} = require('../lib/recommendation-outcomes');
const {nextTradingDay} = require('../lib/trade-time');

function batch(id, date, signalId = id) {
  return {batchId:id,tradeDate:date,publishedAt:`${date}T15:05:00+08:00`,
    inputCutoffAt:`${date}T15:00:00+08:00`,modelVersion:'test-v1',recommendations:[{
      code:'600001',signalId,quote:{price:10},strategyDecision:{primaryStrategyId:'trend-breakout'}
    }]};
}

test('月度和每日账本重复以及连续刷新只形成一个推荐episode', () => {
  const first=batch('one','2026-09-10');
  const second=batch('two','2026-09-11');
  const result=evaluatePublishedEpisodes([first,{...first},second],new Map([['600001',{source:'已核验日线',bars:[
    {date:'2026-09-11',open:10.2,upperLimit:11,close:10.5,isFinal:true},
    {date:'2026-09-14',open:10.6,upperLimit:11.55,close:10.8,isFinal:true}
  ]}]]),{asOfDate:'2026-09-15',horizons:[1,3]});
  assert.equal(result.duplicateBatches,1);
  assert.equal(result.counts.publishedSignals,2);
  assert.equal(result.counts.episodes,1);
  assert.equal(result.episodes[0].refreshCount,2);
  assert.deepEqual(result.episodes[0].signalIds,['one','two']);
  assert.equal(result.episodes[0].observations[1].status,'observed');
  assert.equal(result.episodes[0].observations[3].status,'missing');
  assert.equal(result.episodes[0].execution.status,'executable');
  assert.equal(result.episodes[0].execution.earliestSellDate,'2026-09-14');
});

test('历史回填和附件声称收益不能进入已发布评价', () => {
  const result=evaluatePublishedEpisodes([
    {...batch('old','2026-09-10'),publishedAt:''},
    {...batch('future','2026-09-10'),publishedAt:'2026-09-17T15:05:00+08:00'},
    {...batch('external','2026-09-10'),sourceType:'external-report'}
  ],new Map(),{asOfDate:'2026-09-15'});
  assert.equal(result.excludedBatches,3);
  assert.equal(result.counts.episodes,0);
});

test('连续日期同股跨模型版本必须拆成独立episode', () => {
  const first=batch('old','2026-09-10');
  const second={...batch('new','2026-09-11'),modelVersion:'test-v2'};
  const review=evaluatePublishedEpisodes([first,second],new Map(),{asOfDate:'2026-09-15',horizons:[1]});
  assert.equal(review.counts.episodes,2);
  assert.deepEqual(review.episodes.map(row=>row.modelVersion),['test-v1','test-v2']);
});

test('停牌、开盘涨停和缺限价证据保留为不同状态', () => {
  const rows=[
    {code:'600001',open:11,upperLimit:11},
    {code:'600002',open:10,suspended:true},
    {code:'600003',open:10}
  ];
  const batches=rows.map((item,index)=>({batchId:String(index),tradeDate:'2026-09-10',
    publishedAt:'2026-09-10T15:05:00+08:00',inputCutoffAt:'2026-09-10T15:00:00+08:00',
    modelVersion:'v1',recommendations:[{code:item.code,signalId:item.code,price:10,
      strategyDecision:{primaryStrategyId:'trend-breakout'}}]}));
  const histories=new Map(rows.map(item=>[item.code,{source:'日线',bars:[{date:'2026-09-11',...item}]}]));
  const result=evaluatePublishedEpisodes(batches,histories,{asOfDate:'2026-09-14',horizons:[1]});
  assert.deepEqual(result.episodes.map(row=>row.execution.status),['unfilled','unfilled','unverified']);
  assert.deepEqual(result.counts.execution,{executable:0,unfilled:2,unverified:1,immature:0});
});

test('未收盘日线不能被算作已可执行买入', () => {
  const history=new Map([['600001',{source:'盘中行情',bars:[
    {date:'2026-09-11',open:10,close:10.5,upperLimit:11,isFinal:false}
  ]}]]);
  const review=evaluatePublishedEpisodes([batch('one','2026-09-10')],history,
    {asOfDate:'2026-09-11',horizons:[1]});
  assert.equal(review.episodes[0].execution.status,'unverified');
  assert.equal(review.episodes[0].observations[1].status,'missing');
});

test('只合并已存报告的最终收盘，不把它当可成交开盘', () => {
  const original=new Map([['600001',{source:'本地日线',lastDate:'2026-09-10',bars:[{date:'2026-09-10',close:10}]}]]);
  const reports=[{tradeDate:'2026-09-11',recommendations:{followUp:[
    {code:'600001',closePrice:10.5,dataStatus:'完整',closeObservedAt:'2026-09-11T15:01:00+08:00'},
    {code:'600002',closePrice:12,dataStatus:'完整'},
    {code:'600001',closePrice:10.6,dataStatus:'收盘行情待核验'}
  ]}}];
  const merged=mergeSavedReportCloses(original,reports);
  assert.equal(merged.added,1);
  assert.equal(original.get('600001').bars.length,1);
  const review=evaluatePublishedEpisodes([batch('one','2026-09-10')],merged.histories,
    {asOfDate:'2026-09-14',horizons:[1]});
  assert.equal(Math.round(review.episodes[0].observations[1].returnPct),5);
  assert.equal(review.episodes[0].execution.status,'unverified');
});

test('前瞻门槛只计算冻结后的新交易日和各路线成熟可成交episode', () => {
  const freezeDate='2026-09-29',modelVersion='v25';
  let asOfDate=freezeDate;
  for (let index=0;index<20;index++) asOfDate=nextTradingDay(asOfDate);
  const episode=(track,horizon,index) => ({track,modelVersion,tradeDate:'2026-09-30',episodeId:`${track}-${index}`,
    execution:{status:'executable'},observations:{[horizon]:{status:'observed'}}});
  const episodes=[...Array.from({length:30},(_,index)=>episode('A',20,index)),
    ...Array.from({length:29},(_,index)=>episode('B',5,index)),
    {...episode('B',5,29),modelVersion:'old'}];
  const pending=assessForwardValidation({episodes},{freezeDate,modelVersion,asOfDate});
  assert.equal(pending.tradingDays,20);
  assert.equal(pending.routes.A.mature,30);
  assert.equal(pending.routes.B.mature,29);
  assert.equal(pending.readyForComparison,false);
  episodes.push(episode('B',5,30));
  const ready=assessForwardValidation({episodes},{freezeDate,modelVersion,asOfDate});
  assert.equal(ready.readyForComparison,true);
  assert.equal(ready.promotionAllowed,false);
});
