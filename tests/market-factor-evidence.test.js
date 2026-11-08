'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {filterPointInTimeRows,analyzePricePath,assessRequestedRange,buildCoverageMatrix,markDuplicateSectorCapital}=require('../lib/market-factor-evidence');

test('point-in-time rows exclude future and unknown disclosures',()=>{
  const result=filterPointInTimeRows([{id:1,NOTICE_DATE:'2026-11-05 12:00:00'},{id:2,NOTICE_DATE:'2026-11-09 00:00:00'},{id:3}], '2026-11-06T15:00:00+08:00');
  assert.deepEqual(result.accepted.map(row=>row.id),[1]);
  assert.deepEqual(result.future.map(row=>row.id),[2]);
  assert.deepEqual(result.unknown.map(row=>row.id),[3]);
});

test('price path keeps ordered gain and drawdown and breaks streak on flat day',()=>{
  const rows=[10,12,12,9,11,8].map((close,index)=>({date:`2026-10-${String(index+1).padStart(2,'0')}`,open:close,high:close+1,low:close-1,close,volume:100+index}));
  const result=analyzePricePath(rows,{windows:[1,3]});
  assert.equal(result.longestUp.days,1);
  assert.equal(result.longestDown.days,1);
  assert.equal(result.maximumOrderedGain.returnPct,22.22);
  assert.equal(result.maximumOrderedDrawdown.returnPct,-33.33);
  assert.equal(result.returns[3].returnPct,-33.33);
  assert.equal(result.drawdowns[3],-33.33);
  assert.equal(result.runups[3],22.22);
});

test('requested range reports one returned row as partial instead of complete',()=>{
  assert.deepEqual(assessRequestedRange({requestedCount:10,rows:[{date:'2026-11-06'}]}),{
    requestedCount:10,requestedFrom:'',requestedTo:'',actualCount:1,actualFrom:'2026-11-06',actualTo:'2026-11-06',status:'partial',missingCount:9
  });
});

test('coverage matrix separates received and usable data and missing ledger',()=>{
  const matrix=buildCoverageMatrix({expectedUniverse:100,universeCount:100,quoteCount:100,quoteUsable:90,
    historyCount:80,historyUsable:70,ledgerAvailable:false});
  assert.equal(matrix.quotes.status,'partial');
  assert.equal(matrix.history.ratio,.7);
  assert.equal(matrix.recommendations.status,'missing');
});

test('identical sector capital rows are marked aliases instead of independent money',()=>{
  const rows=markDuplicateSectorCapital([
    {code:'A',name:'银行',boardType:'industry',mainNetInflow:10,mainNetPct:2,changePct:1,capitalTradeDate:'2026-11-06'},
    {code:'B',name:'银行Ⅱ',boardType:'concept',mainNetInflow:10,mainNetPct:2,changePct:1,capitalTradeDate:'2026-11-06'}
  ]);
  assert.equal(rows.filter(row=>row.capitalIndependent).length,1);
  assert.equal(rows.find(row=>row.code==='B').capitalDuplicateOf,'A');
});
