const test = require('node:test');
const assert = require('node:assert/strict');
const {advanceEntryPlan,planFeasibility,summarizeEntryPlans} = require('../lib/entry-plans');

const input = () => ({code:'600001',track:'B',modelVersion:'test',tradeDate:'2026-10-08',cutoffAt:'2026-10-08T15:01:00+08:00',
  analysis:{tradeDate:'2026-10-08',firstPullback:true,supportPrice:9,breakoutContext:{breakoutLevel:9},
    observationPhase:{phase:'closed'},entryAssessment:{allowed:false,status:'首次回踩'},
    tradePlan:{targetEvidence:{status:'verified',nearestResistance:13.5},maxEntryPrice:10.5,stressExitPrice:8.8,
      entryLow:9.5,entryHigh:10.5,transactionCostPct:.2,invalidationPrice:9,confirmationPrice:10,entryExpiryDate:'2026-10-12'}},
  quote:{price:10,tradeDate:'2026-10-08',quoteObservedAt:'2026-10-08T15:00:00+08:00'},signalBar:{high:10.1},
  marketRegime:{allowNewEntry:true},riskProfile:{status:'clear'}});

test('首次回踩冻结价格与期限，完整下一交易日5分钟确认才触发',()=>{
  const first=advanceEntryPlan(null,input());
  assert.equal(first.state,'armed');
  const next={...input(),tradeDate:'2026-10-09',cutoffAt:'2026-10-09T10:10:00+08:00',
    quote:{price:10.2,tradeDate:'2026-10-09',quoteObservedAt:'2026-10-09T10:10:00+08:00'},
    analysis:{...input().analysis,tradeDate:'2026-10-09',tradePlan:{...input().analysis.tradePlan,confirmationPrice:20}}};
  assert.equal(advanceEntryPlan(first,next).state,'armed');
  const triggered=advanceEntryPlan(first,{...next,minuteBars:[{tradeDate:'2026-10-09',closedAt:'2026-10-09T10:05:00+08:00',close:10.2,low:9.5,isFinal:true}]});
  assert.equal(triggered.state,'allowed');
  assert.equal(triggered.tradePlan.confirmationPrice,10.1);
  assert.equal(triggered.planId,first.planId);
  assert.equal(triggered.earliestBuyDate,'2026-10-09');
  assert.equal(triggered.earliestSellDate,'2026-10-12');
  const again=advanceEntryPlan(triggered,{...next,cutoffAt:'2026-10-09T10:11:00+08:00',minuteBars:[{tradeDate:'2026-10-09',closedAt:'2026-10-09T10:05:00+08:00',close:10.2,low:9.5,isFinal:true}]});
  assert.equal(again.events.length,triggered.events.length);
});

test('冻结计划价格区间无交集时保持观察，不能进入 armed 或 allowed',()=>{
  const base=input();
  const breakout={...base,analysis:{...base.analysis,firstPullback:false,tradePlan:{...base.analysis.tradePlan,
    setupType:'突破确认',confirmationPrice:11,maxEntryPrice:10.5}}};
  const first=advanceEntryPlan(null,breakout);
  assert.equal(first.state,'watch');
  assert.equal(first.currentPermission,'watch');
  assert.equal(first.feasibility.status,'empty');
  const pullback={...base,analysis:{...base.analysis,tradePlan:{...base.analysis.tradePlan,
    entryLow:10.6,entryHigh:11,maxEntryPrice:10.5}}};
  const second=advanceEntryPlan(null,pullback);
  assert.equal(second.state,'watch');
  assert.equal(second.feasibility.status,'empty');
});

test('缺失真实目标不以情景目标放行，回踩确认价不能越过区间上限',()=>{
  const plan=input().analysis.tradePlan;
  assert.equal(planFeasibility({...plan,targetEvidence:{status:'missing',nearestResistance:13.5}},'回踩低吸').status,'unknown');
  assert.equal(planFeasibility({...plan,confirmationPrice:11},'回踩低吸').status,'empty');
  assert.equal(planFeasibility({...plan,targetEvidence:{status:'verified',nearestResistance:10.4}},'回踩低吸').status,'empty');
});

