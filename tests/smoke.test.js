const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const handlers = new Map();
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: false,
        whenReady: () => ({ then: () => {} }),
        on: () => {},
        quit: () => {}
      },
      BrowserWindow: function BrowserWindow() {},
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      shell: { openExternal: async () => true }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  dataRootPath,
  RECOMMENDATION_MODEL_VERSION,
  finiteNumber,
  requestText,
  SECTOR_CAPITAL_FALLBACK_MAX_AGE_MS,
  normalizeQuoteRow,
  normalizeTencentQuote,
  normalizeSinaHistoryRows,
  mapSinaFinancialData,
  buildFinancialAnalysis,
  buildIndividualInvestmentAnalysis,
  attachStrategyPlatform,
  splitDataCenterFinancialRows,
  buildCanslimFromFactors,
  buildRecommendationFactorContext,
  buildDetailFactorAnalysis,
  buildIndustryRotationFromQuotes,
  normalizeSectorCapitalRows,
  eastmoneyListRows,
  fetchEastmoneyListPages,
  chinaClockParts,
  tencentQuoteObservedAt,
  marketQuoteContentSignature,
  resolveObservationPhase,
  crossSectionPercentile,
  buildAiEvidencePrompt,
  validateAiExplanation,
  marketSnapshotId,
  classifyMarketRegime,
  buildStrategyScoreCard,
  mergeSectorCapitalRows,
  classifySectorRotationPhase,
  resolveStockRotationProfiles,
  selectRotationPriorityCandidates,
  momentumRecommendationDecision,
  finalizeMomentumRecommendations,
  canReuseMarketRecommendations,
  evaluateRecommendationFactors,
  assessRecommendationNewsConfirmation,
  parseTencentGlobalIndices,
  assessGlobalMarketContext,
  resolveRecommendationIndustry,
  recommendationIndustryGroupKey,
  groupRecommendationsByIndustry,
  recommendationSignalFamily,
  mergeRecommendationOutcomeQuotes,
  mergeRecommendationOutcomeBenchmarks,
  summarizeRecommendationOutcomes,
  recommendationOutcomeMetadata,
  assessRecommendationHorizons,
  recommendationDataConfidence,
  weightedRecommendationScore,
  filterResolvedRecommendations,
  buildRecommendationLedgerEntry,
  calibrateRecommendationWithOutcomes,
  applyOutcomeFeedbackAssessment,
  recommendationPassesOutcomeGate,
  recommendationGateDecision,
  selectMarketRecommendationCandidates,
  recommendationPassesWatchGate,
  recommendationPassesDisplayGate,
  finalizeRecommendationDisplay,
  restoreCachedMarketRecommendations,
  evaluateRecommendationRisk,
  summarizeNews,
  isMarketWideNews,
  assessRecommendationTimingRisk,
  buildFutureRiskProfile,
  summarizeFundFlowRows,
  estimateFundFlowFromHistory,
  fundFlowPeriodEvidence,
  outcomeStatsAdjustment,
  analyzeAccumulationSetup,
  analyzeConsolidationBreakout,
  combineConsolidationBreakout,
  assessCurrentEntry,
  scoreConsolidationCandidate,
  applyIndividualCapitalAssessment,
  applyEntryContextAssessment,
  assessMarketEnvironment,
  analyzeHistory,
  analyzeTrendContinuation,
  analyzeCapitalWindows,
  analyzePathMetrics,
  selectFullMarketScreening,
  buildBackgroundWatchRecommendations,
  assessBreakoutQuality,
  assessReboundQuality,
  annotateSectorRotation,
  buildTradePlan,
  mergeQuoteIntoHistory,
  aggregateHistoryPeriod,
  parseReductionPlanWindow,
  parseJin10FlashItems,
  classifyMarketNewsIssues,
  settleWithConcurrency
} = require('../main.js');
const {selectSectorMemberBoards, mergeFundFlowSnapshot} = require('../main.js');
const {normalizeEastmoneyFundFlow, summarizeEastmoneyFundHistory, formatBusinessProducts, mapDataCenterCompanyProfile, emF10Code, dataCenterRows} = require('../main.js');
Module._load = originalLoad;

test('显式绝对数据根目录覆盖开发和测试默认路径', () => {
  const previous = process.env.STOCK_ASSISTANT_DATA_ROOT;
  const explicitRoot = path.resolve(__dirname, '.temporary-data-root');
  try {
    process.env.STOCK_ASSISTANT_DATA_ROOT = explicitRoot;
    assert.equal(dataRootPath(), explicitRoot);
    process.env.STOCK_ASSISTANT_DATA_ROOT = 'relative-path-is-not-accepted';
    assert.equal(dataRootPath(), path.resolve(__dirname, '..'));
  } finally {
    if (previous === undefined) delete process.env.STOCK_ASSISTANT_DATA_ROOT;
    else process.env.STOCK_ASSISTANT_DATA_ROOT = previous;
  }
});

test('统一时点区分盘中、收盘和旧交易日', () => {
  const intraday = Date.parse('2026-09-14T02:30:00.000Z');
  assert.equal(chinaClockParts(intraday).date, '2026-09-14');
  assert.equal(resolveObservationPhase('2026-09-14', intraday).phase, 'intraday');
  assert.equal(resolveObservationPhase('2026-09-14', Date.parse('2026-09-14T07:10:00.000Z')).phase, 'unknown');
  assert.equal(resolveObservationPhase('2026-09-14', Date.parse('2026-09-14T07:10:00.000Z'), {isFinalBar:true}).phase, 'closed');
  assert.equal(resolveObservationPhase('2026-09-14', Date.parse('2026-09-14T07:10:00.000Z'), {isFinalBar:false}).phase, 'intraday');
  assert.equal(resolveObservationPhase('2026-09-14', Date.parse('2026-09-14T07:10:00.000Z'), {sourceObservedAt:Date.parse('2026-09-14T06:55:00.000Z')}).phase, 'intraday');
  assert.equal(resolveObservationPhase('2026-09-11', intraday).phase, 'closed');
  const snapshot=marketSnapshotId({tradeDate:'2026-09-14',observedAt:intraday,universe:5900,source:'test'});
  assert.match(snapshot, /^2026-09-14-/);
  assert.notEqual(snapshot, marketSnapshotId({tradeDate:'2026-09-14',observedAt:intraday+1,universe:5900,source:'test'}));
});

test('横截面百分位按平均秩处理并拒绝不足样本', () => {
  assert.equal(crossSectionPercentile([10], 10), null);
  assert.equal(crossSectionPercentile([10, 10, 10], 10), 50);
  assert.equal(crossSectionPercentile([1, 2, 2, 4], 2), 50);
  assert.equal(crossSectionPercentile([1, 2, 3, 4], 4), 100);
});

test('AI解释只能引用当前快照的证据编号', () => {
  const prompt = buildAiEvidencePrompt({code:'600001',analysisId:'a-1',evidence:[{id:'E1',text:'近20日上涨5%'},{id:'E2',text:'主力净流入'}]});
  assert.match(prompt,/a-1/);
  assert.match(prompt,/E1/);
  assert.equal(validateAiExplanation('趋势偏强 [E1]，资金确认 [E2]。',['E1','E2']).valid,true);
  assert.equal(validateAiExplanation('目标价20元 [E9]。',['E1','E2']).valid,false);
});

test('统一策略附加不依赖资讯函数的局部变量', () => {
  const result = attachStrategyPlatform({
    code:'600001', price:10, signalScore:68, reason:'趋势改善',
    analysis:{latestPrice:10, ma20:9.5, ma30:9.2, breakoutPrice:10.2, volumeRatio:1.8, return20:6, return60:12}
  }, {snapshotId:'snapshot-1'});
  assert.equal(result.analysisId, 'snapshot-1');
  assert.ok(Array.isArray(result.strategyEvaluations));
  assert.ok(result.strategyDecision);
});

test('腾讯行情原始时间参与收盘判断与快照内容身份', () => {
  assert.equal(tencentQuoteObservedAt('20260914145501'), '2026-09-14T06:55:01.000Z');
  assert.equal(tencentQuoteObservedAt('bad'), '');
  const first=marketQuoteContentSignature([{code:'600001',tradeDate:'2026-09-14',quoteObservedAt:'2026-09-14T06:55:01.000Z',price:10,changePct:1,amount:100}]);
  const second=marketQuoteContentSignature([{code:'600001',tradeDate:'2026-09-14',quoteObservedAt:'2026-09-14T06:55:02.000Z',price:10.1,changePct:2,amount:120}]);
  assert.notEqual(first,second);
});

test('放量普跌中的局部板块单独分类，不误判成普涨或全面风险', () => {
  const result = classifyMarketRegime({breadth:{up:600,down:4500,flat:30},turnover:1.97e12,
    indices:[{changePct:-1.1},{changePct:-.5}],limits:{upCount:40,downCount:8},
    sectors:[{name:'元件',changePct:3.6,upRatio:.86,mainNetInflow:3.2e9,capitalEstimated:false,capitalStale:false}]}, {turnover:1.64e12});
  assert.equal(result.key, 'localized-strength');
  assert.equal(result.label, '放量普跌中的局部强势');
  assert.equal(result.riskOff, false);
  assert.equal(result.localized, true);
});

test('盘中越过突破位只进入观察，收盘数据才允许确认', () => {
  const input={latestPrice:11,ma5:10.8,ma10:10.6,ma20:10.4,ma30:10.2,supportPrice:10,resistance:10.8,
    volumeRatio:2,rsi14:60,breakoutStatus:'接近突破'};
  const intraday=assessCurrentEntry({...input,observationPhase:{phase:'intraday',label:'盘中快照'}});
  const closed=assessCurrentEntry({...input,observationPhase:{phase:'closed',label:'当日收盘'}});
  assert.equal(intraday.allowed,false);
  assert.equal(intraday.status,'盘中突破，等待收盘确认');
  assert.equal(closed.allowed,true);
  assert.equal(closed.status,'可分批入场');
});

test('统一评分快照保留各分数含义和模型版本', () => {
  const card=buildStrategyScoreCard({technicalScore:76,signalScore:81,canslim:{score:69},factorAnalysis:{score:72},dataConfidence:{score:83}},
    {snapshotId:'snap-1',tradeDate:'2026-09-11',observedAt:'2026-09-11T07:00:00Z'});
  assert.deepEqual([card.technical,card.recommendation,card.canslim,card.factor,card.confidence],[76,81,69,72,83]);
  assert.equal(card.snapshotId,'snap-1');
  assert.equal(card.modelVersion,RECOMMENDATION_MODEL_VERSION);
});

test('消息形成可追溯事件且公司事件不向全市场外溢', () => {
  const now='2026-09-11T08:00:00+08:00';
  const company=summarizeNews([{title:'测试公司收到立案调查通知',publishedAt:'2026-09-11T07:00:00+08:00',link:'https://example.com/a'}], '', {subject:'测试公司',now,fetchedAt:now});
  assert.equal(company.items[0].eventScope,'公司');
  assert.equal(company.items[0].eventType,'公司风险');
  assert.equal(company.items[0].evidenceLevel,'可追溯');
  const market=summarizeNews([{title:'测试公司收到立案调查通知',publishedAt:'2026-09-11T07:00:00+08:00',link:'https://example.com/a'}], '', {scope:'market',now,fetchedAt:now});
  assert.equal(market.available,false);
});

test('小样本强势板块降低轮动可信度', () => {
  const phase=classifySectorRotationPhase({count:7,changePct:5.3,mainNetInflow:1e9,mainNetPct:13,
    mainNet3:2e9,mainNet5:3e9,mainNet10:4e9,capitalEstimated:false,capitalStale:false,
    participation:{breadthScore:90,topAmountShare:.2}});
  assert.equal(phase.sampleLimited,true);
  assert.equal(phase.confidence,'低');
});

test('普跌局部行情只放行已确认主线继续评估', () => {
  const base={entryAssessment:{allowed:true,status:'可分批入场',summary:'技术成立',evidence:[]},verdict:'可关注',tradePlan:{enabled:true}};
  const marketOverview={marketRegime:{localized:true,label:'普跌中的局部强势',strongSectors:['元件']},breadth:{up:600,down:4500},indices:[],sectors:[]};
  const result=applyEntryContextAssessment(base,{marketOverview,newsContext:{signal:'中性',items:[]},marketNewsContext:{signal:'中性'},riskProfile:{status:'clear'},
    subject:{industry:'电力',rotationProfiles:[{name:'电力',capitalEstimated:false,capitalStale:false,mainNetInflow:1e8,mainNetPct:1,rotationScore:60}]}});
  assert.equal(result.entryAssessment.status,'普跌环境，非局部主线');
  assert.equal(result.tradePlan.enabled,false);
});

test('公开资金分项使用超大单加大单且缺失不冒充零', () => {
  const result = normalizeEastmoneyFundFlow({f64:2488208,f65:2061930,f70:14272541,f71:15857306,f62:-1158487,f184:-1.09});
  assert.equal(result.mainInflow,16760749);
  assert.equal(result.mainOutflow,17919236);
  assert.equal(result.mainInflow-result.mainOutflow,result.mainNetInflow);
  assert.equal(normalizeEastmoneyFundFlow({f64:0,f70:0}).mainInflow,0);
  assert.equal(normalizeEastmoneyFundFlow({f64:1}).mainInflow,null);
});

test('逐日资金保留百分比单位并标记不足十日，汇总不丢弃真实明细', () => {
  const result = summarizeEastmoneyFundHistory(['2026-09-09,-100,20,80,-120,20,-0.5,1,2,3,4,10,-1'],10);
  assert.equal(result.rows[0].mainNetPct,-.5);
  assert.equal(result.days,1);
  assert.equal(result.complete,false);
  assert.equal(result.grossFlowsAvailable,false);
  const merged = mergeFundFlowSnapshot(result,{tradeDate:'2026-09-09',mainNetInflow:-100,mainNet5:200,mainNet10:400,estimated:false},'2026-09-09');
  assert.equal(merged.rows.length,1);
  assert.equal(merged.positiveDays,null);
  const full = summarizeEastmoneyFundHistory(Array.from({length:10},(_,i)=>`2026-09-${String(i+1).padStart(2,'0')},100,0,0,0,0,0.5`),10);
  const retained = mergeFundFlowSnapshot(full,{tradeDate:'2026-09-10',mainNetInflow:100,mainNet5:500,mainNet10:1000,estimated:false},'2026-09-10');
  assert.equal(retained.positiveDays,10);
  assert.equal(retained.aggregateOnly,undefined);
  assert.equal(summarizeEastmoneyFundHistory(['bad','2026-09-09,-,0'],10).available,false);
});

test('数据中心区分无记录与业务错误，查询失败不能当作无风险',()=>{
  assert.deepEqual(dataCenterRows({success:false,code:9201,message:'返回数据为空'}),[]);
  assert.deepEqual(dataCenterRows({success:true,result:{data:[]}}),[]);
  assert.throws(()=>dataCenterRows({success:false,code:9501,message:'报表配置不存在'}),/报表配置不存在/);
  assert.throws(()=>dataCenterRows({}),/数据中心响应无效/);
});

test('公司接口失联保留已保存资料并标注旧时间，不覆盖成功缓存',async()=>{
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
  const start = source.indexOf('async function fetchCompanyProfile(');
  const end = source.indexOf('\nfunction normalizeHistoryRows(',start);
  let offline = false, disk = null;
  const logs = [];
  const context = {companyProfileCache:new Map(),readTimedCache:()=>null,readDiskCache:()=>disk,
    writeDiskCache:(_key,value)=>{disk=value;},writeTimedCache:(_map,_key,value)=>value,
    cleanStockName:value=>value || '',isGenericSector:()=>true,plainText:value=>value || '',
    mapDataCenterCompanyProfile,formatBusinessProducts,settleWithConcurrency,
    fetchDataCenterCompanyRows:async report=>{
      if (offline) throw new Error('offline');
      return report === 'RPT_F10_BASIC_ORGINFO' ? [{EM2016:'中药',MAIN_BUSINESS:'生产中药',ORG_PROFILE:'公司概况'}]
        : [{REPORT_DATE:'2026-06-30',ITEM_NAME:'中药产品',MAINOP_TYPE:'2',MAIN_BUSINESS_INCOME:1e8}];
    },fetchStockBoards:async()=>[],getJsonWithRetry:async()=>{throw new Error('offline');},
    findPointText:()=>'',findTextByKeys:()=>'',appendLogLine:value=>logs.push(value)};
  const fetchProfile = vm.runInNewContext(source.slice(start,end)+';fetchCompanyProfile',context);
  const first = await fetchProfile({code:'603567',name:'珍宝岛',force:true});
  assert.equal(first.stale,false);
  assert.equal(disk,first);
  offline=true;
  const fallback = await fetchProfile({code:'603567',name:'珍宝岛',force:true});
  assert.equal(fallback.profile.business,'生产中药');
  assert.equal(fallback.stale,true);
  assert.equal(fallback.fetchedAt,first.fetchedAt);
  assert.equal(fallback.cachedFields.length,4);
  assert.equal(disk,first);
  assert.ok(fallback.errors.length > 0);
  assert.equal(logs.at(-1).type,'warn');
});

test('公司资料使用真实行业主营，主营构成不显示分类数字或旧报告', () => {
  assert.equal(emF10Code('920970'),'BJ920970');
  assert.equal(emF10Code('600519'),'SH600519');
  assert.equal(emF10Code('002708'),'SZ002708');
  const profile = mapDataCenterCompanyProfile({EM2016:'医药生物-中药生产',MAIN_BUSINESS:'中药生产',ORG_PROFILE:'公司概况',BUSINESS_SCOPE:'经营范围'});
  assert.equal(profile.industry,'医药生物-中药生产');
  assert.equal(profile.business,'中药生产');
  const products = formatBusinessProducts([
    {REPORT_DATE:'2025-12-31',MAINOP_TYPE:'2',ITEM_NAME:'过期产品',MAIN_BUSINESS_INCOME:9e8},
    {REPORT_DATE:'2026-06-30',REPORT_NAME:'2026中报',MAINOP_TYPE:'3',ITEM_NAME:'华东地区',MAIN_BUSINESS_INCOME:5e8},
    {REPORT_DATE:'2026-06-30',REPORT_NAME:'2026中报',MAINOP_TYPE:'2',ITEM_NAME:'中药制剂',MAIN_BUSINESS_INCOME:1e8,MBI_RATIO:.8}
  ]);
  assert.match(products,/2026中报.*中药制剂.*1.00亿.*80.00%/);
  assert.doesNotMatch(products,/过期产品|华东地区/);
});

test('指数微涨但多数个股下跌时大盘与个股统一判断偏弱',()=>{
  const market={indices:[{changePct:.28},{changePct:.15},{changePct:-.14}],breadth:{up:1793,down:3642}};
  assert.equal(assessMarketEnvironment(market).label,'偏弱');
  const result=applyEntryContextAssessment({entryAssessment:{allowed:true,summary:'技术确认'}},{marketOverview:market});
  assert.equal(result.entryAssessment.status,'大盘偏弱，等待确认');
  assert.equal(assessMarketEnvironment({indices:[{changePct:null}]}).label,'数据不足');
});

test('小板块百分百上涨不能获得与大范围上涨相同的广度加分',()=>{
  const quotes=Array.from({length:20},(_,i)=>({code:String(600001+i),price:10,changePct:2,amount:1e8}));
  const capital={name:'测试行业',mainNetInflow:1e8,mainNetPct:4,changePct:2};
  const build=codes=>mergeSectorCapitalRows({sectors:[]},[{...capital,memberCodes:codes}],quotes).sectors[0];
  const small=build(quotes.slice(0,2).map(row=>row.code)),wide=build(quotes.map(row=>row.code));
  assert.equal(small.upRatio,1);
  assert.ok(small.participation.breadthScore < wide.participation.breadthScore);
  assert.ok(small.rotationScore < wide.rotationScore);
  assert.match(small.participation.summary,/2.*小样本/);
  const missing=build([...quotes.map(row=>row.code),...Array.from({length:20},(_,i)=>String(601001+i))]);
  assert.equal(missing.participation.coverage,.5);
  assert.ok(missing.participation.breadthScore<wide.participation.breadthScore);
});

test('板块单股成交集中且多数下跌应标记分化并降低轮动分',()=>{
  const quotes=Array.from({length:10},(_,i)=>({code:String(600001+i),price:10,changePct:i===0?8:-1,amount:i===0?9e8:1e7}));
  const capital={name:'测试行业',mainNetInflow:1e8,mainNetPct:4,changePct:2,memberCodes:quotes.map(row=>row.code)};
  const row=mergeSectorCapitalRows({sectors:[]},[capital],quotes).sectors[0];
  assert.equal(row.participation.divergent,true);
  assert.match(row.participation.summary,/少数个股拉动/);
  const context=applyEntryContextAssessment({entryAssessment:{allowed:false,summary:'等待突破'}},{subject:{industry:'测试行业'},marketOverview:{sectors:[row]}});
  assert.match(context.entryAssessment.summary,/少数个股拉动/);
});

