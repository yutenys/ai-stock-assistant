const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stockApi', {
  fetchQuotes: (codes) => ipcRenderer.invoke('fetch-a-share-quotes', codes),
  searchStocks: (keyword) => ipcRenderer.invoke('search-a-share-stocks', keyword),
  runIndustryWorkflow: (command) => ipcRenderer.invoke('run-industry-workflow', command),
  fetchStockNews: (stock) => ipcRenderer.invoke('fetch-stock-news', stock),
  fetchStockHistory: (stock) => ipcRenderer.invoke('fetch-stock-history', stock),
  fetchStockChart: (request) => ipcRenderer.invoke('fetch-stock-chart', request),
  fetchStockFundFlow: (request) => ipcRenderer.invoke('fetch-stock-fund-flow', request),
  fetchMarketOverview: (force) => ipcRenderer.invoke('fetch-market-overview', force),
  fetchCompanyProfile: (stock) => ipcRenderer.invoke('fetch-company-profile', stock),
  openExternal: (url) => ipcRenderer.invoke('open-external-url', url),
  appendLog: (entry) => ipcRenderer.invoke('append-operation-log', entry)
});
