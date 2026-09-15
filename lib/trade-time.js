(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TradeTime = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  // SSE 2026 calendar: https://www.sse.com.cn/disclosure/dealinstruc/closed/
  const closures = {2026:[['01-01','01-03'],['02-15','02-23'],['04-04','04-06'],
    ['05-01','05-05'],['06-19','06-21'],['09-25','09-27'],['10-01','10-07']]};
  function clock(at = Date.now()) {
    const time = typeof at === 'number' ? at : Date.parse(at);
    if (!Number.isFinite(time)) return {date:'', minute:null};
    const date = new Date(time + 8 * 3600000);
    return {date:date.toISOString().slice(0,10), minute:date.getUTCHours()*60+date.getUTCMinutes()};
  }
  function isTradingDay(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return null;
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== date) return null;
    if ([0,6].includes(parsed.getUTCDay())) return false;
    const ranges = closures[date.slice(0,4)];
    if (!ranges) return null;
    return !ranges.some(([start,end]) => date.slice(5) >= start && date.slice(5) <= end);
  }
  function nextTradingDay(date) {
    let time = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(time)) return null;
    for (let i=0;i<370;i++) {
      time += 86400000;
      const next = new Date(time).toISOString().slice(0,10), open = isTradingDay(next);
      if (open === null) return null;
      if (open) return next;
    }
    return null;
  }
  function executionWindow(at = Date.now()) {
    const {date, minute} = clock(at), day = isTradingDay(date);
    const session = day === null ? 'unknown' : !day ? 'holiday' : minute < 570 ? 'preopen'
      : minute < 690 ? 'morning' : minute < 780 ? 'lunch' : minute < 900 ? 'afternoon' : 'closed';
    const tradable = ['morning','afternoon'].includes(session);
    const buyDate = day === null ? null : day && minute < 900 ? date : nextTradingDay(date);
    const sellDate = buyDate ? nextTradingDay(buyDate) : null;
    const labels = {unknown:'交易日历待更新',holiday:'休市',preopen:'开盘前',morning:'上午交易时段',lunch:'午间休市',afternoon:'下午交易时段',closed:'盘后'};
    return {date,session,tradable,buyDate,sellDate,label:labels[session],
      summary:buyDate && sellDate ? `最早买入 ${buyDate}${session === 'lunch' ? ' 13:00后' : ''}；若当日成交，最早卖出 ${sellDate}（T+1）。实际买入顺延，卖出日同步顺延。`
        : '交易日历待更新，最早买卖日期暂无法确认。',
      risk:'当日新买仓位不能当日卖出；止损触发也须等待可卖交易日，存在隔夜跳空风险。'};
  }
  function orderTimeError(order) {
    if (isTradingDay(order.tradeDate) !== true) return '休市或交易日历未确认，不能模拟成交';
    if (order.submittedAt) {
      const timing = executionWindow(order.submittedAt);
      if (!timing.tradable || timing.date !== order.tradeDate) return '仅支持交易日9:30-11:30、13:00-15:00模拟成交';
    }
    return '';
  }
  return {clock,isTradingDay,nextTradingDay,executionWindow,orderTimeError};
});
