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
  normalizeQuoteRow,
  normalizeTencentQuote,
  mapSinaFinancialData,
  buildFinancialAnalysis,
  buildIndividualInvestmentAnalysis,
  splitDataCenterFinancialRows,
  buildCanslimFromFactors,
  buildRecommendationFactorContext,
  buildIndustryRotationFromQuotes,
  evaluateRecommendationFactors,
  assessRecommendationNewsConfirmation,
  parseTencentGlobalIndices,
  assessGlobalMarketContext,
  resolveRecommendationIndustry,
  recommendationIndustryGroupKey,
  groupRecommendationsByIndustry,
  recommendationSignalFamily,
  mergeRecommendationOutcomeQuotes,
  summarizeRecommendationOutcomes,
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
  analyzeHistory,
  buildTradePlan,
  mergeQuoteIntoHistory,
  aggregateHistoryPeriod,
  parseReductionPlanWindow,
  parseJin10FlashItems,
  classifyMarketNewsIssues,
  settleWithConcurrency
} = require('../main.js');
Module._load = originalLoad;

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
  const item = { code: '600001', score: 80, signalScore: 80, reason: '待突破。' };
  const unverified = evaluateRecommendationRisk(item, {
    status: 'unknown', summary: '限售解禁数据未确认',
    st: { status: 'clear' }, reduction: { status: 'clear' }, unlock: { status: 'unknown' },
    errors: ['限售解禁查询失败：read ECONNRESET']
  });
  assert.equal(unverified.status, 'unverified');
  assert.equal(unverified.item.signalScore, 72);
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

test('大盘分析返回指数、轮动、资金和涨跌停结构', { timeout: 60000 }, async () => {
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
  assert.match(result.source, /腾讯全市场行情/);
  assert.ok(result.recommendations.length > 0);
  assert.ok(result.recommendations.every(item => item.breakoutPrice > 0 && item.ma30 > 0));
  assert.ok(result.recommendations.every(item => [
    '底部待反弹', '已反弹', '待突破', '横盘观察', '突破蓄势', '接近突破', '突破确认', '底部吸筹', '震荡洗盘'
  ].includes(item.signal)));
  assert.ok(result.recommendations.every(item => ['消息确认', '消息中性', '消息谨慎'].includes(item.newsLabel)));
  assert.ok(result.recommendations.every(item => Number.isFinite(item.signalScore) && item.reason.includes(item.signal)));
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
  assert.match(strong.summary, /近期技术分75\+样本25条，平均累计-2\.62%，胜率31\.4%，同批次平均跑赢3\.49%/);
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
  assert.match(breakout.summary, /待突破近期同类样本16条.*同批次平均跑输0\.66%/);
  assert.equal(rebound.adjustment, 5);
  assert.equal(rebound.caution, false);
  assert.match(rebound.summary, /已反弹近期同类样本15条.*同批次平均跑赢2\.10%/);
});

test('系统性下跌时实际累计亏损和低胜率仍优先触发风控', () => {
  const stats = {count:12, averageReturn:-5, medianReturn:-4, winRate:0, averageExcessReturn:2.4, medianExcessReturn:1.2, outperformRate:66.7};
  const result = calibrateRecommendationWithOutcomes({signal:'已反弹', signalScore:78}, {
    sampleSize:12, byRecentSignal:{'已反弹':stats}, byRecentScoreBand:{},
    bySignal:{}, byFamily:{}, byScoreBand:{}, marketRisk:{status:'normal'}
  });
  assert.equal(result.adjustment, -6);
  assert.equal(result.caution, true);
  assert.match(result.summary, /平均累计-5\.00%.*同批次平均跑赢2\.40%/);
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

test('严格推荐不足时补足高质量横盘观察候选但不生成买入结论', () => {
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
  const displayed = finalizeRecommendationDisplay([strict], watches, 6);
  assert.equal(displayed.length, 6);
  assert.equal(displayed[0].recommendationTier, '严格推荐');
  assert.ok(displayed.slice(1).every(item => item.recommendationTier === '观察候选'));
  assert.ok(displayed.slice(1).every(item => item.signal === '横盘观察'));
  assert.ok(displayed.slice(1).every(item => item.entryAssessment.allowed === false));
  assert.ok(displayed.every(recommendationPassesDisplayGate));
  assert.equal(recommendationPassesWatchGate({...watches[0], qualityScore:72}), true);
  assert.equal(finalizeRecommendationDisplay([strict], watches).length, 8);
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
  assert.match(weak.historicalOutcomeAssessment.summary, /同批次平均跑输0\.66%.*策略回撤/);

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
});

test('低价高估值弱反弹股票不会进入大盘推荐', { timeout: 60000 }, async () => {
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
