const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {readReportSummary,readCacheSummary} = require('../lib/large-json');

const {
  calculateRecommendationPerformance,
  selectPublishedBatch,
  selectPublishedBatchStatus,
  classifyRecommendationRole,
  favoriteSummary,
  buildDailyReport,
  renderDailyReportHtml,
  reconstructLegacyPortfolio
} = require('../lib/daily-report');

test('收藏评价使用冻结时点的大盘和行业基准计算同期超额',()=>{
  const summary=favoriteSummary([{code:'600001',label:'观察',referencePrice:10,currentPrice:12,
    marketReturnPct:10,industryReturnPct:25}]);
  assert.equal(summary.averageReturnPct,20);
  assert.equal(summary.averageMarketExcessReturnPct,10);
  assert.equal(summary.averageIndustryExcessReturnPct,-5);
  assert.equal(summary.marketBenchmarkCount,1);
  assert.match(summary.caveats[0],/大盘超额10%/);
});

test('历史报告只使用截止报告日的模拟成交重建持仓',()=>{
  const trades=[
    {id:'1',time:'2026/11/02 10:00:00',side:'买入',code:'600001',name:'甲',price:10,quantity:200},
    {id:'2',time:'2026/11/03 10:00:00',side:'卖出',code:'600001',name:'甲',price:11,quantity:100},
    {id:'3',time:'2026/11/04 10:00:00',side:'买入',code:'600002',name:'乙',price:8,quantity:100}
  ];
  const result=reconstructLegacyPortfolio(trades,'2026-11-03');
  assert.equal(result.status,'complete');
  assert.deepEqual(result.positions.map(row=>({code:row.code,quantity:row.quantity,costPrice:row.costPrice,realizedPnl:row.realizedPnl})),[
    {code:'600001',quantity:100,costPrice:10,realizedPnl:100}
  ]);
});

test('历史持仓遇到无对应买入的卖出事件保持partial且不伪造持仓',()=>{
  const result=reconstructLegacyPortfolio([
    {time:'2026/11/03 10:00:00',side:'卖出',code:'600001',price:11,quantity:100}
  ],'2026-11-03');
  assert.equal(result.status,'partial');
  assert.deepEqual(result.positions,[]);
  assert.match(result.reason,/卖出数量超过/);
});

test('历史持仓部分异常时报告仍保留可由成交事件确认的持仓',()=>{
  const report=buildDailyReport({tradeDate:'2026-11-03',closingQuotes:[
    {code:'600001',price:11,changePct:1,tradeDate:'2026-11-03',isFinal:true}
  ],portfolio:{unavailableReason:'部分成交事件异常',legacy:{positions:[
    {code:'600001',name:'甲',quantity:100,costPrice:10}
  ]}}});
  assert.equal(report.portfolio.positions.length,1);
  assert.equal(report.portfolio.legacy.coveredUnrealizedPnl,100);
  assert.equal(report.portfolio.unavailableReason,'部分成交事件异常');
});

test('报告三个视图共用冻结术语并区分本地与外部B2',()=>{
  const report = buildDailyReport({tradeDate:'2026-10-09',removedFavoriteEvents:[{favoriteEventId:'f1',code:'600001',removedAt:'2026-10-09T10:00:00+08:00'}]});
  const html = renderDailyReportHtml(report);
  assert.match(html,/id="page-review"/);
  assert.match(html,/id="next-day-plan"/);
  assert.match(html,/id="report-terms"/);
  assert.equal(report.termDefinitions.find(row => row.id === 'track.B').status,'现行规则');
  assert.equal(report.termDefinitions.find(row => row.id === 'external.chan.B2').status,'外部术语');
  assert.match(html,/不映射为本地方案B或接力B2/);
  assert.equal(report.favoriteHistory.removedCount,1);
  assert.match(html,/已移除事件 1 条/);
});

test('评价线程中断时报告不把未知收益和成交显示为零',()=>{
  const report=buildDailyReport({tradeDate:'2026-11-02',publishedOutcomes:{
    dataStatus:'partial',scope:'report-date-only',reason:'评价线程退出',
    decisionFunnel:{publishedSignals:2}}});
  const html=renderDailyReportHtml(report);
  assert.match(html,/仅含报告当日发布账本/);
  assert.match(html,/收益、触发观察及成交统计未知/);
  assert.doesNotMatch(html,/发布批次 0/);
});

