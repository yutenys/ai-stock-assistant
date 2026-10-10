const test = require('node:test');
const assert = require('node:assert/strict');

const {createResearchAccount, executeResearchOrder, markResearchAccount} = require('../lib/research-account');

const rules = {commissionRate:.00025, minimumCommission:5, stampDutyRate:.0005, transferFeeRate:.00001, lotSize:100, tPlusOne:true};

test('研究账户买入遵守整手、现金和显式费用', () => {
  const account = createResearchAccount({accountId:'r-1', initialCash:100000, rules});
  const result = executeResearchOrder(account, {side:'buy', code:'600001', price:10, quantity:1000, tradeDate:'2026-09-14'});
  assert.equal(result.ok, true);
  assert.equal(result.account.positions[0].quantity, 1000);
  assert.ok(result.account.cash < 90000);
  assert.equal(executeResearchOrder(result.account, {side:'buy',code:'600001',price:10,quantity:50,tradeDate:'2026-09-14'}).ok, false);
});

test('科创板买入至少200股且可逐股递增，旧仓和当日新仓分别遵守T+1', () => {
  let account = createResearchAccount({accountId:'star-lots',initialCash:100000,rules});
  const base = {code:'688005',price:10,tradeDate:'2026-09-14'};
  assert.equal(executeResearchOrder(account,{...base,side:'buy',quantity:100}).ok,false);
  account = executeResearchOrder(account,{...base,side:'buy',quantity:201}).account;
  assert.equal(account.positions[0].quantity,201);
  account = executeResearchOrder(account,{...base,side:'buy',quantity:200,tradeDate:'2026-09-15'}).account;
  assert.equal(markResearchAccount(account,[],'2026-09-15').positions[0].availableQuantity,201);
  const denied = executeResearchOrder(account,{...base,side:'sell',quantity:401,tradeDate:'2026-09-15'});
  assert.equal(denied.ok,false);
  assert.match(denied.reason,/T\+1/);
  const oldLot = executeResearchOrder(account,{...base,side:'sell',quantity:201,tradeDate:'2026-09-15'});
  assert.equal(oldLot.ok,true);
  assert.equal(oldLot.account.positions[0].quantity,200);
});

test('研究账户执行T+1并逐笔记录拒绝原因', () => {
  let account = createResearchAccount({accountId:'r-1', initialCash:100000, rules});
  account = executeResearchOrder(account, {side:'buy', code:'600001', price:10, quantity:1000, tradeDate:'2026-09-14'}).account;
  const sameDay = executeResearchOrder(account, {side:'sell', code:'600001', price:11, quantity:1000, tradeDate:'2026-09-14'});
  assert.equal(sameDay.ok, false);
  assert.match(sameDay.reason, /T\+1/);
  const nextDay = executeResearchOrder(sameDay.account, {side:'sell', code:'600001', price:11, quantity:1000, tradeDate:'2026-09-15'});
  assert.equal(nextDay.ok, true);
  assert.equal(nextDay.account.positions.length, 0);
  assert.ok(nextDay.account.realizedPnl > 900);
});

test('研究账户不能在午休盘后或休市日成交，也不能使用伪造交易日', () => {
  const account=createResearchAccount({accountId:'time',initialCash:100000,rules});
  const order={side:'buy',code:'600001',price:10,quantity:100,tradeDate:'2026-09-15'};
  for (const time of ['09:29:00','11:30:00','12:30:00','15:00:00']) {
    assert.equal(executeResearchOrder(account,{...order,submittedAt:`2026-09-15T${time}+08:00`}).ok,false);
  }
  assert.equal(executeResearchOrder(account,{...order,submittedAt:'2026-09-16T10:00:00+08:00'}).ok,false);
  assert.equal(executeResearchOrder(account,{...order,tradeDate:'2026-09-25'}).ok,false);
  const bought=executeResearchOrder(account,{...order,tradeDate:'2026-09-18',submittedAt:'2026-09-18T14:00:00+08:00'}).account;
  assert.equal(executeResearchOrder(bought,{...order,side:'sell',tradeDate:'2026-09-19'}).ok,false);
  assert.equal(executeResearchOrder(bought,{...order,side:'sell',tradeDate:'2026-09-21'}).ok,true);
});