test('计划漏斗区分历史触发、当前许可和未核验成交',()=>{
  const first=advanceEntryPlan(null,input());
  const unavailable=advanceEntryPlan(null,{...input(),analysis:{...input().analysis,
    tradePlan:{...input().analysis.tradePlan,entryLow:11}}});
  const summary=summarizeEntryPlans([{planState:first},{planState:unavailable},{}]);
  assert.equal(summary.discovered,3);
  assert.equal(summary.dataAvailable,2);
  assert.equal(summary.structureEstablished,2);
  assert.equal(summary.priceFeasible,1);
  assert.equal(summary.riskPassed,1);
  assert.equal(summary.currentlyAllowed,0);
  assert.equal(summary.verifiedFills,null);
  assert.ok(Object.keys(summary.reasons).length >= 1);
});

test('触发后的旧许可在价格失效时撤销，历史触发仍可审计',()=>{
  const first=advanceEntryPlan(null,input());
  const allowed=advanceEntryPlan(first,{...input(),tradeDate:'2026-10-09',cutoffAt:'2026-10-09T10:10:00+08:00',
    quote:{price:10.2,tradeDate:'2026-10-09',quoteObservedAt:'2026-10-09T10:10:00+08:00',source:'fixture'},
    minuteBars:[{tradeDate:'2026-10-09',closedAt:'2026-10-09T10:05:00+08:00',close:10.2,low:9.5,isFinal:true,source:'fixture'}]});
  assert.equal(allowed.currentPermission,'allowed');
  const stale=advanceEntryPlan(allowed,{...input(),tradeDate:'2026-10-09',cutoffAt:'2026-10-09T10:20:00+08:00',
    quote:{price:10.7,tradeDate:'2026-10-09',quoteObservedAt:'2026-10-09T10:20:00+08:00'},minuteBars:[]});
  assert.equal(stale.currentPermission,'watch');
  assert.ok(stale.triggeredAt);
});

test('过期计划不复活，越价和未来未完成分时不触发',()=>{
  const first=advanceEntryPlan(null,input());
  const next={...input(),tradeDate:'2026-10-13',cutoffAt:'2026-10-13T10:00:00+08:00'};
  const expired=advanceEntryPlan(first,next);
  assert.equal(expired.state,'expired');
  assert.equal(advanceEntryPlan(expired,next).state,'expired');
  const over=advanceEntryPlan(first,{...input(),tradeDate:'2026-10-09',cutoffAt:'2026-10-09T10:00:00+08:00',
    quote:{price:11,tradeDate:'2026-10-09',quoteObservedAt:'2026-10-09T10:00:00+08:00'},
    minuteBars:[{tradeDate:'2026-10-09',closedAt:'2026-10-09T10:05:00+08:00',close:11,low:9.5,isFinal:true}]});
  assert.equal(over.state,'armed');
  assert.match(over.reason,/上限/);
});

test('触发时刻不得倒填，当前已跌回确认价下方不能借早先K线触发',()=>{
  const first=advanceEntryPlan(null,input());
  const next={...input(),tradeDate:'2026-10-09',cutoffAt:'2026-10-09T10:10:00+08:00',
    quote:{price:10.2,tradeDate:'2026-10-09',quoteObservedAt:'2026-10-09T10:10:00+08:00',source:'test'},
    minuteBars:[{tradeDate:'2026-10-09',closedAt:'2026-10-09T10:05:00+08:00',close:10.2,low:9.5,isFinal:true,source:'test'}]};
  const triggered=advanceEntryPlan(first,next);
  assert.equal(triggered.triggeredAt,next.cutoffAt);
  assert.equal(triggered.decisionEvent.planId,first.planId);
  assert.equal(triggered.decisionEvent.referencePrice,10.2);
  assert.equal(triggered.decisionEvent.verified,true);
  assert.equal(triggered.tradePlan.frozenAt,first.createdAt);
  assert.equal(triggered.tradePlan.planId,first.planId);
  assert.equal(advanceEntryPlan(first,{...next,quote:{...next.quote,price:10}}).state,'armed');
});

