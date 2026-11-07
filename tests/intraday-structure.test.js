const test = require('node:test');
const assert = require('node:assert/strict');
const {normalizeIntradayBars, analyzeRangeRetest60m} = require('../lib/intraday-structure');

const at = (date, time) => `${date}T${time}:00+08:00`;
const slots = [['09:30','10:30'],['10:30','11:30'],['13:00','14:00'],['14:00','15:00']];
// Tencent m60 10:30/11:30 labels at 11:20 and 141279+89618 hands vs quote ~231181 hands.
const contract = {timestampLabel:'end',source:'腾讯60分钟K线',adjustment:'raw',volumeUnit:'hand',observedAt:at('2026-10-09','15:01')};
const calendar = () => true;
const row = (stamp, volume=100) => [stamp,10,10,10.2,9.8,volume];

test('60m close/open labels use exchange slots, never lunch arithmetic; future last bar stays preview',()=>{
  const raw=[row('202610091030'),row('202610091130'),row('202610091400'),row('202610091500')];
  const result=normalizeIntradayBars(raw,{period:'hour60',sourceContract:{...contract,observedAt:at('2026-10-09','11:12')},
    cutoffAt:at('2026-10-09','11:12'),tradeCalendar:calendar});
  assert.deepEqual(result.bars.map(bar=>[bar.openedAt.slice(11,16),bar.closedAt.slice(11,16),bar.isFinal]),
    [['09:30','10:30',true],['10:30','11:30',false]]);
  const open=normalizeIntradayBars([row('202610091300')],{period:'hour60',
    sourceContract:{...contract,timestampLabel:'start',observedAt:at('2026-10-09','14:01')},cutoffAt:at('2026-10-09','14:01'),tradeCalendar:calendar});
  assert.equal(open.bars[0].closedAt,at('2026-10-09','14:00'));
  assert.equal(open.bars[0].isFinal,true);
});

test('normalization requires known time, unit, basis and valid calendar for final bars',()=>{
  const unknown=normalizeIntradayBars([row('202610091030')],{period:'hour60',
    sourceContract:{source:'fixture'},cutoffAt:at('2026-10-09','11:00'),tradeCalendar:calendar});
  assert.equal(unknown.bars.length,1);
  assert.equal(unknown.bars[0].isFinal,false);
  assert.equal(unknown.bars[0].closedAt,null);
  assert.ok(unknown.issues.some(issue=>issue.code==='unknown-contract'));
  const stale=normalizeIntradayBars([row('202610091030')],{period:'hour60',
    sourceContract:{...contract,observedAt:at('2026-10-09','10:29')},
    cutoffAt:at('2026-10-09','11:00'),tradeCalendar:calendar});
  assert.equal(stale.bars[0].isFinal,false);
  assert.ok(stale.issues.some(issue=>issue.code==='stale'));
  const unit=normalizeIntradayBars([row('202610091030')],{period:'hour60',
    sourceContract:{...contract,volumeUnit:'unknown',adjustment:'unknown'},
    cutoffAt:at('2026-10-09','11:00'),tradeCalendar:calendar});
  assert.equal(unit.bars[0].volume,100);
  assert.equal(unit.bars[0].volumeUnit,'unknown');
  assert.equal(unit.bars[0].adjustment,'unknown');
  assert.equal(analyzeRangeRetest60m(unit.bars,{cutoffAt:at('2026-10-09','11:00')}).state,'unknown');
  const hand=normalizeIntradayBars([row('202610091030',141279)],{period:'hour60',
    sourceContract:contract,cutoffAt:at('2026-10-09','11:00'),tradeCalendar:calendar});
  assert.equal(hand.bars[0].volume,14127900);
  assert.equal(hand.bars[0].rawVolume,141279);
  assert.equal(hand.bars[0].volumeUnit,'share');
});

test('duplicate and missing slots are reported and excluded from structural history',()=>{
  const bad=[row('202610091030'),row('202610091030'),row('202610091400'),
    ['202610091500',10,11,10,9,100]];
  const result=normalizeIntradayBars(bad,{period:'hour60',sourceContract:contract,
    cutoffAt:at('2026-10-09','15:01'),tradeCalendar:calendar});
  assert.deepEqual(result.bars.map(bar=>bar.closedAt.slice(11,16)),['14:00']);
  assert.ok(result.issues.some(issue=>issue.code==='duplicate'));
  assert.ok(result.issues.some(issue=>issue.code==='missing'));
  assert.ok(result.issues.some(issue=>issue.code==='invalid-ohlc'));
  assert.equal(result.bars[0].gapBefore,true);
});

