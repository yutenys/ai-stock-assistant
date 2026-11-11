const test = require('node:test');
const assert = require('node:assert/strict');
const {selectShortReboundCandidates} = require('../lib/short-rebound-selection');

const tradeDate = '2026-11-09';

function candidate(code, overrides = {}) {
  code=String(code).padStart(6,'0');
  const theme = overrides.theme || `主题${code}`;
  return {
    code, name:`股票${code}`, price:10, tradeDate,
    riskProfile:{status:'clear'}, newsLabel:'消息中性',
    rotationProfiles:[{name:theme,mainNetInflow:2e8,capitalTradeDate:tradeDate,capitalEstimated:false,capitalStale:false,
      upRatio:.7,participation:{coverage:.8,exTop3UpRatio:.65}}],
    fundFlowPeriod:{available:true,complete:true,estimated:false,mainNetInflow:3e8,positiveDays:7,
      current:{mainNetInflow:2e7,tradeDate,estimated:false}},
    shortRebound:{matched:true,state:'condition-pending',route:'R2',score:80,executionScore:70,
      tradeDate,resistance:10.5,invalidation:9.85,observedAt:'2026-11-09T07:10:00.000Z'},
    analysis:{resistanceLevels:[10.4,10.8]},
    ...overrides
  };
}

test('精选最多三只且同一真实主题最多一只', () => {
  const rows = [candidate('1',{theme:'半导体'}),candidate('2',{theme:'半导体'}),candidate('3'),candidate('4'),candidate('5')];
  const result = selectShortReboundCandidates(rows,{tradeDate,marketRegime:{allowNewEntry:true},observedAt:'2026-11-09T07:10:00.000Z'});
  assert.equal(result.selected.length,3);
  assert.equal(result.selected.filter(row=>row.shortReboundSelection.theme === '半导体').length,1);
  assert.equal(result.selected[0].shortRebound.tradePlan.shadowOnly,true);
  assert.ok(result.selected[0].shortRebound.tradePlan.rewardRisk >= 2);
  assert.equal(result.selected[0].shortRebound.tradePlan.planVersion,'short-rebound-selective-v31');
  assert.equal(result.selected[0].shortReboundSelection.firstPublishedAt,'2026-11-09T07:10:00.000Z');
  assert.ok(result.watch.length >= 2);
});

test('同源真实多窗口汇总可替代逐日完整性但不编造流入天数', () => {
  const row=candidate('1',{fundFlowPeriod:{available:true,complete:false,aggregateOnly:true,estimated:false,
    mainNetInflow:3e8,positiveDays:null,source:'东方财富批量主力资金（真实多日累计）',
    current:{mainNetInflow:2e7,mainNet3:5e7,mainNet5:8e7,mainNet10:3e8,tradeDate,estimated:false,source:'东方财富批量主力资金'}}});
  const result=selectShortReboundCandidates([row],{tradeDate,marketRegime:{allowNewEntry:true}});
  assert.equal(result.selected.length,1);
  assert.equal(result.selected[0].fundFlowPeriod.positiveDays,null);
});

test('滚动资金总额不能掩盖最近非重叠窗口流出', () => {
  const row=candidate('1',{fundFlowPeriod:{available:true,complete:false,aggregateOnly:true,estimated:false,
    source:'东方财富批量主力资金（真实多日累计）',
    current:{mainNetInflow:8e7,mainNet3:5e7,mainNet5:9e7,mainNet10:2e8,tradeDate,estimated:false,
      source:'东方财富批量主力资金'}}});
  const result=selectShortReboundCandidates([row],{tradeDate,marketRegime:{allowNewEntry:true}});
  assert.equal(result.selected.length,0);
  assert.ok(result.watch[0].shortReboundSelection.reasons.includes('阶段个股资金未形成非重叠窗口持续流入证据'));
  assert.equal(result.watch[0].shortReboundSelection.fundWindows.latest,8e7);
  assert.equal(result.watch[0].shortReboundSelection.fundWindows.prior2,-3e7);
});

