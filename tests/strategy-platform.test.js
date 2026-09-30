const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDataEnvelope,
  detectBreakoutContext,
  buildFactorSnapshot,
  evaluateStrategyRegistry,
  evaluateResearchSetups,
  arbitrateStrategyResults,
  buildAnalysisViewModel,
  mergeEventLifecycle
} = require('../lib/strategy-platform');
const {nextTradingDay} = require('../lib/trade-time');

test('C类影子规则保留量能边界且不授予入场许可', () => {
  const rows = Array.from({length:20}, (_, index) => ({date:`2026-08-${String(index + 1).padStart(2, '0')}`,volume:100}));
  const evidence = {
    tradeDate:'2026-09-14',inputCutoffAt:'2026-09-14T15:05:00+08:00',history:[...rows,{date:'2026-09-11',volume:150},
      {date:'2026-09-14',close:11,high:11,low:10,upperLimit:11,volume:220}],
    observationPhase:{phase:'closed'},leaderPool:{complete:true,tradeDate:'2026-09-14',ruleGroup:'10%',
      availableAt:'2026-09-14T15:01:00+08:00',priorHeightWindowVerified:true,
      stocks:[{code:'600001',height:3,ruleGroup:'10%'},{code:'600002',height:2,ruleGroup:'10%'}],priorTenDayHeights:Array(10).fill(2)},
    intradayEvents:[
      {type:'opened-limit',tradeDate:'2026-09-14',at:'2026-09-14T10:00:00+08:00',price:10.9},
      {type:'resealed',tradeDate:'2026-09-14',at:'2026-09-14T10:02:00+08:00',eventId:'a',price:11},
      {type:'resealed',tradeDate:'2026-09-14',at:'2026-09-14T10:08:00+08:00',eventId:'b',price:11}]
  };
  const base = () => evaluateResearchSetups('600001',evidence).filter(row => row.id === 'leader-reversal-shadow');
  assert.equal(base()[0].status,'matched');
  assert.equal(base()[1].status,'matched');
  assert.equal(evaluateResearchSetups('600001',evidence).find(row => row.id === 'leader-catchup-combination-shadow').status,'matched');
  assert.equal(base()[0].entryPermission,'none');
  evidence.history.at(-2).volume = 149;
  assert.equal(base()[0].status,'failed');
  evidence.history.at(-2).volume = 401;
  assert.equal(base()[0].status,'matched');
  evidence.leaderPool.stocks[1].height = 3;
  assert.equal(base()[0].status,'failed');
  evidence.leaderPool.stocks[1].height = 2;
  evidence.leaderPool.complete = false;
  assert.equal(base()[0].status,'unknown');
  evidence.leaderPool.complete = true;
  evidence.leaderPool.availableAt = '2026-09-14T15:06:00+08:00';
  assert.equal(base()[0].status,'unknown');
  evidence.leaderPool.availableAt = '2026-09-14T15:01:00+08:00';
  evidence.intradayEvents = null;
  assert.equal(base()[0].status,'unknown');
  evidence.intradayEvents = [];
  evidence.observationPhase.phase = 'intraday';
  assert.notEqual(base()[0].status,'matched');
});

