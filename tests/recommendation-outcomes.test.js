const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {evaluatePublishedEpisodes,mergeSavedReportCloses,assessForwardValidation} = require('../lib/recommendation-outcomes');
const {readLedgerEntriesForDate} = require('../lib/report-service');
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
  assert.equal(result.episodes[0].execution.status,'unverified');
  assert.equal(result.episodes[0].nextOpenProxy.status,'executable');
  assert.equal(result.episodes[0].nextOpenProxy.earliestSellDate,'2026-09-14');
  assert.equal(result.counts.execution.executable,0);
  assert.equal(result.counts.nextOpenProxy.executable,1);
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

test('压缩账本后B观察与触发以及A不同setup仍分组评价', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(),'outcome-groups-')), 'ledger.jsonl');
  const batches = [
    {batchId:'b-watch',tradeDate:'2026-09-10',publishedAt:'2026-09-10T02:00:00+08:00',inputCutoffAt:'2026-09-10T01:59:00+08:00',modelVersion:'v1',momentumRecommendations:[
      {code:'600001',signalId:'b-watch',strategyId:'first-pullback',price:10,entryPermission:'watch',setupType:'首次回踩'}
    ]},
    {batchId:'b-trigger',tradeDate:'2026-09-10',publishedAt:'2026-09-10T02:30:00+08:00',inputCutoffAt:'2026-09-10T02:29:00+08:00',modelVersion:'v1',momentumRecommendations:[
      {code:'600001',signalId:'b-trigger',strategyId:'first-pullback',price:10.2,entryPermission:'allowed',triggeredAt:'2026-09-10T02:29:00+08:00',setupType:'首次回踩'}
    ]},
    {batchId:'a-breakout',tradeDate:'2026-09-10',publishedAt:'2026-09-10T03:00:00+08:00',inputCutoffAt:'2026-09-10T02:59:00+08:00',modelVersion:'v1',recommendations:[
      {code:'600002',signalId:'a-breakout',strategyId:'trend-breakout',price:20,entryPermission:'watch',setupType:'突破确认'}
    ]},
    {batchId:'a-pullback',tradeDate:'2026-09-10',publishedAt:'2026-09-10T03:30:00+08:00',inputCutoffAt:'2026-09-10T03:29:00+08:00',modelVersion:'v1',recommendations:[
      {code:'600002',signalId:'a-pullback',strategyId:'trend-breakout',price:19.5,entryPermission:'watch',setupType:'回踩低吸'}
    ]}
  ];
  fs.writeFileSync(file, batches.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  const compact = await readLedgerEntriesForDate(file,'2026-09-10',{compact:true});
  assert.equal(compact.entries[1].momentumRecommendations[0].entryPermission, 'allowed');
  assert.equal(compact.entries[1].momentumRecommendations[0].triggeredAt, '2026-09-10T02:29:00+08:00');
  assert.equal(compact.entries[3].recommendations[0].setupType, '回踩低吸');
  const review = evaluatePublishedEpisodes(compact.entries,new Map(),{asOfDate:'2026-09-10',horizons:[1]});
  assert.deepEqual(review.episodes.map(row => row.evaluationGroup).sort(), ['A:回踩低吸','A:突破确认','B:观察','B:触发']);
  assert.equal(review.decisionFunnel.scope,'当日全部已发布批次');
  assert.equal(review.decisionFunnel.publishedBatches,4);
  assert.equal(review.decisionFunnel.publishedSignals,4);
  assert.equal(review.decisionFunnel.episodes,4);
  assert.equal(review.decisionFunnel.publishedAllowed,1);
  assert.equal(review.decisionFunnel.verifiedTriggers,0);
  assert.equal(review.decisionFunnel.verifiedFills,0);
});