test('研究账户按最新可用报价计算真实权益和集中度', () => {
  let account = createResearchAccount({accountId:'r-1', initialCash:100000, rules});
  account = executeResearchOrder(account, {side:'buy', code:'600001', price:10, quantity:5000, tradeDate:'2026-09-14', industry:'半导体'}).account;
  const marked = markResearchAccount(account, [{code:'600001',price:12,tradeDate:'2026-09-15',industry:'半导体'}], '2026-09-15');
  assert.ok(marked.equity > 109000);
  assert.ok(marked.concentration.byIndustry[0].weight > .5);
});

test('研究账户部分行情缺失时保留上次有效估值并标记过期', () => {
  let account = createResearchAccount({accountId:'r-1', initialCash:100000, rules});
  account = executeResearchOrder(account, {side:'buy', code:'600001', price:10, quantity:5000, tradeDate:'2026-09-14'}).account;
  account = markResearchAccount(account, [{code:'600001',price:12,tradeDate:'2026-09-15'}], '2026-09-15');
  const previousEquity = account.equity;
  const marked = markResearchAccount(account, [], '2026-09-16');
  assert.equal(marked.equity, previousEquity);
  assert.equal(marked.positions[0].quoteStatus, 'stale');
  assert.equal(marked.positions[0].tradeDate, '2026-09-15');
});

test('marks require positive dated quotes and retain the last valid mark without relabelling its date', () => {
  const account = executeResearchOrder(createResearchAccount({accountId:'marks',initialCash:100000,rules}),
    {side:'buy',code:'600001',price:10,quantity:100,tradeDate:'2026-09-14'}).account;
  const fresh = markResearchAccount(account, [{code:'600001',price:12,tradeDate:'2026-09-15'}], '2026-09-15');
  assert.equal(fresh.positions[0].quoteStatus, 'fresh');
  for (const quote of [
    {price:0}, {price:-1}, {price:Infinity}, {price:true}, {price:[13]}, {price:13,tradeDate:''},
    {price:13,tradeDate:'2026-02-30'}, {price:13,tradeDate:'2026-09-17'},
    {price:13,stale:true}, {price:13,isStale:true}, {price:13,status:'cached'},
    {price:13,quoteStatus:'stale'}, {price:13,status:'missing'},
    {price:11,tradeDate:'2026-09-14'}, {price:11,tradeDate:'2026-09-15'}
  ]) {
    const marked = markResearchAccount(fresh, [{code:'600001',tradeDate:'2026-09-16',...quote}], '2026-09-16');
    assert.equal(marked.positions[0].currentPrice, 12);
    assert.equal(marked.positions[0].quoteStatus, 'stale');
    assert.equal(marked.positions[0].tradeDate, '2026-09-15');
  }
  const older = markResearchAccount(account, [{code:'600001',price:11,tradeDate:'2026-09-14'}], '2026-09-16');
  assert.equal(older.positions[0].currentPrice, 11);
  assert.equal(older.positions[0].quoteStatus, 'stale');
  assert.equal(older.positions[0].tradeDate, '2026-09-14');
  const estimated = markResearchAccount(account, [{code:'600001',price:12}], '2026-09-15');
  assert.equal(estimated.positions[0].currentPrice, account.positions[0].costPrice);
  assert.equal(estimated.positions[0].quoteStatus, 'estimated');
  assert.equal(estimated.positions[0].tradeDate, '');
  assert.equal(markResearchAccount(estimated, [], '2026-09-16').positions[0].quoteStatus, 'estimated');
  assert.doesNotThrow(() => markResearchAccount(fresh, [null,undefined,{code:'600001',price:null}], '2026-09-16'));
});

