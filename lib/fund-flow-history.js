const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {atomicWriteJson, readJsonWithBackup} = require('./persistence');

const FINAL_PHASES = new Set(['historical-final']);
const VALID_PHASES = new Set(['intraday', 'close-observed', 'historical-final', 'final-unverified']);
const VALID_ORIGINS = new Set(['historical-api', 'historical-page', 'closing-snapshot', 'local-recovery', 'user-export']);

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function amountMultiplier(unit) {
  if (unit === 'CNY') return 1;
  if (unit === 'CNY_10K') return 10000;
  throw new Error(`未知amountUnit：${unit || '未提供'}`);
}

function ratioMultiplier(unit) {
  if (unit === 'percent') return 1;
  if (unit === 'fraction') return 100;
  throw new Error(`未知ratioUnit：${unit || '未提供'}`);
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeFundFlowRecord(input, contract = {}) {
  const code = String(input?.code || '');
  const tradeDate = String(input?.tradeDate || '');
  if (!/^\d{6}$/.test(code)) throw new Error(`股票代码无效：${code}`);
  if (!validDate(tradeDate)) throw new Error(`交易日期无效：${tradeDate}`);
  if (!input?.provider || !input?.definitionId) throw new Error('资金记录缺少provider或definitionId');
  if (!VALID_PHASES.has(input.phase)) throw new Error(`资金阶段无效：${input.phase || '未提供'}`);
  if (!VALID_ORIGINS.has(input.origin)) throw new Error(`资金来源类型无效：${input.origin || '未提供'}`);
  const amountFactor = amountMultiplier(contract.amountUnit);
  const hasRatio = finite(input.mainNetPct) !== null;
  const ratioFactor = hasRatio ? ratioMultiplier(contract.ratioUnit) : 1;
  const convertAmount = value => {
    const number = finite(value);
    return number === null ? null : number * amountFactor;
  };
  const fetchedAt = input.fetchedAt || new Date().toISOString();
  const record = {
    code,
    tradeDate,
    provider:String(input.provider),
    definitionId:String(input.definitionId),
    schemaVersion:1,
    mainNetAmount:convertAmount(input.mainNetAmount),
    largeNetAmount:convertAmount(input.largeNetAmount),
    extraLargeNetAmount:convertAmount(input.extraLargeNetAmount),
    mainNetPct:hasRatio ? finite(input.mainNetPct) * ratioFactor : null,
    turnoverAmount:convertAmount(input.turnoverAmount),
    amountUnit:'CNY',
    ratioUnit:'percent',
    phase:input.phase,
    sourceObservedAt:input.sourceObservedAt || null,
    fetchedAt,
    firstObservedAt:input.firstObservedAt || fetchedAt,
    origin:input.origin,
    evidenceLocator:input.evidenceLocator || null,
    revision:Number.isInteger(input.revision) && input.revision > 0 ? input.revision : 1,
    qualityFlags:[...new Set((input.qualityFlags || []).map(String).filter(Boolean))]
  };
  if (record.mainNetAmount === null) record.qualityFlags.push('missing-main-net-amount');
  record.evidenceHash = input.evidenceHash || stableHash({
    code:record.code, tradeDate:record.tradeDate, provider:record.provider,
    definitionId:record.definitionId, mainNetAmount:record.mainNetAmount,
    largeNetAmount:record.largeNetAmount, extraLargeNetAmount:record.extraLargeNetAmount,
    mainNetPct:record.mainNetPct, turnoverAmount:record.turnoverAmount,
    phase:record.phase, origin:record.origin, evidenceLocator:record.evidenceLocator
  });
  return record;
}

function recordValueKey(record) {
  return JSON.stringify([
    record.mainNetAmount, record.largeNetAmount, record.extraLargeNetAmount,
    record.mainNetPct, record.turnoverAmount
  ]);
}

function assessSeries(records, expectedSet, startDate, endDate) {
  const byDate = new Map();
  const provisionalRows = [];
  for (const record of records) {
    if (!validDate(record.tradeDate) || startDate && record.tradeDate < startDate
      || endDate && record.tradeDate > endDate || expectedSet.size && !expectedSet.has(record.tradeDate)) continue;
    if (!FINAL_PHASES.has(record.phase)) {
      provisionalRows.push(record);
      continue;
    }
    if (record.mainNetAmount === null || record.mainNetAmount === undefined) continue;
    if (!byDate.has(record.tradeDate)) byDate.set(record.tradeDate, []);
    byDate.get(record.tradeDate).push(record);
  }
  const finalDailyRows = [];
  const conflicts = [];
  for (const [tradeDate, rows] of byDate) {
    const byValue = new Map();
    for (const row of rows) if (!byValue.has(recordValueKey(row))) byValue.set(recordValueKey(row), row);
    if (byValue.size > 1) conflicts.push({tradeDate, records:[...byValue.values()]});
    else finalDailyRows.push([...byValue.values()][0]);
  }
  finalDailyRows.sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
  provisionalRows.sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
  const covered = new Set(finalDailyRows.map(row => row.tradeDate));
  return {finalDailyRows, provisionalRows, conflicts, covered};
}

function assessFundFlowCoverage({
  code, records = [], expectedDates = [], suspendedDates = [], endDate = '', startDate = '', provider = '', definitionId = ''
} = {}) {
  const expected = [...new Set(expectedDates.filter(validDate).filter(date => (!startDate || date >= startDate) && (!endDate || date <= endDate)))].sort();
  const suspended = [...new Set(suspendedDates.filter(date => expected.includes(date)))].sort();
  const suspendedSet = new Set(suspended);
  const requiredDates = expected.filter(date => !suspendedSet.has(date));
  const expectedSet = new Set(requiredDates);
  const eligible = records.filter(row => (!code || row.code === code)
    && (!provider || row.provider === provider) && (!definitionId || row.definitionId === definitionId));
  const groups = new Map();
  for (const row of eligible) {
    const key = `${row.provider}\u0000${row.definitionId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const candidates = [...groups.entries()].map(([key, rows]) => {
    const result = assessSeries(rows, expectedSet, startDate, endDate);
    return {key, provider:rows[0]?.provider || '', definitionId:rows[0]?.definitionId || '', ...result};
  }).sort((left, right) => right.covered.size - left.covered.size
    || left.conflicts.length - right.conflicts.length
    || right.finalDailyRows.length - left.finalDailyRows.length
    || left.key.localeCompare(right.key));
  const selected = candidates[0] || {provider:'', definitionId:'', finalDailyRows:[], provisionalRows:[], conflicts:[], covered:new Set()};
  const coveredDates = requiredDates.filter(date => selected.covered.has(date));
  const missingDates = requiredDates.filter(date => !selected.covered.has(date));
  const unionCovered = new Set(candidates.flatMap(item => [...item.covered]));
  const dateCoverageComplete = requiredDates.length > 0 && requiredDates.every(date => unionCovered.has(date));
  const comparableSeriesComplete = requiredDates.length > 0 && missingDates.length === 0 && selected.conflicts.length === 0;
  let status = comparableSeriesComplete ? 'complete' : selected.conflicts.length ? 'conflict'
    : selected.finalDailyRows.length || selected.provisionalRows.length ? 'partial' : 'unavailable';
  if (!requiredDates.length) status = 'unavailable';
  const latestFinalDate = selected.finalDailyRows.at(-1)?.tradeDate || '';
  const latestRequiredDate = requiredDates.at(-1) || '';
  return {
    code:String(code || ''),
    provider:selected.provider,
    definitionId:selected.definitionId,
    expectedDates:expected,
    coveredDates,
    missingDates,
    suspendedDates:suspended,
    finalDailyRows:selected.conflicts.length ? selected.finalDailyRows.filter(row => !selected.conflicts.some(item => item.tradeDate === row.tradeDate)) : selected.finalDailyRows,
    provisionalRows:selected.provisionalRows,
    aggregateWindows:[],
    intraday:selected.provisionalRows.filter(row => row.phase === 'intraday').at(-1) || null,
    conflicts:selected.conflicts,
    status,
    asOfDate:endDate || expected.at(-1) || latestFinalDate,
    freshEnough:Boolean(latestRequiredDate && latestFinalDate === latestRequiredDate
      && missingDates.length === 0 && selected.conflicts.length === 0),
    dateCoverageComplete,
    comparableSeriesComplete,
    errors:[],
    nextRetryAt:null,
    alternatives:candidates.slice(1).map(item => ({
      provider:item.provider, definitionId:item.definitionId, coveredDates:[...item.covered].sort(), conflicts:item.conflicts.length
    }))
  };
}

function safeSegment(value, label) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9._-]+$/.test(text)) throw new Error(`${label}无效：${text}`);
  return text;
}

class FundFlowHistoryStore {
  constructor(root) {
    this.root = root;
    this.pendingWrites = new Map();
  }

  file(provider, code, year) {
    return path.join(this.root, safeSegment(provider, 'provider'), safeSegment(code, 'code'), `${safeSegment(year, 'year')}.json`);
  }

  async merge(records = []) {
    const groups = new Map();
    for (const input of records) {
      const normalized = normalizeFundFlowRecord(input, {amountUnit:'CNY', ratioUnit:'percent'});
      const year = normalized.tradeDate.slice(0, 4);
      const file = this.file(normalized.provider, normalized.code, year);
      if (!groups.has(file)) groups.set(file, []);
      groups.get(file).push(normalized);
    }
    return Promise.all([...groups].map(([file, incoming]) => this.mergeFile(file, incoming)));
  }

  async mergeFile(file, incoming) {
    const previous = this.pendingWrites.get(file) || Promise.resolve();
    const write = previous.catch(() => {}).then(async () => {
      const current = (await readJsonWithBackup(file, null)).value;
      const byEvidence = new Map((current?.records || []).map(row => [row.evidenceHash, row]));
      for (const row of incoming) byEvidence.set(row.evidenceHash, row);
      const rows = [...byEvidence.values()].sort((left, right) => left.tradeDate.localeCompare(right.tradeDate)
        || left.provider.localeCompare(right.provider) || left.definitionId.localeCompare(right.definitionId)
        || left.revision - right.revision);
      const value = {
        schemaVersion:1,
        provider:incoming[0].provider,
        code:incoming[0].code,
        year:incoming[0].tradeDate.slice(0, 4),
        records:rows,
        updatedAt:new Date().toISOString()
      };
      await atomicWriteJson(file, value);
      return value;
    });
    this.pendingWrites.set(file, write);
    try {
      return await write;
    } finally {
      if (this.pendingWrites.get(file) === write) this.pendingWrites.delete(file);
    }
  }

  async providers() {
    try {
      return (await fs.promises.readdir(this.root, {withFileTypes:true}))
        .filter(entry => entry.isDirectory()).map(entry => entry.name);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async query(input = {}) {
    const providers = input.provider ? [input.provider] : await this.providers();
    const startYear = Number(String(input.startDate || input.expectedDates?.[0] || input.endDate || '').slice(0, 4));
    const endYear = Number(String(input.endDate || input.expectedDates?.at(-1) || input.startDate || '').slice(0, 4));
    const years = [];
    if (Number.isInteger(startYear) && Number.isInteger(endYear)) {
      for (let year = startYear; year <= endYear; year++) years.push(String(year));
    }
    const records = [];
    for (const provider of providers) for (const year of years) {
      const value = (await readJsonWithBackup(this.file(provider, input.code, year), null)).value;
      if (value?.records) records.push(...value.records);
    }
    return assessFundFlowCoverage({...input, records});
  }

  async writeManifest(value) {
    return atomicWriteJson(path.join(this.root, 'recovery-manifest.json'), value);
  }

  async readManifest() {
    return (await readJsonWithBackup(path.join(this.root, 'recovery-manifest.json'), null)).value;
  }

  async writeProviderHealth(value) {
    return atomicWriteJson(path.join(this.root, 'provider-health.json'), {
      schemaVersion:1,
      providers:value,
      updatedAt:new Date().toISOString()
    });
  }

  async readProviderHealth() {
    return (await readJsonWithBackup(path.join(this.root, 'provider-health.json'), null)).value;
  }
}

class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit);
    this.active = 0;
    this.waiters = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise(resolve => this.waiters.push(resolve));
    this.active++;
  }

  release() {
    this.active--;
    this.waiters.shift()?.();
  }
}

class FundFlowRequestCoordinator {
  constructor({providerLimit = 2, totalLimit = 4, failureThreshold = 3, cooldownMs = 60000,
    extendedCooldownMs = 300000, negativeTtlMs = 600000, now = () => Date.now()} = {}) {
    this.providerLimit = providerLimit;
    this.total = new Semaphore(totalLimit);
    this.providers = new Map();
    this.health = new Map();
    this.inflight = new Map();
    this.negative = new Map();
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.extendedCooldownMs = extendedCooldownMs;
    this.negativeTtlMs = negativeTtlMs;
    this.now = now;
  }

  semaphore(provider) {
    if (!this.providers.has(provider)) this.providers.set(provider, new Semaphore(this.providerLimit));
    return this.providers.get(provider);
  }

  state(provider) {
    if (!this.health.has(provider)) this.health.set(provider, {failures:0, cooldownUntil:0, cooldowns:0});
    return this.health.get(provider);
  }

  async run({provider, key, force = false}, loader) {
    const requestKey = `${provider}\u0000${key}`;
    if (this.inflight.has(requestKey)) return this.inflight.get(requestKey);
    const negativeUntil = this.negative.get(requestKey) || 0;
    if (negativeUntil > this.now()) return {available:false, rows:[], negativeCached:true, nextRetryAt:new Date(negativeUntil).toISOString()};
    const state = this.state(provider);
    if (state.cooldownUntil > this.now()) {
      const error = new Error(`${provider}处于冷却期`);
      error.code = 'PROVIDER_COOLDOWN';
      error.nextRetryAt = new Date(state.cooldownUntil).toISOString();
      throw error;
    }
    const promise = this.execute(provider, requestKey, loader, state, force);
    this.inflight.set(requestKey, promise);
    try {
      return await promise;
    } finally {
      if (this.inflight.get(requestKey) === promise) this.inflight.delete(requestKey);
    }
  }

  async execute(provider, requestKey, loader, state) {
    const providerSemaphore = this.semaphore(provider);
    await this.total.acquire();
    await providerSemaphore.acquire();
    try {
      const result = await loader();
      const empty = !result || result.available === false && !(result.rows || []).length;
      if (empty) this.negative.set(requestKey, this.now() + this.negativeTtlMs);
      else {
        state.failures = 0;
        state.cooldownUntil = 0;
      }
      return result;
    } catch (error) {
      state.failures++;
      if (error?.statusCode === 429) {
        state.cooldowns++;
        state.cooldownUntil = this.now() + Math.max(this.cooldownMs, Number(error.retryAfterMs) || 0);
      } else if (error?.statusCode === 403) {
        state.cooldowns++;
        state.cooldownUntil = this.now() + this.extendedCooldownMs;
      } else if (state.failures >= this.failureThreshold) {
        state.cooldowns++;
        state.cooldownUntil = this.now() + (state.cooldowns > 1 ? this.extendedCooldownMs : this.cooldownMs);
      }
      throw error;
    } finally {
      providerSemaphore.release();
      this.total.release();
    }
  }

  snapshot() {
    return [...this.health].map(([provider, value]) => ({provider, ...value,
      nextRetryAt:value.cooldownUntil ? new Date(value.cooldownUntil).toISOString() : null}));
  }

  restore(rows = []) {
    for (const row of rows) {
      if (!row?.provider) continue;
      const cooldownUntil = Math.max(0, Number(row.cooldownUntil) || Date.parse(row.nextRetryAt || '') || 0);
      this.health.set(String(row.provider), {
        failures:Math.max(0, Number(row.failures) || 0),
        cooldowns:Math.max(0, Number(row.cooldowns) || 0),
        cooldownUntil:cooldownUntil > this.now() ? cooldownUntil : 0
      });
    }
  }
}

function parseKnownJsonp(text, callbackName = '') {
  const source = String(text || '').trim();
  if (source.startsWith('{') || source.startsWith('[')) return JSON.parse(source);
  if (!callbackName || !/^[A-Za-z_$][\w$]*$/.test(callbackName)) throw new Error('响应不是有效JSON');
  const prefix = `${callbackName}(`;
  if (!source.startsWith(prefix)) throw new Error('响应不是允许的JSONP包装');
  const suffix = source.endsWith(');') ? ');' : source.endsWith(')') ? ')' : '';
  if (!suffix) throw new Error('JSONP响应不完整');
  return JSON.parse(source.slice(prefix.length, -suffix.length));
}

function parseYyqyxFundFlowTable(html, code, days = 10) {
  const canonical = String(html).match(/<link rel="canonical" href="https:\/\/www\.yyqyx\.com\/s\/(\d{6})\.(SH|SZ|BJ)"\s*\/?>/i);
  if (canonical?.[1] !== code) throw new Error('公开资金页股票代码不匹配');
  const table = String(html).match(/<h2[^>]*>[^<]*近期主力资金流向<\/h2>[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if (!table || !/<th>主力净额<\/th>/.test(table)) throw new Error('公开资金页缺少逐日主力净额表');
  const rows = [];
  const dates = new Set();
  for (const match of table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(cell => cell[1].replace(/<[^>]*>/g, '').trim());
    if (!cells.length) continue;
    if (!validDate(cells[0]) || dates.has(cells[0])) throw new Error('公开资金页交易日期无效或重复');
    const amount = cells[1]?.replace(/,/g, '').replace(/−/g, '-').match(/^([+-]?\d+(?:\.\d+)?)\s*(万元|亿元)$/);
    if (!amount) throw new Error(`公开资金页金额格式无效：${cells[0]}`);
    dates.add(cells[0]);
    rows.push({date:cells[0], mainNetInflow:Math.round(Number(amount[1]) * (amount[2] === '亿元' ? 1e8 : 1e4)),
      mainNetPct:null, mainInflow:null, mainOutflow:null});
  }
  if (!rows.length || rows.length > 10) throw new Error('公开资金页逐日记录数量无效');
  return rows.sort((a, b) => a.date.localeCompare(b.date)).slice(-days);
}

module.exports = {
  FundFlowHistoryStore,
  FundFlowRequestCoordinator,
  assessFundFlowCoverage,
  normalizeFundFlowRecord,
  parseKnownJsonp,
  parseYyqyxFundFlowTable
};
