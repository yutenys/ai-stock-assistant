const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {atomicWriteJson, readJsonWithBackup, ResearchJobStore, StockHistoryStore} = require('../lib/persistence');

test('原子JSON保存保留上一版备份且可在主文件损坏后恢复', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-state-'));
  const file = path.join(dir, 'state.json');
  await atomicWriteJson(file, {schemaVersion:1, labels:['first']});
  await atomicWriteJson(file, {schemaVersion:2, labels:['second']});
  fs.writeFileSync(file, '{broken', 'utf8');
  const restored = await readJsonWithBackup(file);
  assert.deepEqual(restored.value.labels, ['first']);
  assert.equal(restored.recoveredFromBackup, true);
});

test('损坏的主文件不会覆盖上一版有效备份', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-backup-'));
  const file = path.join(dir, 'state.json');
  await atomicWriteJson(file, {version:1});
  await atomicWriteJson(file, {version:2});
  fs.writeFileSync(file, '{broken', 'utf8');
  await atomicWriteJson(file, {version:3});
  fs.writeFileSync(file, '{broken-again', 'utf8');
  const restored = await readJsonWithBackup(file);
  assert.equal(restored.value.version, 1);
  assert.equal(restored.recoveredFromBackup, true);
});

test('全市场任务按游标恢复、取消且不重复写已完成证券', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-job-'));
  const store = new ResearchJobStore(dir);
  await store.start({jobId:'job-1',analysisId:'a-1',tradeDate:'2026-09-14',total:3});
  await store.recordBatch('job-1', [{code:'600001',factor:{code:'600001'}},{code:'600002',error:'timeout'}]);
  await store.recordBatch('job-1', [{code:'600002',factor:{code:'600002'}},{code:'600003',error:'history missing'}]);
  let status = await store.status('job-1');
  assert.equal(status.completed, 3);
  assert.equal(status.cursor, 3);
  assert.equal(status.valid, 2);
  assert.equal(status.failed, 1);
  await store.cancel('job-1');
  status = await store.status('job-1');
  assert.equal(status.state, 'cancelled');
  const resumed = await store.resume('job-1');
  assert.equal(resumed.state, 'running');
  assert.equal(resumed.completed, 3);
});

test('股票历史仓库按交易日增量合并、覆盖同日快照并限制长度', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-history-'));
  const store = new StockHistoryStore(dir, 3);
  await store.merge('600001', [
    {date:'2026-09-10',close:10}, {date:'2026-09-11',close:11}, {date:'2026-09-12',close:12}
  ], {source:'full', fullRefresh:true});
  const result = await store.merge('600001', [
    {date:'2026-09-12',close:12.5}, {date:'2026-09-14',close:13}
  ], {source:'full',tradeDate:'2026-09-14'});
  assert.deepEqual(result.bars.map(row => [row.date,row.close]), [
    ['2026-09-11',11],['2026-09-12',12.5],['2026-09-14',13]
  ]);
  assert.equal(result.lastDate,'2026-09-14');
  assert.ok(result.fullFetchedAt);
  await assert.rejects(() => store.read('../bad'), /股票代码无效/);
});

test('compatible final close preserves same-date OHLCV and price basis metadata', async () => {
  const store = new StockHistoryStore(fs.mkdtempSync(path.join(os.tmpdir(), 'stock-overlay-')));
  await store.merge('600001', [{date:'2026-09-14',open:10,high:12,low:9,close:11,volume:1000}],
    {source:'provider',adjustment:'qfq',fullRefresh:true});
  const result = await store.merge('600001', [{date:'2026-09-14',close:11.5}],
    {source:'provider',adjustment:'qfq',tradeDate:'2026-09-14'});
  assert.deepEqual(result.bars[0], {date:'2026-09-14',open:10,high:12,low:9,close:11.5,volume:1000,source:'provider',adjustment:'qfq'});
  assert.equal(result.source, 'provider');
  assert.equal(result.adjustment, 'qfq');
});