test('全天决策漏斗按计划生命周期去重并区分许可、核验触发与成交',()=>{
  const first=batch('first','2026-09-10','s1');
  first.recommendations[0]={...first.recommendations[0],planId:'p1',planRevision:1,entryPermission:'watch',
    tradePlan:{feasibility:{status:'feasible'},maxEntryPrice:10.5,invalidationPrice:9,targetPrice:13}};
  const second={...batch('second','2026-09-10','s2'),publishedAt:'2026-09-10T15:10:00+08:00',
    inputCutoffAt:'2026-09-10T15:09:00+08:00'};
  second.recommendations[0]={...second.recommendations[0],planId:'p1',planRevision:1,entryPermission:'allowed',
    tradePlan:first.recommendations[0].tradePlan,triggeredAt:'2026-09-10T15:08:00+08:00',
    decisionEvent:{id:'p1:allowed',type:'entry-allowed',planId:'p1',revision:1,verified:true,source:'fixture',
      occurredAt:'2026-09-10T15:08:00+08:00',referencePrice:10.1}};
  const review=evaluatePublishedEpisodes([first,second],new Map(),{asOfDate:'2026-09-10',horizons:[1]});
  assert.equal(review.decisionFunnel.episodes,1);
  assert.equal(review.decisionFunnel.frozenPlans,1);
  assert.equal(review.decisionFunnel.priceFeasible,1);
  assert.equal(review.decisionFunnel.observed,1);
  assert.equal(review.decisionFunnel.publishedAllowed,1);
  assert.equal(review.decisionFunnel.verifiedTriggers,1);
  assert.equal(review.decisionFunnel.verifiedFills,0);
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
  assert.deepEqual(result.episodes.map(row=>row.nextOpenProxy.status),['unfilled','unfilled','unverified']);
  assert.deepEqual(result.counts.execution,{executable:0,unfilled:0,unverified:3,immature:0});
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
  for (let index=0;index<21;index++) asOfDate=nextTradingDay(asOfDate);
  const episode=(track,horizon,index) => {
    let date='2026-09-30';
    for (let day=0;day<horizon;day++) date=nextTradingDay(date);
    return {track,modelVersion,tradeDate:'2026-09-30',episodeId:`${track}-${index}`,
    execution:{status:'executable',verified:true,entryDate:'2026-09-30',earliestSellDate:'2026-10-08'},
    executionObservations:{[horizon]:{status:'observed',date,returnPct:1,netReturnPct:.8}}};
  };
  const episodes=[...Array.from({length:30},(_,index)=>episode('A',20,index)),
    ...Array.from({length:29},(_,index)=>episode('B',5,index)),
    {...episode('B',5,29),modelVersion:'old'}];
  const pending=assessForwardValidation({episodes},{freezeDate,modelVersion,asOfDate});
  assert.equal(pending.tradingDays,21);
  assert.equal(pending.routes.A.mature,30);
  assert.equal(pending.routes.B.mature,29);
  assert.equal(pending.routes.A.readyForComparison,true);
  assert.equal(pending.routes.B.readyForComparison,false);
  assert.equal(pending.readyForComparison,false);
  episodes.push(episode('B',5,30));
  const ready=assessForwardValidation({episodes},{freezeDate,modelVersion,asOfDate});
  assert.equal(ready.readyForComparison,true);
  assert.equal(ready.promotionAllowed,false);
});

function allowed(id = 'allowed', date = '2026-09-10') {
  const row = batch(id,date);
  Object.assign(row.recommendations[0],{
    entryPermission:'allowed',planId:'plan-one',revision:1,
    tradePlan:{earliestBuyDate:'2026-09-11',entryExpiryDate:'2026-09-15',maxEntryPrice:10.5,
      costs:{entryBps:10,exitBps:20}},
    triggerEvent:{id:'trigger-one',type:'entry-allowed',occurredAt:'2026-09-10T15:00:00+08:00',
      referencePrice:10,verified:true,source:'frozen-close'}
  });
  return row;
}

function daily(date, extra = {}) {
  return {date,open:10.2,high:10.8,low:10,close:10.5,volume:1000,isFinal:true,
    upperLimit:11,lowerLimit:9,suspended:false,
    tradeRules:{verified:true,tradeDate:date,source:'historical-exchange',tPlusOne:true,capitalAvailable:true},...extra};
}

function evaluate(rows, bars, asOfDate = '2026-09-15', horizons = [1,3]) {
  return evaluatePublishedEpisodes(rows,new Map([['600001',{source:'historical',bars}]]),{asOfDate,horizons});
}