test('orderId replay preserves cash, lots, fills and rejected orders', () => {
  const account = createResearchAccount({accountId:'replay',initialCash:100000,rules});
  const order = {orderId:'buy-1',side:'buy',code:'600001',price:10,quantity:100,tradeDate:'2026-09-14'};
  const first = executeResearchOrder(account, order);
  const replay = executeResearchOrder(first.account, {...order,price:20});
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.account, first.account);
  assert.deepEqual(replay.fill, first.fill);
  const denied = executeResearchOrder(first.account, {...order,orderId:'denied',quantity:50});
  const deniedReplay = executeResearchOrder(denied.account, {...order,orderId:'denied'});
  assert.equal(deniedReplay.ok, false);
  assert.deepEqual(deniedReplay.account, denied.account);
  const sale = executeResearchOrder(first.account, {...order,orderId:'sale',side:'sell',tradeDate:'2026-09-15'});
  assert.equal(sale.ok, true);
  assert.deepEqual(executeResearchOrder(sale.account, {...order,orderId:'sale',side:'sell',tradeDate:'2026-09-15'}).account, sale.account);
});

test('fees must be nonnegative and lot size a positive integer', () => {
  for (const key of ['commissionRate','minimumCommission','stampDutyRate','transferFeeRate']) {
    assert.throws(() => createResearchAccount({accountId:'bad',initialCash:1000,rules:{...rules,[key]:-1}}));
  }
  for (const lotSize of [0,-100,1.5]) {
    assert.throws(() => createResearchAccount({accountId:'bad',initialCash:1000,rules:{...rules,lotSize}}));
  }
  assert.doesNotThrow(() => createResearchAccount({accountId:'zero-fees',initialCash:1000,
    rules:{...rules,commissionRate:0,minimumCommission:0,stampDutyRate:0,transferFeeRate:0}}));
});

test('lots expose T+1 availability and fee-inclusive weighted cost after FIFO sales', () => {
  let account = createResearchAccount({accountId:'lots',initialCash:100000,rules});
  account = executeResearchOrder(account, {side:'buy',code:'600001',price:10,quantity:100,tradeDate:'2026-09-14'}).account;
  const firstCost = account.positions[0].costValue;
  account = executeResearchOrder(account, {side:'buy',code:'600001',price:20,quantity:100,tradeDate:'2026-09-15'}).account;
  const secondCost = account.positions[0].costValue - firstCost;
  const marked = markResearchAccount(account, [], '2026-09-15');
  assert.deepEqual(marked.positions[0].lots.map(lot => lot.availableQuantity), [100,0]);
  assert.equal(marked.positions[0].availableQuantity, 100);
  assert.equal(marked.positions[0].weightedCostPrice, (firstCost + secondCost) / 200);
  const sold = executeResearchOrder(marked, {side:'sell',code:'600001',price:21,quantity:100,tradeDate:'2026-09-15'});
  assert.equal(sold.ok, true);
  assert.ok(Math.abs(sold.account.positions[0].costValue - secondCost) < 1e-8);
  assert.ok(Math.abs(sold.account.positions[0].costPrice - secondCost / 100) < 1e-8);
  assert.equal(sold.account.positions[0].availableQuantity, 0);
  assert.equal(markResearchAccount(sold.account, [], '2026-09-16').positions[0].availableQuantity, 100);
});

