const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {nextTradingDay} = require('../lib/trade-time');
const {createThemeShadowManifest} = require('../lib/theme-shadow-experiments');

const api = require('../lib/strategy-experiments');
const rules = {commissionRate:.00025,minimumCommission:5,stampDutyRate:.0005,
  transferFeeRate:.00001,lotSize:100,tPlusOne:true,slippageBps:10};
const manifest = () => api.createStrategyExperimentManifest({freezeDate:'2026-09-10',modelVersion:'v26',rules});
const at = date => `${date}T15:05:00+08:00`;
function signal(code = '600001', extra = {}) {
  return {code,signalId:`s-${code}`,planId:`p-${code}`,track:'B',tradeDate:'2026-09-14',cutoffAt:at('2026-09-14'),
    entryPermission:'allowed',planState:'triggered',themes:['battery'],entryAssessment:{allowed:true},
    triggerEvent:{id:`e-${code}`,planId:`p-${code}`,type:'entry-allowed',verified:true,source:'recorded-5m',
      occurredAt:'2026-09-14T14:55:00+08:00',referencePrice:10},
    analysis:{tradePlan:{planId:`p-${code}`,frozenAt:'2026-09-14T09:00:00+08:00',enabled:true,
      entryLow:9.5,maxEntryPrice:10.5,entryExpiryDate:'2026-09-18',invalidationPrice:9,
      rewardRisk:2.5,targetEvidence:{status:'verified',source:'historical-resistance'},
      targets:[{price:13},{price:15},{price:17}],atr:1,horizon:'short',timeExitTradingDays:5}},
    marketRegime:{tradeDate:'2026-09-14',observedAt:at('2026-09-14'),riskOff:false,breadthTrend:'基本稳定'},
    sector:{tradeDate:'2026-09-14',observedAt:at('2026-09-14'),participation:{coverage:.8,memberCount:20},
      shadowRotation:{tradeDate:'2026-09-14',observedAt:at('2026-09-14'),phase:'扩散确认'}},...extra};
}
function bar(date, code = '600001', extra = {}) {
  return {code,tradeDate:date,source:'recorded-daily',adjustment:'none',isFinal:true,open:10,high:10.4,low:9.6,close:10.2,
    volume:100000,suspended:false,lowerLimit:8,upperLimit:18,
    tradeRules:{verified:true,source:'historical-exchange',tradeDate:date,tPlusOne:true},...extra};
}
function position(extra = {}) {
  return {quantity:1000,initialQuantity:1000,costPrice:10.1,weightedCostPrice:10.1,lotSize:100,
    lots:[{tradeDate:'2026-09-14',remaining:1000}],...extra};
}
const plan = () => signal().analysis.tradePlan;
const replay = (signals, prices, extra = {}) => api.replayStrategyExperiments({manifest:manifest(),signals,prices,
  asOfDate:'2026-09-22',...extra});

test('manifest is deeply frozen, deterministic and rejects implicit transaction assumptions', () => {
  assert.equal(typeof api.createStrategyExperimentManifest,'function');
  const first = manifest();
  assert.deepEqual(first,manifest());
  assert.ok(Object.isFrozen(first.rules));
  assert.ok(Object.isFrozen(first.experiments));
  assert.equal(first.rules.maxSingleWeight,.2);
  assert.equal(first.rules.maxGrossWeight,.8);
  assert.equal(first.rules.maxThemeWeight,.4);
  assert.equal(first.promotionAllowed,false);
  assert.throws(() => api.createStrategyExperimentManifest({freezeDate:'2026-09-10',modelVersion:'v26',rules:{...rules,slippageBps:undefined}}));
  assert.throws(() => api.createStrategyExperimentManifest({freezeDate:'2026-09-10',modelVersion:'v26',rules:{...rules,tPlusOne:false}}));
});

