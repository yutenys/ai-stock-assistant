# 横盘突破趋势分析 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在大盘推荐和个股分析中统一识别横盘箱体、量能试压、阶段资金确认及有效突破。

**Architecture:** 在 `main.js` 增加纯函数 `analyzeConsolidationBreakout(history)` 计算技术结构，再由 `combineConsolidationBreakout(technical, flow)` 合并现有近 10 日阶段资金。`analyzeHistory`、大盘推荐和个股分析复用同一结果，`renderer.js` 只负责展示。

**Tech Stack:** Electron、Node.js、原生 JavaScript、Node test runner、现有腾讯/新浪行情接口。

## Global Constraints

- 不增加第三方依赖，不针对 600589 写特例。
- 阶段资金失败时保留技术评估，并明确显示数据不足。
- 状态表示条件完成度，不承诺未来上涨。
- 保留当前未提交的界面、刷新和资金分析改动。

---

### Task 1: 横盘与量能技术结构

**Files:**
- Modify: `main.js`
- Test: `tests/smoke.test.js`

**Interfaces:**
- Produces: `analyzeConsolidationBreakout(history: HistoryRow[]): ConsolidationBreakout`
- `ConsolidationBreakout` 包含 `available`、`isConsolidating`、`status`、`technicalScore`、`boxDays`、`boxLow`、`boxHigh`、`rangePct`、`distanceToBreakoutPct`、`volumeCompressionRatio`、`pressureTestCount`、`failedPressureCount`、`breakoutConfirmed`、`overheated`、`summary`、`trigger`、`invalidation`。

- [ ] **Step 1: 写失败测试**

在 `tests/smoke.test.js` 构造 80 日行情，其中最后 9 日位于 8.00 至 8.60 元箱体，量能先缩后放量试压。断言横盘成立、箱体天数为 7 至 12 日、状态为“突破蓄势”或“接近突破”。再把最后一日改为放量收盘 8.70 元，断言状态为“突破确认”。

- [ ] **Step 2: 验证测试失败**

Run: `node --test --test-name-pattern="横盘箱体量能试压" tests/smoke.test.js`

Expected: FAIL，提示 `analyzeConsolidationBreakout is not a function`。

- [ ] **Step 3: 实现最小技术分析**

在 `main.js`：

```js
function analyzeConsolidationBreakout(history) {
  const rows = validHistoryRows.slice(-120);
  const candidates = [12, 11, 10, 9, 8, 7].map(days => scoreWindow(rows, days));
  const box = candidates.find(item => item.rangePct <= 10 && item.averageAbsChangePct <= 2.5);
  // 计算 MA5/10、MA20 方向、近 5 日量能相对前 20 日、箱顶试压、上影线风险。
  // 收盘突破箱顶且当日量达到前 20 日均量 1.2 倍，状态为“突破确认”。
  return result;
}
```

评分采用已确认阈值：箱体成立 30 分、窄幅 6 至 10 分、距箱顶 4% 内 15 分、短均线不弱 10 分、MA20 未明显向下 10 分、缩量整理 8 分、有效试压 10 分；放量长上影减 8 分，近 20 日涨幅超过 30% 减 15 分。

- [ ] **Step 4: 接入历史分析并验证**

在 `analyzeHistory` 返回值加入 `consolidationBreakout`，导出纯函数。运行：

`node --test --test-name-pattern="横盘箱体量能试压" tests/smoke.test.js`

Expected: PASS。

### Task 2: 阶段资金与大盘推荐

**Files:**
- Modify: `main.js`
- Test: `tests/smoke.test.js`

**Interfaces:**
- Consumes: `ConsolidationBreakout`、`summarizeFundFlowRows(rows, 10)`。
- Produces: `combineConsolidationBreakout(technical, flow): BreakoutPotential`。
- `BreakoutPotential` 包含 `available`、`status`、`score`、`technicalScore`、`flowAdjustment`、`summary`、`trigger`、`invalidation`。

- [ ] **Step 1: 写失败测试**

构造同一横盘技术结构，分别传入持续净流入、资金缺失和持续净流出三组资金。断言净流入提升为“接近突破”，缺失时保留技术状态，持续净流出降级为“结构偏弱”。

- [ ] **Step 2: 验证测试失败**

Run: `node --test --test-name-pattern="横盘突破合并阶段资金" tests/smoke.test.js`

Expected: FAIL，提示 `combineConsolidationBreakout is not a function`。

- [ ] **Step 3: 实现资金合并**

```js
function combineConsolidationBreakout(technical, flow) {
  const persistentOutflow = flow.available && flow.netRatio <= -3
    && flow.positiveDays <= Math.floor(flow.days * .4);
  const flowAdjustment = !flow.available ? 0
    : flow.mainNetInflow > 0 && flow.positiveDays >= Math.ceil(flow.days * .6) ? 10
      : flow.mainNetInflow > 0 ? 5 : persistentOutflow ? -18 : -8;
  const score = clampRecommendationScore(technical.technicalScore + flowAdjustment);
  return { ...technical, score, flowAdjustment, status, summary };
}
```

- [ ] **Step 4: 接入大盘推荐**

候选初筛纳入 `analysis.consolidationBreakout.isConsolidating`。取得阶段资金后生成 `breakoutPotential`，最高加 10 分；`结构偏弱` 不进入最终推荐。推荐原因追加箱体、距箱顶、试压次数和资金依据，推荐信号使用“横盘蓄势”或“接近突破”。

- [ ] **Step 5: 验证资金与大盘逻辑**

Run: `npm test`

Expected: 所有 Node 测试通过，大盘推荐测试仍有结果且横盘信号使用统一字段。

### Task 3: 个股展示与完整回归

**Files:**
- Modify: `main.js`
- Modify: `renderer.js`
- Test: `tests/ui-smoke.js`

**Interfaces:**
- Consumes: `analysis.consolidationBreakout`、`analysis.breakoutPotential`。
- Produces: 个股详情中的“横盘突破评估”区域。

- [ ] **Step 1: 写 UI 失败测试**

在 UI mock 的个股分析结果加入箱体 8.00 至 8.60 元、横盘 9 日、试压 1 次、状态“接近突破”。断言详情包含“横盘突破评估”“箱顶 ¥8.60”“箱底 ¥8.00”“放量收盘突破 ¥8.60”“跌破 ¥8.00 失效”。

- [ ] **Step 2: 验证 UI 测试失败**

Run: `npm run test:ui`

Expected: FAIL，详情文本缺少横盘突破区域。

- [ ] **Step 3: 接入个股资金合并和页面**

`fetchStockHistory` 使用已并发取得的 `fundFlowPeriod` 生成 `analysis.breakoutPotential`。`renderer.js` 在阶段资金后展示状态、评分、箱体、量能试压、确认条件和失效条件；无数据时显示明确原因。

- [ ] **Step 4: 完整验证**

Run:

```powershell
npm test
npm run test:ui
node --check main.js
node --check renderer.js
git diff --check
```

Expected: Node 测试和 Electron UI 回归全部通过，无语法错误、无新增差异错误。
