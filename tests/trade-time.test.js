const test = require('node:test');
const assert = require('node:assert/strict');
const {executionWindow,isTradingDay,nextTradingDay} = require('../lib/trade-time');

test('盘中当日买次交易日卖，盘后下一交易日买再下一日卖', () => {
  const day=executionWindow('2026-09-15T10:00:00+08:00');
  assert.equal(day.tradable,true);
  assert.equal(day.buyDate,'2026-09-15');
  assert.equal(day.sellDate,'2026-09-16');
  const after=executionWindow('2026-09-15T15:00:00+08:00');
  assert.equal(after.tradable,false);
  assert.equal(after.buyDate,'2026-09-16');
  assert.equal(after.sellDate,'2026-09-17');
});

test('北京时间交易时段严格处理开盘午休和收盘边界', () => {
  for (const [time,tradable] of [['09:29:59',false],['09:30:00',true],['11:29:59',true],
    ['11:30:00',false],['12:59:59',false],['13:00:00',true],['14:59:59',true],['15:00:00',false]]) {
    assert.equal(executionWindow(`2026-09-15T${time}+08:00`).tradable,tradable,time);
  }
  const lunch=executionWindow('2026-09-15T12:00:00+08:00');
  assert.equal(lunch.buyDate,'2026-09-15');
  assert.equal(lunch.sellDate,'2026-09-16');
  assert.match(lunch.summary,/13:00/);
  assert.equal(executionWindow('2026-09-15T01:30:00Z').tradable,true);
});

test('T+1跳过周末、节假日和调休周末，未知日历不编造日期', () => {
  assert.equal(executionWindow('2026-09-18T10:00:00+08:00').sellDate,'2026-09-21');
  assert.equal(executionWindow('2026-09-18T16:00:00+08:00').sellDate,'2026-09-22');
  assert.equal(isTradingDay('2026-09-20'),false);
  assert.equal(nextTradingDay('2026-09-24'),'2026-09-28');
  assert.equal(nextTradingDay('2026-09-30'),'2026-10-08');
  assert.equal(isTradingDay('2026-10-10'),false);
  assert.equal(nextTradingDay('2026-12-31'),null);
  assert.equal(isTradingDay('2026-02-30'),null);
  assert.equal(executionWindow('2027-01-04T10:00:00+08:00').tradable,false);
});
