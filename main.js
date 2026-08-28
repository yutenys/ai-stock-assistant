const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { TextDecoder } = require('util');

const quoteCache = new Map();
const companyProfileCache = new Map();
const stockNewsCache = new Map();
const stockHistoryCache = new Map();
const stockFinancialCache = new Map();
const stockChartCache = new Map();
const stockFundFlowCache = new Map();
const stockFundFlowHistoryCache = new Map();
const stockRiskCache = new Map();
const marketNewsCache = new Map();
const marketHistoryCache = new Map();
let marketOverviewCache = null;
let stockDirectoryCache = null;
let stockDirectoryFetchedAt = 0;
let boardDirectoryCache = null;
let boardDirectoryFetchedAt = 0;
let marketDirectorySavedAt = 0;
const CONTROLLED_VOLUME_MIN = 1.5;
const CONTROLLED_VOLUME_MAX = 4;

function isControlledVolumeExpansion(value) {
  const ratio = Number(value);
  return Number.isFinite(ratio) && ratio >= CONTROLLED_VOLUME_MIN && ratio <= CONTROLLED_VOLUME_MAX;
}

function isExplosiveVolume(value) {
  const ratio = Number(value);
  return Number.isFinite(ratio) && ratio > CONTROLLED_VOLUME_MAX;
}

function readTimedCache(cache, key, maxAgeMs) {
  const entry = cache.get(key);
  return entry && Date.now() - entry.savedAt < maxAgeMs ? entry.value : null;
}

function writeTimedCache(cache, key, value) {
  cache.set(key, { savedAt: Date.now(), value });
  return value;
}
const fallbackStocks = [
  { code: '603629', name: '利通电子', market: '1', securityType: 'A股' },
  { code: '600519', name: '贵州茅台', market: '1', securityType: 'A股' },
  { code: '000001', name: '平安银行', market: '0', securityType: 'A股' },
  { code: '300750', name: '宁德时代', market: '0', securityType: 'A股' },
  { code: '002594', name: '比亚迪', market: '0', securityType: 'A股' },
  { code: '601138', name: '工业富联', market: '1', securityType: 'A股' },
  { code: '300308', name: '中际旭创', market: '0', securityType: 'A股' },
  { code: '300502', name: '新易盛', market: '0', securityType: 'A股' },
  { code: '002463', name: '沪电股份', market: '0', securityType: 'A股' },
  { code: '300476', name: '胜宏科技', market: '0', securityType: 'A股' },
  { code: '000977', name: '浪潮信息', market: '0', securityType: 'A股' },
  { code: '002837', name: '英维克', market: '0', securityType: 'A股' },
  { code: '688111', name: '金山办公', market: '1', securityType: 'A股' },
  { code: '002230', name: '科大讯飞', market: '0', securityType: 'A股' },
  { code: '688041', name: '海光信息', market: '1', securityType: 'A股' },
  { code: '688256', name: '寒武纪', market: '1', securityType: 'A股' }
];

const industryFallbacks = {
  半导体: [
    { code: '688041', name: '海光信息', sector: '上游 / 国产算力芯片' },
    { code: '688256', name: '寒武纪', sector: '上游 / AI芯片' },
    { code: '688012', name: '中微公司', sector: '上游 / 半导体设备' },
    { code: '002371', name: '北方华创', sector: '上游 / 半导体设备' },
    { code: '688126', name: '沪硅产业', sector: '上游 / 半导体材料' },
    { code: '600584', name: '长电科技', sector: '中游 / 封测' },
    { code: '688981', name: '中芯国际', sector: '中游 / 晶圆制造' }
  ],
  芯片: [
    { code: '688041', name: '海光信息', sector: '上游 / 国产算力芯片' },
    { code: '688256', name: '寒武纪', sector: '上游 / AI芯片' },
    { code: '688981', name: '中芯国际', sector: '中游 / 晶圆制造' },
    { code: '603986', name: '兆易创新', sector: '中游 / 存储与MCU' }
  ],
  白酒: [
    { code: '600519', name: '贵州茅台', sector: '高端白酒' },
    { code: '000858', name: '五粮液', sector: '高端白酒' },
    { code: '000568', name: '泸州老窖', sector: '高端白酒' },
    { code: '600809', name: '山西汾酒', sector: '次高端白酒' },
    { code: '002304', name: '洋河股份', sector: '区域白酒' },
    { code: '603369', name: '今世缘', sector: '区域白酒' }
  ],
  猪肉: [
    { code: '002714', name: '牧原股份', sector: '上游 / 生猪养殖' },
    { code: '300498', name: '温氏股份', sector: '上游 / 生猪养殖' },
    { code: '002124', name: '天邦食品', sector: '上游 / 生猪养殖' },
    { code: '605296', name: '神农集团', sector: '上游 / 生猪养殖' },
    { code: '603477', name: '巨星农牧', sector: '上游 / 生猪养殖' },
    { code: '600975', name: '新五丰', sector: '上游 / 生猪养殖' },
    { code: '000048', name: '京基智农', sector: '中游 / 饲料与养殖' },
    { code: '000876', name: '新希望', sector: '中游 / 饲料与养殖' },
    { code: '002311', name: '海大集团', sector: '中游 / 饲料' },
    { code: '002567', name: '唐人神', sector: '下游 / 肉制品与养殖' }
  ],
  AI: [
    { code: '601138', name: '工业富联', sector: '中游 / AI服务器与整机' },
    { code: '300308', name: '中际旭创', sector: '中游 / CPO与光模块' },
    { code: '300502', name: '新易盛', sector: '中游 / CPO与光模块' },
    { code: '002463', name: '沪电股份', sector: '中游 / AI服务器PCB' },
    { code: '000977', name: '浪潮信息', sector: '中游 / AI服务器' },
    { code: '002837', name: '英维克', sector: '中游 / 液冷与数据中心' },
    { code: '688111', name: '金山办公', sector: '下游 / AI应用' },
    { code: '002230', name: '科大讯飞', sector: '下游 / AI应用' }
  ],
  算力: [
    { code: '601138', name: '工业富联', sector: '中游 / AI服务器与整机' },
    { code: '000977', name: '浪潮信息', sector: '中游 / AI服务器' },
    { code: '300308', name: '中际旭创', sector: '中游 / CPO与光模块' },
    { code: '300502', name: '新易盛', sector: '中游 / CPO与光模块' },
    { code: '002837', name: '英维克', sector: '中游 / 液冷与数据中心' }
  ],
  新能源车: [
    { code: '002594', name: '比亚迪', sector: '整车 / 新能源车' },
    { code: '601633', name: '长城汽车', sector: '整车 / 自主品牌' },
    { code: '601689', name: '拓普集团', sector: '零部件 / 智能底盘' },
    { code: '002050', name: '三花智控', sector: '零部件 / 热管理' },
    { code: '300750', name: '宁德时代', sector: '上游 / 动力电池' },
    { code: '002460', name: '赣锋锂业', sector: '上游 / 锂资源' }
  ],
  锂电池: [
    { code: '300750', name: '宁德时代', sector: '中游 / 动力电池' },
    { code: '002812', name: '恩捷股份', sector: '中游 / 隔膜' },
    { code: '300073', name: '当升科技', sector: '中游 / 正极材料' },
    { code: '002709', name: '天赐材料', sector: '中游 / 电解液' },
    { code: '002460', name: '赣锋锂业', sector: '上游 / 锂资源' }
  ],
  光伏: [
    { code: '601012', name: '隆基绿能', sector: '中游 / 组件与硅片' },
    { code: '688599', name: '天合光能', sector: '中游 / 组件' },
    { code: '300274', name: '阳光电源', sector: '下游 / 逆变器' },
    { code: '600438', name: '通威股份', sector: '上游 / 硅料电池' },
    { code: '603806', name: '福斯特', sector: '中游 / 胶膜' }
  ],
  机器人: [
    { code: '300124', name: '汇川技术', sector: '核心部件 / 工控' },
    { code: '002747', name: '埃斯顿', sector: '本体 / 工业机器人' },
    { code: '002050', name: '三花智控', sector: '执行器 / 热管理' },
    { code: '603728', name: '鸣志电器', sector: '核心部件 / 电机' },
    { code: '688017', name: '绿的谐波', sector: '核心部件 / 减速器' }
  ],
  低空经济: [
    { code: '002085', name: '万丰奥威', sector: '整机 / eVTOL' },
    { code: '300900', name: '广联航空', sector: '制造 / 航空部件' },
    { code: '688297', name: '中无人机', sector: '整机 / 无人机' },
    { code: '600038', name: '中直股份', sector: '整机 / 直升机' },
    { code: '300034', name: '钢研高纳', sector: '材料 / 高温合金' }
  ],
  军工: [
    { code: '600760', name: '中航沈飞', sector: '主机厂 / 航空装备' },
    { code: '000768', name: '中航西飞', sector: '主机厂 / 航空装备' },
    { code: '600893', name: '航发动力', sector: '上游 / 航空发动机' },
    { code: '002179', name: '中航光电', sector: '中游 / 军工电子' },
    { code: '300034', name: '钢研高纳', sector: '上游 / 高温合金' }
  ],
  医药: [
    { code: '600276', name: '恒瑞医药', sector: '创新药' },
    { code: '300760', name: '迈瑞医疗', sector: '医疗器械' },
    { code: '603259', name: '药明康德', sector: 'CXO' },
    { code: '300015', name: '爱尔眼科', sector: '医疗服务' },
    { code: '000538', name: '云南白药', sector: '中药消费' }
  ],
  银行: [
    { code: '600036', name: '招商银行', sector: '股份制银行' },
    { code: '000001', name: '平安银行', sector: '股份制银行' },
    { code: '601398', name: '工商银行', sector: '国有大行' },
    { code: '601288', name: '农业银行', sector: '国有大行' },
    { code: '601166', name: '兴业银行', sector: '股份制银行' }
  ],
  证券: [
    { code: '600030', name: '中信证券', sector: '券商 / 综合龙头' },
    { code: '300059', name: '东方财富', sector: '券商 / 互联网金融' },
    { code: '601688', name: '华泰证券', sector: '券商 / 财富管理' },
    { code: '600837', name: '海通证券', sector: '券商 / 综合券商' },
    { code: '601211', name: '国泰君安', sector: '券商 / 综合券商' }
  ],
  有色: [
    { code: '601899', name: '紫金矿业', sector: '铜金资源' },
    { code: '603993', name: '洛阳钼业', sector: '铜钴钼资源' },
    { code: '600489', name: '中金黄金', sector: '黄金' },
    { code: '000933', name: '神火股份', sector: '铝' },
    { code: '600547', name: '山东黄金', sector: '黄金' }
  ],
  煤炭: [
    { code: '601088', name: '中国神华', sector: '动力煤 / 一体化' },
    { code: '600188', name: '兖矿能源', sector: '煤炭开采' },
    { code: '601225', name: '陕西煤业', sector: '动力煤' },
    { code: '600985', name: '淮北矿业', sector: '焦煤' },
    { code: '000983', name: '山西焦煤', sector: '焦煤' }
  ],
  电力: [
    { code: '600900', name: '长江电力', sector: '水电' },
    { code: '600905', name: '三峡能源', sector: '新能源发电' },
    { code: '600011', name: '华能国际', sector: '火电' },
    { code: '600886', name: '国投电力', sector: '水火风光' },
    { code: '003816', name: '中国广核', sector: '核电' }
  ],
  游戏: [
    { code: '002555', name: '三七互娱', sector: '游戏研发运营' },
    { code: '002624', name: '完美世界', sector: '游戏研发运营' },
    { code: '300418', name: '昆仑万维', sector: '游戏与AI应用' },
    { code: '300002', name: '神州泰岳', sector: '游戏出海' }
  ],
  传媒: [
    { code: '300413', name: '芒果超媒', sector: '长视频与内容' },
    { code: '300418', name: '昆仑万维', sector: 'AI内容应用' },
    { code: '002555', name: '三七互娱', sector: '游戏传媒' },
    { code: '601595', name: '上海电影', sector: '影视院线' }
  ],
  软件: [
    { code: '688111', name: '金山办公', sector: '办公软件 / AI应用' },
    { code: '600570', name: '恒生电子', sector: '金融IT' },
    { code: '300454', name: '深信服', sector: '网络安全与云计算' },
    { code: '002230', name: '科大讯飞', sector: 'AI软件应用' },
    { code: '300496', name: '中科创达', sector: '操作系统与智能终端' },
    { code: '300339', name: '润和软件', sector: '鸿蒙与操作系统' }
  ],
  互联网: [
    { code: '300059', name: '东方财富', sector: '互联网金融' },
    { code: '300418', name: '昆仑万维', sector: 'AI互联网应用' },
    { code: '002555', name: '三七互娱', sector: '互联网游戏' },
    { code: '300113', name: '顺网科技', sector: '云游戏与算力服务' }
  ],
  港口海运: [
    { code: '601919', name: '中远海控', sector: '海运 / 集装箱运输' },
    { code: '601872', name: '招商轮船', sector: '海运 / 油运与干散货' },
    { code: '600026', name: '中远海能', sector: '海运 / 油运' },
    { code: '601298', name: '青岛港', sector: '港口 / 综合港口' },
    { code: '600018', name: '上港集团', sector: '港口 / 集装箱港口' },
    { code: '001872', name: '招商港口', sector: '港口 / 港口运营' }
  ],
  粮食: [
    { code: '600598', name: '北大荒', sector: '上游 / 种植与土地资源' },
    { code: '000998', name: '隆平高科', sector: '上游 / 种业' },
    { code: '600737', name: '中粮糖业', sector: '中游 / 农产品加工' },
    { code: '000930', name: '中粮科技', sector: '中游 / 粮食深加工' },
    { code: '002385', name: '大北农', sector: '上游 / 种业与饲料' },
    { code: '600313', name: '农发种业', sector: '上游 / 种业' }
  ],
  消费电子: [
    { code: '002475', name: '立讯精密', sector: '果链 / 精密制造' },
    { code: '000725', name: '京东方A', sector: '面板' },
    { code: '002241', name: '歌尔股份', sector: '声学与XR' },
    { code: '300433', name: '蓝思科技', sector: '玻璃盖板' },
    { code: '603501', name: '韦尔股份', sector: 'CIS芯片' },
    { code: '300782', name: '卓胜微', sector: '射频前端' },
    { code: '002600', name: '领益智造', sector: '精密功能件' },
    { code: '002938', name: '鹏鼎控股', sector: '消费电子PCB' },
    { code: '300136', name: '信维通信', sector: '天线与射频' },
    { code: '688036', name: '传音控股', sector: '智能手机终端' }
  ]
};

function logFilePath() {
  const date = new Date().toLocaleDateString('en-CA');
  const baseDir = app.isPackaged ? path.dirname(process.execPath) : __dirname;
  return path.join(baseDir, 'logs', `${date}.log`);
}

function cacheFilePath(name) {
  const baseDir = app.isPackaged ? path.dirname(process.execPath) : __dirname;
  return path.join(baseDir, 'cache', `${name}.json`);
}

function readDiskCache(name, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  try {
    const file = cacheFilePath(name);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed?.savedAt || Date.now() - parsed.savedAt > maxAgeMs) return null;
    return parsed.data || null;
  } catch {
    return null;
  }
}

function writeDiskCache(name, data) {
  const file = cacheFilePath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.promises.writeFile(file, JSON.stringify({ savedAt: Date.now(), data }, null, 2), 'utf8').catch(() => {});
}

function appendLogLine(entry) {
  const file = logFilePath();
  const action = entry.action ? ` action=${entry.action}` : '';
  const detail = entry.detail ? ` ${JSON.stringify(entry.detail)}` : '';
  const stack = entry.stack ? ` stack=${String(entry.stack).split('\n').slice(0, 3).join(' | ')}` : '';
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] [${entry.type || 'info'}] ${entry.message || ''}${action}${detail}${stack}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.promises.appendFile(file, line, 'utf8').catch(() => {});
  return file;
}

function requestText(url, timeout = 12000, extraHeaders = {}, encoding = 'utf8', redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http://') ? http : https;
    const req = client.get(url, {
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 250,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://quote.eastmoney.com/',
        ...extraHeaders
      }
    }, (res) => {
      const chunks = [];
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        const redirectedUrl = new URL(res.headers.location, url).toString();
        res.resume();
        requestText(redirectedUrl, timeout, extraHeaders, encoding, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`行情接口 HTTP ${res.statusCode}`));
        return;
      }
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = encoding === 'utf8' ? buffer.toString('utf8') : new TextDecoder(encoding).decode(buffer);
        resolve(text);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => {
      req.destroy(new Error('请求超时'));
    });
  });
}

async function getJson(url) {
  try {
    return JSON.parse(await requestText(url, 12000));
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error('接口返回内容无法解析');
    throw err;
  }
}