test('allowed trigger plus historical rules permits next-session open, using three independent clocks', () => {
  const row=allowed();
  row.inputCutoffAt='2026-09-10T15:01:00+08:00';
  const result=evaluate([row],[daily('2026-09-11'),daily('2026-09-14',{close:10.8})]);
  const episode=result.episodes[0];
  assert.equal(episode.execution.status,'executable');
  assert.equal(episode.execution.verified,true);
  assert.equal(episode.execution.basis,'next-session-open');
  assert.equal(episode.execution.entryDate,'2026-09-11');
  assert.equal(episode.execution.earliestSellDate,'2026-09-14');
  assert.equal(episode.observations[1].date,'2026-09-11');
  assert.deepEqual(episode.publicationObservations,episode.observations);
  assert.equal(episode.triggerObservations[1].date,'2026-09-11');
  assert.equal(episode.executionObservations[1].date,'2026-09-14');
  assert.ok(episode.executionObservations[1].netReturnPct < episode.executionObservations[1].returnPct);
  assert.equal(episode.executionObservations[3].status,'immature');
});

test('watch and armed never execute even with full opening data and copied trigger evidence', () => {
  for (const permission of ['watch','armed']) {
    const row=allowed();
    row.recommendations[0].entryPermission=permission;
    const episode=evaluate([row],[daily('2026-09-11')]).episodes[0];
    assert.equal(episode.nextOpenProxy.status,'executable');
    assert.equal(episode.execution.status,'unverified');
    assert.deepEqual(episode.executionObservations,{});
    assert.deepEqual(episode.triggerObservations,{});
  }
});

test('missing final bars, historical limits or verified trade rules cannot execute', () => {
  for (const extra of [{isFinal:false},{upperLimit:null},{lowerLimit:null},{tradeRules:null},
    {tradeRules:{verified:true,tradeDate:'2026-09-14',source:'current',tPlusOne:true}},
    {volume:0},{suspended:undefined}]) {
    assert.equal(evaluate([allowed()],[daily('2026-09-11',extra)]).episodes[0].execution.status,'unverified');
  }
  const noTrigger=allowed();
  delete noTrigger.recommendations[0].triggerEvent;
  assert.equal(evaluate([noTrigger],[daily('2026-09-11')]).episodes[0].execution.status,'unverified');
});

test('expiry, terminal invalidation and price cap prevent fills and never reopen old plans', () => {
  const expired=allowed();
  expired.recommendations[0].tradePlan.entryExpiryDate='2026-09-10';
  assert.equal(evaluate([expired],[daily('2026-09-11')]).episodes[0].execution.status,'unfilled');
  assert.equal(evaluate([allowed()],[daily('2026-09-11',{open:10.6})]).episodes[0].execution.status,'unfilled');
  const invalid=allowed('invalid');
  invalid.recommendations[0].invalidated=true;
  const again=allowed('again','2026-09-14');
  const result=evaluate([invalid,again],[daily('2026-09-11'),daily('2026-09-15')]);
  assert.equal(result.episodes.length,1);
  assert.equal(result.episodes[0].terminalState,'invalidated');
  assert.equal(result.counts.execution.executable,0);
});

test('stable plan events merge across gaps and permission transitions without duplicating triggers', () => {
  const watch=allowed('watch');
  watch.recommendations[0].entryPermission='watch';
  const trigger=allowed('trigger','2026-09-14');
  trigger.inputCutoffAt='2026-09-14T15:01:00+08:00';
  trigger.recommendations[0].triggerEvent.occurredAt='2026-09-14T15:00:00+08:00';
  trigger.recommendations[0].tradePlan.entryExpiryDate='2026-09-18';
  watch.recommendations[0].tradePlan.entryExpiryDate='2026-09-18';
  const duplicate=JSON.parse(JSON.stringify(trigger));
  duplicate.batchId='duplicate';
  const result=evaluate([watch,trigger,duplicate],[daily('2026-09-11'),daily('2026-09-15')],'2026-09-15');
  const episode=result.episodes[0];
  assert.equal(result.episodes.length,1);
  assert.equal(episode.triggerEvents.length,1);
  assert.equal(episode.execution.entryDate,'2026-09-15');
  assert.equal(episode.observations[1].date,'2026-09-11');
  assert.equal(episode.triggerObservations[1].date,'2026-09-15');
  const revised=allowed('revision','2026-09-14');
  revised.recommendations[0].revision=2;
  assert.equal(evaluate([allowed(),revised],[]).episodes.length,2);
});

