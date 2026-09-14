const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {atomicWriteJson, readJsonWithBackup, ResearchJobStore} = require('../lib/persistence');

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