test('filters are independent; unknown sector/date/coverage and cutoff never pass', () => {
  const item = signal();
  const evaluate = (row = item, extra = {}) => api.evaluateStrategyExperiments(row,{tradeDate:row.tradeDate,
    cutoffAt:row.cutoffAt,marketRegime:row.marketRegime,sector:row.sector,...extra});
  assert.deepEqual(evaluate().map(row=>row.status),['pass','pass','pass','pass','pass']);
  assert.equal(evaluate(item,{marketRegime:{...item.marketRegime,riskOff:true}})[1].status,'fail');
  assert.equal(evaluate(item,{marketRegime:{...item.marketRegime,breadthTrend:'明显走弱'}})[1].status,'fail');
  assert.equal(evaluate(item,{marketRegime:{...item.marketRegime,observedAt:undefined}})[1].status,'unknown');
  assert.equal(evaluate(item,{marketRegime:{...item.marketRegime,shadowPath:{peakBreadthDropPp:10}}})[1].status,'fail');
  assert.equal(evaluate(item,{marketRegime:{...item.marketRegime,shadowPath:{status:'unknown'}}})[1].status,'unknown');
  assert.equal(evaluate(item,{sector:{...item.sector,tradeDate:'2026-09-15'}})[2].status,'unknown');
  assert.equal(evaluate(item,{sector:{...item.sector,participation:{coverage:.2,memberCount:20}}})[2].status,'unknown');
  assert.equal(evaluate({...item,sector:undefined,rotationProfiles:[item.sector]})[2].status,'pass');
  assert.equal(evaluate({...item,triggerEvent:{...item.triggerEvent,occurredAt:'2026-09-15T10:00:00+08:00'}})[0].status,'unknown');
  assert.equal(evaluate({...item,entryPermission:'watch'})[0].status,'fail');
  assert.ok(evaluate().every(row=>row.shadowOnly && row.baselineId === 'baseline'));
});

test('H3 requires frozen genuine target, RR2 and expiry; H4 needs predeclared horizon', () => {
  const item = signal();
  const evaluate = tradePlan => api.evaluateStrategyExperiments({...item,analysis:{tradePlan}},
    {tradeDate:item.tradeDate,cutoffAt:item.cutoffAt,marketRegime:item.marketRegime,sector:item.sector});
  assert.equal(evaluate({...plan(),rewardRisk:1.8})[3].status,'fail');
  assert.equal(evaluate({...plan(),targetEvidence:{status:'missing'}})[3].status,'unknown');
  assert.equal(evaluate({...plan(),timeExitTradingDays:20})[4].status,'fail');
  assert.equal(evaluate({...plan(),frozenAt:'2026-09-14T15:00:00+08:00'})[0].status,'unknown');
});

test('runtime frozen plan objects take precedence; H3 pullback hypothesis cannot promote the baseline',()=>{
  const item=signal();
  const planned={...item,triggerEvent:undefined,decisionEvent:undefined,planId:undefined,entryPermission:'watch',
    entryAssessment:{allowed:false},analysis:{tradePlan:{enabled:false}},
    planState:{planId:item.planId,state:'allowed',tradePlan:plan(),decisionEvent:item.triggerEvent}};
  const shadow={...planned,entryPermission:'allowed',entryAssessment:{allowed:true}};
  const rows=api.evaluateStrategyExperiments(planned,{tradeDate:item.tradeDate,cutoffAt:item.cutoffAt,
    marketRegime:item.marketRegime,sector:item.sector,shadowEntry:shadow});
  assert.equal(rows[0].status,'fail');
  assert.equal(rows[3].status,'pass');
  assert.equal(planned.entryPermission,'watch');
});

test('ledger adapter preserves frozen input and timezone cutoffs for replay',()=>{
  const row=signal();
  const input=api.buildExperimentReplayInput([{recommendations:[{shadowDecisionInput:row},
    {shadowDecisionInput:{...row,cutoffAt:'2026-09-15T00:10:00+08:00'}}]}],
    new Map([[row.code,{source:'fixture',bars:[bar('2026-09-14')]}]]),{manifest:manifest(),asOfDate:'2026-09-14'});
  assert.equal(input.signals.length,1);
  assert.deepEqual(input.signals[0].planState,row.planState);
  assert.equal(input.prices.length,1);
  assert.equal(api.evaluateShadowExit(position(),plan(),{...bar('2026-09-15'),adjustment:'qfq'},
    {tradeDate:'2026-09-15',heldTradingDays:1}).status,'unknown');
});