test('实际大盘路径对象和影子决策能渲染，缺失锚点不补造',()=>{
  const report=buildDailyReport({tradeDate:'2026-10-09',market:{path:{snapshots:[],anchors:{'10:00':{
    fetchedAt:'2026-10-09T10:00:00+08:00',breadth:{up:1000,down:4000},source:'fixture'}}}},
    strategyExperiments:{manifest:{parameterVersion:'test',frozenAt:'2026-10-09T09:00:00+08:00'},
      decisions:[{id:'H3',status:'pass'}]}});
  const html=renderDailyReportHtml(report);
  assert.match(html,/10:00/);
  assert.match(html,/预注册影子实验/);
  assert.match(html,/H3<\/td><td>1/);
  assert.doesNotMatch(html,/14:30/);
});

test('收盘报告保留组件级数据质量和来源时间',()=>{
  const components={indices:{status:'fresh',source:'腾讯指数',sourceObservedAt:'2026-10-22T07:00:00.000Z'},
    news:{status:'unavailable',source:'',reason:'公开消息源连接失败'}};
  const report=buildDailyReport({tradeDate:'2026-10-22',market:{components}});
  assert.equal(report.status,'partial');
  assert.equal(report.dataQuality.components.news.status,'unavailable');
  const html=renderDailyReportHtml(report);
  assert.match(html,/数据质量/);
  assert.match(html,/公开消息源连接失败/);
  assert.match(html,/2026-10-22T07:00:00.000Z/);
});

test('收盘报告对无可行买点只列观察条件，不伪装次日触发',()=>{
  const report=buildDailyReport({tradeDate:'2026-10-09',stable:[{code:'600001',entryPermission:'watch',
    tradePlan:{feasibility:{status:'empty',reason:'确认价高于最高入场价'},confirmationPrice:11,
      maxEntryPrice:10}}],market:{publishedPlanFunnel:{publishedBatches:3,publishedSignals:8,episodes:5,
        frozenPlans:4,priceFeasible:2,publishedAllowed:1,verifiedTriggers:1,verifiedFills:0,reasons:{'未形成核验入场触发':4}},
      planFunnel:{discovered:1,dataAvailable:1,structureEstablished:1,
        priceFeasible:0,riskPassed:0,armed:0,
        triggered:0,currentlyAllowed:0,reasons:{'确认价高于最高入场价':1}}}});
  assert.match(report.nextDayConditions[0].trigger,/当前无合格买点/);
  const html=renderDailyReportHtml(report);
  assert.match(html,/推荐计划漏斗/);
  assert.match(html,/全天发布批次 3，快照信号 8，合并生命周期 5/);
  assert.match(html,/数据可用 1，结构成立 1，价格可行 0，风险通过 0/);
});

test('超大旧报告按结构化路径跳过重复时间点和episode明细', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'large-report-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'report.json');
  fs.writeFileSync(file,JSON.stringify({tradeDate:'2026-10-09',revision:1,
    market:{breadth:{up:100},path:{snapshots:[{huge:'x'.repeat(10000)}]}},
    publishedOutcomes:{counts:{episodes:2},episodes:[{huge:'x'.repeat(10000)}]},
    recommendations:{all:[{code:'600001'}]}}));
  const report=await readReportSummary(file);
  assert.equal(report.market.path,null);
  assert.deepEqual(report.publishedOutcomes.episodes,[]);
  assert.equal(report.publishedOutcomes.counts.episodes,2);
  assert.equal(report.recommendations.all[0].code,'600001');
});

