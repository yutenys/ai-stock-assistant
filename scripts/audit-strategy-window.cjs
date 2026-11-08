'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {Transform} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const {validDate,readLedgerEntriesInRange} = require('../lib/report-service');
const {favoriteSummary} = require('../lib/daily-report');
const {evaluatePublishedEpisodes,mergeSavedReportCloses} = require('../lib/recommendation-outcomes');
const {clock,isTradingDay} = require('../lib/trade-time');
const {buildExperimentReplayInput} = require('../lib/strategy-experiments');
const {readReportSummary,readCacheSummary} = require('../lib/large-json');

async function splitEpisodeDetails(episodes, runDirectory) {
  const chunks = [];
  let lines = [], bytes = 0;
  async function flush() {
    if (!lines.length) return;
    const content = lines.join('');
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    const file = `episode-details-${String(chunks.length + 1).padStart(3,'0')}.jsonl`;
    await fs.promises.writeFile(path.join(runDirectory,file),content,{flag:'wx',mode:0o600});
    chunks.push({file,sha256,bytes:Buffer.byteLength(content),count:lines.length});
    lines = []; bytes = 0;
  }
  for (const episode of episodes) {
    const line = JSON.stringify(episode)+'\n';
    const size = Buffer.byteLength(line);
    if (size > 1_900_000) throw new Error(`Single episode exceeds audit chunk budget: ${episode.episodeId || 'unknown'}`);
    if (bytes + size > 1_900_000) await flush();
    lines.push(line); bytes += size;
  }
  await flush();
  return {count:episodes.length,chunks};
}

function compactMarketAudit(overview, rotation, from, to) {
  const sector = row => ({name:row.name,code:row.code,boardType:row.boardType,
    changePct:row.changePct,capitalTradeDate:row.capitalTradeDate,
    capitalSource:row.capitalSource,capitalEstimated:row.capitalEstimated,
    mainNetInflow:row.mainNetInflow,memberSignature:row.memberSignature,
    memberCount:row.memberCount || row.memberCodes?.length || null,
    themeRegime:row.themeRegime ? {phase:row.themeRegime.phase,state:row.themeRegime.state,
      capital:row.themeRegime.capital,episodeId:row.themeRegime.episodeId} : null});
  const compact = row => ({tradeDate:row.tradeDate,fetchedAt:row.fetchedAt,
    quoteObservedAt:row.quoteObservedAt,breadth:row.breadth,turnover:row.turnover,
    indices:row.indices,limits:row.limits ? {upCount:row.limits.upCount,downCount:row.limits.downCount} : null,
    sectors:(row.sectors || []).map(sector)});
  return {overview:compact(overview),overviewStatus:overview.tradeDate >= from && overview.tradeDate <= to
    ? 'in-window' : 'outside-window',rotationWindow:(Array.isArray(rotation) ? rotation : [])
      .filter(row => row.tradeDate >= from && row.tradeDate <= to).map(compact)};
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--from','--to','--root','--output'].includes(key) || !args[index + 1]
      || args[index + 1].startsWith('--') || options[key.slice(2)] !== undefined) throw new Error(`Invalid argument: ${key}`);
    options[key.slice(2)] = args[index + 1];
  }
  validateOptions(options);
  return options;
}

function validateOptions({from,to,root}) {
  if (!validDate(from) || !validDate(to) || from > to || !root)
    throw new Error('Required: --from YYYY-MM-DD --to YYYY-MM-DD --root directory [--output directory]');
}

