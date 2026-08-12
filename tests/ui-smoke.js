const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  ipcMain.handle('append-operation-log', async () => true);
  ipcMain.handle('run-industry-workflow', async () => ({
    subject: '中药',
    stocks: [{ code: '603567', name: '珍宝岛', sector: '线上搜索', type: '待观察', status: '已突破', focus: '搜索添加', reason: '测试数据', news: '等待刷新' }],
    errors: []
  }));
  ipcMain.handle('fetch-a-share-quotes', async () => ({
    quotes: [{ code: '603567', name: '珍宝岛', price: 11.08, change: -0.08, changePct: -0.72, open: 11.16, high: 11.25, low: 11.02, prevClose: 11.16, amount: 389000000, mainNetInflow: 1666200, mainNetPct: 0.43, floatMarketCap: 6454000000, totalMarketCap: 9432000000, source: '腾讯实时行情 + 东方财富资金', fetchedAt: '2026-08-12T03:17:18.000Z' }],
    errors: [], warnings: [], requested: 1, updated: 1, cached: 0, failed: 0
  }));
  ipcMain.handle('fetch-stock-fund-flow', async () => ({
    mainInflow: 32662000,
    mainOutflow: 30995800,
    mainNetInflow: 1666200,
    mainNetPct: 0.43,
    source: '腾讯逐笔成交汇总估算（主力口径≥20万元）',
    tradeDate: '2026-08-12',
    estimated: true,
    errors: []
  }));
  ipcMain.handle('fetch-company-profile', async () => ({
    profile: { industry: '中药', business: '中药材种植、中成药研发生产与销售。', products: '中成药；中药材', summary: '公司主营中药制剂，业务覆盖研发、生产和销售。', source: '公司资料接口' },
    errors: []
  }));
  ipcMain.handle('fetch-stock-news', async () => ({
    news: [
      { title: '较早资讯', link: 'https://example.com/old', publishedAt: '2026-08-10 09:00:00', source: '测试资讯' },
      { title: '最新资讯', link: 'https://example.com/new', publishedAt: '2026-08-12 10:00:00', source: '测试资讯' },
      { title: '次新资讯', link: 'https://example.com/middle', publishedAt: '2026-08-11 10:00:00', source: '测试资讯' }
    ],
    errors: []
  }));
  ipcMain.handle('fetch-stock-history', async (_event, request) => ({
    history: Array.from({ length: 66 }, (_, index) => ({ date: `2026-06-${String(index + 1).padStart(2, '0')}`, close: 6 + index * 0.01 })),
    analysis: {
      summary: '近3个月累计上涨18.42%，当前处于震荡上行阶段。',
      ma5: 6.92, ma10: 6.81, ma20: 6.55, ma30: 6.42, ma60: 6.18, rsi14: 61.3,
      return5: 3.18, return20: 9.26, return60: 18.42,
      macdDif: 0.18, macdDea: 0.12, macdHistogram: 0.12,
      bollUpper: 7.52, bollMiddle: 6.55, bollLower: 5.58,
      rangeLow: 4.21, rangeHigh: 8.00,
      volume: '近5日平均成交量高于20日均量，量能偏活跃。',
      volumeRatio: 1.43, volume5Ratio: 1.31,
      breakoutPrice: 7.40, supportPrice: 6.20, distanceToBreakout: 2.10,
      score: request?.force ? 82 : 76, verdict: '等待确认', risk: '波动率偏高，ATR14为0.26元。',
      maAlignment: 'MA5/10/20/30/60多头排列',
      buyCondition: '等待放量突破7.40元且收盘站稳，当前不宜无条件追价。',
      newsImpact: '消息面偏积极，但需等待量价确认。',
      combinedConclusion: '等待确认（技术评分76/100）。等待放量突破7.40元且收盘站稳。消息面偏积极，但需等待量价确认。',
      entry: '未来3-5个交易日回踩MA10后企稳，或放量突破7.40元再确认。',
      exit: '收盘连续2日跌破MA20，或跌破6.20元止损；接近8.00元留意止盈。',
      entryWindow: '未来3-10个交易日，条件未触发则继续等待。',
      exitWindow: '入场后1-4周持续观察，价格条件优先于日期。',
      source: '腾讯前复权日线'
    },
    errors: []
  }));
  ipcMain.handle('fetch-stock-chart', async (_event, request) => ({
    period: request.period,
    rows: Array.from({ length: 80 }, (_, index) => {
      const close = 6.2 + index * 0.012 + Math.sin(index / 5) * 0.08;
      return {
        time: request.period === 'minute' || request.period === 'five-day'
          ? `202608${String(8 + Math.floor(index / 16)).padStart(2, '0')}${String(930 + index).padStart(4, '0')}`
          : `2026-${String(4 + Math.floor(index / 28)).padStart(2, '0')}-${String(index % 28 + 1).padStart(2, '0')}`,
        open: close - 0.025,
        close,
        high: close + 0.06,
        low: close - 0.07,
        volume: 1200000 + index * 16000
      };
    }),
    previousClose: 6.18,
    source: `测试${request.period}行情`,
    errors: []
  }));
  ipcMain.handle('fetch-market-overview', async () => ({
    indices: [
      { code: '000001', name: '上证指数', price: 3936.83, changePct: 0.07 },
      { code: '399001', name: '深证成指', price: 14359.57, changePct: 0.70 },
      { code: '399006', name: '创业板指', price: 3587.06, changePct: 1.07 }
    ],
    breadth: { up: 3210, down: 1780, flat: 126 },
    turnover: 1146711000000,
    sectors: [{ name: '中药', changePct: 2.31, mainNet: 1860000000, leader: '珍宝岛' }],
    fundSectors: [{ name: '半导体', changePct: 1.82, mainNet: 3260000000, leader: '中芯国际' }],
    limits: { upCount: 68, downCount: 7, upStocks: [{ code: '603567', name: '珍宝岛', industry: '中药' }], downStocks: [] },
    recommendations: [{ code: '603567', name: '珍宝岛', verdict: '等待确认', score: 76, breakoutPrice: 7.40, supportPrice: 6.20, ma30: 6.42, reason: '距20日突破位较近，现价站上MA30（6.42元），量能改善，等待放量确认。', newsContext: { summary: '最新消息偏积极。' } }],
    recommendationCoverage: { scanned: 5230, prefiltered: 428, analyzed: 60, industries: 42, directoryAvailable: true },
    newsContext: { signal: '偏积极', summary: '政策与行业消息偏积极，仍需结合盘面确认。', items: [{ title: '中药行业最新政策消息', link: 'https://example.com/market-news', publishedAt: '2026-08-12 11:00:00', source: '测试资讯' }] },
    analysis: '三大指数多数上涨，市场情绪偏强；资金集中于半导体、中药。',
    source: '腾讯指数 + 东方财富市场统计',
    fetchedAt: '2026-08-12T05:30:00.000Z',
    errors: []
  }));
  const errors = [];
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !message.includes('No handler registered')) errors.push(message);
  });
  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await win.webContents.executeJavaScript(`localStorage.clear(); location.reload()`);
  await new Promise(resolve => setTimeout(resolve, 50));
  await win.webContents.executeJavaScript(`document.getElementById('generateBtn').click()`);
  await new Promise(resolve => setTimeout(resolve, 50));
  await win.webContents.executeJavaScript(`
    document.getElementById('openAddPanel').click();
    document.getElementById('modalSelectAll').click();
    document.getElementById('tagName').value = '半导体';
    document.getElementById('confirmAdd').focus();
    document.getElementById('confirmAdd').click();
  `);
  const focusAfterAdd = await win.webContents.executeJavaScript(`document.activeElement?.id || ''`);
  const multiLabelState = await win.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-edit-stock-labels="603567"]').click();
    document.getElementById('newStockLabelName').value = '医疗';
    document.getElementById('saveStockLabels').click();
    return [...document.querySelectorAll('[data-active-label]')].map(button => button.innerText.trim());
  })()`);
  await win.webContents.executeJavaScript(`document.querySelector('[data-detail-code="603567"]').click()`);
  await new Promise(resolve => setTimeout(resolve, 100));
  const chartState = await win.webContents.executeJavaScript(`(async () => {
    const periods = ['minute', 'five-day', 'day', 'week', 'month'];
    const rendered = [];
    const features = [];
    for (const period of periods) {
      document.querySelector('[data-chart-period="' + period + '"]').click();
      for (let index = 0; index < 20; index += 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
        if (document.querySelector('[data-chart-for="603567"]')?.dataset.rendered === 'true') break;
      }
      rendered.push(document.querySelector('[data-chart-for="603567"]')?.dataset.rendered === 'true');
      const currentCanvas = document.querySelector('[data-chart-for="603567"]');
      features.push({ period, averageLine:currentCanvas?.dataset.hasAverageLine, zeroLine:currentCanvas?.dataset.hasZeroLine, meta:document.querySelector('[data-chart-meta="603567"]')?.textContent || '', legend:document.querySelector('[data-chart-legend="603567"]')?.textContent || '' });
    }
    const canvas = document.querySelector('[data-chart-for="603567"]');
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let nonBlank = false;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] > 0) { nonBlank = true; break; }
    }
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, pointerId:1, pointerType:'mouse', clientX:rect.left + rect.width * .35, clientY:rect.top + rect.height * .45 }));
    const firstIndex = canvas.dataset.selectedIndex;
    canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles:true, pointerId:1, pointerType:'mouse', clientX:rect.left + rect.width * .72, clientY:rect.top + rect.height * .45 }));
    const interaction = {
      locked: canvas.dataset.locked,
      firstIndex,
      selectedIndex: canvas.dataset.selectedIndex,
      selectedDate: canvas.dataset.selectedDate,
      selectedClose: canvas.dataset.selectedClose,
      selectedChangePct: canvas.dataset.selectedChangePct,
      title: canvas.title
    };
    return { rendered, nonBlank, features, interaction, tabs: [...document.querySelectorAll('[data-chart-period]')].map(button => button.textContent.trim()) };
  })()`);
  const detailState = await win.webContents.executeJavaScript(`({
    text: document.getElementById('detailPanel').innerText,
    labelText: document.getElementById('labelStocks').innerText,
    newsTitles: [...document.querySelectorAll('[data-news-for="603567"] .news-row b')].map(node => node.textContent)
  })`);
  await win.webContents.executeJavaScript(`
    window.scrollTo(0, document.body.scrollHeight);
    [...document.querySelectorAll('[data-detail-add-label="603567"]')].at(-1).click();
  `);
  await new Promise(resolve => setTimeout(resolve, 20));
  const labelModalState = await win.webContents.executeJavaScript(`({
    position: getComputedStyle(document.getElementById('stockLabelPanel')).position,
    visible: !document.getElementById('stockLabelPanel').classList.contains('hidden'),
    focused: document.activeElement?.dataset?.stockLabelName || document.activeElement?.id || '',
    columns: getComputedStyle(document.getElementById('stockLabelChoices')).gridTemplateColumns
  })`);
  await win.webContents.executeJavaScript(`document.getElementById('closeStockLabelPanel').click()`);
  await win.webContents.executeJavaScript(`document.getElementById('refreshLabel').click()`);
  await new Promise(resolve => setTimeout(resolve, 100));
  const refreshedLabelText = await win.webContents.executeJavaScript(`document.getElementById('labelStocks').innerText`);
  const refreshedLabelMetrics = await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('#labelStocks .label-stock-card');
    const score = card?.querySelector('.compact-score b');
    const states = [...(card?.querySelectorAll('.compact-state') || [])];
    return {
      height: card?.getBoundingClientRect().height || 0,
      text: card?.innerText || '',
      stateTexts: states.map(node => node.textContent.trim()),
      stateClasses: states.map(node => node.className),
      scoreBeforeStates: Boolean(score) && states.every(node => Boolean(score.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING))
    };
  })()`);
  const contextMenuState = await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('#labelStocks [data-detail-code="603567"]');
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 180 }));
    const menu = document.getElementById('labelStockMenu');
    const visible = !menu.classList.contains('hidden');
    const actions = menu.innerText;
    document.getElementById('pinLabelStock').click();
    const pinnedCard = document.querySelector('#labelStocks .pinned-stock-card');
    return { visible, actions, pinnedText: document.getElementById('labelStocks').innerText, pinnedBackground:getComputedStyle(pinnedCard).backgroundColor, pinnedBorder:getComputedStyle(pinnedCard).borderLeftColor };
  })()`);
  const contextDeleteState = await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('#labelStocks [data-detail-code="603567"]');
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 180 }));
    document.getElementById('removeLabelStock').click();
    return document.getElementById('labelStocks').innerText;
  })()`);
  await win.webContents.executeJavaScript(`
    window.confirm = () => { throw new Error('删除标签不应调用原生 confirm'); };
    document.querySelector('[data-delete-label="半导体"]').click();
    document.querySelector('[data-delete-label="半导体"]').click();
  `);
  await new Promise(resolve => setTimeout(resolve, 20));
  const focusAfterDelete = await win.webContents.executeJavaScript(`document.activeElement?.id || ''`);
  const tableScoreState = await win.webContents.executeJavaScript(`(() => {
    document.getElementById('tableView').click();
    return document.getElementById('stockContainer').innerText;
  })()`);
  const simulationState = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-sim-price="603567"]').value = '10';
    document.querySelector('[data-sim-amount="603567"]').value = '10000';
    document.querySelector('[data-sim-trade="buy"]').click();
    await new Promise(resolve => setTimeout(resolve, 20));
    document.getElementById('simulationView').click();
    await new Promise(resolve => setTimeout(resolve, 80));
    const afterBuy = document.getElementById('stockContainer').innerText;
    document.querySelector('[data-portfolio-code="603567"]').click();
    await new Promise(resolve => setTimeout(resolve, 20));
    document.querySelector('[data-sim-price="603567"]').value = '12';
    document.querySelector('[data-sim-amount="603567"]').value = '6000';
    document.querySelector('[data-sim-trade="sell"]').click();
    await new Promise(resolve => setTimeout(resolve, 20));
    document.getElementById('simulationView').click();
    await new Promise(resolve => setTimeout(resolve, 80));
    const saved = JSON.parse(localStorage.getItem('ai-stock-assistant-state-v1') || '{}');
    return {
      afterBuy,
      afterSell:document.getElementById('stockContainer').innerText,
      active:document.getElementById('simulationView').classList.contains('active'),
      position:saved.portfolio?.find(item => item.code === '603567'),
      tradeCount:saved.simulatedTrades?.filter(item => item.code === '603567').length || 0
    };
  })()`);
  async function clickAndType(id, value) {
    const point = await win.webContents.executeJavaScript(`(() => {
      const input = document.getElementById('${id}');
      input.scrollIntoView({ block: 'center' });
      input.value = '';
      const rect = input.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    for (const char of value) win.webContents.sendInputEvent({ type: 'char', keyCode: char });
    return win.webContents.executeJavaScript(`({ active: document.activeElement?.id, value: document.getElementById('${id}').value })`);
  }
  const typed = {
    commandInput: await clickAndType('commandInput', 'abc'),
    searchInput: await clickAndType('searchInput', 'xyz')
  };
  const state = await win.webContents.executeJavaScript(`({
    title: document.title,
    heading: document.querySelector('h1')?.textContent,
    hasApi: Boolean(window.stockApi?.fetchQuotes),
    stockContainer: Boolean(document.getElementById('stockContainer')),
    statusFixed: getComputedStyle(document.getElementById('statusNotice')).position,
    inputStates: Object.fromEntries(['commandInput', 'searchInput', 'tagName', 'newStockLabelName'].map(id => {
      const input = document.getElementById(id);
      input.focus();
      return [id, {
        focused: document.activeElement === input,
        disabled: input.disabled,
        readOnly: input.readOnly,
        pointerEvents: getComputedStyle(input).pointerEvents,
        hidden: input.closest('.hidden')?.id || ''
      }];
    })),
    typed: ${JSON.stringify(typed)},
    focusAfterAdd: ${JSON.stringify(focusAfterAdd)},
    multiLabelState: ${JSON.stringify(multiLabelState)},
    focusAfterDelete: ${JSON.stringify(focusAfterDelete)},
    detailState: ${JSON.stringify(detailState)},
    chartState: ${JSON.stringify(chartState)},
    labelModalState: ${JSON.stringify(labelModalState)},
    refreshedLabelText: ${JSON.stringify(refreshedLabelText)},
    refreshedLabelMetrics: ${JSON.stringify(refreshedLabelMetrics)},
    contextMenuState: ${JSON.stringify(contextMenuState)},
    contextDeleteState: ${JSON.stringify(contextDeleteState)},
    tableScoreState: ${JSON.stringify(tableScoreState)},
    simulationState: ${JSON.stringify(simulationState)},
    marketText: document.getElementById('marketPanel')?.innerText || ''
  })`);
  const inputsUsable = state.typed.commandInput.active === 'commandInput'
    && state.typed.commandInput.value === 'abc'
    && state.typed.searchInput.active === 'searchInput'
    && state.typed.searchInput.value === 'xyz';
  const multiLabelUsable = state.multiLabelState.some(text => /半导体\s+1只/.test(text))
    && state.multiLabelState.some(text => /医疗\s+1只/.test(text));
  const detailUsable = state.detailState.text.includes('所属行业：中药')
    && state.detailState.text.includes('净流入166.62万')
    && state.detailState.text.includes('主力流入3266.20万')
    && state.detailState.text.includes('流出3099.58万')
    && state.detailState.text.includes('腾讯逐笔成交汇总估算')
    && state.detailState.text.includes('近3个月累计上涨18.42%')
    && state.detailState.text.includes('未来3-10个交易日')
    && state.detailState.text.includes('离场 / 风控')
    && state.detailState.text.includes('是否适合购买')
    && state.detailState.text.includes('当前放量')
    && state.detailState.text.includes('MA30 ¥6.42')
    && state.detailState.labelText.includes('评分 82')
    && !/当前归属|定位为待观察|状态为待刷新|行业 \/ 分类：线上搜索/.test(state.detailState.text)
    && JSON.stringify(state.detailState.newsTitles) === JSON.stringify(['最新资讯', '次新资讯', '较早资讯']);
  const marketUsable = /上证指数|深证成指|创业板指/.test(state.marketText)
    && /板块轮动|半导体|资金|涨停 68|跌停 7|即将突破观察|MA30 ¥6.42|消息面偏积极/.test(state.marketText);
  const chartUsable = state.chartState.nonBlank
    && state.chartState.rendered.every(Boolean)
    && state.chartState.interaction.locked === 'true'
    && state.chartState.interaction.firstIndex !== state.chartState.interaction.selectedIndex
    && /^2026-\d{2}-\d{2}/.test(state.chartState.interaction.selectedDate)
    && Number.isFinite(Number(state.chartState.interaction.selectedChangePct))
    && /开 [\d.]+ 高 [\d.]+ 低 [\d.]+ 收 [\d.]+ 涨跌幅 [+-]?[\d.]+% 成交量/.test(state.chartState.interaction.title)
    && state.chartState.features[0]?.averageLine === 'true'
    && state.chartState.features[0]?.zeroLine === 'true'
    && /价格[\s\S]*成交均价[\s\S]*昨收 \/ 0%线/.test(state.chartState.features[0]?.legend || '')
    && state.chartState.features.slice(2).every(item => /上涨K线[\s\S]*下跌K线[\s\S]*MA5 短线[\s\S]*MA30 中期趋势[\s\S]*MA60 中长期趋势/.test(item.legend))
    && state.chartState.features.slice(1).every(item => /收盘 ¥[\d.]+ · 涨跌 [+-]?[\d.]+%/.test(item.meta))
    && JSON.stringify(state.chartState.tabs) === JSON.stringify(['分时', '五日', '日K', '周K', '月K']);
  const simulationUsable = state.simulationState.active
    && /1000股[\s\S]*¥11.08 \/ ¥10.00[\s\S]*1080[\s\S]*\+10.80%/.test(state.simulationState.afterBuy)
    && /500股[\s\S]*¥11.08 \/ ¥10.00[\s\S]*540[\s\S]*\+10.80%[\s\S]*1000[\s\S]*1540/.test(state.simulationState.afterSell)
    && state.simulationState.position?.quantity === 500
    && state.simulationState.position?.costPrice === 10
    && state.simulationState.position?.realizedPnl === 1000
    && state.simulationState.tradeCount === 2;
  const labelModalUsable = state.labelModalState.position === 'fixed'
    && state.labelModalState.visible
    && Boolean(state.labelModalState.focused)
    && Boolean(state.labelModalState.columns);
  const labelListUsable = state.refreshedLabelText.includes('评分 82')
    && !state.refreshedLabelMetrics.text.includes('线上搜索')
    && state.refreshedLabelMetrics.height > 0 && state.refreshedLabelMetrics.height < 90
    && state.refreshedLabelMetrics.stateTexts.length === 3
    && state.refreshedLabelMetrics.stateClasses.every(value => /b-(red|amber|green|blue|purple)/.test(value))
    && state.refreshedLabelMetrics.scoreBeforeStates
    && state.contextMenuState.visible
    && /置顶|从当前标签删除/.test(state.contextMenuState.actions)
    && state.contextMenuState.pinnedText.includes('置顶')
    && state.contextMenuState.pinnedBackground === 'rgb(239, 246, 255)'
    && state.contextMenuState.pinnedBorder === 'rgb(37, 99, 235)'
    && state.contextDeleteState.includes('暂无股票')
    && /评分[\s\S]*82/.test(state.tableScoreState)
    && state.tableScoreState.includes('突破后运行')
    && !state.tableScoreState.includes('已突破');
  if (state.title !== 'AI股票观察助手' || state.heading !== state.title || !state.hasApi || !state.stockContainer || state.statusFixed !== 'fixed' || state.focusAfterAdd !== 'searchInput' || state.focusAfterDelete !== 'searchInput' || !inputsUsable || !multiLabelUsable || !detailUsable || !marketUsable || !chartUsable || !simulationUsable || !labelModalUsable || !labelListUsable || errors.length) {
    console.error(JSON.stringify({ state, checks: { inputsUsable, multiLabelUsable, detailUsable, marketUsable, chartUsable, simulationUsable, labelModalUsable, labelListUsable }, errors }, null, 2));
    app.exit(1);
    return;
  }
  console.log(JSON.stringify({ state, errors }, null, 2));
  app.exit(0);
});
