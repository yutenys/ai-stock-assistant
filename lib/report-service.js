'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const {Worker, isMainThread, parentPort, workerData} = require('node:worker_threads');
const {atomicWriteJson, readJsonWithBackup} = require('./persistence');
const {renderDailyReportHtml} = require('./daily-report');

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function contentHash(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function reportIdentity(report, input) {
  const {generatedAt, revision, ...stableReport} = report || {};
  return {
    report:stableReport,
    modelVersion:input?.modelVersion || '',
    checkpoints:input?.checkpoints || []
  };
}

async function atomicWriteText(file, value) {
  await fs.promises.mkdir(path.dirname(file), {recursive:true});
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temporary, value, 'utf8');
  await fs.promises.rename(temporary, file);
}

class DailyReportStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.indexFile = path.join(this.root, 'index.json');
    this.pendingSave = Promise.resolve();
    this.preview = null;
  }

  directory(date) {
    if (!validDate(date)) throw new Error(`报告日期无效：${date}`);
    return path.join(this.root, date);
  }

  async list() {
    const stored = (await readJsonWithBackup(this.indexFile, {reports:[]})).value;
    return [...(stored?.reports || [])].sort((a, b) => String(b.tradeDate).localeCompare(String(a.tradeDate)));
  }

  async load(date, revision = null) {
    const directory = this.directory(date);
    const manifest = (await readJsonWithBackup(path.join(directory, 'manifest.json'), null)).value;
    if (!manifest) return null;
    const selected = revision || manifest.latestRevision;
    if (!Number.isInteger(Number(selected)) || Number(selected) < 1) throw new Error('报告修订号无效');
    const report = (await readJsonWithBackup(path.join(directory, `report-r${String(selected).padStart(3, '0')}.json`), null)).value;
    return report ? {manifest, report} : null;
  }

  async save(date, report, input = {}) {
    const work = this.pendingSave.then(() => this.saveUnqueued(date, report, input));
    this.pendingSave = work.catch(() => {});
    return work;
  }

  async saveUnqueued(date, report, input = {}) {
    const directory = this.directory(date);
    const hash = contentHash(reportIdentity(report, input));
    const current = (await readJsonWithBackup(path.join(directory, 'manifest.json'), null)).value;
    if (current?.inputHash === hash) {
      const name = `report-r${String(current.latestRevision).padStart(3, '0')}`;
      if (fs.existsSync(path.join(directory, `${name}.json`)) && fs.existsSync(path.join(directory, `${name}.html`))) {
        const entries = await this.list();
        if (!entries.some(item => item.tradeDate === date && item.inputHash === hash && item.latestRevision === current.latestRevision)) {
          await atomicWriteJson(this.indexFile, {schemaVersion:1,updatedAt:new Date().toISOString(),
            reports:[...entries.filter(item => item.tradeDate !== date), current]});
        }
        return {...current, revision:current.latestRevision, unchanged:true};
      }
    }
    const revision = Number(current?.latestRevision || 0) + 1;
    const generatedAt = new Date().toISOString();
    const storedReport = {...report, tradeDate:date, revision, generatedAt:report.generatedAt || generatedAt};
    const revisionName = `report-r${String(revision).padStart(3, '0')}`;
    await fs.promises.mkdir(path.join(directory, 'inputs'), {recursive:true});
    await atomicWriteJson(path.join(directory, 'inputs', `${hash}.json`), input);
    await atomicWriteJson(path.join(directory, `${revisionName}.json`), storedReport);
    await atomicWriteText(path.join(directory, `${revisionName}.html`), renderDailyReportHtml(storedReport));
    const manifest = {
      schemaVersion:storedReport.schemaVersion || 1,
      tradeDate:date,
      latestRevision:revision,
      inputHash:hash,
      status:storedReport.status || 'partial',
      generatedAt,
      reason:String(input.reason || (revision > 1 ? '输入数据变化' : '首次生成')),
      jsonFile:`${revisionName}.json`,
      htmlFile:`${revisionName}.html`,
      warnings:storedReport.dataQuality?.warnings || []
    };
    await atomicWriteJson(path.join(directory, 'manifest.json'), manifest);
    const entries = (await this.list()).filter(item => item.tradeDate !== date);
    entries.push(manifest);
    await atomicWriteJson(this.indexFile, {schemaVersion:1, updatedAt:generatedAt, reports:entries});
    return {...manifest, revision};
  }

  async savePreview(date, report) {
    this.directory(date);
    const file = path.join(this.root, 'previews', `${date}.html`);
    await atomicWriteText(file, renderDailyReportHtml({...report, revision:'盘中预览', status:'未归档'}));
    this.preview = {date, file};
    return file;
  }

  async htmlPath(date, revision = null) {
    if (revision === 0) return this.preview?.date === date ? this.preview.file : null;
    const loaded = await this.load(date, revision);
    if (!loaded) return null;
    const selected = revision || loaded.manifest.latestRevision;
    return path.join(this.directory(date), `report-r${String(selected).padStart(3, '0')}.html`);
  }
}