async function freezeFile(file, snapshotDirectory) {
  const handle = await fs.promises.open(file,'r');
  const hash = crypto.createHash('sha256');
  const chunks = [];
  let bytes = 0;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Not a file: ${file}`);
    const ledger = file.endsWith('.jsonl');
    const streamedJson = file.endsWith('.json') && stat.size > 20_000_000;
    let snapshotFile;
    if (ledger || streamedJson) {
      await fs.promises.mkdir(snapshotDirectory,{recursive:true});
      snapshotFile = path.join(snapshotDirectory,`${crypto.randomUUID()}${ledger ? '.jsonl' : '.json'}`);
    }
    if (stat.size) {
      // One descriptor and a fixed byte boundary exclude concurrent appends.
      const stream = handle.createReadStream({start:0,end:stat.size - 1,autoClose:false});
      if (ledger || streamedJson) {
        const hashing = new Transform({transform(chunk,encoding,callback) {
          bytes += chunk.length;
          hash.update(chunk);
          callback(null,chunk);
        }});
        await pipeline(stream,hashing,fs.createWriteStream(snapshotFile,{flags:'wx',mode:0o600}));
      } else {
        for await (const chunk of stream) {
          bytes += chunk.length;
          hash.update(chunk);
          chunks.push(chunk);
        }
      }
    } else if (ledger) await fs.promises.writeFile(snapshotFile,'',{flag:'wx',mode:0o600});
    if (bytes !== stat.size) throw new Error(`Input truncated during freeze: ${file}`);
    return {file,bytes,sha256:hash.digest('hex'),snapshotFile,
      buffer:ledger || streamedJson ? undefined : Buffer.concat(chunks)};
  } finally {
    await handle.close();
  }
}

function parseFrozenJson(frozen) {
  return JSON.parse(frozen.buffer.toString('utf8'));
}

async function readFrozenLedger(frozen, {from,to}) {
  return readLedgerEntriesInRange(frozen.snapshotFile,from,to,{compact:true});
}

async function filesUnder(directory, extension) {
  const entries = await fs.promises.readdir(directory,{withFileTypes:true})
    .catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const files = [];
  for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory,entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(file,extension));
    else if (entry.isFile() && file.endsWith(extension)) files.push(file);
  }
  return files;
}

async function canonicalDirectory(directory) {
  try { return await fs.promises.realpath(directory); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(await canonicalDirectory(path.dirname(directory)),path.basename(directory));
  }
}

function within(directory,file) {
  const relative = path.relative(directory,file);
  return relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function runAudit(options) {
  validateOptions(options);
  const requestedRoot = path.resolve(options.root);
  const root = await fs.promises.realpath(requestedRoot);
  const requestedOutput = path.resolve(options.output || path.join(requestedRoot,'cache','strategy-audits'));
  const output = await canonicalDirectory(requestedOutput);
  const business = await canonicalDirectory(path.join(root,'data'));
  if (within(business,output) || output === root || output === path.join(root,'cache'))
    throw new Error('Audit output must not be a business directory');
  const runId = `${new Date().toISOString().replace(/[:.]/g,'-')}-${crypto.randomUUID()}`;
  const runDirectory = path.join(output,runId);
  await fs.promises.mkdir(runDirectory,{recursive:true,mode:0o700});
  const snapshotDirectory = path.join(runDirectory,'.frozen');
  const frozen = new Map(), missing = [], invalid = [];
  const relative = file => path.relative(root,file).split(path.sep).join('/');
  const add = async (file,required = true) => {
    try { frozen.set(relative(file),await freezeFile(file,snapshotDirectory)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (required) missing.push(relative(file));
    }
  };
  try {
    for (const file of ['data/user-state.json','cache/market-rotation-history.json','cache/market-overview.json'])
      await add(path.join(root,file));
    await add(path.join(root,'cache','quotes.json'),false);
    await add(path.join(root,'data','strategy-experiments','plan10-08v2.json'),false);
    const ledgerRoot = path.join(root,'data','recommendation-ledger');
    const daily = (await filesUnder(path.join(ledgerRoot,'daily'),'.jsonl')).filter(file => {
      const date = path.basename(file,'.jsonl');
      return validDate(date) && date >= options.from && date <= options.to;
    });
    const monthly = (await fs.promises.readdir(ledgerRoot).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)))
      .filter(name => /^\d{4}-\d{2}\.jsonl$/.test(name) && name.slice(0,7) >= options.from.slice(0,7) && name.slice(0,7) <= options.to.slice(0,7))
      .sort().map(name => path.join(ledgerRoot,name));
    for (const file of [...daily,...monthly]) await add(file);
    if (!daily.length && !monthly.length) missing.push('data/recommendation-ledger');
    const manifests = (await filesUnder(path.join(root,'data','reports'),'.json')).filter(file => {
      const date = path.basename(path.dirname(file));
      return validDate(date) && date <= options.to && path.basename(file) === 'manifest.json';
    });
    for (const file of manifests) await add(file);
    for (const file of manifests) {
      let manifest;
      try { manifest = parseFrozenJson(frozen.get(relative(file))); }
      catch (error) { invalid.push({file:relative(file),reason:error.message}); continue; }
      const revision = manifest?.latestRevision;
      if (!Number.isInteger(Number(revision)) || Number(revision) < 1) {
        invalid.push({file:relative(file),reason:'缺少有效的最新修订号'});
        continue;
      }
      const reportFile = path.join(path.dirname(file),`report-r${String(revision).padStart(3,'0')}.json`);
      await add(reportFile);
      await add(reportFile.replace(/\.json$/,'.html'));
    }
    const json = key => {
      const input = frozen.get(key);
      if (!input) return null;
      try { return parseFrozenJson(input); }
      catch (error) { invalid.push({file:key,reason:error.message}); return null; }
    };
    const state = json('data/user-state.json') || {};
    const overviewFrozen = frozen.get('cache/market-overview.json');
    const rotationFrozen = frozen.get('cache/market-rotation-history.json');
    const overviewFile = overviewFrozen?.buffer ? json('cache/market-overview.json')
      : overviewFrozen?.snapshotFile ? await readCacheSummary(overviewFrozen.snapshotFile,'market-overview') : null;
    const rotationFile = rotationFrozen?.buffer ? json('cache/market-rotation-history.json')
      : rotationFrozen?.snapshotFile ? await readCacheSummary(rotationFrozen.snapshotFile,'market-rotation-history') : null;
    const overview = overviewFile?.data || overviewFile || {};
    const rotation = rotationFile?.data || rotationFile || [];
    const entries = [], ledgerQuality = [], dailyBatches = new Set();
    for (const file of [...daily,...monthly]) {
      const input = frozen.get(relative(file));
      const result = await readFrozenLedger(input,options);
      const isMonthly = path.dirname(file) === ledgerRoot;
      const selected = result.entries.filter(row => !isMonthly || !row.batchId || !dailyBatches.has(`${row.tradeDate}|${row.batchId}`));
      if (!isMonthly) for (const row of selected) if (row.batchId) dailyBatches.add(`${row.tradeDate}|${row.batchId}`);
      entries.push(...selected);
      ledgerQuality.push({file:relative(file),invalidLines:result.invalidLines,incompleteTail:result.incompleteTail,
        skippedMonthlyDuplicates:result.entries.length - selected.length});
    }
    const coveredDates = new Set(entries.map(row => row.tradeDate));
    const calendarUnknown = [];
    for (let time = Date.parse(`${options.from}T00:00:00Z`); time <= Date.parse(`${options.to}T00:00:00Z`); time += 86400000) {
      const date = new Date(time).toISOString().slice(0,10);
      const trading = isTradingDay(date);
      if (trading === null) calendarUnknown.push(date);
      else if (trading && !coveredDates.has(date)) missing.push(`ledger:${date}`);
    }
    const reports = [], reportRevisions = [];
    for (const key of frozen.keys()) if (/\/manifest\.json$/.test(key)) {
      const manifest = json(key);
      const prefix = key.slice(0,-'manifest.json'.length);
      const revision = manifest?.latestRevision;
      const name = `report-r${String(revision).padStart(3,'0')}`;
      const reportInput = frozen.get(`${prefix}${name}.json`);
      const report = reportInput?.snapshotFile ? await readReportSummary(reportInput.snapshotFile) : json(`${prefix}${name}.json`);
      const html = frozen.has(`${prefix}${name}.html`);
      const complete = Boolean(report && report.tradeDate === manifest.tradeDate && Number(report.revision) === Number(revision) && html);
      if (complete) reports.push(report);
      else missing.push(`${prefix}${name} complete revision`);
      reportRevisions.push({tradeDate:manifest?.tradeDate || prefix.split('/').at(-2),revision,
        inputHash:manifest?.inputHash || null,jsonFile:`${prefix}${name}.json`,htmlFile:`${prefix}${name}.html`,complete});
    }
    const histories = new Map();
    const codes = [...new Set([...entries.flatMap(batch => [...(batch.recommendations || []),...(batch.momentumRecommendations || [])].map(row => String(row.code))),
      ...(state.labels || []).flatMap(label => (label.stocks || []).map(row => String(row.code)))])].filter(code => /^\d{6}$/.test(code)).sort();
    // Freeze only the window's codes and all saved favorites, never the whole stock universe.
    for (const code of codes) {
      const file = path.join(root,'data','market-history',code.slice(0,2),`${code}.json`);
      await add(file,false);
      const history = json(relative(file));
      histories.set(code,history?.code === code ? history : null);
    }
    const merged = mergeSavedReportCloses(histories,reports,{asOfDate:options.to});
    const quoteFile = json('cache/quotes.json');
    const quotes = Array.isArray(quoteFile) ? quoteFile : quoteFile?.data || quoteFile?.quotes || [];
    const localQuotes = new Map((Array.isArray(quotes) ? quotes : []).map(row => [String(row.code),row]));
    const favoriteRows = (state.labels || []).flatMap(label => (label.stocks || []).map(stock => {
      const code = String(stock.code || '');
      const history = merged.histories.get(code);
      const original = history?.bars?.find(row => row.date === options.to);
      const overlay = original?.finalClose;
      const bar = overlay?.isFinal === true && overlay.date === options.to
        && (overlay.adjustment || 'none') === (original.adjustment || history.adjustment || 'none')
        ? overlay : original?.isFinal === true ? original : null;
      const quote = localQuotes.get(code);
      const finalQuote = quote?.tradeDate === options.to && quote.isFinal === true && !quote.stale ? quote : null;
      const addedAt = stock.favoriteAddedAt || '';
      const future = addedAt && clock(addedAt).date > options.to;
      return {code,name:stock.name || '',label:label.name || '',addedAt,
        referencePrice:stock.favoriteBasePrice,currentPrice:future ? null : bar?.close ?? finalQuote?.price ?? null,
        quoteTradeDate:bar?.date || finalQuote?.tradeDate || null,
        quoteObservedAt:bar?.observedAt || finalQuote?.quoteObservedAt || finalQuote?.observedAt || null,
        source:bar?.source || (bar ? history?.source : finalQuote?.source) || null,
        favoriteEntrySnapshot:stock.favoriteEntrySnapshot || null,
        modelVersion:stock.favoriteEntrySnapshot?.modelVersion || 'unknown',
        attribution:stock.favoriteEntrySnapshot?.sourceType || 'unknown',
        entryPermission:stock.entryPermission,riskReasons:stock.riskReasons || [],
        dataStatus:future ? 'added-after-cutoff' : bar || finalQuote ? 'observed' : 'missing'};
    }));
    const isLegacy = (row,batch) => batch.sourceType === 'external-report' || Boolean(row.fullMarketFactor?.scope)
      || row.recommendationTier === '历史待筛';
    const legacy = entries.map(batch => ({...batch,
      recommendations:(batch.recommendations || []).filter(row => isLegacy(row,batch)),
      momentumRecommendations:(batch.momentumRecommendations || []).filter(row => isLegacy(row,batch))}))
      .filter(batch => batch.recommendations.length || batch.momentumRecommendations.length);
    const legacyStocks = new Set(legacy.flatMap(batch => [...batch.recommendations,...batch.momentumRecommendations].map(row => row.code)));
    const strategyEntries = entries.map(batch => ({...batch,
      recommendations:(batch.recommendations || []).filter(row => !isLegacy(row,batch)),
      momentumRecommendations:(batch.momentumRecommendations || []).filter(row => !isLegacy(row,batch))}));
    const publishedOutcomes = evaluatePublishedEpisodes(strategyEntries,merged.histories,{asOfDate:options.to});
    const outcomeBytes = Buffer.byteLength(JSON.stringify(publishedOutcomes.episodes));
    const episodeDetails = outcomeBytes > 1_000_000
      ? await splitEpisodeDetails(publishedOutcomes.episodes,runDirectory) : null;
    const outcomeSummary = episodeDetails ? {...publishedOutcomes,episodes:[],episodeDetails} : publishedOutcomes;
    const experimentManifest = json('data/strategy-experiments/plan10-08v2.json');
    let replayInputFile = null;
    if (experimentManifest?.freezeDate <= options.to) {
      replayInputFile = path.join(runDirectory,'replay-input.json');
      await fs.promises.writeFile(replayInputFile,JSON.stringify(buildExperimentReplayInput(strategyEntries,merged.histories,
        {manifest:experimentManifest,asOfDate:options.to}),null,2)+'\n',{flag:'wx',mode:0o600});
    }
    const evidence = {schemaVersion:1,runId,createdAt:new Date().toISOString(),
      cutoffAt:`${options.to}T23:59:59+08:00`,timezone:'Asia/Shanghai',from:options.from,to:options.to,
      methodologyVersion:'2026-10-08-v2-local-frozen',modelVersions:[...new Set(entries.map(row => row.modelVersion || 'unknown'))].sort(),
      inputs:[...frozen.entries()].map(([file,value]) => ({file,bytes:value.bytes,sha256:value.sha256})).sort((a,b) => a.file.localeCompare(b.file)),
      replayInputFile,
      data:{favorites:favoriteSummary(favoriteRows),
        removedFavoriteEvents:(state.removedFavoriteEvents || []).filter(row => Number.isFinite(Date.parse(row.removedAt || ''))
          && clock(row.removedAt).date >= options.from && clock(row.removedAt).date <= options.to),
        publishedOutcomes:outcomeSummary,
        market:compactMarketAudit(overview,rotation,options.from,options.to),reportRevisions,
        legacyBroadList:{batches:legacy.length,signals:legacy.reduce((sum,batch) => sum + (batch.recommendations?.length || 0) + (batch.momentumRecommendations?.length || 0),0),
          codes:legacyStocks.size,excludedFromStrategyStats:true},
        byModelVersion:[...new Set(entries.map(row => row.modelVersion || 'unknown'))].sort().map(modelVersion => {
          const batches = entries.filter(row => (row.modelVersion || 'unknown') === modelVersion);
          return {modelVersion,batches:batches.length,signals:batches.reduce((sum,row) => sum + (row.recommendations?.length || 0) + (row.momentumRecommendations?.length || 0),0)};
        }),
        quality:{networkRequests:0,missing,invalid,calendarUnknown,ledgers:ledgerQuality,savedCloseCount:merged.added,closeConflicts:merged.conflicts || [],
          missingFavoritePrices:favoriteRows.filter(row => row.dataStatus === 'missing').map(row => ({code:row.code,label:row.label})),
          caveats:['Current saved favorites only; deleted favorites cause survivorship bias.',
            'Local histories are retrospective; adjustments and corporate actions remain unverified.',
            'Unknown versions/original plans and unavailable observations are not zero returns; no automatic calibration.',
            'Files freeze sequentially, not as a cross-file database transaction; hashes describe exactly the bytes parsed.']}}};
    const evidenceFile = path.join(runDirectory,'evidence.json');
    await fs.promises.writeFile(evidenceFile,JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});
    // Keep the public path under the caller-provided root. On Windows realpath()
    // can expand an 8.3 temp path, which makes a valid audit appear to have
    // escaped its requested root even though both paths point to the same file.
    return {runId,evidenceFile:path.join(requestedOutput,runId,'evidence.json'),evidence};
  } finally {
    // Raw ledgers are temporary; no user-state byte copy is persisted.
    await fs.promises.rm(snapshotDirectory,{recursive:true,force:true});
  }
}

if (require.main === module) {
  Promise.resolve().then(() => runAudit(parseArgs(process.argv.slice(2)))).then(result => {
    console.log(JSON.stringify({runId:result.runId,evidenceFile:result.evidenceFile}));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = {parseArgs,freezeFile,parseFrozenJson,readFrozenLedger,runAudit,splitEpisodeDetails};