test('verified quote/fill must follow trigger in ordinary session; close confirmation cannot fill same close', () => {
  const row=allowed();
  const item=row.recommendations[0];
  item.tradePlan.earliestBuyDate='2026-09-10';
  item.executionEvidence={type:'fill',status:'filled',orderId:'order-one',quantity:100,verified:true,source:'research-fill',planId:'plan-one',revision:1,
    triggerEventId:'trigger-one',at:'2026-09-10T15:00:00+08:00',price:10,earliestSellDate:'2026-09-11'};
  assert.equal(evaluate([row],[daily('2026-09-10')]).episodes[0].execution.status,'unverified');
  item.executionEvidence.at='2026-09-11T10:00:00+08:00';
  item.executionEvidence.earliestSellDate='2026-09-14';
  row.publishedAt='2026-09-11T10:05:00+08:00';
  row.inputCutoffAt='2026-09-11T10:04:00+08:00';
  const result=evaluate([row],[daily('2026-09-11'),daily('2026-09-14')]);
  assert.equal(result.episodes[0].execution.basis,'verified-fill');
  assert.equal(result.episodes[0].execution.entryPrice,10);
  item.executionEvidence.earliestSellDate='2026-09-11';
  assert.equal(evaluate([row],[daily('2026-09-11')]).episodes[0].execution.status,'unverified');
});

test('entry clocks do not inherit publication maturity and exits remain conservative on locked days', () => {
  const row=allowed();
  row.recommendations[0].tradePlan.earliestBuyDate='2026-09-14';
  const result=evaluate([row],[daily('2026-09-11'),daily('2026-09-14'),
    daily('2026-09-15',{close:9,lowerLimit:9,high:9,low:9})]);
  const episode=result.episodes[0];
  assert.equal(episode.observations[3].status,'observed');
  assert.equal(episode.executionObservations[1].status,'unverified');
  assert.equal(episode.executionObservations[1].netReturnPct,null);
  assert.equal(episode.executionObservations[3].status,'immature');
});

test('report close overlay preserves OHLCV and provenance, rejecting conflicts and future injections', () => {
  const original=daily('2026-09-11',{close:10.4,isFinal:false,source:'intraday'});
  const histories=new Map([['600001',{source:'bars',adjustment:'none',bars:[original]}]]);
  const report=(close, date='2026-09-11', extra={})=>({tradeDate:date,recommendations:{all:[{
    code:'600001',dataStatus:'完整',closePrice:close,closeObservedAt:`${date}T15:05:00+08:00`,...extra}]}});
  const merged=mergeSavedReportCloses(histories,[report(10.5),report(10.6,'2026-09-16')],{asOfDate:'2026-09-15'});
  const bar=merged.histories.get('600001').bars[0];
  assert.equal(merged.added,1);
  for (const key of ['open','high','low','volume','close','source','isFinal']) assert.equal(bar[key],original[key]);
  assert.equal(bar.finalClose.close,10.5);
  assert.equal(evaluate([batch('pub','2026-09-10')],merged.histories.get('600001').bars).episodes[0].observations[1].returnPct,5.000000000000004);
  assert.deepEqual(histories.get('600001').bars[0],original);
  const conflict=mergeSavedReportCloses(new Map([['600001',{source:'bars',bars:[daily('2026-09-11')]}]]),[report(12)]);
  assert.equal(conflict.added,0);
  assert.equal(conflict.conflicts.length,1);
  assert.equal(conflict.histories.get('600001').bars[0].close,10.5);
  const adjusted=mergeSavedReportCloses(new Map([['600001',{source:'bars',adjustment:'forward',bars:[original]}]]),[report(10.5)]);
  assert.equal(adjusted.added,0);
  assert.equal(adjusted.conflicts.length,1);
});