test('板块净流入被单股撑起时剔除龙头复核并降低轮动等级',()=>{
  const quotes=Array.from({length:10},(_,i)=>({code:String(600001+i),price:10,changePct:2,amount:1e8}));
  const base={name:'测试行业',mainNetInflow:1e8,mainNetPct:4,changePct:2,memberCodes:quotes.map(row=>row.code),
    mainNet3:3e8,mainNet5:5e8,mainNet10:9e8};
  const normal=mergeSectorCapitalRows({sectors:[]},[base],quotes).sectors[0];
  const concentrated=mergeSectorCapitalRows({sectors:[]},[{...base,memberCapital:{available:true,concentrated:true,
    coverage:1,topName:'龙头股',topPositiveShare:.8,exLeaderNetInflow:-2e7}}],quotes).sectors[0];
  assert.equal(concentrated.participation.capitalConcentrated,true);
  assert.ok(concentrated.rotationScore<normal.rotationScore);
  assert.equal(concentrated.rotationPhase.phase,'龙头集中');
  assert.match(concentrated.participation.summary,/剔除最大资金贡献股龙头股.*资金扩散不足/);
});

test('等待技术确认的股票也必须记录环境风险且关闭交易计划',()=>{
  const analysis={verdict:'可关注',tradePlan:{enabled:true},entryAssessment:{allowed:false,status:'等待确认',summary:'接近突破',evidence:[]}};
  const result=applyEntryContextAssessment(analysis,{subject:{industry:'半导体'},
    marketOverview:{breadth:{up:1000,down:4000},overseas:{available:true,severity:'high',summary:'美股科技下跌'}},
    newsContext:{signal:'偏谨慎',items:[{title:'风险消息'}]},marketNewsContext:{available:true,signal:'偏谨慎'}});
  assert.equal(result.entryAssessment.status,'消息风险待确认');
  assert.ok(result.entryAssessment.contextRisks.includes('大盘偏弱'));
  assert.ok(result.entryAssessment.contextRisks.includes('美股科技风险'));
  assert.equal(result.tradePlan.enabled,false);
  assert.equal(result.verdict,'等待确认');
  const broken=applyEntryContextAssessment({...analysis,entryAssessment:{...analysis.entryAssessment,status:'破位'}},{newsContext:{signal:'偏谨慎'}});
  assert.equal(broken.entryAssessment.status,'破位');
});

test('环境风险下的技术候选显示环境观察而非严格推荐',()=>{
  const item={code:'600001',signal:'突破确认',signalScore:80,technicalScore:85,entryAssessment:{allowed:false,status:'大盘偏弱，等待确认',contextRisks:['大盘偏弱']}};
  const result=finalizeRecommendationDisplay([item],[])[0];
  assert.equal(result.recommendationTier,'环境观察');
  assert.equal(recommendationPassesDisplayGate(result),true);
  assert.match(result.reason,/环境.*观察/);
  const blocked={...item,entryAssessment:{...item.entryAssessment,contextRisks:['大盘偏弱','板块退潮']}};
  assert.equal(recommendationPassesOutcomeGate(blocked),false);
  const b={...blocked,momentumDecision:{passed:true,profile:{name:'行业甲'},entryAssessment:{allowed:false,summary:'等待回踩'}}};
  assert.equal(finalizeMomentumRecommendations([b]).length,0);
});

test('板块内领先度使用真实成分同行，不能将自身比较当作满分',()=>{
  const quotes=[1,2,3].map((n)=>({code:`60000${n}`,industry:'行业甲',price:10,changePct:n,amount:n*1e8}));
  const capital={name:'行业甲',boardType:'industry',mainNetInflow:1e8,mainNetPct:5,memberCodes:quotes.map(row=>row.code)};
  const sector=mergeSectorCapitalRows({sectors:[]},[capital],quotes).sectors[0];
  const context=buildRecommendationFactorContext(quotes);
  const factor=stock=>evaluateRecommendationFactors({...stock,rotationProfiles:[sector]},context,{}).factors.find(row=>row.key==='leadership');
  assert.ok(factor(quotes[2]).score>factor(quotes[0]).score);
  const missing=evaluateRecommendationFactors({...quotes[0],rotationProfiles:[{...capital,rotationScore:70}]},{},{}).factors.find(row=>row.key==='leadership');
  assert.match(missing.evidence,/同行.*未取得/);
  assert.ok(missing.score<=70);
});

test('最近3日显著流出不能被当日翻红和10日净流入掩盖',()=>{
  const current={tradeDate:'2026-09-08',mainNetInflow:1e7,mainNetPct:1,mainNet3:-8e7,mainNetPct3:-4,mainNet5:2e8,mainNet10:5e8};
  const sector=mergeSectorCapitalRows({sectors:[]},[{...current,name:'行业甲',boardType:'industry'}]).sectors[0];
  assert.equal(sector.capitalTrend.weakening,true);
  assert.match(sector.capitalTrend.phase,/转出/);
  const flow={current};
  assert.equal(analyzeCapitalWindows(flow,current.tradeDate).weakening,true);
  assert.equal(recommendationPassesOutcomeGate({signal:'突破确认',signalScore:90,technicalScore:90,analysis:{tradeDate:current.tradeDate},fundFlowPeriod:flow}),false);
  const analysis=applyEntryContextAssessment({entryAssessment:{allowed:true,summary:'技术突破'}},{subject:{industry:'行业甲'},marketOverview:{sectors:[sector]}});
  assert.equal(analysis.entryAssessment.allowed,false);
  assert.equal(analysis.entryAssessment.status,'板块退潮，等待确认');
  assert.equal(momentumRecommendationDecision({price:10,high:10,changePct:5,amount:1e9,rotationProfiles:[sector]}).passed,false);
});

test('阶段回流和当日拉升不能冒充跨阶段持续流入',()=>{
  const row={name:'行业甲',mainNetInflow:1e8,mainNetPct:5,mainNet3:3e8,mainNet5:6e8,mainNet10:4e8};
  const build=extra=>mergeSectorCapitalRows({sectors:[]},[{...row,...extra}]).sectors[0].capitalTrend;
  assert.equal(build({}).confirmed,false);
  assert.match(build({}).phase,/阶段回流/);
  assert.equal(build({}).recovering,true);
  const recoveringSector=mergeSectorCapitalRows({sectors:[]},[{...row,name:'回流行业'}]).sectors[0];
  assert.equal(recoveringSector.rotationPhase.phase,'试探回流');
  assert.equal(build({mainNet10:10e8}).confirmed,true);
  assert.equal(build({mainNet10:10e8,mainNet3:.5e8}).confirmed,false);
  assert.equal(build({mainNet3:-1e8,mainNetPct3:-5,capitalStale:true}).weakening,false);
});

test('无入选信号的收藏仍计收益但不污染信号分组',()=>{
  const row={code:'600001',label:'历史批次',favoriteBasePrice:10,price:8,favoriteAddedAt:'2026-08-01',signal:''};
  const profile=summarizeRecommendationOutcomes([row],{now:Date.parse('2026-09-08')});
  assert.equal(profile.overall.averageReturn,-20);
  assert.equal(profile.unattributedCount,1);
  assert.equal(profile.attributedCount,0);
  assert.deepEqual(profile.byFamily,{});
  assert.deepEqual(profile.bySignal,{});
});

test('单一批次再多股票也不足以调整跨版本推荐评分',()=>{
  const stats={count:30,cohortCount:1,averageReturn:-8,winRate:10};
  assert.equal(outcomeStatsAdjustment(stats,8),0);
  assert.ok(outcomeStatsAdjustment({...stats,cohortCount:2},8)<0);
});

test('强势追踪最终文案保留资金消息美股风险分析',()=>{
  const item={code:'600001',signalScore:78,entryAssessment:{allowed:false,summary:'近期资金转弱；消息谨慎；美股偏弱',evidence:['美股风险']},
    momentumDecision:{passed:true,profile:{name:'行业甲'},entryAssessment:{allowed:false,status:'强势追踪，等待首次回踩',summary:'等待首次缩量回踩'}}};
  const result=finalizeMomentumRecommendations([item])[0];
  assert.equal(result.entryAssessment.allowed,false);
  assert.match(result.entryAssessment.summary,/首次缩量回踩/);
  assert.match(result.entryAssessment.summary,/资金转弱.*消息谨慎.*美股偏弱/);
  assert.ok(result.entryAssessment.evidence.includes('美股风险'));
});

test('新浪股数转换为手后与实时报价合并，量比和资金估算不差100倍', () => {
  const rows = Array.from({length:65}, (_, i) => ({day:new Date(Date.UTC(2026,5,i+1)).toISOString().slice(0,10),open:10,close:10,high:11,low:9,volume:100000}));
  const normalized = normalizeSinaHistoryRows(rows);
  assert.equal(normalized[0].volume,1000);
  const merged = mergeQuoteIntoHistory(normalized,{tradeDate:normalized.at(-1).date,price:10.5,open:10,high:11,low:9,volume:1500,amount:1575000});
  assert.equal(analyzeHistory(merged).volumeRatio,1.5);
  assert.equal(estimateFundFlowFromHistory(normalized,10).rows[0].amount,1000000);
  assert.equal(normalizeSinaHistoryRows([{...rows[0],volume:null}])[0].volume,null);
});

test('真实当日流出阻止估算资金误判入场，过期当日资金不能用于确认', () => {
  const flow={available:true,estimated:true,days:10,mainNetInflow:1e8,netRatio:10,positiveDays:8,endDate:'2026-09-07',rows:[],
    current:{tradeDate:'2026-09-07',mainNetInflow:-2e7,mainNetPct:-6,estimated:false}};
  assert.equal(analyzeCapitalWindows(flow,'2026-09-07').weakening,true);
  assert.equal(analyzeCapitalWindows(flow,'2026-09-08').weakening,false);
  assert.equal(analyzeCapitalWindows({...flow,current:{...flow.current,tradeDate:''}},'').weakening,false);
  assert.equal(recommendationPassesOutcomeGate({signal:'接近突破',signalScore:85,technicalScore:85,analysis:{tradeDate:'2026-09-07'},fundFlowPeriod:flow}),false);
  const result=applyIndividualCapitalAssessment({tradeDate:'2026-09-07',score:85,verdict:'可关注',entryAssessment:{allowed:true,summary:'技术条件成立'},consolidationBreakout:{available:false}},flow);
  assert.equal(result.entryAssessment.allowed,false);
  assert.match(result.entryAssessment.summary,/当日真实主力/);
  assert.equal(analyzeCapitalWindows({...flow,current:{...flow.current,mainNetInflow:2e7,mainNetPct:6}},'2026-09-07').confirmed,false);
});

test('同批次相对跑赢但绝对亏损或低胜率不能获得历史加分', () => {
  const stats={count:20,averageReturn:-.4,winRate:27,outperformRate:70,medianExcessReturn:1,averageExcessReturn:2};
  assert.equal(outcomeStatsAdjustment(stats,8),0);
  assert.equal(outcomeStatsAdjustment({...stats,averageReturn:2,winRate:35},8),0);
  assert.ok(outcomeStatsAdjustment({...stats,averageReturn:2,winRate:60},8)>0);
});

test('存在同期大盘基准时历史校准优先使用大盘超额而不是同批次相对值', () => {
  const stats={count:20,cohortCount:4,averageReturn:2,winRate:55,
    averageExcessReturn:2,medianExcessReturn:1,outperformRate:70,
    marketBenchmarkCount:20,averageMarketExcessReturn:-2,medianMarketExcessReturn:-1,marketOutperformRate:30};
  assert.ok(outcomeStatsAdjustment(stats,8)<0);
});

test('板块真实多日资金区分持续流入、当日转入与资金退潮', () => {
  const row = {f12:'BK0448',f14:'通信设备',f3:2,f62:1e8,f184:4,f164:6e8,f165:3,f174:9e8,f175:2,f124:Date.parse('2026-09-08T02:00:00Z')/1000};
  const normalized = normalizeSectorCapitalRows([row], 'industry', 'https://push2.eastmoney.com')[0];
  assert.equal(normalized.mainNet5,6e8);
  assert.equal(normalized.mainNet10,9e8);
  assert.equal(normalized.capitalTradeDate,'2026-09-08');
  const build = extra => mergeSectorCapitalRows({sectors:[]},[{...normalized,...extra}],[]).sectors[0];
  assert.equal(build({}).capitalTrend.phase,'持续流入');
  assert.equal(build({mainNet5:-3e8,mainNet10:-8e8}).capitalTrend.phase,'当日转入待确认');
  assert.equal(build({mainNetInflow:-1e8,mainNetPct:-4}).capitalTrend.weakening,true);
  assert.ok(build({}).rotationScore > build({mainNet5:-3e8,mainNet10:-8e8}).rotationScore);
  assert.equal(build({capitalStale:true}).capitalTrend.confirmed,false);
  assert.equal(build({mainNet5:null,mainNet10:null}).capitalTrend.available,false);
  assert.equal(mergeSectorCapitalRows({sectors:[]},[normalized],[{code:'600001',tradeDate:'2026-09-09'}]).sectors[0].capitalStale,true);
});

test('真实个股5日10日净额不能与量价代理混淆或把累计窗口相加', () => {
  const current={tradeDate:'2026-09-08',mainNetInflow:1e8,mainNetPct:5,mainNet5:4e8,mainNet10:6e8};
  const flow={available:true,estimated:true,days:10,mainNetInflow:9e9,positiveDays:10,rows:[],current};
  const windows=analyzeCapitalWindows(flow,'2026-09-08');
  assert.equal(windows.confirmed,true);
  assert.equal(windows.net5,4e8);
  assert.equal(windows.net10,6e8);
  assert.equal(windows.net3,null);
  assert.match(windows.summary,/真实.*5日.*10日/);
  assert.equal(analyzeCapitalWindows({...flow,current:{...current,mainNet5:-1e8}},'2026-09-08').confirmed,false);
  assert.equal(analyzeCapitalWindows(flow,'2026-09-09').confirmed,false);
});

test('轮动预留队列跳过无成员板块和重复股票后继续寻找有效板块', () => {
  const sectors=[
    {name:'无匹配行业',rotationScore:99,mainNetInflow:1e9,mainNetPct:5,capitalEstimated:false},
    {name:'行业甲',rotationScore:95,mainNetInflow:1e9,mainNetPct:5,capitalEstimated:false,memberCodes:['600001','600002']},
    {name:'概念甲',rotationScore:94,mainNetInflow:1e9,mainNetPct:5,capitalEstimated:false,memberCodes:['600001','600003']},
    {name:'行业乙',rotationScore:90,mainNetInflow:1e9,mainNetPct:5,capitalEstimated:false,memberCodes:['600004']}
  ];
  const scored=['600001','600002','600003','600004'].map((code,i)=>({code,price:10,high:10,changePct:1,amount:1e8,preliminaryScore:99-i}));
  const selected=selectRotationPriorityCandidates(scored,sectors,{limit:3,perSector:1,sectorLimit:3});
  assert.deepEqual(selected.map(row=>row.code),['600001','600003','600004']);
});

test('强势追踪最终排序保留历史消息和美股风险扣分', () => {
  const row=(code,signalScore,raw)=>({code,signalScore,score:signalScore,momentumDecision:{passed:true,score:raw,profile:{name:code},entryAssessment:{allowed:false,status:'等待回踩',summary:'跟踪'}}});
  const result=finalizeMomentumRecommendations([row('600001',61,95),row('600002',78,80)]);
  assert.equal(result[0].code,'600002');
  assert.equal(result[1].signalScore,61);
  assert.equal(result[1].score,61);
});

test('板块成分覆盖同时预留行业和概念，重复名称不占据名额', () => {
  const rows=Array.from({length:12},(_,i)=>({code:`BK${1000+i}`,name:`行业${i}`,boardType:'industry',mainNetInflow:1e9,mainNetPct:8,changePct:2}));
  rows.push({...rows[0],code:'BK2000'});
  rows.push({code:'BK3000',name:'概念甲',boardType:'concept',mainNetInflow:1e8,mainNetPct:2,changePct:1});
  const chosen=selectSectorMemberBoards(rows,6);
  assert.equal(chosen.length,6);
  assert.ok(chosen.some(row=>row.boardType==='concept'));
  assert.equal(new Set(chosen.map(row=>row.name)).size,6);
});

test('融资融券和财报筛选集合不冒充产业资金轮动', () => {
  const make=(code,name,net)=>({code,name,boardType:'concept',changePct:2,mainNetInflow:net,mainNetPct:5,mainNet5:net*3,mainNet10:net*5,memberCodes:['600001']});
  const rows=[make('BK0001','融资融券',9e10),make('BK0002','2026中报预增',8e10),make('BK0003','猪肉概念',2e9)];
  assert.deepEqual(selectSectorMemberBoards(rows,3).map(row=>row.name),['猪肉概念']);
  const merged=mergeSectorCapitalRows({sectors:[]},rows);
  assert.deepEqual(merged.fundSectors.map(row=>row.name),['猪肉概念']);
});

test('真实多日汇总覆盖资金代理但不编造每日流入天数和买卖分项', () => {
  const current={tradeDate:'2026-09-08',mainNetInflow:1e8,mainNetPct:4,mainNet5:5e8,mainNet10:8e8,mainNetPct10:3,source:'东方财富批量资金'};
  const proxy={available:true,estimated:true,days:10,mainNetInflow:-9e9,positiveDays:0,netRatio:-10,rows:[{date:'2026-09-08'}]};
  const flow=mergeFundFlowSnapshot(proxy,current,'2026-09-08');
  assert.equal(flow.estimated,false);
  assert.equal(flow.mainNetInflow,8e8);
  assert.equal(flow.positiveDays,null);
  assert.equal(flow.mainInflow,null);
  assert.equal(flow.mainOutflow,null);
  assert.match(fundFlowPeriodEvidence(flow),/5日.*10日/);
  const analysis={tradeDate:'2026-09-08',score:85,entryAssessment:{lowBuyCandidate:true,allowed:false,setupType:'sideways-washout',summary:'结构稳定'}};
  const assessed=applyIndividualCapitalAssessment(analysis,flow);
  assert.doesNotMatch(assessed.entryAssessment.summary,/null日/);
  assert.equal(assessRecommendationNewsConfirmation({analysis,fundFlowPeriod:flow},{signal:'偏积极'}).confirmed,true);
  assert.equal(mergeFundFlowSnapshot(proxy,current,'2026-09-09').estimated,true);
});

test('热门概念不能掩盖实际所属行业的显著资金流出', () => {
  const analysis={score:85,verdict:'可关注',entryAssessment:{allowed:true,summary:'技术条件成立'}};
  const result=applyEntryContextAssessment(analysis,{subject:{industry:'通信设备',rotationProfiles:[
    {name:'热门概念',boardType:'concept',mainNetInflow:1e9,mainNetPct:5,capitalEstimated:false},
    {name:'通信设备',boardType:'industry',mainNetInflow:-1e9,mainNetPct:-5,capitalEstimated:false}
  ]}});
  assert.equal(result.entryAssessment.allowed,false);
  assert.match(result.entryAssessment.summary,/通信设备/);
  const waiting=applyEntryContextAssessment({...analysis,entryAssessment:{...analysis.entryAssessment,allowed:false}}, {subject:{industry:'通信设备',rotationProfiles:[{name:'通信设备',boardType:'industry',mainNetInflow:-1e9,mainNetPct:-5,capitalEstimated:false}]}});
  assert.equal(waiting.entryAssessment.status,'板块退潮，等待确认');
});

test('长周期统计保留时间顺序，不将后来的低点算作先前涨幅',()=>{
  const result=analyzePathMetrics([10,20,5].map((close,i)=>({close,date:`2026-09-0${i+1}`})));
  assert.equal(result.maxRunup,100);
  assert.equal(result.maxDrawdown,-75);
  assert.equal(result.rangePct,300);
  assert.equal(result.longestUp,1);
  assert.equal(result.longestDown,1);
  assert.equal(result.returns[250],null);
  assert.equal(analyzePathMetrics([]).available,false);
});

test('缺失估值不等于负估值，弱均线缩量箱体不进入低吸候选',()=>{
  const stock={price:10,low:9.5,high:10,changePct:0,amount:1e9,totalMarketCap:1e10,analysis:{score:80,reboundScore:80}};
  for(const assess of [assessBreakoutQuality,assessReboundQuality]) {
    assert.equal(assess({...stock,peRatio:null,pbRatio:null}).score,100);
    assert.ok(assess({...stock,peRatio:-1}).score<100);
  }
  const params={latestPrice:10.15,ma5:10.1,ma10:10.3,ma20:10.1,ma30:10,supportPrice:9.8,resistance:10.8,volumeRatio:.8,rsi14:60,
    consolidationBreakout:{available:true,isConsolidating:true,boxLow:9.8,boxHigh:10.8,volumeCompressionRatio:.8,failedPressureCount:0}};
  assert.equal(assessCurrentEntry(params).lowBuyCandidate,false);
  assert.notEqual(assessCurrentEntry({...params,consolidationBreakout:{...params.consolidationBreakout,volumeCompressionRatio:null}}).setupType,'sideways-washout');
});

