const test = require('node:test');
const assert = require('node:assert/strict');
const {createThemeShadowManifest,evaluateThemeShadowExperiments} = require('../lib/theme-shadow-experiments');

const frozenAt = '2026-10-10T10:00:00+08:00';
const manifest = createThemeShadowManifest({frozenAt,modelVersion:'v26'});
const cutoffAt = '2026-10-12T10:30:00+08:00';
const item = {entryPermission:'allowed',planState:{currentPermission:'allowed',decisionEvent:{
  type:'entry-allowed',verified:true,source:'quote',occurredAt:'2026-10-12T10:15:00+08:00'}},
  intradayStructure:{state:'retest-confirmed'},intradayPlanState:{currentPermission:'allowed',
    decisionEvent:{type:'entry-allowed',verified:true,source:'minute',occurredAt:'2026-10-12T10:20:00+08:00'}}};
const theme = {tradeDate:'2026-10-12',cutoffAt,memberRevision:'frozen-members',memberCount:10,
  capacityTrack:{status:'confirmed'},ladderTrack:{status:'observed'},capital:{status:'observed',netInflow:100},state:'资金与广度同向'};

test('H5-H7 use a separate prospective version and do not backfill old days', () => {
  assert.equal(manifest.firstTradeDate,'2026-10-12');
  assert.equal(manifest.promotionAllowed,false);
  const before = evaluateThemeShadowExperiments(item,{manifest,tradeDate:'2026-10-09',cutoffAt:'2026-10-09T10:30:00+08:00',theme});
  assert.deepEqual(before.map(row => row.status),['unknown','unknown','unknown']);
  const current = evaluateThemeShadowExperiments(item,{manifest,tradeDate:'2026-10-12',cutoffAt,theme});
  assert.deepEqual(current.map(row => row.status),['pass','pass','pass']);
  assert.ok(current.every(row => row.shadowOnly));
});

test('missing capacity stays unknown while the 60-minute research path remains independent', () => {
  const context = {manifest,tradeDate:'2026-10-12',cutoffAt,theme:{...theme,capacityTrack:{status:'unknown'}}};
  assert.deepEqual(evaluateThemeShadowExperiments(item,context).map(row => row.status),['unknown','pass','unknown']);
  assert.deepEqual(evaluateThemeShadowExperiments({...item,entryPermission:'blocked',planState:{currentPermission:'blocked'}},context)
    .map(row => row.status),['fail','pass','fail']);
  assert.deepEqual(evaluateThemeShadowExperiments({...item,entryPermission:'watch',planState:{currentPermission:'watch'}},
    {...context,theme}).map(row => row.status),['unknown','pass','unknown']);
});

test('H7 cannot pass without H5 and stale or unverified events do not pass', () => {
  const context = {manifest,tradeDate:'2026-10-12',cutoffAt,theme};
  assert.deepEqual(evaluateThemeShadowExperiments({...item,planState:{...item.planState,currentPermission:'blocked'}},context)
    .map(row => row.status),['fail','pass','fail']);
  assert.deepEqual(evaluateThemeShadowExperiments({...item,entryPermission:'blocked'},context)
    .map(row => row.status),['fail','pass','fail']);
  assert.deepEqual(evaluateThemeShadowExperiments({...item,entryPermission:'watch'},context)
    .map(row => row.status),['unknown','pass','unknown']);
  assert.deepEqual(evaluateThemeShadowExperiments({...item,planState:{...item.planState,decisionEvent:{
    ...item.planState.decisionEvent,occurredAt:'2026-10-09T10:15:00+08:00'}}},context)
    .map(row => row.status),['unknown','pass','unknown']);
  assert.deepEqual(evaluateThemeShadowExperiments({...item,intradayPlanState:{...item.intradayPlanState,decisionEvent:{
    ...item.intradayPlanState.decisionEvent,verified:false}}},context)
    .map(row => row.status),['pass','unknown','unknown']);
  assert.deepEqual(evaluateThemeShadowExperiments(item,{...context,theme:{...theme,cutoffAt:'bad-clock'}})
    .map(row => row.status),['unknown','pass','unknown']);
});

test('unknown next-year calendar leaves the prospective start unverified', () => {
  const future = createThemeShadowManifest({frozenAt:'2026-12-31T16:00:00+08:00',modelVersion:'v26'});
  assert.equal(future.firstTradeDate,null);
  assert.deepEqual(evaluateThemeShadowExperiments(item,{manifest:future,tradeDate:'2027-01-04',
    cutoffAt:'2027-01-04T10:30:00+08:00',theme}).map(row => row.status),['unknown','unknown','unknown']);
});
