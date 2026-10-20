const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const originalLoad = Module._load;
Module._load = function(request,parent,isMain) {
  if (request === 'electron') return {app:{isPackaged:false,whenReady:()=>({then(){}}),on(){}},
    ipcMain:{handle(){}},BrowserWindow:function(){},shell:{}};
  return originalLoad.call(this,request,parent,isMain);
};
const api = require('../main');
Module._load = originalLoad;

test('breadth coverage changes are unknown, not falsely calculated deceleration',()=>{
  const before={breadth:{up:4000,down:1000,sampleCount:5000}};
  const now={breadth:{up:500,down:500,sampleCount:1000}};
  const value=api.classifyMarketRegime(now,before);
  assert.equal(value.upRatioDelta,null);
  assert.equal(value.coverageComparable,false);
});

test('trimming intraday samples preserves earlier peak and available anchors',()=>{
  const early={tradeDate:'2026-10-09',snapshotId:'early',fetchedAt:'2026-10-09T01:45:00Z',
    quoteObservedAt:'2026-10-09T01:45:00Z',breadth:{up:4500,down:500},turnover:1,observationPhase:{phase:'intraday'}};
  let history=api.updateMarketRotationHistory([],early);
  for(let i=0;i<110;i++) {
    const at=new Date(Date.parse(early.fetchedAt)+(i+1)*60000).toISOString();
    history=api.updateMarketRotationHistory(history,{...early,snapshotId:`s${i}`,fetchedAt:at,quoteObservedAt:at,
      breadth:{up:1000,down:4000},turnover:i+2});
  }
  assert.equal(history[0].snapshots.length,96);
  assert.equal(history[0].peakBreadth.snapshotId,'early');
  assert.equal(history[0].continuousPeakBreadth.snapshotId,'early');
  assert.equal(history[0].anchors['09:45'].snapshotId,'early');
});

test('auction breadth peak is separate from continuous trading peak',()=>{
  const base={tradeDate:'2026-10-09',fetchedAt:'2026-10-09T01:25:00Z',
    quoteObservedAt:'2026-10-09T01:25:00Z',breadth:{up:900,down:100,sampleCount:1000},
    observationPhase:{phase:'intraday'}};
  let history=api.updateMarketRotationHistory([],{...base,snapshotId:'auction'});
  history=api.updateMarketRotationHistory(history,{...base,snapshotId:'open',
    fetchedAt:'2026-10-09T01:45:00Z',quoteObservedAt:'2026-10-09T01:45:00Z',
    breadth:{up:700,down:300,sampleCount:1000}});
  const close={...base,snapshotId:'close',fetchedAt:'2026-10-09T07:01:00Z',
    quoteObservedAt:'2026-10-09T07:00:00Z',breadth:{up:500,down:500,sampleCount:1000}};
  history=api.updateMarketRotationHistory(history,close);
  assert.equal(history[0].peakBreadth.snapshotId,'auction');
  assert.equal(history[0].continuousPeakBreadth.snapshotId,'open');
  const path=api.marketPathEvidence(close,history[0]);
  assert.equal(path.peakBreadthDropPp,40);
  assert.equal(path.continuousPeakBreadthDropPp,20);
});

test('capital source or members switching cannot claim a same-day fund retreat',()=>{
  const base={name:'test',mainNetInflow:1e9,capitalSource:'A',boardType:'industry',memberCodes:['600001']};
  const previous={tradeDate:'2026-10-09',sectors:[base]};
  for(const row of [{...base,capitalSource:'B'},{...base,memberCodes:['600002']}]) {
    const value=api.annotateSectorRotation([{...row,mainNetInflow:1e8}],previous,'2026-10-09')[0];
    assert.equal(value.rotationIntraday.retreating,false);
    assert.equal(value.shadowRotation.sourceComparable,false);
  }
});

test('retrieving the same provider clock twice does not confirm independent sector inflow',()=>{
  const base={name:'test',mainNetInflow:1e9,capitalSource:'A',boardType:'industry',memberCodes:['600001'],
    capitalTradeDate:'2026-10-09',capitalObservedAt:'2026-10-09T10:00:00+08:00',capitalFetchedAt:'2026-10-09T10:01:00+08:00',
    participation:{coverage:1},exTop3UpRatio:1,exTop3Count:10,structureCoverage:1,ma20AboveRatio:1,ma30AboveRatio:1};
  const previous={tradeDate:'2026-10-09',sectors:[base]};
  const repeated=api.annotateSectorRotation([{...base,capitalFetchedAt:'2026-10-09T10:05:00+08:00'}],previous,'2026-10-09')[0];
  assert.equal(repeated.shadowRotation.independentSnapshot,false);
  assert.notEqual(repeated.shadowRotation.phase,'扩散确认');
  const fresh=api.annotateSectorRotation([{...base,capitalObservedAt:'2026-10-09T10:04:00+08:00',capitalFetchedAt:'2026-10-09T10:05:00+08:00'}],previous,'2026-10-09')[0];
  assert.equal(fresh.shadowRotation.independentSnapshot,true);
  assert.equal(fresh.shadowRotation.phase,'扩散确认');
});

test('market path preserves peak drawdown and previous limit-up cohort without inventing anchors',()=>{
  const overview={tradeDate:'2026-10-09',quoteObservedAt:'2026-10-09T10:00:00+08:00',breadth:{up:300,down:700,sampleCount:1000}};
  const peak={...overview,quoteObservedAt:'2026-10-09T09:45:00+08:00',breadth:{up:800,down:200,sampleCount:1000}};
  const evidence=api.marketPathEvidence(overview,{peakBreadth:peak,anchors:{'09:45':peak}},
    {tradeDate:'2026-10-08',limits:{upCodes:['600001']}},
    [{code:'600001',tradeDate:overview.tradeDate,source:'fixture',quoteObservedAt:overview.quoteObservedAt,changePct:-3}]);
  assert.equal(evidence.peakBreadthDropPp,50);
  assert.equal(evidence.anchorChangePp['09:45'],-50);
  assert.equal(evidence.anchorChangePp['11:30'],null);
  assert.equal(evidence.priorLimitUpPremium.averageChangePct,-3);
});