test('全市场历史筛选只使用完整同日同模型结果，候选队列避免类别饿死',()=>{
  const now=Date.parse('2026-09-05T08:00:00Z'),stock={code:'600001',tradeDate:'2026-09-04',amount:1e8,price:10,high:10};
  const cache={complete:true,codes:['600001','600001','600999'],tradeDate:'2026-09-04',generatedAt:'2026-09-05T07:59:00Z',modelVersion:RECOMMENDATION_MODEL_VERSION};
  assert.equal(selectFullMarketScreening([stock],cache,'2026-09-04',now).length,1);
  assert.equal(selectFullMarketScreening([{...stock,amount:0}],cache,'2026-09-04',now).length,0);
  assert.equal(selectFullMarketScreening([stock],{...cache,complete:false},'2026-09-04',now).length,0);
  assert.equal(selectFullMarketScreening([stock],cache,'2026-09-07',now).length,0);
  const rows=prefix=>Array.from({length:100},(_,i)=>({code:`${prefix}${String(i).padStart(4,'0')}`,industry:`行业${i}`}));
  const picked=selectMarketRecommendationCandidates({breakoutScreened:rows('60'),reboundScreened:rows('00'),fullMarketScreened:rows('30')},6);
  assert.equal(picked.filter(item=>item.code.startsWith('00')).length,2);
  assert.equal(picked.filter(item=>item.code.startsWith('30')).length,2);
});

test('空白与非数值类型不被转换成有效零值', () => {
  for (const value of [' ', '\t', false, true, [], {}, null, undefined, Infinity]) assert.equal(finiteNumber(value),null);
  assert.equal(finiteNumber('0'),0);
  assert.equal(finiteNumber(' 1.5 '),1.5);
});

