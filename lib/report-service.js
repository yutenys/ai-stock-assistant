'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const zlib = require('node:zlib');
const {Readable} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const {Worker, isMainThread, parentPort, workerData} = require('node:worker_threads');
const {atomicWriteJson, readJsonWithBackup} = require('./persistence');
const {renderDailyReportHtml} = require('./daily-report');
const {readReportSummary} = require('./large-json');

function validDate(value) {
  const date = String(value || '');
  const time = Date.parse(`${date}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(time)
    && new Date(time).toISOString().slice(0, 10) === date;
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
    const file = path.join(directory, `report-r${String(selected).padStart(3, '0')}.json`);
    const stat = await fs.promises.stat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    const report = stat?.size > 20_000_000 ? await readReportSummary(file)
      : (await readJsonWithBackup(file, null)).value;
    return report && report.tradeDate === date && Number(report.revision) === Number(selected) ? {manifest, report} : null;
  }

  async episodePage(date, revision = null, page = 0, limit = 20) {
    if (!Number.isInteger(page) || page < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new Error('报告明细页码无效');
    const saved = await this.load(date,revision);
    if (!saved) return null;
    const chunks = saved.report.publishedOutcomes?.episodeChunks || [];
    const total = chunks.reduce((sum,row) => sum + (Number(row.count) || 0),0);
    const rows = [];
    let skip = page * limit;
    for (const chunk of chunks) {
      if (skip >= chunk.count) {skip -= chunk.count;continue;}
      if (!/^outcome-details\/[a-f0-9]{64}\.jsonl$/.test(chunk.file)
        || chunk.file.slice(16,80) !== chunk.sha256) throw new Error('报告明细引用无效');
      const content = await fs.promises.readFile(path.join(this.directory(date),chunk.file));
      if (content.length !== chunk.bytes || crypto.createHash('sha256').update(content).digest('hex') !== chunk.sha256)
        throw new Error('报告明细校验失败');
      const lines = content.toString('utf8').trimEnd().split('\n');
      if (lines.length !== chunk.count) throw new Error('报告明细数量不符');
      rows.push(...lines.slice(skip,skip + limit - rows.length).map(JSON.parse));
      skip = 0;
      if (rows.length >= limit) break;
    }
    return {rows,total,page,limit,hasMore:(page + 1)*limit < total};
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
      const saved = await this.load(date,current.latestRevision);
      const html = await fs.promises.readFile(path.join(directory,`${name}.html`),'utf8')
        .catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (saved && contentHash(reportIdentity(saved.report,input)) === hash && html === renderDailyReportHtml(saved.report)) {
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
    const manifest = (await readJsonWithBackup(path.join(this.directory(date), 'manifest.json'), null)).value;
    const selected = revision || manifest?.latestRevision;
    if (!manifest || !Number.isInteger(Number(selected)) || Number(selected) < 1) return null;
    const file = path.join(this.directory(date), `report-r${String(selected).padStart(3, '0')}.html`);
    const json = path.join(this.directory(date), `report-r${String(selected).padStart(3, '0')}.json`);
    return fs.existsSync(file) && fs.existsSync(json) ? file : null;
  }
}

function compactPublishedBatch(batch) {
  const compact = item => ({code:item.code,signalId:item.signalId,lifecycleOnly:item.lifecycleOnly,
    shadowDecisionInput:item.shadowDecisionInput,
    businessRelation:item.businessRelation,businessRelationEvidence:item.businessRelationEvidence,
    strategyId:item.strategyId || item.strategyDecision?.primaryStrategyId,
    price:item.quote?.price ?? item.price,invalidated:item.invalidated,
    entryPermission:item.entryPermission || item.strategyDecision?.entryPermission,triggeredAt:item.triggeredAt,
    setupType:item.setupType,decisionEventType:item.decisionEvent?.type || item.decisionEventType,
    planId:item.planId,planRevision:item.planRevision,revision:item.revision,episodeId:item.episodeId,
    terminal:item.terminal,terminalState:item.terminalState,planState:item.planState,invalidatedAt:item.invalidatedAt,
    expiresAt:item.expiresAt,entryExpiryDate:item.entryExpiryDate,maxEntryPrice:item.maxEntryPrice,
    expectedEntryPrice:item.expectedEntryPrice,triggerPrice:item.triggerPrice,
    riskChecks:item.riskChecks,costAssumptions:item.costAssumptions,costs:item.costs,
    plan:item.plan,earliestBuyDate:item.earliestBuyDate,earliestSellDate:item.earliestSellDate,
    executionEvidence:item.executionEvidence,
    tradePlan:item.tradePlan || item.analysis?.tradePlan,
    triggerEvent:item.triggerEvent,decisionEvent:item.decisionEvent,
    quoteObservedAt:item.quote?.quoteObservedAt || item.quote?.observedAt || item.quoteObservedAt,
    quoteTradeDate:item.quote?.tradeDate || item.quoteTradeDate || item.tradeDate,
    quoteSource:item.quote?.source || item.quoteSource,
    quoteStale:item.quote?.stale ?? item.quoteStale,
    executionTiming:item.executionTiming,recommendationTier:item.recommendationTier,
    fullMarketFactor:item.fullMarketFactor?.scope ? {scope:item.fullMarketFactor.scope} : undefined});
  return {batchId:batch.batchId,publishedAt:batch.publishedAt,inputCutoffAt:batch.inputCutoffAt,
    modelVersion:batch.modelVersion,tradeDate:batch.tradeDate,sourceType:batch.sourceType,
    quoteObservedAt:batch.quoteObservedAt,observedAt:batch.observedAt,
    recommendations:(batch.recommendations || []).map(compact),
    momentumRecommendations:(batch.momentumRecommendations || []).map(compact),
    shortReboundCandidates:(batch.shortReboundCandidates || []).map(item => ({...compact(item),
      shortRebound:item.shortRebound,shortReboundSelection:item.shortReboundSelection,
      shadowOnly:true,entryPermission:'shadow-only'}))};
}

async function readLedgerEntriesForDate(file, tradeDate, {compact = false} = {}) {
  if (!validDate(tradeDate)) throw new Error(`账本日期无效：${tradeDate}`);
  return readLedgerEntriesInRange(file, tradeDate, tradeDate, {compact});
}

async function readLedgerEntriesInRange(file, from, to, {compact = false} = {}) {
  if (!validDate(from) || !validDate(to) || from > to) throw new Error('账本日期范围无效');
  const entries = [];
  let invalidLines = 0;
  let incompleteTail = false;
  const handle = await fs.promises.open(file, 'r').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!handle) return {entries, invalidLines, incompleteTail};
  try {
    const stat = await handle.stat();
    if (!stat.size) return {entries, invalidLines, incompleteTail};
    const tail = Buffer.alloc(1);
    await handle.read(tail, 0, 1, stat.size - 1);
    const endsWithNewline = tail[0] === 10;
    const stream = handle.createReadStream({encoding:'utf8',start:0,end:stat.size - 1,autoClose:false});
    const reader = readline.createInterface({input:stream, crlfDelay:Infinity});
    const parseLine = line => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line);
        if (validDate(parsed?.tradeDate) && parsed.tradeDate >= from && parsed.tradeDate <= to)
          entries.push(compact ? compactPublishedBatch(parsed) : parsed);
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
          if (validDate(parsed?.tradeDate) && parsed.tradeDate >= from && parsed.tradeDate <= to)
            entries.push(compact ? compactPublishedBatch(parsed) : parsed);
        } catch {
          incompleteTail = true;
        }
      } else parseLine(pending);
    }
    return {entries, invalidLines, incompleteTail};
  } finally {
    await handle.close();
  }
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

async function readCachedPublishedLedger(file, tradeDate, cacheDir) {
  const stat = await fs.promises.stat(file);
  const identity = crypto.createHash('sha256').update(`published-cache-v4:${path.resolve(file)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`)
    .digest('hex').slice(0, 20);
  const cacheFile = path.join(cacheDir, `${tradeDate}-${identity}.jsonl.gz`);
  try {
    await fs.promises.access(cacheFile);
    const input = fs.createReadStream(cacheFile).pipe(zlib.createGunzip());
    const reader = readline.createInterface({input,crlfDelay:Infinity});
    let meta = null;
    const entries = [];
    for await (const line of reader) {
      const row = JSON.parse(line);
      if (!meta) meta = row;
      else {
        if (row?.tradeDate !== tradeDate) throw new Error('缓存账本日期不一致');
        entries.push(row);
      }
    }
    if (meta?.identity !== identity || meta.tradeDate !== tradeDate || meta.count !== entries.length)
      throw new Error('缓存账本不完整');
    return {entries,invalidLines:meta.invalidLines,incompleteTail:meta.incompleteTail,cacheHit:true};
  } catch (error) {
    if (error.code !== 'ENOENT') await fs.promises.rename(cacheFile,`${cacheFile}.invalid-${Date.now()}`).catch(()=>{});
  }
  const result = await readLedgerEntriesForDate(file, tradeDate, {compact:true});
  const published = item => !item?.fullMarketFactor?.scope && item?.recommendationTier !== '历史待筛';
  result.entries = result.entries.map(batch=>({...batch,
    recommendations:batch.recommendations.filter(published),
    momentumRecommendations:batch.momentumRecommendations.filter(published),
    shortReboundCandidates:(batch.shortReboundCandidates || []).filter(item => item.shadowOnly)}));
  const temp = `${cacheFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.mkdir(cacheDir,{recursive:true});
    const lines = function* () {
      yield `${JSON.stringify({identity,tradeDate,count:result.entries.length,
        invalidLines:result.invalidLines,incompleteTail:result.incompleteTail})}\n`;
      for (const row of result.entries) yield `${JSON.stringify(row)}\n`;
    };
    await pipeline(Readable.from(lines()),zlib.createGzip({level:1}),fs.createWriteStream(temp,{flags:'wx'}));
    await fs.promises.rename(temp,cacheFile);
  } catch {
    await fs.promises.rm(temp,{force:true}).catch(()=>{});
  }
  return {...result,cacheHit:false};
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

module.exports = {DailyReportStore, compactPublishedBatch, readLedgerEntriesForDate, readLedgerEntriesInRange, readLedgerEntriesOffThread, readCachedPublishedLedger, reportDatesToGenerate, contentHash, validDate};
