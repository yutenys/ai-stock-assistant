const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {atomicWriteJson, readJsonWithBackup, ResearchJobStore, StockHistoryStore} = require('../lib/persistence');
const {compactFavoriteStock,splitUserState,hydrateUserState,UserStateStore} = require('../lib/user-state-store');

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

test('用户状态将重复收藏证据按内容哈希去重并可完整还原',()=>{
  const snapshot={signal:'待突破',plan:{entryLow:10},capturedAt:'2026-11-05T10:00:00+08:00'};
  const input={schemaVersion:2,labels:[
    {name:'A',stocks:[{code:'600001',favoriteEntrySnapshot:snapshot}]},
    {name:'B',stocks:[{code:'600001',favoriteEntrySnapshot:snapshot}]}
  ]};
  const split=splitUserState(input);
  assert.equal(split.state.schemaVersion,3);
  assert.equal(Object.keys(split.evidence).length,1);
  assert.equal(split.state.labels[0].stocks[0].favoriteEntrySnapshot,undefined);
  assert.equal(split.state.labels[0].stocks[0].favoriteEntrySnapshotRef,
    split.state.labels[1].stocks[0].favoriteEntrySnapshotRef);
  const hydrated=hydrateUserState(split.state,split.evidence);
  assert.deepEqual(hydrated.state.labels[1].stocks[0].favoriteEntrySnapshot,snapshot);
  assert.equal(hydrated.missingEvidence,0);
});

test('主进程再次剥离收藏中的瞬时大对象并保留显示与累计字段',()=>{
  const compact=compactFavoriteStock({code:'600001',name:'甲',price:12,changePct:2,
    favoriteBasePrice:10,favoriteAddedAt:'2026-11-01',pinned:true,
    analysis:{rows:Array(1000).fill('large')},rotationProfiles:Array(100).fill({large:true})});
  assert.deepEqual(compact,{code:'600001',name:'甲',price:12,changePct:2,
    favoriteBasePrice:10,favoriteAddedAt:'2026-11-01',pinned:true});
});

test('用户状态存储在线程中迁移旧格式且缺失证据保持可诊断',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'user-state-store-'));
  const store=new UserStateStore(root);
  const state={schemaVersion:2,revision:7,labels:[{name:'A',stocks:[
    {code:'600001',name:'甲',favoriteEntrySnapshot:{signal:'观察',capturedAt:'2026-11-05'}}
  ]}]};
  const saved=await store.save(state);
  assert.equal(saved.schemaVersion,3);
  assert.equal(saved.revision,7);
  const raw=JSON.parse(fs.readFileSync(path.join(root,'user-state.json'),'utf8'));
  assert.equal(raw.labels[0].stocks[0].favoriteEntrySnapshot,undefined);
  const loaded=await store.load();
  assert.equal(loaded.value.labels[0].stocks[0].favoriteEntrySnapshot.signal,'观察');
  assert.equal(loaded.value.labels[0].stocks[0].analysis,undefined);
  assert.equal(loaded.missingEvidence,0);
  const unchanged=await store.save(loaded.value);
  assert.equal(unchanged.evidenceChanged,false);
  fs.writeFileSync(path.join(root,'user-favorite-evidence.json'),'{}','utf8');
  fs.rmSync(path.join(root,'user-favorite-evidence.json.bak'),{force:true});
  const partial=await store.load();
  assert.equal(partial.missingEvidence,1);
  assert.ok(partial.value.labels[0].stocks[0].favoriteEntrySnapshotRef);
});

test('三千条收藏关系压缩后不丢标签关系且去除瞬时分析数据',()=>{
  const evidence={signal:'等待确认',plan:{entryLow:10,entryHigh:11},capturedAt:'2026-11-05'};
  const labels=Array.from({length:60},(_,labelIndex)=>({name:`标签${labelIndex}`,stocks:Array.from({length:50},(_,stockIndex)=>({
    code:String(600000 + labelIndex * 50 + stockIndex).padStart(6,'0'),name:`股票${stockIndex}`,price:12,
    favoriteBasePrice:10,favoriteAddedAt:'2026-11-01',favoriteEntrySnapshot:evidence,
    analysis:{text:'x'.repeat(2000)},rotationProfiles:Array(20).fill({members:'y'.repeat(100)})
  }))}));
  const input={schemaVersion:2,labels};
  const originalBytes=Buffer.byteLength(JSON.stringify(input));
  const split=splitUserState(input);
  const compactBytes=Buffer.byteLength(JSON.stringify(split.state))+Buffer.byteLength(JSON.stringify(split.evidence));
  const hydrated=hydrateUserState(split.state,split.evidence);
  assert.equal(hydrated.state.labels.reduce((sum,label)=>sum+label.stocks.length,0),3000);
  assert.equal(hydrated.state.labels[10].stocks[20].favoriteEntrySnapshot.signal,'等待确认');
  assert.equal(hydrated.state.labels[10].stocks[20].analysis,undefined);
  assert.ok(compactBytes < originalBytes * 0.2);
});