test('exit uses per-lot T+1; gap stop uses open and ambiguous daily bar stops first', () => {
  const context = {tradeDate:'2026-09-15',heldTradingDays:1};
  const gap = bar(context.tradeDate,'600001',{open:8.5,low:8.2,high:13.2,close:9.5});
  const exit = api.evaluateShadowExit(position(),plan(),gap,context);
  assert.equal(exit.reason,'gap-stop');
  assert.equal(exit.price,8.5);
  assert.equal(exit.quantity,1000);
  assert.equal(api.evaluateShadowExit(position({lots:[{tradeDate:context.tradeDate,remaining:1000}]}),plan(),gap,context).status,'blocked');
  const mixed = position({lots:[{tradeDate:'2026-09-14',remaining:600},{tradeDate:context.tradeDate,remaining:400}]});
  assert.equal(api.evaluateShadowExit(mixed,plan(),gap,context).quantity,600);
  const ambiguous = bar(context.tradeDate,'600001',{high:14,low:8.8});
  assert.equal(api.evaluateShadowExit(position(),plan(),ambiguous,context).reason,'ambiguous-stop-first');
  assert.equal(api.evaluateShadowExit(position(),plan(),ambiguous,context).price,9);
});

test('exit blocks suspension/limit and incomplete/wrong date; protects actual weighted cost only after target', () => {
  const context = {tradeDate:'2026-09-15',heldTradingDays:1};
  for (const extra of [{suspended:true},{open:8,high:8,low:8,close:8}]) {
    assert.equal(api.evaluateShadowExit(position(),plan(),bar(context.tradeDate,'600001',extra),context).status,'blocked');
  }
  for (const extra of [{isFinal:false},{quoteDate:'2026-09-14'},{tradeRules:{verified:false}}]) {
    assert.equal(api.evaluateShadowExit(position(),plan(),bar(context.tradeDate,'600001',extra),context).status,'unknown');
  }
  const protectedPosition = position({quantity:700,firstTargetFilled:true,lots:[{tradeDate:'2026-09-14',remaining:700}]});
  const exit = api.evaluateShadowExit(protectedPosition,plan(),bar(context.tradeDate,'600001',{open:11,low:10.4,high:12,close:11}),context);
  assert.equal(exit.price,10.6);
  assert.equal(exit.reason,'cost-protection');
  const target = api.evaluateShadowExit(position(),plan(),bar(context.tradeDate,'600001',{high:14}),context);
  assert.equal(target.quantity,300);
  assert.equal(api.evaluateShadowExit(protectedPosition,plan(),bar(context.tradeDate,'600001',{high:16,low:11,open:12,close:14}),context).quantity,300);
  assert.equal(api.evaluateShadowExit(position(),plan(),bar(context.tradeDate),{...context,heldTradingDays:5}).reason,'time-exit');
});

test('replay is deterministic, records watches, deduplicates same-code A/B and caps cash/exposures', () => {
  const item = signal();
  const signals = [item,{...item,signalId:'B-copy',track:'A'},signal('600002'),signal('600003'),signal('600004'),
    signal('600005',{entryPermission:'watch'})];
  const prices = signals.flatMap(row=>[bar('2026-09-15',row.code),bar('2026-09-16',row.code)]);
  const result = replay(signals,prices);
  assert.deepEqual(result,replay(signals,prices));
  const baseline = result.variants[0];
  assert.ok(baseline.account.cash >= 0);
  assert.equal(baseline.account.positions.filter(row=>row.code === item.code).length,1);
  assert.ok(baseline.account.positions.every(row=>row.costValue <= 20000));
  assert.ok(baseline.account.positions.reduce((sum,row)=>sum+row.costValue,0) <= 40000);
  assert.ok(baseline.records.some(row=>row.reason === 'not-allowed' && row.status === 'not-executed'));
  assert.ok(baseline.records.some(row=>row.reason === 'risk-budget' && row.status === 'not-executed'));
  assert.ok(baseline.account.fills.every(row=>row.fees.total > 0));
  assert.ok(result.variants.every(row=>row.validation.A.status === 'pending' && !row.promotionAllowed));
});

