# Sector Capital Dual Recommendation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add truthful sector capital flow and separate stable rotation recommendations from aggressive momentum tracking recommendations.

**Architecture:** Reuse the current Tencent full-market snapshot and Eastmoney board directory. Fetch ranked industry/concept capital rows through two Eastmoney hosts, merge direct capital fields with computed breadth, attach related boards to stocks, then produce two independently gated recommendation arrays. Keep all cache and fallback states explicit.

**Tech Stack:** Electron, Node.js standard library, existing renderer DOM/CSS, Node test runner.

## Global Constraints

- No new dependencies.
- Direct board fund fields must be labeled as direct; breadth/turnover fallback must be labeled as estimated.
- Stable and momentum lists have separate gates and UI sections.
- Limit-up, explosive-volume, and overextended momentum rows never receive an immediate buy conclusion.
- Existing favorite persistence, market refresh, detail refresh, and online search behavior must remain unchanged.

---

### Task 1: Sector Capital Data

**Files:**
- Modify: `main.js:974-1040`
- Test: `tests/smoke.test.js`

**Interfaces:**
- Produces: `mergeSectorCapitalRows(rotation, capitalRows, marketQuotes)` returning `{sectors, weakSectors, fundSectors}`.
- Produces: `fetchSectorCapitalFlow(force)` returning `{rows, source, fetchedAt, warnings, direct}`.

- [ ] **Step 1: Write failing tests**

Add tests proving direct `mainNetInflow/mainNetPct` outrank turnover-only rows, concept members inherit their board, and fallback rows retain `capitalEstimated: true`.

- [ ] **Step 2: Verify RED**

Run `node --test --test-name-pattern="板块真实资金|概念板块成员" tests/smoke.test.js` and confirm missing exports fail.

- [ ] **Step 3: Implement minimal data flow**

Add host fallback for `82.push2.eastmoney.com` and `push2.eastmoney.com`; query industry and concept boards ordered by both `f62` and `f3`; normalize `f12/f14/f3/f20/f62/f184`; cache for 60 seconds; merge direct capital into computed industry rotation.

- [ ] **Step 4: Verify GREEN**

Run the focused tests and confirm all pass.

### Task 2: Stable Rotation Candidate Coverage

**Files:**
- Modify: `main.js:2451-2838`
- Test: `tests/smoke.test.js`

**Interfaces:**
- Consumes: sector rows with `memberCodes`, `mainNetInflow`, `mainNetPct`, `capitalRank`, `capitalEstimated`.
- Produces: `resolveStockRotationProfiles(stock, sectors)` and rotation-prioritized candidates.

- [ ] **Step 1: Write failing tests**

Add a test where agriculture is the top direct-capital sector but its stocks rank below generic preliminary candidates; assert rotation candidates are still selected while weak or negative-flow sectors are not promoted.

- [ ] **Step 2: Verify RED**

Run `node --test --test-name-pattern="轮动主线候选" tests/smoke.test.js` and confirm failure.

- [ ] **Step 3: Implement minimal candidate integration**

Attach exact industry and concept memberships, add rotation score to the factor context, reserve per-sector candidates for the top three to five positive-flow sectors, then pass them through existing history, technical, financial, news, future-risk and outcome gates.

- [ ] **Step 4: Verify GREEN**

Run focused tests and existing recommendation-gate tests.

### Task 3: Momentum Tracking Recommendation

**Files:**
- Modify: `main.js:2451-2838`
- Modify: `renderer.js`
- Modify: `styles.css`
- Test: `tests/smoke.test.js`
- Test: `tests/ui-smoke.js`

**Interfaces:**
- Produces: `momentumRecommendationDecision(item)`.
- Produces: market result property `momentumRecommendations` containing four to eight risk-reviewed rows when qualified.

- [ ] **Step 1: Write failing tests**

Add tests proving a high-flow sector leader can enter momentum tracking, a negative-flow leader cannot, and limit-up or volume-ratio-above-four rows receive `强势追踪，不追高` with `allowed: false`.

- [ ] **Step 2: Verify RED**

Run `node --test --test-name-pattern="强势追踪" tests/smoke.test.js` and confirm failure.

- [ ] **Step 3: Implement momentum gate and presentation**

Score board capital, daily strength, turnover/volume, leadership and news separately. Limit two rows per board. Render a distinct “强势追踪推荐” section below “稳健轮动推荐” with direct fund amount, fund ratio, board rank and risk status.

- [ ] **Step 4: Verify GREEN**

Run focused unit tests and `npm run test:ui`; confirm both sections render without changing existing click-to-detail behavior.

### Task 4: Individual Analysis, Logs, and Live Verification

**Files:**
- Modify: `main.js:1475-1530`
- Modify: `main.js:2185-2240`
- Modify: `renderer.js`
- Test: `tests/smoke.test.js`
- Test: `tests/ui-smoke.js`

**Interfaces:**
- Consumes: `marketOverview.sectors`, recommendation `rotationProfiles`, and current stock/market news.
- Produces: individual analysis text with sector capital rank, direct/estimated source, breadth, leadership position and entry risk.

- [ ] **Step 1: Write failing tests**

Add tests proving individual analysis reports direct sector inflow and rank, distinguishes leading/following position, and blocks entry when direct sector capital turns negative.

- [ ] **Step 2: Verify RED**

Run focused tests and confirm missing sector-capital evidence fails.

- [ ] **Step 3: Implement analysis and diagnostics**

Extend entry context and detail rendering. Log board hosts, direct coverage, fallback reason, stable/momentum counts, and rejection summaries without exposing logs in the UI.

- [ ] **Step 4: Full verification**

Run `npm test`, `npm run test:ui`, `node --check main.js`, `node --check renderer.js`, and `git diff --check`. Execute live board requests and confirm agriculture/pork rows carry current direct capital values, source and timestamp.
