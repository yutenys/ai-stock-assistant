const test=require('node:test');
const assert=require('node:assert/strict');
const {selectHistorySource}=require('../lib/history-source-selection');
test('one current bar does not suppress a full secondary history',async()=>{
  const rows=Array.from({length:30},(_,i)=>({date:`2026-10-${String(i+1).padStart(2,'0')}`,close:10}));
  rows.push({date:'2026-11-05',close:11});
  const result=await selectHistorySource({count:30,tradeDate:'2026-11-05',primary:async()=>({rows:rows.slice(-1),adjustment:'qfq'}),secondary:async()=>({rows,adjustment:'none'})});
  assert.equal(result.rows.length,31);assert.equal(result.adjustment,'none');
});
test('failed fallback retains primary and never joins two price bases',async()=>{
  const rows=[{date:'2026-11-05',close:11}];
  const result=await selectHistorySource({count:30,tradeDate:'2026-11-05',primary:async()=>({rows,adjustment:'qfq'}),secondary:async()=>{throw new Error('offline');}});
  assert.deepEqual(result.rows,rows);assert.equal(result.adjustment,'qfq');
});
test('future bars are excluded and all-empty providers fail explicitly',async()=>{
  await assert.rejects(selectHistorySource({count:30,tradeDate:'2026-11-05',primary:async()=>({rows:[{date:'2026-11-06'}]}),secondary:async()=>({rows:[]})}),/为空/);
});