test('旧大盘缓存的日内重复板块明细可流式压缩', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'large-cache-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'cache.json');
  fs.writeFileSync(file,JSON.stringify({savedAt:1,data:[{tradeDate:'2026-10-09',
    breadth:{up:1},sectors:[{name:'农业',memberCodes:['600001']}],
    snapshots:[{sectors:[{huge:'x'.repeat(10000)}]}],anchors:{close:{huge:'x'.repeat(10000)}}}]}));
  const days=await readCacheSummary(file,'market-rotation-history');
  assert.equal(days[0].sectors[0].memberCount,1);
  assert.equal(days[0].snapshots,undefined);
});
const {
  DailyReportStore,
  readLedgerEntriesForDate,
  readLedgerEntriesOffThread,
  readCachedPublishedLedger,
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

test('盘后首发不计当日平盘，旧仓缺价只披露已核验部分', () => {
  const report=buildDailyReport({tradeDate:'2026-10-09',
    stable:[{code:'600001',price:10,publishedAt:'2026-10-09T15:05:00+08:00'}],
    closingQuotes:[{code:'600001',price:10,changePct:0,tradeDate:'2026-10-09',isFinal:true},
      {code:'600002',price:12,changePct:2,tradeDate:'2026-10-09',isFinal:true}],
    portfolio:{legacy:{positions:[{code:'600002',quantity:100,costPrice:10},{code:'600003',quantity:100,costPrice:10}]}}});
  assert.equal(report.recommendations.performance.published.count,0);
  assert.equal(report.recommendations.all[0].dataStatus,'盘后发布，未进入当日评价窗');
  assert.equal(report.portfolio.legacy.coveredUnrealizedPnl,200);
  assert.deepEqual(report.portfolio.legacy.missingCodes,['600003']);
  assert.equal(report.portfolio.legacy.accountEquity,null);
});

test('历史模拟账户披露最大赢家贡献和剔除最大赢家后的盈亏',()=>{
  const report=buildDailyReport({tradeDate:'2026-10-09',closingQuotes:[
    {code:'600001',price:15,changePct:5,tradeDate:'2026-10-09',isFinal:true},
    {code:'600002',price:8,changePct:-2,tradeDate:'2026-10-09',isFinal:true}],
  portfolio:{legacy:{positions:[
    {code:'600001',name:'甲',quantity:100,costPrice:10},
    {code:'600002',name:'乙',quantity:100,costPrice:10}]}}});
  assert.equal(report.portfolio.legacy.coveredUnrealizedPnl,300);
  assert.equal(report.portfolio.legacy.bestContributor.code,'600001');
  assert.equal(report.portfolio.legacy.bestContributor.pnl,500);
  assert.equal(report.portfolio.legacy.pnlExBest,-200);
  assert.equal(report.portfolio.legacy.topPositiveContributionPct,100);
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

test('当日报告披露亏损尾部、剔除最大赢家均值和收益集中度',()=>{
  const stable=[10,10,10,10].map((price,index)=>({code:`60000${index}`,price,publishedAt:'2026-10-20T10:00:00+08:00'}));
  const closes=[11,9.9,9.8,9.7].map((price,index)=>({code:`60000${index}`,price,changePct:(price/10-1)*100,
    tradeDate:'2026-10-20',isFinal:true}));
  const report=buildDailyReport({tradeDate:'2026-10-20',stable,closingQuotes:closes});
  const summary=report.recommendations.performance.published;
  assert.equal(summary.worstReturnPct,-3);
  assert.equal(summary.averageExBestPct,-2);
  assert.equal(summary.topPositiveContributionPct,100);
  assert.match(renderDailyReportHtml(report),/剔除最大赢家 -2\.00%/);
});

test('报告按A和B路线分别统计表现并继续披露重叠股票',()=>{
  const report=buildDailyReport({tradeDate:'2026-10-20',stable:[
    {code:'600001',price:10,publishedAt:'2026-10-20T10:00:00+08:00'},
    {code:'600002',price:10,publishedAt:'2026-10-20T10:00:00+08:00'}
  ],momentum:[
    {code:'600002',price:10,publishedAt:'2026-10-20T10:01:00+08:00'},
    {code:'600003',price:10,publishedAt:'2026-10-20T10:01:00+08:00'}
  ],closingQuotes:[
    {code:'600001',price:11,changePct:10,tradeDate:'2026-10-20',isFinal:true},
    {code:'600002',price:9,changePct:-10,tradeDate:'2026-10-20',isFinal:true},
    {code:'600003',price:10.5,changePct:5,tradeDate:'2026-10-20',isFinal:true}
  ]});
  assert.equal(report.recommendations.performance.byTrack.A.count,2);
  assert.equal(report.recommendations.performance.byTrack.A.averageReturnPct,0);
  assert.equal(report.recommendations.performance.byTrack.B.averageReturnPct,-2.5);
  assert.equal(report.recommendations.overlapCount,1);
  assert.match(renderDailyReportHtml(report),/方案A 2只，平均 0\.00%/);
  assert.match(renderDailyReportHtml(report),/方案B 2只，平均 -2\.50%/);
});

test('报告保留实现、参数、数据和计划版本', () => {
  const versions={implementationVersion:'git-abc123',parameterVersion:'params-v1',
    dataContractVersion:'data-v2',planContractVersion:'plan-v2'};
  const report=buildDailyReport({tradeDate:'2026-10-20',...versions});
  for (const [key,value] of Object.entries(versions)) assert.equal(report[key],value);
  const html=renderDailyReportHtml(report);
  assert.match(html,/实现 git-abc123/);
  assert.match(html,/参数 params-v1/);
  assert.match(html,/数据契约 data-v2/);
  assert.match(html,/计划契约 plan-v2/);
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
  assert.equal(classifyRecommendationRole({analysis:{supportIntact:true},capital:{mainNetInflow:100},
    distanceToResistancePct:5}).primaryRole,'趋势观察');
  assert.equal(classifyRecommendationRole({analysis:{supportIntact:true},capital:{mainNetInflow:100},
    distanceToResistancePct:5,relativeStrength:75,sectorRelative:{comparable:true,sectorChangePct:3,stockChangePct:1}}).primaryRole,'健康滞涨');
  assert.equal(classifyRecommendationRole({analysis:{supportIntact:true},capital:{mainNetInflow:100},
    distanceToResistancePct:5,relativeStrength:75,sectorRelative:{comparable:true,sectorChangePct:3,stockChangePct:-2}}).primaryRole,'趋势观察');
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
  assert.equal(report.favorites.count, 3);
  assert.equal(report.favorites.codeCount, 2);
  assert.equal(report.favorites.averageReturnPct, 0);
  assert.deepEqual(report.dataQuality.warnings, ['逐日资金缺失']);
});

test('all favorite labels survive; code risk and missing original plans remain explicit', () => {
  const report = buildDailyReport({tradeDate:'2026-10-08',favorites:[
    {code:'600001',label:'personal',addedAt:'2026-09-30',referencePrice:10,currentPrice:11,entryPermission:'watch'},
    {code:'600001',label:'重点关注',addedAt:'2026-10-08',referencePrice:11,currentPrice:11,entryPermission:'blocked',riskReasons:['risk']},
    {code:'600002',label:'other',referencePrice:null,currentPrice:8}
  ]});
  assert.deepEqual(report.favorites.rows.map(row => row.label), ['personal','重点关注','other']);
  assert.equal(report.favorites.byLabel.length,3);
  assert.equal(report.favorites.byCode.find(row => row.code === '600001').entryPermission,'blocked');
  assert.equal(report.favorites.missingOriginalCount,3);
  assert.equal(report.favorites.unknownVersionCount,3);
  assert.equal(report.favorites.rows[2].returnPct,null);
  const html = renderDailyReportHtml(report);
  assert.match(html,/personal/);
  assert.match(html,/重点关注/);
  assert.match(html,/幸存者偏差/);
  assert.match(html,/原始计划缺失/);
  assert.doesNotMatch(html,/排除重点关注/);
});

test('report renders favorite recommendation cohort matrix before simulated account', () => {
  const favoriteBatchPerformance={schemaVersion:1,asOfDate:'2026-11-11',horizonOrder:[1,3,5],
    counts:{rawFavorites:3,dedupedEpisodes:2,invalid:0},
    horizons:{1:{count:2,observed:2,missing:0,immature:0,incomparable:0,averageReturnPct:1,medianReturnPct:1},
      3:{count:2,observed:1,missing:0,immature:1,incomparable:0,averageReturnPct:-2,medianReturnPct:-2},
      5:{count:2,observed:0,missing:0,immature:2,incomparable:0,averageReturnPct:null,medianReturnPct:null}},
    cohorts:[{key:'one',date:'2026-11-10',phase:'盘中',modelVersion:'v1',attribution:'recommendation',
      label:'1110-盘中积极',count:2,current:{observed:2,averageReturnPct:1.5,medianReturnPct:1.5},
      horizons:{1:{observed:2,missing:0,immature:0,incomparable:0,averageReturnPct:1,medianReturnPct:1},
        3:{observed:1,missing:0,immature:1,incomparable:0,averageReturnPct:-2,medianReturnPct:-2},
        5:{observed:0,missing:0,immature:2,incomparable:0,averageReturnPct:null,medianReturnPct:null}}}],
    episodes:[{episodeId:'one',code:'600001',name:'样本',labels:['1110-盘中积极'],baseDate:'2026-11-10',
      phase:'盘中',referencePrice:10,current:{date:'2026-11-11',close:10.1,returnPct:1,todayChangePct:.5},
      observations:{1:{status:'observed',date:'2026-11-11',close:10.1,returnPct:1}}}],
    caveats:['收藏后价格表现不是实际成交收益']};
  const report=buildDailyReport({tradeDate:'2026-11-11',favoriteBatchPerformance});
  assert.equal(report.favoriteBatchPerformance.counts.dedupedEpisodes,2);
  const html=renderDailyReportHtml(report);
  assert.match(html,/每日收藏推荐批次表现/);
  assert.match(html,/1110-盘中积极/);
  assert.match(html,/D\+3/);
  assert.match(html,/未成熟 1/);
  assert.ok(html.indexOf('每日收藏推荐批次表现') < html.indexOf('历史手工模拟'));
});

test('trigger observation starts at recorded trigger price, not publication price', () => {
  const report = buildDailyReport({tradeDate:'2026-10-08',stable:[
    {code:'600001',price:10,entryPermission:'allowed',triggeredAt:'2026-10-08T10:00:00+08:00',
      triggerEvent:{id:'event',type:'entry-allowed',verified:true,source:'local',referencePrice:11,occurredAt:'2026-10-08T10:00:00+08:00'}},
    {code:'600002',price:10,entryPermission:'allowed',triggeredAt:'2026-10-08T10:00:00+08:00'}
  ],closingQuotes:['600001','600002'].map(code => ({code,price:12,changePct:2,tradeDate:'2026-10-08',isFinal:true}))});
  assert.equal(report.recommendations.performance.published.averageReturnPct,20);
  assert.equal(report.recommendations.performance.triggered.count,1);
  assert.equal(report.recommendations.performance.triggered.averageReturnPct,9.09);
});

test('report renders path anchors, sector evidence, next-day expiry and isolated legacy scope', () => {
  const report = buildDailyReport({tradeDate:'2026-10-08',
    market:{path:[{label:'早盘',observedAt:'10:00',state:'weak',source:'local',breadth:{up:1,down:9}}],sourceSwitches:['source changed']},
    sectors:[{name:'sector',stateTransitions:[{from:'watch',to:'blocked'}],evidence:{diffusion:'narrow',capital:'missing'},dataQuality:{missing:['capital']}}],
    nextDayConditions:[{code:'600001',trigger:'completed bar',invalidation:'support lost',expiresAt:'2026-10-09T15:00:00+08:00',dataPrerequisites:['5m']}],
    legacyBroadList:[{code:'600003',price:5}],dataQuality:{missing:['indices']}
  });
  assert.equal(report.recommendations.all.length,0);
  assert.equal(report.legacyBroadList.count,1);
  const html = renderDailyReportHtml(report);
  for (const text of ['早盘','weak','source changed','watch','blocked','narrow','capital','completed bar','support lost','2026-10-09','5m','兼容广泛名单','indices']) assert.ok(html.includes(text),text);
});

test('unknown and immature outcomes never render as zero or enter execution statistics', () => {
  const report = buildDailyReport({tradeDate:'2026-10-08',publishedOutcomes:{horizons:[1],counts:{execution:{executable:9}},episodes:[
    {observations:{1:{status:'observed',returnPct:null}},nextOpenProxy:{status:'executable'},execution:{status:'unknown'},executionObservations:{1:{status:'immature',returnPct:0}}},
    {observations:{1:{status:'observed',returnPct:2}},triggerObservations:{1:{status:'observed',returnPct:-1}},execution:{status:'unfilled'},executionObservations:{1:{status:'observed',returnPct:0}}},
    {nextOpenProxy:{status:'executable'},execution:{status:'executable',verified:false},executionObservations:{1:{status:'observed',returnPct:99,netReturnPct:99}}}
  ]}});
  const html = renderDailyReportHtml(report);
  assert.match(html,/发布后观察/);
  assert.match(html,/触发后观察/);
  assert.match(html,/nextOpenProxy/);
  assert.match(html,/已核验成交 0/);
  assert.match(html,/class="up">\+2\.00%/);
  assert.match(html,/class="down">-1\.00%/);
  assert.doesNotMatch(html,/class="(?:up|down)">0\.00%/);
  assert.doesNotMatch(html,/99\.00%/);
});

test('verified execution displays net costs separately from price observations', () => {
  const html = renderDailyReportHtml(buildDailyReport({tradeDate:'2026-10-08',publishedOutcomes:{horizons:[1],
    counts:{execution:{executable:1},nextOpenProxy:{executable:2}},episodes:[
      {execution:{status:'executable',verified:true},executionObservations:{1:{status:'observed',returnPct:5,netReturnPct:4.5}}}
    ]}}));
  assert.match(html,/已核验成交 1/);
  assert.match(html,/class="up">\+4\.50%/);
});

test('strict calendar dates reject rollover and browser revision must exist', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'report-calendar-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const store = new DailyReportStore(root);
  assert.throws(() => store.directory('2026-02-30'),/日期无效/);
  await store.save('2026-10-08',{summary:'test'});
  assert.equal(await store.htmlPath('2026-10-08',2),null);
  fs.unlinkSync(path.join(root,'2026-10-08','report-r001.html'));
  assert.equal(await store.htmlPath('2026-10-08',1),null);
});

test('corrupt same-hash JSON or HTML creates a fresh complete revision', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'report-corrupt-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const store = new DailyReportStore(root);
  const report = {summary:'test'};
  await store.save('2026-10-08',report);
  fs.writeFileSync(path.join(root,'2026-10-08','report-r001.json'),'{broken');
  assert.equal((await store.save('2026-10-08',report)).revision,2);
  fs.writeFileSync(path.join(root,'2026-10-08','report-r002.html'),'wrong revision');
  assert.equal((await store.save('2026-10-08',report)).revision,3);
  assert.match(fs.readFileSync(await store.htmlPath('2026-10-08'),'utf8'),/修订 r003/);
});

test('compact ledger preserves frozen plan, trigger, terminal and risk contract', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'report-contract-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const file = path.join(root,'ledger.jsonl');
  const item = {code:'600001',signalId:'signal',planId:'plan',planRevision:2,episodeId:'episode',
    entryPermission:'expired',terminal:true,expiresAt:'2026-10-09T15:00:00+08:00',maxEntryPrice:12,
    riskChecks:{allowed:false},costAssumptions:{slippageBps:10},
    triggerEvent:{id:'trigger',type:'entry-allowed',observedAt:'2026-10-08T10:00:00+08:00',price:11},
    plan:{entryExpiryDate:'2026-10-09',expectedEntryPrice:11},planState:'expired',
    tradePlan:{entryExpiryDate:'2026-10-09',expectedEntryPrice:11},
    earliestBuyDate:'2026-10-09',earliestSellDate:'2026-10-12',
    executionEvidence:{type:'quote',verified:true,price:11,observedAt:'2026-10-08T10:05:00+08:00'},
    quote:{price:11,tradeDate:'2026-10-08',quoteObservedAt:'2026-10-08T10:00:00+08:00',huge:'discard'}};
  fs.writeFileSync(file,JSON.stringify({tradeDate:'2026-10-08',batchId:'batch',recommendations:[item]})+'\n');
  const compact = (await readLedgerEntriesForDate(file,'2026-10-08',{compact:true})).entries[0].recommendations[0];
  for (const key of ['planId','planRevision','episodeId','terminal','expiresAt','maxEntryPrice','riskChecks','costAssumptions','triggerEvent','tradePlan','plan','planState','earliestBuyDate','earliestSellDate','executionEvidence']) assert.deepEqual(compact[key],item[key],key);
  assert.equal(compact.quoteTradeDate,'2026-10-08');
  assert.equal(compact.quoteObservedAt,item.quote.quoteObservedAt);
  assert.equal(compact.quote,undefined);
});

