const path = require('node:path');
const crypto = require('node:crypto');
const {Worker,isMainThread,parentPort,workerData} = require('node:worker_threads');
const {atomicWriteJson,readJsonWithBackup} = require('./persistence');

function snapshotHash(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function compactFavoriteStock(stock = {}) {
  const fields = ['code','name','sector','industry','actualIndustry','type','status','focus','reason','news',
    'price','changePct','change','volume','amount','high','low','open','prevClose','amplitude','turnoverRate','peRatio',
    'snapshotVolumeRatio','pbRatio','upperLimit','lowerLimit','totalMarketCap','floatMarketCap','mainNetInflow','mainNetPct',
    'mainInflow','mainOutflow','fundFlowDate','fundFlowObservedAt','fundFlowSource','fundFlowStatus','tradeDate',
    'quoteObservedAt','source','fetchedAt','stale','technicalScore','score','signalScore','relevanceScore','canslim',
    'holdingProfile','holdingPeriod','marketSignal','newsLabel','recommendationModelVersion','signalId','planId','analysisId',
    'favoriteEntrySnapshotRef','favoriteBasePrice','favoriteAddedAt','pinned'];
  const compact = {};
  for (const field of fields) if (stock[field] !== undefined) compact[field] = stock[field];
  return compact;
}

function splitUserState(input = {}) {
  const evidence = {};
  const labels = (input.labels || []).map(label => ({...label,stocks:(label.stocks || []).map(stock => {
    const next = compactFavoriteStock(stock);
    if (stock.favoriteEntrySnapshot && typeof stock.favoriteEntrySnapshot === 'object') {
      const ref = snapshotHash(stock.favoriteEntrySnapshot);
      evidence[ref] = stock.favoriteEntrySnapshot;
      next.favoriteEntrySnapshotRef = ref;
      delete next.favoriteEntrySnapshot;
    }
    return next;
  })}));
  return {state:{...input,schemaVersion:3,labels},evidence};
}

function hydrateUserState(input = {}, evidence = {}) {
  let missingEvidence = 0;
  const labels = (input.labels || []).map(label => ({...label,stocks:(label.stocks || []).map(stock => {
    const snapshot = stock.favoriteEntrySnapshot || evidence[stock.favoriteEntrySnapshotRef];
    if (stock.favoriteEntrySnapshotRef && !snapshot) missingEvidence++;
    return snapshot ? {...stock,favoriteEntrySnapshot:snapshot} : {...stock};
  })}));
  return {state:{...input,labels},missingEvidence};
}

function compactHydratedState(input = {}) {
  const labels = (input.labels || []).map(label => ({...label,stocks:(label.stocks || []).map(stock => {
    const compact = compactFavoriteStock(stock);
    if (stock.favoriteEntrySnapshot) compact.favoriteEntrySnapshot = stock.favoriteEntrySnapshot;
    return compact;
  })}));
  return {...input,labels};
}

async function loadFiles(stateFile,evidenceFile) {
  const loaded = await readJsonWithBackup(stateFile,null);
  if (!loaded.value) return {...loaded,value:null,missingEvidence:0};
  const evidenceLoaded = await readJsonWithBackup(evidenceFile,{});
  const hydrated = hydrateUserState(loaded.value,evidenceLoaded.value || {});
  return {...loaded,value:compactHydratedState(hydrated.state),missingEvidence:hydrated.missingEvidence,
    evidenceRecoveredFromBackup:evidenceLoaded.recoveredFromBackup};
}

async function saveFiles(stateFile,evidenceFile,input) {
  const {state,evidence} = splitUserState(input);
  const existing = (await readJsonWithBackup(evidenceFile,{})).value || {};
  const additions = Object.entries(evidence).filter(([ref]) =>
    !Object.prototype.hasOwnProperty.call(existing,ref) || snapshotHash(existing[ref]) !== ref);
  const mergedEvidence = additions.length ? {...existing,...Object.fromEntries(additions)} : existing;
  if (additions.length) await atomicWriteJson(evidenceFile,mergedEvidence);
  await atomicWriteJson(stateFile,state);
  return {ok:true,file:stateFile,schemaVersion:3,revision:state.revision || 0,
    evidenceCount:Object.keys(mergedEvidence).length,evidenceChanged:Boolean(additions.length)};
}

function runWorker(data) {
  return new Promise((resolve,reject) => {
    const worker = new Worker(__filename,{workerData:data});
    worker.once('message',message => message?.error ? reject(new Error(message.error)) : resolve(message.result));
    worker.once('error',reject);
    worker.once('exit',code => { if (code !== 0) reject(new Error(`用户状态线程异常退出：${code}`)); });
  });
}

class UserStateStore {
  constructor(root) {
    this.stateFile = path.join(root,'user-state.json');
    this.evidenceFile = path.join(root,'user-favorite-evidence.json');
    this.pending = Promise.resolve();
  }

  load() {
    return runWorker({mode:'load',stateFile:this.stateFile,evidenceFile:this.evidenceFile});
  }

  save(state) {
    const task = this.pending.catch(()=>{}).then(() => runWorker({mode:'save',stateFile:this.stateFile,
      evidenceFile:this.evidenceFile,state}));
    this.pending = task;
    return task;
  }
}

if (!isMainThread && workerData?.mode) {
  const task = workerData.mode === 'load'
    ? loadFiles(workerData.stateFile,workerData.evidenceFile)
    : saveFiles(workerData.stateFile,workerData.evidenceFile,workerData.state || {});
  task.then(result=>parentPort.postMessage({result}),error=>parentPort.postMessage({error:error.stack || String(error)}));
}

module.exports={snapshotHash,compactFavoriteStock,splitUserState,hydrateUserState,compactHydratedState,
  loadFiles,saveFiles,UserStateStore};
