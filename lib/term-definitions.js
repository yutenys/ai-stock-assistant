'use strict';

const definitions = Object.freeze([
  {id:'market.capital-net',name:'主力净额',status:'现行规则',version:'sector-capital-v1',
    definition:'公开接口定义的分类买入额减卖出额；不等于机构真实持仓变化。',limit:'跨来源、跨成员、跨日累计值不可直接相减。'},
  {id:'market.turnover',name:'成交额',status:'现行规则',version:'market-quote-v1',
    definition:'统计区间内成交金额，不等于资金净流入。',limit:'不同区间或口径不能直接比较。'},
  {id:'market.regime',name:'市场状态',status:'现行规则',version:'market-regime-v1',
    definition:'宽基指数、涨跌家数等市场级证据的状态。',limit:'不代表单只股票或题材已具备买点。'},
  {id:'theme.episode',name:'题材轮次',status:'影子假设',version:'theme-regime-20261010-shadow-v1',
    definition:'同一成员版本下连续交易日的题材观察轮次。',limit:'缺失交易日证据时暂停判断，不自动推断资金接力。'},
  {id:'entry.permission',name:'当前入场许可',status:'现行规则',version:'entry-plan-v1',
    definition:'当前时点计划的风险、价格、结构和时效条件检查结果。',limit:'历史曾允许不代表现在允许；许可不等于已成交。'},
  {id:'track.B',name:'方案B强势追踪',status:'现行规则',version:'recommendation-v26',
    definition:'大盘推荐中的强势延续观察轨道。',limit:'不是接力B2，也不是外部缠论B2。'},
  {id:'track.R',name:'R短线修复',status:'影子假设',version:'short-rebound-selective-v30',
    definition:'R1超跌首修复、R2强趋势回踩修复、R3题材共振首启动的精选、观察、历史三层轨道。',limit:'精选同时最多3只、同主题最多1只、每日新增最多5只；不授予正式入场许可，不纳入A/B收益统计。'},
  {id:'relay.B2',name:'接力B2',status:'影子假设',version:'relay-research-v1',
    definition:'仅用于独立接力研究的编号。',limit:'未取得完整封板与排队数据时不形成默认模拟成交。'},
  {id:'external.chan.B2',name:'附件B2',status:'外部术语',version:'external-20261010',
    definition:'附件中的外部买点称谓，原算法和完整证据未提供。',limit:'不映射为本地方案B或接力B2，不授予交易许可。'},
  {id:'outcome.observed',name:'观察涨幅',status:'现行规则',version:'outcome-v2',
    definition:'从发布参考价到核验价格的变化。',limit:'不是浮盈、已实现收益，也不证明可成交。'},
  {id:'account.unrealized',name:'持仓浮盈亏',status:'现行规则',version:'research-account-v1',
    definition:'持仓估值减核验成本。',limit:'缺最终价格时仅列已核验部分，不拼成当日完整账户净值。'},
  {id:'account.realized',name:'已实现收益',status:'现行规则',version:'research-account-v1',
    definition:'规则模拟实际卖出成交后按成本及费用计算的盈亏。',limit:'与收藏观察涨幅、持仓浮盈亏分开统计。'}
]);

module.exports = {termDefinitions:() => definitions.map(row => ({...row}))};