test('已触发计划不因证据暂缺重建触发，实际行情破位仍进入终态',()=>{
  const first=advanceEntryPlan(null,input());
  const next={...input(),tradeDate:'2026-10-09',cutoffAt:'2026-10-09T10:10:00+08:00',
    quote:{price:10.2,tradeDate:'2026-10-09',quoteObservedAt:'2026-10-09T10:10:00+08:00'},
    minuteBars:[{tradeDate:'2026-10-09',closedAt:'2026-10-09T10:05:00+08:00',close:10.2,low:9.5,isFinal:true}]};
  const triggered=advanceEntryPlan(first,next);
  const missing=advanceEntryPlan(triggered,{...next,cutoffAt:'2026-10-09T10:20:00+08:00',minuteBars:[]});
  assert.equal(missing.events.filter(row=>row.type==='entry-allowed').length,1);
  assert.equal(missing.currentPermission,'watch');
  const blocked=advanceEntryPlan(missing,{...next,cutoffAt:'2026-10-09T10:21:00+08:00',
    quote:{...next.quote,price:8,quoteObservedAt:'2026-10-09T10:21:00+08:00'}});
  assert.equal(blocked.state,'blocked');
});

test('60分钟回踩只接受结构完成后的完整5分钟K线，且不复用日线计划ID',()=>{
  const base=input();
  const intradayStructure={algorithmVersion:'range-retest-60m-v1',state:'retest-confirmed',basis:'raw',
    source:'fixture',boxUpper:10,boxLower:9.5,departureAt:'2026-10-09T10:30:00+08:00',
    structureReadyAt:'2026-10-09T11:30:00+08:00',confirmationPrice:10.1,
    invalidationPrice:9.7,evidenceHash:'evidence-a'};
  const next={...base,tradeDate:'2026-10-09',cutoffAt:'2026-10-09T13:15:00+08:00',
    intradayStructure,analysis:{...base.analysis,tradeDate:'2026-10-09',firstPullback:false,
      tradePlan:{...base.analysis.tradePlan,setupType:'range-retest-60m-v1'}},
    quote:{price:10.2,tradeDate:'2026-10-09',quoteObservedAt:'2026-10-09T13:15:00+08:00',source:'fixture'},
    minuteBars:[{tradeDate:'2026-10-09',closedAt:'2026-10-09T11:25:00+08:00',close:10.2,low:9.9,isFinal:true,source:'fixture'}]};
  const waiting=advanceEntryPlan(null,next);
  assert.equal(waiting.setup,'range-retest-60m-v1');
  assert.notEqual(waiting.currentPermission,'allowed');
  assert.equal(waiting.tradePlan.invalidationPrice,9.7);
  assert.equal(waiting.structureReadyAt,intradayStructure.structureReadyAt);
  assert.notEqual(waiting.planId,advanceEntryPlan(null,base).planId);
  const triggered=advanceEntryPlan(waiting,{...next,cutoffAt:'2026-10-09T13:20:00+08:00',
    quote:{...next.quote,quoteObservedAt:'2026-10-09T13:20:00+08:00'},
    minuteBars:[{tradeDate:'2026-10-09',closedAt:'2026-10-09T13:15:00+08:00',close:10.2,low:9.9,isFinal:true,source:'fixture'}]});
  assert.equal(triggered.currentPermission,'allowed');
  assert.equal(triggered.earliestBuyDate,'2026-10-09');
  assert.equal(triggered.earliestSellDate,'2026-10-12');
  const broken=advanceEntryPlan(waiting,{...next,cutoffAt:'2026-10-09T13:21:00+08:00',
    intradayStructure:{...intradayStructure,state:'invalid'},
    quote:{...next.quote,quoteObservedAt:'2026-10-09T13:21:00+08:00'},minuteBars:[]});
  assert.equal(broken.state,'blocked');
  const tomorrow={...next,tradeDate:'2026-10-12',cutoffAt:'2026-10-12T10:05:00+08:00',
    analysis:{...next.analysis,tradeDate:'2026-10-12'},
    quote:{...next.quote,tradeDate:'2026-10-12',quoteObservedAt:'2026-10-12T10:05:00+08:00'}};
  assert.equal(advanceEntryPlan(broken,tomorrow).planId,broken.planId);
  const newStructure={...intradayStructure,evidenceHash:'evidence-b',structureReadyAt:'2026-10-12T10:00:00+08:00'};
  assert.notEqual(advanceEntryPlan(broken,{...tomorrow,intradayStructure:newStructure}).planId,broken.planId);
});