test('G首补二补必须有完整此前20交易日和信号时已知题材证据', () => {
  let day = '2026-08-14';
  const previousTwentyLimitUps = [];
  for (let index=0;index<20;index++) {
    previousTwentyLimitUps.push({date:day,confirmed:true,limitUp:index===3});
    day = nextTradingDay(day);
  }
  const evidence = {tradeDate:day,inputCutoffAt:`${day}T15:10:00+08:00`,previousTwentyLimitUps,observationPhase:{phase:'closed'},
    signalBar:{close:11,upperLimit:11,high:11,low:10},
    theme:{memberCoverage:1,membershipAsOf:`${day}T10:00:00+08:00`,heightScope:'theme',memberCodes:['600001'],leadingHeight:5}};
  const get = id => evaluateResearchSetups('600001',evidence).find(row => row.id === id).status;
  assert.equal(get('first-catchup-shadow'),'failed');
  assert.equal(get('second-catchup-shadow'),'matched');
  assert.notEqual(get('leader-catchup-combination-shadow'),'matched');
  evidence.sentiment={phase:'高潮',observedAt:`${day}T15:00:00+08:00`};
  assert.equal(get('leader-catchup-combination-shadow'),'matched');
  evidence.sentiment.observedAt=`${day}T15:11:00+08:00`;
  assert.notEqual(get('leader-catchup-combination-shadow'),'matched');
  evidence.previousTwentyLimitUps.pop();
  assert.equal(get('second-catchup-shadow'),'unknown');
  evidence.previousTwentyLimitUps.push({date:'2026-01-01',confirmed:true,limitUp:false});
  assert.equal(get('second-catchup-shadow'),'unknown');
  evidence.previousTwentyLimitUps.at(-1).date = previousTwentyLimitUps[18].date;
  evidence.theme.membershipAsOf = '2026-12-01T10:00:00+08:00';
  assert.notEqual(get('second-catchup-shadow'),'matched');
  assert.equal(evaluateResearchSetups('600001',evidence).find(row => row.id === 'position-guarded-shadow').status,'unknown');
  evidence.inputCutoffAt = `${day}T15:10:00+08:00`;
  evidence.exactGuard = {ruleVersion:'C7/C8-v1',source:'point-in-time',status:'pass',availableAt:`${day}T15:11:00+08:00`};
  assert.equal(get('position-guarded-shadow'),'unknown');
  evidence.exactGuard.availableAt = `${day}T15:00:00+08:00`;
  assert.equal(get('position-guarded-shadow'),'matched');
  evidence.exactGuard.status = 'unknown';
  assert.equal(get('position-guarded-shadow'),'unknown');
});

function history(start, dailyPct, count = 260) {
  const rows = [];
  let close = start;
  for (let index = 0; index < count; index++) {
    close *= 1 + dailyPct / 100;
    rows.push({date:`2026-${String(1 + Math.floor(index / 28)).padStart(2, '0')}-${String(1 + index % 28).padStart(2, '0')}`, close, volume:1000 + index});
  }
  return rows;
}

test('数据契约可同时表达部分成功和过期，缺失不等于零', () => {
  const envelope = createDataEnvelope({value:[{code:'600001'}], source:'test', observedAt:'2026-09-14T06:00:00Z', partial:true, stale:true,
    missing:['fundFlow'], errors:['timeout']});
  assert.equal(envelope.status, 'partial-stale');
  assert.equal(envelope.partial, true);
  assert.equal(envelope.stale, true);
  assert.deepEqual(envelope.missing, ['fundFlow']);
  assert.equal(createDataEnvelope({value:null, source:'test'}).status, 'missing');
});

test('完整横截面生成20至250日RPS，单样本不伪造全市场RPS', () => {
  const rows = [
    {code:'600001', history:history(10, .12)},
    {code:'600002', history:history(10, .04)},
    {code:'600003', history:history(10, -.03)}
  ];
  const snapshot = buildFactorSnapshot(rows, {analysisId:'a-1', tradeDate:'2026-09-14', universeSize:3, complete:true});
  assert.equal(snapshot.factors.length, 3);
  assert.equal(snapshot.factors[0].rpsScope, 'full-market');
  assert.ok(snapshot.factors[0].rps20 > snapshot.factors[1].rps20);
  assert.equal(buildFactorSnapshot(rows.slice(0, 1), {analysisId:'a-2', universeSize:1, complete:false}).factors[0].rps20, null);
});

test('独立策略可多重命中但裁决只给一个主状态并保留命中轨迹', () => {
  const factor = {
    code:'600001', returns:{d20:12,d60:24,d120:36,d250:50}, rps20:95,rps60:92,rps120:90,rps250:88,
    close:12, ma20:11.2, ma30:10.9, high20:12, previousHigh20:11.8, volumeRatio:1.8, drawdown20:-2, volatility20:1.8,
    dataCoverage:{history:1}
  };
  const evaluations = evaluateStrategyRegistry(factor, {sectorRotation:{confirmed:true, score:82}, newsRisk:false, observationPhase:{phase:'closed'}});
  assert.ok(evaluations.filter(item => item.matched).length >= 2);
  const decision = arbitrateStrategyResults(evaluations, {hardRisk:false});
  assert.equal(decision.status, 'strict');
  assert.equal(decision.primaryStrategyId, evaluations.filter(item => item.matched).sort((a,b)=>b.score-a.score)[0].id);
  assert.equal(decision.matches.length, evaluations.filter(item => item.matched).length);
});