test('行情响应中途断开能结束请求并进入失败路径', async () => {
  const http=require('node:http');
  const server=http.createServer((_req,res)=>{
    res.writeHead(200,{'Content-Length':'100'});
    res.write('x');
    setTimeout(()=>res.destroy(),25);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try { await assert.rejects(requestText(`http://127.0.0.1:${server.address().port}`,500),/断开|aborted|socket/i); }
  finally { await new Promise(resolve=>server.close(resolve)); }
});

test('成功筛空不能恢复旧推荐，接口失败回退不保留入场许可', () => {
  const cached={recommendations:[{code:'600001',industry:'半导体',signal:'突破确认',technicalScore:80,signalScore:80,entryAssessment:{allowed:true,status:'可入场'},tradePlan:{enabled:true},newsLabel:'消息确认'}]};
  const empty={recommendations:[],recommendationsComputed:true,momentumRecommendations:[{code:'600002'}]};
  assert.equal(restoreCachedMarketRecommendations(empty,cached),false);
  assert.equal(empty.recommendations.length,0);
  const failed={recommendations:[],momentumRecommendations:[{code:'600002'}]};
  assert.equal(restoreCachedMarketRecommendations(failed,cached),true);
  assert.equal(failed.recommendations[0].entryAssessment.allowed,false);
  assert.equal(failed.recommendations[0].tradePlan.enabled,false);
  assert.equal(failed.recommendations[0].newsLabel,'消息待核验');
  assert.equal(failed.momentumRecommendations[0].code,'600002');
});

test('短期流出不能被十日累计流入和利好标题覆盖', () => {
  const rows=Array.from({length:10},(_,i)=>({date:`2026-08-${String(22+i).padStart(2,'0')}`,mainNetInflow:i===9?-50:100,mainNetPct:i===9?-5:5}));
  const flow={available:true,days:10,positiveDays:9,mainNetInflow:850,netRatio:4,rows};
  const windows=analyzeCapitalWindows(flow,'2026-08-31');
  assert.equal(windows.net10,850);
  assert.equal(windows.weakening,true);
  assert.equal(windows.confirmed,false);
  assert.match(windows.summary,/1日净额-/);
  const analysis={tradeDate:'2026-08-31',score:80,verdict:'可关注',entryAssessment:{allowed:true,summary:'结构确认'},tradePlan:{enabled:true}};
  const result=applyIndividualCapitalAssessment(analysis,flow);
  assert.equal(result.entryAssessment.allowed,false);
  assert.equal(result.tradePlan.enabled,false);
  assert.ok(result.capitalAdjustedScore<80);
  const item={signal:'突破确认',signalScore:90,technicalScore:80,analysis,fundFlowPeriod:flow};
  assert.equal(recommendationGateDecision(item).passed,false);
  assert.equal(assessRecommendationNewsConfirmation(item,{signal:'偏积极',factorScore:80}).confirmed,false);
});

test('资金日期对齐、三日反转与估算数据不能误作实时确认', () => {
  const rows=[{date:'2026-09-02',mainNetInflow:100,mainNetPct:5},{date:'2026-09-03',mainNetInflow:100,mainNetPct:5},{date:'2026-09-04',mainNetInflow:100,mainNetPct:5}];
  const flow={available:true,days:3,rows};
  assert.equal(analyzeCapitalWindows(flow,'2026-09-04').confirmed,true);
  assert.equal(analyzeCapitalWindows(flow,'2026-09-05').stale,true);
  const stale=applyIndividualCapitalAssessment({tradeDate:'2026-09-05',score:70,verdict:'可关注',entryAssessment:{allowed:false,summary:'观察'},tradePlan:{enabled:true}},flow);
  assert.equal(stale.tradePlan.enabled,false);
  assert.equal(stale.verdict,'等待确认');
  assert.equal(analyzeCapitalWindows({...flow,estimated:true},'2026-09-04').confirmed,false);
  const reversed={...flow,rows:rows.map((r,i)=>({...r,mainNetInflow:i? -100:10,mainNetPct:null}))};
  assert.equal(analyzeCapitalWindows(reversed,'2026-09-04').weakening,true);
  assert.equal(analyzeCapitalWindows(flow,'2026-09-03').endDate,'2026-09-03');
});

test('过期板块资金不进入强势追踪和轮动优先队列', () => {
  const sector={name:'软件',mainNetInflow:1e9,mainNetPct:10,rotationScore:90,capitalEstimated:false,capitalStale:true};
  const stock={code:'600001',industry:'软件',price:10,high:10,changePct:6,amount:1e9,rotationProfiles:[sector]};
  assert.equal(momentumRecommendationDecision(stock).passed,false);
  assert.deepEqual(selectRotationPriorityCandidates([stock],[sector]),[]);
  const merged=mergeSectorCapitalRows({sectors:[{name:'软件',rotationScore:45}]},[sector]);
  assert.equal(merged.sectors[0].rotationScore,45);
  assert.equal(merged.sectors[0].capitalStale,true);
});

test('轮动对照使用跨交易日同口径基线而非重复刷新', () => {
  const old={tradeDate:'2026-09-03',sectors:[{name:'软件',rotationScore:60,capitalEstimated:true}]};
  const current=[{name:'软件',rotationScore:75,capitalEstimated:true}];
  const first=annotateSectorRotation(current,old,'2026-09-04');
  assert.equal(first[0].rotationTransition.delta,15);
  const again=annotateSectorRotation([{...current[0],rotationScore:80}],{tradeDate:'2026-09-04',sectors:first},'2026-09-04');
  assert.equal(again[0].rotationTransition.delta,20);
  assert.equal(annotateSectorRotation(current,null,'2026-09-04')[0].rotationTransition.available,false);
  assert.equal(annotateSectorRotation([{...current[0],capitalEstimated:false}],old,'2026-09-04')[0].rotationTransition.available,false);
});

test('同交易日资金从峰值明显回撤时不再作为轮动主线确认',()=>{
  const previous={tradeDate:'2026-09-14',sectors:[{name:'元件',rotationScore:82,changePct:3,
    mainNetInflow:10e8,mainNetPct:4,capitalEstimated:false,capitalStale:false}]};
  const sector=annotateSectorRotation([{name:'元件',rotationScore:68,changePct:2,upRatio:.7,
    mainNetInflow:2e8,mainNetPct:1,capitalEstimated:false,capitalStale:false}],previous,'2026-09-14')[0];
  assert.equal(sector.rotationIntraday.retreating,true);
  assert.equal(sector.rotationIntraday.retreatRatio,.8);
  assert.equal(sector.rotationState,'盘中资金回撤');
  assert.deepEqual(selectRotationPriorityCandidates([{code:'600001',industry:'元件',price:10,high:10,changePct:2,amount:1e8}],[sector]),[]);
  const analysis=applyEntryContextAssessment({verdict:'可关注',tradePlan:{enabled:true},entryAssessment:{allowed:true,status:'可关注',summary:'技术确认'}},
    {subject:{industry:'元件',rotationProfiles:[sector]},marketOverview:{sectors:[sector]}});
  assert.equal(analysis.entryAssessment.allowed,false);
  assert.ok(analysis.entryAssessment.contextRisks.includes('板块盘中资金回撤'));
});

test('趋势延续区分多日站稳、单日拉升和持续下跌', () => {
  const make = close => ({date:'2026-09-01',open:close,close,high:close*1.01,low:close*.99,volume:100});
  const steady = Array.from({length:60},(_,i)=>make(10+i*.025));
  const persistent = analyzeTrendContinuation(steady);
  assert.equal(persistent.passed,true);
  assert.equal(persistent.aboveDays,10);
  const falling = Array.from({length:60},(_,i)=>make(15-i*.05));
  assert.equal(analyzeTrendContinuation(falling).passed,false);
  falling[59]=make(15);
  assert.equal(analyzeTrendContinuation(falling).passed,false);
  const candidate={code:'600001',signal:'已反弹',technicalScore:75,signalScore:70,qualityScore:75,analysis:{trendContinuation:persistent,distanceToBreakout:2,volumeRatio:1}};
  assert.equal(recommendationGateDecision(candidate).passed,false);
  assert.equal(recommendationPassesWatchGate(candidate),true);
  const watches=finalizeRecommendationDisplay([],[candidate]);
  assert.equal(watches[0].signal,'已反弹');
  assert.equal(watches[0].entryAssessment.allowed,false);
  assert.equal(recommendationGateDecision({signal:'已反弹',technicalScore:75,signalScore:70}).passed,false);
});

test('零涨跌RSI为中性且无效行情不能生成分析', () => {
  const rows=Array.from({length:60},()=>({open:10,close:10,high:10,low:10,volume:100}));
  assert.equal(analyzeHistory(rows).rsi14,50);
  assert.throws(()=>analyzeHistory([]),/历史样本不足/);
  assert.throws(()=>analyzeHistory([...rows,{open:10,close:NaN,high:10,low:10,volume:100}]),/无效/);
});

test('同一收藏跨标签去重，缺失分数不归入低分组', () => {
  const row={code:'002631',label:'一',favoriteBasePrice:10,price:12,favoriteAddedAt:'2026-08-13',signal:'已反弹',technicalScore:null,signalScore:null};
  const profile=summarizeRecommendationOutcomes([row,{...row,label:'二'}],{now:Date.parse('2026-09-05')});
  assert.equal(profile.sampleSize,1);
  assert.equal(profile.duplicateCount,1);
  assert.deepEqual(profile.byTechnicalScoreBand,{});
  assert.deepEqual(profile.byScoreBand,{});
});

test('收藏时评分独立于后续刷新，旧收藏不伪造原始评分', () => {
  const vm=require('node:vm');
  const source=fs.readFileSync(path.join(__dirname,'../renderer.js'),'utf8');
  const start=source.indexOf('function labelStockSnapshot(');
  const end=source.indexOf('function loadState(',start);
  const snapshot=vm.runInNewContext(source.slice(start,end)+';labelStockSnapshot');
  const original=snapshot({code:'002631',price:10,technicalScore:60,signalScore:65,signal:'已反弹'});
  const updated=snapshot({code:'002631',price:12,technicalScore:90,signalScore:95},original);
  assert.equal(updated.favoriteBasePrice,10);
  assert.equal(updated.favoriteEntrySnapshot.technicalScore,60);
  assert.equal(updated.favoriteEntrySnapshot.signalScore,65);
  assert.equal(snapshot({code:'002631',technicalScore:90},{code:'002631',favoriteBasePrice:10}).favoriteEntrySnapshot,null);
});

test('资讯时间数值、未来日期、转载去重和否定利好处理一致', () => {
  const now=Date.parse('2026-09-05T12:00:00+08:00');
  const row={title:'测试公司回购股份',publishedAt:'2026-09-05 11:00:00',link:'https://example.com/1'};
  const one=summarizeNews([row],'',{now});
  const duplicate=summarizeNews([row,{...row,link:'https://example.com/2'}],'',{now});
  assert.equal(duplicate.rawScore,one.rawScore);
  assert.equal(summarizeNews([{...row,publishedAt:now+3600000},row],'',{now}).rawScore,one.rawScore);
  assert.equal(one.latestAgeHours,1);
  assert.equal(summarizeNews([{...row,publishedAt:'2027-01-01'}],'',{now}).signal,'中性');
  assert.equal(summarizeNews([{...row,publishedAt:''}],'',{now}).signal,'中性');
  assert.equal(summarizeNews([{...row,title:'测试公司否认回购计划'}],'',{now}).signal,'中性');
  assert.equal(summarizeNews([{...row,title:'测试公司澄清传闻；收到立案调查及处罚'}],'',{now}).signal,'偏谨慎');
});

test('板块主力资金缓存可覆盖周末和盘中接口临时断线', () => {
  assert.equal(SECTOR_CAPITAL_FALLBACK_MAX_AGE_MS, 72 * 60 * 60 * 1000);
});

test('实时消息按发布时间、相关性和风险强度加权', () => {
  const now = '2026-08-16T12:00:00Z';
  const positive = summarizeNews([
    { title:'贵州茅台业绩预增并发布回购计划', summary:'盈利增长', publishedAt:'2026-08-16T08:00:00Z', source:'测试源' }
  ], '', { subject:'贵州茅台', code:'600519', now, fetchedAt:now });
  assert.equal(positive.signal, '偏积极');
  assert.equal(positive.freshness, '实时资讯');
  assert.ok(positive.factorScore > 50);
  assert.match(positive.summary, /消息获取截至.*最新相关资讯.*时效加权判断偏积极/);

  const negative = summarizeNews([
    { title:'贵州茅台收到立案调查并被处罚', summary:'公司提示风险', publishedAt:'2026-08-16T10:00:00Z', source:'测试源' },
    { title:'贵州茅台上月订单增长', summary:'', publishedAt:'2026-07-20T10:00:00Z', source:'测试源' }
  ], '', { subject:'贵州茅台', code:'600519', now, fetchedAt:now });
  assert.equal(negative.signal, '偏谨慎');
  assert.ok(negative.factorScore < 50);
});

test('无关消息不参与个股判断，过期或缓存利好不充当实时确认', () => {
  const now = '2026-08-16T12:00:00Z';
  const irrelevant = summarizeNews([
    { title:'宁德时代重大合同落地', summary:'订单增长', publishedAt:'2026-08-16T10:00:00Z' }
  ], '', { subject:'贵州茅台', code:'600519', now, fetchedAt:now });
  assert.equal(irrelevant.signal, '中性');
  assert.equal(irrelevant.available, false);

  const old = summarizeNews([
    { title:'贵州茅台重大合同落地并回购', summary:'', publishedAt:'2026-07-27T10:00:00Z' }
  ], '', { subject:'贵州茅台', code:'600519', now, fetchedAt:now });
  assert.equal(old.signal, '中性');
  assert.equal(old.freshness, '较早资讯');

  const stale = summarizeNews([
    { title:'贵州茅台业绩预增并回购', summary:'盈利增长', publishedAt:'2026-08-16T10:00:00Z' }
  ], '', { subject:'贵州茅台', code:'600519', now, fetchedAt:now, stale:true });
  assert.equal(stale.signal, '中性');
  assert.equal(stale.factorScore, 50);
  assert.match(stale.summary, /沿用缓存.*不作为买入确认/);
});

test('正向消息必须由技术和阶段资金共同确认才计入推荐加分', () => {
  const newsContext = { signal:'偏积极', factorScore:86, summary:'近期存在正向消息。', items:[{title:'业绩预增'}] };
  const unconfirmed = assessRecommendationNewsConfirmation({
    analysis:{score:78}, fundFlowPeriod:{available:false}
  }, newsContext);
  assert.equal(unconfirmed.label, '消息中性');
  assert.equal(unconfirmed.confirmed, false);
  assert.ok(unconfirmed.factorScore <= 50);
  assert.match(unconfirmed.evidence, /阶段资金未确认/);

  const confirmed = assessRecommendationNewsConfirmation({
    analysis:{score:78},
    fundFlowPeriod:{available:true, days:10, mainNetInflow:8e7, netRatio:4.2, positiveDays:7}
  }, newsContext);
  assert.equal(confirmed.label, '消息确认');
  assert.equal(confirmed.confirmed, true);
  assert.ok(confirmed.factorScore > 55);

  const cautious = assessRecommendationNewsConfirmation({ analysis:{score:90} }, {
    signal:'偏谨慎', factorScore:22, summary:'近期存在风险消息。', items:[{title:'减持'}]
  });
  assert.equal(cautious.label, '消息谨慎');
  assert.equal(cautious.confirmed, false);
});

test('美股三大指数可解析并形成不以上涨单独促成买入的风险上下文', () => {
  const parsed = parseTencentGlobalIndices([
    'v_usDJI="200~道琼斯~.DJI~53559.99~53569.44~~~~~~~~~~~~~~~~~~~~~~~~~~2026-08-28 16:37:09~-9.45~-0.02~53819.65~53489.41";',
    'v_usIXIC="200~纳斯达克~.IXIC~26402.42~26541.35~~~~~~~~~~~~~~~~~~~~~~~~~~2026-08-28 17:15:59~-138.93~-0.52~26700.68~26359.27";',
    'v_usINX="200~标普500~.INX~7711.76~7730.99~~~~~~~~~~~~~~~~~~~~~~~~~~2026-08-28 16:37:00~-19.23~-0.25~7771.48~7700.91";'
  ].join('\n'));
  assert.equal(parsed.length, 3);
  assert.equal(parsed[1].code, 'IXIC');
  assert.equal(parsed[1].changePct, -0.52);

  const weak = assessGlobalMarketContext([
    {code:'DJI',name:'道琼斯',changePct:-1.2},
    {code:'IXIC',name:'纳斯达克',changePct:-2.1},
    {code:'INX',name:'标普500',changePct:-1.6}
  ]);
  assert.equal(weak.signal, '偏弱');
  assert.equal(weak.severity, 'high');
  const strong = assessGlobalMarketContext([
    {code:'DJI',name:'道琼斯',changePct:1.2},
    {code:'IXIC',name:'纳斯达克',changePct:1.8},
    {code:'INX',name:'标普500',changePct:1.4}
  ]);
  assert.equal(strong.signal, '偏强');
  assert.equal(strong.riskAdjustment, 0);
});

test('细分行业轮动按涨幅、上涨广度和成交活跃度排序', () => {
  const rows = [];
  for (let index = 0; index < 6; index++) {
    rows.push({ code:`60000${index}`, name:`强股${index}`, industry:'强势行业', price:10, changePct:2 + index * .1, amount:5e8 + index * 1e7 });
    rows.push({ code:`60100${index}`, name:`弱股${index}`, industry:'弱势行业', price:10, changePct:-2 - index * .1, amount:1e8 });
  }
  const rotation = buildIndustryRotationFromQuotes(rows);
  assert.equal(rotation.sectors[0].name, '强势行业');
  assert.equal(rotation.sectors.at(-1).name, '弱势行业');
  assert.equal(rotation.sectors[0].rotationState, '资金升温');
  assert.equal(rotation.sectors.at(-1).rotationState, '资金退潮');
  assert.ok(rotation.sectors[0].upRatio > rotation.sectors.at(-1).upRatio);
  assert.ok(rotation.fundSectors[0].amount > 0);
});

test('板块真实资金优先于成交额估算并保留资金口径', () => {
  const quotes = Array.from({length:6}, (_, index) => ({
    code:`60010${index}`, name:`农业股${index}`, industry:'生猪养殖', price:10,
    changePct:2 + index * .1, amount:2e8 + index * 1e7
  }));
  const rotation = buildIndustryRotationFromQuotes(quotes);
  const merged = mergeSectorCapitalRows(rotation, [{
    code:'BK1512', name:'生猪养殖', changePct:6.38,
    mainNetInflow:773908784, mainNetPct:8.82, capitalRank:4,
    source:'东方财富行业板块资金', fetchedAt:'2026-09-04T06:20:00.000Z'
  }], quotes);
  const sector = merged.sectors.find(item => item.name === '生猪养殖');
  assert.equal(sector.capitalEstimated, false);
  assert.equal(sector.mainNetInflow, 773908784);
  assert.equal(sector.mainNetPct, 8.82);
  assert.equal(sector.capitalRank, 4);
  assert.match(sector.capitalSource, /东方财富行业板块资金/);
  assert.equal(merged.fundSectors[0].name, '生猪养殖');
});

test('短历史明确标注样本不足，不冒充接口故障或生成信号', () => {
  assert.throws(() => analyzeHistory([{close:10}]), error => error.code === 'INSUFFICIENT_HISTORY' && /当前1根日线/.test(error.message));
  assert.throws(() => analyzeHistory([]), /当前0根日线/);
});

test('板块列表兼容对象响应并完整分页，拒绝重复页和失败页', async () => {
  assert.deepEqual(eastmoneyListRows({diff:{0:{f12:'BK0001'},1:null}}), [{f12:'BK0001'}]);
  assert.deepEqual(eastmoneyListRows({diff:null}), []);
  const calls = [];
  const fetchPage = async pathname => {
    const page = Number(new URL(pathname, 'https://example.test').searchParams.get('pn'));
    calls.push(page);
    const rows = Array.from({length:page === 3 ? 5 : 100}, (_, i) => ({f12:String((page - 1) * 100 + i + 1)}));
    return {json:{data:{total:205,diff:Object.fromEntries(rows.map((row,i)=>[i,row]))}},errors:[],host:'https://push2.eastmoney.com'};
  };
  const result = await fetchEastmoneyListPages(new URLSearchParams(), 100, fetchPage);
  assert.equal(result.rows.length, 205);
  assert.deepEqual(calls.sort(), [1,2,3]);
  await assert.rejects(fetchEastmoneyListPages(new URLSearchParams(), 100, () => fetchPage('/?pn=1')), /不完整/);
  await assert.rejects(fetchEastmoneyListPages(new URLSearchParams(), 100, pathname => {
    if (pathname.includes('pn=2')) throw new Error('page failed');
    return fetchPage(pathname);
  }), /page failed/);
});

test('东方财富板块资金字段按真实净流入和占比解析', () => {
  const rows = normalizeSectorCapitalRows([
    {f12:'BK0433',f14:'农林牧渔',f3:4.16,f20:1324151920000,f62:3118193584,f184:7.93},
    {f12:'BK1512',f14:'生猪养殖',f3:6.35,f20:460239664000,f62:773903632,f184:8.82}
  ], 'industry', 'https://82.push2.eastmoney.com', '2026-09-04T06:20:00.000Z');
  assert.equal(rows[0].mainNetInflow, 3118193584);
  assert.equal(rows[0].mainNetPct, 7.93);
  assert.equal(rows[0].boardType, 'industry');
  assert.equal(rows[0].capitalRank, 1);
  assert.equal(rows[1].capitalRank, 2);
  assert.match(rows[0].source, /东方财富行业板块主力资金/);
});

test('概念板块成员映射到个股并参与轮动判断', () => {
  const sectors = mergeSectorCapitalRows({sectors:[], weakSectors:[], fundSectors:[]}, [{
    code:'BK0882', name:'猪肉概念', changePct:5.92,
    mainNetInflow:1555330704, mainNetPct:9.65, capitalRank:2,
    memberCodes:['000876', '002714'], source:'东方财富概念板块资金'
  }], [
    {code:'000876',name:'新希望',industry:'饲料',price:7.7,changePct:10,amount:1.1e9},
    {code:'002714',name:'牧原股份',industry:'养殖业',price:40,changePct:5,amount:2e9}
  ]);
  const profiles = resolveStockRotationProfiles({code:'000876',industry:'饲料'}, sectors.sectors);
  assert.equal(profiles[0].name, '猪肉概念');
  assert.equal(profiles[0].mainNetInflow, 1555330704);
  assert.equal(profiles[0].capitalEstimated, false);
});

test('轮动主线候选获得预留名额且负资金板块不被提升', () => {
  const sectors = [
    {name:'生猪养殖',rotationScore:92,mainNetInflow:8e8,mainNetPct:8,capitalEstimated:false,memberCodes:['000876','002714']},
    {name:'弱势行业',rotationScore:80,mainNetInflow:-5e8,mainNetPct:-6,capitalEstimated:false,memberCodes:['600001']}
  ];
  const scored = [
    {code:'000876',industry:'饲料',price:7.7,high:7.8,changePct:5.2,amount:1e9,preliminaryScore:20},
    {code:'002714',industry:'养殖业',price:40,high:41,changePct:2.2,amount:2e9,preliminaryScore:18},
    {code:'600001',industry:'弱势行业',price:10,high:10.1,changePct:4,amount:8e8,preliminaryScore:90}
  ];
  const selected = selectRotationPriorityCandidates(scored, sectors, {limit:8, perSector:2});
  assert.deepEqual(selected.map(item => item.code).sort(), ['000876','002714']);
  assert.ok(selected.every(item => item.rotationProfiles[0].mainNetInflow > 0));
});

test('强势追踪要求板块资金确认且涨停爆量不允许追高', () => {
  const base = {
    code:'000876', name:'新希望', price:7.7, high:7.7, changePct:10,
    amount:1.1e9, snapshotVolumeRatio:5.01,
    rotationProfiles:[{name:'猪肉概念',rotationScore:96,mainNetInflow:15e8,mainNetPct:9.65,capitalEstimated:false,capitalRank:2}]
  };
  const hot = momentumRecommendationDecision(base);
  assert.equal(hot.passed, true);
  assert.equal(hot.entryAssessment.allowed, false);
  assert.equal(hot.entryAssessment.status, '强势追踪，不追高');
  assert.match(hot.entryAssessment.summary, /涨停|爆量/);
  const outflow = momentumRecommendationDecision({
    ...base, changePct:6, snapshotVolumeRatio:2,
    rotationProfiles:[{name:'弱势行业',rotationScore:80,mainNetInflow:-2e8,mainNetPct:-3,capitalEstimated:false}]
  });
  assert.equal(outflow.passed, false);
});

test('阶段资金接口不可用时使用明确标注的日线量价资金代理', () => {
  const history = Array.from({length:12}, (_, index) => ({
    date:`2026-08-${String(index + 1).padStart(2, '0')}`,
    open:10 + index * .1,
    high:10.5 + index * .1,
    low:9.8 + index * .1,
    close:10.4 + index * .1,
    volume:1000000 + index * 50000,
    amount:120000000 + index * 5000000
  }));
  const flow = estimateFundFlowFromHistory(history, 10);
  assert.equal(flow.available, true);
  assert.equal(flow.estimated, true);
  assert.equal(flow.days, 10);
  assert.ok(flow.mainNetInflow > 0);
  assert.ok(flow.positiveDays >= 8);
  assert.match(flow.source, /非Level-2/);
  assert.match(fundFlowPeriodEvidence(flow), /量价资金/);
  assert.doesNotMatch(fundFlowPeriodEvidence(flow), /主力买入/);
});

test('金十快讯脚本可解析为大盘实时消息', () => {
  const script = 'var newest = [{"id":"1","time":"2026-08-20 10:01:00","data":{"title":"","content":"【A股午评：沪指上涨，算力板块走强】金十数据8月20日讯，两市成交放量。","source_link":""},"remark":[{"type":"link","link":"https://xnews.jin10.com/details/1","title":"相关链接"}]},{"id":"2","time":"2026-08-20 09:58:00","data":{"content":"国际原油短线波动。"},"remark":[]}]';
  const news = parseJin10FlashItems(script);
  assert.equal(news.length, 1);
  assert.equal(news[0].source, '金十数据快讯');
  assert.equal(news[0].publishedAt, '2026-08-20 10:01:00');
  assert.match(news[0].title, /A股午评/);
});

test('大盘消息已有可用来源时单源失败只作为提示', () => {
  const partial = classifyMarketNewsIssues({
    news: [{ title: 'A股收盘数据' }],
    errors: ['金十数据快讯失败：read ECONNRESET']
  });
  assert.deepEqual(partial.errors, []);
  assert.deepEqual(partial.warnings, ['市场消息来源切换：金十数据快讯失败：read ECONNRESET']);

  const failed = classifyMarketNewsIssues({
    news: [],
    errors: ['全部消息接口不可用']
  });
  assert.deepEqual(failed.warnings, []);
  assert.deepEqual(failed.errors, ['全部消息接口不可用']);
});

test('大盘消息备用搜索使用已定义关键词', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const body = source.slice(source.indexOf('async function fetchMarketNews'), source.indexOf('async function fetchLiveNews'));
  assert.match(body, /const keyword = 'A股 大盘 板块 资金 今日 最新消息';/);
});

test('单股行情解析保留估值、换手和盘口指标', () => {
  const columns = Array(88).fill('');
  Object.assign(columns, {
    1:'贵州茅台', 2:'600519', 3:'1348.11', 4:'1355.29', 5:'1355.00',
    30:'20260814110022', 31:'-7.18', 32:'-0.53', 33:'1359.00', 34:'1348.00',
    36:'14401', 37:'194909', 38:'0.12', 39:'20.37', 43:'0.81', 44:'16852.48',
    45:'16852.48', 46:'7.24', 47:'1490.82', 48:'1219.76', 49:'1.04'
  });
  const tencent = normalizeTencentQuote(columns.join('~'));
  assert.equal(tencent.turnoverRate, 0.12);
  assert.equal(tencent.peRatio, 20.37);
  assert.equal(tencent.pbRatio, 7.24);
  assert.equal(tencent.amplitude, 0.81);
  assert.equal(tencent.snapshotVolumeRatio, 1.04);
  assert.equal(tencent.upperLimit, 1490.82);
  assert.equal(tencent.lowerLimit, 1219.76);

  const eastmoney = normalizeQuoteRow({
    f12:'600519', f14:'贵州茅台', f2:1348.11, f7:0.81, f8:0.12,
    f9:20.37, f10:1.04, f23:7.24, f51:1490.82, f52:1219.76
  });
  assert.equal(eastmoney.turnoverRate, 0.12);
  assert.equal(eastmoney.peRatio, 20.37);
  assert.equal(eastmoney.pbRatio, 7.24);
  assert.equal(eastmoney.amplitude, 0.81);
  assert.equal(eastmoney.snapshotVolumeRatio, 1.04);
  assert.equal(eastmoney.upperLimit, 1490.82);
  assert.equal(eastmoney.lowerLimit, 1219.76);
});

test('新浪财务数据可映射为统一季度和年度指标', () => {
  const item = (field, value, yoy = '') => ({ item_field:field, item_value:String(value), item_tongbi:yoy });
  const data = {
    report_date: [
      { date_value:'20260331', date_description:'2026一季报', date_type:1 },
      { date_value:'20251231', date_description:'2025年报', date_type:4 }
    ],
    report_list: {
      20260331: { data:[item('EPSBASIC', .62, .32), item('PARENETP', 30, .3), item('BIZTOTINCO', 50, .18), item('ROEWEIGHTED', 18), item('OPNCFPS', 1.2), item('CURRENTRT', 2), item('ASSLIABRT', 35), item('SGPMARGIN', 45), item('SNPMARGINCONMS', 20)] },
      20251231: { data:[item('EPSBASIC', 2.1, .2), item('ROEWEIGHTED', 17), item('OPNCFPS', 2.5)] }
    }
  };
  const result = mapSinaFinancialData(data);
  assert.equal(result.quarters.length, 2);
  assert.equal(result.annuals.length, 1);
  assert.deepEqual(result.quarters[0], {
    REPORT_DATE_NAME:'2026一季报', REPORT_TYPE:'2026一季报', REPORT_YEAR:'2026',
    EPSJB:.62, EPSJBTZ:32, PARENTNETPROFITTZ:30, TOTALOPERATEREVETZ:18,
    ROEKCJQ:18, MGJYXJJE:1.2, LD:2, ZCFZL:35, XSMLL:45, XSJLL:20
  });
});

test('数据中心财务序列可拆分为季度与年度数据', () => {
  const rows = [
    { REPORT_DATE_NAME:'2026一季报', REPORT_TYPE:'一季报' },
    { REPORT_DATE_NAME:'2025年报', REPORT_TYPE:'年报' },
    { REPORT_DATE_NAME:'2025三季报', REPORT_TYPE:'三季报' },
    { REPORT_DATE_NAME:'2024年报', REPORT_TYPE:'年报' }
  ];
  const result = splitDataCenterFinancialRows(rows);
  assert.equal(result.quarters.length, 4);
  assert.deepEqual(result.annuals.map(item => item.REPORT_DATE_NAME), ['2025年报', '2024年报']);
});

test('财务源暂时失败时明确标记未评分而不是质量数据不可用', () => {
  const result = buildIndividualInvestmentAnalysis({
    technical: { score:70, return60:5, volumeRatio:1.2 },
    financial: null,
    newsContext: { items:[], signal:'中性' },
    quote: { turnoverRate:2 },
    marketOverview: null
  });
  assert.equal(result.value.quality.score, null);
  assert.equal(result.value.quality.evidence, '财务接口暂时不可用，本次不生成财务质量评分');
});

test('财务序列生成可追溯的CANSLIM成长与价值质量评分', () => {
  const quarterRows = [{
    REPORT_DATE_NAME:'2026一季报', EPSJBTZ:32, PARENTNETPROFITTZ:30, TOTALOPERATEREVETZ:18,
    ROEJQ:18, MGJYXJJE:1.2, LD:2, ZCFZL:35, XSMLL:45, XSJLL:16
  }];
  const annualRows = [
    { REPORT_YEAR:2025, EPSJB:2.4, ROEKCJQ:18, MGJYXJJE:2.1 },
    { REPORT_YEAR:2024, EPSJB:2.0, ROEKCJQ:17, MGJYXJJE:1.8 },
    { REPORT_YEAR:2023, EPSJB:1.6, ROEKCJQ:16, MGJYXJJE:1.5 }
  ];
  const financial = buildFinancialAnalysis(quarterRows, annualRows);
  assert.ok(financial.current.score >= 85);
  assert.ok(financial.annual.score >= 80);
  assert.equal(financial.quality.available, true);
  assert.equal(financial.hardRisks.length, 0);
  const canslim = buildCanslimFromFactors({ factors:[
    { key:'currentEarnings', available:true, score:financial.current.score, evidence:financial.current.evidence },
    { key:'annualEarnings', available:true, score:financial.annual.score, evidence:financial.annual.evidence },
    { key:'catalyst', available:false, score:null, evidence:'消息不足' },
    { key:'supplyDemand', available:true, score:80, evidence:'温和放量' },
    { key:'leadership', available:true, score:75, evidence:'相对强度靠前' },
    { key:'institution', available:false, score:null, evidence:'机构数据不足' },
    { key:'market', available:true, score:70, evidence:'大盘企稳' }
  ]});
  assert.equal(canslim.available, 5);
  assert.equal(canslim.total, 7);
  assert.ok(canslim.score >= 75);
});

test('财务恶化形成硬风险且不会被缺失值伪装为低估', () => {
  const financial = buildFinancialAnalysis([{
    REPORT_DATE_NAME:'2026一季报', EPSJBTZ:-55, PARENTNETPROFITTZ:-60, TOTALOPERATEREVETZ:-25,
    ROEJQ:-4, MGJYXJJE:-.5, LD:null, ZCFZL:72, XSMLL:10, XSJLL:-8
  }], [{ REPORT_YEAR:2025, EPSJB:-.4, ROEKCJQ:-5, MGJYXJJE:-.2 }, { REPORT_YEAR:2024, EPSJB:.2, ROEKCJQ:3, MGJYXJJE:.1 }]);
  assert.ok(financial.hardRisks.length >= 3);
  assert.ok(financial.score < 45);
  assert.ok(financial.quality.checks.find(item => item.label === '流动比率' && !item.available));
});

test('大盘推荐多因子只使用可验证数据并按板块聚合', () => {
  const rows = [
    { code:'600001', industry:'半导体', price:10, changePct:3, amount:1.2e9, turnoverRate:4, peRatio:30, pbRatio:4, analysis:{ volumeRatio:1.8 } },
    { code:'600002', industry:'半导体', price:12, changePct:1, amount:5e8, turnoverRate:3, peRatio:45, pbRatio:5, analysis:{ volumeRatio:1.2 } },
    { code:'600003', industry:'医药', price:8, changePct:-2, amount:1e8, turnoverRate:2, peRatio:null, pbRatio:null, analysis:{ volumeRatio:.7 } }
  ];
  const context = buildRecommendationFactorContext(rows);
  const factors = evaluateRecommendationFactors(rows[0], context, {
    signal:'偏积极', summary:'近期有可核验创新订单消息。', items:[{ title:'创新订单' }]
  });
  assert.equal(factors.available, 5);
  assert.equal(factors.total, 10);
  assert.ok(Number.isFinite(factors.score));
  assert.equal(factors.sectorProfile.name, '半导体');
  assert.ok(factors.factors.find(item => item.key === 'currentEarnings' && !item.available));
  assert.ok(factors.factors.find(item => item.key === 'annualEarnings' && !item.available));
  assert.ok(factors.factors.find(item => item.key === 'institution' && !item.available));
  assert.ok(factors.factors.find(item => item.key === 'capitalAccumulation' && !item.available));

  const missingValuation = evaluateRecommendationFactors(rows[2], context, { signal:'中性', summary:'', items:[] });
  assert.ok(missingValuation.factors.find(item => item.key === 'valuation' && !item.available));
  assert.ok(missingValuation.factors.find(item => item.key === 'catalyst' && !item.available));
  assert.equal(missingValuation.available, 3);

  const grouped = groupRecommendationsByIndustry([
    { code:'1', industry:'医药', signalScore:80, factorAnalysis:{ sectorProfile:{ score:50 } } },
    { code:'2', industry:'半导体', signalScore:78, factorAnalysis:{ sectorProfile:{ score:80 } } },
    { code:'3', signalScore:82, factorAnalysis:{ sectorProfile:{ name:'半导体', score:80 } } }
  ]);
  assert.deepEqual(grouped.map(item => item.code), ['3','2','1']);
  assert.deepEqual(grouped.map(item => item.industry), ['半导体','半导体','医药']);
  assert.equal(resolveRecommendationIndustry({ code:'4', factorAnalysis:{ sectorProfile:{ name:'电力设备' } } }), '电力设备');
  assert.equal(resolveRecommendationIndustry({ code:'5', sector:'中药' }), '中药');
  assert.equal(resolveRecommendationIndustry({ code:'6', industry:'行业待确认' }, new Map([['6',{industry:'白酒'}]])), '白酒');
  assert.equal(recommendationIndustryGroupKey({ code:'600001', industry:'行业待确认' }), '未分类-600001');
  assert.equal(recommendationIndustryGroupKey({ code:'600002', industry:'行业待确认' }), '未分类-600002');
  const unknownContext = buildRecommendationFactorContext([
    { code:'600001', industry:'行业待确认', price:10, changePct:1 },
    { code:'600002', industry:'行业待确认', price:12, changePct:-1 }
  ]);
  assert.equal(unknownContext.sectorProfiles.size, 2);
});

test('大盘推荐在风险接口失败但没有已核验风险时降分保留候选', () => {
  const item = { code: '600001', score: 80, signalScore: 80, reason: '待突破。', scoreCard:{recommendation:80,snapshotId:'snap-risk'} };
  const unverified = evaluateRecommendationRisk(item, {
    status: 'unknown', summary: '限售解禁数据未确认',
    st: { status: 'clear' }, reduction: { status: 'clear' }, unlock: { status: 'unknown' },
    errors: ['限售解禁查询失败：read ECONNRESET']
  });
  assert.equal(unverified.status, 'unverified');
  assert.equal(unverified.item.signalScore, 72);
  assert.equal(unverified.item.scoreCard.recommendation, 72);
  assert.equal(unverified.item.scoreCard.snapshotId, 'snap-risk');
  assert.equal(unverified.item.riskUnverified, true);
  assert.match(unverified.item.reason, /限售解禁数据未确认/);

  assert.equal(evaluateRecommendationRisk(item, {
    status: 'risk', summary: '未来半年存在减持计划',
    st: { status: 'clear' }, reduction: { status: 'risk' }, unlock: { status: 'clear' }, errors: []
  }).status, 'rejected');
  const allUnknown = evaluateRecommendationRisk(item, {
    status: 'unknown', summary: '减持计划数据未确认',
    st: { status: 'clear' }, reduction: { status: 'unknown' }, unlock: { status: 'unknown' }, errors: []
  });
  assert.equal(allUnknown.status, 'unverified');
  assert.equal(allUnknown.item.signalScore, 66);
});

test('后台全市场结果可发布超过160只观察候选且不冒充严格推荐', () => {
  const tradeDate='2026-09-14';
  const scored=Array.from({length:220},(_,index)=>({code:String(600000+index),name:`测试${index}`,industry:`行业${index%12}`,price:10,changePct:1,amount:1e8}));
  const screening={tradeDate,generatedAt:'2026-09-14T07:00:00.000Z',modelVersion:RECOMMENDATION_MODEL_VERSION,analysisId:'full-1',
    complete:true,historyCovered:220,universe:220,candidates:scored.map((item,index)=>({code:item.code,status:index%3?'watch':'strict',score:70,stage:'接近突破',horizon:'波段',rps20:80}))};
  const rows=buildBackgroundWatchRecommendations(scored,screening,tradeDate,Date.parse('2026-09-14T08:00:00.000Z'));
  assert.equal(rows.length,220);
  assert.ok(rows.every(item=>item.recommendationTier==='观察候选' && item.entryAssessment.allowed===false));
});

test('详情多因子评分独立于CANSLIM且缺失项不按中性满配', () => {
  const factor = buildDetailFactorAnalysis({score:82,return20:8,return60:18,volumeRatio:1.8,ma20:10,ma30:9.5,latestPrice:11},
    {available:true,estimated:false,stale:false,mainNetInflow:1e8,netRatio:2}, {rotationScore:76});
  assert.ok(factor.available >= 4);
  assert.ok(factor.score >= 70);
  const missing = buildDetailFactorAnalysis({}, null, null);
  assert.equal(missing.score, null);
  assert.equal(missing.available, 0);
});

test('收藏反馈为空时仍保留稳定签名供缓存复用', () => {
  const profile = summarizeRecommendationOutcomes([{
    code:'600001', label:'历史收藏', outcomeOrigin:'favorite', favoriteBasePrice:10,
    price:11, favoriteAddedAt:'2026-09-01T00:00:00.000Z'
  }], {now:Date.parse('2026-09-10T00:00:00.000Z')});
  const metadata = recommendationOutcomeMetadata(profile);
  assert.equal(metadata.sampleSize, 0);
  assert.equal(metadata.excludedCount, 1);
  assert.equal(metadata.signature, profile.signature);
});

test('本轮大盘推荐为空时保留最近成功推荐并刷新行情', () => {
  const result = { recommendations: [], recommendationCoverage: { scanned: 5892 } };
  const cached = {
    fetchedAt: '2026-08-13T08:00:00.000Z',
    recommendations: [{ code:'600001', name:'测试股', signal:'突破确认', signalScore:72, technicalScore:75, price:10, factorAnalysis:{sectorProfile:{name:'半导体'}} }],
    recommendationCoverage: { scanned:5892, prefiltered:400, analyzed:60, industries:40, qualified:1 }
  };
  const restored = restoreCachedMarketRecommendations(result, cached, [{ code:'600001', price:10.8, changePct:2.5, amount:1e8 }]);
  assert.equal(restored, true);
  assert.equal(result.recommendations.length, 1);
  assert.equal(result.recommendations[0].industry, '半导体');
  assert.equal(result.recommendations[0].price, 10.8);
  assert.equal(result.recommendations[0].entryAssessment.status, '数据待补充');
  assert.match(result.recommendations[0].reason, /综合入场：数据待补充/);
  assert.equal(result.recommendationCoverage.cachedFallback, true);
  assert.equal(result.recommendationCoverage.qualified, 1);
  assert.equal(result.recommendationCoverage.momentumCandidates, null);
  assert.match(result.recommendationCoverage.momentumUnavailableReason, /旧模型/);
  assert.deepEqual(result.recommendationCoverage.signals, { bottomWaiting:0, rebounded:0, breakout:1, structure:0, other:0 });

  const fresh = { recommendations:[{code:'600002'}] };
  assert.equal(restoreCachedMarketRecommendations(fresh, cached, []), false);
  assert.deepEqual(fresh.recommendations, [{code:'600002'}]);

  const obsolete = {
    fetchedAt: '2026-08-12T08:00:00.000Z',
    recommendations: [
      { code:'600003', signal:'待突破', signalScore:90, technicalScore:90 },
      { code:'600004', signal:'突破确认', signalScore:80, technicalScore:60 }
    ]
  };
  const empty = { recommendations: [] };
  assert.equal(restoreCachedMarketRecommendations(empty, obsolete, []), false);
  assert.deepEqual(empty.recommendations, []);
});

test('旧推荐模型缓存不能复用为双轨推荐结果', () => {
  const now = Date.parse('2026-09-04T07:05:00.000Z');
  const oldCache = {
    recommendations:[{code:'600001'}], momentumRecommendations:[],
    recommendationsFetchedAt:'2026-09-04T07:01:00.000Z',
    recommendationCoverage:{modelVersion:'2026-09-03-capital-rotation-v3',outcomeFeedback:{signature:'same'}}
  };
  const currentCache = {
    ...oldCache,
    recommendationCoverage:{modelVersion:RECOMMENDATION_MODEL_VERSION,directSectorCapital:0,outcomeFeedback:{signature:'same'}}
  };
  assert.equal(canReuseMarketRecommendations(oldCache, {feedbackSignature:'same', now}), false);
  assert.equal(canReuseMarketRecommendations(currentCache, {feedbackSignature:'same', now}), true);
  assert.equal(canReuseMarketRecommendations({...currentCache,cachedFallback:true}, {feedbackSignature:'same', now}), false);
  assert.equal(canReuseMarketRecommendations({...currentCache,recommendationFallback:{active:true}}, {feedbackSignature:'same', now}), false);
  assert.equal(canReuseMarketRecommendations(currentCache, {feedbackSignature:'changed', now}), false);
  assert.equal(canReuseMarketRecommendations(currentCache, {feedbackSignature:'same', now:Date.parse('2026-09-04T06:59:00.000Z')}), false);
  assert.equal(canReuseMarketRecommendations(currentCache, {feedbackSignature:'same', hasDirectSectorCapital:true, now}), false);
  assert.equal(canReuseMarketRecommendations({
    ...currentCache,
    recommendationCoverage:{...currentCache.recommendationCoverage,directSectorCapital:120}
  }, {feedbackSignature:'same', hasDirectSectorCapital:true, now}), true);
});

test('command input uses a focus-hidden recommendation prompt', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.match(html, /<textarea[^>]*id="commandInput"[^>]*placeholder="输入你想要搜索的相关内容，会给你生成对应内容的股票推荐"[^>]*><\/textarea>/);
  assert.match(css, /\.command-row textarea:focus::placeholder\{color:transparent\}/);
});

