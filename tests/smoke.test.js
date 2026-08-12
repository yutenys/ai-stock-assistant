const test = require('node:test');
const assert = require('node:assert/strict');
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

require('../main.js');
Module._load = originalLoad;

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

test('近三个月行情返回技术分析和观察窗口', { timeout: 30000 }, async () => {
  const handler = handlers.get('fetch-stock-history');
  assert.equal(typeof handler, 'function');
  const result = await handler(null, { code: '603567', name: '珍宝岛' });
  assert.ok(result.history.length >= 50);
  assert.ok(result.analysis.ma20 > 0);
  assert.ok(result.analysis.ma30 > 0);
  assert.ok(result.analysis.ma60 > 0);
  assert.match(result.analysis.summary, /MA30/);
  assert.match(result.analysis.entry, /入场|等待|观察/);
  assert.match(result.analysis.exit, /离场|止损|止盈|风控/);
  assert.match(result.analysis.entryWindow, /交易日/);
  assert.match(result.analysis.verdict, /可关注|等待确认|暂不适合|不宜追高/);
  assert.equal(typeof result.analysis.score, 'number');
  assert.equal(typeof result.analysis.volumeRatio, 'number');
  assert.ok(result.analysis.breakoutPrice > 0);
  assert.ok(result.analysis.supportPrice > 0);
  assert.ok(result.analysis.latestTradeDate);
  assert.ok(result.analysis.analyzedAt);
  assert.ok(result.newsContext);
  const stop = Number((result.analysis.exit.match(/有效跌破([\d.]+)元/) || [])[1]);
  assert.ok(stop >= result.analysis.ma20 * 0.95 && stop < result.history.at(-1).close);
});

test('个股走势返回分时五日日周月五种周期', { timeout: 60000 }, async () => {
  const handler = handlers.get('fetch-stock-chart');
  assert.equal(typeof handler, 'function');
  for (const period of ['minute', 'five-day', 'day', 'week', 'month']) {
    const result = await handler(null, { code: '600519', period });
    assert.equal(result.period, period);
    assert.ok(result.rows.length >= 20, `${period} 数据不足`);
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

test('大盘分析返回指数、轮动、资金和涨跌停结构', { timeout: 30000 }, async () => {
  const handler = handlers.get('fetch-market-overview');
  assert.equal(typeof handler, 'function');
  const result = await handler(null, true);
  assert.ok(result.indices.length >= 3);
  assert.ok(result.indices.every(index => index.price > 0));
  assert.equal(typeof result.turnover, 'number');
  assert.ok(result.breadth.up + result.breadth.down + result.breadth.flat > 4500);
  assert.ok(result.sectors.length >= 8);
  assert.ok(result.fundSectors.length >= 8);
  assert.equal(typeof result.limits.upCount, 'number');
  assert.equal(typeof result.limits.downCount, 'number');
  assert.match(result.limits.date, /^\d{8}$/);
  assert.match(result.source, /腾讯全市场行情/);
  assert.ok(result.recommendations.length > 0);
  assert.ok(result.recommendations.every(item => item.breakoutPrice > 0 && item.ma30 > 0 && /MA30/.test(item.reason)));
  assert.ok(result.recommendationCoverage.scanned > 1000);
  assert.ok(result.recommendationCoverage.analyzed > 24);
  assert.ok(result.newsContext?.summary);
  assert.ok(Array.isArray(result.newsContext?.items));
  assert.ok(result.analysis);
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