test('replay compares actual baseline excess and H4 exit differences without inventing watch profits', () => {
  const item = signal();
  const prices = [bar('2026-09-15'),bar('2026-09-16','600001',{open:12,high:14,low:11,close:13}),
    bar('2026-09-17','600001',{open:11,high:12,low:10.2,close:11}),bar('2026-09-18'),bar('2026-09-21'),bar('2026-09-22')];
  const result = replay([item],prices);
  const baseline = result.variants.find(row=>row.id === 'baseline');
  const h4 = result.variants.find(row=>row.id === 'H4');
  assert.notEqual(h4.portfolioEquity,baseline.portfolioEquity);
  assert.equal(h4.excessVsBaseline,h4.netReturnPct-baseline.netReturnPct);
  assert.equal(replay([signal('600001',{entryPermission:'watch'})],prices).variants[0].coverage.executed,0);
  const weak = replay([signal('600001',{marketRegime:{...item.marketRegime,riskOff:true}})],prices);
  assert.equal(weak.variants.find(row=>row.id === 'H1').coverage.executed,0);
  assert.ok(weak.variants.find(row=>row.id === 'baseline').coverage.executed > 0);
});

test('missing next open, future trigger, invalid limits and late input remain unexecuted', () => {
  for (const prices of [[],[bar('2026-09-16')],[bar('2026-09-15','600001',{tradeRules:{verified:false}})],
    [bar('2026-09-15','600001',{open:11})]]) {
    assert.equal(replay([signal()],prices).variants[0].coverage.executed,0);
  }
  assert.equal(replay([signal('600001',{cutoffAt:'2026-09-23T15:05:00+08:00'})],[bar('2026-09-15')]).variants[0].coverage.executed,0);
});

test('post-entry plan revisions do not leak backwards and pre-freeze development signals are excluded', () => {
  const first = signal();
  const later = {...first,signalId:'later',tradeDate:'2026-09-16',cutoffAt:at('2026-09-16'),
    triggerEvent:{...first.triggerEvent,occurredAt:'2026-09-16T14:55:00+08:00'},
    analysis:{tradePlan:{...plan(),maxEntryPrice:10.4}}};
  const data = [bar('2026-09-15'),bar('2026-09-16')];
  assert.equal(replay([first,later],data).variants[0].coverage.executed,1);
  assert.equal(replay([first],data,{manifest:api.createStrategyExperimentManifest({freezeDate:'2026-09-15',modelVersion:'v26',rules})}).variants[0].coverage.executed,0);
});

test('missing valuation is unknown, not a zero or newly verified return', () => {
  const result = replay([signal()],[bar('2026-09-15')]);
  assert.equal(result.variants[0].portfolioEquity,null);
  assert.equal(result.variants[0].netReturnPct,null);
  assert.equal(result.variants[1].excessVsBaseline,null);
});

