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

test('研究账户按最新可用报价计算真实权益和集中度', () => {
  let account = createResearchAccount({accountId:'r-1', initialCash:100000, rules});
  account = executeResearchOrder(account, {side:'buy', code:'600001', price:10, quantity:5000, tradeDate:'2026-09-14', industry:'半导体'}).account;
  const marked = markResearchAccount(account, [{code:'600001',price:12,industry:'半导体'}], '2026-09-15');
  assert.ok(marked.equity > 109000);
  assert.ok(marked.concentration.byIndustry[0].weight > .5);
});
