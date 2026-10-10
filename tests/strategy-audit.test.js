const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const script = path.join(__dirname,'../scripts/audit-strategy-window.cjs');
const api = () => {
  assert.ok(fs.existsSync(script),'local-only audit CLI exists');
  return require(script);
};
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'strategy-audit-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const write = (file,value) => {
    const target = path.join(root,file);
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,typeof value === 'string' ? value : JSON.stringify(value));
    return target;
  };
  write('data/user-state.json',{labels:[{name:'personal',stocks:[{code:'600001',favoriteBasePrice:10,favoriteAddedAt:'2026-09-30'}]},
    {name:'重点关注',stocks:[{code:'600002',favoriteBasePrice:20,favoriteAddedAt:'2026-09-30'}]}]});
  write('cache/market-overview.json',{data:{tradeDate:'2026-10-08',breadth:{up:1,down:1}}});
  write('cache/market-rotation-history.json',{data:[]});
  write('data/market-history/60/600001.json',{code:'600001',source:'fixture',bars:[{date:'2026-10-08',close:11,isFinal:true}]});
  write('data/market-history/60/600002.json',{code:'600002',source:'fixture',bars:[{date:'2026-10-08',close:18,isFinal:true}]});
  write('data/recommendation-ledger/daily/2026-09-30.jsonl',JSON.stringify({batchId:'batch',tradeDate:'2026-09-30',
    publishedAt:'2026-09-30T15:30:00+08:00',inputCutoffAt:'2026-09-30T15:00:00+08:00',modelVersion:'fixture-v1',
    recommendations:[{code:'600001',signalId:'signal',strategyId:'fixture',price:10,entryPermission:'watch'}]})+'\n');
  return {root,write};
}

test('audit rejects invalid dates, inverted windows and unknown flags', () => {
  const {parseArgs} = api();
  for (const args of [[],['--from','2026-02-30','--to','2026-10-08','--root','.'],
    ['--from','2026-10-08','--to','2026-09-30','--root','.'],
    ['--from','2026-09-30','--to','2026-10-08','--root','.','--network']]) assert.throws(() => parseArgs(args));
  assert.equal(parseArgs(['--from','2026-09-30','--to','2026-10-08','--root','.']).from,'2026-09-30');
});

test('frozen JSON uses hashed bytes after source replacement', async t => {
  const {root,write} = fixture(t);
  const {freezeFile,parseFrozenJson} = api();
  const file = write('input.json',{value:'original'});
  const original = fs.readFileSync(file);
  const frozen = await freezeFile(file,path.join(root,'snapshot'));
  write('input.json',{value:'replaced'});
  assert.equal(frozen.sha256,hash(original));
  assert.equal(frozen.bytes,original.length);
  assert.deepEqual(parseFrozenJson(frozen),{value:'original'});
});

test('large episode details are complete, hashed and kept below chunk budget', async t => {
  const {root} = fixture(t);
  const rows = Array.from({length:12},(_,index) => ({episodeId:`event-${index}`,evidence:'x'.repeat(180000)}));
  const result = await api().splitEpisodeDetails(rows,root);
  assert.equal(result.count,12);
  assert.ok(result.chunks.length > 1);
  const restored = result.chunks.flatMap(chunk => {
    const content = fs.readFileSync(path.join(root,chunk.file));
    assert.ok(content.length <= 1_900_000);
    assert.equal(hash(content),chunk.sha256);
    return content.toString('utf8').trim().split('\n').map(JSON.parse);
  });
  assert.deepEqual(restored,rows);
});

test('ledger snapshot fixes byte boundary, hash and incomplete-tail diagnostics', async t => {
  const {root,write} = fixture(t);
  const {freezeFile,readFrozenLedger} = api();
  const file = write('ledger.jsonl',JSON.stringify({tradeDate:'2026-10-08',batchId:'first'})+'\n{unfinished');
  const original = fs.readFileSync(file);
  const frozen = await freezeFile(file,path.join(root,'snapshot'));
  fs.appendFileSync(file,'}\n'+JSON.stringify({tradeDate:'2026-10-08',batchId:'late'})+'\n');
  const result = await readFrozenLedger(frozen,{from:'2026-10-08',to:'2026-10-08'});
  assert.equal(frozen.sha256,hash(original));
  assert.equal(frozen.bytes,original.length);
  assert.deepEqual(result.entries.map(row => row.batchId),['first']);
  assert.equal(result.incompleteTail,true);
});

test('same frozen input produces deterministic data, unique runs and no business writes', async t => {
  const {root} = fixture(t);
  const {runAudit} = api();
  const options = {root,from:'2026-09-30',to:'2026-10-08'};
  const business = ['data/user-state.json','cache/market-overview.json','cache/market-rotation-history.json',
    'data/recommendation-ledger/daily/2026-09-30.jsonl','data/market-history/60/600001.json','data/market-history/60/600002.json'];
  const before = business.map(file => hash(fs.readFileSync(path.join(root,file))));
  const first = await runAudit(options), second = await runAudit(options);
  assert.notEqual(first.runId,second.runId);
  assert.notEqual(first.evidenceFile,second.evidenceFile);
  assert.deepEqual(first.evidence.data,second.evidence.data);
  assert.deepEqual(first.evidence.inputs,second.evidence.inputs);
  assert.deepEqual(business.map(file => hash(fs.readFileSync(path.join(root,file)))),before);
  assert.equal(first.evidence.data.favorites.count,2);
  assert.deepEqual(first.evidence.data.favorites.rows.map(row => row.returnPct),[10,-10]);
  assert.equal(first.evidence.data.publishedOutcomes.sourceType,'published-ledger');
  assert.ok(first.evidenceFile.startsWith(path.join(root,'cache','strategy-audits')));
  assert.deepEqual(fs.readdirSync(path.dirname(first.evidenceFile)),['evidence.json']);
  assert.equal(first.evidence.data.quality.networkRequests,0);
  await assert.rejects(runAudit({...options,output:path.join(root,'data')}),/business|output/i);
});

test('legacy broad signals stay in isolated stats and monthly overlap is not double counted', async t => {
  const {root,write} = fixture(t);
  const batch = {batchId:'broad',tradeDate:'2026-09-30',modelVersion:'fixture-v1',
    publishedAt:'2026-09-30T15:30:00+08:00',inputCutoffAt:'2026-09-30T15:00:00+08:00',
    recommendations:[{code:'600001',signalId:'signal',strategyId:'fixture',price:10,fullMarketFactor:{scope:'broad'},entryPermission:'blocked'},
      {code:'600002',signalId:'signal-2',price:20,recommendationTier:'历史待筛'}]};
  write('data/recommendation-ledger/daily/2026-09-30.jsonl',JSON.stringify(batch)+'\n');
  write('data/recommendation-ledger/2026-09.jsonl',JSON.stringify(batch)+'\n');
  const result = await api().runAudit({root,from:'2026-09-30',to:'2026-10-08'});
  assert.equal(result.evidence.data.legacyBroadList.signals,2);
  assert.equal(result.evidence.data.legacyBroadList.codes,2);
  assert.equal(result.evidence.data.publishedOutcomes.counts.episodes,0);
});
