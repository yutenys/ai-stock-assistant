const {orderTimeError} = require('./trade-time');

function finite(value) {
  if (!['number','string'].includes(typeof value) || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clone(account) {
  return JSON.parse(JSON.stringify(account));
}

function rulesError(rules) {
  for (const key of ['commissionRate','minimumCommission','stampDutyRate','transferFeeRate','lotSize']) {
    const value = finite(rules?.[key]);
    if (value === null) return `研究账户缺少交易规则：${key}`;
    if (value < 0 || (key === 'lotSize' && (!Number.isInteger(value) || value === 0))) return `研究账户交易规则无效：${key}`;
  }
  return '';
}

function createResearchAccount({accountId, initialCash, rules, riskBudget} = {}) {
  if (!accountId || !(finite(initialCash) > 0)) throw new Error('研究账户需要 accountId 和正数初始资金');
  const error = rulesError(rules);
  if (error) throw new Error(error);
  return {schemaVersion:1, accountId, initialCash:Number(initialCash), cash:Number(initialCash), positions:[], orders:[], fills:[], realizedPnl:0, rules:{...rules},
    ...(riskBudget ? {riskBudget:clone(riskBudget)} : {})};
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
}

function quoteUsable(quote) {
  return finite(quote?.price) > 0 && validDate(quote.tradeDate) && !quote.stale && !quote.isStale && !quote.cached && !quote.estimated && !quote.error
    && [quote.status, quote.quoteStatus].every(status => !status || ['fresh','live','final','ok','success'].includes(status));
}

function updatePositionLots(position, rules, tradeDate) {
  for (const lot of position.lots) {
    lot.costPrice = finite(lot.costPrice) ?? position.costPrice;
    lot.costValue = lot.costPrice * lot.remaining;
    lot.availableQuantity = validDate(tradeDate) && (!rules.tPlusOne || lot.tradeDate < tradeDate) ? lot.remaining : 0;
  }
  position.availableQuantity = position.lots.reduce((sum, lot) => sum + lot.availableQuantity, 0);
  position.costValue = position.lots.reduce((sum, lot) => sum + lot.costValue, 0);
  position.costPrice = position.quantity ? position.costValue / position.quantity : 0;
  position.weightedCostPrice = position.costPrice;
  return position;
}

function themes(row) {
  return Array.isArray(row?.themes) ? [...new Set(row.themes.filter(theme => typeof theme === 'string' && theme.trim()))] : [];
}

function riskError(account, order, cost, {riskBudget = account.riskBudget, portfolio} = {}) {
  if (!riskBudget || !portfolio || portfolio.tradeDate !== order.tradeDate || !Array.isArray(portfolio.positions)) return '';
  const equity = finite(portfolio.equity);
  const cash = finite(portfolio.cash);
  if (!(equity > 0) || cash === null || cash < 0) return '';
  const byCode = new Map();
  for (const row of portfolio.positions) {
    if (!/^\d{6}$/.test(String(row.code || '')) || !(finite(row.quantity) > 0)
      || !quoteUsable({...row,price:row.currentPrice}) || row.tradeDate !== order.tradeDate || row.quoteStatus !== 'fresh') return '';
    const value = Number(row.quantity) * Number(row.currentPrice);
    if (finite(row.marketValue) === null || Math.abs(row.marketValue - value) > 1e-6) return '';
    const existing = byCode.get(row.code);
    if (existing && Math.abs(existing.value - value) > 1e-6) return '';
    byCode.set(row.code, {value, themes:[...new Set([...(existing?.themes || []),...themes(row)])]});
  }
  const gross = [...byCode.values()].reduce((sum, row) => sum + row.value, 0);
  if (Math.abs(equity - cash - gross) > 1e-6 || !(equity > cost.total)) return '';
  const amount = Number(order.price) * Number(order.quantity);
  const current = byCode.get(order.code);
  const orderThemes = [...new Set([...(current?.themes || []),...themes(order)])];
  const values = {maxSingleWeight:(current?.value || 0) + amount, maxGrossWeight:gross + amount};
  if (orderThemes.length && [...byCode.values()].every(row => row.themes.length)) {
    values.maxThemeWeight = Math.max(...orderThemes.map(theme => amount + [...byCode].reduce((sum, [code,row]) =>
      sum + (code === order.code || row.themes.includes(theme) ? row.value : 0), 0)));
  }
  for (const [key, value] of Object.entries(values)) {
    const limit = finite(riskBudget[key]);
    if (limit !== null && limit >= 0 && limit <= 1 && value / (equity - cost.total) > limit) return `组合风险预算超限：${key}`;
  }
  return '';
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

function executeResearchOrder(account, order = {}, context = {}) {
  const next = clone(account);
  const previous = order.orderId && next.orders.find(item => item.orderId === order.orderId);
  if (previous) return previous.status === 'filled'
    ? {ok:true, account:next, fill:previous, replayed:true}
    : {ok:false, account:next, reason:previous.reason, replayed:true};
  const ruleError = rulesError(next.rules);
  if (ruleError) return rejected(next, order, ruleError);
  const side = order.side;
  const price = finite(order.price);
  const quantity = finite(order.quantity);
  const lotSize = Number(next.rules.lotSize);
  const starBoard = /^688\d{3}$/.test(String(order.code || ''));
  if (!['buy','sell'].includes(side)) return rejected(next, order, '交易方向无效');
  if (!(price > 0) || !(quantity > 0) || !Number.isInteger(quantity)) return rejected(next, order, '数量和价格必须为有效正数');
  if (!/^\d{6}$/.test(String(order.code || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(order.tradeDate || ''))) return rejected(next, order, '股票代码或交易日无效');
  if (starBoard) {
    const position = next.positions.find(item => item.code === order.code);
    if (quantity < 200 && !(side === 'sell' && position?.quantity === quantity)) return rejected(next, order, '科创板申报至少200股；不足200股的持仓须一次卖出');
  } else if (quantity % lotSize !== 0) return rejected(next, order, `数量必须为${lotSize}股整数倍`);
  const timeError = orderTimeError(order);
  if (timeError) return rejected(next, order, timeError);
  const amount = price * quantity;
  const cost = fees(amount, side, next.rules);
  if (side === 'buy') {
    if (next.cash < amount + cost.total) return rejected(next, order, '可用现金不足');
    const risk = riskError(next, order, cost, context);
    if (risk) return rejected(next, order, risk);
    let position = next.positions.find(item => item.code === order.code);
    if (!position) {
      position = {code:order.code, name:order.name || order.code, industry:order.industry || '行业待确认', quantity:0, costValue:0, lots:[]};
      next.positions.push(position);
    }
    updatePositionLots(position, next.rules, order.tradeDate);
    position.themes = [...new Set([...themes(position),...themes(order)])];
    position.quantity += quantity;
    position.costValue += amount + cost.total;
    position.costPrice = position.costValue / position.quantity;
    position.peakObservedPrice = Math.max(finite(position.peakObservedPrice) || 0,price);
    position.lots.push({tradeDate:order.tradeDate, quantity, remaining:quantity, price, costPrice:(amount + cost.total) / quantity});
    next.cash -= amount + cost.total;
  } else {
    const position = next.positions.find(item => item.code === order.code);
    if (!position || position.quantity < quantity) return rejected(next, order, '可卖持仓不足');
    updatePositionLots(position, next.rules, order.tradeDate);
    const availableLots = position.lots.filter(lot => !next.rules.tPlusOne || lot.tradeDate < order.tradeDate);
    if (availableLots.reduce((sum, lot) => sum + lot.remaining, 0) < quantity) return rejected(next, order, 'T+1：当日买入批次不可卖出');
    let remaining = quantity;
    let releasedCost = 0;
    for (const lot of availableLots) {
      const sold = Math.min(remaining, lot.remaining);
      releasedCost += sold * lot.costPrice;
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
  next.positions.forEach(position => updatePositionLots(position, next.rules, order.tradeDate));
  const fill = {...order, amount, fees:cost, status:'filled', filledAt:new Date().toISOString()};
  next.orders.push(fill);
  next.fills.push(fill);
  return {ok:true, account:next, fill};
}

function markResearchAccount(account, quotes = [], tradeDate = '') {
  const byCode = new Map(quotes.filter(item => item?.code).map(item => [String(item.code), item]));
  const positions = account.positions.map(position => {
    const quote = byCode.get(position.code);
    const requestedDate = validDate(tradeDate);
    const previousValid = finite(position.currentPrice) > 0 && validDate(position.tradeDate)
      && !['estimated','missing'].includes(position.quoteStatus) && (!requestedDate || position.tradeDate <= tradeDate);
    const usable = quoteUsable(quote) && (!requestedDate || quote.tradeDate <= tradeDate)
      && (!previousValid || (quote.tradeDate >= position.tradeDate && (!requestedDate || quote.tradeDate === tradeDate)));
    const costPrice = finite(position.costPrice);
    const price = usable ? Number(quote.price) : previousValid ? Number(position.currentPrice) : costPrice > 0 ? costPrice : null;
    const marketValue = price === null ? null : price * position.quantity;
    const quoteStatus = usable && requestedDate && quote.tradeDate === tradeDate ? 'fresh' : usable || previousValid ? 'stale' : price !== null ? 'estimated' : 'missing';
    const date = usable ? quote.tradeDate : previousValid ? position.tradeDate : '';
    const peakObservedPrice = usable && quoteStatus === 'fresh'
      ? Math.max(finite(position.peakObservedPrice) || 0,price) : position.peakObservedPrice;
    return updatePositionLots({...position, lots:position.lots.map(lot => ({...lot})), currentPrice:price,
      peakObservedPrice,marketValue,quoteStatus,tradeDate:date}, account.rules, tradeDate);
  });
  const marketValue = positions.reduce((sum, item) => sum + (item.marketValue || 0), 0);
  const equity = account.cash + marketValue;
  const groups = new Map();
  for (const position of positions) {
    const industry = position.industry || '行业待确认';
    groups.set(industry, (groups.get(industry) || 0) + (position.marketValue || 0));
  }
  const byIndustry = [...groups].map(([industry, value]) => ({industry, value, weight:equity > 0 ? value / equity : 0})).sort((a,b)=>b.value-a.value);
  const missingQuotes = positions.filter(position => position.quoteStatus !== 'fresh').map(position => ({
    code:position.code,lastTradeDate:position.tradeDate || '',status:position.quoteStatus
  }));
  const valuationStatus = missingQuotes.length ? 'partial' : 'complete';
  const feesPaid = (account.fills || []).reduce((sum,fill) => sum + (finite(fill.fees?.total) || 0),0);
  const finalQuotes = positions.every(position => byCode.get(position.code)?.isFinal === true);
  const history = [...(account.equityHistory || [])];
  if (validDate(tradeDate) && valuationStatus === 'complete' && finalQuotes) {
    const snapshot = {tradeDate,equity,cash:account.cash,marketValue,realizedPnl:account.realizedPnl,
      unrealizedPnl:equity - account.initialCash - account.realizedPnl,feesPaid};
    const index = history.findIndex(row => row.tradeDate === tradeDate);
    if (index >= 0) history[index] = snapshot;
    else history.push(snapshot);
    history.sort((a,b) => a.tradeDate.localeCompare(b.tradeDate));
  }
  const previous = history.filter(row => row.tradeDate < tradeDate).at(-1);
  let peak = account.initialCash, maxDrawdownPct = 0;
  for (const row of history) {
    peak = Math.max(peak,row.equity);
    maxDrawdownPct = Math.max(maxDrawdownPct,peak > 0 ? (peak-row.equity)/peak*100 : 0);
  }
  return {...account, positions, marketValue, equity, unrealizedPnl:equity - account.initialCash - account.realizedPnl,
    feesPaid,valuationStatus,finalized:finalQuotes,missingQuotes,equityHistory:history,
    dayPnl:valuationStatus === 'complete' && finalQuotes && previous ? equity-previous.equity : null,
    maxDrawdownPct:history.length > 1 ? maxDrawdownPct : null,
    concentration:{byIndustry, largestIndustryWeight:byIndustry[0]?.weight || 0}, markedAt:new Date().toISOString(), tradeDate};
}

module.exports = {createResearchAccount, executeResearchOrder, markResearchAccount};
