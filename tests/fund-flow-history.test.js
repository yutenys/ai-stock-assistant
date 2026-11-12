const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  FundFlowHistoryStore,
  FundFlowRequestCoordinator,
  assessFundFlowCoverage,
  normalizeFundFlowRecord,
  parseKnownJsonp,
  parseYyqyxFundFlowTable
} = require('../lib/fund-flow-history');

function record(overrides = {}) {
  return normalizeFundFlowRecord({
    code:'600001',
    tradeDate:'2026-10-09',
    mainNetAmount:0,
    provider:'fixture',
    definitionId:'fixture-main-v1',
    phase:'historical-final',
    origin:'historical-api',
    fetchedAt:'2026-10-10T01:00:00.000Z',
    firstObservedAt:'2026-10-10T01:00:00.000Z',
    ...overrides
  }, {amountUnit:'CNY', ratioUnit:'percent'});
}

test('资金记录按显式来源契约转换单位，零值与负值均保留', () => {
  const normalized = normalizeFundFlowRecord({
    code:'600001', tradeDate:'2026-10-09', mainNetAmount:-12.5, mainNetPct:.003,
    provider:'fixture', definitionId:'fixture-main-v1', phase:'historical-final',
    origin:'historical-api', fetchedAt:'2026-10-10T01:00:00.000Z'
  }, {amountUnit:'CNY_10K', ratioUnit:'fraction'});
  assert.equal(normalized.mainNetAmount, -125000);
  assert.equal(normalized.mainNetPct, .3);
  assert.equal(record().mainNetAmount, 0);
  assert.throws(() => normalizeFundFlowRecord({
    code:'600001', tradeDate:'2026-10-09', mainNetAmount:1, provider:'fixture',
    definitionId:'fixture-main-v1', phase:'historical-final', origin:'historical-api'
  }, {}), /amountUnit/);
});

test('公开网页逐日资金只解析匹配股票的表格，并保留取整单位', () => {
  const html = `<link rel="canonical" href="https://www.yyqyx.com/s/603980.SH">
    <h2 id="sec18">吉华集团近期主力资金流向</h2><table>
    <thead><tr><th>日期</th><th>主力净额</th></tr></thead><tbody>
    <tr><td>2026-10-21</td><td class="down">-1.45 亿元</td></tr>
    <tr><td>2026-10-20</td><td class="up">+2,021 万元</td></tr>
    </tbody></table>`;
  assert.deepEqual(parseYyqyxFundFlowTable(html, '603980').map(row => [row.date, row.mainNetInflow]), [
    ['2026-10-20', 20210000], ['2026-10-21', -145000000]
  ]);
  assert.throws(() => parseYyqyxFundFlowTable(html, '002708'), /代码不匹配/);
  assert.throws(() => parseYyqyxFundFlowTable(html.replace('+2,021 万元', '未知'), '603980'), /金额格式无效/);
  assert.throws(() => parseYyqyxFundFlowTable(html.replace('2026-10-20', '2026-10-21'), '603980'), /日期无效或重复/);
});

test('完整性只由同一来源同一口径的最终逐日记录满足', () => {
  const expectedDates = ['2026-10-08','2026-10-09'];
  const result = assessFundFlowCoverage({
    code:'600001', expectedDates, endDate:'2026-10-09', records:[
      record({tradeDate:'2026-10-08', mainNetAmount:100}),
      record({tradeDate:'2026-10-09', provider:'other', definitionId:'other-v1', mainNetAmount:200})
    ]
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.coveredDates.length, 1);
  assert.deepEqual(result.missingDates, ['2026-10-09']);
  assert.equal(result.dateCoverageComplete, true);
  assert.equal(result.comparableSeriesComplete, false);
});

test('暂存快照、未来日期、重复冲突均不能冒充完整历史', () => {
  const provisional = record({tradeDate:'2026-10-08', phase:'close-observed'});
  const result = assessFundFlowCoverage({
    code:'600001', expectedDates:['2026-10-08','2026-10-09'], endDate:'2026-10-09', records:[
      provisional,
      record({mainNetAmount:100, evidenceHash:'evidence-a'}),
      record({mainNetAmount:200, evidenceHash:'evidence-b'}),
      record({tradeDate:'2026-10-10', mainNetAmount:300})
    ]
  });
  assert.equal(result.status, 'conflict');
  assert.equal(result.finalDailyRows.length, 0);
  assert.equal(result.provisionalRows.length, 1);
  assert.deepEqual(result.missingDates, ['2026-10-08','2026-10-09']);
  assert.equal(result.conflicts.length, 1);
});

test('核验停牌日计入日期解释，不生成零资金行', () => {
  const result = assessFundFlowCoverage({
    code:'600001', expectedDates:['2026-10-08','2026-10-09'], suspendedDates:['2026-10-08'],
    endDate:'2026-10-09', records:[record({tradeDate:'2026-10-09', mainNetAmount:88})]
  });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.suspendedDates, ['2026-10-08']);
  assert.equal(result.finalDailyRows.length, 1);
});

