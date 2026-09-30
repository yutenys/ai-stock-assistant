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
  const marked = markResearchAccount(account, [{code:'600001',price:12,industry:'半导体'}], '2026-09-15');
  assert.ok(marked.equity > 109000);
  assert.ok(marked.concentration.byIndustry[0].weight > .5);
});

test('研究账户部分行情缺失时保留上次有效估值并标记过期', () => {
  let account = createResearchAccount({accountId:'r-1', initialCash:100000, rules});
  account = executeResearchOrder(account, {side:'buy', code:'600001', price:10, quantity:5000, tradeDate:'2026-09-14'}).account;
  account = markResearchAccount(account, [{code:'600001',price:12}], '2026-09-15');
  const previousEquity = account.equity;
  const marked = markResearchAccount(account, [], '2026-09-16');
  assert.equal(marked.equity, previousEquity);
  assert.equal(marked.positions[0].quoteStatus, 'stale');
  assert.equal(marked.positions[0].tradeDate, '2026-09-15');
});