test('optional frozen risk budgets deduplicate same-code A/B labels and themes', () => {
  const account = createResearchAccount({accountId:'risk',initialCash:100000,rules});
  const order = {side:'buy',code:'600001',price:10,quantity:100,tradeDate:'2026-09-15',themes:['battery','battery']};
  const row = {code:'600001',quantity:100,currentPrice:10,marketValue:1000,tradeDate:'2026-09-15',quoteStatus:'fresh',themes:['battery']};
  const portfolio = {cash:99000,equity:100000,tradeDate:'2026-09-15',positions:[{...row,label:'A'},{...row,label:'B'}]};
  assert.equal(executeResearchOrder(account,order,{portfolio,riskBudget:{maxSingleWeight:.021,maxThemeWeight:.021,maxGrossWeight:.021}}).ok, true);
  for (const key of ['maxSingleWeight','maxThemeWeight','maxGrossWeight']) {
    const denied = executeResearchOrder(account,order,{portfolio,riskBudget:{[key]:.019}});
    assert.equal(denied.ok, false);
    assert.match(denied.reason, new RegExp(key));
  }
  assert.equal(executeResearchOrder(account,order,{portfolio:{...portfolio,tradeDate:'2026-09-14'},riskBudget:{maxGrossWeight:.001}}).ok, true);
  assert.equal(executeResearchOrder(account,order,{riskBudget:{maxGrossWeight:.001}}).ok, true);
  assert.equal(executeResearchOrder(account,order).ok, true);
  assert.equal(executeResearchOrder(account,order,{portfolio,riskBudget:{maxGrossWeight:-1}}).ok, true);
});

test('shared theme exposure counts each stock once and skips constraints lacking evidence', () => {
  const riskBudget = {maxThemeWeight:.031};
  const account = createResearchAccount({accountId:'themes',initialCash:100000,rules,riskBudget});
  riskBudget.maxThemeWeight = 0;
  const order = {side:'buy',code:'600003',price:10,quantity:100,tradeDate:'2026-09-15',themes:['battery','lithium','battery']};
  const row = {code:'600001',quantity:100,currentPrice:10,marketValue:1000,tradeDate:'2026-09-15',quoteStatus:'fresh',themes:['battery','lithium']};
  const portfolio = {cash:98000,equity:100000,tradeDate:'2026-09-15',positions:[row,{...row,code:'600002'}]};
  const original = JSON.parse(JSON.stringify(portfolio));
  assert.equal(executeResearchOrder(account,order,{portfolio}).ok, true);
  assert.deepEqual(portfolio, original);
  assert.equal(executeResearchOrder(account,order,{portfolio,riskBudget:{maxThemeWeight:.029}}).ok, false);
  for (const invalid of [
    {...portfolio,equity:0}, {...portfolio,equity:99999},
    {...portfolio,positions:[{...row,quoteStatus:'stale'}]},
    {...portfolio,positions:[{...row,marketValue:0}]}
  ]) {
    assert.equal(executeResearchOrder(account,order,{portfolio:invalid,riskBudget:{maxGrossWeight:0}}).ok, true);
  }
  const unclassified = {...portfolio,positions:portfolio.positions.map(row => ({...row,themes:[]}))};
  assert.equal(executeResearchOrder(account,order,{portfolio:unclassified,riskBudget:{maxThemeWeight:0}}).ok, true);
  assert.equal(executeResearchOrder(account,order,{portfolio:unclassified,riskBudget:{maxGrossWeight:0}}).ok, false);
});

test('same-code manual purchases share a position and legacy lots preserve recorded cost', () => {
  let account = createResearchAccount({accountId:'legacy',initialCash:100000,rules});
  account = executeResearchOrder(account,{side:'buy',code:'600001',price:10,quantity:100,tradeDate:'2026-09-14',label:'A',themes:['battery']}).account;
  delete account.positions[0].lots[0].costPrice;
  delete account.positions[0].lots[0].costValue;
  const legacyCost = account.positions[0].costValue;
  const before = JSON.parse(JSON.stringify(account));
  const marked = markResearchAccount(account,[], '2026-09-15');
  assert.deepEqual(account,before);
  assert.equal(marked.positions[0].costValue,legacyCost);
  account = executeResearchOrder(account,{side:'buy',code:'600001',price:20,quantity:100,tradeDate:'2026-09-15',label:'B',themes:['battery','lithium']}).account;
  assert.equal(account.positions.length,1);
  assert.equal(account.positions[0].quantity,200);
  assert.deepEqual(account.positions[0].themes,['battery','lithium']);
});