test('并发调度限制峰值并隔离单项失败', async () => {
  let active = 0;
  let peak = 0;
  const results = await settleWithConcurrency([1, 2, 3, 4, 5], 2, async value => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    if (value === 3) throw new Error('expected');
    return value * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
  assert.deepEqual(results.filter(result => result.status === 'fulfilled').map(result => result.value), [2, 4, 8, 10]);
});

test('market analysis merges the live trading day into delayed daily history', () => {
  const history = [
    { date: '2026-08-12', open: 10, close: 10.2, high: 10.3, low: 9.9, volume: 100 }
  ];
  const quote = {
    tradeDate: '2026-08-13', open: 10.2, price: 9.8, high: 10.4, low: 9.7, volume: 180, amount: 1764
  };
  const merged = mergeQuoteIntoHistory(history, quote);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.at(-1), {
    date: '2026-08-13', open: 10.2, close: 9.8, high: 10.4, low: 9.7, volume: 180, amount: 1764
  });
  assert.equal(history.length, 1);

  const updated = mergeQuoteIntoHistory(merged, { ...quote, price: 9.9, volume: 200 });
  assert.equal(updated.length, 2);
  assert.equal(updated.at(-1).close, 9.9);
  assert.equal(updated.at(-1).volume, 200);
  assert.deepEqual(mergeQuoteIntoHistory(history, { price: 9.8 }), history);
});

test('market recommendation timing rejects weak closes after a hot run', () => {
  const hotReversal = assessRecommendationTimingRisk({
    price: 71.86,
    high: 77.12,
    low: 71,
    changePct: -4.63,
    analysis: { return5: 31.23, rsi14: 72.9, volatility20: 169.1, ma20: 54.29, breakoutPrice: 74.66 }
  });
  assert.ok(hotReversal.penalty >= 70);
  assert.ok(hotReversal.reasons.length >= 3);
  assert.ok(hotReversal.reasons.includes('突破后回落'));

  const steadyBreakout = assessRecommendationTimingRisk({
    price: 10.8,
    high: 10.9,
    low: 10.2,
    changePct: 2.2,
    analysis: { return5: 6.5, rsi14: 66, volatility20: 42, ma20: 10.1 }
  });
  assert.equal(steadyBreakout.penalty, 0);
  assert.deepEqual(steadyBreakout.reasons, []);

  const chase = assessRecommendationTimingRisk({
    price: 10.85,
    high: 10.9,
    low: 10.2,
    changePct: 8.5,
    analysis: { return5: 6.5, rsi14: 66, volatility20: 42, ma20: 10.1 }
  });
  assert.equal(chase.penalty, 25);
  assert.deepEqual(chase.reasons, ['当日涨幅过大']);
});

test('未来半年公司风险只拦截当前ST和窗口内减持解禁', () => {
  const today = '2026-08-13';
  const planContent = '减持期间：股东自本公告披露之日起15个交易日后的2个月内，即2026年7月2日-2026年9月1日。';
  assert.deepEqual(parseReductionPlanWindow(planContent, '2026-06-10'), {
    startDate: '2026-07-02',
    endDate: '2026-09-01',
    estimated: false
  });

  const risky = buildFutureRiskProfile({
    name: '美信科技',
    today,
    unlockRows: [
      { FREE_DATE: '2026-09-15 00:00:00', FREE_SHARES_TYPE: '股权激励限售股份', ABLE_FREE_SHARES: 307800 },
      { FREE_DATE: '2027-09-16 00:00:00', FREE_SHARES_TYPE: '股权激励限售股份', ABLE_FREE_SHARES: 230850 }
    ],
    reductionAnnouncements: [{
      title: '关于特定股东减持股份预披露公告',
      noticeDate: '2026-06-10',
      content: planContent
    }]
  });
  assert.equal(risky.passed, false);
  assert.equal(risky.status, 'risk');
  assert.equal(risky.unlock.events.length, 1);
  assert.equal(risky.reduction.events.length, 1);
  assert.match(risky.summary, /减持计划|限售解禁/);

  const clear = buildFutureRiskProfile({
    name: '正常股票',
    today,
    unlockRows: [{ FREE_DATE: '2027-09-16 00:00:00' }],
    reductionAnnouncements: [{
      title: '关于股东减持计划期满暨实施情况的公告',
      noticeDate: '2026-05-27',
      content: '上述减持计划期限已满。'
    }, {
      title: '关于特定股东减持股份预披露公告',
      noticeDate: '2026-03-05',
      content: '减持期间：2026年3月27日-2026年5月26日。'
    }]
  });
  assert.equal(clear.passed, true);
  assert.equal(clear.status, 'clear');
  assert.equal(clear.unlock.events.length, 0);
  assert.equal(clear.reduction.events.length, 0);

  const stRisk = buildFutureRiskProfile({ name: '*ST测试', today, unlockRows: [], reductionAnnouncements: [] });
  assert.equal(stRisk.passed, false);
  assert.equal(stRisk.st.status, 'risk');
});

test('未来公司风险数据缺失时标记未确认而不是无风险', () => {
  const profile = buildFutureRiskProfile({
    name: '正常股票',
    today: '2026-08-13',
    unlockRows: null,
    reductionAnnouncements: null
  });
  assert.equal(profile.passed, false);
  assert.equal(profile.status, 'unknown');
  assert.match(profile.summary, /未确认/);
});

test('在线搜索能找到利通电子', { timeout: 30000 }, async () => {
  const result = await handlers.get('search-a-share-stocks')(null, '利通电子');
  assert.ok(result.results.some(stock => stock.code === '603629' && stock.name === '利通电子'));
});

test('行情刷新返回实时价格和市值', { timeout: 30000 }, async () => {
  const result = await handlers.get('fetch-a-share-quotes')(null, ['601088']);
  assert.equal(result.requested, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.cached, 0);
  assert.ok(result.quotes[0].price > 0);
  assert.ok(result.quotes[0].totalMarketCap > 0);
  assert.equal(typeof result.quotes[0].turnoverRate, 'number');
  assert.equal(typeof result.quotes[0].peRatio, 'number');
  assert.equal(typeof result.quotes[0].pbRatio, 'number');
  assert.equal(typeof result.quotes[0].snapshotVolumeRatio, 'number');
  assert.equal(typeof result.quotes[0].amplitude, 'number');
  assert.ok(result.quotes[0].upperLimit > result.quotes[0].price);
  assert.ok(result.quotes[0].lowerLimit < result.quotes[0].price);
  assert.match(result.quotes[0].source, /腾讯|东方财富|新浪/);
});

test('个股资金汇总返回主力流入流出净额和占比', { timeout: 60000 }, async () => {
  const handler = handlers.get('fetch-stock-fund-flow');
  assert.equal(typeof handler, 'function');
  const result = await handler(null, { code: '603567', amount: 390000000 });
  assert.ok(result.mainInflow >= 0);
  assert.ok(result.mainOutflow >= 0);
  assert.equal(typeof result.mainNetInflow, 'number');
  assert.equal(typeof result.mainNetPct, 'number');
  assert.ok(result.source);
  assert.ok(result.tradeDate);
});

test('近三个月行情返回技术分析和观察窗口', { timeout: 60000 }, async () => {
  const handler = handlers.get('fetch-stock-history');
  assert.equal(typeof handler, 'function');
  const result = await handler(null, { code: '603567', name: '珍宝岛', industry:'中药', force:true });
  assert.ok(result.history.length >= 50);
  assert.ok(result.analysis.ma20 > 0);
  assert.ok(result.analysis.ma30 > 0);
  assert.ok(result.analysis.ma60 > 0);
  assert.match(result.analysis.summary, /MA30/);
  assert.match(result.analysis.entry, /入场|等待|观察/);
  assert.match(result.analysis.exit, /离场|止损|止盈|风控/);
  assert.match(result.analysis.entryWindow, /交易日/);
  assert.match(result.analysis.verdict, /可关注|等待确认|暂不适合|不宜追高/);
  const plan = result.analysis.tradePlan;
  assert.ok(plan.entryLow > 0 && plan.entryHigh >= plan.entryLow);
  assert.ok(plan.invalidationPrice < plan.entryLow);
  assert.equal(plan.entrySteps.reduce((sum, step) => sum + step.buyPct, 0), 100);
  assert.equal(plan.targets.reduce((sum, target) => sum + target.sellPct, 0), 100);
  assert.ok(plan.targets[0].price < plan.targets[1].price && plan.targets[1].price < plan.targets[2].price);
  assert.ok(plan.maxPositionPct > 0 && plan.maxPositionPct <= 30);
  assert.equal(typeof result.analysis.score, 'number');
  assert.equal(typeof result.analysis.volumeRatio, 'number');
  assert.ok(result.analysis.breakoutPrice > 0);
  assert.ok(result.analysis.supportPrice > 0);
  assert.ok(result.analysis.latestTradeDate);
  assert.ok(result.analysis.analyzedAt);
  assert.ok(result.analysis.accumulationSetup);
  assert.ok(result.analysis.capitalSetupAssessment);
  assert.ok(result.analysis.consolidationBreakout);
  assert.ok(result.analysis.breakoutPotential);
  assert.match(result.analysis.breakoutPotential.status, /横盘观察|突破蓄势|接近突破|突破确认|结构偏弱|非横盘/);
  assert.equal(typeof result.fundFlowPeriod?.available, 'boolean');
  assert.match(result.analysis.capitalSetupAssessment.summary, /主力资金/);
  assert.ok(result.newsContext);
  assert.ok(result.financialAnalysis?.latestReport);
  assert.equal(result.investmentAnalysis?.canslim?.total, 7);
  assert.ok(result.investmentAnalysis?.canslim?.available >= 4);
  assert.match(result.investmentAnalysis.canslim.dimensions.find(item => item.key === 'M')?.evidence || '', /美股/);
  assert.match(result.investmentAnalysis?.value?.dcf?.evidence || '', /暂不计算DCF|缺少/);
  const stop = Number((result.analysis.exit.match(/有效跌破([\d.]+)元/) || [])[1]);
  const nearbySupport = Math.min(result.analysis.ma20, result.analysis.ma30, result.analysis.supportPrice);
  assert.ok(stop >= nearbySupport * 0.95 && stop < result.history.at(-1).close);
});

test('日线可聚合为周K和月K备用数据', () => {
  const rows = [
    { date:'2026-07-31', open:10, high:11, low:9, close:10.5, volume:100 },
    { date:'2026-08-03', open:10.6, high:11.2, low:10.2, close:11, volume:120 },
    { date:'2026-08-07', open:11, high:12, low:10.8, close:11.8, volume:180 },
    { date:'2026-08-10', open:11.9, high:12.3, low:11.4, close:12, volume:200 }
  ];
  const weeks = aggregateHistoryPeriod(rows, 'week');
  assert.equal(weeks.length, 3);
  assert.deepEqual(weeks[1], {
    date:'2026-08-07', open:10.6, high:12, low:10.2, close:11.8, volume:300
  });
  const months = aggregateHistoryPeriod(rows, 'month');
  assert.equal(months.length, 2);
  assert.deepEqual(months[1], {
    date:'2026-08-10', open:10.6, high:12.3, low:10.2, close:12, volume:500
  });
});

test('交易计划失效价始终低于低吸区下沿', () => {
  const plan = buildTradePlan({
    latestPrice:10, supportPrice:8, resistance:11, rangeHigh:12, recent10Low:9,
    ma5:9.5, ma10:9.3, ma20:9, ma30:8.8, atr14:.15, volumeRatio:1, verdict:'等待确认'
  });
  assert.ok(plan.invalidationPrice < plan.entryLow);
  assert.ok(plan.stopPct > 0);
});

test('个股走势返回分时五日日周月五种周期', { timeout: 60000 }, async () => {
  const handler = handlers.get('fetch-stock-chart');
  assert.equal(typeof handler, 'function');
  for (const period of ['minute', 'five-day', 'day', 'week', 'month']) {
    const result = await handler(null, { code: '600519', period });
    assert.equal(result.period, period);
    assert.ok(result.rows.length >= (period === 'minute' ? 1 : 20), `${period} 数据不足`);
    assert.ok(result.rows.every(row => row.time && row.close > 0));
    if (period === 'minute') assert.ok(result.previousClose > 0);
  }
});

test('公司资料可从板块归属识别实际行业', { timeout: 30000 }, async () => {
  const result = await handlers.get('fetch-company-profile')(null, { code: '603567', name: '珍宝岛', sector: '线上搜索' });
  assert.match(result.profile.industry, /中药|医药/);
  assert.ok(result.profile.tags.some(tag => /中药|医药/.test(tag)));
  assert.equal(new Set(result.profile.tags).size, result.profile.tags.length);
});