test('年度档案跨重启保留修订，final不会被暂存记录覆盖', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fund-flow-history-'));
  t.after(() => fs.promises.rm(root, {recursive:true, force:true}));
  const store = new FundFlowHistoryStore(root);
  await store.merge([
    record({tradeDate:'2025-12-31', mainNetAmount:10, evidenceHash:'old-final'}),
    record({tradeDate:'2026-01-02', mainNetAmount:20, evidenceHash:'new-final'})
  ]);
  await store.merge([record({tradeDate:'2026-01-02', phase:'close-observed', mainNetAmount:30, evidenceHash:'snapshot'})]);
  const reopened = new FundFlowHistoryStore(root);
  const result = await reopened.query({
    code:'600001', startDate:'2025-12-31', endDate:'2026-01-02',
    expectedDates:['2025-12-31','2026-01-02']
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.finalDailyRows.find(row => row.tradeDate === '2026-01-02').mainNetAmount, 20);
  assert.equal(result.provisionalRows.length, 1);
  assert.ok(fs.existsSync(path.join(root, 'fixture', '600001', '2025.json')));
  assert.ok(fs.existsSync(path.join(root, 'fixture', '600001', '2026.json')));
});

test('同一年度并发合并不会发生读后写覆盖', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fund-flow-concurrent-'));
  t.after(() => fs.promises.rm(root, {recursive:true, force:true}));
  const store = new FundFlowHistoryStore(root);
  await Promise.all([
    store.merge([record({tradeDate:'2026-10-08', evidenceHash:'concurrent-a'})]),
    store.merge([record({tradeDate:'2026-10-09', evidenceHash:'concurrent-b'})])
  ]);
  const result = await store.query({code:'600001', startDate:'2026-10-08', endDate:'2026-10-09',
    expectedDates:['2026-10-08','2026-10-09']});
  assert.equal(result.status,'complete');
  assert.equal(result.finalDailyRows.length,2);
});

test('年度档案查询不会把目标窗口外的同年记录计入汇总', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fund-flow-window-'));
  t.after(() => fs.promises.rm(root, {recursive:true, force:true}));
  const store = new FundFlowHistoryStore(root);
  await store.merge([
    record({tradeDate:'2026-01-05', mainNetAmount:9_000_000, evidenceHash:'outside-window'}),
    record({tradeDate:'2026-10-08', mainNetAmount:100, evidenceHash:'inside-a'}),
    record({tradeDate:'2026-10-09', mainNetAmount:200, evidenceHash:'inside-b'})
  ]);
  const result = await store.query({code:'600001', startDate:'2026-10-08', endDate:'2026-10-09',
    expectedDates:['2026-10-08','2026-10-09']});
  assert.equal(result.status,'complete');
  assert.deepEqual(result.finalDailyRows.map(row => row.tradeDate),['2026-10-08','2026-10-09']);
});

