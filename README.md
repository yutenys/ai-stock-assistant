# AI 股票观察助手

基于 Electron 的 A 股行情、行业股票池、个股分析与模拟交易桌面工具。

应用使用公开行情接口和本地规则分析，不接入券商交易系统，也不执行真实买卖。分析结果仅用于条件观察，不构成投资建议。

## 主要功能

- 输入半导体、白酒、猪肉、AI 算力等自然语言命令，生成本次行业股票池。
- 在线搜索 A 股，查看实时价格、涨跌、成交额、市值和资金数据。
- 展示分时、五日、日 K、周 K、月 K，以及均价线和 MA5/10/20/30/60。
- 分析近三个月趋势、量能、均线、MACD、RSI、支撑位和突破位。
- 查看大盘指数、市场宽度、板块轮动、资金、涨跌停和突破候选。
- 使用本地标签收藏股票，同一股票可加入多个标签。
- 模拟买入和卖出，记录持仓数量、加权成本、浮动盈亏及已实现收益。
- 每日操作和接口错误写入 `logs/YYYY-MM-DD.log`。

## 环境要求

- Windows 10/11
- Node.js 18 或更高版本
- npm

## 安装与启动

```powershell
git clone https://github.com/yutenys/ai-stock-assistant.git
cd ai-stock-assistant
npm install
npm start
```

也可以双击 `启动AI股票助手.vbs`。首次启动时，脚本会调用 `start.cmd` 自动安装缺失依赖，并隐藏命令行窗口。

不要直接用浏览器打开 `index.html`，行情和日志功能依赖 Electron IPC。

## 测试

```powershell
npm test
npm run test:ui
```

`npm test` 会访问公开行情接口，网络状态和接口限流可能影响执行时间。

## 打包

```powershell
npm run dist
```

Windows 便携版生成在 `release/` 目录。该目录属于构建产物，不提交到 Git。

## 数据存储

- 标签、标签股票、模拟持仓和模拟成交记录保存在 Electron 本地存储中。
- 主显示区的搜索或生成结果不持久化，重启后为空。
- 接口缓存保存在 `cache/`。
- 每日详细日志保存在 `logs/`。

## 项目结构

```text
ai-stock-assistant/
├─ main.js                 Electron 主进程、IPC、网络请求与分析算法
├─ preload.js              安全暴露渲染进程 API
├─ renderer.js             页面状态、交互、标签、图表与模拟交易
├─ index.html              页面结构
├─ styles.css              页面与组件样式
├─ tests/                  核心逻辑和 Electron UI 回归测试
├─ docs/                   架构、选股逻辑与接口文档
├─ start.cmd               命令行启动脚本
└─ 启动AI股票助手.vbs      隐藏命令行窗口的一键启动脚本
```

完整架构、选股算法和数据接口说明见 [项目架构文档](docs/PROJECT_ARCHITECTURE.md)。

## 数据来源与限制

行情、板块、公司资料和资讯来自腾讯、东方财富、新浪及公开网页等多源接口。程序会在接口失败时尝试其他数据源或缓存，并在界面和日志中记录异常。

公开接口可能出现限流、网络重置、字段缺失或延迟。模拟交易不包含手续费、滑点、涨跌停成交限制和真实账户资金约束。