test('止损损失按入场价计算且R2使用回踩确认文案', () => {
  const row=candidate('1',{shortRebound:{...candidate('1').shortRebound,resistance:10.8,invalidation:9.72},analysis:{resistanceLevels:[10.8]}});
  const result=selectShortReboundCandidates([row],{tradeDate,marketRegime:{allowNewEntry:true}});
  assert.equal(result.selected.length,1);
  assert.equal(result.selected[0].shortReboundSelection.pressureLossPct,3);
  assert.match(result.selected[0].shortRebound.tradePlan.trigger,/回踩支撑/);
  assert.doesNotMatch(result.selected[0].shortRebound.tradePlan.trigger,/1\.5-4\.0/);
});

test('风险未知原因和完整漏斗必须保留', () => {
  const row=candidate('1',{riskProfile:{status:'unknown',reasonCode:'request-failed',summary:'接口超时'}});
  const result=selectShortReboundCandidates([row],{tradeDate,marketRegime:{allowNewEntry:true}});
  assert.equal(result.selected.length,0);
  assert.equal(result.summary.funnel.total,1);
  assert.equal(result.summary.funnel.dataPending,1);
  assert.equal(result.summary.funnel.opportunityRejected,0);
  assert.equal(result.watch[0].shortReboundSelection.riskEvidence.reasonCode,'request-failed');
});

test('跨交易日保留首次发布记录但重置当日新增预算', () => {
  const first=selectShortReboundCandidates([candidate('1')],{tradeDate,marketRegime:{allowNewEntry:true},
    observedAt:'2026-11-09T07:10:00.000Z'});
  const nextDate='2026-11-10';
  const nextCandidate={...candidate('2'),tradeDate:nextDate,
    rotationProfiles:[{...candidate('2').rotationProfiles[0],capitalTradeDate:nextDate}],
    fundFlowPeriod:{...candidate('2').fundFlowPeriod,current:{...candidate('2').fundFlowPeriod.current,tradeDate:nextDate}},
    shortRebound:{...candidate('2').shortRebound,tradeDate:nextDate}};
  const second=selectShortReboundCandidates([nextCandidate],{tradeDate:nextDate,marketRegime:{allowNewEntry:true},
    observedAt:'2026-11-10T07:10:00.000Z',previousState:first.publicationState});
  assert.equal(second.selected.length,1);
  assert.equal(second.publicationState.published.length,2);
  assert.equal(second.publicationState.dailyPublishedCodes.length,1);
  assert.equal(second.summary.publishedToday,1);
});

test('发布预算使用上海日期且过期episode不阻止新episode', () => {
  const previousState={published:[{code:'000001',theme:'半导体',route:'R2',
    firstPublishedAt:'2026-11-08T16:10:00.000Z',expiresOn:'2026-11-10',status:'active'}]};
  const current={...candidate('1'),tradeDate:'2026-11-11',
    rotationProfiles:[{...candidate('1').rotationProfiles[0],capitalTradeDate:'2026-11-11'}],
    fundFlowPeriod:{...candidate('1').fundFlowPeriod,current:{...candidate('1').fundFlowPeriod.current,tradeDate:'2026-11-11'}},
    shortRebound:{...candidate('1').shortRebound,tradeDate:'2026-11-11'}};
  const result=selectShortReboundCandidates([current],{
    tradeDate:'2026-11-11',observedAt:'2026-11-11T01:35:00.000Z',marketRegime:{allowNewEntry:true},previousState});
  assert.equal(result.publicationState.published[0].status,'expired');
  assert.equal(result.publicationState.published.length,2);
  assert.equal(result.publicationState.published[1].firstPublishedAt,'2026-11-11T01:35:00.000Z');
  assert.equal(result.summary.publishedToday,1);
});