function getText(url, extraHeaders = {}, encoding = 'utf8') {
  return requestText(url, 8000, extraHeaders, encoding);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function settleWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: 'fulfilled', value: await task(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function getJsonWithRetry(url, retries = 2) {
  let lastError;
  for (let i = 0; i <= retries; i++) {
    try {
      return await getJson(url);
    } catch (err) {
      lastError = err;
      if (i < retries) await sleep(500 * (i + 1));
    }
  }
  throw lastError;
}

function dateOnly(value) {
  const match = String(value || '').match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function currentChinaDate() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function shiftDate(isoDate, { days = 0, months = 0 } = {}) {
  const normalized = dateOnly(isoDate);
  if (!normalized) return '';
  const [year, month, day] = normalized.split('-').map(Number);
  if (months) {
    const targetMonth = month - 1 + months;
    const targetYear = year + Math.floor(targetMonth / 12);
    const normalizedMonth = ((targetMonth % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
    const date = new Date(Date.UTC(targetYear, normalizedMonth, Math.min(day, lastDay)));
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }
  const date = new Date(`${normalized}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseReductionPlanWindow(content, noticeDate) {
  const text = String(content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const markerIndex = Math.max(text.indexOf('减持期间'), text.indexOf('减持期限'));
  const scope = markerIndex >= 0 ? text.slice(markerIndex, markerIndex + 500) : text;
  const range = scope.match(/(\d{4})\s*[年\/-]\s*(\d{1,2})\s*[月\/-]\s*(\d{1,2})\s*日?\s*(?:至|—|–|-|~|～)\s*(?:(\d{4})\s*[年\/-]\s*)?(\d{1,2})\s*[月\/-]\s*(\d{1,2})\s*日?/);
  if (range) {
    const startDate = dateOnly(`${range[1]}-${range[2]}-${range[3]}`);
    let endYear = Number(range[4] || range[1]);
    let endDate = dateOnly(`${endYear}-${range[5]}-${range[6]}`);
    if (startDate && endDate && endDate < startDate && !range[4]) {
      endYear += 1;
      endDate = dateOnly(`${endYear}-${range[5]}-${range[6]}`);
    }
    if (startDate && endDate) return { startDate, endDate, estimated: false };
  }
  const normalizedNoticeDate = dateOnly(noticeDate);
  const duration = scope.match(/(\d+)\s*个?月内/);
  if (!normalizedNoticeDate || !duration) return null;
  const tradingDays = Number((scope.match(/(\d+)\s*个交易日后/) || [])[1]) || 0;
  const startDate = shiftDate(normalizedNoticeDate, { days: Math.ceil(tradingDays * 7 / 5) });
  return { startDate, endDate: shiftDate(startDate, { months: Number(duration[1]) }), estimated: true };
}

function isReductionPlanAnnouncement(title) {
  const text = String(title || '');
  return /减持/.test(text) && /(预披露|计划|进展)/.test(text) && !/(期满|届满|完成|完毕|终止|结束|实施结果)/.test(text);
}

function buildFutureRiskProfile({ name, today = currentChinaDate(), unlockRows, reductionAnnouncements }) {
  const windowStart = dateOnly(today);
  const windowEnd = shiftDate(windowStart, { months: 6 });
  const stRisk = /ST|退/i.test(String(name || ''));
  const st = { status: stRisk ? 'risk' : 'clear', reason: stRisk ? '当前股票名称含ST或退市标记' : '当前无ST或退市标记' };

  const unlockEvents = Array.isArray(unlockRows) ? unlockRows.map(row => ({
    date: dateOnly(row.FREE_DATE || row.date),
    type: row.FREE_SHARES_TYPE || row.type || '限售股份',
    shares: Number(row.ABLE_FREE_SHARES ?? row.FREE_SHARES ?? row.shares) || 0
  })).filter(event => event.date >= windowStart && event.date <= windowEnd) : [];
  const unlock = {
    status: unlockRows == null ? 'unknown' : unlockEvents.length ? 'risk' : 'clear',
    events: unlockEvents
  };

  let unparsedPlans = 0;
  const reductionEvents = Array.isArray(reductionAnnouncements) ? reductionAnnouncements.filter(row => isReductionPlanAnnouncement(row.title)).map(row => {
    const window = parseReductionPlanWindow(row.content, row.noticeDate);
    if (!window) {
      unparsedPlans++;
      return null;
    }
    return { title: row.title, noticeDate: dateOnly(row.noticeDate), ...window };
  }).filter(event => event && event.endDate >= windowStart && event.startDate <= windowEnd) : [];
  const reduction = {
    status: reductionAnnouncements == null || unparsedPlans ? (reductionEvents.length ? 'risk' : 'unknown') : reductionEvents.length ? 'risk' : 'clear',
    events: reductionEvents,
    unparsedPlans
  };

  const statuses = [st.status, unlock.status, reduction.status];
  const status = statuses.includes('risk') ? 'risk' : statuses.includes('unknown') ? 'unknown' : 'clear';
  const risks = [];
  if (st.status === 'risk') risks.push(st.reason);
  if (reductionEvents.length) risks.push(`未来半年存在${reductionEvents.length}项减持计划`);
  if (unlockEvents.length) risks.push(`未来半年存在${unlockEvents.length}次限售解禁`);
  const unknowns = [];
  if (reduction.status === 'unknown') unknowns.push('减持计划');
  if (unlock.status === 'unknown') unknowns.push('限售解禁');
  const summary = status === 'risk' ? risks.join('；')
    : status === 'unknown' ? `${unknowns.join('、')}数据未确认`
      : '当前无ST标记，未来半年未发现减持计划或限售解禁';
  return { status, passed: status === 'clear', windowStart, windowEnd, st, reduction, unlock, summary };
}

async function fetchAnnouncementContent(artCode) {
  const buildUrl = page => `https://np-cnotice-stock.eastmoney.com/api/content/ann?art_code=${encodeURIComponent(artCode)}&client_source=web&page_index=${page}`;
  const first = await getJsonWithRetry(buildUrl(1), 1);
  const pageCount = Math.min(10, Math.max(1, Number(first?.data?.page_size) || 1));
  const contents = [first?.data?.notice_content || ''];
  if (pageCount > 1) {
    const pages = await settleWithConcurrency(Array.from({ length: pageCount - 1 }, (_value, index) => index + 2), 2,
      page => getJsonWithRetry(buildUrl(page), 0));
    pages.forEach(result => {
      if (result.status === 'fulfilled') contents.push(result.value?.data?.notice_content || '');
    });
  }
  return contents.join(' ');
}

async function fetchReductionPlans(code, today) {
  const beginTime = shiftDate(today, { months: -12 });
  const params = new URLSearchParams({
    sr: '-1', page_size: '100', page_index: '1', ann_type: 'A', client_source: 'web',
    stock_list: code, f_node: '7', s_node: '0', begin_time: beginTime, end_time: today
  });
  const json = await getJsonWithRetry(`https://np-anotice-stock.eastmoney.com/api/security/ann?${params}`, 1);
  const candidates = (json?.data?.list || []).filter(row => isReductionPlanAnnouncement(row.title));
  const details = await settleWithConcurrency(candidates, 2, row => fetchAnnouncementContent(row.art_code));
  return candidates.map((row, index) => ({
    title: row.title,
    noticeDate: row.notice_date,
    content: details[index]?.status === 'fulfilled' ? details[index].value : ''
  }));
}

async function fetchUnlocks(code, today) {
  const windowEnd = shiftDate(today, { months: 6 });
  const params = new URLSearchParams({
    reportName: 'RPT_LIFT_STAGE', columns: 'ALL', pageNumber: '1', pageSize: '100',
    sortColumns: 'FREE_DATE', sortTypes: '1',
    filter: `(SECURITY_CODE="${code}")(FREE_DATE>='${today}')(FREE_DATE<='${windowEnd}')`
  });
  const json = await getJsonWithRetry(`https://datacenter-web.eastmoney.com/api/data/v1/get?${params}`, 1);
  return json?.result?.data || [];
}

async function fetchFutureRiskProfile({ code, name, force = false }) {
  const cacheKey = String(code || '');
  const cached = force ? null : readTimedCache(stockRiskCache, cacheKey, 6 * 60 * 60 * 1000);
  if (cached) return { ...cached, cached: true };
  const today = currentChinaDate();
  if (/ST|退/i.test(String(name || ''))) {
    return writeTimedCache(stockRiskCache, cacheKey, {
      ...buildFutureRiskProfile({ name, today, unlockRows: [], reductionAnnouncements: [] }),
      errors: [],
      source: '当前证券名称'
    });
  }
  const [unlockResult, reductionResult] = await Promise.allSettled([
    fetchUnlocks(cacheKey, today),
    fetchReductionPlans(cacheKey, today)
  ]);
  const errors = [];
  if (unlockResult.status === 'rejected') errors.push(`限售解禁查询失败：${unlockResult.reason?.message || unlockResult.reason}`);
  if (reductionResult.status === 'rejected') errors.push(`减持计划查询失败：${reductionResult.reason?.message || reductionResult.reason}`);
  const profile = buildFutureRiskProfile({
    name,
    today,
    unlockRows: unlockResult.status === 'fulfilled' ? unlockResult.value : null,
    reductionAnnouncements: reductionResult.status === 'fulfilled' ? reductionResult.value : null
  });
  return writeTimedCache(stockRiskCache, cacheKey, {
    ...profile,
    errors,
    source: '东方财富公司公告 + 东方财富限售解禁'
  });
}

async function fetchEastmoneyPages(buildUrl, maxPages = 60) {
  const first = await getJsonWithRetry(buildUrl(1), 1);
  const firstRows = first?.data?.diff || [];
  const pageSize = Math.max(firstRows.length, 100);
  const total = Number(first?.data?.total) || firstRows.length;
  const pageCount = Math.min(maxPages, Math.max(1, Math.ceil(total / pageSize)));
  const rows = [...firstRows];
  const errors = [];

  for (let page = 2; page <= pageCount; page += 4) {
    const pages = Array.from({ length: Math.min(4, pageCount - page + 1) }, (_value, index) => page + index);
    const settled = await Promise.allSettled(pages.map(current => getJsonWithRetry(buildUrl(current), 0)));
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') rows.push(...(result.value?.data?.diff || []));
      else errors.push(`第${pages[index]}页：${result.reason?.message || result.reason}`);
    });
  }
  return { rows, total, pageCount, errors };
}

function marketPrefixOf(code) {
  const value = String(code || '');
  if (/^[56]/.test(value)) return 'sh';
  if (/^[489]/.test(value)) return 'bj';
  return 'sz';
}

function secidOf(code) {
  // 东方财富：1=沪市，0=深市/北交所常见。A股常用规则足够覆盖本工具股票池。
  if (/^[56]/.test(String(code))) return `1.${code}`;
  return `0.${code}`;
}

function finiteNumber(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeQuoteRow(r) {
  return {
    code: String(r.f12 || r.f57 || ''),
    name: r.f14 || r.f58 || '',
    price: typeof r.f2 === 'number' ? r.f2 : null,
    changePct: typeof r.f3 === 'number' ? r.f3 : null,
    change: typeof r.f4 === 'number' ? r.f4 : null,
    volume: typeof r.f5 === 'number' ? r.f5 : null,
    amount: typeof r.f6 === 'number' ? r.f6 : null,
    high: typeof r.f15 === 'number' ? r.f15 : null,
    low: typeof r.f16 === 'number' ? r.f16 : null,
    open: typeof r.f17 === 'number' ? r.f17 : null,
    prevClose: typeof r.f18 === 'number' ? r.f18 : null,
    amplitude: typeof r.f7 === 'number' ? r.f7 : null,
    turnoverRate: typeof r.f8 === 'number' ? r.f8 : null,
    peRatio: typeof r.f9 === 'number' ? r.f9 : null,
    snapshotVolumeRatio: typeof r.f10 === 'number' ? r.f10 : null,
    pbRatio: typeof r.f23 === 'number' ? r.f23 : null,
    upperLimit: typeof r.f51 === 'number' ? r.f51 : null,
    lowerLimit: typeof r.f52 === 'number' ? r.f52 : null,
    totalMarketCap: typeof r.f20 === 'number' ? r.f20 : null,
    floatMarketCap: typeof r.f21 === 'number' ? r.f21 : null,
    mainNetInflow: typeof r.f62 === 'number' ? r.f62 : null,
    mainNetPct: typeof r.f184 === 'number' ? r.f184 : null,
    source: '东方财富实时行情',
    fetchedAt: new Date().toISOString()
  };
}

async function fetchQuoteRows(codes) {
  const fields = 'f12,f14,f2,f3,f4,f5,f6,f7,f8,f9,f10,f15,f16,f17,f18,f20,f21,f23,f51,f52,f62,f184,f57,f58';
  const secids = codes.map(secidOf).join(',');
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=${fields}&secids=${encodeURIComponent(secids)}&_=${Date.now()}`;
  const json = await getJsonWithRetry(url, 1);
  return json?.data?.diff || [];
}

async function fetchEastmoneySingleFundFlow(code) {
  const fields = 'f57,f58,f62,f184';
  const json = await getJsonWithRetry(`https://push2.eastmoney.com/api/qt/stock/get?secid=${secidOf(code)}&fltt=2&invt=2&fields=${fields}&_=${Date.now()}`, 0);
  const data = json?.data || {};
  const mainNetInflow = finiteNumber(data.f62);
  const mainNetPct = finiteNumber(data.f184);
  if (mainNetInflow == null || mainNetPct == null) throw new Error('东方财富单股资金字段为空');
  return {
    mainInflow: null,
    mainOutflow: null,
    mainNetInflow,
    mainNetPct,
    source: '东方财富单股资金',
    tradeDate: new Date().toISOString().slice(0, 10),
    estimated: false
  };
}

async function fetchSinaSingleFundFlow(code) {
  const symbol = `${marketPrefixOf(code)}${code}`;
  const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_zjlrqs?page=1&num=1&sort=opendate&asc=0&daima=${symbol}`;
  const text = await getText(url, { Referer: 'https://finance.sina.com.cn/', Accept: '*/*' });
  const rows = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
  const row = rows?.[0] || {};
  const mainNetWan = finiteNumber(row.r0_net);
  const mainNetPct = finiteNumber(row.r0_ratio);
  if (mainNetWan == null || mainNetPct == null) throw new Error('新浪资金字段为空');
  return {
    mainInflow: finiteNumber(row.r0_in) == null ? null : Number(row.r0_in) * 10000,
    mainOutflow: finiteNumber(row.r0_out) == null ? null : Math.abs(Number(row.r0_out)) * 10000,
    mainNetInflow: mainNetWan * 10000,
    mainNetPct,
    source: '新浪日资金流向',
    tradeDate: String(row.opendate || ''),
    estimated: false
  };
}

function parseTencentDetailRows(text) {
  const body = (String(text || '').match(/=\[\d+,"([\s\S]*?)"\];?/) || [])[1] || '';
  return body.split('|').map(item => {
    const cols = item.split('/');
    return { amount: finiteNumber(cols[5]), direction: cols[6] };
  }).filter(item => item.amount != null && /^(B|S|M)$/.test(item.direction));
}

async function fetchTencentEstimatedFundFlow(code) {
  const symbol = `${marketPrefixOf(code)}${code}`;
  const headers = { Referer: 'https://gu.qq.com/' };
  const timeline = await getText(`https://stock.gtimg.cn/data/index.php?appn=detail&action=timeline&c=${symbol}&_=${Date.now()}`, headers);
  const timelineMatch = timeline.match(/=\[(\d{8}),"([\s\S]*?)"\];?/);
  if (!timelineMatch) throw new Error('腾讯逐笔时间轴为空');
  const pageCount = Math.min(120, timelineMatch[2].split('|').filter(Boolean).length);
  if (!pageCount) throw new Error('腾讯逐笔页数为空');
  const rows = [];
  const errors = [];
  for (let index = 0; index < pageCount; index += 10) {
    const group = await Promise.allSettled(Array.from({ length: Math.min(10, pageCount - index) }, (_value, offset) => {
      const page = index + offset;
      return getText(`https://stock.gtimg.cn/data/index.php?appn=detail&action=data&c=${symbol}&p=${page}&_=${Date.now()}`, headers);
    }));
    group.forEach((result, offset) => {
      if (result.status === 'fulfilled') rows.push(...parseTencentDetailRows(result.value));
      else errors.push(`page ${index + offset}: ${result.reason?.message || result.reason}`);
    });
  }
  if (!rows.length || errors.length > pageCount * .25) throw new Error(`腾讯逐笔数据不完整：${rows.length} 条，失败 ${errors.length} 页`);
  const mainThreshold = 200000;
  const mainInflow = rows.filter(row => row.amount >= mainThreshold && row.direction === 'B').reduce((sum, row) => sum + row.amount, 0);
  const mainOutflow = rows.filter(row => row.amount >= mainThreshold && row.direction === 'S').reduce((sum, row) => sum + row.amount, 0);
  const totalAmount = rows.reduce((sum, row) => sum + row.amount, 0);
  const mainNetInflow = mainInflow - mainOutflow;
  return {
    mainInflow,
    mainOutflow,
    mainNetInflow,
    mainNetPct: totalAmount ? mainNetInflow / totalAmount * 100 : 0,
    source: '腾讯逐笔成交汇总估算（主力口径≥20万元）',
    tradeDate: `${timelineMatch[1].slice(0, 4)}-${timelineMatch[1].slice(4, 6)}-${timelineMatch[1].slice(6, 8)}`,
    estimated: true,
    transactionCount: rows.length,
    pageCount
  };
}

async function fetchStockFundFlow({ code, force = false }) {
  const safeCode = String(code || '');
  if (!/^\d{6}$/.test(safeCode)) throw new Error('股票代码无效');
  const cached = force ? null : readTimedCache(stockFundFlowCache, safeCode, 2 * 60 * 1000);
  if (cached) return { ...cached, cached: true };
  const previous = stockFundFlowCache.get(safeCode)?.value;
  const errors = [];
  const primary = await Promise.allSettled([
    fetchEastmoneySingleFundFlow(safeCode),
    fetchSinaSingleFundFlow(safeCode)
  ]);
  for (const result of primary) {
    if (result.status === 'fulfilled' && result.value.mainInflow != null && result.value.mainOutflow != null) {
      return writeTimedCache(stockFundFlowCache, safeCode, { ...result.value, errors });
    }
    errors.push(result.status === 'fulfilled' ? `${result.value.source}未提供主力流入/流出分项` : result.reason?.message || String(result.reason));
  }
  try {
    const fallback = await fetchTencentEstimatedFundFlow(safeCode);
    return writeTimedCache(stockFundFlowCache, safeCode, { ...fallback, errors });
  } catch (err) {
    errors.push(`腾讯逐笔资金失败：${err.message || err}`);
    if (previous) return { ...previous, cached: true, stale: true, errors };
    throw new Error(errors.join('；'));
  }
}

async function fetchSinaQuote(code) {
  const prefix = marketPrefixOf(code);
  const text = await getText(`http://hq.sinajs.cn/list=${prefix}${code}`, { Referer: 'http://finance.sina.com.cn/' }, 'gb18030');
  const body = text.split('"')[1] || '';
  const cols = body.split(',');
  const price = Number(cols[3]);
  const prevClose = Number(cols[2]);
  if (!Number.isFinite(price) || price <= 0) return null;
  const change = Number.isFinite(prevClose) ? price - prevClose : null;
  const changePct = Number.isFinite(change) && prevClose ? change / prevClose * 100 : null;
  return {
    code,
    name: '',
    price,
    changePct,
    change,
    volume: Number(cols[8]) || null,
    amount: Number(cols[9]) || null,
    high: Number(cols[4]) || null,
    low: Number(cols[5]) || null,
    open: Number(cols[1]) || null,
    prevClose: Number.isFinite(prevClose) ? prevClose : null,
    totalMarketCap: Number(cols[45]) ? Number(cols[45]) * 1e8 : null,
    floatMarketCap: Number(cols[44]) ? Number(cols[44]) * 1e8 : null,
    mainNetInflow: null,
    mainNetPct: null,
    source: '新浪实时行情',
    fetchedAt: new Date().toISOString()
  };
}

function normalizeTencentQuote(body) {
  const cols = body.split('~');
  const price = Number(cols[3]);
  const prevClose = Number(cols[4]);
  if (!Number.isFinite(price) || price <= 0) return null;
  const code = String(cols[2] || '');
  return {
    code,
    name: cleanStockName(cols[1]),
    price,
    changePct: finiteNumber(cols[32]),
    change: finiteNumber(cols[31]),
    volume: finiteNumber(cols[36]),
    amount: finiteNumber(cols[37]) == null ? null : Number(cols[37]) * 10000,
    high: finiteNumber(cols[33]),
    low: finiteNumber(cols[34]),
    open: finiteNumber(cols[5]),
    prevClose: Number.isFinite(prevClose) ? prevClose : null,
    amplitude: finiteNumber(cols[43]),
    turnoverRate: finiteNumber(cols[38]),
    peRatio: finiteNumber(cols[39]),
    snapshotVolumeRatio: finiteNumber(cols[49]),
    pbRatio: finiteNumber(cols[46]),
    upperLimit: finiteNumber(cols[47]),
    lowerLimit: finiteNumber(cols[48]),
    totalMarketCap: finiteNumber(cols[45]) == null ? null : Number(cols[45]) * 1e8,
    floatMarketCap: finiteNumber(cols[44]) == null ? null : Number(cols[44]) * 1e8,
    mainNetInflow: null,
    mainNetPct: null,
    source: '腾讯实时行情',
    fetchedAt: new Date().toISOString(),
    tradeDate: /^\d{8}/.test(String(cols[30] || '')) ? `${cols[30].slice(0, 4)}-${cols[30].slice(4, 6)}-${cols[30].slice(6, 8)}` : '',
    stale: false
  };
}

async function fetchTencentQuotes(codes) {
  const symbols = codes.map(code => `${marketPrefixOf(code)}${code}`).join(',');
  const text = await getText(`http://qt.gtimg.cn/q=${symbols}`, { Referer: 'http://gu.qq.com/' }, 'gb18030');
  return text.split(/\r?\n/).map(line => normalizeTencentQuote((line.match(/="([\s\S]*?)"/) || [])[1] || '')).filter(Boolean);
}

async function fetchTencentMarketIndices() {
  const text = await getText('http://qt.gtimg.cn/q=s_sh000001,s_sz399001,s_sz399006', { Referer: 'http://gu.qq.com/' }, 'gb18030');
  return text.split(/\r?\n/).map(line => {
    const body = (line.match(/="([\s\S]*?)"/) || [])[1] || '';
    const cols = body.split('~');
    const price = finiteNumber(cols[3]);
    if (!cols[2] || price == null) return null;
    return {
      code: cols[2], name: cleanStockName(cols[1]), price,
      change: finiteNumber(cols[4]), changePct: finiteNumber(cols[5]),
      amount: finiteNumber(cols[9]) == null ? null : Number(cols[9]) * 1e6
    };
  }).filter(Boolean);
}

const marketSectorIndices = [
  { code: '000928', name: '能源', representatives: ['601088', '600938', '601857'] },
  { code: '000929', name: '原材料', representatives: ['601899', '600019', '600111'] },
  { code: '000930', name: '工业', representatives: ['601668', '601766', '600031'] },
  { code: '000931', name: '可选消费', representatives: ['002594', '000333', '600104'] },
  { code: '000932', name: '主要消费', representatives: ['600519', '000858', '000895'] },
  { code: '000933', name: '医药卫生', representatives: ['600276', '300760', '000538'] },
  { code: '000934', name: '金融地产', representatives: ['601318', '600036', '000001'] },
  { code: '000935', name: '信息技术', representatives: ['002371', '688981', '002415'] },
  { code: '000936', name: '通信服务', representatives: ['600050', '300308', '000063'] },
  { code: '000937', name: '公用事业', representatives: ['600900', '600886', '003816'] }
];

let tencentMarketSymbols = null;

function allTencentMarketSymbols() {
  if (tencentMarketSymbols) return tencentMarketSymbols;
  const symbols = [];
  const addRange = (prefix, start, end) => {
    for (let code = start; code <= end; code++) symbols.push(`${prefix}${String(code).padStart(6, '0')}`);
  };
  addRange('sh', 600000, 605999);
  addRange('sh', 688000, 689999);
  addRange('sz', 1, 4999);
  addRange('sz', 300000, 301999);
  addRange('bj', 920000, 920999);
  tencentMarketSymbols = symbols;
  return symbols;
}

function marketDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}${value.month}${value.day}`;
}

function parseTencentMarketQuote(body) {
  const cols = String(body || '').split('~');
  const price = finiteNumber(cols[3]);
  const code = String(cols[2] || '');
  if (!/^\d{6}$/.test(code) || price == null || price <= 0 || !String(cols[61] || '').startsWith('GP')) return null;
  return {
    code,
    name: cleanStockName(cols[1]),
    price,
    changePct: finiteNumber(cols[32]),
    change: finiteNumber(cols[31]),
    open: finiteNumber(cols[5]),
    high: finiteNumber(cols[33]),
    low: finiteNumber(cols[34]),
    prevClose: finiteNumber(cols[4]),
    volume: finiteNumber(cols[36]),
    amount: finiteNumber(cols[37]) == null ? 0 : Number(cols[37]) * 10000,
    turnoverRate: finiteNumber(cols[38]),
    peRatio: finiteNumber(cols[39]),
    amplitude: finiteNumber(cols[43]),
    totalMarketCap: finiteNumber(cols[45]) == null ? null : Number(cols[45]) * 1e8,
    floatMarketCap: finiteNumber(cols[44]) == null ? null : Number(cols[44]) * 1e8,
    pbRatio: finiteNumber(cols[46]),
    snapshotVolumeRatio: finiteNumber(cols[49]),
    upperLimit: finiteNumber(cols[47]),
    lowerLimit: finiteNumber(cols[48]),
    tradeDate: /^\d{8}/.test(String(cols[30] || '')) ? `${cols[30].slice(0, 4)}-${cols[30].slice(4, 6)}-${cols[30].slice(6, 8)}` : ''
  };
}

async function fetchTencentMarketBatch(symbols) {
  const url = `https://qt.gtimg.cn/q=${symbols.join(',')}`;
  let text;
  try {
    text = await getText(url, { Referer: 'https://gu.qq.com/' }, 'gb18030');
  } catch (firstError) {
    await sleep(250);
    try {
      text = await getText(url, { Referer: 'https://gu.qq.com/' }, 'gb18030');
    } catch (secondError) {
      throw new Error(`${firstError.message || firstError}; retry: ${secondError.message || secondError}`);
    }
  }
  return text.split(/\r?\n/)
    .map(line => parseTencentMarketQuote((line.match(/="([\s\S]*?)"/) || [])[1] || ''))
    .filter(Boolean);
}

async function fetchTencentMarketSnapshot() {
  const symbols = allTencentMarketSymbols();
  const batches = [];
  for (let index = 0; index < symbols.length; index += 800) batches.push(symbols.slice(index, index + 800));
  const quotes = [];
  const errors = [];
  const batchResults = await settleWithConcurrency(batches, 4, fetchTencentMarketBatch);
  batchResults.forEach((result, index) => {
      if (result.status === 'fulfilled') quotes.push(...result.value);
      else errors.push(`batch ${index + 1}: ${result.reason?.message || result.reason}`);
  });
  if (quotes.length < 1000) throw new Error(`腾讯全市场行情仅返回 ${quotes.length} 只股票${errors.length ? `；${errors.join('；')}` : ''}`);
  if (Date.now() - marketDirectorySavedAt > 6 * 60 * 60 * 1000) {
    writeDiskCache('tencent-stock-directory', quotes.map(({ code, name }) => ({ code, name, securityType: 'A股' })));
    marketDirectorySavedAt = Date.now();
  }
  const breadth = quotes.reduce((sum, quote) => {
    if ((quote.changePct || 0) > 0.005) sum.up++;
    else if ((quote.changePct || 0) < -0.005) sum.down++;
    else sum.flat++;
    return sum;
  }, { up: 0, down: 0, flat: 0 });
  const atLimit = (quote, limit, direction) => limit > 0 && Math.abs(quote.price - limit) < 0.005 && direction * (quote.changePct || 0) > 4.5;
  const byAmount = (a, b) => (b.amount || 0) - (a.amount || 0);
  const upStocks = quotes.filter(quote => atLimit(quote, quote.upperLimit, 1)).sort(byAmount);
  const downStocks = quotes.filter(quote => atLimit(quote, quote.lowerLimit, -1)).sort(byAmount);
  return {
    quotes,
    breadth,
    turnover: quotes.reduce((sum, quote) => sum + (quote.amount || 0), 0),
    activeStocks: [...quotes].sort(byAmount).slice(0, 8),
    limits: {
      date: marketDateString(),
      upCount: upStocks.length,
      downCount: downStocks.length,
      upStocks: upStocks.slice(0, 8),
      downStocks: downStocks.slice(0, 8)
    },
    errors
  };
}

async function fetchTencentMarketSectors(marketQuotes) {
  const symbols = marketSectorIndices.map(item => `sh${item.code}`);
  const text = await getText(`https://qt.gtimg.cn/q=${symbols.join(',')}`, { Referer: 'https://gu.qq.com/' }, 'gb18030');
  const quoteByCode = new Map((marketQuotes || []).map(item => [item.code, item]));
  const rowsByCode = new Map(text.split(/\r?\n/).map(line => {
    const cols = ((line.match(/="([\s\S]*?)"/) || [])[1] || '').split('~');
    return [String(cols[2] || ''), cols];
  }));
  const rows = marketSectorIndices.map(sector => {
    const cols = rowsByCode.get(sector.code) || [];
    const representatives = sector.representatives.map(code => quoteByCode.get(code)).filter(Boolean).sort((a, b) => (b.changePct || 0) - (a.changePct || 0));
    return {
      code: sector.code,
      name: sector.name,
      changePct: finiteNumber(cols[32]),
      amount: finiteNumber(cols[37]) == null ? null : Number(cols[37]) * 10000,
      leader: representatives[0]?.name || '',
      representatives: representatives.slice(0, 3).map(item => item.name)
    };
  }).filter(row => row.changePct != null);
  if (rows.length < 8) throw new Error(`腾讯行业指数仅返回 ${rows.length} 个板块`);
  return {
    sectors: [...rows].sort((a, b) => b.changePct - a.changePct),
    weakSectors: [...rows].sort((a, b) => a.changePct - b.changePct).slice(0, 4),
    fundSectors: rows.filter(row => row.amount != null).sort((a, b) => b.amount - a.amount)
  };
}

function newsTimestamp(value) {
  const text = String(value || '').trim().replace(/^(\d{4}-\d{2}-\d{2})\s+/, '$1T');
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function newsAgeLabel(ageHours) {
  if (!Number.isFinite(ageHours)) return '发布时间未知';
  if (ageHours < 1) return '1小时内';
  if (ageHours <= 24) return `${Math.max(1, Math.round(ageHours))}小时内`;
  return `${Math.max(1, Math.round(ageHours / 24))}天内`;
}

function formatNewsTime(value) {
  const timestamp = newsTimestamp(value);
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const pad = number => String(number).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseJsonpPayload(value) {
  const text = String(value || '').trim();
  if (text.startsWith('{') || text.startsWith('[')) return JSON.parse(text);
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start < 0 || end <= start) throw new Error('资讯接口返回了无法识别的JSONP');
  return JSON.parse(text.slice(start + 1, end));
}

function summarizeNews(news, sinceDate = '', options = {}) {
  const now = newsTimestamp(options.now) || Date.now();
  const fetchedAt = options.fetchedAt || new Date(now).toISOString();
  const stale = Boolean(options.stale);
  const subject = cleanStockName(options.subject || options.name || '');
  const code = String(options.code || '').trim();
  const since = newsTimestamp(sinceDate);
  const positiveTerms = [
    ['业绩预增', 2.5], ['扭亏为盈', 2.5], ['中标', 2], ['重大合同', 2], ['回购', 1.8], ['增持', 1.8],
    ['获批', 1.6], ['订单增长', 1.6], ['盈利增长', 1.5], ['创新高', 1.3], ['突破', 1], ['复苏', .8], ['补贴', .6]
  ];
  const negativeTerms = [
    ['退市', 3.5], ['财务造假', 3.5], ['立案调查', 3], ['债务违约', 3], ['业绩预亏', 2.8], ['重大亏损', 2.8],
    ['处罚', 2.2], ['减持', 2], ['诉讼', 1.8], ['质押', 1.5], ['终止', 1.5], ['问询函', 1.3], ['警示', 1.2],
    ['亏损', 1.2], ['下滑', 1], ['风险', .6]
  ];
  const seen = new Set();
  const normalized = sortNewsNewestFirst(news || []).filter(item => {
    const key = `${String(item?.title || '').replace(/\s+/g, '')}|${String(item?.link || '')}`;
    if (!item?.title || seen.has(key)) return false;
    seen.add(key);
    const timestamp = newsTimestamp(item.publishedAt);
    return !since || timestamp >= since;
  }).slice(0, 12).map(item => {
    const text = `${item.title || ''} ${item.summary || ''}`;
    const timestamp = newsTimestamp(item.publishedAt);
    const ageHours = timestamp ? Math.max(0, (now - timestamp) / 36e5) : null;
    const recencyWeight = ageHours === null ? .15 : ageHours <= 6 ? 1 : ageHours <= 24 ? .9 : ageHours <= 72 ? .7 : ageHours <= 168 ? .4 : ageHours <= 720 ? .18 : .08;
    const relevance = !subject && !code ? 1
      : (subject && text.includes(subject)) || (code && text.includes(code)) ? 1 : .12;
    const denied = /澄清|不实|不存在|未涉及|否认/.test(text);
    const positive = positiveTerms.filter(([term]) => text.includes(term));
    const negative = negativeTerms.filter(([term]) => text.includes(term));
    const positiveScore = positive.reduce((sum, [, weight]) => sum + weight, 0);
    const negativeScore = negative.reduce((sum, [, weight]) => sum + weight, 0) * (denied ? .25 : 1);
    const weightedScore = (positiveScore - negativeScore) * recencyWeight * relevance;
    return {
      ...item, ageHours, recencyWeight, relevance, weightedScore,
      sentiment: weightedScore >= .5 ? '偏积极' : weightedScore <= -.5 ? '偏谨慎' : '中性',
      positiveTerms: positive.map(([term]) => term), negativeTerms: negative.map(([term]) => term)
    };
  });
  const items = normalized.slice(0, 6);
  const relevantItems = normalized.filter(item => item.relevance >= .5);
  const rawScore = relevantItems.reduce((sum, item) => sum + item.weightedScore, 0);
  let signal = rawScore >= 1.2 ? '偏积极' : rawScore <= -1.2 ? '偏谨慎' : '中性';
  if (stale && signal === '偏积极') signal = '中性';
  const positive = [...new Set(relevantItems.flatMap(item => item.positiveTerms))];
  const negative = [...new Set(relevantItems.flatMap(item => item.negativeTerms))];
  const latestTimestamp = relevantItems.map(item => newsTimestamp(item.publishedAt)).filter(Boolean).sort((a, b) => b - a)[0] || 0;
  const latestPublishedAt = latestTimestamp ? new Date(latestTimestamp).toISOString() : '';
  const latestAgeHours = latestTimestamp ? Math.max(0, (now - latestTimestamp) / 36e5) : null;
  const freshness = stale ? '缓存数据' : latestAgeHours === null ? '发布时间未知' : latestAgeHours <= 24 ? '实时资讯' : latestAgeHours <= 72 ? '近期资讯' : '较早资讯';
  const available = relevantItems.length > 0;
  const factorScore = available ? clampRecommendationScore(stale && rawScore > 0 ? 50 : 50 + rawScore * 9) : null;
  const scoreAdjustment = !available || stale && rawScore > 0 ? 0 : Math.max(-16, Math.min(8, Math.round(rawScore * (rawScore < 0 ? 4 : 2))));
  const asOf = formatNewsTime(fetchedAt) || formatNewsTime(now);
  const latest = latestPublishedAt ? `${formatNewsTime(latestPublishedAt)}（${newsAgeLabel(latestAgeHours)}）` : '发布时间未知';
  const sourceLabel = options.source ? `，来源${options.source}` : '';
  const rangeLabel = sinceDate ? `${sinceDate}以来` : '近期';
  const staleNotice = stale ? '实时接口本次不可用，沿用缓存；缓存正向消息不作为买入确认。' : '';
  const summary = available
    ? `消息获取截至${asOf}${sourceLabel}，最新相关资讯${latest}；${rangeLabel}核验${relevantItems.length}条，时效加权判断${signal}${positive.length ? `；积极项：${positive.slice(0, 3).join('、')}` : ''}${negative.length ? `；风险项：${negative.slice(0, 3).join('、')}` : ''}。${staleNotice || '消息仅修正技术与资金信号，不单独构成推荐。'}`
    : `消息获取截至${asOf}，${rangeLabel}未取得与${subject || code || '市场'}直接相关的可核验资讯，按中性处理。${staleNotice}`;
  return {
    signal, summary, positive, negative, items, relevantItems: relevantItems.length, sinceDate,
    rawScore: Math.round(rawScore * 100) / 100, factorScore, scoreAdjustment, available,
    fetchedAt, latestPublishedAt, latestAgeHours, freshness, stale, source: options.source || ''
  };
}

async function fetchBingNews(keyword, cacheKey = keyword, maxAgeMs = 10 * 60 * 1000, force = false) {
  const cached = force ? null : readTimedCache(marketNewsCache, cacheKey, maxAgeMs);
  if (cached) return cached;
  const rss = await getText(`https://www.bing.com/news/search?q=${encodeURIComponent(keyword)}&format=rss&setlang=zh-CN`, { 'User-Agent': 'Mozilla/5.0' });
  return writeTimedCache(marketNewsCache, cacheKey, parseRssItems(rss));
}

function assessRecommendationTimingRisk(item) {
  const reasons = [];
  let penalty = 0;
  const dayPosition = item.high > item.low ? (item.price - item.low) / (item.high - item.low) : .5;
  if (dayPosition < .2 && item.changePct <= 0) {
    penalty += 35;
    reasons.push('收盘接近日内低点');
  } else if (dayPosition < .35) {
    penalty += 15;
    reasons.push('日内冲高回落');
  }
  if (item.analysis.breakoutPrice > 0 && item.high >= item.analysis.breakoutPrice
    && item.price < item.analysis.breakoutPrice && dayPosition < .4) {
    penalty += 25;
    reasons.push('突破后回落');
  }
  if (item.changePct >= 8) {
    penalty += 25;
    reasons.push('当日涨幅过大');
  } else if (item.changePct >= 6) {
    penalty += 12;
    reasons.push('当日涨幅偏大');
  }
  if (item.analysis.return5 > 20) {
    penalty += 25;
    reasons.push('近5日涨幅过大');
  } else if (item.analysis.return5 > 12) {
    penalty += 10;
    reasons.push('近5日涨幅偏快');
  }
  if (item.analysis.volatility20 > 120) {
    penalty += 20;
    reasons.push('20日波动率极高');
  } else if (item.analysis.volatility20 > 90) {
    penalty += 10;
    reasons.push('20日波动率偏高');
  }
  if (item.analysis.rsi14 >= 78) {
    penalty += 20;
    reasons.push('RSI接近超买区');
  } else if (item.analysis.rsi14 >= 74) {
    penalty += 8;
    reasons.push('RSI偏热');
  }
  if (item.analysis.ma20 > 0 && item.price > item.analysis.ma20 * 1.2) {
    penalty += 15;
    reasons.push('现价偏离MA20过大');
  }
  if (isExplosiveVolume(item.analysis.volumeRatio)) {
    penalty += 35;
    reasons.push('当日量比超过4倍，属于爆量');
  }
  return { penalty, reasons };
}

function assessReboundQuality(item) {
  const reasons = [];
  let score = 100;
  const timingRisk = assessRecommendationTimingRisk(item);
  score -= timingRisk.penalty;
  reasons.push(...timingRisk.reasons);
  const pe = Number(item.peRatio);
  const pb = Number(item.pbRatio);
  if (item.price < 3) { score -= 60; reasons.push('股价低于3元'); }
  else if (item.price < 5) { score -= 12; reasons.push('低价股波动风险'); }
  if ((item.amount || 0) < 8e7) { score -= 18; reasons.push('成交活跃度不足'); }
  if ((item.totalMarketCap || 0) > 0 && item.totalMarketCap < 2e9) { score -= 18; reasons.push('市值偏小'); }
  if (Number.isFinite(pe) && (pe <= 0 || pe > 150)) { score -= 45; reasons.push(pe <= 0 ? '静态估值为负' : '静态估值过高'); }
  else if (Number.isFinite(pe) && pe > 100) { score -= 22; reasons.push('静态估值偏高'); }
  if (Number.isFinite(pb) && pb > 15) { score -= 18; reasons.push('市净率过高'); }
  if ((item.turnoverRate || 0) > 18) { score -= 15; reasons.push('换手率过高'); }
  if (item.analysis.return20 < -12) { score -= 20; reasons.push('20日趋势仍明显下行'); }
  if (item.analysis.volume5Ratio < .6) { score -= 12; reasons.push('近5日量能不足'); }
  if (item.analysis.reboundSignal === '底部待反弹' && item.analysis.bottomDrawdown > -22) {
    score -= 35;
    reasons.push('回撤深度不足以确认底部反弹结构');
  }
  if (item.analysis.reboundScore < 65) { score -= 20; reasons.push('反弹综合评分不足'); }
  return { score: Math.max(0, Math.min(100, Math.round(score))), passed: score >= 65, reasons };
}

function assessBreakoutQuality(item) {
  const reasons = [];
  let score = 100;
  const timingRisk = assessRecommendationTimingRisk(item);
  score -= timingRisk.penalty;
  reasons.push(...timingRisk.reasons);
  const pe = Number(item.peRatio);
  const pb = Number(item.pbRatio);
  if (item.price < 3) { score -= 60; reasons.push('股价低于3元'); }
  else if (item.price < 5) { score -= 10; reasons.push('低价股波动风险'); }
  if ((item.amount || 0) < 8e7) { score -= 18; reasons.push('成交活跃度不足'); }
  if ((item.totalMarketCap || 0) > 0 && item.totalMarketCap < 2e9) { score -= 18; reasons.push('市值偏小'); }
  if (Number.isFinite(pe) && (pe <= 0 || pe > 180)) { score -= 35; reasons.push(pe <= 0 ? '静态估值为负' : '静态估值过高'); }
  else if (Number.isFinite(pe) && pe > 120) { score -= 18; reasons.push('静态估值偏高'); }
  if (Number.isFinite(pb) && pb > 18) { score -= 18; reasons.push('市净率过高'); }
  if ((item.turnoverRate || 0) > 18) { score -= 15; reasons.push('换手率过高'); }
  if (item.analysis.return20 < -8) { score -= 20; reasons.push('20日趋势仍偏弱'); }
  if (item.analysis.volume5Ratio < .6) { score -= 12; reasons.push('近5日量能不足'); }
  if (item.analysis.score < 55) { score -= 25; reasons.push('突破技术评分不足'); }
  return { score: Math.max(0, Math.min(100, Math.round(score))), passed: score >= 65, reasons };
}

function clampRecommendationScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function percentileScore(values, value) {
  const valid = values.map(finiteNumber).filter(item => item !== null).sort((a, b) => a - b);
  const numericValue = finiteNumber(value);
  if (!valid.length || numericValue === null) return 50;
  const below = valid.filter(item => item <= numericValue).length;
  return clampRecommendationScore((below / valid.length) * 100);
}

function resolveRecommendationIndustry(item, directoryByCode = null) {
  const code = String(item?.code || '').slice(-6);
  const candidates = [
    item?.industry,
    directoryByCode?.get(code)?.industry,
    item?.factorAnalysis?.sectorProfile?.name,
    item?.sector
  ];
  const value = candidates.map(cleanStockName).find(name => name && !['行业待确认', '未分类', '线上搜索', '-', '--'].includes(name));
  return value || '行业待确认';
}

function recommendationIndustryGroupKey(item, directoryByCode = null) {
  const industry = resolveRecommendationIndustry(item, directoryByCode);
  const code = String(item?.code || '').slice(-6) || 'unknown';
  return industry === '行业待确认' ? `未分类-${code}` : industry;
}

function buildRecommendationFactorContext(items) {
  const rows = (items || []).filter(item => item?.price > 0);
  const up = rows.filter(item => Number(item.changePct) > 0).length;
  const down = rows.filter(item => Number(item.changePct) < 0).length;
  const breadthRatio = up + down ? up / (up + down) : .5;
  const marketScore = clampRecommendationScore(35 + breadthRatio * 50);
  const sectors = new Map();
  rows.forEach(item => {
    const key = recommendationIndustryGroupKey(item);
    if (!sectors.has(key)) sectors.set(key, []);
    sectors.get(key).push(item);
  });
  const sectorProfiles = new Map([...sectors.entries()].map(([key, peers]) => {
    const name = resolveRecommendationIndustry(peers[0]);
    const changes = peers.map(item => finiteNumber(item.changePct)).filter(item => item !== null);
    const amounts = peers.map(item => finiteNumber(item.amount)).filter(item => item !== null);
    const averageChangePct = changes.length ? average(changes) : 0;
    const upRatio = changes.length ? changes.filter(value => value > 0).length / changes.length : .5;
    const score = clampRecommendationScore(50 + averageChangePct * 7 + (upRatio - .5) * 35);
    const label = score >= 72 ? '强势板块' : score >= 58 ? '活跃板块' : score < 42 ? '偏弱板块' : '中性板块';
    return [key, {
      name, count: peers.length, averageChangePct, upRatio,
      amount: amounts.reduce((sum, value) => sum + value, 0), score, label,
      changes, amounts
    }];
  }));
  return { breadth: { up, down, ratio: breadthRatio }, marketScore, sectorProfiles };
}

function formatCapitalAmount(value) {
  const number = Number(value) || 0;
  return Math.abs(number) >= 1e8 ? `${(Math.abs(number) / 1e8).toFixed(2)}亿` : `${(Math.abs(number) / 1e4).toFixed(0)}万`;
}

function fundFlowPeriodEvidence(flow) {
  if (!flow?.available) return '阶段主力资金数据不可用';
  const direction = flow.mainNetInflow >= 0 ? '净流入' : '净流出';
  const gross = flow.grossFlowsAvailable === false || flow.mainInflow == null || flow.mainOutflow == null
    ? '主力买入/卖出分项暂不可拆分'
    : `主力买入${formatCapitalAmount(flow.mainInflow)}、卖出${formatCapitalAmount(flow.mainOutflow)}`;
  return `近${flow.days}日${gross}，${direction}${formatCapitalAmount(flow.mainNetInflow)}，净流入${flow.positiveDays}日`;
}

function combineConsolidationBreakout(technical, flow) {
  if (!technical?.available) return {
    ...(technical || {}), available: false, status: technical?.status || '数据不足', score: 0,
    flowAdjustment: 0, summary: technical?.summary || '历史行情不足，暂不能评估横盘突破'
  };
  if (!technical.isConsolidating) return {
    ...technical,
    score: technical.technicalScore || 0,
    flowAdjustment: 0,
    flowAvailable: false
  };
  const flowAvailable = Boolean(flow?.available && flow.days);
  const persistentOutflow = flowAvailable && flow.mainNetInflow < 0
    && flow.netRatio <= -3 && flow.positiveDays <= Math.floor(flow.days * .4);
  const flowAdjustment = !flowAvailable ? 0
    : flow.mainNetInflow > 0 && flow.positiveDays >= Math.ceil(flow.days * .6) ? 10
      : flow.mainNetInflow > 0 ? 5 : persistentOutflow ? -18 : -8;
  const score = clampRecommendationScore(technical.technicalScore + flowAdjustment);
  const status = technical.status === '结构偏弱' || persistentOutflow ? '结构偏弱'
    : technical.breakoutConfirmed ? '突破确认'
      : flowAvailable && flow.mainNetInflow > 0 && score >= 75 && technical.distanceToBreakoutPct <= 4 ? '接近突破'
        : score >= 58 ? technical.status === '接近突破' ? '接近突破' : '突破蓄势' : '横盘观察';
  const flowEvidence = flowAvailable ? fundFlowPeriodEvidence(flow) : '阶段资金数据不足，不调整横盘技术评分';
  return {
    ...technical, score, status, flowAdjustment, flowAvailable,
    summary: `${technical.summary}；${flowEvidence}；综合状态${status}`
  };
}

function applyIndividualCapitalAssessment(analysis, flow) {
  const setup = analysis?.accumulationSetup || { passed: false, summary: '蓄势结构数据不足' };
  const available = Boolean(flow?.available && flow.days);
  const strongFlow = available && flow.mainNetInflow > 0
    && flow.positiveDays >= Math.ceil(flow.days * .6);
  const persistentOutflow = available && flow.mainNetInflow < 0
    && flow.netRatio <= -3 && flow.positiveDays <= Math.floor(flow.days * .4);
  const adjustment = !available ? 0
    : flow.mainNetInflow > 0 && flow.positiveDays >= Math.ceil(flow.days * .6) ? 6
      : flow.mainNetInflow > 0 ? 3 : persistentOutflow ? -8 : -4;
  const status = !available ? '资金数据不足'
    : setup.passed && adjustment >= 6 ? '蓄势增强'
      : setup.passed && flow.mainNetInflow <= 0 ? '资金未确认'
        : setup.passed ? '形态成立'
          : persistentOutflow ? '资金偏弱' : flow.mainNetInflow > 0 ? '资金改善' : '等待确认';
  const interpretation = status === '蓄势增强' ? '资金与形态相互确认'
    : status === '资金未确认' ? '形态成立，但阶段资金尚未确认'
      : status === '形态成立' ? '蓄势形态成立，资金强度仍需继续观察'
        : status === '资金偏弱' ? '阶段资金持续净流出，暂不支持低吸计划'
          : status === '资金改善' ? '阶段资金转强，但五线与三次放量结构尚未完整成立'
            : status === '资金数据不足' ? '本次不使用资金数据调整评分' : '资金与形态均需继续确认';
  const breakoutPotential = combineConsolidationBreakout(analysis.consolidationBreakout, flow);
  const breakoutWeak = breakoutPotential.status === '结构偏弱';
  let entryAssessment = analysis.entryAssessment;
  if (entryAssessment && (persistentOutflow || breakoutWeak)) {
    entryAssessment = {
      ...entryAssessment,
      allowed: false,
      status: persistentOutflow ? '资金未确认' : '结构偏弱',
      tone: 'negative',
      summary: persistentOutflow
        ? `${entryAssessment.summary} 但阶段主力资金持续净流出，当前不建议入场。`
        : `${entryAssessment.summary} 但横盘量价结构已转弱，当前不建议入场。`
    };
  } else if (entryAssessment?.lowBuyCandidate && strongFlow
    && ['bottom-accumulation', 'sideways-washout'].includes(entryAssessment.setupType)) {
    const setupLabel = entryAssessment.setupType === 'bottom-accumulation' ? '底部吸筹' : '震荡洗盘';
    const capitalEvidence = `近${flow.days}日阶段主力净流入${formatCapitalAmount(flow.mainNetInflow)}，净流入${flow.positiveDays}日`;
    entryAssessment = {
      ...entryAssessment,
      allowed: true,
      status: `${setupLabel}，可分批低吸`,
      tone: 'positive',
      summary: `${entryAssessment.summary} ${capitalEvidence}，资金与量价结构相互确认，可在支撑有效前提下分批低吸。`,
      evidence: [...new Set([...(entryAssessment.evidence || []), capitalEvidence])]
    };
  } else if (entryAssessment?.allowed && available && flow.mainNetInflow <= 0) {
    entryAssessment = { ...entryAssessment, allowed: false, status: '资金未确认', tone: 'warning', summary: `${entryAssessment.summary} 但阶段资金尚未转为净流入，等待资金确认后再入场。` };
  } else if (entryAssessment?.allowed && available && flow.mainNetInflow > 0) {
    entryAssessment = { ...entryAssessment, summary: `${entryAssessment.summary} 阶段主力净流入${formatCapitalAmount(flow.mainNetInflow)}，资金方向同步。` };
  } else if (entryAssessment?.lowBuyCandidate && available && flow.mainNetInflow <= 0) {
    entryAssessment = { ...entryAssessment, status: '资金未确认', tone: 'warning', summary: `${entryAssessment.summary} 阶段主力资金尚未转为净流入，当前只观察，不执行低吸。` };
  }
  const entryBlockedByFunds = Boolean(analysis.entryAssessment?.allowed && entryAssessment && !entryAssessment.allowed);
  const entryAllowed = Boolean(entryAssessment?.allowed);
  const verdict = entryAllowed ? '可关注'
    : (persistentOutflow || breakoutWeak || entryBlockedByFunds) && analysis.verdict === '可关注' ? '等待确认' : analysis.verdict;
  const buyCondition = entryAllowed ? entryAssessment.summary
    : persistentOutflow
      ? '阶段主力资金持续净流出，暂不执行低吸；等待净流入天数恢复并重新满足原技术条件后再评估。'
      : breakoutWeak
        ? '横盘结构已经转弱，暂不执行低吸；等待重新站回箱底并修复量价结构后再评估。'
        : analysis.buyCondition;
  return {
    ...analysis,
    score: analysis.score,
    capitalAdjustedScore: Math.max(0, Math.min(100, Math.round((analysis.score || 0) + adjustment))),
    verdict,
    buyCondition,
    tradePlan: analysis.tradePlan ? {
      ...analysis.tradePlan,
      enabled: entryAllowed ? true : persistentOutflow || breakoutWeak || entryBlockedByFunds ? false : analysis.tradePlan.enabled
    } : analysis.tradePlan,
    entryAssessment,
    breakoutPotential,
    capitalSetupAssessment: {
      status, scoreAdjustment: adjustment,
      summary: `阶段主力资金：${fundFlowPeriodEvidence(flow)}；${interpretation}。`
    }
  };
}

function applyEntryContextAssessment(analysis, { newsContext = null, riskProfile = null, marketOverview = null, marketNewsContext = null } = {}) {
  if (!analysis?.entryAssessment) return analysis;
  const entry = analysis.entryAssessment;
  const evidence = [...(entry.evidence || [])];
  const newsSignal = newsContext?.signal || '中性';
  const hasNews = Boolean(newsContext?.items?.length);
  evidence.push(hasNews ? `消息面${newsSignal}（${newsContext?.freshness || '时效未知'}）` : '消息面暂无可核验资讯');
  const marketNewsSignal = marketNewsContext?.signal || '中性';
  if (marketNewsContext?.available) evidence.push(`大盘实时消息${marketNewsSignal}（${marketNewsContext.freshness || '时效未知'}）`);

  const indexChanges = (marketOverview?.indices || []).map(item => Number(item.changePct)).filter(Number.isFinite);
  const indexAverage = indexChanges.length ? average(indexChanges) : null;
  const up = Number(marketOverview?.breadth?.up || 0);
  const down = Number(marketOverview?.breadth?.down || 0);
  const marketWeak = Number.isFinite(indexAverage) && indexAverage <= -1
    || down > 0 && down > up * 1.3;
  const marketStrong = Number.isFinite(indexAverage) && indexAverage >= .4
    || up > 0 && up > down * 1.3;
  const marketLabel = marketWeak ? '偏弱' : marketStrong ? '偏强' : '分化';
  evidence.push(`大盘环境${marketLabel}`);

  let entryAssessment = {
    ...entry,
    evidence: [...new Set(evidence)],
    summary: `${entry.summary} 消息面${hasNews ? `${newsSignal}（${newsContext?.freshness || '时效未知'}）` : '暂无可核验资讯'}，大盘环境${marketLabel}。`
  };
  if (riskProfile?.status === 'risk') {
    entryAssessment = { ...entryAssessment, allowed: false, status: '公司风险', tone: 'negative', summary: `${entryAssessment.summary} 未来半年存在已核验公司风险，当前不建议入场。` };
  } else if (newsSignal === '偏谨慎' && entryAssessment.allowed) {
    entryAssessment = { ...entryAssessment, allowed: false, status: '消息风险待确认', tone: 'warning', summary: `${entryAssessment.summary} 风险消息尚未消化，等待价格和资金重新确认。` };
  } else if (marketNewsSignal === '偏谨慎' && entryAssessment.allowed) {
    entryAssessment = { ...entryAssessment, allowed: false, status: '大盘消息风险待确认', tone: 'warning', summary: `${entryAssessment.summary} 大盘近期风险消息偏多，等待市场宽度和资金重新确认。` };
  } else if (marketWeak && entryAssessment.allowed) {
    entryAssessment = { ...entryAssessment, allowed: false, status: '大盘偏弱，等待确认', tone: 'warning', summary: `${entryAssessment.summary} 市场下跌家数或指数跌幅偏大，暂缓入场。` };
  }
  const blocked = Boolean(entry.allowed && !entryAssessment.allowed);
  const verdict = entryAssessment.status === '公司风险' ? '暂不适合介入'
    : blocked && analysis.verdict === '可关注' ? '等待确认' : analysis.verdict;
  return {
    ...analysis,
    verdict,
    buyCondition: blocked ? entryAssessment.summary : analysis.buyCondition,
    tradePlan: blocked && analysis.tradePlan ? { ...analysis.tradePlan, enabled: false } : analysis.tradePlan,
    entryAssessment
  };
}

function buildSupplyDemandScore({ volumeRatio, turnover, amount }) {
  const volume = finiteNumber(volumeRatio);
  const turnoverRate = finiteNumber(turnover);
  const tradedAmount = finiteNumber(amount);
  const parts = [];
  if (volume !== null) parts.push(isExplosiveVolume(volume) ? 20 : isControlledVolumeExpansion(volume) ? 88 : volume >= 1 ? 72 : volume >= .7 ? 55 : 35);
  if (turnoverRate !== null) parts.push(turnoverRate >= 1 && turnoverRate <= 10 ? 78 : turnoverRate > 10 && turnoverRate <= 18 ? 58 : turnoverRate > 18 ? 32 : 52);
  if (tradedAmount !== null && tradedAmount > 0) parts.push(tradedAmount >= 1e9 ? 88 : tradedAmount >= 3e8 ? 74 : tradedAmount >= 8e7 ? 58 : 35);
  return {
    available: parts.length > 0,
    score: parts.length ? clampRecommendationScore(average(parts)) : null,
    evidence: `量比${volume !== null ? volume.toFixed(2) : '未提供'}，换手${turnoverRate !== null ? turnoverRate.toFixed(2) + '%' : '未提供'}，成交额${tradedAmount !== null && tradedAmount > 0 ? (tradedAmount / 1e8).toFixed(2) + '亿' : '未提供'}`
  };
}

function evaluateRecommendationFactors(item, context, newsContext, financialAnalysis = null) {
  const sector = context?.sectorProfiles?.get(recommendationIndustryGroupKey(item));
  const factors = [];
  const add = (key, label, score, evidence, available = true) => factors.push({
    key, label, available, score: available ? clampRecommendationScore(score) : null, evidence
  });

  const pe = finiteNumber(item.peRatio);
  const pb = finiteNumber(item.pbRatio);
  const valuationParts = [];
  if (pe !== null) valuationParts.push(pe > 0 && pe <= 45 ? 82 : pe > 0 && pe <= 80 ? 65 : pe > 0 && pe <= 120 ? 48 : 20);
  if (pb !== null) valuationParts.push(pb > 0 && pb <= 5 ? 82 : pb > 0 && pb <= 10 ? 62 : pb > 0 && pb <= 18 ? 45 : 22);
  add('valuation', '估值质量', valuationParts.length ? average(valuationParts) : 0,
    valuationParts.length ? `PE ${pe !== null ? pe.toFixed(1) : '未提供'}，PB ${pb !== null ? pb.toFixed(1) : '未提供'}` : '行情接口未提供有效PE/PB', valuationParts.length > 0);

  const volumeRatio = finiteNumber(item.analysis?.volumeRatio ?? item.snapshotVolumeRatio);
  const demand = buildSupplyDemandScore({ volumeRatio, turnover: item.turnoverRate, amount: item.amount });
  add('supplyDemand', '供需量能', demand.score || 0, demand.evidence, demand.available);

  const flow = item.fundFlowPeriod;
  const flowScore = flow?.available
    ? clampRecommendationScore(50 + Number(flow.netRatio || 0) * 5 + (flow.positiveDays / flow.days - .5) * 45) : 0;
  add('capitalAccumulation', '阶段主力资金', flowScore, fundFlowPeriodEvidence(flow), Boolean(flow?.available));

  const relativeStrength = percentileScore(context?.relativeReturns || [], item.analysis?.return60);
  const leadershipScore = sector
    ? average([relativeStrength, percentileScore(sector.changes, item.changePct), percentileScore(sector.amounts, item.amount), sector.score]) : 0;
  add('leadership', '板块领先', leadershipScore,
    sector ? `${sector.name}${sector.label}，近60日相对强度分位${relativeStrength}，并结合板块内涨幅与成交活跃度` : '行业分类不可用', Boolean(sector));
  add('market', '市场方向', context?.marketScore || 0,
    context?.breadth ? `全市场上涨${context.breadth.up}只、下跌${context.breadth.down}只` : '全市场宽度不可用', Boolean(context?.breadth));

  const newsAvailable = Boolean(newsContext?.items?.length);
  add('catalyst', '成长/创新催化', newsContext?.factorScore ?? (newsContext?.signal === '偏积极' ? 82 : newsContext?.signal === '偏谨慎' ? 25 : 50),
    newsAvailable ? newsContext.summary : '未获取到可核验的近期消息', newsAvailable);
  add('currentEarnings', 'C 当季盈利', financialAnalysis?.current?.score || 0,
    financialAnalysis?.current?.evidence || '季度EPS/净利润增长序列不可用', Boolean(financialAnalysis?.current?.available));
  add('annualEarnings', 'A 年度盈利', financialAnalysis?.annual?.score || 0,
    financialAnalysis?.annual?.evidence || '近三年EPS与ROE序列不可用', Boolean(financialAnalysis?.annual?.available));
  add('financialQuality', '价值质量', financialAnalysis?.quality?.score || 0,
    financialAnalysis?.quality?.evidence || '现金流、负债与盈利质量数据不可用', Boolean(financialAnalysis?.quality?.available));
  add('institution', '机构认同', 0, '现有接口未提供可追溯的机构持仓变化', false);

  const available = factors.filter(factor => factor.available);
  return {
    score: available.length ? clampRecommendationScore(average(available.map(factor => factor.score))) : null,
    available: available.length,
    total: factors.length,
    factors,
    scope: '全市场横截面',
    sectorProfile: sector ? {
      name: sector.name, count: sector.count, averageChangePct: sector.averageChangePct,
      upRatio: sector.upRatio, amount: sector.amount, score: sector.score, label: sector.label
    } : null
  };
}

function groupRecommendationsByIndustry(items) {
  const groups = new Map();
  (items || []).forEach(item => {
    const industry = resolveRecommendationIndustry(item);
    item = { ...item, industry };
    if (!groups.has(industry)) groups.set(industry, []);
    groups.get(industry).push(item);
  });
  return [...groups.values()]
    .map(group => group.sort((a, b) => Number(b.signalScore) - Number(a.signalScore)))
    .sort((a, b) => {
      const sectorDifference = Number(b[0]?.factorAnalysis?.sectorProfile?.score || 0) - Number(a[0]?.factorAnalysis?.sectorProfile?.score || 0);
      return sectorDifference || Number(b[0]?.signalScore || 0) - Number(a[0]?.signalScore || 0);
    })
    .flat();
}

function recommendationSignalFamily(signal) {
  if (signal === '底部待反弹') return 'bottomWaiting';
  if (signal === '已反弹') return 'rebounded';
  if (['底部吸筹', '震荡洗盘'].includes(signal)) return 'structure';
  if (['待突破', '横盘观察', '突破蓄势', '接近突破', '突破确认'].includes(signal)) return 'breakout';
  return 'other';
}

function recommendationScoreBand(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return '';
  if (value < 55) return '<55';
  if (value < 65) return '55-64';
  if (value < 75) return '65-74';
  return '75+';
}

function mergeRecommendationOutcomeQuotes(rows, quotes) {
  const quoteByCode = new Map((Array.isArray(quotes) ? quotes : [])
    .filter(quote => /^\d{6}$/.test(String(quote?.code || '')) && Number(quote?.price) > 0)
    .map(quote => [String(quote.code), Number(quote.price)]));
  return (Array.isArray(rows) ? rows : []).map(row => {
    const price = quoteByCode.get(String(row?.code || ''));
    return price ? { ...row, price } : row;
  });
}

function selectRecentOutcomeSamples(samples, currentTime, recentDays, minimumCount = 20) {
  const cutoff = currentTime - recentDays * 864e5;
  const selected = new Set(samples.filter(row => row.addedAt >= cutoff));
  let extended = false;
  if (selected.size < minimumCount) {
    const cohorts = [...new Set(samples.map(row => row.label))].map(label => ({
      label,
      rows: samples.filter(row => row.label === label),
      addedAt: Math.max(...samples.filter(row => row.label === label).map(row => row.addedAt))
    })).sort((left, right) => right.addedAt - left.addedAt);
    for (const cohort of cohorts) {
      if ([...selected].some(row => row.label === cohort.label)) continue;
      cohort.rows.forEach(row => selected.add(row));
      extended = true;
      if (selected.size >= minimumCount) break;
    }
  }
  const recentSamples = [...selected];
  return {
    samples: recentSamples,
    extended,
    cohortCount: new Set(recentSamples.map(row => row.label)).size,
    windowDays: recentSamples.length
      ? roundMetric(Math.max(...recentSamples.map(row => currentTime - row.addedAt)) / 864e5, 1)
      : recentDays
  };
}

function recommendationOutcomeStats(rows) {
  if (!rows.length) return null;
  const returns = rows.map(row => row.returnPct).sort((a, b) => a - b);
  const excessReturns = rows.map(row => row.excessReturnPct).sort((a, b) => a - b);
  const middle = Math.floor(returns.length / 2);
  const median = returns.length % 2 ? returns[middle] : (returns[middle - 1] + returns[middle]) / 2;
  const excessMedian = excessReturns.length % 2 ? excessReturns[middle] : (excessReturns[middle - 1] + excessReturns[middle]) / 2;
  return {
    count: rows.length,
    cohortCount: new Set(rows.map(row => row.label).filter(Boolean)).size,
    averageReturn: roundMetric(average(returns), 2),
    medianReturn: roundMetric(median, 2),
    winRate: roundMetric(rows.filter(row => row.returnPct > 0).length / rows.length * 100, 1),
    averageExcessReturn: roundMetric(average(excessReturns), 2),
    medianExcessReturn: roundMetric(excessMedian, 2),
    outperformRate: roundMetric(rows.filter(row => row.excessReturnPct > 0).length / rows.length * 100, 1)
  };
}

function summarizeRecommendationOutcomes(rows, { now = Date.now(), minimumAgeDays = 1, recentDays = 4, minimumRecentSamples = 20 } = {}) {
  const parsedNow = typeof now === 'number' ? now : Date.parse(now);
  const currentTime = Number.isFinite(parsedNow) ? parsedNow : Date.now();
  let excludedCount = 0;
  let immatureCount = 0;
  let invalidCount = 0;
  const eligible = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const label = String(row?.label || '').trim();
    if (label === '重点关注' || label.toLowerCase() === 'personal') {
      excludedCount++;
      continue;
    }
    const base = Number(row?.favoriteBasePrice);
    const price = Number(row?.price);
    const addedAt = Date.parse(row?.favoriteAddedAt || '');
    if (!(base > 0) || !(price > 0) || !Number.isFinite(addedAt)) {
      invalidCount++;
      continue;
    }
    if ((currentTime - addedAt) / 864e5 < minimumAgeDays) {
      immatureCount++;
      continue;
    }
    const signal = String(row?.signal || '').trim();
    eligible.push({
      label,
      addedAt,
      signal,
      family: recommendationSignalFamily(signal),
      scoreBand: row?.signalScore === null || row?.signalScore === '' ? '' : recommendationScoreBand(row.signalScore),
      technicalScoreBand: row?.technicalScore === null || row?.technicalScore === '' ? '' : recommendationScoreBand(row.technicalScore),
      returnPct: (price / base - 1) * 100
    });
  }
  const cohortMedians = new Map();
  for (const label of [...new Set(eligible.map(row => row.label))]) {
    const returns = eligible.filter(row => row.label === label).map(row => row.returnPct).sort((a, b) => a - b);
    const middle = Math.floor(returns.length / 2);
    cohortMedians.set(label, returns.length % 2 ? returns[middle] : (returns[middle - 1] + returns[middle]) / 2);
  }
  const samples = eligible.map(row => ({ ...row, excessReturnPct: row.returnPct - cohortMedians.get(row.label) }));
  const recentSelection = selectRecentOutcomeSamples(samples, currentTime, recentDays, minimumRecentSamples);
  const recentSamples = recentSelection.samples;
  const byFamily = {};
  const bySignal = {};
  const byScoreBand = {};
  const byTechnicalScoreBand = {};
  const byRecentFamily = {};
  const byRecentSignal = {};
  const byRecentScoreBand = {};
  const byRecentTechnicalScoreBand = {};
  for (const family of [...new Set(samples.map(row => row.family))]) {
    byFamily[family] = recommendationOutcomeStats(samples.filter(row => row.family === family));
  }
  for (const signal of [...new Set(samples.map(row => row.signal).filter(Boolean))]) {
    bySignal[signal] = recommendationOutcomeStats(samples.filter(row => row.signal === signal));
  }
  for (const band of [...new Set(samples.map(row => row.scoreBand).filter(Boolean))]) {
    byScoreBand[band] = recommendationOutcomeStats(samples.filter(row => row.scoreBand === band));
  }
  for (const band of [...new Set(samples.map(row => row.technicalScoreBand).filter(Boolean))]) {
    byTechnicalScoreBand[band] = recommendationOutcomeStats(samples.filter(row => row.technicalScoreBand === band));
  }
  for (const family of [...new Set(recentSamples.map(row => row.family))]) {
    byRecentFamily[family] = recommendationOutcomeStats(recentSamples.filter(row => row.family === family));
  }
  for (const signal of [...new Set(recentSamples.map(row => row.signal).filter(Boolean))]) {
    byRecentSignal[signal] = recommendationOutcomeStats(recentSamples.filter(row => row.signal === signal));
  }
  for (const band of [...new Set(recentSamples.map(row => row.scoreBand).filter(Boolean))]) {
    byRecentScoreBand[band] = recommendationOutcomeStats(recentSamples.filter(row => row.scoreBand === band));
  }
  for (const band of [...new Set(recentSamples.map(row => row.technicalScoreBand).filter(Boolean))]) {
    byRecentTechnicalScoreBand[band] = recommendationOutcomeStats(recentSamples.filter(row => row.technicalScoreBand === band));
  }
  const recentOverall = recommendationOutcomeStats(recentSamples);
  const marketRisk = recentOverall?.count >= minimumRecentSamples && recentOverall.averageReturn <= -2 && recentOverall.winRate < 35
    ? { status: 'drawdown', ...recentOverall }
    : { status: 'normal', ...(recentOverall || {}) };
  const profile = {
    sampleSize: samples.length,
    minimumAgeDays,
    recentDays,
    recentWindowDays: recentSelection.windowDays,
    recentCohortCount: recentSelection.cohortCount,
    recentExtended: recentSelection.extended,
    excludedCount,
    immatureCount,
    invalidCount,
    overall: recommendationOutcomeStats(samples),
    recentOverall,
    marketRisk,
    byFamily,
    bySignal,
    byScoreBand,
    byTechnicalScoreBand,
    byRecentFamily,
    byRecentSignal,
    byRecentScoreBand,
    byRecentTechnicalScoreBand
  };
  profile.signature = JSON.stringify({
    sampleSize: profile.sampleSize,
    marketRisk: marketRisk.status,
    recentCohorts: profile.recentCohortCount,
    recentSignals: Object.fromEntries(Object.entries(byRecentSignal).map(([key, stats]) => [key, [stats.count, outcomeStatsAdjustment(stats, 8)]])),
    recentScoreBands: Object.fromEntries(Object.entries(byRecentScoreBand).map(([key, stats]) => [key, [stats.count, outcomeStatsAdjustment(stats, 8)]])),
    recentTechnicalScoreBands: Object.fromEntries(Object.entries(byRecentTechnicalScoreBand).map(([key, stats]) => [key, [stats.count, outcomeStatsAdjustment(stats, 8)]]))
  });
  return profile;
}

function outcomeStatsAdjustment(stats, minimumCount) {
  if (!stats || Number(stats.count) < minimumCount) return 0;
  if (Number(stats.outperformRate) < 35 && Number(stats.medianExcessReturn) < -.5) return -6;
  if (Number(stats.outperformRate) < 45 && Number(stats.medianExcessReturn) < -.5) return -4;
  if (Number(stats.outperformRate) < 50 && Number(stats.averageExcessReturn) <= -1 && Number(stats.medianExcessReturn) < -.5) return -4;
  if (Number(stats.outperformRate) >= 65 && Number(stats.medianExcessReturn) >= .5) return 5;
  if (Number(stats.outperformRate) >= 55 && Number(stats.averageExcessReturn) >= 1) return 2;
  return 0;
}

function signedPercent(value) {
  const number = Number(value) || 0;
  return `${number >= 0 ? '+' : ''}${number.toFixed(2)}%`;
}

function hasRecentOutcomeEvidence(stats) {
  return Number(stats?.count) >= 8
    || Number(stats?.count) >= 6 && Number(stats?.cohortCount) >= 2;
}

function calibrateRecommendationWithOutcomes(item, profile) {
  const family = recommendationSignalFamily(item?.signal);
  const recentSignalStats = profile?.byRecentSignal?.[item?.signal];
  const signalStats = profile?.bySignal?.[item?.signal];
  const recentFamilyStats = profile?.byRecentFamily?.[family];
  const allFamilyStats = profile?.byFamily?.[family];
  const familyStats = hasRecentOutcomeEvidence(recentSignalStats) ? recentSignalStats
    : Number(signalStats?.count) >= 12 ? signalStats
      : hasRecentOutcomeEvidence(recentFamilyStats) ? recentFamilyStats
        : Number(allFamilyStats?.count) >= 12 ? allFamilyStats : null;
  const recent = familyStats === recentSignalStats || familyStats === recentFamilyStats;
  const scoreBand = recommendationScoreBand(item?.signalScore ?? item?.score);
  const recentScoreStats = profile?.byRecentScoreBand?.[scoreBand];
  const scoreStats = hasRecentOutcomeEvidence(recentScoreStats) ? recentScoreStats : profile?.byScoreBand?.[scoreBand] || null;
  const technicalScoreBand = recommendationScoreBand(item?.technicalScore);
  const recentTechnicalStats = profile?.byRecentTechnicalScoreBand?.[technicalScoreBand];
  const longTermTechnicalStats = profile?.byTechnicalScoreBand?.[technicalScoreBand] || null;
  const technicalStats = hasRecentOutcomeEvidence(recentTechnicalStats)
    ? recentTechnicalStats : longTermTechnicalStats;
  const technicalRecent = technicalStats === recentTechnicalStats;
  const familyAdjustment = outcomeStatsAdjustment(familyStats, recent ? 6 : 12);
  const scoreAdjustment = outcomeStatsAdjustment(scoreStats, scoreStats === recentScoreStats ? 6 : 8);
  const technicalAdjustment = outcomeStatsAdjustment(technicalStats, technicalStats === recentTechnicalStats ? 6 : 8);
  const adjustment = Math.max(-10, Math.min(8, familyAdjustment + scoreAdjustment + technicalAdjustment));
  const familyLabel = { breakout: '突破类', rebounded: '反弹类', bottomWaiting: '待反弹类', structure: '吸筹/洗盘类', other: '其他类' }[family];
  const label = familyStats === recentSignalStats || familyStats === signalStats
    ? item?.signal || '同类信号' : familyLabel;
  const summary = familyStats
    ? `${label}${recent ? '近期' : ''}同类样本${familyStats.count}条，平均累计${signedPercent(familyStats.averageReturn)}，同批次平均${familyStats.averageExcessReturn >= 0 ? '跑赢' : '跑输'}${Math.abs(Number(familyStats.averageExcessReturn)).toFixed(2)}%，超额胜率${Number(familyStats.outperformRate).toFixed(1)}%`
    : '本地同类推荐样本不足，暂不调整';
  const technicalSummary = technicalStats
    ? `；${technicalRecent ? '近期' : ''}技术分${technicalScoreBand}样本${technicalStats.count}条，平均累计${signedPercent(technicalStats.averageReturn)}，胜率${Number(technicalStats.winRate).toFixed(1)}%，同批次平均${technicalStats.averageExcessReturn >= 0 ? '跑赢' : '跑输'}${Math.abs(Number(technicalStats.averageExcessReturn)).toFixed(2)}%`
    : '';
  const longTermTechnicalSummary = technicalRecent && Number(longTermTechnicalStats?.count) > Number(technicalStats?.count)
    ? `；长期技术分${technicalScoreBand}样本${longTermTechnicalStats.count}条，平均累计${signedPercent(longTermTechnicalStats.averageReturn)}，胜率${Number(longTermTechnicalStats.winRate).toFixed(1)}%，同批次平均${longTermTechnicalStats.averageExcessReturn >= 0 ? '跑赢' : '跑输'}${Math.abs(Number(longTermTechnicalStats.averageExcessReturn)).toFixed(2)}%`
    : '';
  return {
    family,
    scoreBand,
    technicalScoreBand,
    adjustment,
    familyAdjustment,
    scoreAdjustment,
    technicalAdjustment,
    caution: familyAdjustment < 0 || technicalAdjustment < 0,
    familyStats,
    scoreStats,
    technicalStats,
    longTermTechnicalStats,
    technicalRecent,
    recent,
    summary: `${summary}${technicalSummary}${longTermTechnicalSummary}`
  };
}

function recommendationPassesOutcomeGate(item) {
  return Number(item?.signalScore) >= 65
    && Number(item?.technicalScore) >= 65
    && ['突破确认', '突破蓄势', '接近突破', '底部吸筹', '震荡洗盘'].includes(item?.signal);
}

function applyOutcomeFeedbackAssessment(analysis, profile) {
  if (!analysis || !profile?.sampleSize) return analysis;
  const signal = analysis.entryAssessment?.setupType === 'bottom-accumulation' ? '底部吸筹'
    : analysis.entryAssessment?.setupType === 'sideways-washout' ? '震荡洗盘'
      : analysis.reboundSignal === '已反弹' ? '已反弹'
        : analysis.reboundSignal === '底部待反弹' ? '底部待反弹'
          : '待突破';
  const outcome = calibrateRecommendationWithOutcomes({ signal, technicalScore: analysis.score }, profile);
  const strategyDrawdown = profile.marketRisk?.status === 'drawdown';
  const severeTechnicalHistory = outcome.technicalScoreBand === '<55'
    && [outcome.technicalStats, outcome.longTermTechnicalStats].some(stats => Number(stats?.count) >= 20
      && Number(stats?.averageReturn) <= -5
      && Number(stats?.winRate) < 20);
  const middleTechnicalHistory = outcome.technicalScoreBand === '55-64'
    && [outcome.technicalStats, outcome.longTermTechnicalStats].some(stats => Number(stats?.count) >= 20
      && (Number(stats?.averageReturn) < .5 || Number(stats?.winRate) < 50));
  const riskSummary = strategyDrawdown
    ? `最近${profile.recentCohortCount || '--'}个版本成熟推荐${profile.marketRisk.count}条，平均累计${signedPercent(profile.marketRisk.averageReturn)}、胜率${Number(profile.marketRisk.winRate).toFixed(1)}%，处于策略回撤。`
    : '';
  if (!outcome.familyStats && !outcome.technicalStats && !strategyDrawdown) return { ...analysis, historicalOutcomeAssessment: outcome };
  const currentStrong = Number(analysis.score) >= 70
    && Number(analysis.capitalAdjustedScore ?? analysis.score) >= 70
    && Number(analysis.capitalSetupAssessment?.scoreAdjustment || 0) >= 3;
  const downgradeBasis = strategyDrawdown ? '历史结果和策略回撤' : '历史结果';
  const summary = `${outcome.summary}。${riskSummary}${outcome.caution || strategyDrawdown || severeTechnicalHistory || middleTechnicalHistory
    ? currentStrong ? '当前技术与资金确认较强，不据此一票否决。' : `当前确认不足，${downgradeBasis}只作为降级依据，不替代实时行情判断。`
    : '历史结果仅用于辅助判断，不替代实时行情、资金和消息。'}`;
  const feedbackGate = (outcome.caution || strategyDrawdown)
    && analysis.entryAssessment?.allowed && !currentStrong;
  if (!severeTechnicalHistory && !middleTechnicalHistory && !feedbackGate) {
    return { ...analysis, historicalOutcomeAssessment: { ...outcome, summary } };
  }
  const preserveCurrentStatus = ['破位', '爆量观察', '结构偏弱', '不宜追高', '公司风险']
    .includes(analysis.entryAssessment?.status);
  const entryAssessment = {
    ...analysis.entryAssessment,
    allowed: false,
    status: severeTechnicalHistory && !preserveCurrentStatus ? '历史同类技术分偏弱，不建议入场'
      : middleTechnicalHistory && !preserveCurrentStatus ? '历史技术分未达到有效区间，等待确认'
      : feedbackGate ? outcome.caution ? '历史样本偏弱，等待确认' : '策略回撤，等待确认'
        : analysis.entryAssessment.status,
    tone: 'warning',
    summary: `${analysis.entryAssessment.summary} ${summary}`,
    evidence: [...new Set([...(analysis.entryAssessment.evidence || []), outcome.summary])]
  };
  return {
    ...analysis,
    verdict: severeTechnicalHistory ? '暂不适合'
      : middleTechnicalHistory && analysis.verdict === '可关注' ? '等待确认'
      : analysis.verdict === '可关注' ? '等待确认' : analysis.verdict,
    buyCondition: entryAssessment.summary,
    tradePlan: analysis.tradePlan ? { ...analysis.tradePlan, enabled: false } : analysis.tradePlan,
    entryAssessment,
    historicalOutcomeAssessment: { ...outcome, summary }
  };
}

function restoreCachedMarketRecommendations(result, cachedOverview, marketQuotes = []) {
  if ((result.recommendations || []).length || !(cachedOverview?.recommendations || []).length) return false;
  const eligibleRecommendations = cachedOverview.recommendations.filter(item =>
    recommendationPassesOutcomeGate(item)
    && !['破位', '爆量观察', '结构偏弱', '不宜追高', '公司风险'].includes(item.entryAssessment?.status)
  );
  if (!eligibleRecommendations.length) return false;
  const quoteByCode = new Map((marketQuotes || []).map(item => [item.code, item]));
  result.recommendations = eligibleRecommendations.map(item => {
    const quote = quoteByCode.get(item.code);
    const entryAssessment = item.entryAssessment || {
      allowed: false, status: '数据待补充', tone: 'neutral',
      summary: '当前为旧缓存推荐，需刷新走势、资金、消息面和大盘数据后重新评估。', evidence: []
    };
    const reason = /综合入场/.test(item.reason || '')
      ? item.reason : `${item.reason ? item.reason.replace(/[。；;]+$/, '') + '；' : ''}综合入场：${entryAssessment.status}，${entryAssessment.summary}`;
    return {
      ...item,
      ...(quote ? {
        price: quote.price, change: quote.change, changePct: quote.changePct,
        high: quote.high, low: quote.low, open: quote.open, prevClose: quote.prevClose,
        amount: quote.amount, totalMarketCap: quote.totalMarketCap, floatMarketCap: quote.floatMarketCap,
        fetchedAt: quote.fetchedAt || item.fetchedAt
      } : {}),
      industry: resolveRecommendationIndustry(item),
      entryAssessment,
      reason
    };
  });
  const signals = result.recommendations.reduce((counts, item) => {
    counts[recommendationSignalFamily(item.signal)] += 1;
    return counts;
  }, { bottomWaiting: 0, rebounded: 0, breakout: 0, structure: 0, other: 0 });
  result.recommendationCoverage = {
    ...(cachedOverview.recommendationCoverage || {}),
    scanned: marketQuotes.length || cachedOverview.recommendationCoverage?.scanned || 0,
    qualified: result.recommendations.length,
    signals,
    cachedFallback: true,
    cachedAt: cachedOverview.fetchedAt || ''
  };
  result.recommendationFallback = {
    active: true,
    cachedAt: cachedOverview.fetchedAt || '',
    reason: '本轮推荐计算未返回结果，已保留最近一次成功推荐并刷新可用行情'
  };
  return true;
}

function buildCanslimFromFactors(factorAnalysis) {
  const factors = factorAnalysis?.factors || [];
  const mapping = [
    ['C', '当季盈利', 'currentEarnings', 15], ['A', '年度盈利', 'annualEarnings', 15],
    ['N', '创新变化', 'catalyst', 15], ['S', '供需关系', 'supplyDemand', 15],
    ['L', '行业领先', 'leadership', 15], ['I', '机构认可', 'institution', 15],
    ['M', '市场方向', 'market', 10]
  ];
  const dimensions = mapping.map(([key, label, factorKey, max]) => {
    const factor = factors.find(item => item.key === factorKey);
    const available = Boolean(factor?.available);
    return {
      key, label, max, available,
      score: available ? Math.round(Number(factor.score) / 100 * max * 10) / 10 : null,
      evidence: factor?.evidence || '数据不可用'
    };
  });
  const available = dimensions.filter(item => item.available);
  const earned = available.reduce((sum, item) => sum + item.score, 0);
  const availableMax = available.reduce((sum, item) => sum + item.max, 0);
  return {
    score: availableMax ? clampRecommendationScore(earned / availableMax * 100) : null,
    rawScore: Math.round(earned * 10) / 10,
    availableMax, available: available.length, total: dimensions.length, dimensions,
    scope: factorAnalysis?.scope || '可验证数据',
    note: '总分仅按可核验维度归一化；缺失维度不按零分处理，也不视为已通过。'
  };
}

function buildIndividualInvestmentAnalysis({ technical, financial, newsContext, quote, marketOverview, marketNewsContext = null }) {
  const indices = marketOverview?.indices || [];
  const marketChanges = indices.map(item => finiteNumber(item.changePct)).filter(item => item !== null);
  const averageMarketChange = marketChanges.length ? average(marketChanges) : null;
  const marketUp = Number(marketOverview?.breadth?.up || 0);
  const marketDown = Number(marketOverview?.breadth?.down || 0);
  const baseMarketScore = marketUp + marketDown
    ? clampRecommendationScore(35 + marketUp / (marketUp + marketDown) * 50)
    : averageMarketChange === null ? null : clampRecommendationScore(55 + averageMarketChange * 12);
  const marketNewsAdjustment = marketNewsContext?.signal === '偏积极' ? 5 : marketNewsContext?.signal === '偏谨慎' ? -10 : 0;
  const marketScore = baseMarketScore === null ? null : clampRecommendationScore(baseMarketScore + marketNewsAdjustment);
  const marketEvidenceBase = marketUp + marketDown
    ? `全市场上涨${marketUp}只、下跌${marketDown}只`
    : averageMarketChange === null ? '大盘方向数据不可用' : `主要指数平均涨跌${averageMarketChange.toFixed(2)}%`;
  const marketEvidence = `${marketEvidenceBase}${marketNewsContext?.available ? `；实时市场消息${marketNewsContext.signal}` : ''}`;
  const supplyDemand = buildSupplyDemandScore({
    volumeRatio: technical?.volumeRatio,
    turnover: quote?.turnoverRate,
    amount: quote?.amount
  });
  const factors = [
    { key:'currentEarnings', available:Boolean(financial?.current?.available), score:financial?.current?.score ?? null, evidence:financial?.current?.evidence || '季度盈利数据不可用' },
    { key:'annualEarnings', available:Boolean(financial?.annual?.available), score:financial?.annual?.score ?? null, evidence:financial?.annual?.evidence || '年度盈利数据不可用' },
    { key:'catalyst', available:Boolean(newsContext?.available ?? newsContext?.items?.length), score:newsContext?.factorScore ?? (newsContext?.signal === '偏积极' ? 82 : newsContext?.signal === '偏谨慎' ? 25 : 50), evidence:newsContext?.items?.length ? newsContext.summary : '近期可核验消息不可用' },
    { key:'supplyDemand', available:supplyDemand.available, score:supplyDemand.score, evidence:supplyDemand.available ? supplyDemand.evidence : '供需数据不可用' },
    { key:'leadership', available:Boolean(technical), score:technical ? clampRecommendationScore(50 + Number(technical.return60 || 0) * 1.5) : null, evidence:technical ? `近60日涨跌${Number(technical.return60 || 0).toFixed(1)}%；个股当日${averageMarketChange === null ? '无法比较大盘' : Number(quote?.changePct || 0) >= averageMarketChange ? '强于或不弱于大盘' : '弱于大盘'}` : '相对强弱数据不可用' },
    { key:'institution', available:false, score:null, evidence:'机构持仓与增减持序列未接入，不推测' },
    { key:'market', available:marketScore !== null, score:marketScore, evidence:marketEvidence }
  ];
  const canslim = buildCanslimFromFactors({ factors, scope: '个股实时分析' });
  const pe = finiteNumber(quote?.peRatio);
  const pb = finiteNumber(quote?.pbRatio);
  const valuationParts = [];
  if (pe !== null) valuationParts.push(pe > 0 && pe <= 45 ? 80 : pe > 0 && pe <= 80 ? 62 : 30);
  if (pb !== null) valuationParts.push(pb > 0 && pb <= 5 ? 80 : pb > 0 && pb <= 10 ? 60 : 32);
  const valuationScore = valuationParts.length ? clampRecommendationScore(average(valuationParts)) : null;
  const availableScores = [canslim.score, financial?.quality?.score, valuationScore, technical?.score].filter(Number.isFinite);
  return {
    canslim,
    value: {
      score: availableScores.length ? clampRecommendationScore(average(availableScores)) : null,
      valuationScore,
      quality: financial?.quality || { available:false, score:null, evidence:'财务接口暂时不可用，本次不生成财务质量评分' },
      pe, pb,
      dcf: { available:false, evidence:'缺少可验证的自由现金流预测、净债务与增长假设，暂不计算DCF或目标价' },
      moat: { available:false, evidence:'护城河需要主营结构、竞争优势和多年经营质量人工核验，当前不自动给高分' },
      source: [financial?.source, quote ? '腾讯/东方财富实时估值' : ''].filter(Boolean).join(' + ')
    }
  };
}

function evaluateRecommendationRisk(item, riskProfile) {
  if (!riskProfile) riskProfile = {
    status: 'unknown', summary: '未来半年公司风险数据未确认', errors: ['风险核验未返回结果'],
    st: { status: 'clear' }, reduction: { status: 'unknown' }, unlock: { status: 'unknown' }
  };
  if (riskProfile.status === 'risk') return { status: 'rejected', item: null };
  if (riskProfile.status === 'clear') {
    return {
      status: 'approved',
      item: { ...item, riskProfile, reason: `${item.reason} ${riskProfile.summary}。` }
    };
  }
  const noVerifiedRisk = riskProfile.st?.status !== 'risk'
    && !(riskProfile.reduction?.events || []).length
    && !(riskProfile.unlock?.events || []).length;
  if (!noVerifiedRisk) return { status: 'unknown', item: null };
  const missingSources = [riskProfile.reduction?.status, riskProfile.unlock?.status].filter(status => status === 'unknown').length;
  const penalty = Math.min(14, Math.max(8, missingSources * 7));
  const signalScore = Math.max(0, Number(item.signalScore || item.score || 0) - penalty);
  return {
    status: 'unverified',
    item: {
      ...item,
      score: signalScore,
      signalScore,
      riskProfile,
      riskUnverified: true,
      reason: `${item.reason} ${riskProfile.summary}（风险数据未完整返回，已降${penalty}分保留并标记未确认）。`
    }
  };
}

async function fetchEastmoneyNews(keyword, cacheKey = keyword, maxAgeMs = 10 * 60 * 1000, force = false) {
  const cached = force ? null : readTimedCache(marketNewsCache, `eastmoney-${cacheKey}`, maxAgeMs);
  if (cached) return cached;
  const param = {
    uid: '', keyword, type: ['cmsArticleWebOld'], client: 'web', clientType: 'web', clientVersion: 'curr',
    param: { cmsArticleWebOld: { searchScope: 'default', sort: 'default', pageIndex: 1, pageSize: 8, preTag: '', postTag: '' } }
  };
  const text = await getText(`https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=${encodeURIComponent(JSON.stringify(param))}`, { Referer: 'https://so.eastmoney.com/' });
  const json = parseJsonpPayload(text);
  const rows = json?.result?.cmsArticleWebOld || json?.Data?.cmsArticleWebOld || [];
  const news = sortNewsNewestFirst(rows.map(row => ({
    title: cleanStockName(row.title || row.Title), link: row.url || row.Url,
    summary: String(row.content || row.Content || '').replace(/<[^>]+>/g, '').slice(0, 160),
    publishedAt: row.showTime || row.ShowTime || row.date || '', source: '东方财富资讯'
  })).filter(item => item.title && item.link)).slice(0, 8);
  return writeTimedCache(marketNewsCache, `eastmoney-${cacheKey}`, news);
}

async function fetchSinaMarketNews() {
  const json = await getJsonWithRetry(`https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2517&num=100&page=1&_=${Date.now()}`, 1);
  const marketPattern = /A股|沪指|深证|创业板|上证指数|大盘|两市|北向资金|主力资金|涨停|跌停|证监会/;
  return sortNewsNewestFirst((json?.result?.data || []).filter(row => marketPattern.test(`${row.title || ''} ${row.intro || row.summary || ''}`)).map(row => ({
    title: cleanStockName(row.title),
    link: row.url || row.wapurl || '',
    summary: String(row.intro || row.summary || row.wapsummary || '').replace(/<[^>]+>/g, '').slice(0, 180),
    publishedAt: Number(row.ctime) > 0 ? new Date(Number(row.ctime) * 1000).toISOString() : row.intime || '',
    source: row.media_name ? `新浪财经·${row.media_name}` : '新浪财经滚动'
  })).filter(item => item.title && item.link)).slice(0, 8);
}

function parseJin10FlashItems(script, limit = 10) {
  const match = String(script || '').match(/var\s+newest\s*=\s*(\[[\s\S]*?\])\s*;?\s*$/);
  if (!match) throw new Error('金十快讯返回格式异常');
  const rows = JSON.parse(match[1]);
  const marketPattern = /A股|沪指|深证|创业板|上证指数|大盘|两市|北向资金|主力资金|涨停|跌停|证监会|央行|财政部|降息|加息|关税|人民币/;
  return sortNewsNewestFirst((Array.isArray(rows) ? rows : []).map(row => {
    const data = row?.data || {};
    const remarks = Array.isArray(row?.remark) ? row.remark : [];
    const content = String(data.content || '').replace(/<[^>]+>/g, '').trim();
    const prefix = data.title && !content.startsWith(data.title) ? `${data.title} ` : '';
    const link = remarks.find(item => /^https?:\/\//i.test(item?.link || ''))?.link || data.source_link || '';
    const symbols = remarks.map(item => `${item.title || ''} ${item.symbol || ''}`).join(' ');
    return {
      title: cleanStockName(`${prefix}${content}`).slice(0, 160),
      link,
      summary: content.slice(0, 180),
      publishedAt: row?.time || '',
      source: '金十数据快讯',
      symbols
    };
  }).filter(item => item.title && marketPattern.test(`${item.title} ${item.summary} ${item.symbols}`))).slice(0, limit)
    .map(({ symbols, ...item }) => item);
}

async function fetchJin10MarketNews(limit = 10) {
  const script = await getText('https://www.jin10.com/flash_newest.js', { Referer: 'https://www.jin10.com/' });
  return parseJin10FlashItems(script, limit);
}

function classifyMarketNewsIssues(newsResult) {
  const issues = (newsResult?.errors || []).filter(Boolean);
  return newsResult?.news?.length
    ? { errors: [], warnings: issues.map(issue => `市场消息来源切换：${issue}`) }
    : { errors: issues, warnings: [] };
}

async function fetchMarketNews(force = false) {
  const maxAgeMs = 2 * 60 * 1000;
  const combinedKey = 'market-overview-live-news';
  const cached = force ? null : readTimedCache(marketNewsCache, combinedKey, maxAgeMs);
  if (cached) return { ...cached, cached: true };
  const previous = marketNewsCache.get(combinedKey)?.value;
  const keyword = 'A股 大盘 板块 资金 今日 最新消息';
  const errors = [];
  const collected = [];
  const sources = [];
  const addSource = (news, source) => {
    if (!news.length) return false;
    collected.push(...news);
    sources.push(source);
    return true;
  };
  try {
    const news = await fetchJin10MarketNews();
    if (!addSource(news, '金十数据快讯')) errors.push('金十数据快讯搜索为空');
  } catch (err) {
    errors.push(`金十数据快讯失败：${err.message || err}`);
  }
  try {
    const news = await fetchSinaMarketNews();
    if (!addSource(news, '新浪财经滚动')) errors.push('新浪财经滚动资讯搜索为空');
  } catch (err) {
    errors.push(`新浪财经滚动资讯失败：${err.message || err}`);
  }
  if (collected.length) {
    const seen = new Set();
    const news = sortNewsNewestFirst(collected).filter(item => {
      const key = `${item.title}|${item.link || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 12);
    return writeTimedCache(marketNewsCache, combinedKey, { news, source: sources.join(' + '), fetchedAt: new Date().toISOString(), stale: false, errors });
  }
  try {
    const news = await fetchEastmoneyNews(keyword, 'market-overview-news', maxAgeMs, force);
    if (news.length) return writeTimedCache(marketNewsCache, combinedKey, { news, source: '东方财富资讯', fetchedAt: new Date().toISOString(), stale: false, errors });
    errors.push('东方财富资讯搜索为空');
  } catch (err) {
    errors.push(`东方财富资讯失败：${err.message || err}`);
  }
  try {
    const news = await fetchBingNews(keyword, 'market-overview-news-bing', maxAgeMs, force);
    if (news.length) return writeTimedCache(marketNewsCache, combinedKey, { news, source: 'Bing新闻', fetchedAt: new Date().toISOString(), stale: false, errors });
    errors.push('Bing新闻搜索为空');
  } catch (err) {
    errors.push(`Bing资讯失败：${err.message || err}`);
  }
  if (previous?.news?.length) return { ...previous, cached: true, stale: true, errors };
  throw new Error(errors.join('；') || '市场资讯接口未返回数据');
}

async function fetchLiveNews({ force = false, limit = 24 } = {}) {
  const maxAgeMs = 2 * 60 * 1000;
  const safeLimit = Math.max(1, Math.min(48, Number(limit) || 24));
  const cacheKey = `live-news-${safeLimit}`;
  const cached = force ? null : readTimedCache(marketNewsCache, cacheKey, maxAgeMs);
  if (cached) return { ...cached, cached: true };
  const previous = marketNewsCache.get(cacheKey)?.value;
  const keyword = 'A股 大盘 板块 资金 今日 最新消息';
  const errors = [];
  const collected = [];
  const sources = [];
  const addSource = (news, source) => {
    if (!news?.length) return false;
    collected.push(...news);
    sources.push(source);
    return true;
  };
  try {
    if (!addSource(await fetchJin10MarketNews(safeLimit), '金十数据快讯')) errors.push('金十数据快讯搜索为空');
  } catch (err) {
    errors.push(`金十数据快讯失败：${err.message || err}`);
  }
  try {
    if (!addSource(await fetchSinaMarketNews(), '新浪财经滚动') && !collected.length) errors.push('新浪财经滚动资讯搜索为空');
  } catch (err) {
    if (!collected.length) errors.push(`新浪财经滚动资讯失败：${err.message || err}`);
  }
  if (collected.length < safeLimit) {
    try {
      if (!addSource(await fetchBingNews(keyword, 'live-news-bing', maxAgeMs, force), 'Bing新闻') && !collected.length) errors.push('Bing新闻搜索为空');
    } catch (err) {
      if (!collected.length) errors.push(`Bing资讯失败：${err.message || err}`);
    }
  }
  const seen = new Set();
  const news = sortNewsNewestFirst(collected).filter(item => {
    const key = `${item.title}|${item.link || ''}`;
    if (!item.title || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, safeLimit);
  if (news.length) return writeTimedCache(marketNewsCache, cacheKey, { news, source: sources.join(' + '), fetchedAt: new Date().toISOString(), stale: false, errors });
  if (previous?.news?.length) return { ...previous, cached: true, stale: true, errors };
  throw new Error(errors.join('；') || '实时新闻接口未返回数据');
}

function scoreConsolidationCandidate(item) {
  const change = Math.abs(Number(item?.changePct) || 0);
  const volumeRatio = finiteNumber(item?.snapshotVolumeRatio) ?? 1;
  const turnover = finiteNumber(item?.turnoverRate) ?? 4;
  const nearHigh = item?.high > 0 ? item.price / item.high : 0;
  const liquidity = Math.log10(Math.max(Number(item?.amount) || 0, 1)) * 3;
  const stability = Math.max(0, 2.5 - change) * 10;
  const quietVolume = Math.max(0, 1.5 - Math.abs(volumeRatio - .8)) * 8;
  const turnoverFit = turnover >= .5 && turnover <= 12 ? 8 : 0;
  return liquidity + stability + quietVolume + nearHigh * 10 + turnoverFit;
}

async function buildMarketRecommendations(marketQuotes, force = false, outcomeProfile = null) {
  const marketAssessmentContext = {
    breadth: (marketQuotes || []).reduce((counts, item) => {
      if (item.changePct > 0) counts.up++;
      else if (item.changePct < 0) counts.down++;
      else counts.flat++;
      return counts;
    }, { up: 0, down: 0, flat: 0 }),
    indices: []
  };
  let directory = [];
  try {
    directory = await fetchStockDirectory();
  } catch {}
  const cachedDirectory = readDiskCache('stock-directory') || [];
  const directoryByCode = new Map();
  [...cachedDirectory, ...directory].forEach(item => {
    const current = directoryByCode.get(item.code) || {};
    const industry = cleanStockName(item.industry) || cleanStockName(current.industry);
    directoryByCode.set(item.code, { ...current, ...item, industry });
  });
  const scored = (marketQuotes || []).map(item => {
    const industry = resolveRecommendationIndustry(item, directoryByCode);
    const nearHigh = item.high > 0 ? item.price / item.high : 0;
    const turnoverFit = item.turnoverRate >= .5 && item.turnoverRate <= 12 ? 8 : 0;
    const preliminaryScore = nearHigh * 40 + Math.max(0, Math.min(10, (item.changePct || 0) + 1)) * 4
      + Math.log10(Math.max(item.amount || 0, 1)) * 2 + turnoverFit;
    const dayRange = item.high > item.low ? (item.price - item.low) / (item.high - item.low) : .5;
    const reboundPreliminaryScore = Math.log10(Math.max(item.amount || 0, 1)) * 3 + turnoverFit
      + Math.max(0, Math.min(1, dayRange)) * 12
      + ((item.changePct || 0) >= -.5 && (item.changePct || 0) <= 6 ? 16 : (item.changePct || 0) > 6 ? 10 : 6);
    return { ...item, industry, preliminaryScore, reboundPreliminaryScore, consolidationPreliminaryScore: scoreConsolidationCandidate(item) };
  }).filter(item => !/ST|退/.test(item.name) && item.price > 0 && item.high > 0);
  const factorContext = buildRecommendationFactorContext(scored);
  const breakoutScreened = scored.filter(item => item.amount >= 5e7
    && item.changePct >= -1 && item.changePct < 9.5 && item.price / item.high >= .96)
    .sort((a, b) => b.preliminaryScore - a.preliminaryScore);
  const reboundScreened = scored.filter(item => item.amount >= 3e7 && item.changePct >= -5 && item.changePct < 9.5
    && (item.turnoverRate == null || item.turnoverRate <= 20) && item.price / item.high >= .9)
    .sort((a, b) => b.reboundPreliminaryScore - a.reboundPreliminaryScore);
  const consolidationScreened = scored.filter(item => item.amount >= 3e7 && Math.abs(item.changePct || 0) <= 2.5
    && (item.snapshotVolumeRatio == null || item.snapshotVolumeRatio >= .45 && item.snapshotVolumeRatio <= 1.4)
    && (item.turnoverRate == null || item.turnoverRate >= .5 && item.turnoverRate <= 12)
    && item.price / item.high >= .94)
    .sort((a, b) => b.consolidationPreliminaryScore - a.consolidationPreliminaryScore);
  const selectCandidates = (source, limit, perIndustry) => {
    const output = [];
    const industryCounts = new Map();
    for (const item of source) {
      const group = recommendationIndustryGroupKey(item);
      if ((industryCounts.get(group) || 0) >= perIndustry) continue;
      industryCounts.set(group, (industryCounts.get(group) || 0) + 1);
      output.push(item);
      if (output.length >= limit) break;
    }
    return output;
  };
  const candidates = [];
  const candidateCodes = new Set();
  for (const item of [...selectCandidates(breakoutScreened, 25, 2), ...selectCandidates(consolidationScreened, 25, 2), ...selectCandidates(reboundScreened, 70, 3)]) {
    if (candidateCodes.has(item.code)) continue;
    candidateCodes.add(item.code);
    const group = recommendationIndustryGroupKey(item);
    candidates.push({ ...item, recommendationGroup: group });
    if (candidates.length >= 60) break;
  }
  const analyzed = [];
  const historyErrors = [];
  const historyResults = await settleWithConcurrency(candidates, 6, async quote => {
      let history = readTimedCache(marketHistoryCache, quote.code, 10 * 60 * 1000);
      if (!history) {
        try {
          history = await fetchTencentHistory(quote.code, 120);
        } catch (tencentError) {
          history = await fetchSinaHistory(quote.code);
        }
        if (history.length >= 60) writeTimedCache(marketHistoryCache, quote.code, history);
      }
      history = mergeQuoteIntoHistory(history, quote);
      if (history.length < 60) return null;
      const analysis = {
        ...analyzeHistory(history),
        latestTradeDate: history.at(-1)?.date || '',
        latestPrice: history.at(-1)?.close || null
      };
      const item = { ...quote, analysis };
      return { ...item, reboundQuality: assessReboundQuality(item), breakoutQuality: assessBreakoutQuality(item) };
  });
  historyResults.forEach(result => {
    if (result.status === 'fulfilled' && result.value) analyzed.push(result.value);
    else if (result.status === 'rejected') historyErrors.push(result.reason?.message || String(result.reason));
  });
  factorContext.relativeReturns = analyzed.map(item => item.analysis?.return60).filter(value => finiteNumber(value) !== null);
  const breakoutQualifying = analyzed
    .filter(item => (item.analysis.distanceToBreakout >= -2.5 && item.analysis.distanceToBreakout <= 5 && item.analysis.rsi14 < 80
      && item.price >= item.analysis.ma30 * .98) || item.analysis.accumulationSetup?.passed
      || item.analysis.consolidationBreakout?.isConsolidating)
    .sort((a, b) => (b.analysis.consolidationBreakout?.technicalScore || 0) - (a.analysis.consolidationBreakout?.technicalScore || 0)
      || Number(b.analysis.accumulationSetup?.passed) - Number(a.analysis.accumulationSetup?.passed)
      || b.analysis.score - a.analysis.score);
  const bottomWaiting = analyzed.filter(item => item.analysis.reboundSignal === '底部待反弹' && item.reboundQuality.passed)
    .sort((a, b) => b.analysis.reboundScore + b.reboundQuality.score * .35 - (a.analysis.reboundScore + a.reboundQuality.score * .35));
  const rebounded = analyzed.filter(item => item.analysis.reboundSignal === '已反弹' && item.reboundQuality.passed)
    .sort((a, b) => b.analysis.reboundScore + b.reboundQuality.score * .35 - (a.analysis.reboundScore + a.reboundQuality.score * .35));
  const selectedCodes = new Set();
  const ranked = [];
  const appendSignal = (items, signal) => items.forEach(item => {
    if (selectedCodes.has(item.code)) return;
    selectedCodes.add(item.code);
    const breakoutStatus = item.analysis.consolidationBreakout?.isConsolidating
      ? item.analysis.consolidationBreakout.status : signal;
    ranked.push({ ...item, signal: signal === '待突破' ? breakoutStatus : signal, quality: signal === '待突破' ? item.breakoutQuality : item.reboundQuality });
  });
  appendSignal(breakoutQualifying, '待突破');
  appendSignal(rebounded, '已反弹');
  appendSignal(bottomWaiting, '底部待反弹');
  const recommendationResults = await settleWithConcurrency(ranked, 4, async item => {
    const [fundFlowResult, newsResult, financialResult] = await Promise.allSettled([
      fetchSinaFundFlowHistory(item.code, 10),
      fetchStockNews({ code: item.code, name: item.name, force }),
      fetchStockFinancials({ code: item.code, force: false })
    ]);
    const fundFlowPeriod = fundFlowResult.status === 'fulfilled' ? fundFlowResult.value : null;
    const capitalAnalysis = applyIndividualCapitalAssessment(item.analysis, fundFlowPeriod);
    const breakoutPotential = capitalAnalysis.breakoutPotential;
    const breakoutSignal = !['已反弹', '底部待反弹'].includes(item.signal);
    let signal = breakoutSignal && breakoutPotential.isConsolidating ? breakoutPotential.status : item.signal;
    item = { ...item, fundFlowPeriod, breakoutPotential, signal };
    const windowStart = breakoutSignal
      ? new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      : item.analysis.bottomDate;
    const newsContext = newsResult.status === 'fulfilled'
      ? summarizeNews(newsResult.value.news, windowStart, { subject: item.name, code: item.code, ...newsResult.value })
      : summarizeNews([], windowStart);
    const contextualAnalysis = applyEntryContextAssessment(capitalAnalysis, {
      newsContext, marketOverview: marketAssessmentContext
    });
    const entryAnalysis = applyOutcomeFeedbackAssessment(contextualAnalysis, outcomeProfile);
    const entryAssessment = entryAnalysis.entryAssessment;
    if (entryAssessment?.setupType === 'bottom-accumulation') signal = '底部吸筹';
    else if (entryAssessment?.setupType === 'sideways-washout') signal = '震荡洗盘';
    item = { ...item, signal };
    const financialAnalysis = financialResult.status === 'fulfilled' ? financialResult.value.analysis : null;
    let verdict = entryAnalysis.verdict;
    if (newsContext.signal === '偏谨慎' && verdict === '可关注') verdict = '等待确认';
    const distance = item.analysis.distanceToBreakout;
    const ma30Position = item.price >= item.analysis.ma30 ? '站上' : '接近';
    const technicalReason = breakoutSignal
      ? item.analysis.consolidationBreakout?.isConsolidating
        ? item.analysis.consolidationBreakout.summary
        : item.analysis.accumulationSetup?.passed
        ? item.analysis.accumulationSetup.summary
        : `${item.analysis.maAlignment}，现价${ma30Position}MA30（${item.analysis.ma30.toFixed(2)}元）；距20日突破位${distance >= 0 ? '约' + distance.toFixed(2) + '%' : '已突破约' + Math.abs(distance).toFixed(2) + '%'}；近5日量比${item.analysis.volumeRatio.toFixed(2)}`
      : item.analysis.reboundReason;
    const newsLabel = newsContext.signal === '偏积极' ? '消息确认' : newsContext.signal === '偏谨慎' ? '消息谨慎' : '消息中性';
    const factorAnalysis = evaluateRecommendationFactors(item, factorContext, newsContext, financialAnalysis);
    const canslim = buildCanslimFromFactors(factorAnalysis);
    const sectorDescription = factorAnalysis.sectorProfile
      ? `${factorAnalysis.sectorProfile.name}${factorAnalysis.sectorProfile.label}（板块评分${factorAnalysis.sectorProfile.score}）` : '板块强度未确认';
    const capitalDescription = fundFlowPeriod?.available ? fundFlowPeriodEvidence(fundFlowPeriod) : '阶段主力资金暂未取得，不据此加分';
    const structureReason = entryAssessment?.structureSummary ? `；形态评估：${entryAssessment.structureSummary}` : '';
    let reason = `${item.signal}；${technicalReason}；${capitalDescription}；${sectorDescription}；${newsContext.signal === '偏积极' ? '存在经时效加权的正向消息催化' : newsContext.signal === '偏谨慎' ? '存在近期风险消息，信号降级等待确认' : '消息面时效加权后中性'}（最新${newsContext.latestPublishedAt ? formatNewsTime(newsContext.latestPublishedAt) : '未取得'}，${newsContext.freshness}）；综合入场：${entryAssessment?.status || '数据待补充'}，${entryAssessment?.summary || '关键数据不足'}${structureReason}。`;
    const setupAdjustment = item.analysis.accumulationSetup?.passed ? 10 : 0;
    const technicalBreakout = item.analysis.consolidationBreakout;
    const horizontalAdjustment = !technicalBreakout?.isConsolidating ? 0
      : technicalBreakout.status === '突破确认' ? 12
        : technicalBreakout.status === '接近突破' ? 10
          : technicalBreakout.status === '突破蓄势' ? 7
            : technicalBreakout.status === '结构偏弱' ? -15 : 2;
    const rawSignalScore = Math.max(0, Math.min(100, (breakoutSignal ? item.analysis.score : item.analysis.reboundScore)
      + setupAdjustment + horizontalAdjustment));
    const qualityScore = item.quality?.score ?? 100;
    const factorScore = factorAnalysis.score ?? rawSignalScore;
    const baseSignalScore = clampRecommendationScore(rawSignalScore * .55 + qualityScore * .15 + factorScore * .3);
    const outcomeResult = calibrateRecommendationWithOutcomes({ signal, signalScore: baseSignalScore, technicalScore: item.analysis.score }, outcomeProfile);
    const strategyRiskAdjustment = outcomeProfile?.marketRisk?.status === 'drawdown' ? -3 : 0;
    const totalOutcomeAdjustment = outcomeResult.adjustment + strategyRiskAdjustment;
    const outcomeCalibration = { ...outcomeResult, strategyRiskAdjustment, totalAdjustment: totalOutcomeAdjustment };
    const signalScore = clampRecommendationScore(baseSignalScore + totalOutcomeAdjustment);
    if (outcomeCalibration.familyStats || outcomeCalibration.technicalStats) reason += ` 本地推荐复盘：${outcomeCalibration.summary}，本次评分${totalOutcomeAdjustment >= 0 ? '+' : ''}${totalOutcomeAdjustment}分。`;
    if (strategyRiskAdjustment) reason += ` 最近成熟推荐整体处于回撤，额外降低${Math.abs(strategyRiskAdjustment)}分。`;
    return {
      ...item,
      verdict,
      signal,
      technicalScore: item.analysis.score,
      score: signalScore,
      signalScore,
      qualityScore,
      qualityRisks: item.quality?.reasons || [],
      factorAnalysis,
      financialAnalysis,
      canslim,
      newsLabel,
      breakoutPrice: item.analysis.breakoutPrice,
      supportPrice: item.analysis.supportPrice,
      ma30: item.analysis.ma30,
      maAlignment: item.analysis.maAlignment,
      volumeRatio: item.analysis.volumeRatio,
      accumulationSetup: item.analysis.accumulationSetup,
      consolidationBreakout: item.analysis.consolidationBreakout,
      breakoutPotential,
      fundFlowPeriod,
      entryAssessment,
      outcomeCalibration,
      reason,
      newsContext
    };
  });
  const recommendations = recommendationResults.filter(result => result.status === 'fulfilled').map(result => result.value);
  const qualityRecommendations = recommendations.filter(item => item.qualityScore >= 65
    && recommendationPassesOutcomeGate(item)
    && item.breakoutPotential?.status !== '结构偏弱'
    && !isExplosiveVolume(item.analysis?.volumeRatio)
    && !['破位', '爆量观察', '结构偏弱', '不宜追高', '公司风险'].includes(item.entryAssessment?.status)
    && !(item.newsLabel === '消息谨慎' && item.signalScore < 65)
    && !(item.fundFlowPeriod?.available && item.fundFlowPeriod.netRatio <= -3 && item.fundFlowPeriod.positiveDays <= 4)
    && !(item.financialAnalysis?.hardRisks?.length >= 2 && item.financialAnalysis?.score < 45)
    && !(item.canslim?.available >= 5 && item.canslim.score < 50));
  const riskResults = await settleWithConcurrency(qualityRecommendations, 4, item => fetchFutureRiskProfile({
    code: item.code,
    name: item.name,
    force: false
  }));
  let riskRejected = 0;
  let riskUnknown = 0;
  let riskUnverifiedIncluded = 0;
  const riskApprovedRecommendations = [];
  riskResults.forEach((result, index) => {
    if (result.status === 'rejected') {
      riskUnknown++;
      const decision = evaluateRecommendationRisk(qualityRecommendations[index], null);
      if (decision.item) {
        riskUnverifiedIncluded++;
        riskApprovedRecommendations.push(decision.item);
      }
      return;
    }
    const riskProfile = result.value;
    const decision = evaluateRecommendationRisk(qualityRecommendations[index], riskProfile);
    if (decision.status === 'rejected') riskRejected++;
    if (decision.status === 'unknown' || decision.status === 'unverified') riskUnknown++;
    if (decision.status === 'unverified') riskUnverifiedIncluded++;
    if (decision.item) riskApprovedRecommendations.push(decision.item);
  });
  const finalRiskApprovedRecommendations = riskApprovedRecommendations.filter(item => Number(item.signalScore ?? item.score) >= 65);
  const riskScoreRejected = riskApprovedRecommendations.length - finalRiskApprovedRecommendations.length;
  riskUnverifiedIncluded = finalRiskApprovedRecommendations.filter(item => item.riskUnverified).length;
  const recommendationGroups = ['breakout', 'rebounded', 'bottomWaiting', 'structure', 'other'].reduce((groups, family) => {
    groups[family] = finalRiskApprovedRecommendations.filter(item => recommendationSignalFamily(item.signal) === family)
      .sort((a, b) => b.signalScore - a.signalScore);
    return groups;
  }, {});
  const defaultFamilyOrder = ['breakout', 'rebounded', 'bottomWaiting', 'structure', 'other'];
  const representativeSignal = { breakout: '待突破', rebounded: '已反弹', bottomWaiting: '底部待反弹', structure: '震荡洗盘', other: '' };
  const familyOrder = [...defaultFamilyOrder].sort((left, right) => {
    const difference = calibrateRecommendationWithOutcomes({ signal: representativeSignal[right], signalScore: 75 }, outcomeProfile).adjustment
      - calibrateRecommendationWithOutcomes({ signal: representativeSignal[left], signalScore: 75 }, outcomeProfile).adjustment;
    return difference || defaultFamilyOrder.indexOf(left) - defaultFamilyOrder.indexOf(right);
  });
  const balancedRecommendations = [];
  while (Object.values(recommendationGroups).some(group => group.length)) {
    familyOrder.forEach(family => {
      const item = recommendationGroups[family].shift();
      if (item) balancedRecommendations.push(item);
    });
  }
  const groupedRecommendations = groupRecommendationsByIndustry(balancedRecommendations);
  const finalSignals = groupedRecommendations.reduce((counts, item) => {
    counts[recommendationSignalFamily(item.signal)] += 1;
    return counts;
  }, { bottomWaiting: 0, rebounded: 0, breakout: 0, structure: 0, other: 0 });
  return {
    recommendations: groupedRecommendations,
    coverage: {
      scanned: marketQuotes?.length || 0,
      prefiltered: new Set([...breakoutScreened, ...consolidationScreened, ...reboundScreened].map(item => item.code)).size,
      analyzed: analyzed.length,
      industries: new Set(analyzed.map(item => resolveRecommendationIndustry(item)).filter(industry => industry !== '行业待确认')).size,
      industryUnresolved: analyzed.filter(item => resolveRecommendationIndustry(item) === '行业待确认').length,
      directoryAvailable: directoryByCode.size > 0,
      historyFailures: historyErrors.length,
      accumulationCandidates: analyzed.filter(item => item.analysis.accumulationSetup?.passed).length,
      consolidationCandidates: analyzed.filter(item => item.analysis.consolidationBreakout?.isConsolidating).length,
      fundFlowAvailable: recommendations.filter(item => item.fundFlowPeriod?.available).length,
      signals: finalSignals,
      signalCandidates: {
        bottomWaiting: bottomWaiting.length,
        rebounded: rebounded.length,
        breakout: breakoutQualifying.length
      },
      qualityRejected: analyzed.filter(item => item.analysis.reboundSignal && !item.reboundQuality.passed).length,
      riskChecked: qualityRecommendations.length,
      riskRejected,
      riskUnknown,
      riskUnverifiedIncluded,
      riskScoreRejected,
      outcomeFeedback: outcomeProfile?.sampleSize ? {
        sampleSize: outcomeProfile.sampleSize,
        excludedCount: outcomeProfile.excludedCount,
        immatureCount: outcomeProfile.immatureCount,
        recentCohortCount: outcomeProfile.recentCohortCount,
        recentWindowDays: outcomeProfile.recentWindowDays,
        recentExtended: outcomeProfile.recentExtended,
        signature: outcomeProfile.signature,
        marketRisk: outcomeProfile.marketRisk,
        byFamily: outcomeProfile.byFamily,
        byRecentSignal: outcomeProfile.byRecentSignal,
        byRecentTechnicalScoreBand: outcomeProfile.byRecentTechnicalScoreBand
      } : null,
      factorModel: 'A股适配CANSLIM + 价值质量 + 阶段主力资金 + 底部五线粘合放量 + 横盘箱体突破趋势（缺失项不计分）',
      qualified: groupedRecommendations.length
    }
  };
}

function marketAnalysis(result) {
  const indexAverage = average((result.indices || []).map(item => item.changePct));
  const up = result.breadth?.up || 0;
  const down = result.breadth?.down || 0;
  const sentiment = indexAverage >= .6 && up > down ? '偏强' : indexAverage <= -.6 && down > up ? '偏弱' : '分化';
  const leaders = (result.sectors || []).slice(0, 3).map(item => `${item.name}${item.changePct >= 0 ? '+' : ''}${item.changePct.toFixed(2)}%`).join('、');
  const funds = (result.fundSectors || []).slice(0, 3).map(item => item.name).join('、');
  const news = result.newsContext?.signal ? `消息面经发布时间和相关性加权后${result.newsContext.signal}（${result.newsContext.freshness || '时效未知'}）。` : '';
  const signalGroups = Object.entries((result.recommendations || []).reduce((groups, item) => {
    (groups[item.signal || '待突破'] ||= []).push(item.name);
    return groups;
  }, {})).map(([signal, names]) => `${signal}：${names.slice(0, 3).join('、')}`).join('；');
  return `市场情绪${sentiment}${up || down ? `，上涨${up}家、下跌${down}家` : ''}。${leaders ? `轮动靠前：${leaders}。` : ''}${funds ? `成交资金活跃板块：${funds}。` : ''}涨停${result.limits?.upCount ?? 0}只、跌停${result.limits?.downCount ?? 0}只。${news}${signalGroups ? `技术形态观察候选——${signalGroups}；仍需等待价格和成交量条件确认。` : '当前未筛出满足条件的技术形态候选。'}`;
}

async function fetchMarketOverview(force = false, favoriteOutcomes = []) {
  const freshCachedQuotes = [...quoteCache.values()].filter(quote => !quote.stale
    && Date.now() - Date.parse(quote.fetchedAt || '') < 10 * 60 * 1000);
  let outcomeProfile = summarizeRecommendationOutcomes(mergeRecommendationOutcomeQuotes(favoriteOutcomes, freshCachedQuotes));
  let feedbackSignature = outcomeProfile.signature;
  const cachedFeedbackSignature = marketOverviewCache?.value?.recommendationCoverage?.outcomeFeedback?.signature || '';
  if (!force && marketOverviewCache && feedbackSignature === cachedFeedbackSignature
    && Date.now() - marketOverviewCache.savedAt < 30 * 1000) return { ...marketOverviewCache.value, cached: true };
  const previousOverview = readDiskCache('market-overview', 24 * 60 * 60 * 1000);
  const recommendationCache = marketOverviewCache?.value?.recommendations?.length
    ? marketOverviewCache.value
    : previousOverview;
  const recommendationSavedAt = Date.parse(recommendationCache?.recommendationsFetchedAt || recommendationCache?.fetchedAt || '');
  const recommendationFeedbackSignature = recommendationCache?.recommendationCoverage?.outcomeFeedback?.signature || '';
  const result = { errors: [], warnings: [], fetchedAt: new Date().toISOString() };
  const [indicesResult, snapshotResult] = await Promise.allSettled([
    fetchTencentMarketIndices(), fetchTencentMarketSnapshot()
  ]);
  if (indicesResult.status === 'fulfilled' && indicesResult.value.length) result.indices = indicesResult.value;
  else result.errors.push(`指数行情失败：${indicesResult.reason?.message || '返回为空'}`);
  if (snapshotResult.status === 'fulfilled') {
    const quoteFetchedAt = new Date().toISOString();
    const outcomeQuotes = snapshotResult.value.quotes.map(quote => ({
      ...quote, source: '腾讯全市场行情', fetchedAt: quoteFetchedAt, stale: false
    }));
    outcomeQuotes.forEach(quote => quoteCache.set(quote.code, quote));
    outcomeProfile = summarizeRecommendationOutcomes(mergeRecommendationOutcomeQuotes(favoriteOutcomes, outcomeQuotes));
    feedbackSignature = outcomeProfile.signature;
    const reuseRecommendations = Boolean(!force && recommendationCache?.recommendations?.length
      && recommendationFeedbackSignature === feedbackSignature
      && Number.isFinite(recommendationSavedAt)
      && Date.now() - recommendationSavedAt < 10 * 60 * 1000);
    result.breadth = snapshotResult.value.breadth;
    result.limits = snapshotResult.value.limits;
    result.activeStocks = snapshotResult.value.activeStocks;
    result.turnover = snapshotResult.value.turnover;
    result.errors.push(...snapshotResult.value.errors.map(error => `全市场行情部分失败：${error}`));
    const [sectorsResult, recommendationsResult, newsResult] = await Promise.allSettled([
      fetchTencentMarketSectors(snapshotResult.value.quotes),
      reuseRecommendations ? Promise.resolve(null) : buildMarketRecommendations(snapshotResult.value.quotes, force, outcomeProfile),
      fetchMarketNews(force)
    ]);
    if (sectorsResult.status === 'fulfilled') Object.assign(result, sectorsResult.value);
    else result.errors.push(`板块轮动失败：${sectorsResult.reason?.message || sectorsResult.reason}`);
    if (recommendationsResult.status === 'fulfilled' && recommendationsResult.value) {
      result.recommendations = recommendationsResult.value.recommendations;
      result.recommendationCoverage = recommendationsResult.value.coverage;
      result.recommendationsFetchedAt = new Date().toISOString();
    } else if (reuseRecommendations) {
      restoreCachedMarketRecommendations(result, recommendationCache, snapshotResult.value.quotes);
      result.recommendationsFetchedAt = recommendationCache.recommendationsFetchedAt || recommendationCache.fetchedAt;
      result.recommendationCoverage.cachedFallback = false;
      delete result.recommendationFallback;
    }
    else result.errors.push(`技术形态候选分析失败：${recommendationsResult.reason?.message || recommendationsResult.reason}`);
    if (newsResult.status === 'fulfilled') {
      result.newsContext = summarizeNews(newsResult.value.news, '', { ...newsResult.value });
      const newsIssues = classifyMarketNewsIssues(newsResult.value);
      result.errors.push(...newsIssues.errors);
      result.warnings.push(...newsIssues.warnings);
    }
    else result.errors.push(`大盘消息获取失败：${newsResult.reason?.message || newsResult.reason}`);
  } else {
    result.errors.push(`全市场行情失败：${snapshotResult.reason?.message || snapshotResult.reason}`);
  }
  result.indices ||= [];
  result.breadth ||= { up: 0, down: 0, flat: 0 };
  result.sectors ||= [];
  result.weakSectors ||= [];
  result.fundSectors ||= [];
  result.activeStocks ||= [];
  result.recommendations ||= [];
  const restoredRecommendations = restoreCachedMarketRecommendations(result, previousOverview, snapshotResult.value?.quotes || []);
  if (restoredRecommendations) result.warnings.push(`技术形态候选本轮未生成，已回退最近一次成功推荐（${result.recommendations.length}只）`);
  result.recommendationCoverage ||= { scanned: snapshotResult.value?.quotes?.length || 0, prefiltered: 0, analyzed: 0, industries: 0, directoryAvailable: false };
  result.newsContext ||= summarizeNews([]);
  result.limits ||= { date: '', upCount: 0, downCount: 0, upStocks: [], downStocks: [] };
  result.turnover ||= result.indices.slice(0, 2).reduce((sum, item) => sum + (item.amount || 0), 0);
  result.analysis = marketAnalysis(result);
  result.source = ['腾讯指数', snapshotResult.status === 'fulfilled' ? '腾讯全市场行情' : '', result.sectors.length ? '中证行业指数' : ''].filter(Boolean).join(' + ');
  if (!result.indices.length && !result.sectors.length) {
    if (previousOverview?.indices?.length || previousOverview?.sectors?.length) {
      const fallback = {
        ...previousOverview,
        cached: true,
        cachedFallback: true,
        warnings: [...new Set([...(previousOverview.warnings || []), ...(result.warnings || [])])],
        errors: [...new Set([...(previousOverview.errors || []), ...result.errors, '本轮大盘接口均不可用，已显示最近一次成功数据'])]
      };
      fallback.recommendations = (fallback.recommendations || []).map(item => ({ ...item, industry: resolveRecommendationIndustry(item) }));
      marketOverviewCache = { savedAt: Date.now(), value: fallback };
      return fallback;
    }
    throw new Error(result.errors.join('；') || '大盘数据源均未返回数据');
  }
  writeDiskCache('market-overview', result);
  marketOverviewCache = { savedAt: Date.now(), value: result };
  return result;
}

function decodeJsEscapes(text) {
  return String(text || '').replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

async function fetchTencentSmartbox(keyword) {
  const input = String(keyword || '').trim();
  if (!input) return [];
  const text = await getText(`https://smartbox.gtimg.cn/s3/?q=${encodeURIComponent(input)}&t=all`, { Referer: 'https://gu.qq.com/' });
  const body = (text.match(/v_hint="([\s\S]*?)";?/) || [])[1] || '';
  if (!body || body === 'N') return [];
  return uniqueStocks(body.split('^').map(part => {
    const cols = part.split('~');
    return {
      market: cols[0] || '',
      code: String(cols[1] || '').slice(-6),
      name: cleanStockName(decodeJsEscapes(cols[2] || '')),
      securityType: cols[4] || '',
      source: '腾讯股票搜索'
    };
  })).filter(item => /^\d{6}$/.test(item.code) && item.name);
}

function uniqueStocks(items) {
  const seen = new Set();
  return items.map(item => ({
    ...item,
    code: String(item.code || '').slice(-6),
    name: cleanStockName(item.name)
  })).filter(item => {
    if (!/^\d{6}$/.test(item.code) || !item.name || seen.has(item.code)) return false;
    seen.add(item.code);
    return true;
  });
}

function cleanStockName(name) {
  return String(name || '')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9*ＳＴST.-]/g, '')
    .trim();
}

async function fetchStockDirectory() {
  if (stockDirectoryCache && Date.now() - stockDirectoryFetchedAt < 6 * 60 * 60 * 1000) return stockDirectoryCache;
  try {
    const fields = 'f12,f14,f13,f100,f102';
    const fs = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
    const buildUrl = page => `https://push2.eastmoney.com/api/qt/clist/get?pn=${page}&pz=100&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f12&fs=${encodeURIComponent(fs)}&fields=${fields}&_=${Date.now()}`;
    const result = await fetchEastmoneyPages(buildUrl);
    const fresh = uniqueStocks(result.rows.map(r => ({
      code: String(r.f12 || ''),
      name: r.f14 || '',
      market: String(r.f13 || ''),
      industry: cleanStockName(r.f100 || ''),
      area: cleanStockName(r.f102 || ''),
      securityType: 'A股'
    }))).filter(x => /^\d{6}$/.test(x.code) && x.name);
    const previous = result.errors.length ? readDiskCache('stock-directory') || [] : [];
    const merged = new Map(previous.map(item => [item.code, item]));
    fresh.forEach(item => {
      const cached = merged.get(item.code) || {};
      merged.set(item.code, { ...cached, ...item, industry: cleanStockName(item.industry) || cleanStockName(cached.industry) });
    });
    stockDirectoryCache = uniqueStocks([...merged.values()]);
    stockDirectoryFetchedAt = Date.now();
    writeDiskCache('stock-directory', stockDirectoryCache);
    appendLogLine({ type: result.errors.length ? 'warn' : 'info', message: 'A股完整目录分页加载完成', action: 'stock_directory_pages', detail: { count: stockDirectoryCache.length, expected: result.total, pages: result.pageCount, errors: result.errors } });
    return stockDirectoryCache;
  } catch (err) {
    const cached = stockDirectoryCache?.length ? stockDirectoryCache : readDiskCache('stock-directory');
    if (cached?.length) {
      stockDirectoryCache = cached;
      stockDirectoryFetchedAt = Date.now();
      appendLogLine({ type: 'warn', message: 'A股目录接口失败，已使用本地缓存', action: 'stock_directory_cache_used', detail: { count: cached.length, error: err.message || String(err) } });
      return cached;
    }
    throw err;
  }
}

async function fetchBoardDirectory() {
  if (boardDirectoryCache && Date.now() - boardDirectoryFetchedAt < 6 * 60 * 60 * 1000) return boardDirectoryCache;
  const fields = 'f12,f14,f3,f20,f62';
  const boards = [];
  const errors = [];
  for (const boardFilter of ['m:90+t:2', 'm:90+t:3']) {
    try {
      const buildUrl = page => `https://push2.eastmoney.com/api/qt/clist/get?pn=${page}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${encodeURIComponent(boardFilter)}&fields=${fields}&_=${Date.now()}`;
      const result = await fetchEastmoneyPages(buildUrl, 15);
      result.rows.forEach(row => {
        const code = String(row.f12 || '');
        const name = cleanStockName(row.f14);
        if (/^BK\d{4}$/.test(code) && name) boards.push({ code, name, source: '东方财富板块列表' });
      });
      errors.push(...result.errors.map(error => `${boardFilter} ${error}`));
    } catch (err) {
      errors.push(err.message || String(err));
    }
  }
  if (!boards.length && errors.length) {
    const cached = boardDirectoryCache?.length ? boardDirectoryCache : readDiskCache('board-directory');
    if (cached?.length) {
      boardDirectoryCache = cached;
      boardDirectoryFetchedAt = Date.now();
      appendLogLine({ type: 'warn', message: '板块目录接口失败，已使用本地缓存', action: 'board_directory_cache_used', detail: { count: cached.length, errors } });
      return cached;
    }
    throw new Error(`板块列表获取失败：${errors.join('；')}`);
  }
  const previous = errors.length ? readDiskCache('board-directory') || [] : [];
  boardDirectoryCache = [...new Map([...boards, ...previous].map(board => [board.code, board])).values()];
  boardDirectoryFetchedAt = Date.now();
  writeDiskCache('board-directory', boardDirectoryCache);
  appendLogLine({ type: errors.length ? 'warn' : 'info', message: '完整板块目录分页加载完成', action: 'board_directory_pages', detail: { count: boardDirectoryCache.length, errors } });
  return boardDirectoryCache;
}

async function fetchBoardStocks(board) {
  const cacheName = `board-stocks-${board.code}`;
  try {
    const fields = 'f12,f14,f13,f2,f3,f4,f5,f6,f15,f16,f17,f18,f20,f21,f62,f184';
    const buildUrl = page => `https://push2.eastmoney.com/api/qt/clist/get?pn=${page}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${encodeURIComponent(`b:${board.code}`)}&fields=${fields}&_=${Date.now()}`;
    const result = await fetchEastmoneyPages(buildUrl, 6);
    let rows = uniqueStocks(result.rows.map(row => ({
      code: String(row.f12 || ''),
      name: row.f14 || '',
      market: String(row.f13 || ''),
      securityType: 'A股',
      sector: `线上板块 / ${board.name}`,
      source: `东方财富板块成分：${board.name}`
    }))).filter(isLikelyAStock);
    if (result.errors.length) rows = uniqueStocks([...rows, ...(readDiskCache(cacheName) || [])]);
    writeDiskCache(cacheName, rows);
    if (result.errors.length) appendLogLine({ type: 'warn', message: '板块成分页部分失败', action: 'board_stock_pages_partial', detail: { board: board.name, boardCode: board.code, count: rows.length, errors: result.errors } });
    return rows;
  } catch (err) {
    const cached = readDiskCache(cacheName);
    if (cached?.length) {
      appendLogLine({ type: 'warn', message: '板块成分接口失败，已使用本地缓存', action: 'board_stocks_cache_used', detail: { board: board.name, boardCode: board.code, count: cached.length, error: err.message || String(err) } });
      return cached;
    }
    throw err;
  }
}

async function searchStocksInternal(keyword) {
  const input = String(keyword || '').trim();
  if (!input) return { results: [], errors: [], source: '' };
  const errors = [];
  const entities = extractCommandEntities(input);
  if (['高铁', '铁路'].includes(entities.facility) && entities.locationParts.length >= 2) {
    const results = entityFallbackForCommand(input);
    if (results.length) return { results, errors, source: '线路与铁路产业链关系图谱' };
  }
  try {
    const results = (await fetchTencentSmartbox(input))
      .filter(item => /GP-A|A股/i.test(item.securityType || '') || allowsFundResults(input) && isTradableCandidate(item, true))
      .slice(0, 20);
    if (results.length) return { results, errors, source: '腾讯股票搜索' };
    errors.push('腾讯股票搜索返回空结果');
  } catch (err) {
    errors.push(`腾讯股票搜索失败：${err.message || err}`);
  }

  try {
    const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(input)}&type=14&token=D43BF722C8E33BD240066A6A1B24AE28&count=10`;
    const json = await getJsonWithRetry(url, 1);
    const items = json?.QuotationCodeTable?.Data || json?.data || [];
    const results = uniqueStocks(items.map(item => ({
      code: String(item.Code || item.code || '').slice(-6),
      name: item.Name || item.name || '',
      market: item.MktNum || item.market || '',
      securityType: item.SecurityTypeName || item.securityType || 'A股'
    })));
    if (results.length) return { results, errors, source: '东方财富搜索' };
    errors.push('东方财富搜索返回空结果');
  } catch (err) {
    errors.push(`东方财富搜索失败：${err.message || err}`);
  }

  try {
    const directory = await fetchStockDirectory();
    const results = uniqueStocks([...directory, ...fallbackStocks])
      .filter(item => item.name.includes(input) || item.code.includes(input))
      .slice(0, 20);
    if (results.length) return { results, errors, source: '东方财富A股列表' };
    errors.push('A股列表匹配为空');
  } catch (err) {
    errors.push(`A股列表搜索失败：${err.message || err}`);
  }

  try {
    const url = `http://suggest3.sinajs.cn/suggest/type=11,12,13,14,15&key=${encodeURIComponent(input)}&name=suggestdata`;
    const text = await getText(url, { Referer: 'http://finance.sina.com.cn/' }, 'gb18030');
    const body = text.split('"')[1] || '';
    const results = uniqueStocks(body.split(';').map(part => {
      const cols = part.split(',');
      const code = (part.match(/\b\d{6}\b/) || [''])[0];
      const fallback = fallbackStocks.find(x => x.code === code);
      const name = cols.find(x => /[\u4e00-\u9fa5]/.test(x)) || fallback?.name || code;
      return {code, name, market: cols[0] || '', securityType: 'A股'};
    })).slice(0, 10);
    if (results.length) return { results, errors, source: '新浪搜索' };
    errors.push('新浪搜索返回空结果');
  } catch (fallbackErr) {
    errors.push(`新浪搜索失败：${fallbackErr.message || fallbackErr}`);
  }

  const localResults = uniqueStocks(fallbackStocks.filter(item => item.name.includes(input) || item.code.includes(input)));
  if (localResults.length) return { results: localResults, errors, source: '内置兜底列表' };
  return { results: [], errors, source: '' };
}

const industryAliases = {
  AI: ['人工智能', '大模型', 'AI应用'],
  半导体: ['晶圆', '封测', '半导体设备', '集成电路'],
  芯片: ['国产芯片', 'AI芯片'],
  白酒: ['喝酒', '酒类', '酿酒'],
  猪肉: ['生猪', '生猪养殖', '猪饲料', '屠宰', '肉制品', '畜牧'],
  碳积分: ['碳交易', '碳中和', '碳排放', '环保', '节能', '林业', '绿电'],
  碳交易: ['碳积分', '碳中和', '碳排放', '环保', '节能', '绿电'],
  碳中和: ['碳交易', '碳排放', '环保', '节能', '新能源', '绿电'],
  算力: ['算力租赁', '智算中心', '数据中心', '云计算', '服务器', 'IDC', '液冷', '光模块', 'CPO'],
  新能源车: ['新能源', '汽车', '整车'],
  锂电池: ['锂电', '电池'],
  储能: ['电池', '逆变器', '新能源', '电力设备'],
  光伏: ['组件', '逆变器', '硅料', '太阳能'],
  风电: ['风力发电', '海上风电', '电力设备'],
  低空经济: ['低空', '无人机', 'eVTOL'],
  消费电子: ['手机', '果链', '手机产业链', '面板', '可穿戴', '智能终端'],
  电脑: ['个人电脑', 'PC', '笔记本', '电脑产业链'],
  软件: ['信创', '操作系统', '办公软件', '金融IT'],
  互联网: ['互联网金融', '云游戏'],
  港口海运: ['港口', '海运', '航运', '港口航运'],
  粮食: ['农业', '种业', '粮油', '农产品'],
  农业: ['粮食', '种业', '养殖', '农产品'],
  食品饮料: ['白酒', '啤酒', '乳业', '调味品', '休闲食品'],
  医药: ['医疗', '创新药', '医疗器械', '中药'],
  医疗: ['医药', '医疗器械', '创新药', '医院', '中药'],
  证券: ['券商'],
  银行: ['金融', '城商行', '农商行'],
  保险: ['金融', '非银金融'],
  有色: ['有色金属', '金属', '黄金', '铜'],
  稀土: ['有色金属', '稀土永磁', '小金属'],
  煤炭: ['煤炭开采', '焦煤', '动力煤', '煤化工'],
  钢铁: ['普钢', '特钢', '金属材料'],
  化工: ['基础化工', '化学制品', '煤化工', '氟化工'],
  房地产: ['地产', '物业', '建筑材料'],
  家电: ['白电', '小家电', '厨电'],
  传媒: ['游戏', '影视', '广告营销'],
  游戏: ['传媒', '云游戏', '互联网'],
  纳斯达克: ['纳指', '纳斯达克100', '纳指100'],
  纳指: ['纳斯达克', '纳斯达克100', '纳指100'],
  军工: ['国防军工', '航空', '航天', '船舶'],
  机器人: ['工业机器人', '自动化设备', '减速器'],
  电力: ['电网', '发电', '核电', '水电', '绿电'],
  高铁: ['铁路', '高速铁路', '铁路基建', '轨道交通', '动车组', '列车控制', '铁路信号', '铁路供电', '铁路运维'],
  铁路: ['高铁', '铁路基建', '轨道交通', '铁路装备', '铁路信号', '铁路运维'],
  机场: ['民航机场', '机场运营', '机场建设', '机场设备', '空港', '临空经济', '航空物流', '航站楼', '飞行区']
};

const entityRelationFallbacks = {
  机场: [
    { code: '000089', name: '深圳机场', sector: '机场运营 / 粤港澳大湾区', relation: '机场运营与区域机场群' },
    { code: '600004', name: '白云机场', sector: '机场运营 / 广东机场集团', relation: '机场运营与广东区域机场体系' },
    { code: '600009', name: '上海机场', sector: '机场运营', relation: '机场运营龙头' },
    { code: '600515', name: '海南机场', sector: '机场运营 / 临空产业', relation: '机场设施与临空产业运营' },
    { code: '002542', name: '中化岩土', sector: '机场建设 / 低空通航', relation: '机场场道施工与通用机场全生命周期' }
  ],
  高铁: [
    { code: '601390', name: '中国中铁', sector: '高铁产业链 / 线路土建', relation: '铁路勘察设计、施工和基础设施建设通用产业链' },
    { code: '601186', name: '中国铁建', sector: '高铁产业链 / 线路土建', relation: '铁路工程承包和基础设施建设通用产业链' },
    { code: '601766', name: '中国中车', sector: '高铁产业链 / 动车组', relation: '动车组及轨道交通装备通用产业链' },
    { code: '688187', name: '时代电气', sector: '高铁产业链 / 牵引系统', relation: '轨道交通牵引变流和控制系统通用产业链' },
    { code: '688569', name: '铁科轨道', sector: '高铁产业链 / 轨道部件', relation: '高速铁路扣件等轨道结构产品通用产业链' },
    { code: '603508', name: '思维列控', sector: '高铁产业链 / 列车控制', relation: '铁路列车运行控制及安全监测通用产业链' },
    { code: '002296', name: '辉煌科技', sector: '高铁产业链 / 信号监测', relation: '铁路信号和通信监测通用产业链' },
    { code: '300011', name: '鼎汉技术', sector: '高铁产业链 / 供电设备', relation: '轨道交通电源和车辆电气装备通用产业链' },
    { code: '000008', name: '神州高铁', sector: '高铁产业链 / 运营维护', relation: '轨道交通运营检修和智能运维通用产业链' }
  ],
  铁路: [
    { code: '601390', name: '中国中铁', sector: '铁路产业链 / 线路土建', relation: '铁路勘察设计、施工和基础设施建设通用产业链' },
    { code: '601186', name: '中国铁建', sector: '铁路产业链 / 线路土建', relation: '铁路工程承包和基础设施建设通用产业链' },
    { code: '601766', name: '中国中车', sector: '铁路产业链 / 车辆装备', relation: '铁路车辆及轨道交通装备通用产业链' },
    { code: '000008', name: '神州高铁', sector: '铁路产业链 / 运营维护', relation: '轨道交通运营检修和智能运维通用产业链' }
  ],
  惠州: [
    { code: '000089', name: '深圳机场', sector: '区域关联 / 深圳第二机场', relation: '惠州机场定位服务深圳及大湾区机场群' },
    { code: '002542', name: '中化岩土', sector: '机场建设 / 通航', relation: '机场建设与通航业务关联' },
    { code: '000592', name: '平潭发展', sector: '间接关联 / 名称实体待核验', relation: '名称含平潭但地域并非惠州平潭镇，仅作为用户指定的间接关联并明确提示核验' }
  ],
  大连: [
    { code: '605598', name: '上海港湾', sector: '大连金州湾机场 / 地基处理', relation: '联合体中标大连金州湾国际机场航站区深层地基处理工程' },
    { code: '601800', name: '中国交建', sector: '大连金州湾机场 / 基础设施', relation: '公开年报披露中标大连新机场通道及深层地基处理工程' },
    { code: '601668', name: '中国建筑', sector: '大连金州湾机场 / 航站楼建设', relation: '旗下中建八局等联合体中标航站楼、楼前高架桥及附属设施工程' },
    { code: '601186', name: '中国铁建', sector: '大连金州湾机场 / 进场交通', relation: '旗下单位参与机场进场路高架桥、下穿通道及附属设施工程' }
  ]
};

const specificIndustryRelations = {
  算力租赁: [
    { code:'603629', name:'利通电子', sector:'算力租赁 / 智算中心', relation:'算力租赁和智算中心业务关联' },
    { code:'603881', name:'数据港', sector:'算力租赁 / IDC', relation:'数据中心运营与算力基础设施' },
    { code:'300442', name:'润泽科技', sector:'智算中心 / 数据中心', relation:'智算中心和数据中心运营' },
    { code:'603887', name:'城地香江', sector:'算力租赁 / 数据中心', relation:'数据中心与算力服务关联' }
  ],
  智算中心: [
    { code:'300442', name:'润泽科技', sector:'智算中心 / 数据中心', relation:'智算中心和数据中心运营' },
    { code:'603629', name:'利通电子', sector:'算力租赁 / 智算中心', relation:'算力租赁和智算中心业务关联' }
  ]
};

function specificIndustryFallbackForCommand(command) {
  const input = String(command || '');
  return uniqueStocks(Object.entries(specificIndustryRelations).flatMap(([term, rows]) => input.includes(term) ? rows.map(item => ({
    ...item, securityType:'A股', source:'细分产业关系图谱补充', relevanceScore:110, relationEvidence:item.relation
  })) : []));
}

function extractCommandEntities(command) {
  const input = String(command || '').trim();
  const facility = ['机场', '港口', '医院', '园区', '电站', '水库', '铁路', '高铁', '地铁', '大桥', '矿山']
    .find(type => input.includes(type)) || '';
  const facilityIndex = facility ? input.indexOf(facility) : -1;
  const prefix = (facilityIndex >= 0 ? input.slice(0, facilityIndex) : '')
    .replace(/查找|寻找|搜索|生成|推荐|分析|股票|相关|A股/g, '');
  const locationParts = (prefix.match(/[\u4e00-\u9fa5]{2,8}/g) || []).flatMap(part => {
    if (part.length === 4) return [part.slice(0, 2), part.slice(2)];
    if (part.length <= 3) return [part];
    return [part.slice(0, 2), part.slice(-2)];
  });
  const relationTerms = facility === '机场'
    ? ['机场运营', '机场建设', '飞行区', '航站楼', '空港交通', '航空物流', '临空经济', '低空通航']
    : facility === '高铁' || facility === '铁路'
      ? ['铁路基建', '线路土建', '动车组', '轨道部件', '牵引系统', '列车控制', '铁路信号', '供电设备', '运营维护']
      : [];
  return { facility, locationParts:[...new Set(locationParts)], relationTerms };
}

function entityFallbackForCommand(command) {
  const entities = extractCommandEntities(command);
  if (!entities.facility) return [];
  const locationRows = entities.locationParts.flatMap(location => entityRelationFallbacks[location] || []);
  const rows = locationRows.length ? [...locationRows] : [...(entityRelationFallbacks[entities.facility] || [])];
  const routeLabel = !locationRows.length && ['高铁', '铁路'].includes(entities.facility) && entities.locationParts.length >= 2
    ? `${entities.locationParts[0]}—${entities.locationParts[1]}${entities.facility}` : '';
  return uniqueStocks(rows.map(item => ({
    ...item,
    sector: routeLabel ? `${routeLabel} / ${item.sector.split('/').slice(-1)[0].trim()}` : item.sector,
    securityType:'A股', source:'实体关系图谱补充',
    relevanceScore: item.sector.includes('间接关联') ? 55 : 95,
    relationEvidence: routeLabel
      ? `${routeLabel}按高铁通用产业链关联；${item.relation}，不代表已确认参与或中标该线路项目`
      : item.relation
  })));
}

function cleanCommandSubject(text) {
  return String(text || '')
    .replace(/AI选/ig, 'AI')
    .replace(/A股|股票|整个|全行业|全产业链|行业|板块|概念|产业链|产业|相关|公司|标的/g, '')
    .replace(/从下游到上游|从上游到下游|上下游|上游|中游|下游/g, '')
    .replace(/查找|寻找|搜索|生成|更新|按照|类型|分区|列出|筛选|推荐|分析|描述|龙头|待突破|已突破|重点关注|待回调|当前价格|最新情况|原因/g, '')
    .replace(/[，。、“”‘’：:；;,.!?！？\s]/g, '')
    .replace(/^全|全$/g, '')
    .trim();
}

function extractCommandSubject(command) {
  const input = String(command || '').trim();
  const patterns = [
    /(?:查找|寻找|搜索|生成)?\s*A?股?\s*(?:整个)?\s*([\u4e00-\u9fa5A-Za-z0-9]{2,16}?)(?:整个)?(?:行业|板块|概念|产业链)/i,
    /(?:查找|寻找|搜索|生成)\s*([\u4e00-\u9fa5A-Za-z0-9]{2,16}?)(?:行业|板块|概念|产业链)/i,
    /([\u4e00-\u9fa5A-Za-z0-9]{2,16}?)(?:行业|板块|概念|产业链)/i
  ];
  for (const pattern of patterns) {
    const match = input.match(pattern);
    const subject = cleanCommandSubject(match?.[1]);
    if (subject && subject.length >= 2) return subject;
  }
  const cleaned = cleanCommandSubject(input);
  return cleaned.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,12}/)?.[0] || cleaned.slice(0, 12);
}

function detectIndustryKeys(input) {
  const lower = input.toLowerCase();
  const allKeys = [...new Set([...Object.keys(industryFallbacks), ...Object.keys(industryAliases)])];
  const directKeys = allKeys.filter(key => input.includes(key) || (key === 'AI' && lower.includes('ai')));
  if (directKeys.length) return directKeys;
  return allKeys.filter(key => (industryAliases[key] || []).some(alias => input.includes(alias) || lower.includes(alias.toLowerCase())));
}

function buildIndustryTerms(command) {
  const input = String(command || '').trim();
  const terms = new Set();
  const subject = extractCommandSubject(input);
  const industryKeys = detectIndustryKeys(input);
  const explicitCodes = input.match(/\b\d{6}\b/g) || [];
  const entities = extractCommandEntities(input);

  if (subject) terms.add(subject);
  const expansionKeys = industryKeys.includes('AI') && industryKeys.length > 1
    ? industryKeys.filter(key => key !== 'AI')
    : industryKeys;
  expansionKeys.forEach(key => {
    terms.add(key);
    (industryAliases[key] || []).forEach(alias => terms.add(alias));
  });
  const broadAiTerms = new Set(['AI', ...(industryAliases.AI || [])]);
  subjectVariants(subject)
    .filter(term => !(industryKeys.includes('AI') && expansionKeys.length && !expansionKeys.includes('AI') && broadAiTerms.has(term)))
    .forEach(term => terms.add(term));

  explicitCodes.forEach(code => terms.add(code));
  if(entities.facility) terms.add(entities.facility);
  entities.locationParts.forEach(location => terms.add(location));
  entities.relationTerms.forEach(term => terms.add(term));

  if (!industryKeys.length) {
    const stopWords = /查找|寻找|搜索|生成|更新|股票|A股|整个|行业|产业链|产业|相关|按照|类型|分区|列出|龙头|待突破|已突破|重点关注|待回调|当前价格|最新情况|原因|上游|中游|下游|全部|所有/g;
    const cleaned = cleanCommandSubject(input.replace(stopWords, ' '));
    (cleaned.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,8}/g) || [])
      .filter(term => term.length <= 8 && !/^\d+$/.test(term) && !['行业','产业','类型','分区'].includes(term))
      .slice(0, 3)
      .forEach(term => terms.add(term));
  }

  return { terms: [...terms].slice(0, 20), explicitCodes, industryKeys, subject, entities };
}