test('out-of-order rows, missing cross-day slots and cached observation are visible',()=>{
  const raw=[row('202610091030'),row('202610081400')];
  const result=normalizeIntradayBars(raw,{period:'hour60',sourceContract:contract,
    cutoffAt:at('2026-10-09','15:01'),tradeCalendar:calendar});
  assert.ok(result.issues.some(value=>value.code==='out-of-order'));
  assert.ok(result.issues.some(value=>value.code==='missing'));
  assert.equal(result.bars.at(-1).gapBefore,true);
  const direct=normalizeIntradayBars([row('202610091030'),row('202610091130')],{
    period:'hour60',sourceContract:{timestampLabel:'end',volumeUnit:'hand',adjustment:'raw',source:'腾讯60分钟K线'},
    cutoffAt:at('2026-10-09','11:20'),tradeCalendar:calendar});
  assert.deepEqual(direct.bars.map(bar=>bar.isFinal),[true,false]);
});

function fixture() {
  const dates=[];
  for(let day=Date.parse('2026-08-03T00:00:00Z');dates.length<22;day+=86400000) {
    const date=new Date(day).toISOString().slice(0,10);
    if(new Date(day).getUTCDay()%6) dates.push(date);
  }
  const bars=[];
  for(const date of dates.slice(0,20)) for(let slot=0;slot<4;slot++) bars.push({
    tradeDate:date,openedAt:at(date,slots[slot][0]),closedAt:at(date,slots[slot][1]),
    open:10,high:10.2,low:9.8,close:10,volume:100,isFinal:true,
    source:'fixture',adjustment:'none',volumeUnit:'share'});
  const date=dates[20];
  const add=(slot,values)=>bars.push({tradeDate:date,openedAt:at(date,slots[slot][0]),
    closedAt:at(date,slots[slot][1]),open:values[0],high:values[1],low:values[2],close:values[3],
    volume:values[4],isFinal:true,source:'fixture',adjustment:'none',volumeUnit:'share'});
  add(0,[10.1,10.7,10.1,10.6,200]);
  add(1,[10.4,10.45,10.18,10.25,90]);
  return bars;
}

test('80 bars and 20 prior same-slot days; freeze departure and first qualified retest',()=>{
  const bars=fixture(), departure=analyzeRangeRetest60m(bars.slice(0,81),{cutoffAt:bars[80].closedAt});
  assert.equal(departure.state,'departed');
  assert.equal(departure.boxUpper,10.2);
  assert.equal(departure.volumeRatio,2);
  assert.equal(departure.volumeBasis,'same-slot-60m-20-trading-day-median');
  const retest=analyzeRangeRetest60m(bars,{cutoffAt:bars[81].closedAt,previousStructure:departure});
  assert.equal(retest.state,'retest-confirmed');
  assert.equal(retest.confirmationPrice,10.45);
  assert.equal(retest.boxUpper,departure.boxUpper);
  assert.equal(retest.departureAt,departure.departureAt);
  assert.equal(retest.structureReadyAt,bars[81].closedAt);
  assert.equal(retest.triggerTimeframe,'5-minute-completed');
  assert.equal(analyzeRangeRetest60m(bars,{cutoffAt:bars[80].closedAt}).state,departure.state);
});

test('missing baseline, incomplete bar, explosive volume and invalid retest cannot confirm',()=>{
  const bars=fixture();
  assert.equal(analyzeRangeRetest60m(bars.slice(0,79),{cutoffAt:bars[78].closedAt}).state,'unknown');
  assert.notEqual(analyzeRangeRetest60m(bars.slice(4),{cutoffAt:bars[80].closedAt}).state,'departed');
  assert.notEqual(analyzeRangeRetest60m(bars.map((bar,i)=>i===80?{...bar,isFinal:false}:bar),
    {cutoffAt:bars[80].closedAt}).state,'departed');
  assert.notEqual(analyzeRangeRetest60m(bars.map((bar,i)=>i===80?{...bar,volume:401}:bar),
    {cutoffAt:bars[80].closedAt}).state,'departed');
  const departed=analyzeRangeRetest60m(bars.slice(0,81),{cutoffAt:bars[80].closedAt});
  const broken=[...bars.slice(0,81),{...bars[81],low:9.9,close:10.3}];
  assert.equal(analyzeRangeRetest60m(broken,{cutoffAt:bars[81].closedAt,previousStructure:departed}).state,'invalid');
});