test('区间末日停牌时仍需覆盖此前全部交易日才算数据足够新', () => {
  const incomplete = assessFundFlowCoverage({
    code:'600001',
    expectedDates:['2026-10-08','2026-10-09','2026-10-10'],
    suspendedDates:['2026-10-10'],
    endDate:'2026-10-10',
    records:[record({tradeDate:'2026-10-08', mainNetAmount:10})]
  });
  assert.equal(incomplete.freshEnough,false);

  const complete = assessFundFlowCoverage({
    code:'600001',
    expectedDates:['2026-10-08','2026-10-09','2026-10-10'],
    suspendedDates:['2026-10-10'],
    endDate:'2026-10-10',
    records:[
      record({tradeDate:'2026-10-08', mainNetAmount:10}),
      record({tradeDate:'2026-10-09', mainNetAmount:20})
    ]
  });
  assert.equal(complete.freshEnough,true);
});

test('同一请求共享Promise，force仍遵守传输失败冷却', async () => {
  let calls = 0;
  let release;
  const coordinator = new FundFlowRequestCoordinator({failureThreshold:3, cooldownMs:60000});
  const loader = () => new Promise(resolve => { calls++; release = resolve; });
  const first = coordinator.run({provider:'fixture', key:'600001:10'}, loader);
  const second = coordinator.run({provider:'fixture', key:'600001:10', force:true}, loader);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  release({available:true, rows:[1]});
  assert.deepEqual(await first, await second);
  for (let index = 0; index < 3; index++) {
    await assert.rejects(coordinator.run({provider:'broken', key:`key-${index}`}, async () => {
      throw Object.assign(new Error('socket hang up'), {code:'ECONNRESET'});
    }), /socket hang up/);
  }
  await assert.rejects(
    coordinator.run({provider:'broken', key:'forced', force:true}, async () => ({available:true})),
    error => Boolean(error.code === 'PROVIDER_COOLDOWN' && error.nextRetryAt)
  );
});

test('空业务响应按代码和窗口负缓存且全局并发有上限', async () => {
  let emptyCalls = 0;
  let active = 0;
  let maximum = 0;
  const coordinator = new FundFlowRequestCoordinator({totalLimit:2, providerLimit:2, negativeTtlMs:60000});
  const emptyLoader = async () => { emptyCalls++; return {available:false, rows:[]}; };
  await coordinator.run({provider:'fixture', key:'empty'}, emptyLoader);
  const cached = await coordinator.run({provider:'fixture', key:'empty', force:true}, emptyLoader);
  assert.equal(emptyCalls, 1);
  assert.equal(cached.negativeCached, true);
  await Promise.all(Array.from({length:5}, (_, index) => coordinator.run({provider:'slow', key:String(index)}, async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return {available:true, rows:[index]};
  })));
  assert.equal(maximum, 2);
});

test('429与403立即进入安全冷却，force不能绕过', async () => {
  let now = Date.parse('2026-10-19T01:00:00.000Z');
  const coordinator = new FundFlowRequestCoordinator({now:() => now, cooldownMs:60000, extendedCooldownMs:300000});
  const limited = Object.assign(new Error('HTTP 429'), {statusCode:429, retryAfterMs:120000});
  await assert.rejects(coordinator.run({provider:'limited',key:'a'},async()=>{throw limited;}),/429/);
  await assert.rejects(coordinator.run({provider:'limited',key:'b',force:true},async()=>({available:true})),
    error => error.code === 'PROVIDER_COOLDOWN' && Date.parse(error.nextRetryAt) === now + 120000);
  const forbidden = Object.assign(new Error('HTTP 403'), {statusCode:403});
  await assert.rejects(coordinator.run({provider:'forbidden',key:'a'},async()=>{throw forbidden;}),/403/);
  await assert.rejects(coordinator.run({provider:'forbidden',key:'b'},async()=>({available:true})),
    error => error.code === 'PROVIDER_COOLDOWN' && Date.parse(error.nextRetryAt) === now + 300000);
});

test('仅解析JSON或已知JSONP包装，不执行返回脚本', () => {
  assert.deepEqual(parseKnownJsonp('{"ok":true}'), {ok:true});
  assert.deepEqual(parseKnownJsonp('callback123({"ok":true});', 'callback123'), {ok:true});
  assert.throws(() => parseKnownJsonp('<html>blocked</html>'), /JSON/);
  assert.throws(() => parseKnownJsonp('other({"ok":true})', 'callback123'), /JSONP/);
});