test('大盘分析返回指数、轮动、资金和涨跌停结构', { timeout: 180000 }, async () => {
  const handler = handlers.get('fetch-market-overview');
  assert.equal(typeof handler, 'function');
  const result = await handler(null, true);
  assert.ok(result.indices.length >= 3);
  assert.ok(result.indices.every(index => index.price > 0));
  assert.ok(result.overseas.indices.length >= 3);
  assert.match(result.overseas.source, /腾讯/);
  assert.equal(typeof result.turnover, 'number');
  assert.ok(result.breadth.up + result.breadth.down + result.breadth.flat > 4500);
  assert.ok(result.sectors.length >= 8);
  assert.ok(result.fundSectors.length >= 8);
  assert.equal(typeof result.limits.upCount, 'number');
  assert.equal(typeof result.limits.downCount, 'number');
  assert.match(result.limits.date, /^\d{8}$/);
  assert.equal(result.limits.observationOnly, true);
  assert.match(result.limits.observationReason, /不生成买入许可/);
  assert.ok(result.marketRegime?.key);
  assert.ok(result.marketRegime?.evidence?.length >= 3);
  assert.ok(result.snapshotId);
  assert.ok(['preopen','intraday','closed'].includes(result.observationPhase?.phase));
  assert.match(result.source, /腾讯全市场行情/);
  assert.ok(Array.isArray(result.recommendations));
  if (!result.recommendations.length) {
    assert.ok(result.recommendationCoverage.enriched > 0, 'Empty results must still have verified candidates');
    assert.ok(result.recommendationCoverage.outcomeGateRejected > 0, 'Empty results must have screening evidence');
    assert.ok(Object.values(result.recommendationCoverage.outcomeGateFailures).some(count=>count > 0));
    assert.deepEqual(result.errors, []);
  }
  assert.ok(result.recommendations.every(item => item.breakoutPrice > 0 && item.ma30 > 0));
  assert.ok(result.recommendations.every(item => [
    '底部待反弹', '已反弹', '待突破', '横盘观察', '突破蓄势', '接近突破', '突破确认', '底部吸筹', '震荡洗盘'
  ].includes(item.signal)));
  assert.ok(result.recommendations.every(item => ['消息确认', '消息中性', '消息谨慎'].includes(item.newsLabel)));
  assert.ok(result.recommendations.every(item => Number.isFinite(item.signalScore) && item.reason.includes(item.signal)));
  assert.ok(result.recommendations.every(item => item.scoreCard?.recommendation === item.signalScore && item.scoreCard?.snapshotId));
  assert.ok(result.recommendations.every(item => item.industry && item.industry !== '行业待确认'));
  assert.ok(result.recommendations.every(item => item.canslim?.total === 7));
  assert.ok(result.recommendations.every(item => {
    const source = item.financialAnalysis?.source || '';
    return !item.financialAnalysis?.available || /东方财富(?:F10|数据中心)|新浪财务|本地缓存/.test(source);
  }));
  assert.equal(result.recommendations.length, result.recommendationCoverage.qualified);
  const finalSignalCounts = result.recommendations.reduce((counts, item) => {
    counts[recommendationSignalFamily(item.signal)] += 1;
    return counts;
  }, { bottomWaiting: 0, rebounded: 0, breakout: 0, structure: 0, other: 0 });
  assert.deepEqual(result.recommendationCoverage.signals, finalSignalCounts);
  assert.equal(Object.values(result.recommendationCoverage.signals).reduce((sum, count) => sum + count, 0), result.recommendations.length);
  assert.ok(result.recommendations.every(item => item.score === item.signalScore && Number.isFinite(item.technicalScore)));
  assert.ok(result.recommendations.every(recommendationPassesDisplayGate));
  assert.ok(result.recommendations.every(item => [
    '突破确认', '突破蓄势', '接近突破', '底部吸筹', '震荡洗盘', '横盘观察'
  ].includes(item.signal)));
  assert.ok(result.recommendations.every(item => item.entryAssessment?.status));
  assert.ok(result.recommendations.every(item => item.recommendationModelVersion));
  assert.ok(result.recommendations.every(item => item.recommendationContext?.capital));
  assert.ok(result.recommendations.every(item => item.recommendationContext?.news));
  assert.ok(result.recommendations.every(item => item.recommendationContext?.overseas));
  assert.ok(result.recommendations.every(item => !['破位', '爆量观察', '结构偏弱', '不宜追高', '公司风险'].includes(item.entryAssessment.status)));
  assert.ok(result.recommendations.every(item => /综合入场/.test(item.reason)));
  assert.ok(Number.isInteger(result.recommendationCoverage.outcomeGateRejected));
  assert.equal(typeof result.recommendationCoverage.outcomeGateFailures, 'object');
  assert.equal(result.recommendationCoverage.strictQualified + result.recommendationCoverage.watchQualified, result.recommendations.length);
  assert.ok((result.recommendationCoverage.signalCandidates?.rebounded || 0) >= (result.recommendationCoverage.signals?.rebounded || 0));
  assert.ok(result.recommendationCoverage.scanned > 1000);
  assert.ok(result.recommendationCoverage.analyzed > 24);
  assert.ok(result.newsContext?.summary);
  assert.ok(Array.isArray(result.newsContext?.items));
  assert.ok(result.analysis);
});

test('惠州平潭机场按地点设施和产业关系生成股票池', { timeout: 60000 }, async () => {
  const result = await handlers.get('run-industry-workflow')(null, '搜索惠州平潭机场相关股票');
  assert.equal(result.entities.facility, '机场');
  assert.deepEqual(result.entities.locationParts, ['惠州', '平潭']);
  assert.ok(result.stocks.some(stock => stock.code === '000089' && stock.name === '深圳机场'));
  assert.ok(result.stocks.some(stock => stock.code === '002542' && /机场建设|通航/.test(stock.sector)));
  assert.ok(result.stocks.some(stock => stock.code === '000592' && /待核验/.test(stock.sector)));
  assert.ok(!result.stocks.some(stock => stock.code === '002928' || stock.name === '华夏航空'));
});

test('大连金州机场按本地项目关系生成不同于惠州的股票池', { timeout: 60000 }, async () => {
  const result = await handlers.get('run-industry-workflow')(null, '搜索大连金州机场相关股票');
  assert.equal(result.entities.facility, '机场');
  assert.deepEqual(result.entities.locationParts, ['大连', '金州']);
  assert.ok(result.stocks.some(stock => stock.code === '605598' && /大连金州湾机场/.test(stock.sector)));
  assert.ok(result.stocks.some(stock => ['601800', '601668', '601186'].includes(stock.code)));
  assert.ok(!result.stocks.some(stock => ['000089', '000592'].includes(stock.code)));
});

test('深圳南宁高铁按线路端点返回高铁通用产业链', { timeout: 60000 }, async () => {
  const search = await handlers.get('search-a-share-stocks')(null, '深圳南宁高铁');
  assert.ok(search.results.length >= 6);
  assert.ok(search.results.some(stock => stock.code === '601766' && /动车组/.test(stock.sector)));
  assert.ok(search.results.some(stock => ['601390', '601186'].includes(stock.code) && /深圳—南宁高铁/.test(stock.sector)));
  assert.ok(search.results.every(stock => /不代表已确认参与或中标/.test(stock.relationEvidence)));

  const result = await handlers.get('run-industry-workflow')(null, '搜索深圳南宁高铁相关股票');
  assert.equal(result.entities.facility, '高铁');
  assert.deepEqual(result.entities.locationParts, ['深圳', '南宁']);
  assert.ok(result.stocks.length >= 6);
  assert.ok(result.stocks.some(stock => stock.code === '601766'));
  assert.ok(result.stocks.some(stock => stock.code === '000008'));
});

test('阶段深跌后均线与MACD改善可形成已反弹信号', () => {
  const closes = [
    ...Array(60).fill(100),
    ...Array.from({ length: 40 }, (_, index) => 99 - index),
    60, 62, 61, 64, 63, 66, 65, 68, 67, 70,
    69, 72, 70, 73, 71, 74, 72, 75, 73, 76
  ];
  const history = closes.map((close, index) => ({
    date: `2026-08-${String(index + 1).padStart(2, '0')}`,
    open: close - 0.5,
    close,
    high: close + 1,
    low: index === 100 ? 59 : close - 1,
    volume: 1_000_000 + index * 1_000
  }));
  const analysis = analyzeHistory(history);
  assert.equal(analysis.reboundSignal, '已反弹');
  assert.ok(analysis.bottomDrawdown <= -18);
  assert.ok(analysis.reboundFromBottom >= 6);
  assert.ok(analysis.ma5 > analysis.ma10);
});

test('阶段资金流汇总区分主力买入、卖出和净额', () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({
    opendate: `2026-08-${String(index + 1).padStart(2, '0')}`,
    r0_in: '500', r0_out: '300', r0_net: index === 0 ? '-100' : '200', r0_ratio: '2.5'
  }));
  const result = summarizeFundFlowRows(rows, 10);
  assert.equal(result.available, true);
  assert.equal(result.days, 10);
  assert.equal(result.mainInflow, 50_000_000);
  assert.equal(result.mainOutflow, 30_000_000);
  assert.equal(result.mainNetInflow, 17_000_000);
  assert.equal(result.grossFlowsAvailable, true);
  assert.equal(result.positiveDays, 9);
  assert.equal(result.startDate, '2026-08-01');
  assert.equal(result.endDate, '2026-08-10');
});

test('新浪新版阶段资金净额按元处理且缺失买卖分项时不伪造为零', () => {
  const result = summarizeFundFlowRows([
    { opendate:'2026-08-14', r0_net:'-43094586.95', r0_ratio:'-0.09390522' },
    { opendate:'2026-08-13', r0_net:'27837323.49', r0_ratio:'0.03976190' }
  ], 10);
  assert.equal(result.mainInflow, null);
  assert.equal(result.mainOutflow, null);
  assert.equal(result.grossFlowsAvailable, false);
  assert.ok(Math.abs(result.mainNetInflow - -15_257_263.46) < .01);
  assert.ok(result.netRatio < 0);
});

test('识别底部五线粘合后三次温和放量并开始多头发散', () => {
  const rows = Array.from({ length: 90 }, (_, index) => {
    const risingIndex = Math.max(0, index - 59);
    const close = index < 60 ? 10 : 10 + risingIndex * .045;
    const surge = [68, 76, 84].includes(index);
    return {
      date: `2026-05-${String(index + 1).padStart(2, '0')}`,
      open: close * .995, close, high: close * 1.015, low: close * .985,
      volume: surge ? 1_650_000 : 1_000_000, amount: close * (surge ? 1_650_000 : 1_000_000)
    };
  });
  const setup = analyzeAccumulationSetup(rows);
  assert.equal(setup.passed, true);
  assert.equal(setup.bullishAlignment, true);
  assert.equal(setup.notMainWave, true);
  assert.ok(setup.volumeSurgeCount >= 3);
  assert.ok(setup.surgePriceRisePct > 0);
  assert.match(setup.summary, /五线粘合/);
  assert.match(setup.summary, /3次/);

  const upperBoundary = rows.map((row, index) => [68, 76, 84].includes(index) ? ({ ...row, volume: 3_800_000, amount: row.close * 3_800_000 }) : row);
  assert.equal(analyzeAccumulationSetup(upperBoundary).passed, true);

  const overheated = rows.map((row, index) => index < 70 ? row : ({ ...row, close: row.close * 1.45, high: row.high * 1.45, low: row.low * 1.45 }));
  assert.equal(analyzeAccumulationSetup(overheated).passed, false);
});

test('横盘箱体量能试压可识别蓄势和放量突破', () => {
  const trend = Array.from({ length: 70 }, (_, index) => {
    const close = 7 + index * .015;
    return {
      date: `2026-04-${String(index + 1).padStart(2, '0')}`,
      open: close - .03, close, high: close + .08, low: close - .08, volume: 1_000_000
    };
  });
  const boxCloses = [8.08, 8.16, 8.11, 8.22, 8.18, 8.28, 8.21, 8.34, 8.30];
  const box = boxCloses.map((close, index) => ({
    date: `2026-08-${String(index + 1).padStart(2, '0')}`,
    open: close - .03, close,
    high: index === 7 ? 8.58 : close + .10,
    low: index === 0 ? 8.00 : close - .08,
    volume: index === 7 ? 1_600_000 : 760_000
  }));
  const latest = {
    date: '2026-08-10', open: 8.31, close: 8.40, high: 8.48, low: 8.25, volume: 900_000
  };
  const setup = analyzeConsolidationBreakout([...trend, ...box, latest]);
  assert.equal(setup.available, true);
  assert.equal(setup.isConsolidating, true);
  assert.ok(setup.boxDays >= 7 && setup.boxDays <= 12);
  assert.ok(['突破蓄势', '接近突破'].includes(setup.status));
  assert.ok(setup.distanceToBreakoutPct >= 0 && setup.distanceToBreakoutPct <= 4);
  assert.ok(setup.pressureTestCount >= 1);

  const breakout = analyzeConsolidationBreakout([
    ...trend, ...box,
    { ...latest, close: 8.70, high: 8.75, low: 8.40, volume: 1_600_000 }
  ]);
  assert.equal(breakout.breakoutConfirmed, true);
  assert.equal(breakout.status, '突破确认');
  assert.equal(breakout.boxHigh, 8.58);
  assert.match(breakout.trigger, /1\.5.*4\.0/);

  const insufficientVolume = analyzeConsolidationBreakout([
    ...trend, ...box,
    { ...latest, close: 8.70, high: 8.75, low: 8.40, volume: 1_300_000 }
  ]);
  assert.equal(insufficientVolume.breakoutConfirmed, false);

  const explosiveVolume = analyzeConsolidationBreakout([
    ...trend, ...box,
    { ...latest, close: 8.70, high: 8.75, low: 8.40, volume: 4_500_000 }
  ]);
  assert.equal(explosiveVolume.breakoutConfirmed, false);
  assert.equal(explosiveVolume.explosiveVolume, true);
  assert.equal(explosiveVolume.status, '结构偏弱');
});

test('横盘突破合并阶段资金后统一升级或降级', () => {
  const technical = {
    available: true, isConsolidating: true, status: '突破蓄势', technicalScore: 66,
    boxDays: 9, boxLow: 8, boxHigh: 8.6, rangePct: 7.2, distanceToBreakoutPct: 2.5,
    pressureTestCount: 1, failedPressureCount: 0, breakoutConfirmed: false,
    summary: '近9日横盘箱体8.00-8.60元', trigger: '放量收盘突破8.60元', invalidation: '收盘跌破8.00元'
  };
  const positive = combineConsolidationBreakout(technical, {
    available: true, days: 10, mainInflow: 8e8, mainOutflow: 5e8,
    mainNetInflow: 3e8, netRatio: 23.08, positiveDays: 7
  });
  assert.equal(positive.score, 76);
  assert.equal(positive.status, '接近突破');
  assert.match(positive.summary, /近10日主力买入/);

  const missing = combineConsolidationBreakout(technical, { available: false, days: 0 });
  assert.equal(missing.score, 66);
  assert.equal(missing.status, '突破蓄势');
  assert.match(missing.summary, /资金数据不足/);

  const negative = combineConsolidationBreakout(technical, {
    available: true, days: 10, mainInflow: 4e8, mainOutflow: 7e8,
    mainNetInflow: -3e8, netRatio: -27.27, positiveDays: 3
  });
  assert.equal(negative.score, 48);
  assert.equal(negative.status, '结构偏弱');

  const nonConsolidating = combineConsolidationBreakout({
    ...technical, isConsolidating: false, status: '非横盘', technicalScore: 42
  }, {
    available: true, days: 10, mainInflow: 9e8, mainOutflow: 2e8,
    mainNetInflow: 7e8, netRatio: 63.64, positiveDays: 9
  });
  assert.equal(nonConsolidating.status, '非横盘');
  assert.equal(nonConsolidating.score, 42);
  assert.equal(nonConsolidating.flowAdjustment, 0);
});

test('个股入场结论区分破位、爆量、等待确认和可分批入场', () => {
  const base = {
    latestPrice: 10.8, ma5: 10.5, ma10: 10.3, ma20: 10.1, ma30: 9.9,
    supportPrice: 9.8, resistance: 10.5, volumeRatio: 1.8, rsi14: 62,
    breakoutStatus: '突破确认'
  };
  const ready = assessCurrentEntry(base);
  assert.equal(ready.allowed, true);
  assert.equal(ready.status, '可分批入场');
  assert.match(ready.summary, /现价10\.80元.*量比1\.80/);

  const broken = assessCurrentEntry({
    ...base, latestPrice: 8.8, ma5: 9.1, ma10: 9.3, ma20: 9.4, ma30: 9.5,
    supportPrice: 9.2, resistance: 10.5, volumeRatio: .8, breakoutStatus: '结构偏弱'
  });
  assert.equal(broken.allowed, false);
  assert.equal(broken.status, '破位');
  assert.match(broken.summary, /不建议入场/);

  const explosive = assessCurrentEntry({ ...base, volumeRatio: 4.2 });
  assert.equal(explosive.allowed, false);
  assert.equal(explosive.status, '爆量观察');
  assert.match(explosive.summary, /超过4\.0倍/);

  const waiting = assessCurrentEntry({ ...base, volumeRatio: 1.4 });
  assert.equal(waiting.allowed, false);
  assert.equal(waiting.status, '等待确认');
  assert.match(waiting.summary, /未达到1\.5倍/);
  assert.equal(waiting.structureSummary, undefined);

  const extended = assessCurrentEntry({ ...base, latestPrice: 11.2 });
  assert.equal(extended.allowed, false);
  assert.equal(extended.status, '不宜追高');
  assert.match(extended.summary, /偏离突破位/);

  const accumulating = assessCurrentEntry({
    ...base, latestPrice: 10.1, resistance: 10.8, volumeRatio: .9,
    breakoutStatus: '横盘观察',
    accumulationSetup: {
      passed: true, bullishAlignment: true, diverging: true,
      volumeSurgeCount: 3, summary: '底部五线粘合后转为多头发散，三次温和放量'
    },
    consolidationBreakout: { available: true, isConsolidating: false },
    macdHistogram: .08, return20: 2.1
  });
  assert.equal(accumulating.status, '底部吸筹观察');
  assert.equal(accumulating.setupType, 'bottom-accumulation');
  assert.equal(accumulating.lowBuyCandidate, true);
  assert.match(accumulating.summary, /底部吸筹.*温和放量/);

  const washing = assessCurrentEntry({
    ...base, latestPrice: 10.15, resistance: 10.8, volumeRatio: .82,
    breakoutStatus: '突破蓄势', accumulationSetup: { passed: false },
    consolidationBreakout: {
      available: true, isConsolidating: true, status: '突破蓄势',
      boxLow: 9.8, boxHigh: 10.8, boxDays: 9, volumeCompressionRatio: .82,
      pressureTestCount: 1, failedPressureCount: 0
    },
    macdHistogram: .03, return20: 1.2
  });
  assert.equal(washing.status, '震荡洗盘观察');
  assert.equal(washing.setupType, 'sideways-washout');
  assert.equal(washing.lowBuyCandidate, true);
  assert.match(washing.summary, /9日.*缩量.*洗盘/);

  const suspectedAccumulation = assessCurrentEntry({
    ...base, latestPrice: 10.1, resistance: 10.8, volumeRatio: 1.15,
    breakoutStatus: '横盘观察',
    accumulationSetup: {
      passed: false, bullishAlignment: true, diverging: true, notMainWave: true,
      adhesionDate: '2026-07-20', volumeSurgeCount: 2,
      summary: '五线粘合2.80%；多头排列成立，发散成立，温和放量2次，区间涨幅6.0%'
    },
    consolidationBreakout: { available: true, isConsolidating: false, status: '非横盘', summary: '最近7至12日未形成稳定横盘箱体' }
  });
  assert.equal(suspectedAccumulation.status, '疑似吸筹，等待确认');
  assert.match(suspectedAccumulation.structureSummary, /疑似吸筹.*温和放量2次.*洗盘证据不足/);

  const uncompressedBox = assessCurrentEntry({
    ...base, latestPrice: 10.2, resistance: 10.8, volumeRatio: 1.15,
    breakoutStatus: '横盘观察', accumulationSetup: { passed: false, summary: '近阶段未识别到底部五线粘合' },
    consolidationBreakout: {
      available: true, isConsolidating: true, status: '横盘观察', boxDays: 10,
      boxLow: 9.8, boxHigh: 10.8, volumeCompressionRatio: 1.12,
      failedPressureCount: 0, summary: '近10日形成稳定横盘箱体，但量能尚未压缩'
    }
  });
  assert.equal(uncompressedBox.status, '箱体震荡，洗盘待确认');
  assert.match(uncompressedBox.structureSummary, /洗盘待确认.*量能压缩比1\.12/);
});

test('横盘预筛优先低波动缩量且接近日内高位的股票', () => {
  const quiet = scoreConsolidationCandidate({
    amount: 2e8, changePct: .5, snapshotVolumeRatio: .8,
    turnoverRate: 3, price: 8.3, high: 8.45
  });
  const volatile = scoreConsolidationCandidate({
    amount: 2e8, changePct: 8, snapshotVolumeRatio: 3,
    turnoverRate: 15, price: 8.3, high: 8.45
  });
  assert.ok(quiet > volatile);
  assert.ok(quiet > 0);
});