test('forward validation rejects proxy/publication maturity and permits route-independent comparison', () => {
  let asOfDate='2026-09-10';
  for (let index=0;index<25;index++) asOfDate=nextTradingDay(asOfDate);
  const episodes=Array.from({length:30},(_,index)=>({episodeId:`B-${index}`,track:'B',modelVersion:'new',tradeDate:'2026-09-11',
    execution:{status:'executable',verified:true,entryDate:'2026-09-14',earliestSellDate:'2026-09-15'},
    observations:{5:{status:'observed'}},executionObservations:{5:{status:'observed',date:'2026-09-21',returnPct:1,netReturnPct:.7}}}));
  episodes.push({...episodes[0],episodeId:'proxy',execution:{status:'unverified'},nextOpenProxy:{status:'executable'}});
  const options={freezeDate:'2026-09-10',modelVersion:'new',asOfDate};
  const result=assessForwardValidation({episodes},options);
  assert.equal(result.routes.B.mature,30);
  assert.equal(result.routes.B.readyForComparison,true);
  assert.equal(result.routes.A.readyForComparison,false);
  assert.equal(result.readyForComparison,false);
  assert.equal(assessForwardValidation({episodes},{...options,requireAllRoutes:false}).readyForComparison,true);
  assert.equal(result.promotionAllowed,false);
});

test('future, mismatched and ambiguous execution evidence cannot substitute a verified fill', () => {
  for (const extra of [{at:'2026-09-14T10:00:00+08:00'},{triggerEventId:'other'},
    {revision:2},{earliestSellDate:'2026-09-11'},{verified:false},{quantity:null}]) {
    const row=allowed();
    row.publishedAt='2026-09-11T10:05:00+08:00';
    row.inputCutoffAt='2026-09-11T10:04:00+08:00';
    row.recommendations[0].executionEvidence={type:'fill',status:'filled',orderId:'one',quantity:100,
      verified:true,source:'fill',planId:'plan-one',revision:1,triggerEventId:'trigger-one',
      at:'2026-09-11T10:00:00+08:00',price:10.2,earliestSellDate:'2026-09-14',...extra};
    assert.equal(evaluate([row],[daily('2026-09-11')]).episodes[0].execution.status,'unverified');
  }
});

test('verified quote can execute intraday only with contemporaneous liquidity and capital checks', () => {
  const row=allowed();
  row.inputCutoffAt='2026-09-10T10:02:00+08:00';
  row.publishedAt='2026-09-10T10:03:00+08:00';
  const item=row.recommendations[0];
  item.triggerEvent.occurredAt='2026-09-10T10:00:00+08:00';
  item.tradePlan.earliestBuyDate='2026-09-10';
  item.executionEvidence={type:'quote',verified:true,source:'live-snapshot',executable:true,
    liquidityVerified:true,capitalAvailable:true,planId:'plan-one',revision:1,triggerEventId:'trigger-one',
    at:'2026-09-10T10:01:00+08:00',price:10.2,earliestSellDate:'2026-09-11'};
  const bars=[daily('2026-09-10',{isFinal:false}),daily('2026-09-11')];
  assert.equal(evaluate([row],bars).episodes[0].execution.basis,'verified-quote');
  item.executionEvidence.liquidityVerified=false;
  assert.equal(evaluate([row],bars).episodes[0].execution.status,'unverified');
});

test('terminal states across revisions and legacy refreshes do not reopen an opportunity', () => {
  for (const planState of ['blocked','invalidated','expired','completed','cancelled']) {
    const stopped=allowed('stopped');
    stopped.recommendations[0].planState=planState;
    const later=allowed('later','2026-09-14');
    later.recommendations[0].revision=2;
    assert.equal(evaluate([stopped,later],[daily('2026-09-11'),daily('2026-09-15')]).counts.execution.executable,0);
  }
  const first=allowed('first');
  first.recommendations[0].tradePlan.entryExpiryDate='2026-09-11';
  const renewed=allowed('renewed','2026-09-14');
  renewed.recommendations[0].revision=2;
  renewed.recommendations[0].tradePlan.entryExpiryDate='2026-09-18';
  renewed.recommendations[0].triggerEvent.occurredAt='2026-09-14T15:00:00+08:00';
  const result=evaluate([first,renewed],[daily('2026-09-15')]);
  assert.equal(result.counts.execution.executable,0);
  assert.equal(result.episodes[1].terminalState,'expired');
  const legacy=batch('legacy','2026-09-10');
  legacy.recommendations[0].invalidated=true;
  assert.equal(evaluate([legacy,batch('refresh','2026-09-11')],[]).episodes[0].terminalState,'invalidated');
});

