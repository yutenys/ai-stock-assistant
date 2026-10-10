'use strict';

const fs = require('node:fs');
const {Worker,isMainThread,parentPort,workerData} = require('node:worker_threads');

async function readReportSummaryOffThread(file) {
  const [{parser},{ignore},{pick},{streamObject},{streamArray},{default:chain}] = await Promise.all([
    import('stream-json'),import('stream-json/filters/ignore.js'),
    import('stream-json/filters/pick.js'),import('stream-json/streamers/stream-object.js'),
    import('stream-json/streamers/stream-array.js'),import('stream-chain')
  ]);
  const stream = chain([fs.createReadStream(file),parser(),
    ignore({filter:/^(market\.path|publishedOutcomes\.episodes)$/}),streamObject()]);
  const report = {};
  for await (const {key,value} of stream) report[key] = value;
  if (report.market) report.market.path = null;
  if (report.publishedOutcomes) {
    const review = report.publishedOutcomes;
    const fields = ['observations','triggerObservations','nextOpenProxyObservations','executionObservations'];
    const values = Object.fromEntries((review.horizons || []).map(horizon => [horizon,
      Object.fromEntries(fields.map(field => [field,[]]))]));
    let verifiedExecutionCount = 0;
    if (review.counts?.episodes) {
      const details = chain([fs.createReadStream(file),parser(),pick({filter:'publishedOutcomes.episodes'}),streamArray()]);
      for await (const {value:episode} of details) {
        if (episode.execution?.verified === true) verifiedExecutionCount++;
        for (const horizon of review.horizons || []) for (const field of fields) {
          if (field === 'executionObservations' && episode.execution?.verified !== true) continue;
          const observation = field === 'nextOpenProxyObservations' ? episode.nextOpenProxy?.observations?.[horizon]
            : episode[field]?.[horizon];
          const result = field === 'executionObservations' ? observation?.netReturnPct : observation?.returnPct;
          if (observation?.status === 'observed' && Number.isFinite(result)) values[horizon][field].push(result);
        }
      }
    }
    review.horizonSummaries = Object.fromEntries(Object.entries(values).map(([horizon,byField]) => [horizon,
      Object.fromEntries(Object.entries(byField).map(([field,returns]) => [field,{
        count:returns.length,meanReturnPct:returns.length ? returns.reduce((sum,value)=>sum+value,0)/returns.length : null}]))]));
    review.verifiedExecutionCount = verifiedExecutionCount;
    review.episodes = [];
  }
  const recommendationKeys = ['code','name','industry','tracks','track','primaryRole','holdingPeriod','checkpoint',
    'publishedAt','earliestBuyDate','earliestSellDate','price','changePct','closePrice','closeChangePct',
    'closeSource','closeObservedAt','priceReturnPct','dataStatus','entryPermission','planId'];
  for (const key of ['stable','momentum','all','followUp','best','worst']) {
    if (Array.isArray(report.recommendations?.[key])) report.recommendations[key] = report.recommendations[key]
      .map(row => Object.fromEntries(recommendationKeys.filter(field => row[field] !== undefined)
        .map(field => [field,row[field]])));
  }
  if (Array.isArray(report.sectors)) report.sectors = report.sectors.map(row => ({name:row.name,code:row.code,
    changePct:row.changePct,rotationState:row.rotationState,mainNetInflow:row.mainNetInflow,
    capitalSource:row.capitalSource,capitalTradeDate:row.capitalTradeDate,
    shadowRotation:row.shadowRotation?.phase ? {phase:row.shadowRotation.phase,status:row.shadowRotation.status} : null}));
  if (Array.isArray(report.portfolio?.positions)) report.portfolio.positions = report.portfolio.positions
    .map(row => ({code:row.code,name:row.name,quantity:row.quantity,costPrice:row.costPrice,lastPrice:row.lastPrice}));
  report.legacyProjection = true;
  return report;
}

async function readCacheSummaryOffThread(file, type) {
  const [{parser},{pick},{ignore},{streamObject},{streamArray},{default:chain}] = await Promise.all([
    import('stream-json'),import('stream-json/filters/pick.js'),import('stream-json/filters/ignore.js'),
    import('stream-json/streamers/stream-object.js'),import('stream-json/streamers/stream-array.js'),import('stream-chain')
  ]);
  const projectSector = row => ({name:row.name,code:row.code,changePct:row.changePct,
    rotationScore:row.rotationScore,mainNetInflow:row.mainNetInflow,capitalSource:row.capitalSource,
    capitalTradeDate:row.capitalTradeDate,capitalObservedAt:row.capitalObservedAt,
    memberSignature:row.memberSignature,memberCount:row.memberCount || row.memberCodes?.length || null,
    rotationState:row.rotationState});
  if (type === 'market-overview') {
    const stream = chain([fs.createReadStream(file),parser(),pick({filter:'data'}),
      ignore({filter:'marketPath'}),streamObject()]);
    const data = {};
    for await (const {key,value} of stream) data[key] = value;
    data.sectors = (data.sectors || []).map(projectSector);
    data.marketPath = null;
    return data;
  }
  if (type === 'market-rotation-history') {
    const stream = chain([fs.createReadStream(file),parser(),pick({filter:'data'}),
      ignore({filter:/^\d+\.(snapshots|anchors|peakBreadth)$/}),streamArray()]);
    const days = [];
    for await (const {value} of stream) days.push({tradeDate:value.tradeDate,quoteObservedAt:value.quoteObservedAt,
      breadth:value.breadth,turnover:value.turnover,indices:value.indices,limits:value.limits,
      sectors:(value.sectors || []).map(projectSector)});
    return days;
  }
  throw new Error(`不支持的旧缓存类型：${type}`);
}

function runOffThread(file,mode) {
  if (!isMainThread) return mode === 'report' ? readReportSummaryOffThread(file) : readCacheSummaryOffThread(file,mode);
  return new Promise((resolve,reject) => {
    const worker = new Worker(__filename,{workerData:{file,mode}});
    worker.unref();
    let settled = false;
    const finish = (error,result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('旧报告流式读取超时')),120000);
    worker.once('message',message => finish(message.error ? new Error(message.error) : null,message.result));
    worker.once('error',error => finish(error));
    worker.once('exit',code => { if (!settled && code !== 0) finish(new Error(`旧报告读取线程退出：${code}`)); });
  });
}

function readReportSummary(file) { return runOffThread(file,'report'); }
function readCacheSummary(file,type) { return runOffThread(file,type); }

if (!isMainThread && workerData?.file) {
  (workerData.mode === 'report' ? readReportSummaryOffThread(workerData.file)
    : readCacheSummaryOffThread(workerData.file,workerData.mode)).then(result => parentPort.postMessage({result}),
    error => parentPort.postMessage({error:error.message || String(error)}));
}

module.exports = {readReportSummary,readCacheSummary};
