'use strict';

async function selectHistorySource({primary,secondary,count,tradeDate}) {
  const attempts=[];
  for(const load of [primary,secondary]) {
    try {
      const result=await load();
      const rows=(result.rows || []).filter(row=>row.date<=tradeDate);
      const dates=new Set(rows.map(row=>row.date));
      attempts.push({...result,rows});
      if(dates.has(tradeDate)&&dates.size>=Math.min(count,60)) return {...result,rows};
    }catch(error){attempts.push({rows:[],error:error.message || String(error)});}
  }
  const usable=attempts.filter(item=>item.rows.length).sort((a,b)=>{
    const latest=rows=>rows.reduce((value,row)=>row.date>value?row.date:value,'');
    return latest(b.rows).localeCompare(latest(a.rows)) || b.rows.length-a.rows.length;
  });
  if(usable.length) return usable[0];
  throw new Error(attempts.map(item=>item.error || '历史日线为空').join('；'));
}
module.exports={selectHistorySource};
