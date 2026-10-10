const test = require('node:test');
const assert = require('node:assert/strict');
const {buildThemeRegimes} = require('../lib/theme-regime');

const day = '2026-10-09';
const at = '2026-10-09T10:00:00+08:00';
const later = '2026-10-09T10:30:00+08:00';
function sector(overrides = {}) {
  return {name:'测试行业',code:'BK0001',boardType:'industry',memberCodes:['600001','600002','600003','600004'],
    capitalEstimated:false,capitalStale:false,capitalTradeDate:day,capitalSource:'source-a',
    capitalObservedAt:at,capitalFetchedAt:at,mainNetInflow:100,...overrides};
}
function quotes() {
  return ['600001','600002','600003','600004'].map((code,index) => ({code,tradeDate:day,
    amount:400-index*100,changePct:index === 3 ? -1 : 1}));
}
function calculate(row, prior = [], cutoffAt = later) {
  return buildThemeRegimes({sectors:[row],quotes:quotes(),limits:{upCodes:['600001'],ladderStatus:'partial'},
    previous:prior,tradeDate:day,cutoffAt})[0];
}

test('same source, members and increasing source time yield real direction; negative flow never uses positive drawdown', () => {
  const first = calculate(sector({mainNetInflow:-20}));
  const second = calculate(sector({mainNetInflow:-150,capitalObservedAt:later,capitalFetchedAt:later}),[first]);
  assert.equal(second.capital.deltaNet,-130);
  assert.equal(second.capital.direction,'净流出扩大');
  assert.equal(second.state,'资金与涨停背离');
  assert.equal(second.capacityTrack.status,'unknown');
  assert.equal(second.ladderTrack.status,'partial');
});

test('source switch, member change, stale and future evidence cannot confirm flow', () => {
  const first = calculate(sector());
  for (const changed of [sector({capitalSource:'source-b',capitalObservedAt:later}),
    sector({memberCodes:['600001','600002'],capitalObservedAt:later}),
    sector({capitalStale:true,capitalObservedAt:later}),
    sector({capitalObservedAt:'2026-10-09T11:00:00+08:00'})]) {
    const current = calculate(changed,[first]);
    assert.equal(current.capital.comparable,false);
    assert.equal(current.capital.deltaNet,null);
  }
  assert.equal(calculate(sector({memberCodes:[]})).capital.status,'unknown');
});

test('next trading day keeps episode but does not subtract cumulative daily money', () => {
  const first = calculate(sector());
  const next = buildThemeRegimes({sectors:[sector({capitalTradeDate:'2026-10-12',
    capitalObservedAt:'2026-10-12T10:00:00+08:00',capitalFetchedAt:'2026-10-12T10:00:00+08:00',mainNetInflow:200})],
    quotes:[],previous:[first],tradeDate:'2026-10-12',cutoffAt:'2026-10-12T10:00:00+08:00'})[0];
  assert.equal(next.episodeId,first.episodeId);
  assert.equal(next.runTradingDays,2);
  assert.equal(next.capital.deltaNet,null);
});

test('missing trading-day snapshot pauses count without fabricating a new episode', () => {
  const first = calculate(sector());
  const resumed = buildThemeRegimes({sectors:[sector({capitalTradeDate:'2026-10-13',
    capitalObservedAt:'2026-10-13T10:00:00+08:00',capitalFetchedAt:'2026-10-13T10:00:00+08:00'})],
    previous:[first],tradeDate:'2026-10-13',cutoffAt:'2026-10-13T10:00:00+08:00'})[0];
  assert.equal(resumed.episodeId,first.episodeId);
  assert.equal(resumed.runTradingDays,2);
  assert.equal(resumed.missingDates,1);
  assert.match(resumed.unknownReasons.join(' '),/缺少1个交易日快照/);
});

test('unknown future calendar does not restart a prior theme episode', () => {
  const prior = {...calculate(sector()),tradeDate:'2026-12-31'};
  const current = buildThemeRegimes({sectors:[sector({capitalTradeDate:'2027-01-04',
    capitalObservedAt:'2027-01-04T10:00:00+08:00',capitalFetchedAt:'2027-01-04T10:00:00+08:00'})],
    previous:[prior],tradeDate:'2027-01-04',cutoffAt:'2027-01-04T10:00:00+08:00'})[0];
  assert.equal(current.episodeId,prior.episodeId);
  assert.equal(current.runTradingDays,prior.runTradingDays);
  assert.equal(current.missingDates,null);
  assert.match(current.unknownReasons.join(' '),/连续天数待核验/);
});
