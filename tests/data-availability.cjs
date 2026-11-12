// Audit missing components against the collected universe; never fabricate bars or flows.
const fs = require('node:fs');
const path = require('node:path');
const {api, live} = require('./market-diagnostics.cjs');
const root = path.resolve(__dirname, '../cache/full-market-research');
async function run() {
  const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'snapshot.json'), 'utf8'));
  const records = snapshot.quotes.map(stock => JSON.parse(fs.readFileSync(path.join(root, `${stock.code}.json`), 'utf8')));
  const missing = {};
  for (const key of ['history', 'financial', 'funds']) {
    const failed = records.filter(row => !row[key]?.ok);
    missing[key] = {total:failed.length, withTurnover:failed.filter(row => row.stock.amount > 0).length,
      withoutTurnover:failed.filter(row => !(row.stock.amount > 0)).length};
  }
  const results = await api.settleWithConcurrency(records.filter(row => !row.history?.ok), 4, async record => {
    const sources = await Promise.allSettled([live.fetchTencentHistory(record.stock.code, 320), live.fetchSinaHistory(record.stock.code, 320)]);
    const evidence = sources.map((result, index) => {
      if (result.status === 'rejected') return {source:index === 0 ? 'Tencent' : 'Sina', error:String(result.reason)};
      const rows = result.value;
      let analysisError = null;
      try { api.analyzeHistory(rows); } catch (error) { analysisError = error.message; }
      return {source:index === 0 ? 'Tencent' : 'Sina', count:rows.length, firstDate:rows[0]?.date,
        lastDate:rows.at(-1)?.date, analysisError};
    });
    const usable = evidence.some(row => row.count >= 20 && !row.analysisError);
    const short = evidence.some(row => row.count > 0 && row.count < 20);
    return {code:record.stock.code, name:record.stock.name, hasTurnover:record.stock.amount > 0,
      status:usable ? 'recovered' : short ? 'insufficient-history' : 'unavailable', evidence};
  });
  const errors = results.filter(row => row.status === 'rejected');
  if (errors.length) throw new Error(`${errors.length} audit workers failed`);
  const history = results.map(row => row.value);
  const report = {checkedAt:new Date().toISOString(), snapshotTradeDate:records[0]?.tradeDate, missing, history,
    note:'Zero turnover is a snapshot observation, not a delisting determination. Fewer than 20 bars cannot support the existing strategy.'};
  fs.writeFileSync(path.join(root, 'data-availability.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
run().catch(error => {console.error(error); process.exitCode = 1;});