function compactPublishedBatch(batch) {
  const compact = item => ({code:item.code,signalId:item.signalId,
    strategyId:item.strategyId || item.strategyDecision?.primaryStrategyId,
    price:item.quote?.price ?? item.price,invalidated:item.invalidated});
  return {batchId:batch.batchId,publishedAt:batch.publishedAt,inputCutoffAt:batch.inputCutoffAt,
    modelVersion:batch.modelVersion,tradeDate:batch.tradeDate,sourceType:batch.sourceType,
    recommendations:(batch.recommendations || []).map(compact),
    momentumRecommendations:(batch.momentumRecommendations || []).map(compact)};
}

async function readLedgerEntriesForDate(file, tradeDate, {compact = false} = {}) {
  if (!validDate(tradeDate)) throw new Error(`账本日期无效：${tradeDate}`);
  const entries = [];
  let invalidLines = 0;
  let incompleteTail = false;
  if (!fs.existsSync(file)) return {entries, invalidLines, incompleteTail};
  const stat = await fs.promises.stat(file);
  const endsWithNewline = stat.size === 0 ? true : await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file, {start:stat.size - 1, end:stat.size - 1});
    let value = '';
    stream.on('data', chunk => { value += chunk.toString('utf8'); });
    stream.on('end', () => resolve(value === '\n'));
    stream.on('error', reject);
  });
  const reader = readline.createInterface({input:fs.createReadStream(file, {encoding:'utf8'}), crlfDelay:Infinity});
  const parseLine = line => {
    if (!line.trim()) return;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.tradeDate === tradeDate) entries.push(compact ? compactPublishedBatch(parsed) : parsed);
    } catch {
      invalidLines += 1;
    }
  };
  let pending = null;
  for await (const line of reader) {
    if (pending !== null) parseLine(pending);
    pending = line;
  }
  if (pending !== null) {
    if (!endsWithNewline) {
      try {
        const parsed = JSON.parse(pending);
        if (parsed?.tradeDate === tradeDate) entries.push(compact ? compactPublishedBatch(parsed) : parsed);
      } catch {
        incompleteTail = true;
      }
    } else parseLine(pending);
  }
  return {entries, invalidLines, incompleteTail};
}

function readLedgerEntriesOffThread(file, tradeDate, timeoutMs = 120000, compact = false) {
  if (!isMainThread) return readLedgerEntriesForDate(file, tradeDate, {compact});
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {workerData:{ledgerRead:true,file,tradeDate,compact}});
    worker.unref();
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('历史推荐账本读取超时')), timeoutMs);
    worker.once('message', message => finish(message.error ? new Error(message.error) : null, message.result));
    worker.once('error', error => finish(error));
    worker.once('exit', code => {
      if (!settled && code !== 0) finish(new Error(`历史推荐账本工作线程退出：${code}`));
    });
  });
}

function reportDatesToGenerate({now = Date.now(), evidenceDates = [], existingDates = [], isTradingDay, maxDates = 20} = {}) {
  const nowTime = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(nowTime)) return [];
  const beijing = new Date(nowTime + 8 * 3600000);
  const today = beijing.toISOString().slice(0, 10);
  const minute = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  const existing = new Set(existingDates);
  const unique = [...new Set(evidenceDates)].filter(validDate).sort().slice(-maxDates);
  return unique.filter(date => !existing.has(date)
    && (typeof isTradingDay !== 'function' || isTradingDay(date) === true)
    && (date < today || (date === today && minute >= 15 * 60 + 30)));
}

if (!isMainThread && workerData?.ledgerRead) {
  readLedgerEntriesForDate(workerData.file, workerData.tradeDate,{compact:Boolean(workerData.compact)})
    .then(result => parentPort.postMessage({result}))
    .catch(error => parentPort.postMessage({error:error.stack || error.message || String(error)}));
}

module.exports = {DailyReportStore, readLedgerEntriesForDate, readLedgerEntriesOffThread, reportDatesToGenerate, contentHash, validDate};
