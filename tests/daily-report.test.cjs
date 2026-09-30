const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  calculateRecommendationPerformance,
  selectPublishedBatch,
  selectPublishedBatchStatus,
  classifyRecommendationRole,
  buildDailyReport,
  renderDailyReportHtml
} = require('../lib/daily-report');
const {
  DailyReportStore,
  readLedgerEntriesForDate,
  readLedgerEntriesOffThread,
  reportDatesToGenerate
} = require('../lib/report-service');

test('推荐后价格表现与涨幅百分点分别计算', () => {
  const result = calculateRecommendationPerformance({signalChangePct:2.26, closeChangePct:10.01});
  assert.equal(result.changeDeltaPoints, 7.75);
  assert.equal(result.priceReturnPct, null);
});

test('空收盘和跨日行情不会伪造涨跌或已核验收盘', () => {
  assert.deepEqual(calculateRecommendationPerformance({signalPrice:10,closePrice:null,signalChangePct:2,closeChangePct:null}),
    {priceReturnPct:null,changeDeltaPoints:null});
  const report = buildDailyReport({tradeDate:'2026-09-22',stable:[{code:'000823',price:23.71,changePct:1.41}],
    closingQuotes:[{code:'000823',price:25.2,changePct:7.78,tradeDate:'2026-09-21',isFinal:true}]});
  assert.equal(report.recommendations.all[0].closeChangePct, null);
  assert.equal(report.recommendations.all[0].dataStatus, '收盘行情待核验');
  assert.equal(report.status, 'partial');
});

test('两个交易日的超声电子报告分别使用对应收盘价和红色涨幅', () => {
  const rows = [{code:'000823',name:'超声电子',price:23.71,changePct:1.41}];
  const build = (tradeDate,price,changePct) => buildDailyReport({tradeDate,stable:rows,
    closingQuotes:[{code:'000823',price,changePct,tradeDate,isFinal:true,source:'腾讯收盘后行情'}]});
  const previous = build('2026-09-21',25.2,7.78);
  const current = build('2026-09-22',25.22,.08);
  assert.equal(previous.recommendations.all[0].closeChangePct, 7.78);
  assert.equal(current.recommendations.all[0].closeChangePct, .08);
  assert.match(renderDailyReportHtml(current), /推荐时价格/);
  assert.match(renderDailyReportHtml(current), /当日收盘/);
  assert.match(renderDailyReportHtml(current), /<td>23\.71<\/td>/);
  assert.match(renderDailyReportHtml(current), /<td>25\.22<\/td>/);
  assert.match(renderDailyReportHtml(current), /class="up">\+0\.08%/);
  assert.doesNotMatch(renderDailyReportHtml(current), /class="up">\+7\.78%/);
});

test('报告分开展示已发布推荐观察表现和可模拟成交计数', () => {
  const publishedOutcomes={dataStatus:'retrospective-local-history',horizons:[1],counts:{
    publishedSignals:2,episodes:1,execution:{executable:0,unfilled:1,unverified:0}
  },episodes:[{observations:{1:{status:'observed',returnPct:-2}}}]};
  const report=buildDailyReport({tradeDate:'2026-09-22',publishedOutcomes});
  assert.equal(report.publishedOutcomes.counts.episodes,1);
  const html=renderDailyReportHtml(report);
  assert.match(html,/已发布推荐评价/);
  assert.match(html,/未成交 1/);
  assert.match(html,/class="down">-2\.00%/);
  assert.match(html,/参考涨幅不等于账户净收益/);
});

test('当日没有新推荐仍可独立跟踪上一交易日推荐', () => {
  const report=buildDailyReport({tradeDate:'2026-09-22',stable:[],momentum:[],
    followUp:[{code:'000823',name:'超声电子',price:23.71,changePct:1.41,originalTradeDate:'2026-09-21',
      publishedAt:'2026-09-21T03:29:52.000Z',checkpoint:'11:30'}],
    closingQuotes:[{code:'000823',price:25.22,changePct:.08,tradeDate:'2026-09-22',isFinal:true}]});
  assert.equal(report.recommendations.all.length,0);
  assert.equal(report.recommendations.followUp.length,1);
  assert.equal(report.recommendations.followUp[0].closeChangePct,.08);
  assert.match(report.recommendations.followUp[0].checkpoint,/2026-09-21/);
});

