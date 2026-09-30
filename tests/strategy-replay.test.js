const test=require('node:test');
const assert=require('node:assert/strict');
const {replayStrategies,replayPortfolio}=require('./strategy-replay.cjs');

test('回放只在信号后下一交易日成交并显式扣除成本',()=>{
  const report=replayStrategies({signals:[{code:'600001',tradeDate:'2026-09-10',signal:'待突破'}],feeRate:.001,slippageBps:10,
    horizons:[1,3],prices:[
      {code:'600001',date:'2026-09-10',open:5,close:20},
      {code:'600001',date:'2026-09-11',open:10,close:11,upperLimit:11},
      {code:'600001',date:'2026-09-14',open:11,close:12},
      {code:'600001',date:'2026-09-15',open:12,close:13},
      {code:'600001',date:'2026-09-16',open:13,close:13.5}
    ]});
  assert.equal(report.trades[0].entryDate,'2026-09-11');
  assert.ok(report.trades[0].outcomes[1] > 15 && report.trades[0].outcomes[1] < 20);
  assert.ok(report.trades[0].outcomes[3] > 30 && report.trades[0].outcomes[3] < 35);
  assert.equal(report.metrics[3].count,1);
  assert.equal('maxDrawdown' in report.metrics[3],false);
  assert.ok(Number.isFinite(report.metrics[3].worstReturn));
});

test('账户回放按日净值计算回撤并遵守持仓数和A股整手约束',()=>{
  const prices=[
    {code:'600001',date:'2026-09-11',open:10,close:9,upperLimit:11},
    {code:'600001',date:'2026-09-14',open:9,high:9,close:8,lowerLimit:7.2},
    {code:'600002',date:'2026-09-11',open:20,close:22,upperLimit:22},
    {code:'600002',date:'2026-09-14',open:21,high:24,close:24,lowerLimit:19.8}
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

test('UTC时间跨过北京时间午夜的发布信号不能提前一日买入',()=>{
  const report=replayStrategies({signals:[{code:'600001',tradeDate:'2026-09-10',publishedAt:'2026-09-10T16:30:00Z'}],
    prices:[{code:'600001',date:'2026-09-11',open:10,close:10,upperLimit:11},
      {code:'600001',date:'2026-09-14',open:10.2,close:10.3,upperLimit:11.2}],
    feeRate:0,slippageBps:0,horizons:[1]});
  assert.equal(report.trades[0].entryDate,'2026-09-14');
});

test('次日一字涨停和缺限价证据不计为可成交，重复信号不重复建仓',()=>{
  const prices=[
    {code:'600001',date:'2026-09-11',open:11,high:11,low:11,close:11,upperLimit:11},
    {code:'600002',date:'2026-09-11',open:10,close:10.5,upperLimit:11},
    {code:'600002',date:'2026-09-14',open:10.5,high:10.8,close:10.8,lowerLimit:9.45},
    {code:'600003',date:'2026-09-11',open:10,close:10.5}
  ];
  const signals=['600001','600002','600002','600003'].map(code=>({code,tradeDate:'2026-09-10'}));
  const observations=replayStrategies({signals,prices,feeRate:0,slippageBps:0});
  assert.deepEqual(observations.unfilled.map(row=>row.reason),['limit-up-not-buyable','limit-price-unverified']);
  const portfolio=replayPortfolio({signals,prices,feeRate:0,slippageBps:0,initialCapital:10000,maxPositions:2,holdingDays:1});
  assert.equal(portfolio.fills.filter(row=>row.side==='buy').length,1);
  assert.ok(portfolio.rejected.some(row=>row.reason==='already-held'));
});

test('跌停封死延后退出，回放保留未平仓和每日净值',()=>{
  const prices=[
    {code:'600001',date:'2026-09-11',open:10,close:10,upperLimit:11},
    {code:'600001',date:'2026-09-14',open:9,high:9,close:9,lowerLimit:9},
    {code:'600001',date:'2026-09-15',open:8.5,high:9,close:8.8,lowerLimit:8.1}
  ];
  const result=replayPortfolio({signals:[{code:'600001',tradeDate:'2026-09-10'}],prices,
    feeRate:0,slippageBps:0,initialCapital:10000,maxPositions:1,holdingDays:1});
  assert.equal(result.fills.find(row=>row.side==='sell').date,'2026-09-15');
  assert.equal(result.openPositions.length,0);
  assert.ok(result.equityCurve.some(row=>row.date==='2026-09-14' && row.positions===1));
});

test('盘中打开但收盘封跌停不能按收盘价模拟卖出',()=>{
  const prices=[
    {code:'600001',date:'2026-09-11',open:10,close:10,upperLimit:11},
    {code:'600001',date:'2026-09-14',open:9.2,high:9.5,close:9,lowerLimit:9},
    {code:'600001',date:'2026-09-15',open:9.1,high:9.4,close:9.3,lowerLimit:8.1}
  ];
  const result=replayPortfolio({signals:[{code:'600001',tradeDate:'2026-09-10'}],prices,
    feeRate:0,slippageBps:0,initialCapital:10000,maxPositions:1,holdingDays:1});
  assert.equal(result.fills.find(row=>row.side==='sell').date,'2026-09-15');
  assert.ok(result.equityCurve.some(row=>row.date==='2026-09-14' && row.positions===1));
});
