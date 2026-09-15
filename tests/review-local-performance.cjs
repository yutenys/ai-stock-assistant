const fs = require('node:fs');
const path = require('node:path');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { api, live } = require('./market-diagnostics.cjs');
const root = path.resolve(__dirname, '..');
const read = name => JSON.parse(fs.readFileSync(path.join(root, 'cache', name), 'utf8'));
const stateFile = path.join(root, 'data', 'user-state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : read('local-state-review.json');
async function main() {
  const snapshot = process.argv.includes('--snapshot') ? read('review-live-snapshot.json')
    : { ...await live.fetchTencentMarketSnapshot(), fetchedAt:new Date().toISOString() };
  const quoteFetchedAt = snapshot.fetchedAt || fs.statSync(path.join(root, 'cache', 'review-live-snapshot.json')).mtime.toISOString();
  if (!process.argv.includes('--snapshot')) fs.writeFileSync(path.join(root, 'cache', 'review-live-snapshot.json'), JSON.stringify(snapshot));
  const quotes = new Map(snapshot.quotes.map(row => [row.code, row]));
  const excluded = label => ['重点关注', 'personal'].includes(String(label).trim().toLowerCase());
  const favoriteOutcomes = (state.labels || []).flatMap(label => (label.stocks || []).map(stock => ({
    code:stock.code, label:label.name, favoriteBasePrice:stock.favoriteBasePrice,
    favoriteAddedAt:stock.favoriteAddedAt, price:stock.price,
    signal:stock.favoriteEntrySnapshot?.signal || '',
    signalScore:stock.favoriteEntrySnapshot?.signalScore ?? null,
    technicalScore:stock.favoriteEntrySnapshot?.technicalScore ?? null,
    holdingPeriod:stock.favoriteEntrySnapshot?.holdingPeriod || stock.holdingPeriod || '',
    benchmarkIndices:stock.favoriteEntrySnapshot?.benchmarkIndices || [],
    industryBenchmark:stock.favoriteEntrySnapshot?.industryBenchmark || null,
    recommendationModelVersion:stock.favoriteEntrySnapshot?.modelVersion || '',
    recommendationContext:stock.favoriteEntrySnapshot?.context || null
  })));
  const pricedOutcomes = api.mergeRecommendationOutcomeQuotes(favoriteOutcomes, snapshot.quotes);
  // Old positions cannot safely be attributed using their current label membership.
  const positions = (state.portfolio || []).map(position => {
    const price = quotes.get(position.code)?.price;
    return { code:position.code, name:position.name, quantity:position.quantity, cost:position.costPrice, price,
      floatingPnl:price > 0 ? (price - position.costPrice) * position.quantity : null,
      returnPct:price > 0 && position.costPrice > 0 ? (price / position.costPrice - 1) * 100 : null,
      realizedPnl:position.realizedPnl, attribution:'模拟账户诊断，不以当前标签反推入场归属' };
  });
  const eventLoop = monitorEventLoopDelay({resolution:20});
  eventLoop.enable();
  const startedAt = Date.now();
  const progress = [];
  const market = await api.fetchMarketOverviewInWorker({force:true, favoriteOutcomes}, update => {
    const row = { stage:update.stage, message:update.message, elapsedMs:Date.now() - startedAt };
    progress.push(row);
    console.log(JSON.stringify(row));
  });
  eventLoop.disable();
  const benchmarkedOutcomes = api.mergeRecommendationOutcomeBenchmarks(pricedOutcomes, market.indices, market.sectors);
  const profile = api.summarizeRecommendationOutcomes(benchmarkedOutcomes, {now:quoteFetchedAt,requireFreshQuote:true});
  const cohorts = (state.labels || []).filter(label => !excluded(label.name)).map(label => {
    const rows = benchmarkedOutcomes.filter(row => row.label === label.name);
    const stats = api.summarizeRecommendationOutcomes(rows, {now:quoteFetchedAt,requireFreshQuote:true});
    const earlyObservation = stats.immatureCount ? {
      ...api.summarizeRecommendationOutcomes(rows, {now:quoteFetchedAt,minimumAgeDays:0,requireFreshQuote:true}).overall,
      calibrationEligible:false
    } : null;
    return {label:label.name, ...stats.overall, immatureCount:stats.immatureCount, invalidCount:stats.invalidCount, earlyObservation};
  });
  const report = { fetchedAt:new Date().toISOString(), quoteFetchedAt, quoteTradeDate:snapshot.quotes[0]?.tradeDate,
    marketFetchedAt:market.fetchedAt, breadth:market.breadth, marketNews:market.newsContext, overseas:market.overseas,
    profile, cohorts, positions, simulatedTradeCount:state.simulatedTrades?.length || 0,
    totalFloatingPnl:positions.reduce((sum, row) => sum + (row.floatingPnl || 0), 0),
    progress, eventLoopMaxMs:eventLoop.max / 1e6, elapsedMs:Date.now() - startedAt,
    coverage:market.recommendationCoverage, errors:market.errors, warnings:market.warnings,
    recommendations:market.recommendations.map(row => ({code:row.code,name:row.name,industry:row.industry,signal:row.signal,score:row.signalScore,
      tier:row.recommendationTier,entry:row.entryAssessment?.status,contextRisks:row.entryAssessment?.contextRisks,
      rotationThemes:(row.rotationProfiles || []).map(profile=>profile.name)})),
    momentum:market.momentumRecommendations.map(row => ({code:row.code,name:row.name,industry:row.industry,score:row.signalScore,
      entry:row.entryAssessment?.status,contextRisks:row.entryAssessment?.contextRisks,
      rotationThemes:(row.rotationProfiles || []).map(profile=>profile.name)})) };
  fs.writeFileSync(path.join(root, 'cache', 'performance-review.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