test('固定时点只接受目标时间前已发布且行情新鲜的批次', () => {
  const rows = [
    {batchId:'request-only', generatedAt:'2026-09-18T01:53:00.000Z'},
    {batchId:'late', publishedAt:'2026-09-18T02:01:00.000Z', quoteObservedAt:'2026-09-18T01:59:30.000Z'},
    {batchId:'stale', publishedAt:'2026-09-18T01:59:00.000Z', quoteObservedAt:'2026-09-18T01:55:00.000Z'},
    {batchId:'valid', publishedAt:'2026-09-18T01:59:40.000Z', quoteObservedAt:'2026-09-18T01:58:40.000Z'}
  ];
  const selected = selectPublishedBatch(rows, '2026-09-18T02:00:00.000Z');
  assert.equal(selected?.batchId, 'valid');
  assert.equal(selectPublishedBatch(rows.slice(0, 3), '2026-09-18T02:00:00.000Z'), null);
  const stale = selectPublishedBatchStatus(rows.slice(0, 3), '2026-09-18T02:00:00.000Z');
  assert.equal(stale.status, 'stale');
  assert.equal(stale.nearestPrior.batchId, 'stale');
  assert.equal(stale.quoteAgeMs, 5 * 60 * 1000);
  assert.match(stale.reason, /行情距检查点/);
});

test('推荐角色要求对应证据且破位优先拒绝', () => {
  assert.equal(classifyRecommendationRole({analysis:{trendBroken:true}}).primaryRole, '结构失效');
  assert.equal(classifyRecommendationRole({entryPermission:'blocked'}).entryPermission, 'blocked');
  assert.equal(classifyRecommendationRole({capital:{available:true,netRatio:5}, sector:{phase:'持续扩散'}, relativeStrength:88}).primaryRole, '资金前排');
  assert.equal(classifyRecommendationRole({analysis:{breakoutConfirmed:true,firstPullback:true,volumeRatio:.8}, capital:{mainNetInflow:100}}).primaryRole, '首次回踩');
  assert.equal(classifyRecommendationRole({analysis:{boxStable:true,volumeCompressed:true}, capital:{mainNetInflow:100}}).primaryRole, '吸筹/洗盘观察');
  assert.equal(classifyRecommendationRole({analysis:{boxStable:false}, capital:{available:false}}).primaryRole, '趋势观察');
});

test('每日报告保留A/B重叠但全局去重并披露缺失数据', () => {
  const report = buildDailyReport({
    tradeDate:'2026-09-18', generatedAt:'2026-09-18T07:30:00.000Z', modelVersion:'v-test',
    market:{breadth:{up:4234,down:1151,flat:529},turnover:2092546149100,warnings:['逐日资金缺失']},
    stable:[{code:'600001',name:'测试一',price:10,changePct:2,publishedAt:'2026-09-18T02:00:00.000Z'}],
    momentum:[
      {code:'600001',name:'测试一',price:10,changePct:2,publishedAt:'2026-09-18T02:00:00.000Z'},
      {code:'600002',name:'测试二',price:20,changePct:-1}
    ],
    closingQuotes:[{code:'600001',price:11,changePct:10,tradeDate:'2026-09-18',isFinal:true}],
    favorites:[
      {code:'600001',label:'0918-推荐',referencePrice:10,currentPrice:11},
      {code:'600001',label:'0918-推荐副本',referencePrice:10,currentPrice:11},
      {code:'600003',label:'personal',referencePrice:10,currentPrice:9}
    ]
  });
  assert.equal(report.recommendations.all.length, 2);
  assert.equal(report.recommendations.overlapCount, 1);
  assert.equal(report.recommendations.all.find(row => row.code === '600001').priceReturnPct, 10);
  assert.equal(report.recommendations.all.find(row => row.code === '600002').dataStatus, '收盘行情缺失');
  assert.deepEqual(report.recommendations.best.map(row => row.code), ['600001']);
  assert.deepEqual(report.recommendations.worst.map(row => row.code), ['600001']);
  assert.equal(report.favorites.count, 1);
  assert.equal(report.favorites.averageReturnPct, 10);
  assert.deepEqual(report.dataQuality.warnings, ['逐日资金缺失']);
});

