const test = require('node:test');
const assert = require('node:assert/strict');
const {evaluateShortRebound, mergeShortReboundLifecycle} = require('../lib/short-rebound');

function bars({start=20, drift=.04, pullback=0, volume=100}={}) {
  return Array.from({length:80}, (_, index) => {
    const trend = start + index * drift;
    const retreat = index >= 70 ? pullback * (index - 69) / 10 : 0;
    const close = trend - retreat;
    return {date:`2026-10-${String(index + 1).padStart(2,'0')}`,open:close-.05,high:close+.18,low:close-.18,close,volume:index === 79 ? volume : 100};
  });
}

test('R2识别缩量回踩修复且保持影子权限', () => {
  const history=bars({drift:.12,pullback:.7,volume:90});
  const result=evaluateShortRebound({bars:history,quote:{changePct:1},observationPhase:{phase:'closed'}});
  assert.equal(result.matched,true);
  assert.equal(result.route,'R2');
  assert.equal(result.shadowOnly,true);
  assert.notEqual(result.state,'verified-trigger');
  assert.ok(result.missingEvidence.some(value=>value.includes('历史分钟资金未取得')));
  assert.ok(Number.isFinite(result.detectionScore) && Number.isFinite(result.executionScore));
  assert.notEqual(result.detectionScore,result.executionScore);
});

test('R1识别深回撤后低点企稳和短线修复', () => {
  const closes=[...Array.from({length:55},(_,index)=>30-index*.05),
    ...Array.from({length:20},(_,index)=>27.25-index*.35),20.3,20.2,20.35,20.7,21.1];
  const history=closes.map((close,index)=>({date:`d${index}`,open:close-.08,high:close+.18,low:close-.18,close,volume:100}));
  const result=evaluateShortRebound({bars:history,quote:{changePct:2},observationPhase:{phase:'closed'}});
  assert.equal(result.matched,true);
  assert.equal(result.route,'R1');
  assert.ok(result.evidence.some(value=>value.includes('回撤')));
});

test('R3要求板块扩散资金和个股相对强度共同确认', () => {
  const history=bars({drift:.02,volume:100});
  history.at(-1).close += .8;
  history.at(-1).high = history.at(-1).close + .18;
  const result=evaluateShortRebound({bars:history,quote:{changePct:3,tradeDate:'2026-11-09',rotationProfiles:[{
    name:'AI应用',upRatio:.72,mainNetInflow:2e8,averageChangePct:.5,rotationScore:82,capitalTradeDate:'2026-11-09'
  }]},observationPhase:{phase:'closed'}});
  assert.equal(result.matched,true);
  assert.equal(result.route,'R3');
  assert.ok(result.evidence.some(value=>value.includes('板块')));
});

test('R3不能用评分替代资金，旧资金和弱于板块均不通过', () => {
  const history=bars({drift:.02});
  history.at(-1).close+=.8;
  history.at(-1).high=history.at(-1).close+.18;
  for(const extra of [{mainNetInflow:null},{capitalTradeDate:'2026-11-06'},{capitalEstimated:true},{averageChangePct:4}]) {
    const result=evaluateShortRebound({bars:history,quote:{changePct:3,tradeDate:'2026-11-09',rotationProfiles:[{
      name:'测试',upRatio:.8,rotationScore:90,mainNetInflow:1e8,capitalTradeDate:'2026-11-09',averageChangePct:1,...extra
    }]}});
    assert.notEqual(result.route,'R3');
  }
});

test('爆量或大涨只标记过热不生成可执行结论', () => {
  const history=bars({drift:.12,pullback:.7,volume:500});
  const result=evaluateShortRebound({bars:history,quote:{changePct:9},observationPhase:{phase:'closed'}});
  assert.equal(result.matched,true);
  assert.equal(result.state,'overheated');
  assert.ok(['explosive-volume','no-chase'].includes(result.reasonCode));
});

test('跌势中继不冒充超跌首修复', () => {
  const history=bars({start:30,drift:-.2,volume:100});
  const result=evaluateShortRebound({bars:history,quote:{changePct:-2},observationPhase:{phase:'closed'}});
  assert.equal(result.matched,false);
  assert.equal(result.reasonCode,'no-repair-structure');
});

test('涨停附近即使结构匹配也只能标记过热禁追', () => {
  const history=bars({drift:.12,pullback:.7,volume:100});
  const result=evaluateShortRebound({bars:history,quote:{changePct:9.8,upperLimit:history.at(-1).close},observationPhase:{phase:'closed'}});
  assert.equal(result.matched,true);
  assert.equal(result.state,'overheated');
  assert.equal(result.reasonCode,'no-chase');
});

test('历史不足明确返回无效而非补造', () => {
  assert.deepEqual(evaluateShortRebound({bars:bars().slice(-20)}),{
    matched:false,state:'invalid',reasonCode:'history-insufficient',missingEvidence:['至少60根有效日线']
  });
});

test('生命周期保留首次发现时间并记录状态变化', () => {
  const current=[{code:'600001',shortRebound:{state:'condition-pending',observedAt:'2026-11-06T02:00:00Z'}}];
  const previous=[{code:'600001',shortRebound:{state:'observation',firstDetectedAt:'2026-11-05T02:00:00Z',stateChangedAt:'2026-11-05T02:00:00Z'}}];
  const [result]=mergeShortReboundLifecycle(current,previous);
  assert.equal(result.shortRebound.firstDetectedAt,'2026-11-05T02:00:00Z');
  assert.equal(result.shortRebound.stateChangedAt,'2026-11-06T02:00:00Z');
});