test('接近前高或盘中越过前高不能标记为突破确认', () => {
  const factor = {code:'600001',returns:{d20:10,d60:20,d120:30,d250:40},rps20:95,rps60:90,rps120:80,rps250:70,
    close:9.8,ma20:9.5,ma30:9.2,high20:10,previousHigh20:10,volumeRatio:1.8,drawdown20:-2,volatility20:2};
  assert.equal(evaluateStrategyRegistry(factor, {observationPhase:{phase:'closed'}}).find(item => item.id === 'trend-breakout').matched, false);
  factor.close = 10.2;
  assert.equal(evaluateStrategyRegistry(factor, {observationPhase:{phase:'intraday'}}).find(item => item.id === 'trend-breakout').matched, false);
  assert.equal(evaluateStrategyRegistry(factor, {observationPhase:{phase:'closed'}}).find(item => item.id === 'trend-breakout').matched, true);
});

test('首次回踩必须有近期放量突破且此前没有触及回踩区', () => {
  const base = Array.from({length:25}, (_, index) => ({date:`2026-08-${String(index + 1).padStart(2, '0')}`,close:10,volume:1000}));
  const rows = [...base,
    {date:'2026-08-26',close:11,volume:2000},
    {date:'2026-08-27',close:11.2,volume:1100},
    {date:'2026-08-28',close:10.4,volume:900}
  ];
  const context = detectBreakoutContext(rows);
  assert.equal(context.confirmed, true);
  assert.equal(context.barsSinceBreakout, 2);
  assert.equal(context.priorPullbackCount, 0);
  const factor = {code:'600001',close:10.4,high20:11.2,ma20:10.15,ma30:10.1,volumeRatio:.9,rps60:80,breakoutContext:context};
  const closed={observationPhase:{phase:'closed'}};
  assert.equal(evaluateStrategyRegistry(factor,closed).find(item => item.id === 'first-pullback').matched, true);
  assert.equal(evaluateStrategyRegistry({...factor,breakoutContext:{...context,priorPullbackCount:1}},closed)
    .find(item => item.id === 'first-pullback').matched, false);
  assert.equal(evaluateStrategyRegistry({...factor,breakoutContext:null},closed)
    .find(item => item.id === 'first-pullback').matched, false);
  assert.equal(evaluateStrategyRegistry(factor,{observationPhase:{phase:'intraday'}})
    .find(item => item.id === 'first-pullback').matched, false);
  assert.equal(evaluateStrategyRegistry({...factor,breakoutContext:{...context,breakoutLevel:11}},closed)
    .find(item => item.id === 'first-pullback').matched, false);
  assert.equal(evaluateStrategyRegistry({...factor,ma30:null},closed)
    .find(item => item.id === 'first-pullback').matched, false);
});

test('硬风险覆盖策略高分，推荐和详情共享同一冻结展示模型', () => {
  const evaluations = [{id:'trend-breakout',matched:true,score:92,stage:'突破确认',horizon:'短线',reasons:['放量突破'],evidenceIds:['price-1']}];
  const decision = arbitrateStrategyResults(evaluations, {hardRisk:true, hardRiskReason:'未来半年减持风险'});
  assert.equal(decision.status, 'rejected');
  const item = {code:'600001',name:'测试',analysisId:'snapshot-1',scoreCard:{recommendation:92,snapshotId:'snapshot-1'}};
  const recommendation = buildAnalysisViewModel(item, {decision,evaluations,view:'recommendation'});
  const detail = buildAnalysisViewModel(item, {decision,evaluations,view:'detail'});
  assert.deepEqual(recommendation.analysis, detail.analysis);
  assert.equal(recommendation.analysisId, 'snapshot-1');
});

test('同一资讯刷新保持首次发现时间，只有内容变化才生成新事件', () => {
  const first = mergeEventLifecycle([], [{title:'公司发布公告',link:'https://example.com/a',publishedAt:'2026-09-14T01:00:00Z'}], '2026-09-14T02:00:00Z');
  const second = mergeEventLifecycle(first, [{title:'公司发布公告',link:'https://example.com/a',publishedAt:'2026-09-14T01:00:00Z'}], '2026-09-14T03:00:00Z');
  assert.equal(second[0].firstSeenAt, '2026-09-14T02:00:00Z');
  assert.equal(second[0].lastSeenAt, '2026-09-14T03:00:00Z');
  const revised = mergeEventLifecycle(second, [{title:'公司发布公告（更正）',link:'https://example.com/a',publishedAt:'2026-09-14T01:00:00Z'}], '2026-09-14T04:00:00Z');
  assert.equal(revised.length, 2);
});
