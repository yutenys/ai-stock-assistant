'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('../lib/persistence');
const {
  classifyTradeDateCoverage,
  extractFundTradeDates,
  reconcileFundSnapshots
} = require('../lib/data-coverage-audit');

const root = path.resolve(__dirname, '..', 'data');
const tradeDate = process.argv.find(arg => arg.startsWith('--date='))?.slice(7) || '2026-11-05';
const targetDates = ['2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04', tradeDate];
const folder = path.join(root, 'minute-funds', tradeDate);

function countBy(rows, key = 'status') {
  return rows.reduce((counts, row) => {
    const value = row[key] || 'unknown';
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function historyPath(code) {
  return path.join(root, 'market-history', code.slice(0, 2), `${code}.json`);
}

async function readJson(file) {
  return JSON.parse(await fs.promises.readFile(file, 'utf8'));
}

async function tradedCodesFromHistory() {
  const codes = [];
  const historyRoot = path.join(root, 'market-history');
  for (const directory of await fs.promises.readdir(historyRoot, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const directoryPath = path.join(historyRoot, directory.name);
    for (const file of await fs.promises.readdir(directoryPath)) {
      if (!/^\d{6}\.json$/.test(file)) continue;
      const history = await readJson(path.join(directoryPath, file));
      const bar = (history.bars || []).find(row => row.date === tradeDate);
      if (bar && (Number(bar.volume) > 0 || Number(bar.amount) > 0)) codes.push(history.code || file.slice(0, 6));
    }
  }
  return [...new Set(codes)];
}

async function fetchJson(url, attempts = 2) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(12_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function pooled(items, task, concurrency = 3) {
  let cursor = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index], index);
    }
  }));
  return results;
}

function dailyFundUrl(code) {
  return 'https://push2.eastmoney.com/webguest/api/qt/stock/fflow/daykline/get?' + new URLSearchParams({
    secid: `${code.startsWith('6') ? '1' : '0'}.${code}`,
    klt: '101',
    lmt: '20',
    fields1: 'f1,f2,f3',
    fields2: 'f51,f52,f53,f54,f55,f56'
  });
}

async function resolveDailyCoverage(audit, recheck) {
  const recheckedByCode = new Map((recheck.daily || []).map(row => [row.code, row]));
  const incomplete = audit.daily.filter(row => !row.recentWindowComplete);
  return pooled(incomplete, async item => {
    const history = await readJson(historyPath(item.code));
    const bars = new Map((history.bars || []).map(bar => [bar.date, bar]));
    const priceCheck = recheckedByCode.get(item.code);
    const priceChecked = Boolean(priceCheck && !priceCheck.error);
    const externalPriceDates = new Set(targetDates.filter(date => priceChecked && !(priceCheck.remaining || []).includes(date)));
    let fundChecked = false;
    let fundDates = new Set();
    let fundError = null;
    try {
      const raw = await fetchJson(dailyFundUrl(item.code));
      const extracted = extractFundTradeDates(raw);
      if (!extracted.checked) throw new Error(`provider rc ${extracted.responseCode}`);
      fundDates = new Set(extracted.dates);
      fundChecked = true;
    } catch (error) {
      fundError = error.cause?.code || error.message;
    }

    const dates = targetDates.map(date => {
      const result = classifyTradeDateCoverage({
        date,
        bar: bars.get(date),
        priceSourceChecked: priceChecked,
        fundSourceChecked: fundChecked,
        priceSourceTraded: externalPriceDates.has(date),
        fundSourceTraded: fundDates.has(date)
      });
      return { date, ...result };
    });
    return {
      code: item.code,
      name: priceCheck?.name || '',
      dates,
      unresolved: dates.filter(row => row.status === 'missing' || row.status === 'unverified'),
      evidence: {
        localSource: history.source || '',
        priceSourceChecked: priceChecked,
        fundSourceChecked: fundChecked,
        fundError
      }
    };
  });
}