test('H5-H7 replay shares cash rules with a post-freeze theme baseline and never fills unknown decisions', () => {
  const themeManifest = createThemeShadowManifest({frozenAt:'2026-10-10T10:00:00+08:00',modelVersion:'v26'});
  const row = signal('600001',{tradeDate:'2026-10-12',cutoffAt:at('2026-10-12')});
  row.triggerEvent = {...row.triggerEvent,occurredAt:'2026-10-12T14:55:00+08:00'};
  row.analysis.tradePlan = {...row.analysis.tradePlan,frozenAt:'2026-10-12T09:00:00+08:00',entryExpiryDate:'2026-10-16'};
  row.intradayPlanState = {planId:'intraday-600001',currentPermission:'allowed',state:'allowed',
    tradePlan:{...row.analysis.tradePlan,planId:'intraday-600001'},decisionEvent:{...row.triggerEvent,
      id:'intraday-event',planId:'intraday-600001',source:'recorded-5m'}};
  row.shadowExperiments = ['H5','H6','H7'].map(id=>({id,version:themeManifest.version,
    status:id === 'H5' ? 'unknown' : id === 'H6' ? 'pass' : 'unknown',reasons:['frozen-decision']}));
  const prices = [bar('2026-10-13'),bar('2026-10-14')];
  const run = (signals,extra = {}) => replay(signals,prices,{asOfDate:'2026-10-14',themeManifest,...extra});
  const result = run([row]);
  const get = id => result.variants.find(variant=>variant.id === id);
  assert.equal(get('themeBaseline').coverage.executed,1);
  assert.equal(get('H5').coverage.executed,0);
  assert.equal(get('H6').coverage.executed,1,JSON.stringify(get('H6').records));
  assert.equal(get('H7').coverage.executed,0);
  assert.equal(get('H6').baselineId,'themeBaseline');
  assert.equal(get('H6').account.fills[0].orderId.startsWith('H6:600001|intraday-600001'),true);
  assert.equal(get('H6').validation.B.status,'pending');
  assert.equal(run([{...row,shadowExperiments:[]}]).variants.find(variant=>variant.id === 'H6').coverage.executed,0);
  const allPass = {...row,shadowExperiments:row.shadowExperiments.map(decision=>({...decision,status:'pass'}))};
  assert.equal(run([allPass]).variants.find(variant=>variant.id === 'H7').coverage.executed,1);
  assert.equal(run([{...allPass,intradayPlanState:null}]).variants.find(variant=>variant.id === 'H7').coverage.executed,0);
  assert.equal(run([{...row,tradeDate:'2026-10-09',cutoffAt:at('2026-10-09'),triggerEvent:{...row.triggerEvent,
    occurredAt:'2026-10-09T14:55:00+08:00'}}]).variants.find(variant=>variant.id === 'H6').coverage.executed,0);
});

test('declared 20/60-day exits, target remainder and overlapping theme labels stay bounded', () => {
  const context = {tradeDate:'2026-09-15',heldTradingDays:20};
  const swing = {...plan(),horizon:'swing',timeExitTradingDays:20};
  assert.equal(api.evaluateShadowExit(position(),swing,bar(context.tradeDate),context).reason,'time-exit');
  const long = {...plan(),horizon:'long',timeExitTradingDays:60};
  assert.equal(api.evaluateShadowExit(position(),long,bar(context.tradeDate),context).status,'hold');
  assert.equal(api.evaluateShadowExit(position(),long,bar(context.tradeDate),{...context,heldTradingDays:60}).reason,'time-exit');
  const remaining = position({quantity:400,firstTargetFilled:true,secondTargetFilled:true,
    lots:[{tradeDate:'2026-09-14',remaining:400}]});
  assert.equal(api.evaluateShadowExit(remaining,plan(),bar(context.tradeDate,'600001',{open:16,high:17.5,low:15,close:17}),
    {...context,heldTradingDays:1}).quantity,400);
  const signals = Array.from({length:8},(_,index)=>signal(`60000${index+1}`,{themes:[`theme-${index}`]}));
  const data = signals.flatMap(row=>[bar('2026-09-15',row.code),bar('2026-09-16',row.code)]);
  const result = replay(signals,data).variants[0];
  assert.ok(result.account.positions.reduce((sum,row)=>sum+row.costValue,0) < 80000);
  assert.ok(result.account.cash > 20000);
  const a = signal('600001',{themes:['a']});
  const b = {...a,track:'A',signalId:'b-label',themes:['b']};
  const combined = replay([a,b,signal('600002',{themes:['b']}),signal('600003',{themes:['b']})],data).variants[0];
  assert.deepEqual(combined.account.positions.find(row=>row.code === a.code).themes,['a','b']);
  assert.ok(combined.account.positions.filter(row=>row.themes.includes('b')).reduce((sum,row)=>sum+row.costValue,0) < 40000);
});