function subjectVariants(subject) {
  const s = cleanCommandSubject(subject);
  const variants = new Set();
  if (!s) return [];
  const known = {
    港口海运: ['港口', '海运', '航运', '港口航运'],
    粮食: ['粮食', '农业', '种业', '农产品'],
    医疗: ['医疗', '医药', '医疗器械', '创新药'],
    医药: ['医药', '医疗', '创新药', '医疗器械'],
    半导体: ['半导体', '芯片', '半导体设备', '封测'],
    光伏: ['光伏', '组件', '逆变器', '硅料'],
    软件: ['软件', '信创', '操作系统', '金融IT']
  };
  Object.entries(known).forEach(([key, list]) => {
    if (s.includes(key) || key.includes(s)) list.forEach(x => variants.add(x));
  });
  const aliasEntries = Object.entries(industryAliases);
  const directEntries = aliasEntries.filter(([key]) => s.includes(key) || key.includes(s));
  const matchedEntries = directEntries.length ? directEntries : aliasEntries.filter(([_key, list]) =>
    list.some(alias => s.includes(alias) || alias.includes(s)));
  matchedEntries.forEach(([key, list]) => {
    variants.add(key);
    list.slice(0, 5).forEach(x => variants.add(x));
  });
  if (s.length >= 4) {
    variants.add(s.slice(0, 2));
    variants.add(s.slice(-2));
  }
  return [...variants].filter(x => x && x !== s).slice(0, 5);
}