test('报告区分发布观察、触发观察并显示检查点缺失原因', () => {
  const report = buildDailyReport({
    tradeDate:'2026-09-30',
    stable:[
      {code:'600001',price:10,changePct:1,publishedAt:'2026-09-30T01:59:00Z',entryPermission:'watch'},
      {code:'600002',price:20,changePct:2,publishedAt:'2026-09-30T03:28:00Z',entryPermission:'allowed',triggeredAt:'2026-09-30T03:29:00Z',
        triggerEvent:{id:'trigger',type:'entry-allowed',verified:true,source:'local',referencePrice:20,occurredAt:'2026-09-30T03:29:00Z'}}
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

test('结构失效不能被显式入场许可覆盖', () => {
  const role = classifyRecommendationRole({
    entryPermission:'allowed',
    analysis:{trendBroken:true}
  });
  assert.equal(role.primaryRole, '结构失效');
  assert.equal(role.entryPermission, 'blocked');
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

test('分块报告明细按页读取并验证哈希，不读取整份旧报告', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'report-detail-page-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const date = '2026-10-09', directory = path.join(root,date,'outcome-details');
  fs.mkdirSync(directory,{recursive:true});
  const rows = [{episodeId:'a'},{episodeId:'b'},{episodeId:'c'}];
  const content = rows.map(JSON.stringify).join('\n')+'\n';
  const sha256 = require('node:crypto').createHash('sha256').update(content).digest('hex');
  const file = `outcome-details/${sha256}.jsonl`;
  fs.writeFileSync(path.join(root,date,file),content);
  const store = new DailyReportStore(root);
  await store.save(date,{tradeDate:date,publishedOutcomes:{episodeChunks:[{file,sha256,count:3,bytes:Buffer.byteLength(content)}]}});
  assert.match(fs.readFileSync(path.join(root,date,'report-r001.html'),'utf8'),/离线浏览器可打开同目录下的原始JSONL明细块/);
  assert.deepEqual((await store.episodePage(date,null,0,2)).rows,rows.slice(0,2));
  assert.deepEqual((await store.episodePage(date,null,1,2)).rows,rows.slice(2));
  assert.equal((await store.episodePage(date,null,1,2)).hasMore,false);
  fs.appendFileSync(path.join(root,date,file),'{}\n');
  await assert.rejects(store.episodePage(date,null,0,2),/校验失败/);
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
      businessRelation:'confirmed-business',businessRelationEvidence:{source:'公司资料',url:'https://example.com/company',excerpt:'主营业务',observedAt:'2026-09-18T10:00:00+08:00'},
      quote:{price:12,largePayload:'discard'},analysis:{huge:'discard'}},
    {code:'600002',signalId:'scan',fullMarketFactor:{scope:'market'},quote:{price:10}},
    {code:'600003',signalId:'old',recommendationTier:'历史待筛',quote:{price:10}}]}) + '\n');
  const result = await readLedgerEntriesOffThread(file,'2026-09-18',120000,true);
  assert.equal(result.entries[0].recommendations[0].price,12);
  assert.equal(result.entries[0].recommendations[0].strategyId,'A');
  assert.equal(result.entries[0].recommendations[0].analysis,undefined);
  assert.equal(result.entries[0].recommendations[0].quote,undefined);
  assert.equal(result.entries[0].recommendations[0].businessRelationEvidence.url,'https://example.com/company');
  assert.equal(result.entries[0].recommendations.length,3);
});

test('逐日压缩缓存命中、账本追加失效且损坏缓存回退原账本', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'published-ledger-cache-'));
  const file=path.join(root,'2026-09-18.jsonl'),cacheDir=path.join(root,'cache');
  const batch=id=>({tradeDate:'2026-09-18',batchId:id,modelVersion:'v1',
    publishedAt:'2026-09-18T10:00:00+08:00',inputCutoffAt:'2026-09-18T09:59:00+08:00',
    recommendations:[{code:'600001',signalId:id,price:10,strategyId:'trend'},
      {code:'600002',signalId:`${id}-scan`,price:10,strategyId:'trend',fullMarketFactor:{scope:'broad'}}]});
  fs.writeFileSync(file,`${JSON.stringify(batch('first'))}\ninvalid-json\n`,'utf8');
  const first=await readCachedPublishedLedger(file,'2026-09-18',cacheDir);
  const second=await readCachedPublishedLedger(file,'2026-09-18',cacheDir);
  assert.equal(first.cacheHit,false);
  assert.equal(second.cacheHit,true);
  assert.equal(second.invalidLines,1);
  assert.equal(second.entries[0].recommendations.length,1);
  const firstCache=fs.readdirSync(cacheDir).find(name=>name.endsWith('.gz'));
  fs.appendFileSync(file,`${JSON.stringify(batch('second'))}\n`,'utf8');
  const third=await readCachedPublishedLedger(file,'2026-09-18',cacheDir);
  assert.equal(third.cacheHit,false);
  assert.equal(third.entries.length,2);
  const latest=fs.readdirSync(cacheDir).filter(name=>name.endsWith('.gz') && name!==firstCache)
    .map(name=>path.join(cacheDir,name))[0];
  assert.ok(latest);
  fs.writeFileSync(latest,'corrupt','utf8');
  const recovered=await readCachedPublishedLedger(file,'2026-09-18',cacheDir);
  assert.equal(recovered.cacheHit,false);
  assert.equal(recovered.entries.length,2);
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