test('证据缺失或收益风险比不足只进入观察层', () => {
  const missingFund = candidate('1',{fundFlowPeriod:{available:false}});
  const poorReward = candidate('2',{shortRebound:{...candidate('2').shortRebound,invalidation:9.7},analysis:{resistanceLevels:[10.1]}});
  const result = selectShortReboundCandidates([missingFund,poorReward],{tradeDate,marketRegime:{allowNewEntry:true}});
  assert.equal(result.selected.length,0);
  assert.deepEqual(result.watch.map(row=>row.code).sort(),['000001','000002']);
  assert.ok(result.watch.every(row=>row.shortReboundSelection.reasons.length));
});

test('筛选层直接使用短线结构计算出的真实阻力', () => {
  const row=candidate('1',{analysis:{resistanceLevels:[]},targetPrice:null,
    shortRebound:{...candidate('1').shortRebound,resistance:10.8,invalidation:9.72}});
  const result=selectShortReboundCandidates([row],{tradeDate,marketRegime:{allowNewEntry:true}});
  assert.equal(result.selected.length,1);
  assert.equal(result.selected[0].shortReboundSelection.resistance,10.8);
  assert.equal(result.selected[0].shortRebound.tradePlan.targetPrice,10.8);
});

test('同日刷新不重置五只新增预算且失效不返还名额', () => {
  const first = selectShortReboundCandidates([candidate('1'),candidate('2'),candidate('3')],{
    tradeDate,marketRegime:{allowNewEntry:true},observedAt:'2026-11-09T07:10:00.000Z'
  });
  const second = selectShortReboundCandidates([candidate('4'),candidate('5'),candidate('6')],{
    tradeDate,marketRegime:{allowNewEntry:true},observedAt:'2026-11-09T07:20:00.000Z',previousState:first.publicationState
  });
  assert.equal(second.selected.length,2);
  assert.equal(second.publicationState.published.length,5);
  const third = selectShortReboundCandidates([candidate('7')],{
    tradeDate,marketRegime:{allowNewEntry:true},observedAt:'2026-11-09T07:30:00.000Z',previousState:second.publicationState
  });
  assert.equal(third.selected.length,0);
  assert.equal(third.publicationState.published.length,5);
});

test('同股刷新不抬高冻结入场上限且越价降为观察', () => {
  const first=selectShortReboundCandidates([candidate('1')],{tradeDate,marketRegime:{allowNewEntry:true},observedAt:'2026-11-09T07:10:00.000Z'});
  const second=selectShortReboundCandidates([candidate('1',{price:10.2})],{tradeDate,marketRegime:{allowNewEntry:true},
    observedAt:'2026-11-09T07:20:00.000Z',previousState:first.publicationState});
  assert.equal(second.selected.length,0);
  assert.equal(second.watch[0].shortRebound.tradePlan.maxEntryPrice,10);
  assert.ok(second.watch[0].shortReboundSelection.reasons.includes('现价超过首次发布冻结入场上限'));
});

test('大盘不允许新开仓时候选仅观察', () => {
  const result = selectShortReboundCandidates([candidate('1')],{tradeDate,marketRegime:{allowNewEntry:false}});
  assert.equal(result.selected.length,0);
  assert.equal(result.watch[0].shortReboundSelection.reasons.includes('大盘环境不允许新增入场'),true);
});

test('重复代码只占一个席位且非法代码日期不能精选', () => {
  const duplicate=selectShortReboundCandidates([candidate('1'),candidate('1')],{tradeDate,marketRegime:{allowNewEntry:true}});
  assert.equal(duplicate.selected.length,1);
  assert.equal(duplicate.selected.length+duplicate.watch.length+duplicate.history.length,1);
  const invalid=selectShortReboundCandidates([candidate('1',{code:'ABC',tradeDate:'2026-02-30',
    shortRebound:{...candidate('1').shortRebound,tradeDate:'2026-02-30'}})],{tradeDate:'2026-02-30',marketRegime:{allowNewEntry:true}});
  assert.equal(invalid.selected.length,0);
  assert.ok(invalid.watch[0].shortReboundSelection.reasons.includes('证券代码或交易日期无效'));
});
