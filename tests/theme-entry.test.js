const test = require('node:test');
const assert = require('node:assert/strict');
const {evaluateThemeEntry} = require('../lib/theme-entry');

const day = '2026-10-09';
const at = minute => `${day}T${minute}+08:00`;
const codes = Array.from({length: 10}, (_, i) => `600${String(i + 1).padStart(3, '0')}`);
const members = codes.map(code => ({code,themeId:'cross-sector',parentThemeIds:['parent'],
  relationEvidence:{source:'company filing',url:`https://example.com/${code}`,
    publishedAt:'2026-10-08T12:00:00+08:00',firstSeenAt:'2026-10-08T13:00:00+08:00'}}));
const frozenLeaders = codes.slice(0, 3).map((code, i) => ({code,median20Amount:3e8-i*1e7,
  stableTradingDays:20,frozenAt:'2026-10-08T16:00:00+08:00'}));
const snapshots = codes.map((code, i) => ({code,source:'quotes',quoteObservedAt:at('10:30:00'),
  tradeDate:day,price:11,vwap:10,changePct:10-i,amount:(10-i)*1e8,indexChangePct:1,hardRisk:false}));
function themeClock(time, extra = {}) {
  return {themeId:'cross-sector',parentThemeIds:['parent'],memberCodes:codes,capitalSource:'funds',
    capitalObservedAt:at(time),capitalFetchedAt:at(time),capitalTradeDate:day,
    mainNetInflow:1e8,amount:1e9,capitalEstimated:false,capitalStale:false,
    stockFlows:codes.slice(0, 3).map(code => ({code,mainNetInflow:1e7})),...extra};
}
const capital = {themeSnapshots:[themeClock('10:00:00'),themeClock('10:20:00')],
  peers:['cross-sector','peer-a','peer-b','peer-c'].map((themeId, i) => ({themeId,
    capitalSource:'funds',capitalObservedAt:at('10:20:00'),capitalTradeDate:day,
    mainNetInflow:i ? 1e7 : 1e8,amount:1e9,capitalEstimated:false,capitalStale:false}))};
function evaluate(overrides = {}) {
  return evaluateThemeEntry({members,frozenLeaders,snapshots,capital,news:[],cutoffAt:at('10:30:00'),...overrides});
}

test('confirms independent capacity, ex-top-three breadth and matching real funds', () => {
  const value = evaluate();
  assert.deepEqual(value.leaderCodes,codes.slice(0, 3));
  assert.equal(value.breadthCoverage,1);
  assert.equal(value.priceConfirmation.status,'confirmed');
  assert.equal(value.priceConfirmation.exTop3UpRatio,1);
  assert.equal(value.capitalConfirmation.status,'confirmed');
  assert.equal(value.capitalConfirmation.snapshots.length,2);
  assert.equal(value.capitalConfirmation.intensityPercentile,1);
  assert.equal(value.persistence.status,'unknown');
});

test('unverified relation and duplicate parent membership never inflate breadth', () => {
  const value = evaluate({members:[...members,{...members[0],themeId:'another-child'},
    {code:'600999',themeId:'cross-sector',parentThemeIds:['parent']}]});
  assert.equal(value.memberCodes.length,10);
  assert.equal(value.breadthCoverage,1);
  assert.match(value.unknownReasons.join(' '),/关系/);
});

test('candidate cannot validate itself and frozen set cannot be refilled intraday', () => {
  const value = evaluate({candidateCode:codes[0]});
  assert.deepEqual(value.leaderCodes,codes.slice(1, 3));
  assert.equal(value.priceConfirmation.status,'confirmed');
  const insufficient = evaluate({candidateCode:codes[0],frozenLeaders:frozenLeaders.slice(0, 2)});
  assert.equal(insufficient.priceConfirmation.status,'unknown');
  assert.match(insufficient.unknownReasons.join(' '),/容量股不足/);
});

test('repeat source time, changed members and fetched time cannot produce independent funds', () => {
  for (const second of [themeClock('10:00:00',{capitalFetchedAt:at('10:25:00')}),
    themeClock('10:20:00',{memberCodes:codes.slice(1)}),
    themeClock('10:20:00',{capitalSource:'other'})]) {
    const value = evaluate({capital:{...capital,themeSnapshots:[themeClock('10:00:00'),second]}});
    assert.equal(value.capitalConfirmation.status,'unknown');
    assert.match(value.unknownReasons.join(' '),/独立同口径/);
  }
});

test('real outflow is divergence, missing funds leave price evidence intact', () => {
  const outflow = evaluate({capital:{...capital,themeSnapshots:[themeClock('10:00:00'),
    themeClock('10:20:00',{mainNetInflow:-1})]}});
  assert.equal(outflow.priceConfirmation.status,'confirmed');
  assert.equal(outflow.capitalConfirmation.status,'divergent');
  const missing = evaluate({capital:{...capital,themeSnapshots:[]}});
  assert.equal(missing.priceConfirmation.status,'confirmed');
  assert.equal(missing.capitalConfirmation.status,'unknown');
  assert.notEqual(missing.capitalConfirmation.netInflow,0);
});

