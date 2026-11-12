'use strict';

const {clock,isTradingDay,nextTradingDay} = require('./trade-time');

function finite(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number=Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value) {
  return Number.isFinite(value) ? Math.round((value+Number.EPSILON)*100)/100 : null;
}

function advance(date,days) {
  let result=date;
  for (let index=0;index<days && result;index++) result=nextTradingDay(result);
  return result;
}

function summary(rows,statuses=[]) {
  const values=rows.map(row=>finite(row?.returnPct)).filter(value=>value !== null).sort((a,b)=>a-b);
  const middle=Math.floor(values.length/2);
  return {
    count:rows.length,observed:values.length,
    missing:statuses.filter(value=>value === 'missing').length,
    immature:statuses.filter(value=>value === 'immature').length,
    incomparable:statuses.filter(value=>value === 'incomparable').length,
    notApplicable:statuses.filter(value=>value === 'not-applicable').length,
    averageReturnPct:values.length ? round(values.reduce((sum,value)=>sum+value,0)/values.length) : null,
    medianReturnPct:values.length ? round(values.length%2 ? values[middle] : (values[middle-1]+values[middle])/2) : null,
    positive:values.filter(value=>value>0).length,
    negative:values.filter(value=>value<0).length,
    flat:values.filter(value=>value===0).length,
    worstReturnPct:values.length ? round(values[0]) : null,
    bestReturnPct:values.length ? round(values.at(-1)) : null,
    averageExBestPct:values.length>1 ? round(values.slice(0,-1).reduce((sum,value)=>sum+value,0)/(values.length-1)) : null
  };
}

function episodeKey(row,baseDate) {
  const snapshot=row.favoriteEntrySnapshot || {};
  const planId=snapshot.planId || snapshot.plan?.planId || row.planId || '';
  if (planId) return `${row.code}:${baseDate}:${row.modelVersion || snapshot.modelVersion || 'unknown'}:${planId}`;
  return String(row.favoriteEventId || snapshot.favoriteEventId
    || `${row.code}:${baseDate}:${row.modelVersion || snapshot.modelVersion || 'unknown'}:${row.attribution || snapshot.sourceType || 'unknown'}`);
}

function validBars(history,asOfDate) {
  return (history?.bars || []).filter(row=>row?.isFinal === true && row.date <= asOfDate && finite(row.close)>0)
    .sort((a,b)=>a.date.localeCompare(b.date));
}

function adjustmentComparable(row,history,bar) {
  const reference=String(row.referenceAdjustment || row.favoriteEntrySnapshot?.adjustment || '').toLowerCase();
  const actual=String(bar?.adjustment || history?.adjustment || '').toLowerCase();
  return !reference || !actual || reference === actual;
}