test('incompatible incremental close is separate non-comparable finalClose evidence', async () => {
  for (const overlay of [{source:'other',adjustment:'qfq'}, {source:'provider',adjustment:'none'}]) {
    const store = new StockHistoryStore(fs.mkdtempSync(path.join(os.tmpdir(), 'stock-basis-')));
    const original = await store.merge('600001', [{date:'2026-09-14',open:10,high:12,low:9,close:11,volume:1000}],
      {source:'provider',adjustment:'qfq',fullRefresh:true});
    const result = await store.merge('600001', [{date:'2026-09-14',close:20},{date:'2026-09-15',close:21}],
      {...overlay,tradeDate:'2026-09-15'});
    assert.deepEqual(result.bars, original.bars);
    assert.equal(result.source, 'provider');
    assert.equal(result.adjustment, 'qfq');
    assert.equal(result.lastDate, '2026-09-14');
    assert.equal(result.tradeDate, '2026-09-14');
    assert.deepEqual(result.finalClose.map(row => [row.date,row.close,row.source,row.adjustment,row.comparable]),
      [['2026-09-14',20,overlay.source,overlay.adjustment,false],['2026-09-15',21,overlay.source,overlay.adjustment,false]]);
    const again = await store.merge('600001', [{date:'2026-09-15',close:21}], {...overlay,tradeDate:'2026-09-15'});
    assert.equal(again.finalClose.length, 2);
  }
});

test('fullRefresh changes the whole history basis rather than blending old rows', async () => {
  const store = new StockHistoryStore(fs.mkdtempSync(path.join(os.tmpdir(), 'stock-refresh-')));
  await store.merge('600001', [{date:'2026-09-14',close:11},{date:'2026-09-15',close:12}],
    {source:'first',adjustment:'qfq',fullRefresh:true});
  const refreshed = await store.merge('600001', [{date:'2026-09-15',open:19,high:21,low:18,close:20,volume:100}],
    {source:'second',adjustment:'none',fullRefresh:true});
  assert.equal(refreshed.bars.length, 1);
  assert.equal(refreshed.source, 'second');
  assert.equal(refreshed.adjustment, 'none');
  assert.equal(refreshed.bars[0].close, 20);
  assert.equal(refreshed.firstDate, '2026-09-15');
});

test('row-level incompatible basis cannot bypass the store basis', async () => {
  const store = new StockHistoryStore(fs.mkdtempSync(path.join(os.tmpdir(), 'stock-row-basis-')));
  const original = await store.merge('600001', [{date:'2026-09-14',close:11}], {source:'provider',adjustment:'qfq'});
  const result = await store.merge('600001', [{date:'2026-09-14',close:20,source:'provider',adjustment:'none'}],
    {source:'provider',adjustment:'qfq'});
  assert.deepEqual(result.bars, original.bars);
  assert.equal(result.finalClose[0].comparable, false);
});

test('default merge options inherit the basis and preserve field-level sources', async () => {
  const store = new StockHistoryStore(fs.mkdtempSync(path.join(os.tmpdir(), 'stock-sources-')));
  await store.merge('600001', [{date:'2026-09-14',open:10,high:12,low:9,close:11,volume:1000,sources:{open:'daily',volume:'daily',close:'snapshot'}}],
    {source:'provider',adjustment:'qfq',fullRefresh:true});
  const result = await store.merge('600001', [{date:'2026-09-14',close:11.5,sources:{close:'final'}}]);
  assert.deepEqual(result.bars[0].sources,{open:'daily',volume:'daily',close:'final'});
  assert.equal(result.bars[0].source,'provider');
  assert.equal(result.bars[0].adjustment,'qfq');
  const invalid = await store.merge('600001', [{date:'2026-02-30',close:12},{date:'2026-09-15',close:Infinity},{date:'2026-09-15',close:0}],
    {source:'other',adjustment:'none',tradeDate:'2026-09-15',fullRefresh:true});
  assert.deepEqual(invalid.bars,result.bars);
  assert.equal(invalid.source,result.source);
  assert.equal(invalid.adjustment,result.adjustment);
  assert.equal(invalid.fullFetchedAt,result.fullFetchedAt);
});
