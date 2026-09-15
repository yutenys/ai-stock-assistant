const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const tradeTime=require('../lib/trade-time');
const source=fs.readFileSync(path.join(__dirname,'../renderer.js'),'utf8');

function harness(names, values={}) {
  const declarations=[...source.matchAll(/^(?:async )?function (\w+)\(/gm)];
  const code=names.map(name=>{
    const index=declarations.findIndex(match=>match[1]===name);
    assert.ok(index>=0,`Missing renderer function ${name}`);
    return source.slice(declarations[index].index,declarations[index+1]?.index ?? source.length);
  }).join('\n');
  const context=vm.createContext({notify(){},saveState(){},renderStocks(){},addLog(){},
    TradeTime:{...tradeTime,executionWindow:()=>tradeTime.executionWindow('2026-09-15T10:00:00+08:00')},...values});
  vm.runInContext(code,context);
  return context;
}

test('保存成功提示等待磁盘回执，失败时不误报成功',async()=>{
  const notices=[];
  let complete;
  const context=harness(['saveState'],{
    STORAGE_KEY:'test-state',labels:[],activeLabel:'',labelSorts:{},portfolio:[],simulatedTrades:[],
    localStorage:{setItem(){}},addLog(){},notify:(message,type)=>notices.push({message,type}),
    window:{stockApi:{saveUserState:()=>new Promise(resolve=>{complete=resolve;})}}
  });
  const pending=context.saveState({successMessage:'标签保存成功'});
  assert.equal(notices.length,0);
  complete({ok:true,file:'state.json'});
  assert.equal((await pending).ok,true);
  assert.deepEqual(notices,[{message:'标签保存成功',type:'success'}]);
  context.window.stockApi.saveUserState=async()=>({ok:false,error:'disk full'});
  const failed=await context.saveState({successMessage:'不应出现'});
  assert.equal(failed.ok,false);
  assert.equal(notices.some(item=>item.message==='不应出现'),false);
  assert.match(notices.at(-1).message,/disk full/);
});

test('环境观察卡片使用观察评分并展示当前环境限制',()=>{
  const context=harness(['recommendationCardHtml'],{recommendationIndustry:()=>'',pctClass:()=>'',badgeClass:()=>'',
    yuan:String,formatPct:String,escapeHtml:String,recommendationCanslimText:()=>'',recommendationFactorText:()=>''});
  const html=context.recommendationCardHtml({code:'600001',name:'测试',signalScore:80,recommendationTier:'环境观察',
    executionTiming:{summary:'最早买入 2026-09-16；最早卖出 2026-09-17（T+1）'},
    holdingPeriod:'波段',dataConfidence:{label:'中等',available:4,total:6},
    entryAssessment:{allowed:false,status:'大盘偏弱，等待确认'}});
  assert.match(html,/观察评分 80/);
  assert.match(html,/大盘偏弱，等待确认/);
  assert.match(html,/波段/);
  assert.match(html,/数据可信度 中等 4\/6/);
  assert.match(html,/最早买入 2026-09-16.*最早卖出 2026-09-17/);
});

test('推荐首屏按行业选代表股，不让行业分组截断遮蔽其他方向',()=>{
  const context=harness(['recommendationIndustry','recommendationPreview']);
  const items=[...Array.from({length:6},(_,i)=>({code:`A${i}`,industry:'证券'})),
    ...Array.from({length:3},(_,i)=>({code:`B${i}`,industry:'多元金融'})),
    ...Array.from({length:3},(_,i)=>({code:`C${i}`,industry:'银行'})),{code:'D0',industry:'电力'}];
  const result=context.recommendationPreview(items,10);
  assert.equal(result.length,10);
  assert.equal(new Set(result.map(item=>item.industry)).size,4);
  assert.ok(result.some(item=>item.code==='D0'));
  assert.equal(items.length,13);
  assert.equal(context.recommendationPreview([...items,items[0]],20).length,13);
  assert.equal(context.recommendationPreview([],10).length,0);
});

test('全市场后台任务优先处理收藏、持仓和当前推荐且去重',()=>{
  const context=harness(['fullMarketResearchPriorityCodes'],{
    labels:[{stocks:[{code:'600001'},{code:'600002'}]}],
    portfolio:[{code:'600002'},{code:'600003'}],
    latestMarketRecommendations:[{code:'600004'}],
    latestMarketWatchRecommendations:[{code:'bad'}],
    latestMarketMomentumRecommendations:[{code:'600001'},{code:'600005'}]
  });
  assert.deepEqual([...context.fullMarketResearchPriorityCodes()],['600001','600002','600003','600004','600005']);
});

test('推荐集中度按完整名单和共同轮动主题统计，不把首屏分散当作风险分散',()=>{
  const context=harness(['recommendationIndustry','recommendationConcentrationText']);
  const items=[{code:'1',industry:'证券',rotationProfiles:[{name:'券商概念'},{name:'券商概念'}]},
    {code:'2',industry:'多元金融',rotationProfiles:[{name:'券商概念'}]},
    {code:'3',industry:'电力'},{code:'4',industry:'行业待确认'}];
  const text=context.recommendationConcentrationText(items);
  assert.match(text,/3 个已确认行业/);
  assert.match(text,/券商概念 2\/4/);
  assert.match(text,/同向风险/);
  assert.equal(context.recommendationConcentrationText([]),'');
});

test('收藏复盘只使用入选快照，旧收藏不能用刷新后的信号补写归因',()=>{
  const stock={code:'600001',price:10,signal:'接近突破',holdingPeriod:'波段',recommendationModelVersion:'v11',recommendationContext:{news:{signal:'中性'}}};
  stock.industry='半导体';
  const context=harness(['favoriteOutcomeRows','labelStockSnapshot'],{labels:[],latestMarketOverview:{
    indices:[{code:'000001',name:'上证指数',price:100}], sectors:[{code:'BK0475',name:'半导体',price:200}]
  }});
  const saved=context.labelStockSnapshot(stock);
  stock.recommendationContext.news.signal='偏谨慎';
  context.latestMarketOverview={indices:[{code:'000001',name:'上证指数',price:110}],sectors:[{code:'BK0475',name:'半导体',price:220}]};
  context.labels=[{name:'版本批次',stocks:[{...saved,signal:'已反弹',recommendationModelVersion:'v12'},
    {code:'600002',signal:'已反弹',recommendationModelVersion:'v12'}]}];
  const rows=context.favoriteOutcomeRows();
  assert.equal(rows[0].signal,'接近突破');
  assert.equal(rows[0].recommendationModelVersion,'v11');
  assert.equal(rows[0].holdingPeriod,'波段');
  assert.equal(rows[0].benchmarkBasePrice,100);
  assert.equal(rows[0].benchmarkPrice,110);
  assert.equal(rows[0].industryBenchmarkBasePrice,200);
  assert.equal(rows[0].industryBenchmarkPrice,220);
  assert.equal(rows[0].recommendationContext.news.signal,'中性');
  assert.equal(rows[1].signal,'');
  assert.equal(rows[1].recommendationModelVersion,'');
  assert.equal(rows[1].recommendationContext,null);
});

test('持仓周期标签使用最新分析，并保留收藏时的周期快照',()=>{
  const stock={code:'600001',holdingPeriod:'波段',favoriteEntrySnapshot:{holdingPeriod:'中长线'}};
  const historyResult={analysis:{holdingPeriod:'短线',holdingProfile:{primary:'短线'}}};
  const context=harness(['stockHoldingPeriod','applyAnalysisClassification'],{
    stocks:[stock],labels:[{name:'关注',stocks:[{...stock}]}],detailHistoryCache:new Map([['600001',historyResult]]),
    currentViewSource:'label',updateStatusByQuote:()=> '等待确认'
  });
  assert.equal(context.stockHoldingPeriod(stock),'波段');
  assert.equal(context.stockHoldingPeriod(stock,historyResult),'短线');
  context.applyAnalysisClassification('600001');
  assert.equal(context.stocks[0].holdingPeriod,'短线');
  assert.equal(context.labels[0].stocks[0].holdingPeriod,'短线');
  assert.equal(context.labels[0].stocks[0].favoriteEntrySnapshot.holdingPeriod,'中长线');
});

test('大盘并发刷新共享正在执行的请求，完成后可重新刷新', async () => {
  const pending=[];
  const context=harness(['loadMarketOverview'],{marketOverviewPending:null,
    performMarketRefresh:()=>new Promise(resolve=>pending.push(resolve))});
  const first=context.loadMarketOverview(true);
  assert.equal(context.loadMarketOverview(true),first);
  assert.equal(pending.length,1);
  pending[0]({fresh:true});
  assert.equal((await first).fresh,true);
  assert.equal(context.marketOverviewPending,null);
  const next=context.loadMarketOverview(true);
  assert.equal(pending.length,2);
  pending[1]({fresh:true});
  await next;
});

test('模拟交易拒绝未知方向和超范围数量，失败不修改持仓',()=>{
  const context=harness(['executeSimulatedTrade'],{
    portfolio:[],simulatedTrades:[],findStockByCode:()=>({code:'600001',name:'测试',price:10}),
    portfolioPosition:()=>null,document:{querySelector:()=>null}
  });
  assert.equal(context.executeSimulatedTrade('600001','hold',{quiet:true}),false);
  assert.equal(context.executeSimulatedTrade('600001','buy',{price:1e-300,amount:1e300,quiet:true}),false);
  assert.equal(context.portfolio.length,0);
  assert.equal(context.simulatedTrades.length,0);
});

test('旧持仓数值字符串不能使加仓数量发生字符串拼接',()=>{
  const position={code:'600001',quantity:'100',costPrice:'10',realizedPnl:0};
  const stock={code:'600001',name:'测试',price:10,recommendationModelVersion:'test-v1',recommendationContext:{news:{signal:'neutral'}}};
  const context=harness(['executeSimulatedTrade'],{
    portfolio:[position],simulatedTrades:[],findStockByCode:()=>stock,labels:[{name:'测试版本',stocks:[stock]}],
    portfolioPosition:()=>position,document:{querySelector:()=>null},nowText:()=>'',money:String
  });
  assert.equal(context.executeSimulatedTrade('600001','buy',{price:10,amount:1000,quiet:true,render:false}),true);
  assert.equal(position.quantity,200);
  assert.equal(position.costPrice,10);
  const snapshot=context.simulatedTrades[0].entrySnapshot;
  assert.equal(snapshot.modelVersion,'test-v1');
  assert.equal(snapshot.labels[0],'测试版本');
  stock.recommendationContext.news.signal='negative';
  assert.equal(snapshot.context.news.signal,'neutral');
});

test('普通模拟交易逐日锁定新买仓位，次交易日解锁，非交易时间拒绝',()=>{
  let at='2026-09-15T10:00:00+08:00';
  const context=harness(['executeSimulatedTrade'],{portfolio:[],simulatedTrades:[],
    TradeTime:{...tradeTime,executionWindow:()=>tradeTime.executionWindow(at)},
    findStockByCode:()=>({code:'600001',name:'测试',price:10}),
    portfolioPosition:()=>context.portfolio[0],document:{querySelector:()=>null},nowText:()=>at,money:String});
  const buy=()=>context.executeSimulatedTrade('600001','buy',{price:10,amount:1000,quiet:true,render:false});
  const sell=quantity=>context.executeSimulatedTrade('600001','sell',{price:10,quantity,quiet:true,render:false});
  assert.equal(buy(),true);
  assert.equal(sell(100),false);
  assert.equal(context.portfolio[0].quantity,100);
  at='2026-09-16T10:00:00+08:00';
  assert.equal(buy(),true);
  assert.equal(sell(200),false);
  assert.equal(sell(100),true);
  assert.equal(sell(100),false);
  at='2026-09-16T12:00:00+08:00';
  assert.equal(buy(),false);
  at='2026-09-17T15:10:00+08:00';
  assert.equal(sell(100),false);
  at='2026-09-18T10:00:00+08:00';
  assert.equal(sell(100),true);
});

test('旧持仓部分卖出不把剩余老仓重新锁定为当日买入',()=>{
  const position={code:'600001',quantity:300,costPrice:10,updatedAt:'2026-09-14T02:00:00Z'};
  const context=harness(['executeSimulatedTrade'],{portfolio:[position],simulatedTrades:[],
    findStockByCode:()=>({code:'600001',name:'测试',price:10}),portfolioPosition:()=>position,
    document:{querySelector:()=>null},nowText:()=>'',money:String});
  const sell=()=>context.executeSimulatedTrade('600001','sell',{quantity:100,price:10,quiet:true,render:false});
  assert.equal(sell(),true);
  assert.equal(sell(),true);
  assert.equal(position.quantity,100);
});

test('取消个股标签勾选后保存移除成员，其他股票不受影响',()=>{
  const stock={code:'600001',name:'测试',price:10};
  const context=harness(['labelStockSnapshot','saveStockLabels'],{
    labels:[{name:'甲',stocks:[stock,{code:'600002'}]},{name:'乙',stocks:[]}],activeLabel:'甲',stockLabelEditCode:stock.code,
    findStockByCode:()=>stock,document:{querySelectorAll:()=>[{dataset:{stockLabelName:'乙'}}]},
    $:()=>({value:''}),closeStockLabelPanel(){}
  });
  context.saveStockLabels();
  assert.equal(context.labels[0].stocks.length,1);
  assert.equal(context.labels[0].stocks[0].code,'600002');
  assert.equal(context.labels[1].stocks[0].code,stock.code);
});

test('个股分析过期缓存重新获取，强制刷新等待旧请求后发起新请求',async()=>{
  const pending=[];
  const context=harness(['fetchStockAnalysis'],{
    detailHistoryCache:new Map([['600001',{analyzedAt:'2020-01-01',old:true}]]),detailHistoryPending:new Map(),
    favoriteOutcomeRows:()=>[],applyAnalysisClassification(){},
    window:{stockApi:{fetchStockHistory:request=>new Promise(resolve=>pending.push({request,resolve}))}}
  });
  const stock={code:'600001',name:'测试'};
  const initial=context.fetchStockAnalysis(stock);
  assert.equal(pending.length,1);
  const forced=context.fetchStockAnalysis(stock,true);
  pending[0].resolve({analyzedAt:new Date().toISOString(),value:1});
  await initial;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(pending.length,2);
  assert.equal(pending[1].request.force,true);
  pending[1].resolve({analyzedAt:new Date().toISOString(),value:2});
  assert.equal((await forced).value,2);
  assert.equal(context.detailHistoryPending.size,0);
});

test('持仓风险按原失效条件判断，不用今日推荐缺席推导卖出',()=>{
  const context=harness(['portfolioMetrics','portfolioRiskAssessment'],{yuan:value=>`¥${value}`});
  const position={quantity:100,costPrice:10,lastPrice:8.5,realizedPnl:0};
  const breached=context.portfolioRiskAssessment(position,{}, {analysis:{tradeDate:'2026-09-11',tradePlan:{invalidationPrice:9}}});
  assert.equal(breached.label,'策略失效');
  position.lastPrice=9.5;
  const unknown=context.portfolioRiskAssessment(position,{},null);
  assert.equal(unknown.label,'待分析');
  assert.match(unknown.summary,/不能用推荐缺席/);
});

test('推荐卡片优先使用统一评分快照并明确周期待确认',()=>{
  const context=harness(['recommendationCardHtml'],{recommendationIndustry:()=>'',pctClass:()=>'',badgeClass:()=>'',
    yuan:String,formatPct:String,escapeHtml:String,recommendationCanslimText:()=>'',recommendationFactorText:()=>''});
  const html=context.recommendationCardHtml({code:'600001',name:'测试',signalScore:70,scoreCard:{recommendation:82},price:10});
  assert.match(html,/推荐评分 82/);
  assert.match(html,/周期待确认/);
});

test('新版模拟交易不再静默截断500条历史记录',()=>{
  const position={code:'600001',quantity:100,costPrice:10,realizedPnl:0};
  const history=Array.from({length:500},(_,index)=>({id:String(index)}));
  const context=harness(['executeSimulatedTrade'],{
    portfolio:[position],simulatedTrades:history,findStockByCode:()=>({code:'600001',name:'测试',price:10}),labels:[],
    portfolioPosition:()=>position,document:{querySelector:()=>null},nowText:()=>'',money:String
  });
  assert.equal(context.executeSimulatedTrade('600001','buy',{price:10,amount:1000,quiet:true,render:false}),true);
  assert.equal(context.simulatedTrades.length,501);
});

test('推荐结果严格、观察、强势三池互斥且不截断',()=>{
  const context=harness(['marketRecommendationPools']);
  const stable=[
    {code:'1',recommendationTier:'严格推荐'},
    {code:'2',recommendationTier:'观察候选'},
    {code:'3',recommendationTier:'环境观察'}
  ];
  const momentum=[{code:'4',recommendationTier:'强势追踪'}];
  const pools=context.marketRecommendationPools(stable,momentum);
  assert.deepEqual(pools.strict.map(item=>item.code),['1']);
  assert.deepEqual(pools.watch.map(item=>item.code),['2','3']);
  assert.equal(pools.momentum.map(item=>item.code).join(','),'4');
});

test('打开一键保存后冻结分析版本和股票内容',()=>{
  const context=harness(['createMarketSaveSnapshot']);
  const rows=[{code:'600001',price:10,analysisId:'a-1',scoreCard:{recommendation:80}}];
  const frozen=context.createMarketSaveSnapshot('strict',rows,'a-1');
  rows[0].price=11;
  rows[0].scoreCard.recommendation=60;
  assert.equal(frozen.track,'strict');
  assert.equal(frozen.analysisId,'a-1');
  assert.equal(frozen.rows[0].price,10);
  assert.equal(frozen.rows[0].scoreCard.recommendation,80);
});

test('标签状态在盘中越过突破位时不能显示已突破',()=>{
  const context=harness(['updateStatusByQuote'],{detailHistoryCache:new Map([['600001',{analysis:{
    breakoutPrice:10,score:80,ma5:10.8,ma10:10.5,ma20:10.2,ma30:10,return5:2,volumeRatio:2,
    observationPhase:{phase:'intraday',label:'盘中快照'}
  }}]])});
  assert.equal(context.updateStatusByQuote({code:'600001',price:10.5}),'盘中突破，等待收盘确认');
});
