const crypto = require('node:crypto');
const {isTradingDay} = require('./trade-time');

const slots = [['09:30','10:30'],['10:30','11:30'],['13:00','14:00'],['14:00','15:00']];
const stamp = (date, clock) => `${date}T${clock}:00+08:00`;
const number = value => value === '' || value === null || value === undefined ? NaN : Number(value);
const issue = (code, detail) => ({code,detail});

function normalizeIntradayBars(raw, {period, sourceContract = {}, cutoffAt, tradeCalendar} = {}) {
  const issues=[], bars=[];
  if (period !== 'hour60' || !Array.isArray(raw) || !Number.isFinite(Date.parse(cutoffAt)))
    return {bars,issues:[issue('invalid-input','hour60, raw rows and cutoffAt are required')]};
  const label=sourceContract.timestampLabel || sourceContract.timeLabel;
  const knownLabel=['start','end','open','close'].includes(label);
  const unit=sourceContract.volumeUnit;
  const knownUnit=['share','shares','hand','lots'].includes(unit);
  const adjustment=sourceContract.adjustment || 'unknown';
  const observedAt=sourceContract.observedAt || cutoffAt;
  const observed=Date.parse(observedAt), cutoff=Date.parse(cutoffAt);
  const calendar=typeof tradeCalendar === 'function' ? tradeCalendar
    : tradeCalendar?.isTradingDay?.bind(tradeCalendar) || isTradingDay;
  if (!knownLabel || !knownUnit || !['raw','none','qfq','hfq'].includes(adjustment) || !sourceContract.source)
    issues.push(issue('unknown-contract','timestamp label, volume unit, adjustment or source is unverified'));
  if (!Number.isFinite(observed) || observed > cutoff) issues.push(issue('stale','source observation time is unavailable at cutoff'));
  const counts=new Map(), parsed=[];
  let previousInputTime='';
  for (const rawRow of raw) {
    const time=String(Array.isArray(rawRow) ? rawRow[0] : rawRow?.time || '');
    const match=/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(time);
    if (!match) { issues.push(issue('invalid-time',time)); continue; }
    const date=`${match[1]}-${match[2]}-${match[3]}`, clock=`${match[4]}:${match[5]}`;
    const parsedDate=Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(parsedDate) || new Date(parsedDate).toISOString().slice(0,10)!==date) {
      issues.push(issue('invalid-time',time)); continue;
    }
    const slot=knownLabel ? slots.findIndex(pair=>pair[['start','open'].includes(label)?0:1]===clock) : -1;
    if (knownLabel && slot<0) { issues.push(issue('invalid-time',time)); continue; }
    if (previousInputTime && time<previousInputTime) issues.push(issue('out-of-order',time));
    previousInputTime=time;
    const openedAt=slot<0 ? null : stamp(date,slots[slot][0]);
    const closedAt=slot<0 ? null : stamp(date,slots[slot][1]);
    if (openedAt && Date.parse(openedAt)>cutoff) continue;
    if (!openedAt && Date.parse(stamp(date,clock))>cutoff) continue;
    const values=Array.isArray(rawRow)
      ? [rawRow[1],rawRow[3],rawRow[4],rawRow[2],rawRow[5]]
      : [rawRow.open,rawRow.high,rawRow.low,rawRow.close,rawRow.volume];
    const [open,high,low,close,rawVolume]=values.map(number);
    const key=`${date}:${slot<0?clock:slot}`;
    counts.set(key,(counts.get(key)||0)+1);
    if (![open,high,low,close,rawVolume].every(Number.isFinite) || low<=0 || rawVolume<0
      || high<Math.max(open,close,low) || low>Math.min(open,close)) {
      issues.push(issue('invalid-ohlc',time)); continue;
    }
    const trading=calendar(date);
    if (trading!==true) issues.push(issue(trading===false?'non-trading-day':'unknown-calendar',date));
    const final=knownLabel && trading===true && Number.isFinite(observed) && observed<=cutoff
      && observed>Date.parse(closedAt) && cutoff>Date.parse(closedAt);
    if (knownLabel && !final && Date.parse(closedAt)<=cutoff) issues.push(issue('stale',time));
    parsed.push({time,tradeDate:date,openedAt,closedAt,open,high,low,close,
      volume:knownUnit ? rawVolume*(['hand','lots'].includes(unit)?100:1) : rawVolume,
      rawVolume,volumeUnit:knownUnit?'share':'unknown',adjustment,source:sourceContract.source || '',
      observedAt:Number.isFinite(observed)?observedAt:null,isFinal:final,slot,key});
  }
  for (const [key,count] of counts) if (count>1) issues.push(issue('duplicate',key));
  parsed.sort((a,b)=>a.tradeDate.localeCompare(b.tradeDate) || a.slot-b.slot || a.time.localeCompare(b.time));
  let previous=null;
  for (const row of parsed) {
    if (counts.get(row.key)>1) continue;
    let gap=false;
    if (row.slot>0 && (!previous || previous.tradeDate!==row.tradeDate || previous.slot!==row.slot-1)) gap=true;
    if (previous && row.tradeDate===previous.tradeDate && row.slot>previous.slot+1) gap=true;
    if (previous && row.tradeDate>previous.tradeDate) {
      if (previous.slot<slots.length-1) gap=true;
      for (let day=Date.parse(`${previous.tradeDate}T00:00:00Z`)+86400000;
        day<Date.parse(`${row.tradeDate}T00:00:00Z`);day+=86400000) {
        if (calendar(new Date(day).toISOString().slice(0,10))===true) { gap=true; break; }
      }
    }
    if (gap) issues.push(issue('missing',row.time));
    const {slot,key,...bar}=row;
    bars.push({...bar,gapBefore:gap});
    previous=row;
  }
  return {bars,issues};
}