test('plan change without revision cannot move price cap or silently reprice frozen costs', () => {
  const first=allowed('first');
  const moved=allowed('moved','2026-09-11');
  moved.recommendations[0].tradePlan.maxEntryPrice=12;
  const episode=evaluate([first,moved],[daily('2026-09-11')]).episodes[0];
  assert.equal(episode.planConflict,true);
  assert.equal(episode.execution.status,'unverified');
  assert.equal(episode.plan.maxEntryPrice,10.5);
});

test('same mature cohort stays fixed within each independent observation clock', () => {
  const first=allowed('first');
  const second=allowed('second','2026-09-11');
  second.recommendations[0].planId='plan-two';
  second.recommendations[0].triggerEvent.id='trigger-two';
  second.recommendations[0].triggerEvent.occurredAt='2026-09-11T15:00:00+08:00';
  second.recommendations[0].tradePlan.earliestBuyDate='2026-09-14';
  const result=evaluate([first,second],[daily('2026-09-11'),daily('2026-09-14'),daily('2026-09-15'),daily('2026-09-16')],
    '2026-09-16',[1,3]);
  assert.equal(result.cohorts.publication.count,2);
  assert.equal(result.cohorts.trigger.count,2);
  assert.equal(result.cohorts.execution.count,1);
  assert.deepEqual(result.cohorts.execution.episodeIds,[result.episodes[0].episodeId]);
  assert.equal(result.cohorts.execution.horizons[1].count,1);
  assert.equal(result.cohorts.execution.horizons[3].count,1);
  assert.equal(result.horizonSummaries[1].observations.count,2);
  assert.equal(result.pairedWindows['1/3/5'],undefined);
});

test('1/3/5配对窗口不等待尚未成熟的60日观察', () => {
  const row=allowed('window');
  const bars=[daily('2026-09-11'),daily('2026-09-14'),daily('2026-09-15'),daily('2026-09-16'),daily('2026-09-17'),daily('2026-09-18')];
  const result=evaluate([row],bars,'2026-09-18',[1,3,5,60]);
  assert.equal(result.pairedWindows['1/3/5'].publication.count,1);
  assert.equal(result.cohorts.publication.count,0);
  assert.equal(result.horizonSummaries[60].observations.count,0);
});

test('conflicting overlay cannot taint execution costs or observations, and no costs means unverified net return', () => {
  const row=allowed();
  const bar=daily('2026-09-14',{finalClose:{date:'2026-09-14',close:8,isFinal:true,adjustment:'forward'}});
  const episode=evaluate([row],[daily('2026-09-11'),bar]).episodes[0];
  assert.equal(episode.executionObservations[1].status,'observed');
  assert.ok(episode.executionObservations[1].netReturnPct > 0);
  delete row.recommendations[0].tradePlan.costs;
  assert.equal(evaluate([row],[daily('2026-09-11'),bar]).episodes[0].executionObservations[1].status,'unverified');
});

test('revoked permission before entry blocks proxy fills without erasing earlier actual fills', () => {
  const first=allowed('first');
  const revoked=allowed('revoked');
  revoked.inputCutoffAt='2026-09-10T15:08:00+08:00';
  revoked.publishedAt='2026-09-10T15:09:00+08:00';
  revoked.recommendations[0].entryPermission='watch';
  assert.equal(evaluate([first,revoked],[daily('2026-09-11')]).episodes[0].execution.status,'unfilled');
  revoked.recommendations[0].entryPermission='allowed';
  revoked.recommendations[0].riskChecks={allowed:false};
  assert.equal(evaluate([first,revoked],[daily('2026-09-11')]).episodes[0].execution.status,'unfilled');
  const filled=allowed('filled','2026-09-11');
  filled.inputCutoffAt='2026-09-11T10:02:00+08:00';
  filled.publishedAt='2026-09-11T10:03:00+08:00';
  filled.recommendations[0].executionEvidence={type:'fill',status:'filled',orderId:'one',quantity:100,
    verified:true,source:'fill',planId:'plan-one',revision:1,triggerEventId:'trigger-one',
    at:'2026-09-11T10:00:00+08:00',price:10.2,earliestSellDate:'2026-09-14'};
  const later=allowed('later','2026-09-11');
  later.recommendations[0].invalidated=true;
  later.recommendations[0].invalidatedAt='2026-09-11T10:05:00+08:00';
  assert.equal(evaluate([first,filled,later],[daily('2026-09-11')]).episodes[0].execution.status,'executable');
});