test('only same-date dated MA structures enter sector coverage and update live MA',()=>{
  const quote={code:'600001',price:12,tradeDate:'2026-10-09',changePct:1,amount:1e8};
  const structure={code:'600001',close:10,ma20:9,ma30:8,tradeDate:quote.tradeDate,source:'fixture'};
  const rows=api.mergeCurrentStructureQuotes([quote],{structures:[structure]});
  assert.equal(rows[0].ma20,9.1);
  assert.equal(api.sectorQuoteStats([quote.code],rows).structureCoverage,1);
  const stale=api.mergeCurrentStructureQuotes([quote],{structures:[{...structure,tradeDate:'2026-10-08'}]});
  assert.equal(api.sectorQuoteStats([quote.code],stale).structureCoverage,0);
  const future=api.mergeCurrentStructureQuotes([{...quote,quoteObservedAt:'2026-10-09T10:00:00+08:00'}],
    {structures:[{...structure,observedAt:'2026-10-09T10:01:00+08:00'}]}, {cutoffAt:'2026-10-09T10:00:00+08:00'});
  assert.equal(api.sectorQuoteStats([quote.code],future).structureCoverage,0);
  const afterClose=api.mergeCurrentStructureQuotes([{...quote,quoteObservedAt:'2026-10-09T15:00:00+08:00'}],
    {structures:[{...structure,observedAt:'2026-10-09T15:10:00+08:00'}]}, {cutoffAt:'2026-10-09T15:30:00+08:00'});
  assert.equal(api.sectorQuoteStats([quote.code],afterClose).structureCoverage,1);
});

test('overseas holiday returns compound finalized closes and reject unavailable future close',()=>{
  const rows=[{date:'2026-09-30',close:100,availableAt:'2026-10-01T04:00:00+08:00'},
    {date:'2026-10-01',close:110,availableAt:'2026-10-02T04:00:00+08:00'},
    {date:'2026-10-02',close:99,availableAt:'2026-10-03T04:00:00+08:00'},
    {date:'2026-10-05',close:999,availableAt:'2026-10-06T04:00:00+08:00'}];
  const value=api.summarizeOverseasWindow(rows,{fromAt:'2026-10-01T15:00:00+08:00',cutoffAt:'2026-10-05T10:00:00+08:00',code:'test',source:'fixture'});
  assert.equal(value.sessions,2);
  assert.equal(value.cumulativeChangePct,-1);
  assert.equal(value.maxCloseDrawdownPct,-10);
});

test('news first seen after historical cutoff cannot influence the past',()=>{
  const value=api.summarizeNews([{title:'测试公司业绩预增',publishedAt:'2026-10-09T09:00:00+08:00',
    firstSeenAt:'2026-10-09T11:00:00+08:00',link:'https://example.com'}], '',
    {subject:'测试公司',cutoffAt:'2026-10-09T10:00:00+08:00'});
  assert.equal(value.available,false);
});

test('minute confirmation waits a complete interval and never includes the future',()=>{
  const rows=api.completedFiveMinuteBars([{time:'202610091005',close:10},{time:'202610091010',close:11}],
    '2026-10-09T10:10:00+08:00');
  assert.equal(rows.length,1);
  assert.equal(rows[0].isFinal,true);
  assert.ok(rows[0].source);
});

test('historical trade rules require the matching finalized quote, never today names or limits',()=>{
  const bar={date:'2026-10-08',open:10,high:10.5,low:9.5,close:10,volume:100};
  const quote={tradeDate:bar.date,price:10,source:'fixture',upperLimit:11,lowerLimit:9,
    quoteObservedAt:'2026-10-08T15:00:00+08:00'};
  assert.equal(api.finalQuoteTradingEvidence(bar,quote,bar.date).tradeRules.verified,true);
  assert.deepEqual(api.finalQuoteTradingEvidence(bar,{...quote,tradeDate:'2026-10-09'},bar.date),{});
  assert.deepEqual(api.finalQuoteTradingEvidence(bar,{...quote,price:12},bar.date),{});
  assert.deepEqual(api.finalQuoteTradingEvidence(bar,{...quote,quoteObservedAt:'2026-10-08T14:00:00+08:00'},bar.date),{});
});

test('a concurrent stale refresh cannot resurrect a saved terminal plan',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'plan-terminal-'));
  const previous=process.env.STOCK_ASSISTANT_DATA_ROOT;
  process.env.STOCK_ASSISTANT_DATA_ROOT=root;
  t.after(()=>{
    if(previous === undefined) delete process.env.STOCK_ASSISTANT_DATA_ROOT;
    else process.env.STOCK_ASSISTANT_DATA_ROOT=previous;
    fs.rmSync(root,{recursive:true,force:true});
  });
  const blocked={code:'600001',track:'A',planId:'frozen',state:'blocked',currentPermission:'blocked',updatedAt:'2026-10-09T10:00:00+08:00'};
  await api.saveEntryPlanStates([blocked]);
  const stale={...blocked,state:'allowed',currentPermission:'allowed',updatedAt:'2026-10-09T10:01:00+08:00'};
  await api.saveEntryPlanStates([stale]);
  assert.equal(stale.state,'blocked');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'data','recommendation-plans.json'),'utf8')).active['600001:A'].state,'blocked');
});
