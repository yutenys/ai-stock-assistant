'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyTradeDateCoverage,
  extractFundTradeDates,
  isTradedBar,
  reconcileFundSnapshots
} = require('../lib/data-coverage-audit');

test('classifyTradeDateCoverage distinguishes traded, zero-volume and pre-listing dates', () => {
  assert.equal(classifyTradeDateCoverage({
    date: '2026-11-05',
    bar: { date: '2026-11-05', volume: 1200 }
  }).status, 'covered');

  assert.equal(classifyTradeDateCoverage({
    date: '2026-11-05',
    bar: { date: '2026-11-05', volume: 0, amount: 0 }
  }).status, 'no-trade-observed');

  assert.equal(classifyTradeDateCoverage({
    date: '2026-10-30',
    listingDate: '2026-11-03'
  }).status, 'pre-listing');
});

test('classifyTradeDateCoverage requires corroboration before clearing a missing date', () => {
  assert.equal(classifyTradeDateCoverage({
    date: '2026-11-03',
    priceSourceChecked: true,
    fundSourceChecked: true,
    priceSourceTraded: false,
    fundSourceTraded: false
  }).status, 'no-trade-corroborated');

  assert.equal(classifyTradeDateCoverage({
    date: '2026-11-03',
    priceSourceChecked: true,
    fundSourceChecked: true,
    priceSourceTraded: true,
    fundSourceTraded: false
  }).status, 'missing');

  assert.equal(classifyTradeDateCoverage({
    date: '2026-11-03',
    priceSourceChecked: true,
    fundSourceChecked: false,
    priceSourceTraded: false
  }).status, 'unverified');
});

test('reconcileFundSnapshots preserves exact deltas and accepts only bounded provider precision', () => {
  const precise = reconcileFundSnapshots(
    [1_000_120, -500_040, 300_080, 200_000, 50_010],
    [1_000_000, -500_000, 300_000, 200_000, 50_000]
  );
  assert.equal(precise.status, 'within-provider-precision');
  assert.deepEqual(precise.deltas, [120, -40, 80, 0, 10]);

  assert.equal(reconcileFundSnapshots(
    [1_000_000, -500_000, 300_000, 200_000, 50_000],
    [1_000_000, -500_000, 300_000, 200_000, 50_000]
  ).status, 'exact');

  assert.equal(reconcileFundSnapshots(
    [1_000_250, -500_000, 300_000, 200_000, 50_000],
    [1_000_000, -500_000, 300_000, 200_000, 50_000]
  ).status, 'mismatch');
});

test('reconcileFundSnapshots rejects malformed provider rows', () => {
  assert.equal(reconcileFundSnapshots([1, 2], [1, 2]).status, 'invalid');
  assert.equal(reconcileFundSnapshots([1, 2, 3, 4, NaN], [1, 2, 3, 4, 5]).status, 'invalid');
});

test('extractFundTradeDates treats provider no-data as checked, not a request failure', () => {
  assert.deepEqual(extractFundTradeDates({
    rc: 0,
    data: { klines: ['2026-11-04,1,2,3,4,5', '2026-11-05,1,2,3,4,5'] }
  }), { checked: true, dates: ['2026-11-04', '2026-11-05'], responseCode: 0 });

  assert.deepEqual(extractFundTradeDates({ rc: 100, data: null }), {
    checked: true,
    dates: [],
    responseCode: 100
  });

  assert.equal(extractFundTradeDates({ rc: 101, data: null }).checked, false);
});

test('isTradedBar only admits positive turnover into minute-fund collection', () => {
  assert.equal(isTradedBar({ volume: 1, amount: 0 }), true);
  assert.equal(isTradedBar({ volume: 0, amount: 1 }), true);
  assert.equal(isTradedBar({ volume: 0, amount: 0 }), false);
  assert.equal(isTradedBar(null), false);
});