async function resolveMinuteCoverage(manifest, dailyRows, tradedCodes) {
  const dailyByCode = new Map(dailyRows.map(row => [row.code, row]));
  const manifestCodes = new Set(manifest.results.map(row => row.code));
  const failed = [
    ...manifest.results.filter(row => row.status === 'failed'),
    ...tradedCodes.filter(code => !manifestCodes.has(code)).map(code => ({ code, error: 'not-in-original-manifest' }))
  ];
  return pooled(failed, async item => {
    let bar = null;
    try {
      const history = await readJson(historyPath(item.code));
      bar = (history.bars || []).find(row => row.date === tradeDate) || null;
    } catch {}
    const local = classifyTradeDateCoverage({ date: tradeDate, bar });
    if (local.status === 'covered') {
      return { code: item.code, status: 'missing-native-minute-fund', reason: item.error || 'provider-empty' };
    }
    if (local.status === 'no-trade-observed') {
      return { code: item.code, status: 'no-trade-observed', reason: local.reason };
    }
    const daily = dailyByCode.get(item.code)?.dates.find(row => row.date === tradeDate);
    if (daily && ['no-trade-corroborated', 'pre-listing'].includes(daily.status)) {
      return { code: item.code, status: daily.status, reason: daily.reason };
    }
    return { code: item.code, status: 'unverified', reason: item.error || 'provider-empty' };
  });
}

async function reconcileFunds(audit) {
  const rows = [];
  for (const item of audit.funds) {
    if (!item.dailyRaw) continue;
    try {
      const minute = await readJson(path.join(folder, `${item.code}.json`));
      const last = minute.raw.data.klines.at(-1).split(',').slice(1).map(Number);
      const daily = item.dailyRaw.split(',').slice(1).map(Number);
      const result = reconcileFundSnapshots(last, daily);
      rows.push({ code: item.code, legacyStatus: item.semantics, ...result });
    } catch (error) {
      rows.push({ code: item.code, status: 'unverified', error: error.message });
    }
  }
  return rows;
}

async function main() {
  const audit = await readJson(path.join(folder, 'audit.json'));
  const recheck = await readJson(path.join(folder, 'gap-recheck.json'));
  const manifest = await readJson(path.join(folder, 'manifest.json'));
  const tradedCodes = await tradedCodesFromHistory();
  const daily = await resolveDailyCoverage(audit, recheck);
  const minute = await resolveMinuteCoverage(manifest, daily, tradedCodes);
  const reconciliations = await reconcileFunds(audit);
  const dailyDates = daily.flatMap(row => row.dates);
  const reconciliationCounts = countBy(reconciliations);
  const reconciliationExceptions = reconciliations.filter(row => row.status !== 'exact');
  const legacyMismatches = reconciliations.filter(row => row.legacyStatus === 'mismatch');
  const summary = {
    tradeDate,
    generatedAt: new Date().toISOString(),
    semantics: {
      daily: 'Only independently observed trading dates are required; zero-turnover and two-source-empty dates are not missing bars.',
      minute: 'Native intraday fund flow only. Price-volume proxies are not counted as fund history.',
      reconciliation: 'Exact deltas are preserved; <= CNY 200 absolute or <= 0.005% relative is provider precision, not an exact match.'
    },
    daily: {
      securitiesReviewed: daily.length,
      dateClassifications: countBy(dailyDates),
      securitiesUnresolved: daily.filter(row => row.unresolved.length).length,
      unresolvedDates: daily.reduce((sum, row) => sum + row.unresolved.length, 0)
    },
    minute: {
      tradedUniverse: tradedCodes.length,
      nativeFiles: manifest.results.filter(row => row.status === 'raw-validated').length,
      failedRequestsReviewed: minute.length,
      classifications: countBy(minute),
      historicalNativeMinuteStatus: 'unavailable-from-verified-registration-free-public-sources'
    },
    reconciliation: {
      ...reconciliationCounts,
      legacyMismatchesReviewed: legacyMismatches.length,
      legacyMismatchesRemaining: legacyMismatches.filter(row => row.status === 'mismatch' || row.status === 'unverified').length
    }
  };
  const result = { summary, daily, minute, reconciliationExceptions };
  await atomicWriteJson(path.join(folder, 'resolved-audit.json'), result);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