function isLikelyAStock(item) {
  const code = String(item.code || '');
  const name = cleanStockName(item.name);
  if (!/^\d{6}$/.test(code)) return false;
  if (/^(399|980)/.test(code)) return false;
  if (/指数|产业|ETF|基金|板块|概念|转债|债券/.test(name)) return false;
  return true;
}

function allowsFundResults(input) {
  return /ETF|QDII|LOF|纳指|纳斯达克|标普|恒生|中概|指数基金/.test(String(input || ''));
}

function isTradableCandidate(item, allowFund = false) {
  if (isLikelyAStock(item)) return true;
  if (!allowFund) return false;
  const code = String(item.code || '');
  const name = cleanStockName(item.name);
  const type = String(item.securityType || '');
  return /^\d{6}$/.test(code)
    && !/^(399|980)/.test(code)
    && /ETF|LOF|QDII|基金/.test(`${name} ${type}`)
    && !/指数$|板块|概念/.test(name);
}

function resultMatchesCommand(item, command, industryKeys) {
  const subject = extractCommandSubject(command);
  const name = cleanStockName(item.name);
  const text = `${name} ${item.sector || ''}`;
  const entities = extractCommandEntities(command);
  if (entities.facility) {
    const mapped = entityFallbackForCommand(command);
    if (mapped.some(stock => stock.code === item.code || stock.name === name)) return true;
    const relationText = `${text} ${item.relationEvidence || ''}`;
    const locationMatched = !entities.locationParts.length || entities.locationParts.some(location => relationText.includes(location));
    const hasSpecificEvidence = Boolean(item.relationEvidence)
      || /公开资讯交叉识别|线上板块/.test(item.source || '')
      || /机场|空港/.test(name);
    return locationMatched && hasSpecificEvidence
      && [entities.facility, ...entities.relationTerms].some(term => relationText.includes(term))
      && !/航空公司|航线运营|航空运输|支线航空/.test(relationText);
  }
  if (!industryKeys.length) {
    if (/线上板块|A股目录行业匹配|行业词库/.test(item.source || '')) return true;
    return scoreSubjectText(subject, text, subjectVariants(subject)) >= 16;
  }
  if ((industryKeys || []).some(key => text.includes(key) || (industryAliases[key] || []).some(alias => text.includes(alias)))) return true;
  return [...fallbackForCommand(command), ...entityFallbackForCommand(command), ...specificIndustryFallbackForCommand(command)].some(stock => stock.code === item.code || stock.name === name);
}