test('the same stable trigger event across revisions is not a second executable opportunity', () => {
  const first=allowed('first');
  const revision=allowed('revision');
  revision.recommendations[0].revision=2;
  const result=evaluate([first,revision],[daily('2026-09-11'),daily('2026-09-14')]);
  assert.equal(result.counts.triggers,1);
  assert.equal(result.counts.execution.executable,1);
  assert.equal(result.episodes[1].triggerEvents.length,0);
});

test('intraday expiry and flattened parent ledger plan fields are enforced', () => {
  const row=allowed();
  const item=row.recommendations[0];
  item.planRevision=item.revision;
  delete item.revision;
  item.costAssumptions=item.tradePlan.costs;
  delete item.tradePlan.costs;
  item.expiresAt='2026-09-11T09:29:00+08:00';
  assert.equal(evaluate([row],[daily('2026-09-11')]).episodes[0].execution.status,'unfilled');
  item.expiresAt='2026-09-11T10:00:00+08:00';
  assert.equal(evaluate([row],[daily('2026-09-11')]).episodes[0].execution.status,'executable');
});

test('entry after terminal event in another revision is rejected, including model changes', () => {
  const first=allowed('first');
  const terminal=allowed('terminal');
  terminal.publishedAt='2026-09-10T15:15:00+08:00';
  terminal.inputCutoffAt='2026-09-10T15:14:00+08:00';
  terminal.recommendations[0].revision=2;
  terminal.recommendations[0].terminalState='invalidated';
  terminal.recommendations[0].invalidatedAt='2026-09-10T15:10:00+08:00';
  const result=evaluate([first,terminal],[daily('2026-09-11')]);
  assert.equal(result.counts.execution.executable,0);
  const newVersion=allowed('new-version');
  newVersion.publishedAt='2026-09-10T15:20:00+08:00';
  newVersion.inputCutoffAt='2026-09-10T15:19:00+08:00';
  newVersion.modelVersion='other';
  assert.equal(evaluate([terminal,newVersion],[daily('2026-09-11')]).counts.execution.executable,0);
});

test('ambiguous daily stop/target order keeps price observation but never claims net executable exit', () => {
  const row=allowed();
  Object.assign(row.recommendations[0].tradePlan,{invalidationPrice:9.8,targetPrice:10.8});
  const episode=evaluate([row],[daily('2026-09-11'),daily('2026-09-14',{high:11,low:9.5,close:10})]).episodes[0];
  assert.equal(episode.executionObservations[1].status,'unverified');
  assert.equal(episode.executionObservations[1].priceStatus,'observed');
  assert.equal(episode.executionObservations[1].exitAmbiguity,true);
  assert.ok(episode.executionObservations[1].returnPct < 0);
  assert.equal(episode.executionObservations[1].netReturnPct,null);
});

test('actual fill fees replace estimated entry costs and nonfinal exit bars do not mature execution', () => {
  const row=allowed();
  row.publishedAt='2026-09-11T10:05:00+08:00';
  row.inputCutoffAt='2026-09-11T10:04:00+08:00';
  row.recommendations[0].executionEvidence={type:'fill',status:'filled',orderId:'one',quantity:100,
    fees:{total:5},verified:true,source:'fill',planId:'plan-one',revision:1,triggerEventId:'trigger-one',
    at:'2026-09-11T10:00:00+08:00',price:10.2,earliestSellDate:'2026-09-14'};
  const episode=evaluate([row],[daily('2026-09-11'),daily('2026-09-14')]).episodes[0];
  assert.ok(Math.abs(episode.executionObservations[1].netReturnPct - (10.5 * .998 / 10.25 - 1) * 100) < .000001);
  assert.equal(evaluate([row],[daily('2026-09-11'),daily('2026-09-14',{isFinal:undefined})]).episodes[0].executionObservations[1].status,'unverified');
});