test('news only enters after publication and first sight, with direct mapping', () => {
  const item = {eventId:'n1',code:codes[0],source:'filing',link:'https://example.com/news',
    publishedAt:at('09:00:00'),firstSeenAt:at('11:00:00')};
  assert.equal(evaluate({news:[item]}).news.items.length,0);
  assert.equal(evaluate({news:[{...item,firstSeenAt:at('10:00:00')}]}).news.items.length,1);
  assert.equal(evaluate({news:[{...item,code:'600999',firstSeenAt:at('10:00:00')}]}).news.items.length,0);
});

test('post-open leader freeze and absent hard-risk quote do not confirm price', () => {
  const late = evaluate({frozenLeaders:frozenLeaders.map(row => ({...row,frozenAt:at('09:16:00')}))});
  assert.equal(late.priceConfirmation.status,'unknown');
  const riskUnknown = evaluate({snapshots:snapshots.map((row, i) => i ? row : (({hardRisk,...rest}) => rest)(row))});
  assert.equal(riskUnknown.priceConfirmation.status,'unknown');
});

test('fund clocks need fifteen minutes and matching currency, unit and provider', () => {
  const contract = {unit:'yuan',currency:'CNY',provider:'funds',boardType:'industry'};
  for (const second of [themeClock('10:14:59'),
    themeClock('10:20:00',{windowContract:{...contract,unit:'wan-yuan'}}),
    themeClock('10:20:00',{windowContract:{...contract,provider:'other'}})]) {
    const first = themeClock('10:00:00',second.windowContract ? {windowContract:contract} : {});
    const value = evaluate({capital:{...capital,themeSnapshots:[first,second]}});
    assert.equal(value.capitalConfirmation.status,'unknown');
  }
  const boundary = evaluate({capital:{themeSnapshots:[themeClock('10:00:00'),themeClock('10:15:00')],
    peers:capital.peers.map(row => ({...row,capitalObservedAt:at('10:15:00')}))}});
  assert.equal(boundary.capitalConfirmation.status,'confirmed');
});

test('frozen capacity ranks by prior median, excludes self without intraday refill', () => {
  const more = {...frozenLeaders[0],code:codes[3],median20Amount:5e8};
  const value = evaluate({frozenLeaders:[...frozenLeaders,more],candidateCode:codes[3]});
  assert.deepEqual(value.leaderCodes,codes.slice(0, 2));
});

test('zero flow and negative three-day summary remain distinct from missing', () => {
  const value = evaluate({capital:{...capital,themeSnapshots:[themeClock('10:00:00'),
    themeClock('10:20:00',{mainNetInflow:0,mainNet3:-1})]}});
  assert.equal(value.capitalConfirmation.status,'divergent');
  assert.equal(value.capitalConfirmation.netInflow,0);
  assert.equal(value.persistence.status,'warning');
});

test('weak ex-top-three breadth and thin quote coverage block price confirmation', () => {
  const weak = evaluate({snapshots:snapshots.map((row, i) => i > 2 ? {...row,changePct:-1} : row)});
  assert.equal(weak.priceConfirmation.status,'divergent');
  const thin = evaluate({snapshots:snapshots.slice(0, 6)});
  assert.equal(thin.priceConfirmation.status,'unknown');
});

test('去前三按成交额而不是涨幅排除', () => {
  const rows=snapshots.map((row,index)=>({...row,amount:index<3 ? 1e7 : (10-index)*1e8,
    changePct:index<3 ? 9-index : index===3 ? -1 : 1}));
  const value=evaluate({snapshots:rows});
  assert.equal(value.priceConfirmation.exTop3Count,7);
  assert.equal(value.priceConfirmation.exTop3UpRatio,1);
});

test('second of four themes is outside top thirty percent of capital intensity', () => {
  const value = evaluate({capital:{...capital,peers:capital.peers.map((row, i) =>
    i === 1 ? {...row,mainNetInflow:2e8} : row)}});
  assert.equal(value.capitalConfirmation.status,'divergent');
  assert.equal(value.capitalConfirmation.intensityRank,2);
});

test('capacity money needs two-thirds coverage and nonnegative combined flow', () => {
  const partial = evaluate({capital:{...capital,themeSnapshots:[themeClock('10:00:00'),
    themeClock('10:20:00',{stockFlows:[{code:codes[0],mainNetInflow:1}]})]}});
  assert.equal(partial.capitalConfirmation.status,'unknown');
  const outflow = evaluate({capital:{...capital,themeSnapshots:[themeClock('10:00:00'),
    themeClock('10:20:00',{stockFlows:[{code:codes[0],mainNetInflow:10},
      {code:codes[1],mainNetInflow:-20},{code:codes[2],mainNetInflow:1}]})]}});
  assert.equal(outflow.capitalConfirmation.status,'divergent');
  assert.equal(outflow.capitalConfirmation.leaderNetInflow,-9);
});