test('个股分析结合阶段主力资金评估蓄势强弱', () => {
  const technical = {
    score: 70,
    verdict: '可关注',
    buyCondition: '等待技术突破后再评估。',
    tradePlan: { enabled: true },
    accumulationSetup: { passed: true, summary: '五线粘合后多头发散，三次温和放量价格抬高' },
    entryAssessment: { allowed: true, status: '可分批入场', tone: 'positive', summary: '量价条件已满足。' }
  };
  const positive = applyIndividualCapitalAssessment(technical, {
    available: true, days: 10, mainInflow: 8e8, mainOutflow: 5e8,
    mainNetInflow: 3e8, netRatio: 23.08, positiveDays: 7
  });
  assert.equal(positive.score, 70);
  assert.equal(positive.capitalAdjustedScore, 76);
  assert.equal(positive.capitalSetupAssessment.status, '蓄势增强');
  assert.match(positive.capitalSetupAssessment.summary, /近10日主力买入/);
  assert.equal(positive.tradePlan.enabled, true);
  assert.equal(positive.entryAssessment.allowed, true);

  const negative = applyIndividualCapitalAssessment(technical, {
    available: true, days: 10, mainInflow: 4e8, mainOutflow: 7e8,
    mainNetInflow: -3e8, netRatio: -27.27, positiveDays: 3
  });
  assert.equal(negative.score, 70);
  assert.equal(negative.capitalAdjustedScore, 62);
  assert.equal(negative.capitalSetupAssessment.status, '资金未确认');
  assert.equal(negative.verdict, '等待确认');
  assert.equal(negative.tradePlan.enabled, false);
  assert.match(negative.buyCondition, /持续净流出/);
  assert.equal(negative.entryAssessment.allowed, false);
  assert.equal(negative.entryAssessment.status, '资金未确认');

  const bottomAccumulation = applyIndividualCapitalAssessment({
    ...technical,
    entryAssessment: {
      allowed: false, status: '底部吸筹观察', tone: 'warning',
      setupType: 'bottom-accumulation', lowBuyCandidate: true,
      summary: '底部五线粘合后温和放量，疑似吸筹。', evidence: []
    }
  }, {
    available: true, days: 10, mainInflow: 8e8, mainOutflow: 5e8,
    mainNetInflow: 3e8, netRatio: 23.08, positiveDays: 7
  });
  assert.equal(bottomAccumulation.entryAssessment.allowed, true);
  assert.equal(bottomAccumulation.entryAssessment.status, '底部吸筹，可分批低吸');
  assert.match(bottomAccumulation.entryAssessment.summary, /阶段主力净流入/);
  assert.equal(bottomAccumulation.verdict, '可关注');
  assert.match(bottomAccumulation.buyCondition, /可在支撑有效前提下分批低吸/);
  assert.equal(bottomAccumulation.tradePlan.enabled, true);
});

test('推荐信号统计区分突破形态与吸筹洗盘形态', () => {
  assert.equal(recommendationSignalFamily('待突破'), 'breakout');
  assert.equal(recommendationSignalFamily('突破确认'), 'breakout');
  assert.equal(recommendationSignalFamily('底部吸筹'), 'structure');
  assert.equal(recommendationSignalFamily('震荡洗盘'), 'structure');
  assert.equal(recommendationSignalFamily('已反弹'), 'rebounded');
});

test('本地推荐复盘排除指定标签和不足一天的样本', () => {
  const now = Date.parse('2026-08-17T12:00:00.000Z');
  const row = (label, signal, score, base, price, addedAt) => ({
    label, signal, signalScore:score, favoriteBasePrice:base, price, favoriteAddedAt:addedAt
  });
  const profile = summarizeRecommendationOutcomes([
    row('重点关注', '待突破', 60, 10, 8, '2026-08-13T00:00:00.000Z'),
    row('personal', '待突破', 60, 10, 8, '2026-08-13T00:00:00.000Z'),
    row('盘中0817', '待突破', 60, 10, 12, '2026-08-17T09:00:00.000Z'),
    row('盘前0813', '待突破', 60, 10, 9, '2026-08-13T00:00:00.000Z'),
    row('盘前0813', '已反弹', 75, 10, 11, '2026-08-13T00:00:00.000Z')
  ], { now });
  assert.equal(profile.sampleSize, 2);
  assert.equal(profile.byFamily.breakout.count, 1);
  assert.equal(profile.byFamily.rebounded.count, 1);
  assert.equal(profile.bySignal['待突破'].averageExcessReturn, -10);
  assert.equal(profile.bySignal['已反弹'].averageExcessReturn, 10);
  assert.equal(profile.byScoreBand['55-64'].count, 1);
  assert.equal(profile.excludedCount, 2);
  assert.equal(profile.immatureCount, 1);
});

test('推荐复盘使用最新行情覆盖收藏旧价', () => {
  const rows = [
    { code:'600001', label:'0821盘后', favoriteBasePrice:10, price:10 },
    { code:'600002', label:'0821盘后', favoriteBasePrice:20, price:19 }
  ];
  const merged = mergeRecommendationOutcomeQuotes(rows, [
    { code:'600001', price:11.5 },
    { code:'600002', price:null }
  ]);
  assert.equal(merged[0].price, 11.5);
  assert.equal(merged[1].price, 19);
  assert.equal(rows[0].price, 10);
});

test('推荐复盘区分同批次比较与真实大盘行业基准并拒绝旧行情', () => {
  const now = Date.parse('2026-09-11T08:00:00.000Z');
  const rows = mergeRecommendationOutcomeQuotes([{
    code:'600001', label:'0910盘后', favoriteBasePrice:10, price:9,
    favoriteAddedAt:'2026-09-09T08:00:00.000Z', holdingPeriod:'波段',
    benchmarkBasePrice:100, benchmarkPrice:105,
    industryBenchmarkBasePrice:200, industryBenchmarkPrice:216
  }, {
    code:'600002', label:'0910盘后', favoriteBasePrice:10, price:12,
    favoriteAddedAt:'2026-09-09T08:00:00.000Z'
  }], [{code:'600001', price:11, fetchedAt:'2026-09-11T07:59:00.000Z'}]);
  const profile = summarizeRecommendationOutcomes(rows, {now, requireFreshQuote:true});
  assert.equal(rows[0].quoteMatched, true);
  assert.equal(rows[1].quoteMatched, false);
  assert.equal(profile.sampleSize, 1);
  assert.equal(profile.staleQuoteCount, 1);
  assert.equal(profile.overall.averageReturn, 10);
  assert.equal(profile.overall.averageMarketExcessReturn, 5);
  assert.equal(profile.overall.averageIndustryExcessReturn, 2);
  assert.equal(profile.byHorizon['波段'].count, 1);
});

test('推荐复盘按收藏时指数快照计算同期大盘基准', () => {
  const rows = mergeRecommendationOutcomeBenchmarks([{
    code:'600001', benchmarkIndices:[{code:'000001',price:100},{code:'399001',price:200}],
    industryBenchmark:{code:'BK0475',name:'半导体',price:200}
  }], [{code:'000001',price:110},{code:'399001',price:180}], [{code:'BK0475',name:'半导体',price:220}]);
  assert.equal(rows[0].benchmarkBasePrice, 100);
  assert.equal(rows[0].benchmarkPrice, 100);
  assert.equal(rows[0].benchmarkCount, 2);
  assert.equal(rows[0].industryBenchmarkBasePrice, 200);
  assert.equal(rows[0].industryBenchmarkPrice, 220);
});

test('推荐评分不把缺失质量数据当作满分并给出数据可信度', () => {
  assert.equal(weightedRecommendationScore(80, null, 70), 76);
  assert.equal(weightedRecommendationScore(80, 100, 70), 80);
  const confidence = recommendationDataConfidence({
    industry:'半导体', qualityScore:null,
    factorAnalysis:{available:5,total:7},
    financialAnalysis:null,
    fundFlowPeriod:{available:true,estimated:false,days:1,complete:false},
    newsContext:{available:true,items:[{title:'行业订单增加'}]}
  });
  assert.equal(confidence.label, '中等');
  assert.equal(confidence.missing.includes('财务质量'), true);
  assert.equal(confidence.missing.includes('阶段资金'), true);
});

test('三周期评估将板块强势且量能受控的候选标记为短线', () => {
  const result = assessRecommendationHorizons({
    signal:'强势追踪', technicalScore:82, qualityScore:76,
    analysis:{score:82,volumeRatio:2.1,return20:6,return60:12,ma20:10,ma30:9.8,ma60:9.2,latestPrice:10.8},
    price:10.8, newsLabel:'消息确认', entryAssessment:{allowed:false,status:'等待首次回踩'},
    fundFlowPeriod:{available:true,estimated:false,mainNetInflow:2e8,netRatio:5,positiveDays:7},
    rotationProfiles:[{rotationScore:86,mainNetInflow:8e8,mainNetPct:6,capitalEstimated:false,capitalStale:false}],
    financialAnalysis:{score:68,available:5}, canslim:{score:70,available:5,total:7},
    momentumDecision:{passed:true}
  });
  assert.equal(result.primary, '短线');
  assert.equal(result.profiles.map(item => item.label).join(','), '短线,波段,中长线');
  assert.equal(result.profiles.every(item => item.days && Number.isFinite(item.score)), true);
});

test('正式推荐排除行业无法确认的股票并保留淘汰原因', () => {
  const result = filterResolvedRecommendations([
    {code:'600001',industry:'行业待确认'},
    {code:'600002',industry:'半导体'}
  ]);
  assert.deepEqual(result.items.map(item => item.code), ['600002']);
  assert.deepEqual(result.rejected, [{code:'600001',reason:'industry-unresolved'}]);
});

test('板块轮动阶段同时考虑资金持续性、上涨广度和成交集中度', () => {
  const base = {
    mainNetInflow:5e8, mainNetPct:4, mainNet3:12e8, mainNetPct3:5,
    mainNet5:20e8, mainNet10:35e8, capitalEstimated:false, capitalStale:false,
    changePct:2.4, participation:{available:true,breadthScore:72,topAmountShare:.24,divergent:false}
  };
  assert.equal(classifySectorRotationPhase(base).phase, '扩散确认');
  assert.equal(classifySectorRotationPhase({...base,participation:{...base.participation,topAmountShare:.58}}).phase, '龙头集中');
  assert.equal(classifySectorRotationPhase({...base,changePct:6.2,mainNetPct:8}).phase, '拥挤加速');
  assert.equal(classifySectorRotationPhase({...base,mainNetInflow:-5e8,mainNetPct:-4,mainNet3:-8e8,mainNetPct3:-4}).phase, '退潮');
});

test('推荐账本记录完整候选和三周期快照', () => {
  const entry = buildRecommendationLedgerEntry({
    fetchedAt:'2026-09-11T08:00:00.000Z', tradeDate:'2026-09-11',
    recommendations:[{code:'600001',name:'测试股份',industry:'半导体',signal:'突破蓄势',signalScore:78,holdingPeriod:'波段'}],
    momentumRecommendations:[],
    recommendationCoverage:{scanned:5000,analyzed:100,rejectedCandidates:[{code:'600002',reason:'industry-unresolved'}],modelVersion:'test-v1'}
  });
  assert.equal(entry.schemaVersion, 1);
  assert.equal(entry.recommendations[0].holdingPeriod, '波段');
  assert.equal(entry.rejectedCandidates[0].reason, 'industry-unresolved');
});

test('跨周末近期样本不足时按最新推荐版本扩窗', () => {
  const now = Date.parse('2026-08-24T08:00:00.000Z');
  const rows = [];
  const addCohort = (label, count, addedAt, returnPct) => {
    for (let index = 0; index < count; index++) rows.push({
      code:`60${String(rows.length).padStart(4, '0')}`,
      label,
      favoriteBasePrice:10,
      price:10 * (1 + returnPct / 100),
      favoriteAddedAt:addedAt,
      signal:'待突破',
      signalScore:75,
      technicalScore:80
    });
  };
  addCohort('0821盘后', 8, '2026-08-21T07:00:00.000Z', -2.5);
  addCohort('0820盘后', 11, '2026-08-20T07:00:00.000Z', -2.2);
  addCohort('0820盘中', 9, '2026-08-20T01:00:00.000Z', -2.8);
  addCohort('0819盘中', 14, '2026-08-19T02:00:00.000Z', 1);
  const profile = summarizeRecommendationOutcomes(rows, { now });
  assert.equal(profile.recentOverall.count, 28);
  assert.equal(profile.recentCohortCount, 3);
  assert.equal(profile.recentExtended, true);
  assert.equal(profile.marketRisk.status, 'drawdown');
});

test('技术评分历史表现参与推荐校准', () => {
  const weakTechnical = {count:28, averageReturn:-8.17, medianReturn:-9.24, winRate:11.5, averageExcessReturn:-.7, medianExcessReturn:-.9, outperformRate:38.5};
  const strongTechnical = {count:25, averageReturn:-2.62, medianReturn:-2.25, winRate:31.4, averageExcessReturn:3.49, medianExcessReturn:2.16, outperformRate:64.7};
  const profile = {
    sampleSize:100,
    byRecentSignal:{}, bySignal:{}, byRecentFamily:{}, byFamily:{},
    byRecentScoreBand:{}, byScoreBand:{},
    byRecentTechnicalScoreBand:{'<55':weakTechnical, '75+':strongTechnical},
    byTechnicalScoreBand:{}, marketRisk:{status:'normal'}
  };
  const weak = calibrateRecommendationWithOutcomes({signal:'待突破', signalScore:78, technicalScore:50}, profile);
  const strong = calibrateRecommendationWithOutcomes({signal:'待突破', signalScore:78, technicalScore:82}, profile);
  assert.equal(weak.technicalAdjustment, -6);
  assert.equal(weak.caution, true);
  assert.equal(strong.technicalAdjustment, -4);
  assert.equal(strong.caution, true);
  assert.match(strong.summary, /近期技术分75\+样本25条，平均累计-2\.62%，胜率31\.4%，同批次中位数相对领先3\.49%/);
});

test('跨多个版本的近期信号优先于长期旧样本', () => {
  const recent = {count:7, cohortCount:3, averageReturn:-3.65, medianReturn:-2.23, winRate:28.6, averageExcessReturn:-1.98, medianExcessReturn:-1.55, outperformRate:42.9};
  const historical = {count:17, cohortCount:8, averageReturn:-5.41, medianReturn:-2.23, winRate:23.5, averageExcessReturn:-.16, medianExcessReturn:.03, outperformRate:52.9};
  const result = calibrateRecommendationWithOutcomes({signal:'震荡洗盘', signalScore:78, technicalScore:82}, {
    sampleSize:100,
    byRecentSignal:{'震荡洗盘':recent}, bySignal:{'震荡洗盘':historical},
    byRecentFamily:{}, byFamily:{}, byRecentScoreBand:{}, byScoreBand:{},
    byRecentTechnicalScoreBand:{}, byTechnicalScoreBand:{}, marketRisk:{status:'drawdown'}
  });
  assert.equal(result.recent, true);
  assert.equal(result.familyAdjustment, -4);
  assert.match(result.summary, /震荡洗盘近期同类样本7条/);
});

test('本地累计收益反馈降低弱突破优先级并提高有效反弹优先级', () => {
  const profile = {
    sampleSize:88,
    byRecentSignal:{
      '待突破':{count:16, averageReturn:-4.46, medianReturn:-4.86, winRate:12.5, averageExcessReturn:-.66, medianExcessReturn:-.98, outperformRate:37.5},
      '已反弹':{count:15, averageReturn:1.39, medianReturn:1.58, winRate:67.5, averageExcessReturn:2.1, medianExcessReturn:1.4, outperformRate:66.7}
    },
    byRecentScoreBand:{
      '55-64':{count:8, averageReturn:-3.38, medianReturn:-4.49, winRate:25, averageExcessReturn:-2.53, medianExcessReturn:-2.03, outperformRate:14.3},
      '75+':{count:45, averageReturn:1.02, medianReturn:.18, winRate:51.1, averageExcessReturn:.4, medianExcessReturn:.18, outperformRate:51.1}
    },
    byFamily:{}, bySignal:{}, byScoreBand:{}, marketRisk:{status:'normal'}
  };
  const breakout = calibrateRecommendationWithOutcomes({ signal:'待突破', signalScore:62, technicalScore:48 }, profile);
  const rebound = calibrateRecommendationWithOutcomes({ signal:'已反弹', signalScore:78, technicalScore:66 }, profile);
  assert.equal(breakout.adjustment, -10);
  assert.equal(breakout.caution, true);
  assert.match(breakout.summary, /待突破近期同类样本16条.*同批次中位数相对落后0\.66%/);
  assert.equal(rebound.adjustment, 5);
  assert.equal(rebound.caution, false);
  assert.match(rebound.summary, /已反弹近期同类样本15条.*同批次中位数相对领先2\.10%/);
});

test('系统性下跌时实际累计亏损和低胜率仍优先触发风控', () => {
  const stats = {count:12, averageReturn:-5, medianReturn:-4, winRate:0, averageExcessReturn:2.4, medianExcessReturn:1.2, outperformRate:66.7};
  const result = calibrateRecommendationWithOutcomes({signal:'已反弹', signalScore:78}, {
    sampleSize:12, byRecentSignal:{'已反弹':stats}, byRecentScoreBand:{},
    bySignal:{}, byFamily:{}, byScoreBand:{}, marketRisk:{status:'normal'}
  });
  assert.equal(result.adjustment, -6);
  assert.equal(result.caution, true);
  assert.match(result.summary, /平均累计-5\.00%.*同批次中位数相对领先2\.40%/);
});

test('推荐只保留65分以上且结构明确的高技术分候选', () => {
  assert.equal(recommendationPassesOutcomeGate({signal:'突破确认', signalScore:80}), false);
  assert.equal(recommendationPassesOutcomeGate({signal:'突破确认', technicalScore:80}), false);
  assert.equal(recommendationPassesOutcomeGate({signal:'突破确认', signalScore:59, technicalScore:80}), false);
  assert.equal(recommendationPassesOutcomeGate({signal:'突破确认', signalScore:80, technicalScore:64}), false);
  assert.equal(recommendationPassesOutcomeGate({signal:'突破确认', signalScore:65, technicalScore:65}), true);
  assert.equal(recommendationPassesOutcomeGate({signal:'底部吸筹', signalScore:68, technicalScore:75}), true);
  assert.equal(recommendationPassesOutcomeGate({signal:'待突破', signalScore:82, technicalScore:85}), false);
  assert.equal(recommendationPassesOutcomeGate({signal:'已反弹', signalScore:82, technicalScore:85}), false);
});

test('高技术分明确形态可承受大盘和美股风险扣分，但普通待突破仍被排除', () => {
  assert.deepEqual(
    recommendationGateDecision({signal:'接近突破', signalScore:60, technicalScore:75}),
    {passed:true, reason:'high-technical-confirmation'}
  );
  assert.equal(recommendationPassesOutcomeGate({signal:'接近突破', signalScore:60, technicalScore:75}), true);
  assert.equal(recommendationPassesOutcomeGate({signal:'接近突破', signalScore:60, technicalScore:74}), false);
  assert.equal(recommendationPassesOutcomeGate({signal:'待突破', signalScore:80, technicalScore:90}), false);
});

test('大盘推荐候选覆盖扩大到120只并保持行业分散', () => {
  const makeRows = (prefix, count) => Array.from({length:count}, (_, index) => ({
    code:`${prefix}${String(index).padStart(4, '0')}`,
    industry:`行业${index % 40}`
  }));
  const candidates = selectMarketRecommendationCandidates({
    breakoutScreened:makeRows('1', 160),
    consolidationScreened:makeRows('2', 160),
    reboundScreened:makeRows('3', 200)
  });
  assert.equal(candidates.length, 120);
  assert.ok(new Set(candidates.map(item => item.industry)).size >= 30);
  assert.ok(candidates.some(item => item.code.startsWith('1')));
  assert.ok(candidates.some(item => item.code.startsWith('2')));
  assert.ok(candidates.some(item => item.code.startsWith('3')));
});

test('板块轮动和强势候选优先进入历史精筛且仍保持去重', () => {
  const rotation = [{code:'000876',industry:'饲料',rotationProfiles:[{name:'猪肉概念'}]}];
  const momentum = [{code:'002714',industry:'养殖业',rotationProfiles:[{name:'生猪养殖'}]}];
  const candidates = selectMarketRecommendationCandidates({
    rotationScreened:rotation,
    momentumScreened:momentum,
    breakoutScreened:[...rotation, {code:'600001',industry:'电子'}],
    consolidationScreened:[], reboundScreened:[]
  }, 3);
  assert.deepEqual(candidates.map(item => item.code), ['000876','002714','600001']);
});

test('个股索赔新闻不能作为全市场消息风险，但仍参与对应公司分析', () => {
  const now = Date.parse('2026-09-11T01:52:00Z');
  const cases = [
    {title:'贵州百灵实控人被罚没3.11亿投资者索赔持续征集中',summary:'ST百灵002424收到证监会行政处罚事先告知书'},
    {title:'*ST卓然退市风险高悬投资者索赔刻不容缓',summary:'中国证监会立案调查'},
    {title:'虚增利润157ST南新收正式罚单受损股民索赔开启',summary:'收到证监会行政处罚决定书'},
    {title:'天力锂能遭立案受损股民索赔开启',summary:'公司及实控人被证监会立案调查'}
  ].map(row => ({...row,publishedAt:'2026-09-11T01:00:00Z'}));
  assert.ok(cases.every(row => !isMarketWideNews(row)));
  const market = summarizeNews(cases,'',{now,scope:'market'});
  assert.equal(market.available,false);
  assert.equal(market.signal,'中性');
  assert.equal(summarizeNews([cases[0]],'',{now,subject:'贵州百灵',code:'002424'}).signal,'偏谨慎');
  assert.equal(isMarketWideNews({title:'证监会对某公司实控人立案调查'}),false);
  assert.equal(isMarketWideNews({title:'某公司今日涨停，主力资金净流入'}),false);
  assert.equal(isMarketWideNews({title:'中国金茂前8个月累计签约销售金额741亿元',summary:'公司取得签约销售金额人民币73.98亿元'}),false);
  assert.equal(isMarketWideNews({title:'巴克莱一个风险平台据悉故障频出',summary:'在今年美联储利率决议前后，一些交易员担心陷入信息盲区'}),false);
});

