'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {evaluateThemeFirstBoard}=require('../lib/theme-first-board');

const day='2026-11-11';
const at=time=>`${day}T${time}+08:00`;
const row=(code,overrides={})=>({code,name:code,themeId:'通信技术',tradeDate:day,
  previousLimitUp:false,limitTouchedAt:at('09:34:00'),firstSealAt:at('09:35:00'),
  evidenceAvailableAt:at('09:36:00'),businessRelation:{verified:true,source:'公告',firstSeenAt:at('09:33:00')},...overrides});
const coverage={days:['2026-11-04','2026-11-05','2026-11-06','2026-11-09','2026-11-10']
  .map(date=>({date,source:'limit-pool',memberRevision:'r1'}))};

test('F路径等待第三只已核验首板且始终不授予买入权限',()=>{
  const result=evaluateThemeFirstBoard([row('600001'),row('600002',{firstSealAt:at('09:36:00')}),
    row('600003',{firstSealAt:at('09:37:00'),evidenceAvailableAt:at('14:32:00')})],{
    tradeDate:day,cutoffAt:at('14:40:00'),recentEpisodes:[],historyCoverage:coverage});
  assert.equal(result.status,'observed');
  assert.equal(result.candidates.length,3);
  assert.equal(result.eligibleAt,new Date(at('14:32:00')).toISOString());
  assert.ok(result.candidates.every(item=>item.entryPermission === 'shadow-only'));
});

test('缺首封、关系未核验和五日内已激活主题不能伪装新题材',()=>{
  const missing=evaluateThemeFirstBoard([row('600001'),row('600002',{firstSealAt:''}),
    row('600003',{businessRelation:{verified:false}})],{tradeDate:day,cutoffAt:at('15:00:00')});
  assert.equal(missing.status,'data-pending');
  assert.equal(missing.candidates.length,0);
  const old=evaluateThemeFirstBoard([row('600001'),row('600002'),row('600003')],{
    tradeDate:day,cutoffAt:at('15:00:00'),historyCoverage:coverage,
    recentEpisodes:[{themeId:'通信技术',subtype:'early-first-board',tradeDate:'2026-11-09',status:'observed'}]});
  assert.equal(old.status,'rejected');
  assert.match(old.reasons.join(' '),/最近5个交易日/);
});

test('同一证券的重复记录不能凑足三只',()=>{
  const result=evaluateThemeFirstBoard([row('600001'),row('600001'),row('600002')],{
    tradeDate:day,cutoffAt:at('15:00:00'),historyCoverage:coverage});
  assert.equal(result.status,'data-pending');
  assert.equal(result.candidates.length,0);
});

test('午后首封不回填早封路径且需独立容量扩散证据',()=>{
  const late=code=>row(code,{firstSealAt:at('13:30:00'),evidenceAvailableAt:at('13:31:00'),
    capacityExpansion:{verified:true,source:'funds',availableAt:at('14:00:00')}});
  const result=evaluateThemeFirstBoard([late('600001'),late('600002'),late('600003')],{
    tradeDate:day,cutoffAt:at('14:10:00'),historyCoverage:coverage});
  assert.equal(result.status,'observed');
  assert.equal(result.groups[0].subtype,'late-capacity');
  assert.equal(result.eligibleAt,new Date(at('14:00:00')).toISOString());
  assert.ok(result.candidates.every(item=>item.earlySeal === false));
});

test('截止后才获得的扩散证据不能回填',()=>{
  const result=evaluateThemeFirstBoard([row('600001'),row('600002'),
    row('600003',{evidenceAvailableAt:at('14:32:00')})],{tradeDate:day,cutoffAt:at('10:00:00')});
  assert.equal(result.status,'data-pending');
  assert.equal(result.candidates.length,0);
});

test('五日题材历史覆盖未知时不能把无记录当成新题材',()=>{
  const result=evaluateThemeFirstBoard([row('600001'),row('600002'),row('600003')],{
    tradeDate:day,cutoffAt:at('15:00:00'),recentEpisodes:[]});
  assert.equal(result.status,'data-pending');
  assert.match(result.reasons.join(' '),/历史覆盖未确认/);
});
