'use strict';

function classifyTradeDateCoverage({
  date,
  bar,
  listingDate,
  priceSourceChecked = false,
  fundSourceChecked = false,
  priceSourceTraded = false,
  fundSourceTraded = false
} = {}) {
  if (bar) {
    const volume = Number(bar.volume);
    const amount = Number(bar.amount);
    if (isTradedBar(bar)) {
      return { status: 'covered', reason: 'local-traded-bar' };
    }
    if (volume === 0 || amount === 0) {
      return { status: 'no-trade-observed', reason: 'local-zero-turnover-bar' };
    }
    return { status: 'covered', reason: 'local-bar' };
  }

  if (listingDate && date && date < listingDate) {
    return { status: 'pre-listing', reason: `listed-${listingDate}` };
  }

  if (priceSourceChecked && fundSourceChecked) {
    if (priceSourceTraded || fundSourceTraded) {
      return { status: 'missing', reason: 'external-trade-evidence' };
    }
    return { status: 'no-trade-corroborated', reason: 'price-and-fund-sources-empty' };
  }

  return { status: 'unverified', reason: 'insufficient-corroboration' };
}

function isTradedBar(bar) {
  return Boolean(bar) && (Number(bar.volume) > 0 || Number(bar.amount) > 0);
}

function reconcileFundSnapshots(left, right, {
  absoluteTolerance = 200,
  relativeTolerance = 0.00005
} = {}) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== 5 || right.length !== 5) {
    return { status: 'invalid', deltas: [] };
  }
  const leftValues = left.map(Number);
  const rightValues = right.map(Number);
  if (leftValues.some(value => !Number.isFinite(value)) || rightValues.some(value => !Number.isFinite(value))) {
    return { status: 'invalid', deltas: [] };
  }

  const deltas = leftValues.map((value, index) => value - rightValues[index]);
  const absoluteDeltas = deltas.map(Math.abs);
  const relativeDeltas = absoluteDeltas.map((delta, index) => delta / Math.max(Math.abs(rightValues[index]), 1));
  const exact = absoluteDeltas.every(delta => delta === 0);
  const withinPrecision = absoluteDeltas.every((delta, index) => (
    delta <= absoluteTolerance || relativeDeltas[index] <= relativeTolerance
  ));

  return {
    status: exact ? 'exact' : withinPrecision ? 'within-provider-precision' : 'mismatch',
    deltas,
    maxAbsoluteDelta: Math.max(...absoluteDeltas),
    maxRelativeDelta: Math.max(...relativeDeltas),
    absoluteTolerance,
    relativeTolerance
  };
}

function extractFundTradeDates(raw) {
  if (raw?.rc === 0) {
    return {
      checked: true,
      dates: (raw.data?.klines || []).map(line => String(line).split(',')[0]).filter(Boolean),
      responseCode: 0
    };
  }
  if (raw?.rc === 100 && !raw.data) {
    return { checked: true, dates: [], responseCode: 100 };
  }
  return { checked: false, dates: [], responseCode: raw?.rc ?? null };
}

module.exports = {
  classifyTradeDateCoverage,
  extractFundTradeDates,
  isTradedBar,
  reconcileFundSnapshots
};