test('大盘消息保留真实市场风险与监管政策，不因过滤个股新闻而丢弃', () => {
  for (const title of ['央行宣布降准政策','证监会发布退市制度新规','A股大盘下滑，市场风险加剧','美联储加息，人民币汇率下跌','全球债券遭抛售，美债收益率上升']) {
    assert.equal(isMarketWideNews({title}),true,title);
  }
  const now = Date.parse('2026-09-11T01:52:00Z');
  assert.equal(summarizeNews([{title:'A股大盘下滑，市场风险加剧',publishedAt:'2026-09-11T01:00:00Z'}],'',{now,scope:'market'}).signal,'偏谨慎');
});

test('合并候选通道后按行业轮流精筛，避免同一行业重复挤占预算', () => {
  const finance = Array.from({length:8}, (_, index) => ({code:`60000${index}`,industry:'证券'}));
  const other = [{code:'000001',industry:'电力'}, {code:'000002',industry:'物流'}, {code:'000003',industry:'饲料'}];
  const input = {breakoutScreened:[...finance,...other], consolidationScreened:finance, reboundScreened:finance};
  const candidates = selectMarketRecommendationCandidates(input, 6);
  assert.deepEqual(candidates.map(item => item.industry), ['证券','电力','物流','饲料','证券','证券']);
  assert.deepEqual(candidates.filter(item => item.industry === '证券').map(item => item.code), ['600000','600001','600002']);
  assert.equal(new Set(candidates.map(item => item.code)).size, 6);
  assert.equal(finance.length, 8);
  assert.equal(selectMarketRecommendationCandidates(input, 30).length, 7);
});

test('行业分散不能挤掉已经通过轮动和强势通道的优先候选', () => {
  const priority = Array.from({length:4}, (_, index) => ({code:`P${index}`,industry:'证券'}));
  const broad = Array.from({length:12}, (_, index) => ({code:`G${index}`,industry:`行业${index}`}));
  const result = selectMarketRecommendationCandidates({rotationScreened:priority.slice(0,2),momentumScreened:priority.slice(2),breakoutScreened:broad},8);
  assert.equal(result.filter(item => item.industry === '证券').length, 4);
  assert.equal(new Set(result.map(item => item.industry)).size, 5);
});

test('强势追踪单独成组并限制每个板块数量', () => {
  const items = [
    {code:'1',signalScore:90,momentumDecision:{passed:true,score:92,profile:{name:'猪肉概念'},entryAssessment:{status:'强势追踪，不追高'}}},
    {code:'2',signalScore:88,momentumDecision:{passed:true,score:90,profile:{name:'猪肉概念'},entryAssessment:{status:'强势追踪，等待首次回踩'}}},
    {code:'3',signalScore:86,momentumDecision:{passed:true,score:89,profile:{name:'猪肉概念'},entryAssessment:{status:'强势追踪，等待首次回踩'}}},
    {code:'4',signalScore:84,momentumDecision:{passed:true,score:87,profile:{name:'农业种植'},entryAssessment:{status:'强势追踪，等待首次回踩'}}}
  ];
  const result = finalizeMomentumRecommendations(items, 8, 2);
  assert.deepEqual(result.map(item => item.code), ['1','2','4']);
  assert.ok(result.every(item => item.signal === '强势追踪' && item.recommendationTier === '强势追踪'));
});

test('强势追踪在风险扣分后重新检查综合评分，不用低分候选凑数量', () => {
  const item = {code:'1',signalScore:70,momentumDecision:{passed:true,score:90,profile:{name:'电力'},entryAssessment:{status:'等待回踩'}}};
  const risky = evaluateRecommendationRisk(item, {status:'unknown',st:{status:'clear'},reduction:{status:'unknown'},unlock:{status:'unknown'}}).item;
  assert.equal(risky.signalScore,56);
  const rows = [risky, {...item,code:'2',signalScore:30}, {...item,code:'3',signalScore:60}, {...item,code:'4',signalScore:NaN}];
  assert.deepEqual(finalizeMomentumRecommendations(rows).map(row => row.code), ['3']);
});

test('严格推荐与全部合格观察候选完整输出且不生成买入结论', () => {
  const strict = {
    code:'600001', signal:'突破确认', signalScore:72, technicalScore:80,
    qualityScore:82, entryAssessment:{allowed:true, status:'突破确认'}, reason:'突破确认；量价确认。'
  };
  const watches = Array.from({length:8}, (_, index) => ({
    code:`6001${String(index).padStart(2, '0')}`,
    signal:'待突破', signalScore:72 - index, technicalScore:82 - index,
    qualityScore:82, newsLabel:'消息中性',
    analysis:{distanceToBreakout:2, volumeRatio:1.2},
    entryAssessment:{allowed:false, status:'等待确认', summary:'尚未形成有效突破。'},
    reason:'待突破；尚未形成有效突破。'
  }));
  assert.equal(recommendationPassesWatchGate(watches[0]), true);
  assert.equal(recommendationPassesWatchGate({...watches[0], signalScore:50}, true), true);
  assert.equal(recommendationPassesWatchGate({...watches[0], signalScore:49}, true), false);
  assert.equal(recommendationPassesWatchGate({...watches[0], technicalScore:74}), false);
  assert.equal(recommendationPassesWatchGate({...watches[0], newsLabel:'消息谨慎'}), false);
  const displayed = finalizeRecommendationDisplay([strict], watches);
  assert.equal(displayed.length, 9);
  assert.equal(displayed[0].recommendationTier, '严格推荐');
  assert.ok(displayed.slice(1).every(item => item.recommendationTier === '观察候选'));
  assert.ok(displayed.slice(1).every(item => item.signal === '横盘观察'));
  assert.ok(displayed.slice(1).every(item => item.entryAssessment.allowed === false));
  assert.ok(displayed.every(recommendationPassesDisplayGate));
  assert.equal(recommendationPassesWatchGate({...watches[0], qualityScore:72}), true);
  assert.equal(finalizeRecommendationDisplay([strict, strict], [strict, ...watches, watches[0]]).length, 9);
});

test('收藏来源收益不参与公共推荐校准',()=>{
  const row={code:'600001',label:'历史批次',favoriteBasePrice:10,price:8,favoriteAddedAt:'2026-08-01',signal:'待突破',outcomeOrigin:'favorite'};
  const profile=summarizeRecommendationOutcomes([row],{now:Date.parse('2026-09-08')});
  assert.equal(profile.sampleSize,0);
  assert.equal(profile.excludedCount,1);
});

test('历史绝对收益和胜率很差时即使相对市场占优也必须降分', () => {
  const adjustment = outcomeStatsAdjustment({
    count:24,
    averageReturn:-5.2,
    medianReturn:-4.8,
    winRate:20.8,
    averageExcessReturn:1.1,
    medianExcessReturn:.6,
    outperformRate:62.5
  }, 8);
  assert.ok(adjustment <= -4);
});

test('个股分析仅在当前确认不足时采用负向历史反馈降级', () => {
  const profile = {
    sampleSize:48,
    byRecentSignal:{'待突破':{count:16, averageReturn:-4.46, medianReturn:-4.86, winRate:12.5, averageExcessReturn:-.66, medianExcessReturn:-.98, outperformRate:37.5}},
    byRecentScoreBand:{}, byFamily:{}, bySignal:{}, byScoreBand:{},
    marketRisk:{status:'drawdown', count:50, averageReturn:-4.8, winRate:20}
  };
  const weak = applyOutcomeFeedbackAssessment({
    score:58, capitalAdjustedScore:54, verdict:'可关注',
    consolidationBreakout:{isConsolidating:true},
    capitalSetupAssessment:{scoreAdjustment:-4},
    entryAssessment:{allowed:true, status:'可分批入场', tone:'positive', summary:'价格刚突破。', evidence:[]},
    tradePlan:{enabled:true}
  }, profile);
  assert.equal(weak.entryAssessment.allowed, false);
  assert.equal(weak.entryAssessment.status, '历史样本偏弱，等待确认');
  assert.equal(weak.tradePlan.enabled, false);
  assert.match(weak.historicalOutcomeAssessment.summary, /同批次中位数相对落后0\.66%.*策略回撤/);

  const strong = applyOutcomeFeedbackAssessment({
    score:76, capitalAdjustedScore:82, verdict:'可关注',
    consolidationBreakout:{isConsolidating:true},
    capitalSetupAssessment:{scoreAdjustment:6},
    entryAssessment:{allowed:true, status:'可分批入场', tone:'positive', summary:'量价资金确认。', evidence:[]},
    tradePlan:{enabled:true}
  }, profile);
  assert.equal(strong.entryAssessment.allowed, true);
  assert.equal(strong.tradePlan.enabled, true);
  assert.match(strong.historicalOutcomeAssessment.summary, /当前技术与资金确认较强/);
});

test('低技术分历史表现显著偏弱时个股结论明确不建议入场', () => {
  const weakTechnical = {
    count:129, cohortCount:16, averageReturn:-8.22, medianReturn:-8.05, winRate:5.4,
    averageExcessReturn:-1.94, medianExcessReturn:-1.24, outperformRate:36.4
  };
  const result = applyOutcomeFeedbackAssessment({
    score:52, capitalAdjustedScore:58, verdict:'可关注',
    capitalSetupAssessment:{scoreAdjustment:2},
    entryAssessment:{allowed:false, status:'等待确认', tone:'warning', summary:'价格尚待确认。', evidence:[]},
    tradePlan:{enabled:true}
  }, {
    sampleSize:204,
    byRecentSignal:{}, bySignal:{}, byRecentFamily:{}, byFamily:{},
    byRecentScoreBand:{}, byScoreBand:{}, byRecentTechnicalScoreBand:{},
    byTechnicalScoreBand:{'<55':weakTechnical}, marketRisk:{status:'normal'}
  });
  assert.equal(result.entryAssessment.allowed, false);
  assert.equal(result.entryAssessment.status, '历史同类技术分偏弱，不建议入场');
  assert.equal(result.tradePlan.enabled, false);
  assert.match(result.historicalOutcomeAssessment.summary, /技术分<55样本129条，平均累计-8\.22%，胜率5\.4%/);
});

test('近期跌幅收窄不掩盖低技术分长期风险', () => {
  const recentWeak = {
    count:7, cohortCount:5, averageReturn:-.67, medianReturn:-2.27, winRate:14.3,
    averageExcessReturn:-1.81, medianExcessReturn:-3.83, outperformRate:14.3
  };
  const longWeak = {
    count:130, cohortCount:20, averageReturn:-6.25, medianReturn:-5.82, winRate:10,
    averageExcessReturn:-2.31, medianExcessReturn:-2.09, outperformRate:34.6
  };
  const result = applyOutcomeFeedbackAssessment({
    score:52, capitalAdjustedScore:58, verdict:'等待确认',
    capitalSetupAssessment:{scoreAdjustment:2},
    entryAssessment:{allowed:false, status:'等待确认', tone:'warning', summary:'价格尚待确认。', evidence:[]},
    tradePlan:{enabled:true}
  }, {
    sampleSize:244,
    byRecentSignal:{}, bySignal:{}, byRecentFamily:{}, byFamily:{},
    byRecentScoreBand:{}, byScoreBand:{}, byRecentTechnicalScoreBand:{'<55':recentWeak},
    byTechnicalScoreBand:{'<55':longWeak}, marketRisk:{status:'normal'}
  });
  assert.equal(result.entryAssessment.status, '历史同类技术分偏弱，不建议入场');
  assert.equal(result.tradePlan.enabled, false);
  assert.match(result.historicalOutcomeAssessment.summary, /近期技术分<55样本7条.*长期技术分<55样本130条/);
});

test('技术分55至64历史胜率不足时个股只做观察', () => {
  const weakMiddle = {
    count:32, cohortCount:15, averageReturn:.14, medianReturn:-1.3, winRate:40.6,
    averageExcessReturn:2.12, medianExcessReturn:1.2, outperformRate:65.6
  };
  const result = applyOutcomeFeedbackAssessment({
    score:61, capitalAdjustedScore:67, verdict:'可关注',
    capitalSetupAssessment:{scoreAdjustment:4},
    entryAssessment:{allowed:true, status:'可分批入场', tone:'positive', summary:'资金出现承接。', evidence:[]},
    tradePlan:{enabled:true}
  }, {
    sampleSize:247,
    byRecentSignal:{}, bySignal:{}, byRecentFamily:{}, byFamily:{},
    byRecentScoreBand:{}, byScoreBand:{}, byRecentTechnicalScoreBand:{},
    byTechnicalScoreBand:{'55-64':weakMiddle}, marketRisk:{status:'normal'}
  });
  assert.equal(result.entryAssessment.allowed, false);
  assert.equal(result.entryAssessment.status, '历史技术分未达到有效区间，等待确认');
  assert.equal(result.tradePlan.enabled, false);
  assert.equal(result.verdict, '等待确认');
  assert.match(result.historicalOutcomeAssessment.summary, /技术分55-64样本32条，平均累计\+0\.14%，胜率40\.6%/);
});

test('近期技术分65至74收益和胜率偏弱且资金未确认时个股降级等待', () => {
  const weakRecent = {
    count:7, cohortCount:3, averageReturn:-3.68, medianReturn:-3, winRate:14.3,
    averageExcessReturn:-1.39, medianExcessReturn:-1.8, outperformRate:28.6
  };
  const result = applyOutcomeFeedbackAssessment({
    score:70, capitalAdjustedScore:68, verdict:'可关注',
    capitalSetupAssessment:{scoreAdjustment:1},
    entryAssessment:{allowed:true, status:'可分批入场', tone:'positive', summary:'价格接近突破。', evidence:[]},
    tradePlan:{enabled:true}
  }, {
    sampleSize:284,
    byRecentSignal:{}, bySignal:{}, byRecentFamily:{}, byFamily:{},
    byRecentScoreBand:{}, byScoreBand:{}, byRecentTechnicalScoreBand:{'65-74':weakRecent},
    byTechnicalScoreBand:{}, marketRisk:{status:'normal'}
  });
  assert.equal(result.entryAssessment.allowed, false);
  assert.equal(result.entryAssessment.status, '近期同技术分胜率偏低，等待确认');
  assert.equal(result.tradePlan.enabled, false);
  assert.match(result.historicalOutcomeAssessment.summary, /近期技术分65-74样本7条，平均累计-3\.68%，胜率14\.3%/);
});

test('消息面和大盘环境会调整个股及大盘推荐入场结论', () => {
  const analysis = {
    entryAssessment: {
      allowed: true, status: '底部吸筹，可分批低吸', tone: 'positive',
      setupType: 'bottom-accumulation', summary: '量价与阶段资金已确认。', evidence: []
    }
  };
  const positive = applyEntryContextAssessment(analysis, {
    newsContext: { signal: '偏积极', items: [{ title: '订单增长' }] },
    riskProfile: { status: 'clear' },
    marketOverview: { breadth: { up: 3200, down: 1800 }, indices: [{ changePct: .8 }] }
  });
  assert.equal(positive.entryAssessment.allowed, true);
  assert.match(positive.entryAssessment.summary, /消息面偏积极.*大盘环境偏强/);

  const cautious = applyEntryContextAssessment(analysis, {
    newsContext: { signal: '偏谨慎', items: [{ title: '减持计划' }] },
    riskProfile: { status: 'clear' },
    marketOverview: { breadth: { up: 3000, down: 1800 }, indices: [{ changePct: .4 }] }
  });
  assert.equal(cautious.entryAssessment.allowed, false);
  assert.equal(cautious.entryAssessment.status, '消息风险待确认');

  const weakMarket = applyEntryContextAssessment(analysis, {
    newsContext: { signal: '中性', items: [] }, riskProfile: { status: 'clear' },
    marketOverview: { breadth: { up: 1200, down: 3500 }, indices: [{ changePct: -1.4 }] }
  });
  assert.equal(weakMarket.entryAssessment.allowed, false);
  assert.equal(weakMarket.entryAssessment.status, '大盘偏弱，等待确认');

  const weakUsTech = applyEntryContextAssessment(analysis, {
    newsContext: { signal:'中性', items:[] }, riskProfile:{status:'clear'},
    subject:{industry:'半导体'},
    marketOverview:{
      breadth:{up:3000,down:1800}, indices:[{changePct:.5}],
      overseas:{signal:'偏弱',severity:'high',summary:'美股三大指数平均下跌1.63%，纳斯达克下跌2.10%。'}
    }
  });
  assert.equal(weakUsTech.entryAssessment.allowed, false);
  assert.equal(weakUsTech.entryAssessment.status, '美股科技风险待确认');
  assert.match(weakUsTech.entryAssessment.summary, /纳斯达克/);

  const sectorOutflow = applyEntryContextAssessment(analysis, {
    newsContext:{signal:'中性',items:[]}, riskProfile:{status:'clear'},
    subject:{industry:'半导体'},
    marketOverview:{
      breadth:{up:2600,down:2200}, indices:[{changePct:.1}],
      sectors:[{name:'半导体',changePct:-2.6,upRatio:.18,rotationScore:24,rotationState:'资金退潮'}]
    }
  });
  assert.equal(sectorOutflow.entryAssessment.allowed, false);
  assert.equal(sectorOutflow.entryAssessment.status, '板块退潮，等待确认');
  assert.match(sectorOutflow.entryAssessment.summary, /半导体.*资金退潮/);

  const directSectorFlow = applyEntryContextAssessment(analysis, {
    newsContext:{signal:'中性',items:[]}, riskProfile:{status:'clear'},
    subject:{industry:'养殖业',rotationProfiles:[{name:'猪肉概念',changePct:5.92,upRatio:.9,rotationScore:91,rotationState:'资金升温',mainNetInflow:1555330704,mainNetPct:9.65,capitalRank:2,capitalEstimated:false}]},
    marketOverview:{breadth:{up:2600,down:2200},indices:[{changePct:.1}],sectors:[]}
  });
  assert.match(directSectorFlow.entryAssessment.summary, /猪肉概念.*主力净流入15\.55亿.*占比\+9\.65%.*资金排名2/);
});

test('低价高估值弱反弹股票不会进入大盘推荐', { timeout: 180000 }, async () => {
  const result = await handlers.get('fetch-market-overview')(null, true);
  assert.ok(!result.recommendations.some(stock => stock.code === '600157'));
  assert.ok(result.recommendations.every(stock => stock.qualityScore >= 65));
  assert.ok(result.recommendationCoverage.qualityRejected >= 0);
});

test('通用行业命令能生成手机产业链股票', { timeout: 90000 }, async () => {
  const result = await handlers.get('run-industry-workflow')(null, '搜索手机行业产业链股票');
  assert.equal(result.subject, '手机');
  assert.ok(result.stocks.length >= 10);
  assert.ok(result.stocks.every(stock => /^\d{6}$/.test(stock.code)));
  assert.ok(result.stocks.every(stock => !/ST|退/.test(stock.name)));
  assert.ok(result.stocks.every(stock => !['300033', '300059'].includes(stock.code)));
  assert.ok(result.boards.every(board => !/TOPCon|光伏|电池/.test(board.name)));
});

test('复合行业命令优先具体产业而不是宽泛AI概念', { timeout: 90000 }, async () => {
  const result = await handlers.get('run-industry-workflow')(null, '查找A股AI算力租赁');
  assert.ok(result.stocks.length >= 10);
  assert.ok(result.stocks.some(stock => /算力租赁|智算中心/.test(stock.sector)));
  assert.ok(result.stocks.every(stock => !['300033', '300059', '300498', '601166', '000001'].includes(stock.code)));
  assert.ok(result.terms.includes('算力租赁'));
  assert.ok(!result.terms.includes('人工智能'));
});

test('白酒和猪肉命令兼顾覆盖率并排除泛行业误匹配', { timeout: 120000 }, async () => {
  const whiteSpirit = await handlers.get('run-industry-workflow')(null, '查找白酒行业产业链');
  assert.ok(whiteSpirit.stocks.length >= 10);
  assert.ok(whiteSpirit.stocks.every(stock => !['603288', '600887', '600127'].includes(stock.code)));
  assert.deepEqual(whiteSpirit.terms, ['白酒', '喝酒', '酒类', '酿酒']);

  const pork = await handlers.get('run-industry-workflow')(null, '筛选猪肉行业相关股票');
  assert.ok(pork.stocks.length >= 10);
  assert.ok(pork.stocks.every(stock => !['300024', '000061'].includes(stock.code)));
});
