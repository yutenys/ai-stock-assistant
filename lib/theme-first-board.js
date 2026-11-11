'use strict';

const {nextTradingDay}=require('./trade-time');

function time(value) {
  const number=Date.parse(value || '');
  return Number.isFinite(number) ? number : null;
}

function withinPreviousTradingDays(date,tradeDate,count) {
  let current=date;
  for (let index=0;index<count && current;index++) {
    current=nextTradingDay(current);
    if (current === tradeDate) return true;
    if (current && current > tradeDate) return false;
  }
  return false;
}

function evaluateThemeFirstBoard(rows=[],{tradeDate='',cutoffAt='',recentEpisodes=[],historyCoverageComplete=false,
  maxActive=3,maxNewPerDay=5}={}) {
  const cutoff=time(cutoffAt);
  const grouped=new Map();
  for (const row of rows) {
    const themeId=String(row?.themeId || '');
    if (!themeId) continue;
    if (!grouped.has(themeId)) grouped.set(themeId,[]);
    grouped.get(themeId).push(row);
  }
  const groups=[];
  for (const [themeId,members] of grouped) {
    const recent=recentEpisodes.some(item=>item?.themeId === themeId && item.status === 'observed'
      && withinPreviousTradingDays(item.tradeDate,tradeDate,5));
    const pending=[];
    const verified=members.filter(item=>{
      const seal=time(item.firstSealAt), touched=time(item.limitTouchedAt);
      const known=time(item.evidenceAvailableAt || item.firstSealAt);
      if (item.tradeDate !== tradeDate || item.previousLimitUp !== false) { pending.push(`${item.code}:前一交易日或交易日证据缺失`); return false; }
      if (seal === null || touched === null) { pending.push(`${item.code}:真实触板/首封时间缺失`); return false; }
      if (cutoff === null || known === null || seal > cutoff || known > cutoff) { pending.push(`${item.code}:截止时点尚不可知`); return false; }
      if (item.businessRelation?.verified !== true || !item.businessRelation?.source) { pending.push(`${item.code}:题材业务关系未核验`); return false; }
      return true;
    }).sort((a,b)=>time(a.evidenceAvailableAt || a.firstSealAt)-time(b.evidenceAvailableAt || b.firstSealAt));
    const reasons=[];
    if (!historyCoverageComplete) reasons.push('最近5个完整交易日题材激活历史覆盖未确认');
    if (recent) reasons.push('最近5个交易日已有同口径激活episode，不属于新激活主题');
    if (verified.length < 3) reasons.push(`已核验首板仅${verified.length}只，未达到同簇3只`);
    const status=recent ? 'rejected' : historyCoverageComplete && verified.length >= 3 ? 'observed' : 'data-pending';
    const cluster=verified.slice(0,3);
    const eligibleAt=status === 'observed'
      ? cluster.map(item=>item.evidenceAvailableAt || item.firstSealAt)
        .sort((left,right)=>time(right)-time(left))[0]
      : null;
    groups.push({themeId,status,eligibleAt,reasons:[...reasons,...pending],verifiedCount:verified.length,
      candidates:status === 'observed' ? verified.map(item=>({...item,route:'F',entryPermission:'shadow-only',
        recommendationTier:'题材首板研究观察',eligibleAt,
        earlySeal:time(item.firstSealAt) <= time(`${tradeDate}T10:00:00+08:00`)})) : []});
  }
  const observed=groups.filter(group=>group.status === 'observed');
  const candidates=observed.flatMap(group=>group.candidates)
    .sort((left,right)=>time(left.eligibleAt)-time(right.eligibleAt)||String(left.code).localeCompare(String(right.code)))
    .slice(0,Math.max(0,Math.min(maxActive,maxNewPerDay)));
  const fallback=groups[0] || {status:'data-pending',eligibleAt:null,reasons:['没有题材首板证据'],candidates:[]};
  const reasons=[...new Set(groups.flatMap(group=>group.reasons))];
  return {schemaVersion:1,tradeDate,cutoffAt,status:observed.length ? 'observed'
    : groups.some(group=>group.status === 'data-pending') ? 'data-pending' : fallback.status,
  eligibleAt:observed.length === 1 ? observed[0].eligibleAt : null,candidates,groups,
  reasons:reasons.length ? reasons : fallback.reasons};
}

module.exports={evaluateThemeFirstBoard};