test('volume ratio boundaries are inclusive and an unknown unit never borrows the threshold',()=>{
  const bars=fixture();
  for (const [volume,expected] of [[149,'watch'],[150,'departed'],[400,'departed'],[401,'watch']]) {
    const data=bars.slice(0,81).map((bar,i)=>i===80?{...bar,volume}:bar);
    assert.equal(analyzeRangeRetest60m(data,{cutoffAt:data[80].closedAt}).state,expected);
  }
  const unknownBars=bars.slice(0,81).map(bar=>({...bar,volumeUnit:'unknown'}));
  assert.equal(analyzeRangeRetest60m(unknownBars,{cutoffAt:bars[80].closedAt}).state,'unknown');
  const adjusted=bars.slice(0,81).map(bar=>({...bar,adjustment:'qfq'}));
  assert.equal(analyzeRangeRetest60m(adjusted,{cutoffAt:bars[80].closedAt}).state,'departed');
  adjusted[80].adjustment='raw';
  assert.equal(analyzeRangeRetest60m(adjusted,{cutoffAt:bars[80].closedAt}).state,'unknown');
});

test('confirmed retest can fail later, unqualified first touch cannot be retried, and 8-bar deadline expires',()=>{
  const bars=fixture(), departure=analyzeRangeRetest60m(bars.slice(0,81),{cutoffAt:bars[80].closedAt});
  const day=bars[80].tradeDate;
  const next={...bars[81],openedAt:at(day,'13:00'),closedAt:at(day,'14:00')};
  assert.equal(analyzeRangeRetest60m([...bars,{...next,low:9.9}],
    {cutoffAt:next.closedAt}).state,'invalid');
  const failed={...bars[81],close:10.19};
  assert.equal(analyzeRangeRetest60m([...bars.slice(0,81),failed],
    {cutoffAt:failed.closedAt,previousStructure:departure}).state,'invalid');
  const later=[...bars,{...next,low:9.9}];
  assert.equal(analyzeRangeRetest60m(later,{cutoffAt:next.closedAt}).state,'invalid');
  const highBars=Array.from({length:9},(_,i)=>({...bars[81],tradeDate:`2026-09-${String(i+1).padStart(2,'0')}`,
    openedAt:at(`2026-09-${String(i+1).padStart(2,'0')}`,'09:30'),
    closedAt:at(`2026-09-${String(i+1).padStart(2,'0')}`,'10:30'),
    high:10.8,low:10.5,close:10.7}));
  assert.equal(analyzeRangeRetest60m([...bars.slice(0,81),...highBars],
    {cutoffAt:highBars[8].closedAt,previousStructure:departure}).state,'expired');
});

test('later data cannot revise an earlier cutoff or bypass a missing bar in the active window',()=>{
  const bars=fixture(), before=analyzeRangeRetest60m(bars.slice(0,81),{cutoffAt:bars[80].closedAt});
  const future={...bars[81],low:9.9};
  assert.deepEqual(analyzeRangeRetest60m([...bars.slice(0,81),future],{cutoffAt:bars[80].closedAt}),before);
  const missing=bars.slice(0,81).map((bar,i)=>i===50?{...bar,gapBefore:true}:bar);
  assert.equal(analyzeRangeRetest60m(missing,{cutoffAt:bars[80].closedAt}).state,'unknown');
});

test('失效的早期箱体不遮挡后来形成的新离开结构',()=>{
  const original=fixture();
  const bars=[...original.slice(0,81),{...original[81],low:9.6,close:9.9}];
  const dates=[];
  for(let day=Date.parse('2026-09-01T00:00:00Z');dates.length<21;day+=86400000) {
    if(new Date(day).getUTCDay()%6) dates.push(new Date(day).toISOString().slice(0,10));
  }
  for(const date of dates.slice(0,20)) for(const [opened,closed] of slots) bars.push({
    tradeDate:date,openedAt:at(date,opened),closedAt:at(date,closed),open:10,high:10.2,low:9.8,
    close:10,volume:100,isFinal:true,source:'fixture',adjustment:'none',volumeUnit:'share'});
  const date=dates[20];
  bars.push({tradeDate:date,openedAt:at(date,'09:30'),closedAt:at(date,'10:30'),
    open:10.1,high:10.7,low:10.1,close:10.6,volume:200,isFinal:true,
    source:'fixture',adjustment:'none',volumeUnit:'share'});
  const latest=analyzeRangeRetest60m(bars,{cutoffAt:bars.at(-1).closedAt});
  assert.equal(latest.state,'departed');
  assert.equal(latest.departureAt,bars.at(-1).closedAt);
});