test('短线修复影子候选单列且不计入正式推荐表现', () => {
  const report=buildDailyReport({tradeDate:'2026-11-06',stable:[],momentum:[],shortReboundCandidates:[{
    code:'600001',name:'测试修复',industry:'电子',shortRebound:{type:'超跌首修复',state:'condition-pending',score:72,
      resistance:10.5,invalidation:9.4,summary:'低点稳定，等待量价确认。'}
  }],shortReboundWatchCandidates:[{code:'600002',name:'观察修复',industry:'电子',
    shortRebound:{type:'强趋势回踩修复',state:'condition-pending'},
    shortReboundSelection:{reasons:['收益风险比不足2']} }],publishedOutcomes:{horizons:[1],counts:{publishedBatches:0,publishedSignals:0,episodes:0},
    shortReboundShadow:{counts:{publishedSignals:2,episodes:1},note:'仅作发布后观察',
      horizonSummaries:{1:{count:1,meanReturnPct:2.5,medianReturnPct:2.5,immature:0,missing:0}}}}});
  assert.equal(report.recommendations.all.length,0);
  assert.equal(report.shortReboundCandidates.length,1);
  assert.equal(report.shortReboundWatchCandidates.length,1);
  const html=renderDailyReportHtml(report);
  assert.match(html,/短线修复精选影子/);
  assert.match(html,/收益风险比不足2/);
  assert.match(html,/不纳入正式推荐收益/);
  assert.match(html,/短线修复发布后观察/);
  assert.match(html,/class="up">\+2\.50%/);
});

test('报告单列F题材首板研究且明确影子权限', () => {
  const report=buildDailyReport({tradeDate:'2026-11-11',market:{themeFirstBoard:{status:'data-pending',groups:[{
    themeId:'通信技术',status:'data-pending',verifiedCount:2,eligibleAt:null,reasons:['真实首封时间缺失']
  }]}},stable:[],momentum:[],closingQuotes:[]});
  const html=renderDailyReportHtml(report);
  assert.match(html,/F题材首板研究/);
  assert.match(html,/仅作影子观察，不授予买入权限/);
  assert.match(html,/真实首封时间缺失/);
});