const unknown = reason => ({algorithmVersion:'range-retest-60m-v1',state:'unknown',reason});
const median = values => { const sorted=[...values].sort((a,b)=>a-b); return (sorted[9]+sorted[10])/2; };

function analyzeRangeRetest60m(bars, {cutoffAt, config = {}, previousStructure} = {}) {
  const cutoff=Date.parse(cutoffAt);
  if (!Array.isArray(bars) || !Number.isFinite(cutoff)) return unknown('invalid-input');
  const series=bars.filter(bar=>bar.isFinal===true && Number.isFinite(Date.parse(bar.closedAt))
    && Date.parse(bar.closedAt)<=cutoff).sort((a,b)=>Date.parse(a.closedAt)-Date.parse(b.closedAt)).slice(-320);
  if (series.length<80) return unknown('fewer-than-80-final-bars');
  const basis=series[0].adjustment, source=series[0].source;
  if (!['raw','none','qfq','hfq'].includes(basis) || !source || series.some(bar=>bar.adjustment!==basis
    || bar.source!==source || bar.volumeUnit!=='share' || !Number.isFinite(bar.volume)
    || !Number.isFinite(bar.high) || !Number.isFinite(bar.low) || !Number.isFinite(bar.close)))
    return unknown('incomparable-or-incomplete-bars');
  const result=previousStructure?.algorithmVersion==='range-retest-60m-v1' && previousStructure.departureAt
    ? {...previousStructure} : null;
  if (result && Date.parse(result.departureAt)>cutoff) return unknown('future-previous-structure');
  if (result && (result.basis!==basis || result.source!==source
    || series.some((bar,i)=>i>0 && bar.gapBefore && Date.parse(bar.closedAt)>Date.parse(result.departureAt))))
    return unknown('changed-basis-or-missing-bar');
  if (result && ['invalid','expired'].includes(result.state)) return result;
  if (result) return advance(result,series);
  let baselineMissing=false, latestTerminal=null;
  for (let i=80;i<series.length;i++) {
    if (series.slice(i-80,i+1).some((bar,n)=>n>0 && bar.gapBefore)) {
      baselineMissing=true; continue;
    }
    const prior=series.slice(i-12,i), bar=series[i];
    const upper=Math.max(...prior.map(row=>row.high)), lower=Math.min(...prior.map(row=>row.low));
    const tr=series.slice(i-14,i).map((row,n)=>{
      const priorClose=series[i-14+n-1]?.close ?? row.close;
      return Math.max(row.high-row.low,Math.abs(row.high-priorClose),Math.abs(row.low-priorClose));
    });
    const atr=tr.reduce((sum,value)=>sum+value,0)/14;
    const left=prior.slice(0,6), right=prior.slice(6);
    const overlap=Math.max(...left.map(row=>row.low),...right.map(row=>row.low))
      <=Math.min(...left.map(row=>row.high),...right.map(row=>row.high));
    if (!(atr>0 && (upper-lower)/atr<=3 && overlap && bar.close>upper+0.1*atr)) continue;
    const dates=[...new Set(series.slice(0,i).map(row=>row.tradeDate).filter(date=>date<bar.tradeDate))].slice(-20);
    const slot=bar.openedAt?.slice(11,16);
    const volumes=dates.map(date=>series.slice(0,i).find(row=>row.tradeDate===date && row.openedAt?.slice(11,16)===slot)?.volume);
    if (dates.length!==20 || volumes.some(value=>!Number.isFinite(value) || value<=0)) {
      baselineMissing=true; continue;
    }
    const volumeRatio=bar.volume/median(volumes);
    if (volumeRatio<1.5 || volumeRatio>4) continue;
    const evidence=[source,basis,bar.closedAt,lower,upper,atr,bar.close,bar.volume,volumes];
    const structure={algorithmVersion:'range-retest-60m-v1',state:'departed',source,basis,
      boxLower:lower,boxUpper:upper,atr,departureAt:bar.closedAt,departureVolume:bar.volume,
      volumeRatio,volumeBasis:'same-slot-60m-20-trading-day-median',
      invalidationPrice:upper-0.3*atr,retestConfirmedAt:null,confirmationPrice:null,
      structureReadyAt:null,triggerTimeframe:'5-minute-completed',expiresAt:null,
      evidenceHash:crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
      departureIndex:i};
    const observed=advance(structure,series);
    if (!['invalid','expired'].includes(observed.state)) return observed;
    latestTerminal=observed;
    const terminalAt=observed.invalidatedAt || observed.expiresAt;
    const terminalIndex=series.findIndex(row=>row.closedAt===terminalAt);
    if (terminalIndex>i) i=terminalIndex;
  }
  return latestTerminal || (baselineMissing ? unknown('missing-20-day-same-slot-volume-baseline')
    : {algorithmVersion:'range-retest-60m-v1',state:'watch'});
}

function advance(structure, bars) {
  const after=bars.filter(bar=>Date.parse(bar.closedAt)>Date.parse(structure.departureAt));
  let seen=0;
  for (const bar of after) {
    seen++;
    if (bar.low<structure.invalidationPrice) return {...structure,state:'invalid',invalidatedAt:bar.closedAt};
    if (structure.state==='retest-confirmed') continue;
    if (seen>8) return {...structure,state:'expired',expiresAt:after[7].closedAt};
    const touch=bar.low<=structure.boxUpper+0.2*structure.atr
      && bar.high>=structure.boxUpper-0.2*structure.atr;
    if (touch) {
      if (bar.close<structure.boxUpper || bar.volume>=structure.departureVolume)
        return {...structure,state:'invalid',invalidatedAt:bar.closedAt,reason:'first-retest-failed'};
      structure={...structure,state:'retest-confirmed',retestConfirmedAt:bar.closedAt,
        structureReadyAt:bar.closedAt,confirmationPrice:bar.high};
    }
  }
  return structure;
}

module.exports={normalizeIntradayBars,analyzeRangeRetest60m};
