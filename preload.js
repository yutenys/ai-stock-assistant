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
  startFullMarketResearch: (request) => ipcRenderer.invoke('start-full-market-research', request),
  getFullMarketResearchStatus: () => ipcRenderer.invoke('get-full-market-research-status'),
  cancelFullMarketResearch: () => ipcRenderer.invoke('cancel-full-market-research'),
  onFullMarketResearchProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('full-market-research-progress', listener);
    return () => ipcRenderer.removeListener('full-market-research-progress', listener);
  },
  loadUserState: () => ipcRenderer.invoke('load-user-state'),
  saveUserState: (state) => ipcRenderer.invoke('save-user-state', state),
  loadResearchAccount: () => ipcRenderer.invoke('load-research-account'),
  createResearchAccount: (request) => ipcRenderer.invoke('create-research-account', request),
  executeResearchOrder: (order) => ipcRenderer.invoke('execute-research-order', order),
  markResearchAccount: (request) => ipcRenderer.invoke('mark-research-account', request),
  explainStockWithAi: (request) => ipcRenderer.invoke('explain-stock-with-ai', request),
  onMarketProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('market-overview-progress', listener);
    return () => ipcRenderer.removeListener('market-overview-progress', listener);
  },
  fetchLiveNews: (request) => ipcRenderer.invoke('fetch-live-news', request),
  fetchCompanyProfile: (stock) => ipcRenderer.invoke('fetch-company-profile', stock),
  openExternal: (url) => ipcRenderer.invoke('open-external-url', url),
  appendLog: (entry) => ipcRenderer.invoke('append-operation-log', entry)
});