function scoreBoard(board, subject, terms) {
  const name = cleanStockName(board.name);
  const cleanSubject = cleanCommandSubject(subject);
  let score = 0;
  if (cleanSubject && name === cleanSubject) score += 100;
  if (cleanSubject && name.includes(cleanSubject)) score += 80;
  if (cleanSubject && cleanSubject.includes(name)) score += 50;
  (terms || []).forEach(term => {
    const cleanTerm = cleanCommandSubject(term);
    if (cleanTerm && name.includes(cleanTerm)) score += 20;
  });
  return score;
}

function compactSubjectText(text) {
  return cleanCommandSubject(text)
    .replace(/股份|集团|有限|公司|行业|板块|概念/g, '')
    .toLowerCase();
}

function scoreSubjectText(subject, text, terms = []) {
  const s = compactSubjectText(subject);
  const t = compactSubjectText(text);
  if (!s || !t) return 0;
  let score = 0;
  if (t === s) score += 100;
  if (t.includes(s)) score += 70;
  if (s.includes(t) && t.length >= 2) score += 35;
  const chars = [...new Set(s.split(''))].filter(ch => /[\u4e00-\u9fa5A-Za-z0-9]/.test(ch));
  const hits = chars.filter(ch => t.includes(ch)).length;
  if (s.length >= 3 && hits >= Math.min(3, s.length)) score += hits * 8;
  terms.forEach(term => {
    const cleanTerm = compactSubjectText(term);
    if (cleanTerm && t.includes(cleanTerm)) score += 24;
  });
  return score;
}

async function findDirectoryStocksForSubject(subject, terms, errors) {
  try {
    const directory = await fetchStockDirectory();
    return uniqueStocks(directory.map(item => {
      const matchText = `${item.name} ${item.industry || ''} ${item.area || ''}`;
      return {
        ...item,
        sector: item.industry ? `线上A股目录 / ${item.industry}` : '线上A股目录 / 待确认',
        source: '东方财富A股目录行业匹配',
        score: scoreSubjectText(subject, matchText, terms)
      };
    }).filter(item => item.score >= 24)).slice(0, 60);
  } catch (err) {
    errors.push(`A股目录行业匹配失败：${err.message || err}`);
    return [];
  }
}

async function findBoardsForSubject(subject, terms, errors) {
  try {
    const boards = await fetchBoardDirectory();
    return boards
      .map(board => ({...board, score: scoreBoard(board, subject, terms)}))
      .filter(board => board.score >= 20)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  } catch (err) {
    errors.push(`线上板块查找失败：${err.message || err}`);
    return [];
  }
}

