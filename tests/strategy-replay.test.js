const test=require('node:test');
const assert=require('node:assert/strict');
const {replayStrategies,replayPortfolio}=require('./strategy-replay.cjs');

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
  assert.equal('maxDrawdown' in report.metrics[3],false);
  assert.ok(Number.isFinite(report.metrics[3].worstReturn));
});

test('账户回放按日净值计算回撤并遵守持仓数和A股整手约束',()=>{
  const prices=[
    {code:'600001',date:'2026-09-11',open:10,close:9},
    {code:'600001',date:'2026-09-14',open:9,close:8},
    {code:'600002',date:'2026-09-11',open:20,close:22},
    {code:'600002',date:'2026-09-14',open:21,close:24}
  ];
  const report=replayPortfolio({signals:[
    {code:'600001',tradeDate:'2026-09-10'},
    {code:'600002',tradeDate:'2026-09-10'}
  ],prices,feeRate:.001,slippageBps:10,initialCapital:10000,maxPositions:1,holdingDays:1});
  assert.equal(report.fills.filter(row=>row.side==='buy').length,1);
  assert.equal(report.fills[0].quantity%100,0);
  assert.equal(report.rejected[0].reason,'position-limit');
  assert.ok(report.maxDrawdown<0);
  assert.ok(report.equityCurve.every(row=>Number.isFinite(row.equity)));
});

test('账户回放拒绝隐含的资金和持仓假设',()=>{
  assert.throws(()=>replayPortfolio({feeRate:0,slippageBps:0}),/initialCapital/);
});

test('回放拒绝隐含费用并排除没有未来成交数据的信号',()=>{
  assert.throws(()=>replayStrategies({}),/必须显式提供/);
  const report=replayStrategies({signals:[{code:'600001',tradeDate:'2026-09-10'}],prices:[],feeRate:0,slippageBps:0});
  assert.equal(report.trades.length,0);
  assert.equal(report.excluded,1);
});