test('报告区分发布观察、触发观察并显示检查点缺失原因', () => {
  const report = buildDailyReport({
    tradeDate:'2026-09-30',
    stable:[
      {code:'600001',price:10,changePct:1,publishedAt:'2026-09-30T01:59:00Z',entryPermission:'watch'},
      {code:'600002',price:20,changePct:2,publishedAt:'2026-09-30T03:28:00Z',entryPermission:'allowed',triggeredAt:'2026-09-30T03:29:00Z'}
    ],
    closingQuotes:[
      {code:'600001',price:9,changePct:-9,tradeDate:'2026-09-30',isFinal:true},
      {code:'600002',price:22,changePct:10,tradeDate:'2026-09-30',isFinal:true}
    ],
    checkpoints:[
      {label:'10:00',status:'covered',publishedAt:'2026-09-30T01:59:00Z'},
      {label:'11:30',status:'stale',reason:'最近批次行情距检查点124秒'}
    ]
  });
  assert.equal(report.recommendations.performance.published.count,2);
  assert.equal(report.recommendations.performance.published.averageReturnPct,0);
  assert.equal(report.recommendations.performance.triggered.count,1);
  assert.equal(report.recommendations.performance.triggered.averageReturnPct,10);
  const html = renderDailyReportHtml(report);
  assert.match(html,/全天首次发布观察/);
  assert.match(html,/11:30.*行情距检查点124秒/s);
});

test('报告HTML转义动态文本且拒绝危险资讯链接', () => {
  const html = renderDailyReportHtml({
    tradeDate:'2026-09-18', revision:1, status:'partial', summary:'<script>alert(1)</script>',
    market:{breadth:{}}, sectors:[], recommendations:{all:[],stable:[],momentum:[],overlapCount:0},
    favorites:{count:0,rows:[]}, portfolio:{positions:[]},
    news:[{title:'<b>公告</b>',url:'javascript:alert(1)'}], dataQuality:{warnings:['<img src=x>']}
  });
  assert.doesNotMatch(html, /<script>|<b>公告|javascript:/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;b&gt;公告&lt;\/b&gt;/);
});

test('报告存储对相同输入幂等且数据更正生成修订', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-'));
  const store = new DailyReportStore(root);
  const first = await store.save('2026-09-18', {tradeDate:'2026-09-18',generatedAt:'2026-09-18T07:30:01.000Z',summary:'first'}, {source:'test',reason:'首次生成'});
  const same = await store.save('2026-09-18', {tradeDate:'2026-09-18',generatedAt:'2026-09-18T07:31:01.000Z',summary:'first'}, {source:'test',reason:'定时重试'});
  const revised = await store.save('2026-09-18', {tradeDate:'2026-09-18',summary:'corrected'}, {source:'test',reason:'数据更正'});
  assert.equal(first.revision, 1);
  assert.equal(same.revision, 1);
  assert.equal(same.unchanged, true);
  assert.equal(revised.revision, 2);
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.load('2026-09-18')).report.summary, 'corrected');
  assert.ok(fs.existsSync(path.join(root, '2026-09-18', 'report-r001.html')));
  assert.ok(fs.existsSync(path.join(root, '2026-09-18', 'report-r002.json')));
});

test('同一交易日报告并发保存按输入顺序生成完整修订', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-concurrent-'));
  const store = new DailyReportStore(root);
  const rows = await Promise.all(['first','second','third'].map(summary =>
    store.save('2026-09-22',{tradeDate:'2026-09-22',summary},{source:'test'})));
  assert.deepEqual(rows.map(row => row.revision),[1,2,3]);
  assert.equal((await store.load('2026-09-22')).report.summary,'third');
  assert.equal((await store.list()).length,1);
});

test('同输入重试修复遗漏索引，缺失HTML时补建新修订', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-repair-'));
  const store = new DailyReportStore(root);
  const report = {tradeDate:'2026-09-22',summary:'已确认收盘'};
  await store.save('2026-09-22',report,{source:'test'});
  fs.writeFileSync(path.join(root,'index.json'),JSON.stringify({reports:[]}), 'utf8');
  const retried = await store.save('2026-09-22',report,{source:'test'});
  assert.equal(retried.unchanged,true);
  assert.equal((await store.list()).length,1);
  fs.unlinkSync(path.join(root,'2026-09-22','report-r001.html'));
  const repaired = await store.save('2026-09-22',report,{source:'test'});
  assert.equal(repaired.revision,2);
  assert.ok(fs.existsSync(path.join(root,'2026-09-22','report-r002.html')));
});