function stripHtml(text) {
  return decodeXmlText(String(text || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .slice(0, 600000);
}

function parseBingWebResults(html) {
  return [...String(html || '').matchAll(/<li class="b_algo"[\s\S]*?<\/li>/g)].map(match => {
    const block = match[0];
    const anchor = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    return {
      link: decodeXmlText(anchor?.[1] || ''),
      title: stripHtml(anchor?.[2] || ''),
      summary: stripHtml(block),
      source: 'Bing网页搜索'
    };
  }).filter(item => /^https?:\/\//i.test(item.link) && item.title);
}

async function fetchBingWebResults(keyword) {
  const html = await getText(`https://cn.bing.com/search?q=${encodeURIComponent(keyword)}&setlang=zh-CN&count=10`, {
    'User-Agent': 'Mozilla/5.0',
    'Accept-Language': 'zh-CN,zh;q=0.9'
  });
  return parseBingWebResults(html);
}

async function fetchChineseSearchDocuments(keyword) {
  const html = await getText(`https://www.so.com/s?q=${encodeURIComponent(keyword)}`, {
    'User-Agent': 'Mozilla/5.0',
    'Accept-Language': 'zh-CN,zh;q=0.9'
  });
  return [...html.matchAll(/<li class="res-list">([\s\S]*?)<\/li>/g)]
    .map(match => ({ text: stripHtml(match[1]), source: '360网页搜索' }))
    .filter(document => document.text.length >= 40);
}

async function discoverStocksFromIndustryNews(subject, terms, errors) {
  let marketStocks = [];
  try {
    marketStocks = (await fetchTencentMarketSnapshot()).quotes;
  } catch (err) {
    errors.push(`全市场股票名称加载失败：${err.message || err}`);
    marketStocks = readDiskCache('tencent-stock-directory', 30 * 24 * 60 * 60 * 1000) || [];
    if (marketStocks.length) errors.push(`已使用本地全市场名称快照：${marketStocks.length}只`);
    else try {
      marketStocks = await fetchStockDirectory();
    } catch (err) {
      errors.push(`备用股票目录加载失败：${err.message || err}`);
    }
  }
  if (!marketStocks.length) return [];

  const compactSubject = compactSubjectText(subject);
  const allTerms = [...new Set([subject, ...terms.filter(term => term.length >= 2)])];
  const directlyRelated = allTerms.filter(term => {
    const compact = compactSubjectText(term);
    return compactSubject.includes(compact) || compact.includes(compactSubject);
  }).sort((a, b) => b.length - a.length);
  const queryTerms = [...new Set([subject, ...directlyRelated, ...allTerms.filter(term => term.length >= 3)])].slice(0, 5);
  const searchGroups = await Promise.allSettled(queryTerms.map(term => fetchBingWebResults(`A股 "${term}" 产业链 概念股 股票名单`)));
  const searchResults = searchGroups.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  searchGroups.filter(result => result.status === 'rejected').forEach(result => errors.push(`产业资料搜索失败：${result.reason?.message || result.reason}`));
  const chineseSearchGroups = await Promise.allSettled(queryTerms.map(term => fetchChineseSearchDocuments(`${term} 核心股票 概念股 名单`)));
  const documents = [
    ...searchResults.map(item => ({ text: `${item.title} ${item.summary || ''}`, source: item.source })),
    ...chineseSearchGroups.flatMap(result => result.status === 'fulfilled' ? result.value : [])
  ];
  const pages = await Promise.allSettled(searchResults.slice(0, 8).map(item => getText(item.link, { 'User-Agent': 'Mozilla/5.0' })));
  pages.forEach((result, index) => {
    if (result.status === 'fulfilled') documents.push({ text: stripHtml(result.value), source: searchResults[index]?.source || '公开资讯' });
  });

  const longTerms = queryTerms.map(compactSubjectText).filter(term => term.length >= 3);
  const relevanceTerms = longTerms.length ? longTerms : queryTerms.map(compactSubjectText).filter(term => term.length >= 2);
  const compoundSubject = compactSubject.length >= 4;
  const trustedTerms = new Set([
    ...directlyRelated.map(compactSubjectText).filter(term => term.length >= 2),
    ...(compoundSubject ? [] : queryTerms.map(compactSubjectText).filter(term => term.length >= 4))
  ]);
  const platformCodes = /证券|券商|金融|互联网金融/.test(subject) ? new Set() : new Set(['300033', '300059']);
  const taxonomyTerms = new Set([
    ...Object.keys(industryAliases),
    ...Object.values(industryAliases).flat()
  ].map(compactSubjectText));
  const evidence = new Map();
  documents.forEach(document => {
    const compact = compactSubjectText(document.text);
    if (!relevanceTerms.some(term => compact.includes(term))) return;
    marketStocks.forEach(stock => {
      const name = cleanStockName(stock.name).replace(/^[*]?ST/i, '');
      const code = String(stock.code || '');
      if (platformCodes.has(code) || /ST|退/.test(stock.name)) return;
      const compactName = compactSubjectText(name);
      if (taxonomyTerms.has(compactName) && !relevanceTerms.includes(compactName)) return;
      const nameIndex = name.length >= 3 ? document.text.indexOf(name) : -1;
      const codeIndex = document.text.indexOf(code);
      const matchIndex = nameIndex >= 0 ? nameIndex : codeIndex;
      if (matchIndex >= 0) {
        const context = compactSubjectText(document.text.slice(Math.max(0, matchIndex - 240), matchIndex + 240));
        const matchedTerms = relevanceTerms.filter(term => context.includes(term));
        if (!matchedTerms.length) return;
        const current = evidence.get(code) || { ...stock, evidenceCount: 0 };
        current.evidenceCount++;
        current.matchedTerms = [...new Set([...(current.matchedTerms || []), ...matchedTerms])];
        evidence.set(code, current);
      }
    });
  });
  return [...evidence.values()]
    .filter(item => item.evidenceCount >= 2 || (item.matchedTerms || []).some(term => trustedTerms.has(term)))
    .sort((a, b) => b.evidenceCount - a.evidenceCount)
    .slice(0, 80)
    .map(item => ({
      ...item,
      sector: `公开产业资料 / ${[...(item.matchedTerms || [])].sort((a, b) => b.length - a.length)[0] || subject}`,
      source: `公开资讯交叉识别（${item.evidenceCount}处）`,
      relevanceScore: 45 + item.evidenceCount * 8
    }));
}

function balanceIndustryCandidates(items, limit = 80) {
  const groups = new Map();
  items.forEach(item => {
    const key = item.sector || '其他 / 待确认';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  const queues = [...groups.values()]
    .map(group => group.sort((a, b) => (b.relevanceScore || b.score || 0) - (a.relevanceScore || a.score || 0)))
    .sort((a, b) => (b[0]?.relevanceScore || b[0]?.score || 0) - (a[0]?.relevanceScore || a[0]?.score || 0));
  const result = [];
  while (result.length < limit && queues.some(queue => queue.length)) {
    queues.forEach(queue => {
      if (queue.length && result.length < limit) result.push(queue.shift());
    });
  }
  return result;
}

function fallbackForCommand(command) {
  const input = String(command || '');
  const rows = [];
  Object.entries(industryFallbacks).forEach(([key, items]) => {
    const matched = input.includes(key)
      || (key === 'AI' && input.toLowerCase().includes('ai'))
      || (industryAliases[key] || []).some(alias => input.includes(alias));
    if (matched) rows.push(...items);
  });
  return rows;
}

function inferSector(stock, command) {
  if (stock.sector) return stock.sector;
  const text = `${command} ${stock.name}`;
  if (/茅台|五粮液|泸州|汾酒|洋河|今世缘|白酒/.test(text)) return '白酒 / 品牌酒企';
  if (/牧原|温氏|猪|生猪|养殖|饲料|海大|新希望|唐人神/.test(text)) return '猪肉 / 养殖与饲料';
  if (/半导体|芯片|中芯|海光|寒武|兆易|北方华创|中微|封测|长电/.test(text)) return '半导体 / 芯片产业链';
  if (/算力|服务器|工业富联|浪潮/.test(text)) return 'AI算力 / 服务器与整机';
  if (/光模块|CPO|中际|新易盛/.test(text)) return 'AI算力 / CPO与光模块';
  if (/PCB|沪电|胜宏/.test(text)) return 'AI算力 / 高端PCB';
  return '其他 / 待确认';
}

function industryStockFromCandidate(item, command) {
  const sector = inferSector(item, command);
  const relevance = item.relevanceScore || item.score || 0;
  return {
    sector,
    name: cleanStockName(item.name),
    code: item.code,
    type: relevance >= 100 ? '核心候选' : '产业链候选',
    status: '待分析',
    focus: relevance >= 80 ? '重点分析' : '观察候选',
    relevanceScore: relevance,
    price: null,
    changePct: null,
    reason: `${sector}；行情表现待刷新；入选依据：${item.source || '通用行业查找脚本'}${item.relationEvidence ? `；关系证据：${item.relationEvidence}` : ''}，命令相关性 ${Math.round(relevance)}。刷新后再按实时行情、均线、量能和评分分类。`,
    news: '等待刷新实际行情；交易日盘中显示当日行情，非交易时间通常显示上一交易日数据。',
    source: item.source || '通用行业查找脚本'
  };
}

function decodeXmlText(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function emF10Code(code) {
  const value = String(code || '');
  const market = /^[48]/.test(value) ? 'BJ' : /^[569]/.test(value) ? 'SH' : 'SZ';
  return `${market}${value}`;
}

function financeMetric(row, key) {
  return finiteNumber(row?.[key]);
}

function scoreCurrentEarnings(latest) {
  if (!latest) return { available: false, score: null, evidence: '季度财务数据不可用' };
  const epsGrowth = financeMetric(latest, 'EPSJBTZ');
  const profitGrowth = financeMetric(latest, 'PARENTNETPROFITTZ');
  const revenueGrowth = financeMetric(latest, 'TOTALOPERATEREVETZ');
  const growth = epsGrowth ?? profitGrowth;
  if (growth === null) return { available: false, score: null, evidence: `${latest.REPORT_DATE_NAME || '最近报告期'}未提供EPS/净利润同比` };
  let score = growth >= 35 ? 95 : growth >= 25 ? 88 : growth >= 20 ? 78 : growth >= 10 ? 62 : growth >= 0 ? 48 : 18;
  if (revenueGrowth !== null && revenueGrowth >= 15) score += 5;
  if (revenueGrowth !== null && revenueGrowth < 0) score -= 10;
  return {
    available: true, score: clampRecommendationScore(score),
    evidence: `${latest.REPORT_DATE_NAME || '最近报告期'} EPS/净利同比${growth.toFixed(1)}%${revenueGrowth !== null ? `，营收同比${revenueGrowth.toFixed(1)}%` : ''}`
  };
}

function scoreAnnualEarnings(annualRows) {
  const rows = (annualRows || []).slice(0, 3);
  if (rows.length < 2) return { available: false, score: null, evidence: '近三年年报数据不足' };
  const eps = rows.map(row => financeMetric(row, 'EPSJB'));
  const roe = rows.map(row => financeMetric(row, 'ROEKCJQ') ?? financeMetric(row, 'ROEJQ'));
  const validEps = eps.filter(value => value !== null);
  const validRoe = roe.filter(value => value !== null);
  if (validEps.length < 2 && !validRoe.length) return { available: false, score: null, evidence: '年度EPS与ROE数据不可用' };
  const epsGrowing = validEps.length >= 3 && validEps[0] > validEps[1] && validEps[1] > validEps[2];
  const latestRoe = validRoe[0] ?? null;
  let score = epsGrowing ? 82 : validEps.length >= 2 && validEps[0] >= validEps[1] ? 68 : 38;
  if (latestRoe !== null) score += latestRoe >= 17 ? 13 : latestRoe >= 15 ? 9 : latestRoe >= 10 ? 2 : -16;
  return {
    available: true, score: clampRecommendationScore(score),
    evidence: `${rows.map((row, index) => `${row.REPORT_YEAR || row.REPORT_DATE_NAME || index + 1}:${eps[index] === null ? '--' : eps[index].toFixed(2)}`).join('，')}；最新扣非/加权ROE${latestRoe === null ? '--' : latestRoe.toFixed(1) + '%'}`
  };
}

function scoreFinancialQuality(latest, annualRows) {
  if (!latest) return { available: false, score: null, evidence: '财务质量数据不可用', checks: [] };
  const roe = financeMetric(latest, 'ROEKCJQ') ?? financeMetric(latest, 'ROEJQ');
  const cashPerShare = financeMetric(latest, 'MGJYXJJE');
  const currentRatio = financeMetric(latest, 'LD');
  const debtRatio = financeMetric(latest, 'ZCFZL');
  const grossMargin = financeMetric(latest, 'XSMLL');
  const netMargin = financeMetric(latest, 'XSJLL');
  const annualCash = (annualRows || []).slice(0, 3).map(row => financeMetric(row, 'MGJYXJJE')).filter(value => value !== null);
  const checks = [
    { label: 'ROE', available: roe !== null, passed: roe !== null && roe >= 10, value: roe === null ? '--' : `${roe.toFixed(1)}%` },
    { label: '经营现金流/股', available: cashPerShare !== null, passed: cashPerShare !== null && cashPerShare > 0, value: cashPerShare === null ? '--' : cashPerShare.toFixed(2) },
    { label: '流动比率', available: currentRatio !== null, passed: currentRatio !== null && currentRatio >= 1.5, value: currentRatio === null ? '--' : currentRatio.toFixed(2) },
    { label: '资产负债率', available: debtRatio !== null, passed: debtRatio !== null && debtRatio <= 60, value: debtRatio === null ? '--' : `${debtRatio.toFixed(1)}%` },
    { label: '毛利率', available: grossMargin !== null, passed: grossMargin !== null && grossMargin >= 20, value: grossMargin === null ? '--' : `${grossMargin.toFixed(1)}%` },
    { label: '净利率', available: netMargin !== null, passed: netMargin !== null && netMargin > 0, value: netMargin === null ? '--' : `${netMargin.toFixed(1)}%` },
    { label: '年度现金流持续为正', available: annualCash.length >= 2, passed: annualCash.length >= 2 && annualCash.every(value => value > 0), value: annualCash.length >= 2 ? `${annualCash.filter(value => value > 0).length}/${annualCash.length}年` : '--' }
  ];
  const available = checks.filter(check => check.available);
  return {
    available: available.length >= 3,
    score: available.length >= 3 ? clampRecommendationScore(available.filter(check => check.passed).length / available.length * 100) : null,
    evidence: available.length ? available.map(check => `${check.label}${check.value}`).join('，') : '关键财务质量指标不可用',
    checks
  };
}

function buildFinancialAnalysis(quarterRows, annualRows, source = '东方财富F10主要指标') {
  const quarters = (quarterRows || []).filter(Boolean);
  const annuals = (annualRows || []).filter(Boolean);
  const latest = quarters[0] || annuals[0] || null;
  const current = scoreCurrentEarnings(latest);
  const annual = scoreAnnualEarnings(annuals);
  const quality = scoreFinancialQuality(latest, annuals);
  const availableScores = [current, annual, quality].filter(item => item.available && item.score !== null);
  const hardRisks = [];
  const latestProfitGrowth = financeMetric(latest, 'PARENTNETPROFITTZ');
  const latestRevenueGrowth = financeMetric(latest, 'TOTALOPERATEREVETZ');
  const latestRoe = financeMetric(latest, 'ROEKCJQ') ?? financeMetric(latest, 'ROEJQ');
  const latestCash = financeMetric(latest, 'MGJYXJJE');
  if (latestProfitGrowth !== null && latestProfitGrowth < -30) hardRisks.push('最近报告期净利润同比下降超过30%');
  if (latestRevenueGrowth !== null && latestRevenueGrowth < -20) hardRisks.push('最近报告期营收同比下降超过20%');
  if (latestRoe !== null && latestRoe < 0) hardRisks.push('最近报告期ROE为负');
  if (latestCash !== null && latestCash < 0) hardRisks.push('最近报告期每股经营现金流为负');
  return {
    source, latestReport: latest?.REPORT_DATE_NAME || '', current, annual, quality,
    score: availableScores.length ? clampRecommendationScore(average(availableScores.map(item => item.score))) : null,
    available: availableScores.length, total: 3, hardRisks,
    rows: quarters.slice(0, 5).map(row => ({
      report: row.REPORT_DATE_NAME || '', eps: financeMetric(row, 'EPSJB'), epsGrowth: financeMetric(row, 'EPSJBTZ'),
      revenueGrowth: financeMetric(row, 'TOTALOPERATEREVETZ'), profitGrowth: financeMetric(row, 'PARENTNETPROFITTZ'),
      roe: financeMetric(row, 'ROEKCJQ') ?? financeMetric(row, 'ROEJQ'), grossMargin: financeMetric(row, 'XSMLL'),
      netMargin: financeMetric(row, 'XSJLL'), cashPerShare: financeMetric(row, 'MGJYXJJE')
    }))
  };
}

function normalizeSinaFundAmount(value, multiplier = 1) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return number * multiplier;
}

function normalizeSinaFundRatio(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.abs(number) <= 1 ? number * 100 : number;
}

function summarizeFundFlowRows(rows, days = 10) {
  const recent = (rows || []).map(row => {
    const rawInflow = finiteNumber(row.r0_in);
    const rawOutflow = finiteNumber(row.r0_out);
    const rawNetInflow = finiteNumber(row.r0_net);
    const hasGrossFields = rawInflow !== null || rawOutflow !== null;
    const values = [rawInflow, rawOutflow, rawNetInflow].filter(value => value !== null);
    const multiplier = hasGrossFields && values.every(value => Math.abs(value) < 1e6) ? 10000 : 1;
    const mainInflow = normalizeSinaFundAmount(rawInflow, multiplier);
    const mainOutflow = normalizeSinaFundAmount(rawOutflow, multiplier);
    const mainNetInflow = normalizeSinaFundAmount(rawNetInflow, multiplier);
    return {
      date: String(row.opendate || row.date || ''),
      mainInflow: mainInflow == null ? null : Math.abs(mainInflow),
      mainOutflow: mainOutflow == null ? null : Math.abs(mainOutflow),
      mainNetInflow,
      mainNetPct: normalizeSinaFundRatio(row.r0_ratio)
    };
  }).filter(row => row.date && row.mainNetInflow != null)
    .sort((a, b) => a.date.localeCompare(b.date)).slice(-days);
  if (!recent.length) return { available: false, days: 0, rows: [] };
  const grossFlowRows = recent.filter(row => row.mainInflow !== null && row.mainOutflow !== null);
  const grossFlowsAvailable = grossFlowRows.length === recent.length;
  const mainInflow = grossFlowsAvailable ? grossFlowRows.reduce((sum, row) => sum + row.mainInflow, 0) : null;
  const mainOutflow = grossFlowsAvailable ? grossFlowRows.reduce((sum, row) => sum + row.mainOutflow, 0) : null;
  const mainNetInflow = recent.reduce((sum, row) => sum + row.mainNetInflow, 0);
  const ratios = recent.map(row => row.mainNetPct).filter(value => value !== null);
  const netRatio = grossFlowsAvailable && mainInflow + mainOutflow
    ? mainNetInflow / (mainInflow + mainOutflow) * 100
    : ratios.length ? average(ratios) : null;
  return {
    available: true,
    days: recent.length,
    startDate: recent[0].date,
    endDate: recent.at(-1).date,
    mainInflow,
    mainOutflow,
    mainNetInflow,
    netRatio,
    grossFlowsAvailable,
    positiveDays: recent.filter(row => row.mainNetInflow > 0).length,
    rows: recent
  };
}

async function fetchSinaFundFlowHistory(code, days = 10, force = false) {
  const cacheKey = `${code}:${days}`;
  const cached = force ? null : readTimedCache(stockFundFlowHistoryCache, cacheKey, 10 * 60 * 1000);
  if (cached) return cached;
  const symbol = `${marketPrefixOf(code)}${code}`;
  const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_zjlrqs?page=1&num=${days}&sort=opendate&asc=0&daima=${symbol}`;
  const text = await getText(url, { Referer: 'https://finance.sina.com.cn/', Accept: '*/*' });
  const rows = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
  const summary = summarizeFundFlowRows(rows, days);
  if (!summary.available) throw new Error('新浪阶段资金流向为空');
  return writeTimedCache(stockFundFlowHistoryCache, cacheKey, { ...summary, source: '新浪历史资金流向' });
}

function splitDataCenterFinancialRows(rows) {
  const quarters = (rows || []).filter(Boolean);
  const annuals = quarters.filter(row => String(row.REPORT_TYPE || row.REPORT_DATE_NAME || '').includes('年报'));
  return { quarters, annuals };
}

function mapSinaFinancialData(data) {
  const reports = data?.report_date || [];
  const reportList = data?.report_list || {};
  const rows = reports.map(report => {
    const items = reportList[report.date_value]?.data || [];
    const byField = new Map(items.filter(item => item?.item_field).map(item => [item.item_field, item]));
    const value = field => finiteNumber(byField.get(field)?.item_value);
    const growth = field => {
      const ratio = finiteNumber(byField.get(field)?.item_tongbi);
      return ratio === null ? null : ratio * 100;
    };
    return {
      REPORT_DATE_NAME: report.date_description || String(report.date_value || ''),
      REPORT_TYPE: report.date_description || '',
      REPORT_YEAR: String(report.date_value || '').slice(0, 4),
      EPSJB: value('EPSBASIC'), EPSJBTZ: growth('EPSBASIC'),
      PARENTNETPROFITTZ: growth('PARENETP'), TOTALOPERATEREVETZ: growth('BIZTOTINCO'),
      ROEKCJQ: value('ROEWEIGHTED'), MGJYXJJE: value('OPNCFPS'), LD: value('CURRENTRT'),
      ZCFZL: value('ASSLIABRT'), XSMLL: value('SGPMARGIN'), XSJLL: value('SNPMARGINCONMS')
    };
  });
  return {
    quarters: rows,
    annuals: rows.filter((_row, index) => Number(reports[index]?.date_type) === 4)
  };
}

async function fetchSinaFinancialRows(code) {
  const symbol = `${marketPrefixOf(code)}${code}`;
  const params = new URLSearchParams({ paperCode:symbol, source:'gjzb', type:'0', page:'1', num:'20' });
  const json = await getJsonWithRetry(`https://quotes.sina.cn/cn/api/openapi.php/CompanyFinanceService.getFinanceReport2022?${params}`, 1);
  const data = json?.result?.data;
  const rows = mapSinaFinancialData(data);
  if (!rows.quarters.length) throw new Error('新浪财务接口返回空数据');
  return rows;
}

async function fetchDataCenterFinancialRows(code) {
  const cacheKey = String(code || '');
  const market = emF10Code(cacheKey).slice(0, 2);
  const params = new URLSearchParams({
    reportName: 'RPT_F10_FINANCE_MAINFINADATA',
    columns: 'ALL',
    filter: `(SECUCODE="${cacheKey}.${market}")`,
    pageNumber: '1',
    pageSize: '20',
    sortColumns: 'REPORT_DATE',
    sortTypes: '-1'
  });
  const json = await getJsonWithRetry(`https://datacenter-web.eastmoney.com/api/data/v1/get?${params}`, 1);
  const rows = json?.result?.data || [];
  if (!rows.length) throw new Error('备用财务接口返回空数据');
  return splitDataCenterFinancialRows(rows);
}

async function fetchStockFinancials({ code, force = false }) {
  const cacheKey = String(code || '');
  const cached = force ? null : readTimedCache(stockFinancialCache, cacheKey, 6 * 60 * 60 * 1000);
  if (cached) return { ...cached, cached: true };
  const previous = stockFinancialCache.get(cacheKey)?.value
    || readDiskCache(`stock-financial-${cacheKey}`, 180 * 24 * 60 * 60 * 1000);
  const endpoint = 'https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/ZYZBAjaxNew';
  const requests = await Promise.allSettled([0, 1].map(type => getJsonWithRetry(`${endpoint}?type=${type}&code=${encodeURIComponent(emF10Code(cacheKey))}`, 1)));
  const warnings = [];
  let quarters = requests[0].status === 'fulfilled' ? requests[0].value?.data || [] : [];
  let annuals = requests[1].status === 'fulfilled' ? requests[1].value?.data || [] : [];
  requests.forEach((result, index) => {
    if (result.status === 'rejected') warnings.push(`${index ? '年度' : '季度'}财务指标失败：${result.reason?.message || result.reason}`);
  });
  let source = '东方财富F10主要指标';
  if (!quarters.length || !annuals.length) {
    const hasPrimaryRows = Boolean(quarters.length || annuals.length);
    try {
      const fallback = await fetchDataCenterFinancialRows(cacheKey);
      if (!quarters.length) quarters = fallback.quarters;
      if (!annuals.length) annuals = fallback.annuals;
      source = hasPrimaryRows ? '东方财富F10与数据中心主要指标' : '东方财富数据中心主要指标';
    } catch (err) {
      warnings.push(`备用财务指标失败：${err.message || err}`);
    }
  }
  if (!quarters.length || !annuals.length) {
    const hasRows = Boolean(quarters.length || annuals.length);
    try {
      const fallback = await fetchSinaFinancialRows(cacheKey);
      if (!quarters.length) quarters = fallback.quarters;
      if (!annuals.length) annuals = fallback.annuals;
      source = hasRows ? `${source}与新浪财务主要指标` : '新浪财务主要指标';
    } catch (err) {
      warnings.push(`新浪财务指标失败：${err.message || err}`);
    }
  }
  const analysis = buildFinancialAnalysis(quarters, annuals, source);
  if (analysis.latestReport && analysis.available > 0) {
    const value = { analysis, errors: [], warnings };
    writeDiskCache(`stock-financial-${cacheKey}`, value);
    return writeTimedCache(stockFinancialCache, cacheKey, value);
  }
  if (previous?.analysis?.latestReport) {
    return {
      ...previous,
      analysis: {
        ...previous.analysis,
        source: `${previous.analysis.source || '财务指标'}（最近成功缓存）`
      },
      cached: true,
      stale: true,
      errors: [],
      warnings: [...warnings, '财务接口暂时异常，已沿用最近一次成功数据']
    };
  }
  return {
    analysis: null,
    errors: [...warnings, '财务指标暂时无法取得，本次不生成财务质量评分'],
    warnings
  };
}

function plainText(value) {
  return String(value || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function findTextByKeys(root, keys) {
  const wanted = keys.map(key => String(key).toUpperCase());
  const seen = new Set();
  function walk(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return '';
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = walk(item);
        if (hit) return hit;
      }
      return '';
    }
    for (const [key, val] of Object.entries(value)) {
      const upper = key.toUpperCase();
      if (wanted.some(item => upper.includes(item)) && typeof val !== 'object') {
        const text = plainText(val);
        if (text && text !== '--') return text;
      }
    }
    for (const val of Object.values(value)) {
      const hit = walk(val);
      if (hit) return hit;
    }
    return '';
  }
  return walk(root);
}

function findPointText(root, labels) {
  const wanted = labels.map(label => String(label).toLowerCase());
  const rows = [];
  const seen = new Set();
  function walk(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    const title = plainText(value.POINT_NAME || value.TITLE || value.KEY_NAME || value.name || value.title);
    const content = plainText(value.POINT_CONTENT || value.CONTENT || value.VALUE || value.DESCRIPTION || value.content || value.value);
    if (title && content && wanted.some(label => title.toLowerCase().includes(label))) rows.push(`${title}：${content}`);
    Object.values(value).forEach(walk);
  }
  walk(root);
  return rows[0] || '';
}

function isGenericSector(value) {
  return /^(线上搜索|待确认|其他\s*\/\s*待确认|命令指定代码)?$/.test(String(value || '').trim());
}

async function fetchStockBoards(code) {
  const url = `https://push2.eastmoney.com/api/qt/slist/get?fltt=2&invt=2&secid=${encodeURIComponent(secidOf(code))}&spt=3&pi=0&pz=200&po=1&fields=f12,f14,f3,f128&_=${Date.now()}`;
  const json = await getJsonWithRetry(url, 1);
  const diff = json?.data?.diff || [];
  const rows = Array.isArray(diff) ? diff : Object.values(diff);
  return [...new Set(rows.map(row => cleanStockName(row.f14)).filter(Boolean))];
}

async function fetchCompanyProfile({ code, name, sector, force = false }) {
  const cacheKey = String(code || '');
  const cached = force ? null : readTimedCache(companyProfileCache, cacheKey, 30 * 60 * 1000);
  if (cached) return { ...cached, cached: true };
  const errors = [];
  const profile = {
    code,
    name: cleanStockName(name),
    industry: isGenericSector(sector) ? '' : sector,
    business: '',
    products: '',
    summary: '',
    source: '',
    tags: []
  };
  const requests = await settleWithConcurrency([
    () => fetchStockBoards(code),
    () => getJsonWithRetry(`https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=${encodeURIComponent(emF10Code(code))}`, 1),
    () => getJsonWithRetry(`https://emweb.securities.eastmoney.com/PC_HSF10/OperationsRequired/PageAjax?code=${encodeURIComponent(emF10Code(code))}`, 1),
    () => getJsonWithRetry(`https://emweb.securities.eastmoney.com/PC_HSF10/BusinessAnalysis/PageAjax?code=${encodeURIComponent(emF10Code(code))}`, 1)
  ], 2, request => request());
  try {
    if (requests[0].status === 'rejected') throw requests[0].reason;
    profile.tags = requests[0].value;
    profile.industry ||= profile.tags[0] || '';
    if (profile.tags.length) profile.source = '东方财富板块归属';
  } catch (err) {
    errors.push(`板块归属失败：${err.message || err}`);
  }
  try {
    if (requests[1].status === 'rejected') throw requests[1].reason;
    const survey = requests[1].value;
    const data = survey?.jbzl || survey?.data?.jbzl || survey?.CompanySurvey || {};
    profile.industry = cleanStockName(data.SSHY || data.INDUSTRY || data.HY || data.BK || profile.industry);
    profile.business = plainText(data.JYFW || data.MAINBUSIN || data.ZYFW || '');
    profile.summary = plainText(data.GSJJ || data.COMPANY_PROFILE || data.INTRODUCTION || '');
    profile.source = [profile.source, '东方财富F10'].filter(Boolean).join(' + ');
  } catch (err) {
    errors.push(`公司概况失败：${err.message || err}`);
  }
  try {
    if (requests[2].status === 'rejected') throw requests[2].reason;
    const required = requests[2].value;
    profile.industry ||= findPointText(required, ['所属板块']) || findTextByKeys(required, ['SSBK', 'INDUSTRY', 'BK']);
    profile.business ||= findPointText(required, ['经营范围']) || findTextByKeys(required, ['JYFW', 'BUSINESS_SCOPE']);
    profile.summary ||= findPointText(required, ['主营业务']) || findPointText(required, ['核心题材']) || findTextByKeys(required, ['GSJJ', 'MAIN_BUSINESS', 'INTRODUCTION']);
    if (profile.business || profile.summary) profile.source = [profile.source, '东方财富F10操盘必读'].filter(Boolean).join(' + ');
  } catch (err) {
    errors.push(`操盘必读失败：${err.message || err}`);
  }
  try {
    if (requests[3].status === 'rejected') throw requests[3].reason;
    const business = requests[3].value;
    const rows = business?.zygcfx || business?.data?.zygcfx || business?.zygcfxList || [];
    const productRows = Array.isArray(rows) ? rows : [];
    profile.products = productRows.slice(0, 8).map(row => {
      const item = row.MAINOP_TYPE || row.PRODUCTNAME || row.ITEM_NAME || row.FL || row.name || '';
      const revenue = row.MAIN_BUSINESS_INCOME || row.INCOME || row.YYSR || '';
      return [item, revenue].filter(Boolean).join('：');
    }).filter(Boolean).join('；');
    if (profile.products && !profile.source) profile.source = '东方财富F10';
  } catch (err) {
    errors.push(`经营分析失败：${err.message || err}`);
  }
  return writeTimedCache(companyProfileCache, cacheKey, { profile, errors });
}

function normalizeHistoryRows(rows) {
  return (rows || []).map(row => Array.isArray(row) ? {
    date: row[0], open: finiteNumber(row[1]), close: finiteNumber(row[2]),
    high: finiteNumber(row[3]), low: finiteNumber(row[4]), volume: finiteNumber(row[5])
  } : {
    date: row.day || row.date, open: finiteNumber(row.open), close: finiteNumber(row.close),
    high: finiteNumber(row.high), low: finiteNumber(row.low), volume: finiteNumber(row.volume)
  }).filter(row => row.date && row.close != null && row.high != null && row.low != null);
}

function aggregateHistoryPeriod(rows, period) {
  const groups = new Map();
  normalizeHistoryRows(rows).forEach(row => {
    const date = new Date(`${row.date}T00:00:00Z`);
    if (!Number.isFinite(date.getTime())) return;
    if (period === 'week') date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    const key = period === 'month' ? row.date.slice(0, 7) : date.toISOString().slice(0, 10);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return [...groups.values()].map(group => {
    const first = group[0];
    const last = group.at(-1);
    const candle = {
      date: last.date,
      open: first.open,
      high: Math.max(...group.map(row => row.high)),
      low: Math.min(...group.map(row => row.low)),
      close: last.close,
      volume: group.reduce((sum, row) => sum + (row.volume || 0), 0)
    };
    if (group.some(row => Number.isFinite(row.amount))) {
      candle.amount = group.reduce((sum, row) => sum + (row.amount || 0), 0);
    }
    return candle;
  });
}

function mergeQuoteIntoHistory(history, quote) {
  const merged = [...(history || [])];
  if (!quote?.tradeDate || !(quote.price > 0)) return merged;
  const liveRow = {
    date: quote.tradeDate,
    open: quote.open || quote.price,
    close: quote.price,
    high: quote.high || quote.price,
    low: quote.low || quote.price,
    volume: quote.volume || 0,
    amount: quote.amount || 0
  };
  const existingIndex = merged.findIndex(row => row.date === quote.tradeDate);
  if (existingIndex >= 0) merged[existingIndex] = { ...merged[existingIndex], ...liveRow };
  else merged.push(liveRow);
  return merged.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

async function fetchTencentHistory(code, count = 120) {
  const symbol = `${marketPrefixOf(code)}${code}`;
  const json = await getJsonWithRetry(`https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${count},qfq&_=${Date.now()}`, 1);
  const data = json?.data?.[symbol] || {};
  return normalizeHistoryRows(data.qfqday || data.day || []);
}

async function fetchSinaHistory(code, count = 66) {
  const symbol = `${marketPrefixOf(code)}${code}`;
  const safeCount = Math.max(20, Math.min(1000, Number(count) || 66));
  const text = await getText(`https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20history=/CN_MarketDataService.getKLineData?symbol=${symbol}&scale=240&ma=no&datalen=${safeCount}`, { Referer: 'https://finance.sina.com.cn/' });
  const jsonText = (text.match(/=\s*\(([\s\S]*?)\);?\s*$/) || [])[1];
  if (!jsonText) throw new Error('新浪日线返回格式异常');
  return normalizeHistoryRows(JSON.parse(jsonText));
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function roundMetric(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function emaSeries(values, span) {
  if (!values.length) return [];
  const multiplier = 2 / (span + 1);
  const output = [values[0]];
  for (let index = 1; index < values.length; index++) output.push(values[index] * multiplier + output[index - 1] * (1 - multiplier));
  return output;
}

function standardDeviation(values) {
  const mean = average(values);
  if (mean == null || !values.length) return null;
  return Math.sqrt(average(values.map(value => (value - mean) ** 2)) || 0);
}

function percentageReturn(rows, days) {
  const start = rows.at(-(days + 1));
  const latest = rows.at(-1);
  return start?.close ? (latest.close / start.close - 1) * 100 : null;
}

function analyzeConsolidationBreakout(history) {
  const rows = (history || []).filter(row => Number.isFinite(row?.close) && Number.isFinite(row?.volume))
    .map(row => ({
      ...row,
      open: Number.isFinite(row.open) ? row.open : row.close,
      high: Number.isFinite(row.high) ? row.high : row.close,
      low: Number.isFinite(row.low) ? row.low : row.close
    })).slice(-120);
  const empty = {
    available: false, isConsolidating: false, status: '数据不足', technicalScore: 0,
    boxDays: 0, boxLow: null, boxHigh: null, rangePct: null, distanceToBreakoutPct: null,
    volumeCompressionRatio: null, pressureTestCount: 0, failedPressureCount: 0,
    breakoutConfirmed: false, overheated: false, explosiveVolume: false, explosiveVolumeCount: 0,
    summary: '历史行情不足，暂不能评估横盘突破', trigger: '', invalidation: ''
  };
  if (rows.length < 35) return empty;
  const latest = rows.at(-1);
  const candidates = [12, 11, 10, 9, 8, 7].map(days => {
    const startIndex = rows.length - days - 1;
    const boxRows = rows.slice(startIndex, -1);
    const boxHigh = Math.max(...boxRows.map(row => row.high));
    const boxLow = Math.min(...boxRows.map(row => row.low));
    const center = (boxHigh + boxLow) / 2;
    const rangePct = center ? (boxHigh - boxLow) / center * 100 : Infinity;
    const averageAbsChangePct = average(boxRows.slice(1).map((row, index) => {
      const previous = boxRows[index].close;
      return previous ? Math.abs(row.close / previous - 1) * 100 : 0;
    }));
    return { days, startIndex, boxRows, boxHigh, boxLow, rangePct, averageAbsChangePct };
  });
  const box = candidates.find(item => item.rangePct <= 10 && item.averageAbsChangePct <= 2.5);
  if (!box) return { ...empty, available: true, status: '非横盘', summary: '最近7至12日未形成稳定横盘箱体' };

  const prior20Volume = average(rows.slice(-21, -1).map(row => row.volume)) || latest.volume;
  const recent5Volume = average(rows.slice(-5).map(row => row.volume)) || latest.volume;
  const volumeCompressionRatio = prior20Volume ? recent5Volume / prior20Volume : 1;
  let pressureTestCount = 0;
  let failedPressureCount = 0;
  let explosiveVolumeCount = 0;
  box.boxRows.forEach((row, offset) => {
    const index = box.startIndex + offset;
    const priorVolume = average(rows.slice(Math.max(0, index - 20), index).map(item => item.volume));
    const nearTop = row.high >= box.boxHigh * .985;
    const volumeRatio = priorVolume ? row.volume / priorVolume : 0;
    if (!nearTop) return;
    if (isExplosiveVolume(volumeRatio)) {
      explosiveVolumeCount++;
      return;
    }
    if (!isControlledVolumeExpansion(volumeRatio)) return;
    pressureTestCount++;
    const dayRange = Math.max(row.high - row.low, row.close * .001);
    const upperShadowRatio = (row.high - Math.max(row.open, row.close)) / dayRange;
    const closePosition = (row.close - row.low) / dayRange;
    if (upperShadowRatio > .45 || closePosition < .45) failedPressureCount++;
  });

  const closes = rows.map(row => row.close);
  const ma5 = average(closes.slice(-5));
  const ma10 = average(closes.slice(-10));
  const ma20 = average(closes.slice(-20));
  const ma20FiveDaysAgo = average(closes.slice(-25, -5));
  const shortAverageHealthy = ma5 >= ma10 * .995;
  const mediumAverageHealthy = ma20 >= ma20FiveDaysAgo * .99;
  const distanceToBreakoutPct = (box.boxHigh - latest.close) / box.boxHigh * 100;
  const currentVolumeRatio = prior20Volume ? latest.volume / prior20Volume : 0;
  const explosiveVolume = isExplosiveVolume(currentVolumeRatio);
  const breakoutConfirmed = latest.close > box.boxHigh && isControlledVolumeExpansion(currentVolumeRatio);
  const breakdown = latest.close < box.boxLow * .99;
  const return20 = percentageReturn(rows, 20) || 0;
  const overheated = return20 > 30 || latest.close > box.boxHigh * 1.08 || explosiveVolume;
  const isConsolidating = !breakdown && !overheated && (latest.close <= box.boxHigh * 1.02 || breakoutConfirmed);

  let technicalScore = 30;
  technicalScore += box.rangePct <= 7 ? 10 : 6;
  if (distanceToBreakoutPct >= 0 && distanceToBreakoutPct <= 4) technicalScore += 15;
  if (shortAverageHealthy) technicalScore += 10;
  if (mediumAverageHealthy) technicalScore += 10;
  if (volumeCompressionRatio <= .95) technicalScore += 8;
  if (pressureTestCount) technicalScore += 10;
  if (failedPressureCount) technicalScore -= 8;
  if (explosiveVolumeCount) technicalScore -= 8;
  if (breakoutConfirmed) technicalScore += 20;
  if (overheated) technicalScore -= explosiveVolume ? 25 : 15;
  if (breakdown) technicalScore -= 25;
  technicalScore = clampRecommendationScore(technicalScore);

  const status = breakdown || overheated ? '结构偏弱'
    : breakoutConfirmed ? '突破确认'
      : technicalScore >= 70 && distanceToBreakoutPct <= 2 ? '接近突破'
        : technicalScore >= 58 ? '突破蓄势' : '横盘观察';
  const summary = `近${box.days}日横盘箱体${box.boxLow.toFixed(2)}-${box.boxHigh.toFixed(2)}元，箱体宽度${box.rangePct.toFixed(1)}%，现价距箱顶${distanceToBreakoutPct >= 0 ? distanceToBreakoutPct.toFixed(1) + '%' : '已越过' + Math.abs(distanceToBreakoutPct).toFixed(1) + '%'}；量能压缩比${volumeCompressionRatio.toFixed(2)}，有效放量试压${pressureTestCount}次${failedPressureCount ? `，其中${failedPressureCount}次冲高回落` : ''}${explosiveVolumeCount ? `，另有${explosiveVolumeCount}次爆量不计入有效试压` : ''}${explosiveVolume ? `；当前量比${currentVolumeRatio.toFixed(2)}超过4.0倍，属于爆量` : ''}`;
  return {
    available: true, isConsolidating, status, technicalScore,
    boxDays: box.days, boxLow: roundMetric(box.boxLow), boxHigh: roundMetric(box.boxHigh),
    rangePct: roundMetric(box.rangePct, 1), distanceToBreakoutPct: roundMetric(distanceToBreakoutPct, 1),
    volumeCompressionRatio: roundMetric(volumeCompressionRatio), pressureTestCount, failedPressureCount, explosiveVolumeCount,
    breakoutConfirmed, overheated, explosiveVolume, currentVolumeRatio: roundMetric(currentVolumeRatio),
    shortAverageHealthy, mediumAverageHealthy, summary,
    trigger: `放量收盘突破${box.boxHigh.toFixed(2)}元，成交量达到20日均量1.5-4.0倍`,
    invalidation: `收盘跌破${box.boxLow.toFixed(2)}元，或放量冲高回落后连续两日未收复箱顶`
  };
}

function analyzeAccumulationSetup(history) {
  const rows = (history || []).filter(row => Number.isFinite(row?.close) && Number.isFinite(row?.volume)).slice(-120);
  const empty = {
    passed: false, bullishAlignment: false, diverging: false, notMainWave: false,
    volumeSurgeCount: 0, surgePriceRisePct: null, summary: '蓄势结构数据不足'
  };
  if (rows.length < 65) return empty;
  const closes = rows.map(row => row.close);
  const periods = [5, 10, 20, 30, 60];
  const averagesAt = index => periods.map(period => index >= period - 1
    ? average(closes.slice(index - period + 1, index + 1)) : null);
  const spreadOf = values => {
    if (values.some(value => !Number.isFinite(value))) return null;
    const center = average(values);
    return center ? (Math.max(...values) - Math.min(...values)) / center * 100 : null;
  };

  const adhesionCandidates = [];
  for (let index = Math.max(59, rows.length - 45); index <= rows.length - 8; index++) {
    const values = averagesAt(index);
    const spreadPct = spreadOf(values);
    const baseRows = rows.slice(Math.max(0, index - 59), index + 1);
    const low = Math.min(...baseRows.map(row => row.low ?? row.close));
    const high = Math.max(...baseRows.map(row => row.high ?? row.close));
    const bottomPositionPct = high > low ? (rows[index].close - low) / (high - low) * 100 : 50;
    if (spreadPct <= 4 && bottomPositionPct <= 55) {
      adhesionCandidates.push({ index, date: rows[index].date || '', close: rows[index].close, spreadPct, bottomPositionPct });
    }
  }
  if (!adhesionCandidates.length) return { ...empty, summary: '近阶段未识别到底部五线粘合' };
  const adhesion = adhesionCandidates.sort((a, b) => (a.spreadPct + a.bottomPositionPct * .02) - (b.spreadPct + b.bottomPositionPct * .02))[0];
  const currentAverages = averagesAt(rows.length - 1);
  const earlierAverages = averagesAt(rows.length - 4);
  const currentSpreadPct = spreadOf(currentAverages);
  const bullishAlignment = currentAverages.every((value, index) => index === currentAverages.length - 1 || value > currentAverages[index + 1]);
  const averagesRising = currentAverages.slice(0, 4).every((value, index) => value >= earlierAverages[index]);
  const diverging = averagesRising && currentSpreadPct >= Math.max(1.2, adhesion.spreadPct + .5);

  const surgeCandidates = [];
  for (let index = Math.max(20, adhesion.index + 1); index < rows.length; index++) {
    const priorVolume = average(rows.slice(index - 20, index).map(row => row.volume));
    const ratio = priorVolume ? rows[index].volume / priorVolume : 0;
    const previousClose = rows[index - 1].close;
    const dayChangePct = previousClose ? (rows[index].close / previousClose - 1) * 100 : 0;
    if (!isControlledVolumeExpansion(ratio) || dayChangePct < -1 || dayChangePct > 5.5) continue;
    const candidate = { index, date: rows[index].date || '', close: rows[index].close, ratio, dayChangePct };
    const previous = surgeCandidates.at(-1);
    if (previous && candidate.index - previous.index < 3) {
      if (candidate.ratio > previous.ratio) surgeCandidates[surgeCandidates.length - 1] = candidate;
    } else surgeCandidates.push(candidate);
  }
  let surgeTriple = null;
  for (let first = 0; first < surgeCandidates.length - 2; first++) {
    for (let second = first + 1; second < surgeCandidates.length - 1; second++) {
      for (let third = second + 1; third < surgeCandidates.length; third++) {
        const triple = [surgeCandidates[first], surgeCandidates[second], surgeCandidates[third]];
        const risePct = (triple[2].close / triple[0].close - 1) * 100;
        const pricesRising = triple[1].close >= triple[0].close * .99 && triple[2].close >= triple[1].close * .99;
        if (pricesRising && risePct >= 1.5 && risePct <= 18) surgeTriple = { rows: triple, risePct };
      }
    }
  }
  const baseRisePct = (rows.at(-1).close / adhesion.close - 1) * 100;
  const return20 = percentageReturn(rows, 20) || 0;
  const notMainWave = baseRisePct >= 2 && baseRisePct <= 30 && return20 <= 25;
  const passed = bullishAlignment && diverging && Boolean(surgeTriple) && notMainWave;
  const summary = passed
    ? `${adhesion.date || '阶段底部'}五线粘合后开始多头发散；识别${surgeCandidates.length}次温和放量，最近三次价格重心抬高${surgeTriple.risePct.toFixed(1)}%，区间上涨${baseRisePct.toFixed(1)}%，尚未进入快速主升`
    : `五线粘合${adhesion.spreadPct.toFixed(2)}%；多头排列${bullishAlignment ? '成立' : '未成立'}，发散${diverging ? '成立' : '未成立'}，温和放量${surgeCandidates.length}次，区间涨幅${baseRisePct.toFixed(1)}%`;
  return {
    passed, bullishAlignment, diverging, notMainWave, summary,
    adhesionDate: adhesion.date, adhesionSpreadPct: roundMetric(adhesion.spreadPct),
    currentSpreadPct: roundMetric(currentSpreadPct), baseRisePct: roundMetric(baseRisePct),
    volumeSurgeCount: surgeCandidates.length,
    surgePriceRisePct: surgeTriple ? roundMetric(surgeTriple.risePct) : null,
    surgeDates: surgeTriple ? surgeTriple.rows.map(row => row.date) : []
  };
}

function assessCurrentEntry({
  latestPrice, ma5, ma10, ma20, ma30, supportPrice, resistance, volumeRatio, rsi14,
  breakoutStatus, accumulationSetup = null, consolidationBreakout = null,
  macdHistogram = null, return20 = null
}) {
  const price = Number(latestPrice);
  const support = Number(supportPrice);
  const breakout = Number(resistance);
  const ratio = Number(volumeRatio);
  const evidence = [
    `现价${Number.isFinite(price) ? price.toFixed(2) : '--'}元`,
    `突破位${Number.isFinite(breakout) ? breakout.toFixed(2) : '--'}元`,
    `MA30 ${Number.isFinite(Number(ma30)) ? Number(ma30).toFixed(2) : '--'}元`,
    `量比${Number.isFinite(ratio) ? ratio.toFixed(2) : '--'}`
  ];
  const accumulationSignalCount = [
    accumulationSetup?.bullishAlignment,
    accumulationSetup?.diverging,
    accumulationSetup?.notMainWave
  ].filter(Boolean).length;
  const suspectedAccumulation = Boolean(!accumulationSetup?.passed
    && accumulationSetup?.adhesionDate
    && Number(accumulationSetup?.volumeSurgeCount || 0) >= 2
    && accumulationSignalCount >= 2);
  const accumulationSummary = !accumulationSetup
    ? '吸筹评估数据不足'
    : accumulationSetup.passed
      ? `吸筹特征成立：${accumulationSetup.summary}`
      : suspectedAccumulation
        ? `疑似吸筹：${accumulationSetup.summary}`
        : `吸筹证据不足：${accumulationSetup.summary || '未识别到底部均线粘合和温和放量组合'}`;
  const compression = Number(consolidationBreakout?.volumeCompressionRatio);
  const washoutSummary = !consolidationBreakout || !consolidationBreakout.available
    ? '洗盘评估数据不足'
    : consolidationBreakout.isConsolidating && Number.isFinite(compression) && compression <= 1
      ? `洗盘特征成立：${consolidationBreakout.summary}`
      : consolidationBreakout.isConsolidating
        ? `洗盘待确认：已形成${consolidationBreakout.boxDays || '--'}日箱体，但量能压缩比${Number.isFinite(compression) ? compression.toFixed(2) : '--'}尚未体现缩量`
        : `洗盘证据不足：${consolidationBreakout.summary || '最近7至12日未形成稳定横盘箱体'}`;
  const structureSummary = `${accumulationSummary}；${washoutSummary}`;
  const hasStructureSignal = Boolean(accumulationSetup?.passed || suspectedAccumulation
    || consolidationBreakout?.available && consolidationBreakout.isConsolidating);
  const withStructure = result => hasStructureSignal ? { ...result, structureSummary } : result;
  if (![price, support, breakout, Number(ma5), Number(ma10), Number(ma20), Number(ma30), ratio].every(Number.isFinite)) {
    return withStructure({ allowed: false, status: '数据待补充', tone: 'neutral', summary: '关键价格、均线或量能数据不足，暂不形成入场结论。', evidence });
  }
  const trendBroken = price < support * .99 || (price < Number(ma30) && Number(ma5) < Number(ma10) && Number(ma20) < Number(ma30));
  if (trendBroken) {
    return withStructure({ allowed: false, status: '破位', tone: 'negative', summary: `现价${price.toFixed(2)}元已跌破支撑${support.toFixed(2)}元或处于MA30 ${Number(ma30).toFixed(2)}元下方，短期均线转弱，当前走势已经破位，不建议入场。`, evidence });
  }
  if (isExplosiveVolume(ratio)) {
    return withStructure({ allowed: false, status: '爆量观察', tone: 'negative', summary: `当前量比${ratio.toFixed(2)}已超过4.0倍，属于爆量，波动和冲高回落风险偏高，不建议追入。`, evidence });
  }
  if (breakoutStatus === '结构偏弱') {
    return withStructure({ allowed: false, status: '结构偏弱', tone: 'negative', summary: '横盘或量价结构已经转弱，当前不建议入场，等待重新站回关键均线和支撑位。', evidence });
  }
  const priceConfirmed = price > breakout;
  const breakoutAdvancePct = breakout ? (price / breakout - 1) * 100 : 0;
  const trendConfirmed = price >= Number(ma30) && Number(ma5) >= Number(ma10) && Number(ma20) >= Number(ma30) * .98;
  const momentumHealthy = !Number.isFinite(Number(rsi14)) || Number(rsi14) <= 75;
  if (priceConfirmed && breakoutAdvancePct > 5) {
    return withStructure({ allowed: false, status: '不宜追高', tone: 'warning', summary: `现价${price.toFixed(2)}元已高于突破位${breakout.toFixed(2)}元${breakoutAdvancePct.toFixed(1)}%，偏离突破位较远，当前不建议追入，等待回踩确认。`, evidence });
  }
  if (priceConfirmed && trendConfirmed && momentumHealthy && isControlledVolumeExpansion(ratio)) {
    return withStructure({ allowed: true, status: '可分批入场', tone: 'positive', summary: `现价${price.toFixed(2)}元已收盘突破${breakout.toFixed(2)}元，站上MA30 ${Number(ma30).toFixed(2)}元，MA5不低于MA10，量比${ratio.toFixed(2)}处于1.5-4.0倍有效放量区间，可考虑分批入场。`, evidence });
  }
  if (priceConfirmed && ratio < CONTROLLED_VOLUME_MIN) {
    return withStructure({ allowed: false, status: '等待确认', tone: 'warning', summary: `现价${price.toFixed(2)}元虽已越过突破位${breakout.toFixed(2)}元，但量比${ratio.toFixed(2)}未达到1.5倍，有效放量尚未确认，暂不入场。`, evidence });
  }
  if (accumulationSetup?.passed) {
    const lowBuyCandidate = price >= support * .99
      && price <= Math.min(breakout * .98, Math.max(Number(ma20), Number(ma30)) * 1.06);
    const volumeDescription = ratio < 1 ? '当前缩量，抛压未明显放大' : `当前量比${ratio.toFixed(2)}，量能仍属温和`;
    const macdDescription = Number.isFinite(Number(macdHistogram))
      ? Number(macdHistogram) >= 0 ? 'MACD动能未转弱' : 'MACD仍待修复'
      : 'MACD数据待补充';
    return withStructure({
      allowed: false,
      status: lowBuyCandidate ? '底部吸筹观察' : '吸筹后等待回踩',
      tone: 'warning',
      setupType: 'bottom-accumulation',
      lowBuyCandidate,
      summary: `底部吸筹结构：${accumulationSetup.summary || '均线收敛后出现温和放量'}；${volumeDescription}，${macdDescription}${Number.isFinite(Number(return20)) ? `，近20日涨跌${Number(return20).toFixed(1)}%` : ''}。${lowBuyCandidate ? '价格仍处于支撑与箱顶之间，可等待阶段资金进一步确认后考虑分批低吸。' : '价格已离开低吸区，等待回踩关键均线后再评估。'}`,
      evidence: [...evidence, `温和放量${accumulationSetup.volumeSurgeCount || 0}次`, macdDescription]
    });
  }
  if (suspectedAccumulation) {
    const lowBuyCandidate = price >= support * .99
      && price <= Math.min(breakout * .98, Math.max(Number(ma20), Number(ma30)) * 1.06);
    return withStructure({
      allowed: false,
      status: '疑似吸筹，等待确认',
      tone: 'warning',
      setupType: 'bottom-accumulation',
      lowBuyCandidate,
      summary: `均线粘合、多头发散和温和放量已有部分吸筹特征，但尚未全部满足严格吸筹条件。当前量比${ratio.toFixed(2)}，${lowBuyCandidate ? '价格仍在支撑与阻力之间，可继续观察阶段资金是否连续净流入。' : '价格不在低吸区，等待回踩后再评估。'}`,
      evidence: [...evidence, `温和放量${accumulationSetup.volumeSurgeCount || 0}次`, '吸筹证据部分成立']
    });
  }
  if (consolidationBreakout?.available && consolidationBreakout.isConsolidating) {
    const boxLow = Number(consolidationBreakout.boxLow);
    const boxHigh = Number(consolidationBreakout.boxHigh);
    const compression = Number(consolidationBreakout.volumeCompressionRatio);
    const boxPosition = Number.isFinite(boxLow) && Number.isFinite(boxHigh) && boxHigh > boxLow
      ? (price - boxLow) / (boxHigh - boxLow) : null;
    const looksLikeWashout = Number.isFinite(compression) && compression <= 1
      && Number(consolidationBreakout.failedPressureCount || 0) <= 1;
    const lowBuyCandidate = looksLikeWashout && Number.isFinite(boxPosition)
      && boxPosition >= .1 && boxPosition <= .65 && price >= support * .99;
    const nearBoxTop = Number.isFinite(boxPosition) && boxPosition > .7;
    if (looksLikeWashout) {
      return withStructure({
        allowed: false,
        status: lowBuyCandidate ? '震荡洗盘观察' : nearBoxTop ? '震荡洗盘，等待回踩' : '震荡洗盘观察',
        tone: 'warning',
        setupType: 'sideways-washout',
        lowBuyCandidate,
        summary: `近${consolidationBreakout.boxDays || '--'}日维持${Number.isFinite(boxLow) ? boxLow.toFixed(2) : '--'}-${Number.isFinite(boxHigh) ? boxHigh.toFixed(2) : '--'}元箱体，近5日量能压缩至20日均量的${compression.toFixed(2)}倍，价格反复震荡但未破箱底，偏向缩量洗盘。${lowBuyCandidate ? '现价位于箱体中低位，可等待主力资金连续净流入后分批低吸。' : nearBoxTop ? '现价靠近箱顶，暂不追入，等待回踩或有效突破。' : '仍需资金和均线方向确认。'}`,
        evidence: [...evidence, `箱体位置${Number.isFinite(boxPosition) ? (boxPosition * 100).toFixed(0) + '%' : '--'}`, `量能压缩比${compression.toFixed(2)}`]
      });
    }
    return withStructure({
      allowed: false,
      status: '箱体震荡，洗盘待确认',
      tone: 'warning',
      setupType: 'sideways-consolidation',
      lowBuyCandidate: false,
      summary: `近${consolidationBreakout.boxDays || '--'}日仍在${Number.isFinite(boxLow) ? boxLow.toFixed(2) : '--'}-${Number.isFinite(boxHigh) ? boxHigh.toFixed(2) : '--'}元箱体内震荡，但近5日量能压缩比${Number.isFinite(compression) ? compression.toFixed(2) : '--'}尚未体现缩量，暂不能确认洗盘或吸筹。继续观察箱底是否守住、成交量是否收缩及阶段资金是否转为连续净流入。`,
      evidence: [...evidence, `箱体位置${Number.isFinite(boxPosition) ? (boxPosition * 100).toFixed(0) + '%' : '--'}`, `量能压缩比${Number.isFinite(compression) ? compression.toFixed(2) : '--'}`]
    });
  }
  const distancePct = breakout ? (breakout - price) / breakout * 100 : null;
  const position = Number.isFinite(distancePct) && distancePct >= 0 && distancePct <= 4 ? '已经接近突破位' : '尚未突破关键阻力';
  return withStructure({ allowed: false, status: '等待确认', tone: 'warning', summary: `现价${price.toFixed(2)}元${position}${breakout.toFixed(2)}元，当前量比${ratio.toFixed(2)}。尚未形成明确突破信号，结合下方吸筹与洗盘评估继续观察量价、资金和均线变化。`, evidence });
}

function buildTradePlan({ latestPrice, supportPrice, resistance, rangeHigh, recent10Low, ma5, ma10, ma20, ma30, atr14, volumeRatio, verdict }) {
  const atr = Math.max(Number(atr14) || 0, latestPrice * 0.015);
  const entryAnchor = Math.min(latestPrice, supportPrice);
  const entryLow = Math.max(0.01, entryAnchor - atr * 0.35);
  const entryHigh = Math.max(entryLow, Math.min(latestPrice, entryAnchor + atr * 0.2));
  const entryMid = (entryLow + entryHigh) / 2;
  const volatilityStop = entryAnchor - Math.max(atr * 0.8, entryAnchor * 0.025);
  const eightPercentStop = entryMid * .92;
  const tenDayStop = Number.isFinite(recent10Low) ? recent10Low * .98 : 0;
  const invalidationPrice = Math.max(0.01, Math.min(entryLow * .99,
    Math.max(volatilityStop, eightPercentStop, tenDayStop)));
  const riskPerShare = Math.max(entryMid - invalidationPrice, atr * 0.5);
  const target1 = Math.max(resistance, latestPrice + atr, entryMid + riskPerShare);
  const target2 = Math.max(target1 + atr * 0.8, Math.min(rangeHigh, entryMid + riskPerShare * 2));
  const target3 = Math.max(target2 + atr, entryMid + riskPerShare * 3);
  const stopPct = (entryMid - invalidationPrice) / entryMid * 100;
  const maxPositionPct = Math.min(30, 100 / Math.max(stopPct, 0.1));
  const enabled = !['不宜追高', '暂不适合介入'].includes(verdict) && latestPrice >= ma30 * 0.97;
  return {
    enabled,
    entryLow: roundMetric(entryLow),
    entryHigh: roundMetric(entryHigh),
    entryAnchor: roundMetric(entryAnchor),
    confirmationPrice: roundMetric(Math.max(resistance, ma20, ma10)),
    invalidationPrice: roundMetric(invalidationPrice),
    stopPct: roundMetric(stopPct, 1),
    maxPositionPct: roundMetric(maxPositionPct, 1),
    targets: [
      { price: roundMetric(target1), sellPct: 30 },
      { price: roundMetric(target2), sellPct: 30 },
      { price: roundMetric(target3), sellPct: 40 }
    ],
    entrySteps: [
      { buyPct: 40, condition: `进入${entryLow.toFixed(2)}-${entryHigh.toFixed(2)}元区间，日内不跌破${invalidationPrice.toFixed(2)}元且量能不高于20日均量` },
      { buyPct: 30, condition: `回踩后重新站上MA5（${ma5.toFixed(2)}元）并保持MA5不低于MA10（${ma10.toFixed(2)}元）` },
      { buyPct: 30, condition: `收盘突破${Math.max(resistance, ma20, ma10).toFixed(2)}元且量比处于1.5-4.0倍` }
    ],
    targetNotes: [
      `到达第一目标后卖出30%，剩余仓位保护价上移到低吸区中值${entryMid.toFixed(2)}元附近`,
      `到达第二目标后再卖出30%，剩余仓位以MA10（${ma10.toFixed(2)}元）、10日低点或第一目标下方0.5倍ATR中较高者保护`,
      `第三目标卖出剩余40%；若未到目标但放量冲高回落、收盘跌破MA5，也执行减仓`
    ],
    rationale: `区间依据最近支撑${supportPrice.toFixed(2)}元、MA20 ${ma20.toFixed(2)}元、MA30 ${ma30.toFixed(2)}元、10日低点${Number.isFinite(recent10Low) ? recent10Low.toFixed(2) : '--'}元及ATR14 ${atr14.toFixed(2)}元计算；初始止损距离不放宽至超过8%；当前量比${volumeRatio.toFixed(2)}`
  };
}

function analyzeHistory(history) {
  const rows = history.slice(-120);
  const closes = rows.map(row => row.close);
  const latest = rows.at(-1);
  const ma = days => average(closes.slice(-days));
  const ma5 = ma(5), ma10 = ma(10), ma20 = ma(20), ma30 = ma(30), ma60 = ma(60);
  const first = rows[0];
  const periodReturn = first?.close ? (latest.close / first.close - 1) * 100 : null;
  const rangeLow = Math.min(...rows.map(row => row.low));
  const rangeHigh = Math.max(...rows.map(row => row.high));
  const recent20 = rows.slice(-20);
  const prior20 = rows.slice(-21, -1);
  const support = Math.min(...recent20.map(row => row.low));
  const resistance = Math.max(...(prior20.length ? prior20 : recent20).map(row => row.high));
  const recentGains = closes.slice(-15).map((value, index, values) => index ? value - values[index - 1] : 0).slice(1);
  const avgGain = average(recentGains.map(value => Math.max(value, 0))) || 0;
  const avgLoss = average(recentGains.map(value => Math.max(-value, 0))) || 0;
  const rsi14 = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  const volume5 = average(rows.slice(-5).map(row => row.volume));
  const volume20 = average(rows.slice(-21, -1).map(row => row.volume)) || average(rows.slice(-20).map(row => row.volume));
  const volumeRatio = volume20 ? latest.volume / volume20 : 0;
  const volume5Ratio = volume20 ? volume5 / volume20 : 0;
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const difSeries = closes.map((_value, index) => ema12[index] - ema26[index]);
  const deaSeries = emaSeries(difSeries, 9);
  const macdDif = difSeries.at(-1);
  const macdDea = deaSeries.at(-1);
  const macdHistogram = (macdDif - macdDea) * 2;
  const macdHistogramThreeDaysAgo = (difSeries.at(-4) - deaSeries.at(-4)) * 2;
  const std20 = standardDeviation(closes.slice(-20)) || 0;
  const bollUpper = ma20 + std20 * 2;
  const bollLower = ma20 - std20 * 2;
  const trueRanges = rows.slice(1).map((row, index) => Math.max(
    row.high - row.low,
    Math.abs(row.high - rows[index].close),
    Math.abs(row.low - rows[index].close)
  ));
  const atr14 = average(trueRanges.slice(-14)) || 0;
  const dailyReturns = closes.slice(-21).map((value, index, values) => index ? (value / values[index - 1] - 1) : 0).slice(1);
  const volatility20 = (standardDeviation(dailyReturns) || 0) * Math.sqrt(252) * 100;
  let peak = closes[0], maxDrawdown = 0;
  closes.forEach(close => {
    peak = Math.max(peak, close);
    maxDrawdown = Math.min(maxDrawdown, (close / peak - 1) * 100);
  });
  const distanceToBreakout = resistance ? (resistance / latest.close - 1) * 100 : 0;
  const recent60 = rows.slice(-60);
  const recent60High = Math.max(...recent60.map(row => row.high));
  const bottomSearchStart = Math.max(0, recent60.length - 20);
  const bottomIndex = recent60.slice(bottomSearchStart)
    .reduce((lowestIndex, row, index, values) => row.low < values[lowestIndex].low ? index : lowestIndex, 0) + bottomSearchStart;
  const bottomRow = recent60[bottomIndex];
  const peakBeforeBottom = Math.max(...recent60.slice(0, bottomIndex + 1).map(row => row.high));
  const bottomDrawdown = peakBeforeBottom ? (bottomRow.low / peakBeforeBottom - 1) * 100 : 0;
  const reboundFromBottom = bottomRow.low ? (latest.close / bottomRow.low - 1) * 100 : 0;
  const bottomRangePosition = recent60High > bottomRow.low ? (latest.close - bottomRow.low) / (recent60High - bottomRow.low) * 100 : 50;
  const daysSinceBottom = recent60.length - 1 - bottomIndex;
  const ma5ThreeDaysAgo = average(closes.slice(-8, -3));
  const ma10ThreeDaysAgo = average(closes.slice(-13, -3));
  const shortAverageImproving = ma5 >= ma5ThreeDaysAgo && ma10 >= ma10ThreeDaysAgo;
  const macdImproving = macdHistogram > macdHistogramThreeDaysAgo;
  const return5 = percentageReturn(rows, 5);
  const return20 = percentageReturn(rows, 20);
  let reboundScore = 0;
  if (bottomDrawdown <= -18) reboundScore += 18;
  if (bottomDrawdown <= -30) reboundScore += 8;
  if (daysSinceBottom <= 20) reboundScore += 8;
  if (bottomRangePosition <= 35) reboundScore += 12;
  else if (bottomRangePosition <= 55) reboundScore += 7;
  if (shortAverageImproving) reboundScore += 12;
  if (macdImproving) reboundScore += 10;
  if (macdHistogram > 0) reboundScore += 8;
  if (latest.close >= ma20) reboundScore += 10;
  if (ma5 > ma10) reboundScore += 8;
  if (volume5Ratio >= .8 && volume5Ratio <= 2.5) reboundScore += 6;
  if (rsi14 >= 35 && rsi14 <= 72) reboundScore += 6;
  if (rsi14 > 80 || reboundFromBottom > 80 || bottomDrawdown > -12) reboundScore -= 18;
  reboundScore = Math.max(0, Math.min(100, Math.round(reboundScore)));
  const waitingForRebound = bottomDrawdown <= -18 && daysSinceBottom <= 20 && reboundFromBottom <= 12
    && bottomRangePosition <= 40 && latest.close <= ma20 * 1.04 && return5 >= -4
    && (shortAverageImproving || macdImproving) && rsi14 >= 30 && rsi14 <= 62;
  const reboundConfirmed = bottomDrawdown <= -18 && daysSinceBottom <= 35 && reboundFromBottom >= 6 && reboundFromBottom <= 80
    && latest.close >= ma20 && ma5 > ma10 && return5 >= -3 && rsi14 < 80
    && (macdHistogram > 0 || macdImproving && return5 >= 3);
  const reboundSignal = reboundConfirmed ? '已反弹' : waitingForRebound ? '底部待反弹' : '';
  const reboundReason = reboundSignal === '已反弹'
    ? `近60日从前高回撤${Math.abs(bottomDrawdown).toFixed(1)}%，${bottomRow.date}见阶段低点后反弹${reboundFromBottom.toFixed(1)}%；现价站上MA20，MA5高于MA10，MACD${macdHistogram > 0 ? '处于零轴上方' : '持续改善'}`
    : reboundSignal === '底部待反弹'
      ? `近60日从前高回撤${Math.abs(bottomDrawdown).toFixed(1)}%，距${bottomRow.date}阶段低点仅${reboundFromBottom.toFixed(1)}%；短均线或MACD开始改善，尚待站稳MA20和放量确认`
      : '';
  const supportCandidates = [ma5, ma10, ma20, ma30, ma60, support].filter(value => Number.isFinite(value) && value <= latest.close);
  const supportPrice = supportCandidates.length ? Math.max(...supportCandidates) : support;
  const bullishAlignment = ma5 > ma10 && ma10 > ma20 && ma20 > ma30 && ma30 > ma60;
  const bearishAlignment = ma5 < ma10 && ma10 < ma20 && ma20 < ma30 && ma30 < ma60;
  const maAlignment = bullishAlignment ? 'MA5/10/20/30/60多头排列'
    : bearishAlignment ? 'MA5/10/20/30/60空头排列'
      : ma20 >= ma30 && ma30 >= ma60 ? '中长期均线偏多，短期仍有分化'
        : ma20 < ma30 && ma30 < ma60 ? '中长期均线偏弱，等待趋势修复' : '均线交错，趋势尚未统一';
  const rising = latest.close > ma20 && ma20 >= ma30 && ma30 >= ma60;
  const falling = latest.close < ma20 && ma20 < ma30 && ma30 < ma60;
  const phase = rising ? '震荡上行' : falling ? '下行整理' : latest.close >= ma20 ? '反弹修复' : '区间震荡';
  const direction = periodReturn >= 0 ? '上涨' : '下跌';
  const accumulationSetup = analyzeAccumulationSetup(rows);
  const consolidationBreakout = analyzeConsolidationBreakout(rows);
  let score = 0;
  if (latest.close > ma20) score += 12;
  if (latest.close > ma30) score += 8;
  if (latest.close > ma60) score += 6;
  if (ma5 > ma10) score += 8;
  if (ma10 > ma20) score += 8;
  if (ma20 > ma30) score += 6;
  if (ma30 > ma60) score += 6;
  if (distanceToBreakout >= -1.5 && distanceToBreakout <= 4) score += 18;
  if (isControlledVolumeExpansion(volumeRatio)) score += 14;
  else if (volumeRatio >= .85 && volumeRatio < CONTROLLED_VOLUME_MIN) score += 7;
  if (rsi14 >= 50 && rsi14 <= 72) score += 8;
  if (macdHistogram > 0) score += 6;
  if (accumulationSetup.passed) score += 16;
  if (rsi14 > 80 || distanceToBreakout < -5 || isExplosiveVolume(volumeRatio)) score -= 18;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const verdict = rsi14 > 80 || distanceToBreakout < -5 || isExplosiveVolume(volumeRatio)
    ? '不宜追高'
    : score >= 72 ? '可关注' : score >= 50 ? '等待确认' : latest.close < ma20 ? '暂不适合介入' : '等待确认';
  const summary = `近${Math.min(rows.length, 120)}个交易日累计${direction}${Math.abs(periodReturn).toFixed(2)}%，当前处于${phase}阶段，${maAlignment}。现价${latest.close.toFixed(2)}元，MA5 ${ma5.toFixed(2)}元、MA10 ${ma10.toFixed(2)}元、MA20 ${ma20.toFixed(2)}元、MA30 ${ma30.toFixed(2)}元、MA60 ${ma60.toFixed(2)}元；近5/20/60日涨跌分别为${roundMetric(percentageReturn(rows, 5))}%/${roundMetric(percentageReturn(rows, 20))}%/${roundMetric(percentageReturn(rows, 60))}%。`;
  const volume = isExplosiveVolume(volumeRatio) ? `当日量为20日均量的${volumeRatio.toFixed(2)}倍，超过4.0倍，属于爆量，不作为健康突破确认；近5日均量比为${volume5Ratio.toFixed(2)}。` : isControlledVolumeExpansion(volumeRatio) ? `当日量为20日均量的${volumeRatio.toFixed(2)}倍，处于1.5-4.0倍有效放量区间；近5日均量比为${volume5Ratio.toFixed(2)}。` : volumeRatio <= .75 ? `当日量为20日均量的${volumeRatio.toFixed(2)}倍，当前缩量；近5日均量比为${volume5Ratio.toFixed(2)}。` : `当日量为20日均量的${volumeRatio.toFixed(2)}倍，未达到1.5倍有效放量标准；近5日均量比为${volume5Ratio.toFixed(2)}。`;
  const entry = rising
    ? `未来3-5个交易日观察回踩MA10（${ma10.toFixed(2)}元）、MA20（${ma20.toFixed(2)}元）或MA30（${ma30.toFixed(2)}元）后企稳；若以1.5-4.0倍量比收盘突破${resistance.toFixed(2)}元，可作为趋势确认。`
    : falling
      ? `当前不宜追价，等待收盘重新站上MA20（${ma20.toFixed(2)}元）和MA30（${ma30.toFixed(2)}元），再观察MA5上穿MA10。`
      : `未来3-10个交易日观察${support.toFixed(2)}元附近缩量企稳，或以1.5-4.0倍量比收盘突破${resistance.toFixed(2)}元后确认。`;
  const nearbySupportStop = Math.max(
    supportPrice < latest.close ? supportPrice * .97 : 0,
    ma30 < latest.close ? ma30 * .97 : 0
  );
  const stop = Math.min(latest.close * .995, Math.max(latest.close * .92,
    latest.close >= ma20 ? ma20 * .97 : nearbySupportStop || latest.close * .95));
  const exit = `收盘连续2日跌破MA20（${ma20.toFixed(2)}元）应降低仓位；继续跌破MA30（${ma30.toFixed(2)}元）或有效跌破${stop.toFixed(2)}元时加强风控；接近${resistance.toFixed(2)}元但放量滞涨时分批止盈。`;
  const buyCondition = verdict === '可关注'
    ? `不追涨，等待收盘站上${resistance.toFixed(2)}元且成交量处于20日均量1.5-4.0倍，或回踩${supportPrice.toFixed(2)}元附近缩量企稳后再评估。`
    : verdict === '不宜追高'
      ? `当前价格或指标偏热，等待回踩${supportPrice.toFixed(2)}元附近并让RSI回落至70以下，不满足前不介入。`
      : `等待收盘突破${resistance.toFixed(2)}元、站稳MA30（${ma30.toFixed(2)}元）、MA5保持高于MA10且量比处于1.5-4.0倍，再从“等待”转为“可关注”。`;
  const risk = `ATR14为${atr14.toFixed(2)}元，20日年化波动约${volatility20.toFixed(1)}%，区间最大回撤${maxDrawdown.toFixed(1)}%；波动越高，观察仓位应越小。`;
  const tradePlan = buildTradePlan({
    latestPrice: latest.close, supportPrice, resistance, rangeHigh, recent10Low: Math.min(...rows.slice(-10).map(row => row.low)),
    ma5, ma10, ma20, ma30, atr14, volumeRatio, verdict
  });
  const entryAssessment = assessCurrentEntry({
    latestPrice: latest.close, ma5, ma10, ma20, ma30, supportPrice, resistance,
    volumeRatio, rsi14, breakoutStatus: consolidationBreakout.status,
    accumulationSetup, consolidationBreakout, macdHistogram, return20
  });
  if (['破位', '爆量观察', '结构偏弱'].includes(entryAssessment.status)) tradePlan.enabled = false;
  return {
    summary, ma5: roundMetric(ma5), ma10: roundMetric(ma10), ma20: roundMetric(ma20), ma30: roundMetric(ma30), ma60: roundMetric(ma60), maAlignment,
    rsi14: roundMetric(rsi14, 1), rangeLow: roundMetric(rangeLow), rangeHigh: roundMetric(rangeHigh),
    return5: roundMetric(return5), return20: roundMetric(return20), return60: roundMetric(percentageReturn(rows, 60)),
    volume, volumeRatio: roundMetric(volumeRatio), volume5Ratio: roundMetric(volume5Ratio),
    macdDif: roundMetric(macdDif, 3), macdDea: roundMetric(macdDea, 3), macdHistogram: roundMetric(macdHistogram, 3),
    bollUpper: roundMetric(bollUpper), bollMiddle: roundMetric(ma20), bollLower: roundMetric(bollLower),
    atr14: roundMetric(atr14), volatility20: roundMetric(volatility20, 1), maxDrawdown: roundMetric(maxDrawdown, 1),
    breakoutPrice: roundMetric(resistance), supportPrice: roundMetric(supportPrice), distanceToBreakout: roundMetric(distanceToBreakout),
    score, verdict, buyCondition, risk, entry, exit, tradePlan, entryAssessment,
    reboundSignal, reboundScore, reboundReason, bottomDate: bottomRow.date,
    bottomPrice: roundMetric(bottomRow.low), bottomDrawdown: roundMetric(bottomDrawdown, 1),
    reboundFromBottom: roundMetric(reboundFromBottom, 1), bottomRangePosition: roundMetric(bottomRangePosition, 1),
    daysSinceBottom, macdImproving, shortAverageImproving, accumulationSetup, consolidationBreakout,
    entryWindow: falling ? '等待趋势条件触发，通常至少观察5-15个交易日。' : '未来3-10个交易日，条件未触发则继续等待。',
    exitWindow: '入场后1-4周持续观察，价格与成交量条件优先于固定日期。'
  };
}

async function fetchStockHistory({ code, name, force = false, favoriteOutcomes = [] }) {
  const cacheKey = String(code || '');
  const freshCachedQuotes = [...quoteCache.values()].filter(quote => !quote.stale
    && Date.now() - Date.parse(quote.fetchedAt || '') < 10 * 60 * 1000);
  let outcomeProfile = summarizeRecommendationOutcomes(mergeRecommendationOutcomeQuotes(favoriteOutcomes, freshCachedQuotes));
  let feedbackSignature = outcomeProfile.signature;
  const cached = force ? null : readTimedCache(stockHistoryCache, cacheKey, 2 * 60 * 1000);
  if (cached && (cached.feedbackSignature || '') === feedbackSignature) return { ...cached, cached: true };
  const historyErrors = [];
  const [historyResult, quoteResult, newsResult, riskResult, financialResult, fundFlowResult, marketNewsResult] = await Promise.allSettled([
    (async () => {
      try {
        const history = await fetchTencentHistory(cacheKey, 120);
        if (history.length >= 60) return { history, source: '腾讯前复权日线' };
      } catch (err) {
        historyErrors.push(`腾讯历史行情失败：${err.message || err}`);
      }
      try {
        return { history: await fetchSinaHistory(cacheKey), source: '新浪日线' };
      } catch (err) {
        historyErrors.push(`新浪历史行情失败：${err.message || err}`);
        return { history: [], source: '' };
      }
    })(),
    fetchTencentQuotes([cacheKey]),
    fetchStockNews({ code: cacheKey, name, force }),
    fetchFutureRiskProfile({ code: cacheKey, name, force: false }),
    fetchStockFinancials({ code: cacheKey, force: false }),
    fetchSinaFundFlowHistory(cacheKey, 10, force),
    fetchMarketNews(force)
  ]);
  const errors = [...historyErrors];
  let history = historyResult.status === 'fulfilled' ? historyResult.value.history : [];
  let source = historyResult.status === 'fulfilled' ? historyResult.value.source : '';
  if (historyResult.status === 'rejected') errors.push(`历史行情失败：${historyResult.reason?.message || historyResult.reason}`);
  try {
    if (quoteResult.status === 'rejected') throw quoteResult.reason;
    const liveQuote = quoteResult.value[0];
    if (liveQuote?.price > 0 && liveQuote.tradeDate) {
      quoteCache.set(cacheKey, liveQuote);
      history = mergeQuoteIntoHistory(history, liveQuote);
      source = `${source || '历史日线'} + 腾讯最新行情`;
    }
  } catch (err) {
    errors.push(`最新行情合并失败：${err.message || err}`);
  }
  outcomeProfile = summarizeRecommendationOutcomes(mergeRecommendationOutcomeQuotes(favoriteOutcomes, [...quoteCache.values()]));
  feedbackSignature = outcomeProfile.signature;
  if (history.length < 20) throw new Error(errors.join('；') || '历史行情不足');
  let analysis = analyzeHistory(history);
  const fundFlowPeriod = fundFlowResult.status === 'fulfilled'
    ? fundFlowResult.value
    : { available: false, days: 0, rows: [], source: '新浪历史资金流向' };
  if (fundFlowResult.status === 'rejected') errors.push(`阶段主力资金失败：${fundFlowResult.reason?.message || fundFlowResult.reason}`);
  analysis = applyIndividualCapitalAssessment(analysis, fundFlowPeriod);
  let newsContext = summarizeNews([]);
  try {
    if (newsResult.status === 'rejected') throw newsResult.reason;
    newsContext = summarizeNews(newsResult.value.news, '', { subject: name, code: cacheKey, ...newsResult.value });
    errors.push(...(newsResult.value.errors || []));
  } catch (err) {
    errors.push(`消息面分析失败：${err.message || err}`);
  }
  let marketNewsContext = summarizeNews([]);
  if (marketNewsResult.status === 'fulfilled') {
    marketNewsContext = summarizeNews(marketNewsResult.value.news, '', { ...marketNewsResult.value });
    errors.push(...(marketNewsResult.value.errors || []));
  } else {
    errors.push(`大盘实时消息分析失败：${marketNewsResult.reason?.message || marketNewsResult.reason}`);
  }
  if (newsContext.signal === '偏谨慎' && analysis.verdict === '可关注') analysis.verdict = '等待确认';
  const riskProfile = riskResult.status === 'fulfilled'
    ? riskResult.value
    : buildFutureRiskProfile({ name, unlockRows: null, reductionAnnouncements: null });
  if (riskResult.status === 'rejected') errors.push(`未来半年公司风险查询失败：${riskResult.reason?.message || riskResult.reason}`);
  errors.push(...(riskProfile.errors || []));
  if (riskProfile.status === 'risk') {
    analysis.verdict = '暂不适合介入';
    if (analysis.tradePlan) analysis.tradePlan.enabled = false;
  } else if (riskProfile.status === 'unknown' && analysis.verdict === '可关注') {
    analysis.verdict = '等待确认';
  }
  analysis = applyEntryContextAssessment(analysis, {
    newsContext, riskProfile, marketOverview: marketOverviewCache?.value || null, marketNewsContext
  });
  analysis = applyOutcomeFeedbackAssessment(analysis, outcomeProfile);
  if (!analysis.entryAssessment?.allowed && analysis.verdict === '可关注'
    && ['消息风险待确认', '大盘消息风险待确认', '大盘偏弱，等待确认'].includes(analysis.entryAssessment.status)) {
    analysis.verdict = '等待确认';
  }
  analysis.newsImpact = `个股消息：${newsContext.summary} 大盘消息：${marketNewsContext.summary}`;
  const financialAnalysis = financialResult.status === 'fulfilled' ? financialResult.value.analysis : null;
  if (financialResult.status === 'fulfilled') errors.push(...(financialResult.value.errors || []));
  else errors.push(`财务指标失败：${financialResult.reason?.message || financialResult.reason}`);
  const liveQuote = quoteResult.status === 'fulfilled' ? quoteResult.value[0] : null;
  const investmentAnalysis = buildIndividualInvestmentAnalysis({
    technical: analysis, financial: financialAnalysis, newsContext, quote: liveQuote,
    marketOverview: marketOverviewCache?.value || null,
    marketNewsContext
  });
  const breakoutConclusion = analysis.breakoutPotential?.available
    ? `横盘突破评估：${analysis.breakoutPotential.status}，${analysis.breakoutPotential.trigger}。` : '';
  analysis.combinedConclusion = `${analysis.verdict}（技术评分${analysis.score}/100，CANSLIM可验证得分${investmentAnalysis.canslim.score ?? '--'}/100）。${analysis.entryAssessment?.summary || analysis.buyCondition}${analysis.capitalSetupAssessment.summary}${breakoutConclusion}个股消息经发布时间与相关性加权后${newsContext.signal}，大盘实时消息${marketNewsContext.signal}；${newsContext.signal === '偏谨慎' || marketNewsContext.signal === '偏谨慎' ? '近期风险信息未充分消化，需降低优先级。' : '暂未发现与技术条件明显冲突的近期风险信息。'}未来半年公司风险：${riskProfile.summary}。`;
  const analyzedAt = new Date().toISOString();
  const latestTradeDate = history.at(-1)?.date || '';
  return writeTimedCache(stockHistoryCache, cacheKey, { history, analysis: { ...analysis, source, latestTradeDate, analyzedAt }, fundFlowPeriod, financialAnalysis, investmentAnalysis, riskProfile, newsContext, marketNewsContext, feedbackSignature, errors, source, latestTradeDate, analyzedAt });
}

async function fetchStockChart({ code, period, force = false }) {
  const safePeriod = ['minute', 'five-day', 'day', 'week', 'month'].includes(period) ? period : 'day';
  const cacheKey = `${code}-${safePeriod}`;
  const cached = force ? null : readTimedCache(stockChartCache, cacheKey, safePeriod === 'minute' ? 60 * 1000 : 10 * 60 * 1000);
  if (cached) return { ...cached, cached: true };
  const previous = stockChartCache.get(cacheKey)?.value;
  try {
  const symbol = `${marketPrefixOf(code)}${code}`;
  let rows = [];
  let source = '';
  let previousClose = null;
  if (safePeriod === 'minute' || safePeriod === 'five-day') {
    const frequency = safePeriod === 'minute' ? 'm1' : 'm5';
    const json = await getJsonWithRetry(`https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${symbol},${frequency},,320&_=${Date.now()}`, 1);
    rows = (json?.data?.[symbol]?.[frequency] || []).map(row => ({
      time: String(row[0] || ''), open: finiteNumber(row[1]), close: finiteNumber(row[2]),
      high: finiteNumber(row[3]), low: finiteNumber(row[4]), volume: finiteNumber(row[5])
    })).filter(row => row.time && row.close > 0);
    if (safePeriod === 'minute' && rows.length) {
      const latestDate = rows.at(-1).time.slice(0, 8);
      rows = rows.filter(row => row.time.startsWith(latestDate));
      try {
        previousClose = (await fetchTencentQuotes([code]))[0]?.prevClose || null;
      } catch {}
    }
    if (safePeriod === 'five-day' && rows.length) {
      const dates = [...new Set(rows.map(row => row.time.slice(0, 8)))].slice(-5);
      rows = rows.filter(row => dates.includes(row.time.slice(0, 8)));
    }
    source = `腾讯${safePeriod === 'minute' ? '分时' : '五日5分钟'}行情`;
  } else {
    const frequency = safePeriod;
    const count = safePeriod === 'day' ? 160 : 120;
    try {
      const json = await getJsonWithRetry(`https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},${frequency},,,${count},qfq&_=${Date.now()}`, 1);
      const data = json?.data?.[symbol] || {};
      rows = normalizeHistoryRows(data[`qfq${frequency}`] || data[frequency] || []).map(row => ({ ...row, time: row.date }));
      source = `腾讯前复权${safePeriod === 'day' ? '日K' : safePeriod === 'week' ? '周K' : '月K'}`;
      if (rows.length < 10) throw new Error(`${source}返回数据不足`);
    } catch (tencentError) {
      const dailyRows = await fetchSinaHistory(code, safePeriod === 'day' ? 160 : 800);
      rows = (safePeriod === 'day' ? dailyRows : aggregateHistoryPeriod(dailyRows, safePeriod))
        .map(row => ({ ...row, time: row.date }));
      source = `新浪${safePeriod === 'day' ? '日K' : safePeriod === 'week' ? '日线聚合周K' : '日线聚合月K'}（腾讯接口异常后备用）`;
    }
  }
  const minimumRows = safePeriod === 'minute' ? 1 : 10;
  if (rows.length < minimumRows) throw new Error(`${source || safePeriod}返回数据不足`);
  return writeTimedCache(stockChartCache, cacheKey, { period: safePeriod, rows, previousClose, source, fetchedAt: new Date().toISOString() });
  } catch (err) {
    if (previous?.rows?.length) {
      return { ...previous, stale: true, errors: [`走势接口暂时不可用，已显示最近一次成功数据：${err.message || err}`] };
    }
    throw err;
  }
}

function parseRssItems(xml) {
  return sortNewsNewestFirst([...String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/g)].map(match => {
    const block = match[1];
    const pick = (tag) => decodeXmlText((block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)) || [])[1]);
    return {
      title: pick('title'),
      link: pick('link'),
      summary: pick('description').replace(/<[^>]+>/g, '').slice(0, 160),
      publishedAt: pick('pubDate'),
      source: 'Bing新闻'
    };
  }).filter(item => item.title && item.link)).slice(0, 6);
}

function sortNewsNewestFirst(news) {
  const timestamp = value => {
    const text = String(value || '').trim().replace(/^(\d{4}-\d{2}-\d{2})\s+/, '$1T');
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...news].sort((a, b) => timestamp(b.publishedAt) - timestamp(a.publishedAt));
}

async function fetchRecentStockAnnouncements(code) {
  if (!/^\d{6}$/.test(String(code || ''))) return [];
  const today = currentChinaDate();
  const params = new URLSearchParams({
    sr: '-1', page_size: '20', page_index: '1', ann_type: 'A', client_source: 'web',
    stock_list: code, f_node: '0', s_node: '0', begin_time: shiftDate(today, { days: -30 }), end_time: today
  });
  const json = await getJsonWithRetry(`https://np-anotice-stock.eastmoney.com/api/security/ann?${params}`, 1);
  return (json?.data?.list || []).map(row => ({
    title: cleanStockName(row.title),
    link: row.art_code ? `https://data.eastmoney.com/notices/detail/${code}/${row.art_code}.html` : '',
    summary: '上市公司公告，具体影响需结合公告正文核验。',
    publishedAt: row.notice_date || '',
    source: '东方财富公司公告'
  })).filter(item => item.title && item.link);
}

async function fetchStockNews({ code, name, force = false }) {
  const cacheKey = String(code || name || '');
  const cached = force ? null : readTimedCache(stockNewsCache, cacheKey, 2 * 60 * 1000);
  if (cached) return { ...cached, cached: true };
  const previous = stockNewsCache.get(cacheKey)?.value;
  const keyword = `${cleanStockName(name) || code} 股票 最新消息`;
  const errors = [];
  const [articleResult, announcementResult] = await Promise.allSettled([(async () => {
    const param = {
      uid: '',
      keyword,
      type: ['cmsArticleWebOld'],
      client: 'web',
      clientType: 'web',
      clientVersion: 'curr',
      param: { cmsArticleWebOld: { searchScope: 'default', sort: 'default', pageIndex: 1, pageSize: 12, preTag: '', postTag: '' } }
    };
    const text = await getText(`https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=${encodeURIComponent(JSON.stringify(param))}`, { Referer: 'https://so.eastmoney.com/' });
    const json = parseJsonpPayload(text);
    const rows = json?.result?.cmsArticleWebOld || json?.Data?.cmsArticleWebOld || [];
    return rows.map(row => ({
      title: cleanStockName(row.title || row.Title),
      link: row.url || row.Url,
      summary: String(row.content || row.Content || '').replace(/<[^>]+>/g, '').slice(0, 160),
      publishedAt: row.showTime || row.ShowTime || row.date || '',
      source: '东方财富资讯'
    })).filter(item => item.title && item.link);
  })(), fetchRecentStockAnnouncements(code)]);
  if (articleResult.status === 'rejected') errors.push(`东方财富资讯失败：${articleResult.reason?.message || articleResult.reason}`);
  if (announcementResult.status === 'rejected') errors.push(`公司公告失败：${announcementResult.reason?.message || announcementResult.reason}`);
  const eastmoneyNews = sortNewsNewestFirst([
    ...(articleResult.status === 'fulfilled' ? articleResult.value : []),
    ...(announcementResult.status === 'fulfilled' ? announcementResult.value : [])
  ]).filter((item, index, rows) => rows.findIndex(candidate => candidate.title === item.title) === index).slice(0, 8);
  if (eastmoneyNews.length) {
    const source = [...new Set(eastmoneyNews.map(item => item.source).filter(Boolean))].join(' + ');
    return writeTimedCache(stockNewsCache, cacheKey, { news: eastmoneyNews, errors, source, fetchedAt: new Date().toISOString(), stale: false });
  }
  errors.push('东方财富资讯与公司公告均为空');

  try {
    const rss = await getText(`https://www.bing.com/news/search?q=${encodeURIComponent(keyword)}&format=rss&setlang=zh-CN`, { 'User-Agent': 'Mozilla/5.0' });
    const news = parseRssItems(rss);
    if (news.length) return writeTimedCache(stockNewsCache, cacheKey, { news, errors, source: 'Bing新闻', fetchedAt: new Date().toISOString(), stale: false });
    errors.push('Bing新闻搜索为空');
  } catch (err) {
    errors.push(`Bing新闻失败：${err.message || err}`);
  }
  if (previous?.news?.length) return { ...previous, cached: true, stale: true, errors };
  return { news: [], errors, source: '', fetchedAt: new Date().toISOString(), stale: false };
}

async function runIndustryWorkflow(command) {
  const input = String(command || '').trim();
  if (!input) throw new Error('命令为空');
  const { terms, explicitCodes, industryKeys, subject, entities } = buildIndustryTerms(input);
  const allowFund = allowsFundResults(input);
  const errors = [];
  const candidates = new Map();
  const addCandidate = item => {
    if (!item?.code) return;
    const current = candidates.get(item.code);
    if (!current || (item.relevanceScore || item.score || 0) > (current.relevanceScore || current.score || 0)) {
      candidates.set(item.code, { ...current, ...item });
    }
  };

  explicitCodes.forEach(code => addCandidate({ code, name: code, sector: '命令指定代码', securityType: 'A股', source: '命令指定代码', relevanceScore: 200 }));
  entityFallbackForCommand(input).filter(item => item.relevanceScore >= 40).forEach(addCandidate);
  specificIndustryFallbackForCommand(input).forEach(addCandidate);

  const matchedBoards = await findBoardsForSubject(subject, terms, errors);
  for (const board of matchedBoards) {
    try {
      const boardStocks = await fetchBoardStocks(board);
      boardStocks.forEach(item => addCandidate({ ...item, relevanceScore: 80 + board.score }));
      appendLogLine({ type: 'info', message: '线上板块成分股完成', action: 'workflow_board_stocks', detail: { command: input, subject, board: board.name, boardCode: board.code, count: boardStocks.length } });
    } catch (err) {
      errors.push(`板块 ${board.name} 成分股获取失败：${err.message || err}`);
      appendLogLine({ type: 'error', message: '线上板块成分股失败', action: 'workflow_board_stocks_failed', detail: { command: input, subject, board: board.name, boardCode: board.code }, stack: err.stack || String(err) });
    }
  }

  const directoryMatches = await findDirectoryStocksForSubject(subject, terms, errors);
  directoryMatches.forEach(item => addCandidate({ ...item, relevanceScore: item.score }));
  appendLogLine({ type: 'info', message: 'A股目录行业匹配完成', action: 'workflow_directory_match', detail: { command: input, subject, count: directoryMatches.length } });

  const searchTerms = candidates.size >= 12 ? [subject] : terms;
  for (const term of searchTerms) {
    try {
      const response = await searchStocksInternal(term);
      errors.push(...response.errors.map(msg => `关键词 ${term}：${msg}`));
      response.results.forEach(item => {
        if (!isTradableCandidate(item, allowFund)) return;
        if (scoreSubjectText(subject, `${item.name} ${item.sector || ''}`, terms) < 16 && !fallbackForCommand(input).some(stock => stock.code === item.code)) return;
        addCandidate({ ...item, source: response.source, relevanceScore: scoreSubjectText(subject, `${item.name} ${item.sector || ''}`, terms) });
      });
      appendLogLine({ type: 'info', message: '行业查找关键词完成', action: 'workflow_keyword_done', detail: { command: input, keyword: term, source: response.source, count: response.results.length } });
    } catch (err) {
      errors.push(`关键词 ${term} 查找失败：${err.message || err}`);
      appendLogLine({ type: 'error', message: '行业查找关键词失败', action: 'workflow_keyword_failed', detail: { command: input, keyword: term }, stack: err.stack || String(err) });
    }
    await sleep(120);
  }

  const hasStrongBoardMatch = matchedBoards.some(board => board.score >= 50);
  if (candidates.size < 25 || !hasStrongBoardMatch) {
    const discovered = await discoverStocksFromIndustryNews(subject, terms, errors);
    discovered.forEach(addCandidate);
    appendLogLine({ type: discovered.length ? 'info' : 'warn', message: '公开产业资料股票交叉识别完成', action: 'workflow_news_discovery', detail: { command: input, subject, count: discovered.length } });
  }

  if (candidates.size < 12) {
    [...fallbackForCommand(input), ...entityFallbackForCommand(input).filter(item => item.relevanceScore >= 40), ...specificIndustryFallbackForCommand(input)].forEach(item => {
      addCandidate({ ...item, securityType: 'A股', source: '内置行业词库补充', relevanceScore: 25 });
    });
  }

  const eligible = uniqueStocks([...candidates.values()])
    .filter(item => isTradableCandidate(item, allowFund))
    .filter(item => allowFund || !/ST|退/.test(item.name))
    .filter(item => resultMatchesCommand(item, input, industryKeys));
  const stocks = balanceIndustryCandidates(eligible, 80)
    .map(item => industryStockFromCandidate(item, input));
  appendLogLine({ type: stocks.length ? 'success' : 'error', message: '行业查找流程完成', action: 'workflow_complete', detail: { command: input, subject, boards: matchedBoards.map(b => b.name), keywords: terms, candidates: candidates.size, eligible: eligible.length, count: stocks.length, sectors: [...new Set(stocks.map(stock => stock.sector))].length, errors } });
  return { stocks, errors, terms, subject, entities, boards: matchedBoards, source: '通用行业查找脚本' };
}

ipcMain.handle('fetch-a-share-quotes', async (_event, codes) => {
  const uniqueCodes = [...new Set((codes || []).map(String).filter(code => /^\d{6}$/.test(code)))];
  if (!uniqueCodes.length) return { quotes: [], errors: [], warnings: [], requested: 0, updated: 0, cached: 0, failed: 0 };
  const quotes = [];
  const errors = [];
  const warnings = [];
  let liveCount = 0;
  let cachedCount = 0;
  const batches = [];
  for (let index = 0; index < uniqueCodes.length; index += 20) batches.push(uniqueCodes.slice(index, index + 20));
  const sourceResults = await settleWithConcurrency(batches, 3, async batch => {
    const eastmoneyTask = Promise.race([
      fetchQuoteRows(batch)
        .then(rows => ({ rows: rows.map(normalizeQuoteRow), error: '' }))
        .catch(err => ({ rows: [], error: err.message || String(err) })),
      sleep(1200).then(() => ({ rows: [], error: '请求超过 1.2 秒，已跳过资金数据补充' }))
    ]);
    const [tencentResult, eastmoneyResult] = await Promise.allSettled([fetchTencentQuotes(batch), eastmoneyTask]);
    return { batch, tencentResult, eastmoneyResult };
  });
  const liveQuotes = new Map();
  sourceResults.forEach((result, index) => {
    const batch = batches[index];
    if (result.status === 'rejected') {
      warnings.push(`批量行情失败 ${batch.join(',')}：${result.reason?.message || result.reason}`);
      return;
    }
    const { tencentResult, eastmoneyResult } = result.value;
    const tencentRows = tencentResult.status === 'fulfilled' ? tencentResult.value : [];
    const eastmoneyValue = eastmoneyResult.status === 'fulfilled' ? eastmoneyResult.value : { rows: [], error: eastmoneyResult.reason?.message || String(eastmoneyResult.reason) };
    if (tencentResult.status === 'rejected') warnings.push(`腾讯批量行情失败 ${batch.join(',')}：${tencentResult.reason?.message || tencentResult.reason}`);
    if (eastmoneyValue.error) warnings.push(`东方财富补充行情失败 ${batch.join(',')}：${eastmoneyValue.error}`);
    const tencentMap = new Map(tencentRows.map(row => [row.code, row]));
    const eastmoneyMap = new Map(eastmoneyValue.rows.map(row => [row.code, row]));
    batch.forEach(code => {
      const tencentQuote = tencentMap.get(code);
      const eastmoneyQuote = eastmoneyMap.get(code);
      if (tencentQuote) {
        liveQuotes.set(code, {
          ...tencentQuote,
          mainNetInflow: eastmoneyQuote?.mainNetInflow ?? null,
          mainNetPct: eastmoneyQuote?.mainNetPct ?? null,
          amplitude: tencentQuote.amplitude ?? eastmoneyQuote?.amplitude ?? null,
          turnoverRate: tencentQuote.turnoverRate ?? eastmoneyQuote?.turnoverRate ?? null,
          peRatio: tencentQuote.peRatio ?? eastmoneyQuote?.peRatio ?? null,
          snapshotVolumeRatio: tencentQuote.snapshotVolumeRatio ?? eastmoneyQuote?.snapshotVolumeRatio ?? null,
          pbRatio: tencentQuote.pbRatio ?? eastmoneyQuote?.pbRatio ?? null,
          upperLimit: tencentQuote.upperLimit ?? eastmoneyQuote?.upperLimit ?? null,
          lowerLimit: tencentQuote.lowerLimit ?? eastmoneyQuote?.lowerLimit ?? null,
          totalMarketCap: tencentQuote.totalMarketCap ?? eastmoneyQuote?.totalMarketCap ?? null,
          floatMarketCap: tencentQuote.floatMarketCap ?? eastmoneyQuote?.floatMarketCap ?? null,
          source: eastmoneyQuote ? '腾讯实时行情 + 东方财富资金' : '腾讯实时行情'
        });
      } else if (eastmoneyQuote?.price != null) {
        liveQuotes.set(code, { ...eastmoneyQuote, stale: false });
      }
    });
  });

  const missingCodes = uniqueCodes.filter(code => !liveQuotes.has(code));
  const fallbackResults = await settleWithConcurrency(missingCodes, 3, fetchSinaQuote);
  fallbackResults.forEach((result, index) => {
    const code = missingCodes[index];
    if (result.status === 'fulfilled' && result.value) {
      liveQuotes.set(code, result.value);
      warnings.push(`${code} 已改用新浪实时行情`);
    } else if (result.status === 'rejected') {
      warnings.push(`${code} 新浪行情失败：${result.reason?.message || result.reason}`);
    }
  });

  uniqueCodes.forEach(code => {
    const quote = liveQuotes.get(code);
    if (quote?.price != null) {
      quoteCache.set(code, quote);
      quotes.push(quote);
      liveCount++;
      return;
    }
    const cached = quoteCache.get(code);
    if (cached) {
      quotes.push({ ...cached, stale: true, source: `${cached.source || '行情'}（缓存）` });
      cachedCount++;
    } else {
      errors.push(`${code} 所有实时行情源均未返回数据`);
    }
  });

  const result = {
    quotes,
    errors,
    warnings,
    requested: uniqueCodes.length,
    updated: liveCount,
    cached: cachedCount,
    failed: uniqueCodes.length - liveCount - cachedCount
  };
  appendLogLine({
    type: errors.length ? 'warn' : 'success',
    message: '行情刷新完成',
    action: 'quotes_refresh_complete',
    detail: { requested: result.requested, updated: result.updated, cached: result.cached, failed: result.failed, warnings, errors }
  });
  return result;
});

ipcMain.handle('search-a-share-stocks', async (_event, keyword) => {
  const response = await searchStocksInternal(keyword);
  appendLogLine({ type: response.results.length ? 'success' : 'warn', message: '单股搜索完成', detail: { keyword, source: response.source, count: response.results.length, errors: response.errors } });
  return response;
});

ipcMain.handle('run-industry-workflow', async (_event, command) => runIndustryWorkflow(command));

ipcMain.handle('fetch-stock-news', async (_event, stock) => {
  const result = await fetchStockNews(stock || {});
  appendLogLine({ type: result.news.length ? 'success' : 'warn', message: '股票资讯查询完成', detail: { code: stock?.code, name: stock?.name, source: result.source, count: result.news.length, errors: result.errors } });
  return result;
});

ipcMain.handle('fetch-live-news', async (_event, request) => {
  const result = await fetchLiveNews(request || {});
  appendLogLine({ type: result.news.length ? 'success' : 'warn', message: '24小时实时新闻查询完成', detail: { source: result.source, count: result.news.length, errors: result.errors } });
  return result;
});

ipcMain.handle('fetch-stock-history', async (_event, stock) => {
  try {
    const result = await fetchStockHistory(stock || {});
    appendLogLine({ type: 'success', message: '近3个月历史行情分析完成', action: 'stock_history_analysis', detail: { code: stock?.code, name: stock?.name, source: result.source, count: result.history.length, analysis: result.analysis, errors: result.errors } });
    return result;
  } catch (err) {
    appendLogLine({ type: 'error', message: '近3个月历史行情分析失败', action: 'stock_history_analysis_failed', detail: { code: stock?.code, name: stock?.name }, stack: err.stack || String(err) });
    throw err;
  }
});

ipcMain.handle('fetch-stock-chart', async (_event, request) => {
  try {
    const result = await fetchStockChart(request || {});
    appendLogLine({ type: 'success', message: '个股走势数据获取完成', action: 'stock_chart_fetch', detail: { code: request?.code, period: result.period, count: result.rows.length, source: result.source } });
    return result;
  } catch (err) {
    appendLogLine({ type: 'error', message: '个股走势数据获取失败', action: 'stock_chart_fetch_failed', detail: { code: request?.code, period: request?.period }, stack: err.stack || String(err) });
    throw err;
  }
});

ipcMain.handle('fetch-stock-fund-flow', async (_event, request) => {
  try {
    const result = await fetchStockFundFlow(request || {});
    appendLogLine({ type: result.errors.length ? 'warn' : 'success', message: '个股资金汇总完成', action: 'stock_fund_flow', detail: { code: request?.code, source: result.source, tradeDate: result.tradeDate, mainInflow: result.mainInflow, mainOutflow: result.mainOutflow, mainNetInflow: result.mainNetInflow, mainNetPct: result.mainNetPct, estimated: result.estimated, errors: result.errors } });
    return result;
  } catch (err) {
    appendLogLine({ type: 'error', message: '个股资金汇总失败', action: 'stock_fund_flow_failed', detail: { code: request?.code }, stack: err.stack || String(err) });
    throw err;
  }
});

ipcMain.handle('fetch-market-overview', async (_event, input) => {
  const request = input && typeof input === 'object' ? input : { force: Boolean(input) };
  try {
    const result = await fetchMarketOverview(Boolean(request.force), request.favoriteOutcomes);
    appendLogLine({ type: result.errors.length ? 'warn' : 'success', message: '大盘实时分析完成', action: 'market_overview', detail: { indices: result.indices.length, sectors: result.sectors.length, recommendations: result.recommendations?.length || 0, recommendationOutcomeSamples: result.recommendationCoverage?.outcomeFeedback?.sampleSize || 0, news: result.newsContext?.items?.length || 0, turnover: result.turnover, limits: result.limits, source: result.source, warnings: result.warnings || [], errors: result.errors } });
    return result;
  } catch (err) {
    appendLogLine({ type: 'error', message: '大盘实时分析失败', action: 'market_overview_failed', stack: err.stack || String(err) });
    throw err;
  }
});

ipcMain.handle('fetch-company-profile', async (_event, stock) => {
  const result = await fetchCompanyProfile(stock || {});
  appendLogLine({ type: result.profile?.business || result.profile?.summary ? 'success' : 'warn', message: 'company_profile_fetch', detail: { code: stock?.code, name: stock?.name, errors: result.errors } });
  return result;
});

ipcMain.handle('open-external-url', async (_event, url) => {
  const target = String(url || '');
  if (!/^https?:\/\//i.test(target)) return false;
  await shell.openExternal(target);
  return true;
});

ipcMain.handle('append-operation-log', async (_event, entry) => appendLogLine(entry || {}));

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: '#f4f6fb',
    title: '股票观察助手',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.removeMenu();
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile('index.html');
}

app.whenReady().then(() => {
  appendLogLine({ type: 'info', message: '应用启动' });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

module.exports = {
  normalizeQuoteRow,
  normalizeTencentQuote,
  mapSinaFinancialData,
  buildFinancialAnalysis,
  splitDataCenterFinancialRows,
  buildCanslimFromFactors,
  buildIndividualInvestmentAnalysis,
  buildRecommendationFactorContext,
  evaluateRecommendationFactors,
  resolveRecommendationIndustry,
  recommendationIndustryGroupKey,
  groupRecommendationsByIndustry,
  recommendationSignalFamily,
  mergeRecommendationOutcomeQuotes,
  summarizeRecommendationOutcomes,
  calibrateRecommendationWithOutcomes,
  applyOutcomeFeedbackAssessment,
  recommendationPassesOutcomeGate,
  restoreCachedMarketRecommendations,
  evaluateRecommendationRisk,
  summarizeNews,
  assessRecommendationTimingRisk,
  buildFutureRiskProfile,
  summarizeFundFlowRows,
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
  fetchLiveNews,
  settleWithConcurrency
};