test('partial per-lot first-target sales finish the declared tranche before advancing', () => {
  const context = {tradeDate:'2026-09-15',heldTradingDays:1};
  const pos = position({quantity:900,firstTargetSoldQuantity:100,
    lots:[{tradeDate:'2026-09-14',remaining:900}]});
  const next = api.evaluateShadowExit(pos,plan(),bar(context.tradeDate,'600001',{open:12,low:11,high:14,close:13}),context);
  assert.equal(next.reason,'target-1');
  assert.equal(next.quantity,200);
});

test('validation requires prospective days and mature episodes separately per route and period', () => {
  const dates = ['2026-01-05'];
  while (dates.length < 65) dates.push(nextTradingDay(dates.at(-1)));
  const codes = Array.from({length:8},(_,index)=>`60000${index+1}`);
  const signals = dates.slice(0,40).flatMap((date,index)=>codes.flatMap(code=>{
    const row = signal(code,{quantity:1000,themes:[code],tradeDate:date,cutoffAt:at(date),signalId:`s-${code}-${date}`,planId:`p-${code}-${date}`});
    row.triggerEvent = {...row.triggerEvent,planId:row.planId,id:`e-${code}-${date}`,occurredAt:`${date}T14:55:00+08:00`};
    row.analysis.tradePlan = {...row.analysis.tradePlan,planId:row.planId,frozenAt:`${date}T09:00:00+08:00`,entryExpiryDate:dates[index+1]};
    return [row,{...row,track:'A',signalId:`a-${code}-${date}`}];
  }));
  const prices = dates.flatMap(date=>codes.map(code=>bar(date,code,{high:14})));
  const frozen = api.createStrategyExperimentManifest({freezeDate:dates[0],modelVersion:'v26',rules});
  const run = end => replay(signals,prices,{manifest:frozen,asOfDate:end});
  const early = run(dates[19]).variants[0].validation;
  assert.ok(early.B.matureEpisodes >= 30);
  assert.equal(early.B.newTradingDays,19);
  assert.equal(early.B.status,'pending');
  assert.equal(early.A.matureEpisodes,0);
  const mature = run(dates.at(-1));
  for (const variant of mature.variants.filter(row=>['baseline','H3','H4'].includes(row.id))) {
    assert.ok(variant.validation.A.matureEpisodes >= 30);
    assert.ok(variant.validation.B.matureEpisodes >= 30);
    assert.notEqual(variant.validation.B.status,'pending');
    assert.equal(variant.validation.B.periods[60].status,'pending');
    assert.equal(variant.promotionAllowed,false);
  }
  assert.equal(mature.variants[0].validation.B.checks.netExcessPositive,false);
});

test('CLI is offline, writes new output only, never overwrites input or existing output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'strategy-experiments-'));
  try {
    const input = path.join(dir,'input.json'), output = path.join(dir,'output.json');
    const bytes = JSON.stringify({manifest:manifest(),signals:[signal()],prices:[bar('2026-09-15')],asOfDate:'2026-09-22'});
    fs.writeFileSync(input,bytes);
    const script = path.join(__dirname,'../scripts/replay-strategy-experiments.cjs');
    const run = out => spawnSync(process.execPath,[script,'--input',input,'--out',out],{encoding:'utf8'});
    assert.equal(run(input).status,1);
    assert.equal(fs.readFileSync(input,'utf8'),bytes);
    assert.equal(run(output).status,0);
    assert.equal(JSON.parse(fs.readFileSync(output,'utf8')).promotionAllowed,false);
    assert.equal(run(output).status,1);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
