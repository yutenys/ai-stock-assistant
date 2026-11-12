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

function coverageComplete(coverage) {
  const rows=Array.isArray(coverage?.days) ? coverage.days : [];
  return new Set(rows.filter(row=>row?.date && row.date < coverage.tradeDate && row.source
    && row.memberRevision).map(row=>row.date)).size === 5;
}

function latestKnownAt(item,subtype) {
  const values=[item.limitTouchedAt,item.firstSealAt,item.evidenceAvailableAt,
    item.businessRelation?.firstSeenAt,item.businessRelation?.availableAt];
  if (subtype === 'late-capacity') values.push(item.capacityExpansion?.availableAt);
  const times=values.map(time).filter(value=>value !== null);
  return times.length === values.filter(Boolean).length ? Math.max(...times) : null;
}

function evaluateThemeFirstBoard(rows=[],{tradeDate='',cutoffAt='',recentEpisodes=[],historyCoverage=null,
  maxActive=3,maxNewPerDay=5}={}) {
  const cutoff=time(cutoffAt);
  const grouped=new Map();
  for (const row of rows) {
    const themeId=String(row?.themeId || '');
    if (!themeId) continue;
    if (!grouped.has(themeId)) grouped.set(themeId,[]);
    const code=String(row?.code || '');
    const existing=grouped.get(themeId).find(item=>String(item.code || '') === code);
    if (!existing) grouped.get(themeId).push(row);
    else if ((time(row.evidenceAvailableAt) ?? Infinity) < (time(existing.evidenceAvailableAt) ?? Infinity)) {
      grouped.get(themeId)[grouped.get(themeId).indexOf(existing)]=row;
    }
  }
  const groups=[];
  for (const [themeId,members] of grouped) {
    const pending=[];
    const verified=members.map(item=>{
      const seal=time(item.firstSealAt), touched=time(item.limitTouchedAt);
      const early=seal !== null && seal <= time(`${tradeDate}T10:00:00+08:00`);
      const subtype=early ? 'early-first-board' : 'late-capacity';
      const known=latestKnownAt(item,subtype);
      if (item.tradeDate !== tradeDate || item.previousLimitUp !== false) { pending.push(`${item.code}:前一交易日或交易日证据缺失`); return null; }
      if (seal === null || touched === null) { pending.push(`${item.code}:真实触板/首封时间缺失`); return null; }
      if (!early && (item.capacityExpansion?.verified !== true || !item.capacityExpansion?.source)) {
        pending.push(`${item.code}:午后容量扩散证据未核验`); return null;
      }
      if (cutoff === null || known === null || known > cutoff) { pending.push(`${item.code}:截止时点尚不可知`); return null; }
      if (item.businessRelation?.verified !== true || !item.businessRelation?.source) { pending.push(`${item.code}:题材业务关系未核验`); return null; }
      return {...item,subtype,knownAt:new Date(known).toISOString()};
    }).filter(Boolean);
    for (const subtype of ['early-first-board','late-capacity']) {
      const subtypeRows=verified.filter(item=>item.subtype === subtype).sort((a,b)=>time(a.knownAt)-time(b.knownAt));
      if (!subtypeRows.length) continue;
      const recent=recentEpisodes.some(item=>item?.themeId === themeId && item.subtype === subtype
        && item.status === 'observed' && withinPreviousTradingDays(item.tradeDate,tradeDate,5));
      const covered=coverageComplete({...historyCoverage,tradeDate});
      const reasons=[];
      if (!covered) reasons.push('最近5个完整交易日题材激活历史覆盖未确认');
      if (recent) reasons.push('最近5个交易日已有同子型激活episode，不属于新激活主题');
      if (subtypeRows.length < 3) reasons.push(`已核验${subtype === 'early-first-board' ? '早封首板' : '午后容量扩散'}仅${subtypeRows.length}只，未达到同簇3只`);
      const status=recent ? 'rejected' : covered && subtypeRows.length >= 3 ? 'observed' : 'data-pending';
      const eligibleAt=status === 'observed' ? subtypeRows.slice(0,3).map(item=>item.knownAt)
        .sort((left,right)=>time(right)-time(left))[0] : null;
      groups.push({themeId,subtype,status,eligibleAt,reasons:[...reasons,...pending],verifiedCount:subtypeRows.length,
        candidates:status === 'observed' ? subtypeRows.map(item=>({...item,route:'F',entryPermission:'shadow-only',
          recommendationTier:subtype === 'early-first-board' ? '题材早封首板研究观察' : '题材午后容量扩散研究观察',eligibleAt,
          earlySeal:subtype === 'early-first-board'})) : []});
    }
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