test('盘中预览可在浏览器打开但不归档为正式报告', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-preview-'));
  const store = new DailyReportStore(root);
  const date = '2026-09-29';
  const first = await store.savePreview(date, {tradeDate:date,status:'preview',revision:0,summary:'首次预览'});
  assert.equal(await store.htmlPath(date,0),first);
  assert.match(fs.readFileSync(first,'utf8'),/盘中预览/);
  const latest = await store.savePreview(date, {tradeDate:date,status:'preview',revision:0,summary:'再次生成'});
  assert.equal(latest,first);
  assert.match(fs.readFileSync(latest,'utf8'),/再次生成/);
  assert.equal(await store.load(date),null);
  assert.deepEqual(await store.list(),[]);
  await store.save(date,{tradeDate:date,summary:'正式收盘'},{source:'test'});
  assert.equal(await store.htmlPath(date,0),first);
  assert.equal((await store.list()).length,1);
  assert.equal(await new DailyReportStore(root).htmlPath(date,0),null);
});

test('推荐账本按日期流式读取并跳过损坏和未完成尾行', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-ledger-'));
  const file = path.join(root, '2026-09.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({tradeDate:'2026-09-17',batchId:'old'}),
    '{broken}',
    JSON.stringify({tradeDate:'2026-09-18',batchId:'wanted'}),
    '{unfinished'
  ].join('\n'), 'utf8');
  const result = await readLedgerEntriesForDate(file, '2026-09-18');
  assert.deepEqual(result.entries.map(row => row.batchId), ['wanted']);
  assert.equal(result.invalidLines, 1);
  assert.equal(result.incompleteTail, true);
});

test('旧月度账本可在工作线程按日期读取', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-ledger-worker-'));
  const file = path.join(root, '2026-09.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({tradeDate:'2026-09-17',batchId:'old'}),
    JSON.stringify({tradeDate:'2026-09-18',batchId:'worker'})
  ].join('\n') + '\n', 'utf8');
  const result = await readLedgerEntriesOffThread(file, '2026-09-18');
  assert.deepEqual(result.entries.map(row => row.batchId), ['worker']);
});

test('发布评价在工作线程只返回必要字段，不传输整份行情与分析', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'published-ledger-worker-'));
  const file = path.join(root, '2026-09-18.jsonl');
  fs.writeFileSync(file, JSON.stringify({tradeDate:'2026-09-18',batchId:'batch-1',modelVersion:'v1',
    publishedAt:'2026-09-18T15:35:00+08:00',inputCutoffAt:'2026-09-18T15:00:00+08:00',
    recommendations:[{code:'600001',signalId:'signal-1',strategyDecision:{primaryStrategyId:'A'},
      quote:{price:12,largePayload:'discard'},analysis:{huge:'discard'}}]}) + '\n');
  const result = await readLedgerEntriesOffThread(file,'2026-09-18',120000,true);
  assert.equal(result.entries[0].recommendations[0].price,12);
  assert.equal(result.entries[0].recommendations[0].strategyId,'A');
  assert.equal(result.entries[0].recommendations[0].analysis,undefined);
  assert.equal(result.entries[0].recommendations[0].quote,undefined);
});

test('启动补报仅生成有证据且未生成的最近交易日', () => {
  const dates = reportDatesToGenerate({
    now:'2026-09-18T08:40:00.000Z',
    evidenceDates:['2026-09-14','2026-09-15','2026-09-16','2026-09-17','2026-09-18'],
    existingDates:['2026-09-15','2026-09-17'],
    isTradingDay:date => !['2026-09-14'].includes(date)
  });
  assert.deepEqual(dates, ['2026-09-16','2026-09-18']);
});

test('启动补报候选超过上限时保留最近交易日', () => {
  const dates = reportDatesToGenerate({
    now:'2026-09-18T08:40:00.000Z',
    evidenceDates:['2026-08-01','2026-08-02','2026-08-03','2026-08-04','2026-08-05'],
    existingDates:[],
    isTradingDay:() => true,
    maxDates:3
  });
  assert.deepEqual(dates, ['2026-08-03','2026-08-04','2026-08-05']);
});
