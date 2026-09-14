function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clone(account) {
  return JSON.parse(JSON.stringify(account));
}

function createResearchAccount({accountId, initialCash, rules} = {}) {
  if (!accountId || !(finite(initialCash) > 0)) throw new Error('研究账户需要 accountId 和正数初始资金');
  for (const key of ['commissionRate','minimumCommission','stampDutyRate','transferFeeRate','lotSize']) {
    if (finite(rules?.[key]) === null) throw new Error(`研究账户缺少交易规则：${key}`);
  }
  return {schemaVersion:1, accountId, initialCash:Number(initialCash), cash:Number(initialCash), positions:[], orders:[], fills:[], realizedPnl:0, rules:{...rules}};
}

function fees(amount, side, rules) {
  const commission = Math.max(rules.minimumCommission, amount * rules.commissionRate);
  const stampDuty = side === 'sell' ? amount * rules.stampDutyRate : 0;
  const transferFee = amount * rules.transferFeeRate;
  return {commission, stampDuty, transferFee, total:commission + stampDuty + transferFee};
}

function rejected(account, order, reason) {
  const next = clone(account);
  next.orders.push({...order, status:'rejected', reason, recordedAt:new Date().toISOString()});
  return {ok:false, reason, account:next};
}

function executeResearchOrder(account, order = {}) {
  const next = clone(account);
  const side = order.side;
  const price = finite(order.price);
  const quantity = finite(order.quantity);
  const lotSize = next.rules.lotSize;
  if (!['buy','sell'].includes(side)) return rejected(next, order, '交易方向无效');
  if (!(price > 0) || !(quantity > 0) || quantity % lotSize !== 0) return rejected(next, order, `数量必须为${lotSize}股整数倍且价格有效`);
  if (!/^\d{6}$/.test(String(order.code || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(order.tradeDate || ''))) return rejected(next, order, '股票代码或交易日无效');
  const amount = price * quantity;
  const cost = fees(amount, side, next.rules);
  if (side === 'buy') {
    if (next.cash < amount + cost.total) return rejected(next, order, '可用现金不足');
    let position = next.positions.find(item => item.code === order.code);
    if (!position) {
      position = {code:order.code, name:order.name || order.code, industry:order.industry || '行业待确认', quantity:0, costValue:0, lots:[]};
      next.positions.push(position);
    }
    position.quantity += quantity;
    position.costValue += amount + cost.total;
    position.costPrice = position.costValue / position.quantity;
    position.lots.push({tradeDate:order.tradeDate, quantity, remaining:quantity, price});
    next.cash -= amount + cost.total;
  } else {
    const position = next.positions.find(item => item.code === order.code);
    if (!position || position.quantity < quantity) return rejected(next, order, '可卖持仓不足');
    const availableLots = position.lots.filter(lot => !next.rules.tPlusOne || lot.tradeDate < order.tradeDate);
    if (availableLots.reduce((sum, lot) => sum + lot.remaining, 0) < quantity) return rejected(next, order, 'T+1：当日买入批次不可卖出');
    let remaining = quantity;
    let releasedCost = 0;
    for (const lot of availableLots) {
      const sold = Math.min(remaining, lot.remaining);
      releasedCost += sold * position.costPrice;
      lot.remaining -= sold;
      remaining -= sold;
      if (!remaining) break;
    }
    position.quantity -= quantity;
    position.costValue = Math.max(0, position.costValue - releasedCost);
    next.cash += amount - cost.total;
    next.realizedPnl += amount - cost.total - releasedCost;
    if (!position.quantity) next.positions = next.positions.filter(item => item !== position);
  }
  const fill = {...order, amount, fees:cost, status:'filled', filledAt:new Date().toISOString()};
  next.orders.push(fill);
  next.fills.push(fill);
  return {ok:true, account:next, fill};
}

function markResearchAccount(account, quotes = [], tradeDate = '') {
  const byCode = new Map(quotes.map(item => [String(item.code), item]));
  const positions = account.positions.map(position => {
    const quote = byCode.get(position.code);
    const freshPrice = finite(quote?.price);
    const previousPrice = finite(position.currentPrice);
    const costPrice = finite(position.costPrice);
    const price = freshPrice ?? previousPrice ?? costPrice;
    const marketValue = price === null ? null : price * position.quantity;
    const quoteStatus = freshPrice !== null ? 'fresh' : previousPrice !== null ? 'stale' : costPrice !== null ? 'estimated' : 'missing';
    return {...position, currentPrice:price, marketValue, quoteStatus, tradeDate:freshPrice !== null ? tradeDate : position.tradeDate || ''};
  });
  const marketValue = positions.reduce((sum, item) => sum + (item.marketValue || 0), 0);
  const equity = account.cash + marketValue;
  const groups = new Map();
  for (const position of positions) {
    const industry = position.industry || '行业待确认';
    groups.set(industry, (groups.get(industry) || 0) + (position.marketValue || 0));
  }
  const byIndustry = [...groups].map(([industry, value]) => ({industry, value, weight:equity > 0 ? value / equity : 0})).sort((a,b)=>b.value-a.value);
  return {...account, positions, marketValue, equity, unrealizedPnl:equity - account.initialCash - account.realizedPnl,
    concentration:{byIndustry, largestIndustryWeight:byIndustry[0]?.weight || 0}, markedAt:new Date().toISOString(), tradeDate};
}

module.exports = {createResearchAccount, executeResearchOrder, markResearchAccount};