test('compatible final report preserves complete daily OHLCV without another observation revision', () => {
  const bar=daily('2026-09-11',{source:'historical'});
  const history={source:'historical',bars:[bar]};
  const merged=mergeSavedReportCloses(new Map([['600001',history]]),[{tradeDate:'2026-09-11',recommendations:{all:[
    {code:'600001',closePrice:10.5,dataStatus:'完整'}
  ]}}],{asOfDate:'2026-09-15'});
  assert.equal(merged.added,0);
  assert.deepEqual(merged.conflicts,[]);
  assert.deepEqual(merged.histories.get('600001'),history);
});

test('actual fill replaces quote proxy in the same plan without creating another entry clock', () => {
  const quote=allowed('quote','2026-09-11');
  quote.inputCutoffAt='2026-09-11T10:02:00+08:00';
  quote.publishedAt='2026-09-11T10:03:00+08:00';
  quote.recommendations[0].executionEvidence={type:'quote',verified:true,source:'snapshot',executable:true,
    liquidityVerified:true,capitalAvailable:true,planId:'plan-one',revision:1,triggerEventId:'trigger-one',
    at:'2026-09-11T10:01:00+08:00',price:10.2,earliestSellDate:'2026-09-14'};
  const fill=JSON.parse(JSON.stringify(quote));
  fill.batchId='fill';
  fill.inputCutoffAt='2026-09-11T10:04:00+08:00';
  fill.publishedAt='2026-09-11T10:05:00+08:00';
  Object.assign(fill.recommendations[0].executionEvidence,{type:'fill',status:'filled',orderId:'one',quantity:100,
    at:'2026-09-11T10:03:00+08:00',price:10.3});
  const result=evaluate([allowed('published'),quote,fill],[daily('2026-09-11'),daily('2026-09-14')]);
  assert.equal(result.episodes.length,1);
  assert.equal(result.counts.execution.executable,1);
  assert.equal(result.episodes[0].execution.basis,'verified-fill');
  assert.equal(result.episodes[0].execution.entryPrice,10.3);
});

test('forward sample count deduplicates stable plans and ignores mature publication-only proxies', () => {
  let asOfDate='2026-09-10';
  for (let index=0;index<25;index++) asOfDate=nextTradingDay(asOfDate);
  const row={code:'600001',planId:'one-plan',track:'B',modelVersion:'new',tradeDate:'2026-09-11',
    execution:{status:'executable',verified:true,entryDate:'2026-09-14',earliestSellDate:'2026-09-15'},
    executionObservations:{5:{status:'observed',date:'2026-09-21',netReturnPct:1}}};
  const episodes=Array.from({length:30},(_,index)=>({...row,episodeId:`revision-${index}`}));
  episodes.push({...row,planId:'publication-only',episodeId:'old',execution:{status:'executable'},
    executionObservations:undefined,observations:{5:{status:'observed'}}});
  const result=assessForwardValidation({episodes},{freezeDate:'2026-09-10',modelVersion:'new',asOfDate});
  assert.equal(result.routes.B.mature,1);
  assert.equal(result.routes.B.readyForComparison,false);
});

test('late-recorded actual fill before terminal invalidation remains factual execution', () => {
  const first=allowed('first');
  const terminal=allowed('terminal','2026-09-11');
  terminal.inputCutoffAt='2026-09-11T10:06:00+08:00';
  terminal.publishedAt='2026-09-11T10:07:00+08:00';
  terminal.recommendations[0].entryPermission='blocked';
  terminal.recommendations[0].invalidatedAt='2026-09-11T10:05:00+08:00';
  const recorded=allowed('recorded','2026-09-11');
  recorded.recommendations[0].entryPermission='blocked';
  recorded.recommendations[0].executionEvidence={type:'fill',status:'filled',orderId:'one',quantity:100,
    verified:true,source:'fill',planId:'plan-one',revision:1,triggerEventId:'trigger-one',
    at:'2026-09-11T10:00:00+08:00',price:10.3,earliestSellDate:'2026-09-14'};
  const episode=evaluate([first,terminal,recorded],[daily('2026-09-11')]).episodes[0];
  assert.equal(episode.terminalState,'blocked');
  assert.equal(episode.execution.basis,'verified-fill');
  assert.equal(episode.execution.entryPrice,10.3);
});
