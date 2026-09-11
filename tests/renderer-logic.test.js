const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../renderer.js'),'utf8');

function harness(names, values={}) {
  const declarations=[...source.matchAll(/^(?:async )?function (\w+)\(/gm)];
  const code=names.map(name=>{
    const index=declarations.findIndex(match=>match[1]===name);
    assert.ok(index>=0,`Missing renderer function ${name}`);
    return source.slice(declarations[index].index,declarations[index+1]?.index ?? source.length);
  }).join('\n');
  const context=vm.createContext({notify(){},saveState(){},renderStocks(){},addLog(){},...values});
  vm.runInContext(code,context);
  return context;
}

test('环境观察卡片使用观察评分并展示当前环境限制',()=>{
  const context=harness(['recommendationCardHtml'],{recommendationIndustry:()=>'',pctClass:()=>'',badgeClass:()=>'',
    yuan:String,formatPct:String,escapeHtml:String,recommendationCanslimText:()=>'',recommendationFactorText:()=>''});
  const html=context.recommendationCardHtml({code:'600001',name:'测试',signalScore:80,recommendationTier:'环境观察',
    holdingPeriod:'波段',dataConfidence:{label:'中等',available:4,total:6},
    entryAssessment:{allowed:false,status:'大盘偏弱，等待确认'}});
  assert.match(html,/观察评分 80/);
  assert.match(html,/大盘偏弱，等待确认/);
  assert.match(html,/波段/);
  assert.match(html,/数据可信度 中等 4\/6/);
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