function evaluateFavoriteBatchPerformance(favorites=[],histories=new Map(),{
  asOfDate=clock().date,horizons=[0,1,2,3,5,10,20]
}={}) {
  const deduped=new Map();
  let validInputs=0;
  for (const row of favorites) {
    const code=String(row?.code || '');
    const added=clock(row?.addedAt);
    if (!/^\d{6}$/.test(code) || !added.date || added.date>asOfDate || !(finite(row.referencePrice)>0)) continue;
    validInputs++;
    const key=episodeKey(row,added.date);
    const existing=deduped.get(key);
    if (existing) {
      existing.labels=[...new Set([...existing.labels,row.label || '未标记'])];
      continue;
    }
    const snapshot=row.favoriteEntrySnapshot || {};
    deduped.set(key,{episodeId:key,code,name:row.name || '',baseDate:added.date,
      addedAt:row.addedAt,referencePrice:finite(row.referencePrice),
      referenceAdjustment:row.referenceAdjustment || snapshot.adjustment || '',
      modelVersion:row.modelVersion || snapshot.modelVersion || 'unknown',
      attribution:row.attribution || snapshot.sourceType || 'unknown',
      planId:row.planId || snapshot.planId || snapshot.plan?.planId || '',
      phase:isTradingDay(added.date) !== true ? '非交易日' : added.minute>=900 ? '盘后' : '盘中',
      labels:[row.label || '未标记']});
  }

  const episodes=[...deduped.values()].map(row=>{
    const history=histories.get(row.code);
    const bars=validBars(history,asOfDate);
    const byDate=new Map(bars.map(bar=>[bar.date,bar]));
    const observations={};
    for (const horizon of horizons) {
      const target=horizon===0 ? row.baseDate : advance(row.baseDate,horizon);
      if (horizon===0 && row.phase !== '盘中') {
        observations[horizon]={status:'not-applicable',date:target,reason:'盘后或非交易日收藏不评价当日收盘'};
        continue;
      }
      if (!target || target>asOfDate) {
        observations[horizon]={status:'immature',date:target,reason:'目标交易日尚未到达'};
        continue;
      }
      const bar=byDate.get(target);
      if (!bar) {
        observations[horizon]={status:'missing',date:target,reason:'目标交易日最终收盘缺失'};
        continue;
      }
      if (!adjustmentComparable(row,history,bar)) {
        observations[horizon]={status:'incomparable',date:target,reason:'收藏基准与历史价格复权口径不同'};
        continue;
      }
      observations[horizon]={status:'observed',date:target,close:finite(bar.close),source:bar.source || history?.source || '',
        returnPct:round((finite(bar.close)/finite(row.referencePrice)-1)*100)};
    }
    const latest=bars.at(-1), previous=bars.at(-2);
    const comparable=latest && adjustmentComparable(row,history,latest);
    const current=comparable ? {
      status:'observed',date:latest.date,close:finite(latest.close),
      returnPct:round((finite(latest.close)/finite(row.referencePrice)-1)*100),
      todayChangePct:previous ? round((finite(latest.close)/finite(previous.close)-1)*100) : null
    } : {status:latest ? 'incomparable' : 'missing',date:latest?.date || '',returnPct:null,todayChangePct:null};
    return {...row,observations,current};
  });

  const horizonSummaries=Object.fromEntries(horizons.map(horizon=>{
    const observations=episodes.map(row=>row.observations[horizon]);
    return [horizon,summary(observations,observations.map(row=>row.status))];
  }));
  const cohortMap=new Map();
  for (const row of episodes) {
    const key=[row.baseDate,row.phase,row.modelVersion || 'unknown',row.attribution || 'unknown',row.labels[0]].join('|');
    if (!cohortMap.has(key)) cohortMap.set(key,{key,date:row.baseDate,phase:row.phase,
      modelVersion:row.modelVersion || 'unknown',attribution:row.attribution || 'unknown',label:row.labels[0],episodes:[]});
    cohortMap.get(key).episodes.push(row);
  }
  const cohorts=[...cohortMap.values()].map(cohort=>{
    const currentRows=cohort.episodes.map(row=>row.current);
    return {...cohort,count:cohort.episodes.length,current:summary(currentRows,currentRows.map(row=>row.status)),
      horizons:Object.fromEntries(horizons.map(horizon=>{
        const rows=cohort.episodes.map(row=>row.observations[horizon]);
        return [horizon,summary(rows,rows.map(row=>row.status))];
      }))};
  }).sort((a,b)=>b.date.localeCompare(a.date)||a.label.localeCompare(b.label));
  return {
    schemaVersion:1,asOfDate,horizonOrder:horizons,
    counts:{rawFavorites:favorites.length,validInputs,dedupedEpisodes:episodes.length,
      duplicates:validInputs-episodes.length,invalid:favorites.length-validInputs},
    horizons:horizonSummaries,cohorts,episodes,
    caveats:['收藏后价格表现不是实际成交收益','盘后收藏不回填当日收益','缺失、未成熟和不可比样本不按0计算']
  };
}

module.exports={evaluateFavoriteBatchPerformance};
