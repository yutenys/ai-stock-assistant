const test=require('node:test');
const assert=require('node:assert/strict');
const {replayStrategies}=require('./strategy-replay.cjs');

test('回放只在信号后下一交易日成交并显式扣除成本',()=>{
  const report=replayStrategies({signals:[{code:'600001',tradeDate:'2026-09-10',signal:'待突破'}],feeRate:.001,slippageBps:10,
    horizons:[1,3],prices:[
      {code:'600001',date:'2026-09-10',open:5,close:20},
      {code:'600001',date:'2026-09-11',open:10,close:11},
      {code:'600001',date:'2026-09-14',open:11,close:12},
      {code:'600001',date:'2026-09-15',open:12,close:13}
    ]});
  assert.equal(report.trades[0].entryDate,'2026-09-11');
  assert.ok(report.trades[0].outcomes[1] < 10);
  assert.ok(report.trades[0].outcomes[3] < 30);
  assert.equal(report.metrics[3].count,1);
});

test('回放拒绝隐含费用并排除没有未来成交数据的信号',()=>{
  assert.throws(()=>replayStrategies({}),/必须显式提供/);
  const report=replayStrategies({signals:[{code:'600001',tradeDate:'2026-09-10'}],prices:[],feeRate:0,slippageBps:0});
  assert.equal(report.trades.length,0);
  assert.equal(report.excluded,1);
});
