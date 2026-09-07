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
