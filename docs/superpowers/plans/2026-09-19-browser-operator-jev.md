# browser-operator 接入 Jev 决策回路 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已复活的 `plugins/browser-operator/` 里新增一个目标级工具 `browser_act(goal, maxSteps?)`,内部用 TypeSafe 的 Jev 模型连跑 N 步「观察 → 决策 → 执行」,只把精简 trace 交回主模型;原有 9 个 `browser_*` 工具行为零改动。

**Architecture:** 把回路拆成三块可分别测试的东西 —— `lib/policy.js`(纯函数:快照 → 索引元素表 → Jev questions;Jev 响应 → 校验过的动作)、`lib/loop.js`(纯逻辑回路,`observe` / `decide` / `execute` 全部注入)、`lib/index.js`(把真实 Playwright 页面、真实 Jev 客户端、真实动作执行接到回路上)。因此回路的全部逻辑都能**离线**测试:不需要浏览器、不需要网络、不需要 API key。

**Tech Stack:** Node ≥ 20 ESM、Playwright(`playwright-core`,插件已有)、`@typesafe-ai/sdk`(新增)、Cordis 插件(`ctx.tools.register` / 可选 `ctx.get('credentials')`)、离线断言用 `node:assert/strict` + 自写的 `check()` 收集器(仓库既有风格,见 `tests/smoke.mjs`)。

**Spec:** `docs/adr/0009-browser-operator-jev-revival.md`

## Global Constraints

- **插件根目录**:`plugins/browser-operator/`(在 worktree `.worktrees/browser-jev/` 里;所有相对路径都相对它)。
- **包名不变**:`dsh-browser-operator`;插件 id 保持 kebab-case。
- **纯 host 插件**:`package.json` + `lib/` + `cordis.yml` 示例 + `tests/`;无 client 半。**不碰** `ctx.browserUse`。
- **凭证规则(AGENTS.md)**:凭证只进 `~/.dsh/.credentials.yaml` 或 `.env`;任何 key/token **绝不**写进代码、文档或 git。本插件**不接受** `apiKey` 配置项。
- **文档路径约定(AGENTS.md)**:文档与配置里**绝不写本机绝对路径**,一律 `<repo-abs-path>`。
- **门禁口径(ADR-0009 决策点 4)**:`just check` = lint + test + audit,**必须保持离线**:不需要浏览器、不需要网络、不需要 API key。`tests/smoke.mjs` **不在**门禁里,只能手动跑。
- **页面侧函数不许引用模块作用域标识符**:`lib/snapshot.js` 的 `pageProbe` 会被 Playwright **只按函数源码**序列化进页面执行,页面里没有模块作用域的名字 —— 引用常量(哪怕只是 `const MAX_NAME_CHARS = 120`)会让读模式对**任何非空页面**抛 `ReferenceError`。需要参数就从 `options` 传,需要上限就写字面量。T6 的第一轮实现正是栽在这里;`tests/policy.test.mjs` 现在用「重新求值 `pageProbe.toString()` 再真调一次读模式」的用例把这条钉住。
- **门禁不 glob**:新测试必须显式加进 **三处** —— `justfile` 的 `test` recipe、根 `package.json` 的 `scripts.test`、根 `package.json` 的 `scripts.check`。
- **新用例插在尾部 runner 之前**(T5 起):`tests/policy.test.mjs` 的末尾有一段统一 `await` 异步用例、再打印摘要并可能 `exit(1)` 的 runner。**在它之后注册的用例永远不会运行、零痕迹、exit 0** —— 正是「门禁无声变瞎」。追加前先看一眼那段的起点,把用例插在它**前面**;runner 之后会被 guard 直接抛错(而不是静默跳过)。
- **工具定义四件套**:`tests/smoke.mjs:225-231` 断言每个注册的工具都有数值 `timeoutMs`、`output.schema`、`output.render`(函数)、`presentCall`(函数)。新工具必须齐全。
- **契约常量(照抄,别自创)**:`TOOL_TIMEOUT_MS = 120000`(已有,`lib/index.js:57`);`maxSteps` 默认 **12** / 硬上限 **40**;`budgetMs` 默认 **100000**(必须严格小于 120000);`jevTimeoutMs` **5000**;`actionTimeoutMs` 默认 **15000**(已有);`goalMet` / `stuck` 停止阈值 **0.8**;低置信度阈值 **0.35**、连续 **3** 步;校验失败最多重试 **2** 次;`WAIT` 单次上限 **1000 ms**;`jevModel` 默认 `'jev-latest'`。
- **闭合枚举**:动作空间 8 个(`CLICK` / `TYPE_TEXT` / `SELECT` / `SCROLL_UP` / `SCROLL_DOWN` / `WAIT` / `DONE` / `BLOCKED`);`status` 8 个(`done` / `stuck` / `blocked` / `max_steps` / `timeout` / `error` / `uncertain` / `text_unavailable`)。
- **不引入第二个模型**:`TYPE_TEXT` 的文本必须是 `goal` 里的逐字片段。**禁止**使用 `ctx.llm`。
- **questions 必须匹配 SDK 的 `Question` 联合**(权威定义:`plugins/browser-operator/node_modules/@typesafe-ai/sdk/dist/index.d.mts`)—— 三条硬约束:
  ① 每个问题都带 `type` 判别字段(`'choice'` / `'noul'` / `'score'`);
  ② `choice` 的 `criteria` 是**「标签 → 描述」的对象**(`ChoiceCriteria`),不是数组;
  ③ `noul` 问题**不带** `criteria`。
  对应地 `ChoiceResponse.choice` 是**字符串标签**(`keyof T & string`)并另带数值 `confidence`,`NoulResponse.noul` 是数值;
  **元素目标的标签就是元素序号的十进制写法**。
- **代码风格**:prettier `{ semi, singleQuote, trailingComma: 'all', printWidth: 100 }`;eslint `@eslint/js` recommended + node globals。**`.mjs` 一律 4 空格** —— prettier 3 会读 `.editorconfig`,其 `[*]` 是 `indent_size = 4` 而 JS glob 不含 `.mjs`;`.js` 保持 2 空格。以 `node node_modules/prettier/bin/prettier.cjs --write` 的结果为准。
- **提交规范**:Conventional Commits,subject ≤ 72 字符、不以句号结尾。

---

## 文件结构

| 文件                                               | 状态     | 职责                                                                                                                               |
| -------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `plugins/browser-operator/lib/policy.js`           | 新建     | **纯函数**:动作空间 / status 闭合枚举、快照 → 索引元素表、state 与 questions 构造、响应解析与校验、逐字候选、停止判据。零 import。 |
| `plugins/browser-operator/lib/loop.js`             | 新建     | 回路控制流。`observe` / `decide` / `execute` / `now` 全部注入,自身不 import 任何 I/O。                                             |
| `plugins/browser-operator/lib/snapshot.js`         | 新建     | 浏览器侧 reader(在页面上下文跑)+ `readSnapshot(page)` 包装。                                                                       |
| `plugins/browser-operator/lib/jev.js`              | 新建     | `@typesafe-ai/sdk` 客户端封装 + 凭证解析(`ctx.credentials`,可选注入)。                                                             |
| `plugins/browser-operator/lib/index.js`            | 修改     | 新增 `browser_act` 注册 + 把三块接到真实依赖上;配置项扩展;模块头注释工具数 9 → 10。                                                |
| `plugins/browser-operator/tests/policy.test.mjs`   | 新建     | **离线**单测:策略层 + 回路 + 注册形状。进 `just check`。                                                                           |
| `plugins/browser-operator/tests/smoke.mjs`         | 修改     | 手动浏览器自检:`EXPECTED_TOOLS` 加 `browser_act`;补两条错误路径检查。**不进**门禁。                                                |
| `plugins/browser-operator/package.json`            | 修改     | 加 `@typesafe-ai/sdk` 依赖;description 的「注册 8 个」→「注册 10 个」。                                                            |
| `plugins/browser-operator/README.md`               | 修改     | 去归档横幅;路径;工具表 9 → 10 + `browser_act` 小节;门禁口径;Jev 边界与凭证。                                                       |
| `plugins/browser-operator/preset/README.md`        | 修改     | 从「留档快照」改写为「在役模板 + 怎么拷到 `~/.dsh/.agent-presets/`」。                                                             |
| `plugins/browser-operator/preset/agent.cordis.yml` | 修改     | 人设补 `browser_act`;路径;`All 9` → `All 10`;`:311` 的「注册 9 个」→ 10。                                                          |
| `plugins/browser-operator/preset/preset.yml`       | 修改     | description 的「9 个」→「10 个」并提一句目标级工具。                                                                               |
| `plugins/browser-operator/cordis.yml`              | 修改     | 归档路径 → 新路径;「注册 9 个」→ 10。                                                                                              |
| `plugins/browser-operator/CONTEXT.md`              | **删除** | 词条并入根 `CONTEXT.md`。                                                                                                          |
| `justfile`                                         | 修改     | 第 15 行注释路径;`test` recipe 加新测试;`audit` recipe 加插件目录那行。                                                            |
| `package.json`(根)                                 | 修改     | `scripts.test` 与 `scripts.check` 各加新测试。                                                                                     |
| `README.md`(根)                                    | 修改     | 插件清单该行「已归档」→「维护中」;补 `browser_act`;恢复使用说明小节。                                                              |
| `CONTEXT.md`(根)                                   | 修改     | 第 3 行失效表述;并入 4 个旧词条 + 3 个新词条。                                                                                     |
| `CHANGELOG.md`                                     | 修改     | `[Unreleased]` 下补 `Added` / `Changed`。                                                                                          |

---

## Task 1: 依赖、动作空间、索引元素表

**Files:**

- Modify: `plugins/browser-operator/package.json`
- Create: `plugins/browser-operator/tests/policy.test.mjs`
- Create: `plugins/browser-operator/lib/policy.js`
- Modify: `justfile`, `package.json`(根)

**Interfaces:**

- Consumes: 无(第一个任务)。
- Produces:
  - `ACTION_SPACE: readonly string[]` —— 恰好 8 个,顺序固定。
  - `STATUS: readonly string[]` —— 恰好 8 个,顺序固定。
  - `buildElementTable(snapshot) -> { lines: string[], byIndex: Map<number, object>, eligible: { CLICK: number[], TYPE_TEXT: number[], SELECT: number[] } }`
  - `renderElementTable(table) -> string`
  - `snapshot` 的形状(由 Task 6 生产、测试里用固定 fixture 模拟):
    `{ url: string, title: string, freshness: string, text: string, elements: Array<{ index: number, role: string, name: string, value: string, disabled: boolean, kind: 'clickable'|'typeable'|'selectable' }> }`

- [ ] **Step 1: 装依赖**

```sh
pnpm --dir plugins/browser-operator add @typesafe-ai/sdk
```

Expected: `plugins/browser-operator/package.json` 的 `dependencies` 出现 `@typesafe-ai/sdk`,并生成/更新 `plugins/browser-operator/pnpm-lock.yaml`。

- [ ] **Step 2: 写失败的测试**

创建 `plugins/browser-operator/tests/policy.test.mjs`:

```js
/**
 * browser-operator 的离线单测 —— 不需要浏览器、不需要网络、不需要 API key。
 *
 * 运行: node plugins/browser-operator/tests/policy.test.mjs
 *
 * 这个文件进 `just check`(见 justfile / 根 package.json 的三处接线)。
 * 会真的拉起浏览器的 tests/smoke.mjs 不在这里,也不在门禁里。
 */

import assert from 'node:assert/strict';

import { ACTION_SPACE, STATUS, buildElementTable, renderElementTable } from '../lib/policy.js';

let passed = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log('ok - ' + label);
  } catch (error) {
    failures.push(`${label} :: ${error?.message ?? String(error)}`);
    console.error('not ok - ' + label + ' :: ' + (error?.message ?? String(error)));
  }
}

/** 一个固定的页面快照 fixture;形状与 lib/snapshot.js 的 reader 输出一致。 */
const SNAPSHOT = {
  url: 'https://example.test/flights',
  title: 'Flights',
  freshness: 'f-1',
  text: 'Round trip  Where from?  San Francisco  Where to?  Departure',
  elements: [
    { index: 1, role: 'button', name: 'Round trip', value: '', disabled: false, kind: 'clickable' },
    {
      index: 2,
      role: 'combobox',
      name: 'Where from?',
      value: 'San Francisco',
      disabled: false,
      kind: 'typeable',
    },
    {
      index: 3,
      role: 'combobox',
      name: 'Where to?',
      value: '',
      disabled: false,
      kind: 'selectable',
    },
    { index: 4, role: 'textbox', name: 'Departure', value: '', disabled: false, kind: 'typeable' },
    { index: 5, role: 'button', name: 'Search', value: '', disabled: true, kind: 'clickable' },
  ],
};

check('动作空间闭合在 8 个操作上', () => {
  assert.deepEqual(
    [...ACTION_SPACE],
    ['CLICK', 'TYPE_TEXT', 'SELECT', 'SCROLL_UP', 'SCROLL_DOWN', 'WAIT', 'DONE', 'BLOCKED'],
  );
});

check('status 闭合在 8 个取值上', () => {
  assert.deepEqual(
    [...STATUS],
    ['done', 'stuck', 'blocked', 'max_steps', 'timeout', 'error', 'uncertain', 'text_unavailable'],
  );
});

check('元素表把每个元素渲染成一行「[n] role name · value」', () => {
  const table = buildElementTable(SNAPSHOT);
  assert.equal(table.lines[0], '[1] button "Round trip"');
  assert.equal(table.lines[1], '[2] combobox "Where from?" · San Francisco');
});

check('元素表保留 index → 元素的映射', () => {
  const table = buildElementTable(SNAPSHOT);
  assert.equal(table.byIndex.get(4).name, 'Departure');
  assert.equal(table.byIndex.get(99), undefined);
});

check('停用的元素不进任何 eligible 列表', () => {
  const table = buildElementTable(SNAPSHOT);
  assert.ok(!table.eligible.CLICK.includes(5), 'disabled 的按钮不该可点');
  assert.deepEqual(table.eligible.CLICK, [1]);
});

check('eligible 按 kind 分派', () => {
  const table = buildElementTable(SNAPSHOT);
  assert.deepEqual(table.eligible.TYPE_TEXT, [2, 4]);
  assert.deepEqual(table.eligible.SELECT, [3]);
});

check('renderElementTable 输出多行文本', () => {
  const table = buildElementTable(SNAPSHOT);
  const text = renderElementTable(table);
  assert.equal(text.split('\n').length, 5);
  assert.match(text, /\[5\] button "Search"/);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败 / 共 ${passed + failures.length} 项`);
  process.exit(1);
}
console.log(`\n全部通过:${passed} 项`);
```

- [ ] **Step 3: 跑测试确认它失败**

Run: `node plugins/browser-operator/tests/policy.test.mjs`
Expected: FAIL —— `Cannot find module '../lib/policy.js'`。

- [ ] **Step 4: 写最小实现**

创建 `plugins/browser-operator/lib/policy.js`:

```js
/**
 * Jev 决策回路的**纯策略层** —— 零 import、零 I/O。
 *
 * 这一层的全部意义是可在离线环境里断言:快照 → 索引元素表 → Jev questions,
 * 以及 Jev 响应 → 校验过的动作。浏览器、网络、凭证都不在这里。
 *
 * @module dsh-browser-operator/policy
 */

/** 闭合的动作空间。策略层只会发出这 8 个操作之一,也只会接受这 8 个之一。 */
export const ACTION_SPACE = Object.freeze([
  'CLICK',
  'TYPE_TEXT',
  'SELECT',
  'SCROLL_UP',
  'SCROLL_DOWN',
  'WAIT',
  'DONE',
  'BLOCKED',
]);

/** 闭合的终止状态。 */
export const STATUS = Object.freeze([
  'done',
  'stuck',
  'blocked',
  'max_steps',
  'timeout',
  'error',
  'uncertain',
  'text_unavailable',
]);

/** 哪些 kind 支持哪些操作。`CLICK` 对 kind 无要求(由 eligible 决定)。 */
const KIND_FOR_OPERATION = {
  TYPE_TEXT: 'typeable',
  SELECT: 'selectable',
};

/**
 * 把快照转成**索引元素表** —— 表给模型看,索引给执行器用。
 *
 * 停用的元素照旧出现在表里(模型需要知道它存在),但不进任何 eligible 列表。
 *
 * @param {{ elements?: object[] }} snapshot
 * @returns {{ lines: string[], byIndex: Map<number, object>, eligible: Record<string, number[]> }}
 */
export function buildElementTable(snapshot) {
  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : [];
  const lines = [];
  const byIndex = new Map();
  const eligible = { CLICK: [], TYPE_TEXT: [], SELECT: [] };

  for (const element of elements) {
    byIndex.set(element.index, element);
    lines.push(renderLine(element));
    if (element.disabled === true) continue;
    if (element.kind === 'clickable') eligible.CLICK.push(element.index);
    for (const [operation, kind] of Object.entries(KIND_FOR_OPERATION)) {
      if (element.kind === kind) eligible[operation].push(element.index);
    }
  }

  return { lines, byIndex, eligible };
}

/** 一行:`[2] combobox "Where from?" · San Francisco`;无值时不带 `· ` 段。 */
function renderLine(element) {
  const label = `[${element.index}] ${element.role} "${element.name}"`;
  const value = typeof element.value === 'string' ? element.value : '';
  return value === '' ? label : `${label} · ${value}`;
}

/** 元素表的模型可见文本。 */
export function renderElementTable(table) {
  return table.lines.join('\n');
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node plugins/browser-operator/tests/policy.test.mjs`
Expected: PASS —— 7 项全过,末行 `全部通过:7 项`。

- [ ] **Step 6: 接线进门禁(三处,一处都不能少)**

`justfile` 的 `test` recipe 末尾追加一行(缩进 4 空格):

```
    node plugins/browser-operator/tests/policy.test.mjs
```

根 `package.json` 的 `scripts.test` 与 `scripts.check` **两个字符串**各在末尾追加:

```
 && node plugins/browser-operator/tests/policy.test.mjs
```

- [ ] **Step 7: 确认门禁真的会跑它**

Run:

```sh
node -e "const s=require('./package.json').scripts; if(!s.test.includes('policy.test.mjs')||!s.check.includes('policy.test.mjs')) throw new Error('根 package.json 少接线'); console.log('root package.json OK')"
grep -c "policy.test.mjs" justfile
```

Expected: 打印 `root package.json OK`,然后 grep 输出 `1`(justfile 里恰好一处)。紧接着 `node plugins/browser-operator/tests/policy.test.mjs` 仍 PASS。

- [ ] **Step 8: 提交**

```bash
git add plugins/browser-operator/package.json plugins/browser-operator/pnpm-lock.yaml plugins/browser-operator/lib/policy.js plugins/browser-operator/tests/policy.test.mjs justfile package.json
git commit -m "feat(browser-operator): 加 Jev 策略层的动作空间与索引元素表"
```

---

## Task 2: Jev 的 state 与 questions

**Files:**

- Modify: `plugins/browser-operator/lib/policy.js`
- Modify: `plugins/browser-operator/tests/policy.test.mjs`

**Interfaces:**

- Consumes: `buildElementTable(snapshot) -> table`(Task 1)。
- Produces:
  - `buildState({ goal, snapshot, table, steps }) -> object` —— 交给 `systemOne({ state })` 的那个 state。
  - `buildQuestions({ goal, table }) -> Record<string, object>` —— 交给 `systemOne({ questions })` 的那个 questions。键固定为 `operation` / `click_target` / `type_text_target` / `select_target` / `goal_met` / `stuck`。

- [ ] **Step 1: 写失败的测试**

在 `tests/policy.test.mjs` 的 import 行补 `buildQuestions, buildState`,并在文件末尾(汇总之前)追加:

```js
check('state 带上 goal、当前 URL/标题、元素表与已走过的步数', () => {
  const table = buildElementTable(SNAPSHOT);
  const state = buildState({
    goal: 'Find one-way flights',
    snapshot: SNAPSHOT,
    table,
    steps: [{ step: 1, operation: 'CLICK', targetIndex: 1, reason: '', confidence: 0.9 }],
  });
  assert.equal(state.goal, 'Find one-way flights');
  assert.equal(state.url, SNAPSHOT.url);
  assert.equal(state.title, SNAPSHOT.title);
  assert.match(state.elementTable, /\[1\] button "Round trip"/);
  assert.equal(state.steps.length, 1);
});

check('questions 的键恰好是那六个', () => {
  const questions = buildQuestions({ goal: 'g', table: buildElementTable(SNAPSHOT) });
  assert.deepEqual(Object.keys(questions).sort(), [
    'click_target',
    'goal_met',
    'operation',
    'select_target',
    'stuck',
    'type_text_target',
  ]);
});

check('每个问题都带 type 判别字段,且 noul 不带 criteria', () => {
  const questions = buildQuestions({ goal: 'g', table: buildElementTable(SNAPSHOT) });
  for (const [name, question] of Object.entries(questions)) {
    assert.ok(['choice', 'noul'].includes(question.type), `${name} 的 type 不对:${question.type}`);
  }
  assert.equal(questions.operation.type, 'choice');
  assert.equal(questions.goal_met.type, 'noul');
  assert.ok(!('criteria' in questions.goal_met), 'noul 问题不该带 criteria');
});

check('questions 只装当前合法的操作与目标', () => {
  const table = buildElementTable(SNAPSHOT);
  const questions = buildQuestions({ goal: 'g', table });
  assert.deepEqual(Object.keys(questions.operation.criteria), [...ACTION_SPACE]);
  // criteria 的键就是元素序号的十进制写法 —— parseDecision 靠它把回答映射回索引。
  assert.deepEqual(Object.keys(questions.click_target.criteria), table.eligible.CLICK.map(String));
  assert.deepEqual(
    Object.keys(questions.type_text_target.criteria),
    table.eligible.TYPE_TEXT.map(String),
  );
  assert.deepEqual(
    Object.keys(questions.select_target.criteria),
    table.eligible.SELECT.map(String),
  );
});

check('criteria 的值就是元素表里那一行', () => {
  const questions = buildQuestions({ goal: 'g', table: buildElementTable(SNAPSHOT) });
  assert.equal(questions.click_target.criteria['1'], '[1] button "Round trip"');
});

check('没有合法目标时依然给出 questions(交给 Jev 选 DONE/BLOCKED)', () => {
  const table = buildElementTable({ elements: [] });
  const questions = buildQuestions({ goal: 'g', table });
  assert.deepEqual(questions.click_target.criteria, {});
  assert.deepEqual(Object.keys(questions.operation.criteria), [...ACTION_SPACE]);
});

check('goal_met 与 stuck 是带实质文案的概率问题', () => {
  const questions = buildQuestions({ goal: 'g', table: buildElementTable(SNAPSHOT) });
  assert.ok(questions.goal_met.instructions.length > 0);
  assert.ok(questions.stuck.instructions.length > 0);
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `node plugins/browser-operator/tests/policy.test.mjs`
Expected: FAIL —— `buildState is not a function`(或 import 报未导出)。

- [ ] **Step 3: 写实现**

在 `lib/policy.js` 末尾追加:

```js
/** 交给 Jev 的 state。键名是代码用的,模型只看得到内容。 */
export function buildState({ goal, snapshot, table, steps }) {
  return {
    goal,
    url: snapshot?.url ?? '',
    title: snapshot?.title ?? '',
    visibleText: typeof snapshot?.text === 'string' ? snapshot.text : '',
    elementTable: renderElementTable(table),
    steps: Array.isArray(steps) ? steps : [],
  };
}

/**
 * 8 个操作的说明文案。
 *
 * `@typesafe-ai/sdk` 的 `ChoiceCriteria` 是**「标签 → 描述」的对象**(不是数组),
 * 所以 choice 的 criteria 就得长这样:键是模型要原样回给我们的标签。
 */
const OPERATION_HINTS = Object.freeze({
  CLICK: 'Press one clickable element.',
  TYPE_TEXT: 'Fill one typeable element with a verbatim fragment of the goal.',
  SELECT: 'Choose an option in one selectable element.',
  SCROLL_UP: 'Scroll the page up. Makes no selection.',
  SCROLL_DOWN: 'Scroll the page down. Makes no selection.',
  WAIT: 'Wait for the page to settle. Makes no selection.',
  DONE: 'The goal is already met; stop.',
  BLOCKED: 'A human is required (login, SSO, captcha); stop.',
});

/**
 * 一次请求里同时问完 operation 与所有兼容 target —— 两个决策,一次网络往返。
 *
 * ⚠ 形状必须与 SDK 的 `Question` 联合一致(见 `@typesafe-ai/sdk/dist/index.d.mts`):
 * 每个问题都带 `type`;`choice` 的 `criteria` 是「标签 → 描述」的对象;`noul` 不带
 * criteria。**标签就是元素序号的十进制写法** —— `parseDecision` 靠它把回答映射回索引。
 *
 * @param {{ goal: string, table: object }} options
 */
export function buildQuestions({ goal, table }) {
  const criteriaFor = (indexes) => {
    const criteria = {};
    for (const index of indexes) {
      criteria[String(index)] = renderLine(table.byIndex.get(index));
    }
    return criteria;
  };
  const operationCriteria = {};
  for (const operation of ACTION_SPACE) operationCriteria[operation] = OPERATION_HINTS[operation];

  return {
    operation: {
      type: 'choice',
      instructions:
        `Choose the single next operation that best advances this goal: ${goal}\n` +
        'Only operations that are legal on the current page are offered. ' +
        'CLICK presses a clickable element, TYPE_TEXT fills a typeable one, SELECT picks an ' +
        'option, SCROLL/WAIT make no selection, DONE means the goal is already met, and ' +
        'BLOCKED means a human is required (login, SSO, captcha).',
      criteria: operationCriteria,
    },
    click_target: {
      type: 'choice',
      instructions:
        'Which element should be clicked? Answer with the element number. ' +
        'Only meaningful when operation is CLICK.',
      criteria: criteriaFor(table.eligible.CLICK),
    },
    type_text_target: {
      type: 'choice',
      instructions:
        'Which element should receive text? Answer with the element number. ' +
        'Only meaningful when operation is TYPE_TEXT.',
      criteria: criteriaFor(table.eligible.TYPE_TEXT),
    },
    select_target: {
      type: 'choice',
      instructions:
        'Which element should be selected? Answer with the element number. ' +
        'Only meaningful when operation is SELECT.',
      criteria: criteriaFor(table.eligible.SELECT),
    },
    goal_met: {
      type: 'noul',
      instructions: `The goal is already satisfied by the page as it stands: ${goal}`,
    },
    stuck: {
      type: 'noul',
      instructions:
        'No offered operation can make further progress on this goal, and repeating the ' +
        'last operation would not help.',
    },
  };
}
```

> `criteria` 是**对象**(「标签 → 描述」)而不是数组,这是 SDK 的 `ChoiceCriteria` 规定的;`noul` 问题则完全不带 criteria。白名单校验不看 criteria,而是看 `table.eligible[operation]`(Task 3)—— 那才是执行器的权威,模型回什么标签都越不过它。

- [ ] **Step 4: 跑测试确认通过**

Run: `node plugins/browser-operator/tests/policy.test.mjs`
Expected: PASS —— 14 项(7 项来自 Task 1 + Task 2 自己的 7 项)。判定以 exit 0 与「无 not ok」为准,下面的数字只是参照。

- [ ] **Step 5: 提交**

```bash
git add plugins/browser-operator/lib/policy.js plugins/browser-operator/tests/policy.test.mjs
git commit -m "feat(browser-operator): Jev 回路构造 state 与投机扇出 questions"
```

---

## Task 3: 决策解析与白名单校验

**Files:**

- Modify: `plugins/browser-operator/lib/policy.js`
- Modify: `plugins/browser-operator/tests/policy.test.mjs`

**Interfaces:**

- Consumes: `table`(Task 1)、`buildQuestions`(Task 2)。
- Produces:
  - `parseDecision(response) -> { operation, clickTarget, typeTextTarget, selectTarget, goalMet, stuck }` —— 响应形状不对时 **throw**(`new Error('...')`,消息以 `browser-operator:` 开头)。
  - `validateDecision(decision, table) -> { ok: true, targetIndex: number|null } | { ok: false, reason: string }`

- [ ] **Step 1: 写失败的测试**

补 import `parseDecision, validateDecision`,追加:

```js
/**
 * 一个形状正确的 Jev 响应 fixture。
 *
 * 注意 target 的 `choice` 是**字符串标签**(SDK 的 `ChoiceResponse.choice` 是
 * `keyof T & string`),不是数字 —— 标签就是 criteria 的键,也就是元素序号。
 */
const RESPONSE = {
  answers: {
    operation: { choice: 'CLICK', confidence: 0.91 },
    click_target: { choice: '1', confidence: 0.88 },
    type_text_target: { choice: '2', confidence: 0.4 },
    select_target: { choice: '3', confidence: 0.3 },
    goal_met: { noul: 0.02 },
    stuck: { noul: 0.05 },
  },
};

check('解析出 operation 与各自的 target 概率', () => {
  const decision = parseDecision(RESPONSE);
  assert.equal(decision.operation, 'CLICK');
  assert.equal(decision.clickTarget, 1);
  assert.equal(decision.goalMet, 0.02);
  assert.equal(decision.stuck, 0.05);
  assert.equal(decision.confidence, 0.91);
});

check('未知 operation 直接抛错(不接受模型自创的动作)', () => {
  const bad = {
    answers: { ...RESPONSE.answers, operation: { choice: 'NAVIGATE', confidence: 1 } },
  };
  assert.throws(() => parseDecision(bad), /browser-operator:.*NAVIGATE/);
});

check('响应缺 answers 时抛错', () => {
  assert.throws(() => parseDecision({}), /browser-operator:/);
});

check('CLICK 的目标落在本次提供的白名单里 → 通过', () => {
  const table = buildElementTable(SNAPSHOT);
  assert.deepEqual(validateDecision(parseDecision(RESPONSE), table), { ok: true, targetIndex: 1 });
});

check('CLICK 的目标不在白名单(越界)→ 拒绝', () => {
  const table = buildElementTable(SNAPSHOT);
  const decision = { ...parseDecision(RESPONSE), clickTarget: 999 };
  const verdict = validateDecision(decision, table);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /999/);
});

check('CLICK 落在停用元素上 → 拒绝', () => {
  const table = buildElementTable(SNAPSHOT);
  const decision = { ...parseDecision(RESPONSE), clickTarget: 5 };
  const verdict = validateDecision(decision, table);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /不可用|停用/);
});

check('CLICK 落在不可点的 kind 上 → 拒绝', () => {
  const table = buildElementTable(SNAPSHOT);
  const decision = { ...parseDecision(RESPONSE), clickTarget: 4 }; // textbox
  const verdict = validateDecision(decision, table);
  assert.equal(verdict.ok, false);
});

check('DONE / BLOCKED 不需要目标', () => {
  const table = buildElementTable(SNAPSHOT);
  for (const operation of ['DONE', 'BLOCKED', 'SCROLL_UP', 'WAIT']) {
    const decision = { ...parseDecision(RESPONSE), operation };
    assert.deepEqual(validateDecision(decision, table), { ok: true, targetIndex: null });
  }
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `node plugins/browser-operator/tests/policy.test.mjs`
Expected: FAIL —— `parseDecision is not a function`。

- [ ] **Step 3: 写实现**

在 `lib/policy.js` 末尾追加:

```js
/** 需要目标的三个操作与它们各自读取的字段名。 */
const TARGET_FOR_OPERATION = {
  CLICK: 'clickTarget',
  TYPE_TEXT: 'typeTextTarget',
  SELECT: 'selectTarget',
};

/** 从 answers 里安全取一个 choice 值;缺了返回 undefined。 */
function choiceOf(answers, key) {
  const value = answers?.[key]?.choice;
  return value === undefined ? undefined : value;
}

/**
 * 从 answers 里安全取一个概率。`noul` 是概率原语的字段名;`choice` 类回答把
 * 概率放在 `confidence` 上,两处都要认。都缺时返回 0 —— 缺概率不该把回路憋死。
 */
function probabilityOf(answers, key) {
  const answer = answers?.[key];
  const value = typeof answer?.noul === 'number' ? answer.noul : answer?.confidence;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 元素目标的回答是 criteria 的**标签**(字符串),而标签就是元素序号的十进制写法。
 * 不是纯数字的标签一律当作「没给目标」返回 undefined —— 由 validateDecision 拒绝。
 */
function indexOfLabel(label) {
  return typeof label === 'string' && /^\d+$/.test(label) ? Number(label) : undefined;
}

/**
 * 解析一次 Jev 响应。形状不对就**抛** —— 宁可停下,也不要拿半个决策去点页面。
 * @param {object} response `systemOne` 的返回值
 */
export function parseDecision(response) {
  const answers = response?.answers;
  if (answers === null || typeof answers !== 'object') {
    throw new Error('browser-operator: Jev 响应里没有 answers');
  }
  const operation = choiceOf(answers, 'operation');
  if (!ACTION_SPACE.includes(operation)) {
    throw new Error(`browser-operator: Jev 给出了动作空间外的 operation: ${String(operation)}`);
  }
  return {
    operation,
    clickTarget: indexOfLabel(choiceOf(answers, 'click_target')),
    typeTextTarget: indexOfLabel(choiceOf(answers, 'type_text_target')),
    selectTarget: indexOfLabel(choiceOf(answers, 'select_target')),
    goalMet: probabilityOf(answers, 'goal_met'),
    stuck: probabilityOf(answers, 'stuck'),
    confidence: probabilityOf(answers, 'operation'),
  };
}

/**
 * 执行前校验:操作合法、目标在本次提供的白名单里、且当前真的可用。
 * 这是「模型输出永远不直接变成选择器 / 坐标 / JS」的那道闸。
 *
 * @returns `{ ok: true, targetIndex: number|null }` 或 `{ ok: false, reason: string }`
 */
export function validateDecision(decision, table) {
  const field = TARGET_FOR_OPERATION[decision.operation];
  if (field === undefined) return { ok: true, targetIndex: null };

  const targetIndex = decision[field];
  if (!Number.isInteger(targetIndex)) {
    return {
      ok: false,
      reason: `${decision.operation} 需要一个整数目标,拿到 ${String(targetIndex)}`,
    };
  }

  const allowed = table.eligible[decision.operation];
  if (!allowed.includes(targetIndex)) {
    const element = table.byIndex.get(targetIndex);
    if (element === undefined) {
      return { ok: false, reason: `目标 ${targetIndex} 不在本次观察到的元素里` };
    }
    return {
      ok: false,
      reason: `目标 ${targetIndex} 不可用(停用或不是 ${decision.operation} 支持的类型)`,
    };
  }

  return { ok: true, targetIndex };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node plugins/browser-operator/tests/policy.test.mjs`
Expected: PASS —— 22 项。判定以 exit 0 与「无 not ok」为准。

- [ ] **Step 5: 提交**

```bash
git add plugins/browser-operator/lib/policy.js plugins/browser-operator/tests/policy.test.mjs
git commit -m "feat(browser-operator): 解析并白名单校验 Jev 的决策"
```

---

## Task 4: `TYPE_TEXT` 的逐字候选

**Files:**

- Modify: `plugins/browser-operator/lib/policy.js`
- Modify: `plugins/browser-operator/tests/policy.test.mjs`

**Interfaces:**

- Consumes: 无。
- Produces: `textCandidates(goal) -> string[]` —— 从 goal 里切出的**逐字片段**候选,保持出现顺序、去重、剔除过短片段。

- [ ] **Step 1: 写失败的测试**

补 import `textCandidates`,追加:

```js
check('从 goal 里切出逐字候选', () => {
  const candidates = textCandidates('Fly from Zurich to London on 2026-09-20, one adult');
  assert.ok(candidates.includes('Zurich'));
  assert.ok(candidates.includes('London'));
  assert.ok(candidates.includes('2026-09-20'));
});

check('候选保持出现顺序并去重', () => {
  const candidates = textCandidates('Zurich then London then Zurich');
  assert.deepEqual(candidates, ['Zurich', 'then', 'London']);
});

check('剔除过短片段(1 个字符的词不要)', () => {
  const candidates = textCandidates('Fly from Zurich to London');
  assert.ok(!candidates.includes('to'));
});

check('空 goal 给出空候选(调用方据此回 text_unavailable)', () => {
  assert.deepEqual(textCandidates(''), []);
  assert.deepEqual(textCandidates(undefined), []);
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `node plugins/browser-operator/tests/policy.test.mjs`
Expected: FAIL —— `textCandidates is not a function`。

- [ ] **Step 3: 写实现**

在 `lib/policy.js` 末尾追加:

```js
/** 逐字候选片段的最小长度。2 个字符的英文虚词(of / to / on / in)当候选没有意义。 */
const MIN_CANDIDATE_CHARS = 3;
/** 逐字候选的数量上限,挡住超长 goal 把 questions 撑爆。 */
const MAX_CANDIDATES = 20;

/**
 * 从 goal 里切出**逐字片段**候选。
 *
 * 这是本插件对 `TYPE_TEXT` 的全部策略:文本必须原样来自 goal,不是生成的。
 * 调用方把候选交给 Jev 选一个;候选为空时该步只能停下(`text_unavailable`)。
 *
 * 切分口径:按空白与常见标点断词,保留出现顺序,去重,丢弃过短片段。
 *
 * @param {string|undefined} goal
 * @returns {string[]}
 */
export function textCandidates(goal) {
  if (typeof goal !== 'string' || goal.trim() === '') return [];
  const seen = new Set();
  const candidates = [];
  for (const raw of goal.split(/[\s,;，、。:：!?！？()（）"'`]+/u)) {
    const piece = raw.replace(/[.]+$/u, '');
    if (piece.length < MIN_CANDIDATE_CHARS) continue;
    if (seen.has(piece)) continue;
    seen.add(piece);
    candidates.push(piece);
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return candidates;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node plugins/browser-operator/tests/policy.test.mjs`
Expected: PASS —— 26 项。判定以 exit 0 与「无 not ok」为准。

- [ ] **Step 5: 提交**

```bash
git add plugins/browser-operator/lib/policy.js plugins/browser-operator/tests/policy.test.mjs
git commit -m "feat(browser-operator): TYPE_TEXT 只从 goal 取逐字候选"
```

---

## Task 5: 停止判据与 `runLoop`

**Files:**

- Create: `plugins/browser-operator/lib/loop.js`
- Modify: `plugins/browser-operator/tests/policy.test.mjs`

**Interfaces:**

- Consumes: `buildElementTable` / `buildState` / `buildQuestions` / `parseDecision` / `validateDecision` / `textCandidates`(Tasks 1–4)。
- Produces:
  - `evaluateStop({ attempts, elapsedMs, maxSteps, budgetMs, consecutiveLowConfidence }) -> { stop: true, status: string } | { stop: false }` —— `attempts` 数的是**观察 → 决策**的轮次(校验失败后的重新观察也计一个),不是成功执行的步数。
  - `runLoop({ goal, maxSteps, budgetMs, now, observe, decide, execute }) -> { status, steps, goalMet, elapsedMs, error? }`
    - `observe() -> Promise<snapshot>`
    - `decide({ goal, state, questions, signal }) -> Promise<response>`
    - `execute({ operation, targetIndex, text, snapshot, table }) -> Promise<void>`
    - `now() -> number`(毫秒;注入以便测试)

- [ ] **Step 1: 写失败的测试**

在 `tests/policy.test.mjs` 顶部补 import:

```js
import { evaluateStop, runLoop } from '../lib/loop.js';
```

追加:

```js
check('用尽 maxSteps 时停下,status 为 max_steps', () => {
  assert.deepEqual(
    evaluateStop({
      attempts: 12,
      elapsedMs: 0,
      maxSteps: 12,
      budgetMs: 100000,
      consecutiveLowConfidence: 0,
    }),
    { stop: true, status: 'max_steps' },
  );
});

check('超预算时停下,status 为 timeout', () => {
  assert.deepEqual(
    evaluateStop({
      attempts: 0,
      elapsedMs: 100000,
      maxSteps: 12,
      budgetMs: 100000,
      consecutiveLowConfidence: 0,
    }),
    { stop: true, status: 'timeout' },
  );
});

check('连续 3 步低置信度时停下,status 为 uncertain', () => {
  assert.deepEqual(
    evaluateStop({
      attempts: 0,
      elapsedMs: 0,
      maxSteps: 12,
      budgetMs: 100000,
      consecutiveLowConfidence: 3,
    }),
    { stop: true, status: 'uncertain' },
  );
});

check('都没到时不停止', () => {
  assert.deepEqual(
    evaluateStop({
      attempts: 0,
      elapsedMs: 0,
      maxSteps: 12,
      budgetMs: 100000,
      consecutiveLowConfidence: 0,
    }),
    { stop: false },
  );
});

check('校验失败后的重新观察也计一个单位(ADR-0009 决策点 6)', async () => {
  // 每次都返回越界目标:每一步都会重试 3 轮,但 attempts 也随之上涨,
  // 所以 maxSteps=3 时应该在第 3 次尝试后停下,而不是无限重试。
  const bad = {
    answers: {
      operation: { choice: 'CLICK', confidence: 0.9 },
      click_target: { choice: '999', confidence: 0.9 },
      goal_met: { noul: 0.1 },
      stuck: { noul: 0.1 },
    },
  };
  let decides = 0;
  const result = await runLoop({
    goal: 'g',
    maxSteps: 3,
    budgetMs: 100000,
    now: () => 0,
    observe: async () => SNAPSHOT,
    decide: async () => {
      decides += 1;
      return bad;
    },
    execute: async () => {},
  });
  assert.ok(result.status === 'max_steps' || result.status === 'error');
  assert.ok(decides <= 4, `不该无限重试,实际调了 ${decides} 次`);
});

/** 回路测试用的假依赖:一次 CLICK,然后 DONE。 */
function fakeDeps({ responses, snapshot = SNAPSHOT }) {
  let clock = 0;
  const executed = [];
  const queue = [...responses];
  return {
    executed,
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    observe: async () => snapshot,
    decide: async () => queue.shift(),
    execute: async (action) => {
      executed.push(action);
    },
  };
}

const CLICK_THEN_DONE = [
  {
    answers: {
      operation: { choice: 'CLICK', confidence: 0.9 },
      click_target: { choice: '1', confidence: 0.9 },
      goal_met: { noul: 0.1 },
      stuck: { noul: 0.1 },
    },
  },
  {
    answers: {
      operation: { choice: 'DONE', confidence: 0.95 },
      goal_met: { noul: 0.95 },
      stuck: { noul: 0.02 },
    },
  },
];

async function runWith(deps, overrides = {}) {
  return runLoop({
    goal: 'g',
    maxSteps: 12,
    budgetMs: 100000,
    now: deps.now,
    observe: deps.observe,
    decide: deps.decide,
    execute: deps.execute,
    ...overrides,
  });
}

check('回路执行 CLICK 后因 goal_met 停止', async () => {
  const deps = fakeDeps({ responses: CLICK_THEN_DONE });
  const result = await runWith(deps);
  assert.equal(result.status, 'done');
  assert.equal(result.steps.length, 2);
  assert.equal(deps.executed.length, 1);
  // 只断言这三个字段:action 上还挂着 snapshot 与 table(执行器要用)。
  assert.equal(deps.executed[0].operation, 'CLICK');
  assert.equal(deps.executed[0].targetIndex, 1);
  assert.equal(deps.executed[0].text, undefined);
});

check('DONE 不声称目标真的达成 —— 只回报概率', async () => {
  const deps = fakeDeps({ responses: CLICK_THEN_DONE });
  const result = await runWith(deps);
  assert.equal(result.goalMet, 0.95);
  assert.ok(!('success' in result), '不该有 success 这种断言');
});

check('越界目标被拒后重新观察,不执行;重试 2 次后 error', async () => {
  const bad = {
    answers: {
      operation: { choice: 'CLICK', confidence: 0.9 },
      click_target: { choice: '999', confidence: 0.9 },
      goal_met: { noul: 0.1 },
      stuck: { noul: 0.1 },
    },
  };
  const deps = fakeDeps({ responses: [bad, bad, bad] });
  const result = await runWith(deps);
  assert.equal(result.status, 'error');
  assert.equal(deps.executed.length, 0, '越界目标一次都不该执行');
});

check('BLOCKED 映射到独立的 blocked 状态,与 stuck 分开', async () => {
  const deps = fakeDeps({
    responses: [
      { answers: { operation: { choice: 'BLOCKED', confidence: 0.9 }, stuck: { noul: 0.1 } } },
    ],
  });
  const result = await runWith(deps);
  assert.equal(result.status, 'blocked');
});

check('stuck 高置信时停下,status 为 stuck', async () => {
  const deps = fakeDeps({
    responses: [
      { answers: { operation: { choice: 'WAIT', confidence: 0.9 }, stuck: { noul: 0.9 } } },
    ],
  });
  const result = await runWith(deps);
  assert.equal(result.status, 'stuck');
});

check('decide 抛错时立即停,不静默重试', async () => {
  let calls = 0;
  const result = await runLoop({
    goal: 'g',
    maxSteps: 12,
    budgetMs: 100000,
    now: () => 0,
    observe: async () => SNAPSHOT,
    decide: async () => {
      calls += 1;
      throw new Error('boom');
    },
    execute: async () => {},
  });
  assert.equal(result.status, 'error');
  assert.equal(calls, 1, '抛错后不该再调一次');
  assert.match(result.error, /boom/);
});

check('TYPE_TEXT 没有逐字候选时停下,status 为 text_unavailable', async () => {
  const deps = fakeDeps({
    responses: [
      {
        answers: {
          operation: { choice: 'TYPE_TEXT', confidence: 0.9 },
          type_text_target: { choice: '4', confidence: 0.9 },
          goal_met: { noul: 0.1 },
          stuck: { noul: 0.1 },
        },
      },
    ],
  });
  const result = await runWith(deps, { goal: '' });
  assert.equal(result.status, 'text_unavailable');
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `node plugins/browser-operator/tests/policy.test.mjs`
Expected: FAIL —— `Cannot find module '../lib/loop.js'`。

- [ ] **Step 3: 写实现**

创建 `plugins/browser-operator/lib/loop.js`:

```js
/**
 * Jev 决策回路的**控制流**。
 *
 * `observe` / `decide` / `execute` / `now` 全部注入,所以这个文件不 import 任何
 * I/O,回路的全部行为都能离线断言(见 tests/policy.test.mjs)。
 *
 * @module dsh-browser-operator/loop
 */

import {
  buildElementTable,
  buildQuestions,
  buildState,
  parseDecision,
  textCandidates,
  validateDecision,
} from './policy.js';

/** operation 的置信度低于这个值就算「低置信度」。 */
const LOW_CONFIDENCE = 0.35;
/** 连续这么多步低置信度就停。 */
const LOW_CONFIDENCE_RUN = 3;
/** 一次动作的校验失败最多重试这么多轮(每轮重新观察)。 */
const MAX_VALIDATION_RETRIES = 2;
/** goal_met / stuck 达到这个概率就停。 */
const STOP_PROBABILITY = 0.8;

/**
 * 该不该停。**纯函数**,顺序即优先级:预算 > 步数 > 低置信度。
 *
 * `attempts` 数的是**观察 → 决策**的轮次,不是成功执行的步数 —— 校验失败后的
 * 重新观察同样消耗一个单位(ADR-0009 决策点 6),否则一个持续越界的目标可以把
 * 回路拖成无界重试。
 *
 * @returns `{ stop: true, status }` 或 `{ stop: false }`
 */
export function evaluateStop({
  attempts,
  elapsedMs,
  maxSteps,
  budgetMs,
  consecutiveLowConfidence,
}) {
  if (elapsedMs >= budgetMs) return { stop: true, status: 'timeout' };
  if (attempts >= maxSteps) return { stop: true, status: 'max_steps' };
  if (consecutiveLowConfidence >= LOW_CONFIDENCE_RUN) return { stop: true, status: 'uncertain' };
  return { stop: false };
}

/**
 * 跑一次目标级回路。
 *
 * @param {object} options
 * @param {string} options.goal
 * @param {number} options.maxSteps
 * @param {number} options.budgetMs
 * @param {() => number} options.now
 * @param {() => Promise<object>} options.observe
 * @param {(request: { goal: string, state: object, questions: object }) => Promise<object>} options.decide
 * @param {(action: { operation: string, targetIndex: number|null, text: string|undefined, snapshot: object, table: object }) => Promise<void>} options.execute
 * @returns {Promise<{ status: string, steps: object[], goalMet: number, elapsedMs: number, error?: string }>}
 */
export async function runLoop({ goal, maxSteps, budgetMs, now, observe, decide, execute }) {
  const startedAt = now();
  const steps = [];
  let attempts = 0;
  let consecutiveLowConfidence = 0;
  let goalMet = 0;

  try {
    for (;;) {
      const elapsedMs = now() - startedAt;
      const verdict = evaluateStop({
        attempts,
        elapsedMs,
        maxSteps,
        budgetMs,
        consecutiveLowConfidence,
      });
      if (verdict.stop) return finish(verdict.status, steps, goalMet, elapsedMs);

      // 观察 → 决策。校验失败时整轮重来,最多 MAX_VALIDATION_RETRIES 次;
      // 每一轮都计一个 attempts 单位,包括失败的那些轮。
      let action = null;
      let lastReason = '';
      for (let retry = 0; retry <= MAX_VALIDATION_RETRIES; retry += 1) {
        attempts += 1;
        if (attempts > maxSteps) return finish('max_steps', steps, goalMet, now() - startedAt);
        const snapshot = await observe();
        const table = buildElementTable(snapshot);
        const state = buildState({ goal, snapshot, table, steps });
        const questions = buildQuestions({ goal, table });
        const decision = parseDecision(await decide({ goal, state, questions, snapshot }));

        if (decision.goalMet >= STOP_PROBABILITY) {
          goalMet = decision.goalMet;
          return finish('done', steps, goalMet, now() - startedAt);
        }
        if (decision.stuck >= STOP_PROBABILITY) {
          return finish('stuck', steps, decision.goalMet, now() - startedAt);
        }
        if (decision.operation === 'BLOCKED') {
          return finish('blocked', steps, decision.goalMet, now() - startedAt);
        }
        if (decision.operation === 'DONE') {
          return finish('done', steps, decision.goalMet, now() - startedAt);
        }

        const checked = validateDecision(decision, table);
        if (!checked.ok) {
          lastReason = checked.reason;
          continue; // 重新观察
        }

        // TYPE_TEXT 的文本只能来自 goal 的逐字候选。
        let text;
        if (decision.operation === 'TYPE_TEXT') {
          const candidates = textCandidates(goal);
          if (candidates.length === 0) {
            return finish('text_unavailable', steps, decision.goalMet, now() - startedAt);
          }
          text = candidates[0];
        }

        action = {
          operation: decision.operation,
          targetIndex: checked.targetIndex,
          text,
          snapshot,
          table,
        };
        const record = {
          step: steps.length + 1,
          operation: decision.operation,
          reason: lastReason,
          confidence: decision.confidence,
        };
        // targetIndex 只有 CLICK / TYPE_TEXT / SELECT 才有。**不写 null** —— 工具输出的
        // schema 就得声明可空整数,而 dsh-tools 的 schema 子集不认 `type: [...]` 联合。
        if (checked.targetIndex !== null) record.targetIndex = checked.targetIndex;
        if (text !== undefined) record.text = text;
        steps.push(record);
        consecutiveLowConfidence =
          decision.confidence < LOW_CONFIDENCE ? consecutiveLowConfidence + 1 : 0;
        break;
      }

      if (action === null) {
        return finish('error', steps, goalMet, now() - startedAt, `动作校验连续失败:${lastReason}`);
      }
      await execute(action);

      const elapsedAfter = now() - startedAt;
      if (elapsedAfter >= budgetMs) return finish('timeout', steps, goalMet, elapsedAfter);
    }
  } catch (error) {
    return finish('error', steps, goalMet, now() - startedAt, error?.message ?? String(error));
  }
}

/** 统一的收尾形状。`status: 'done'` 只表示回路停了,**不表示目标真的达成**。 */
function finish(status, steps, goalMet, elapsedMs, error) {
  const result = { status, steps, goalMet, elapsedMs };
  if (error !== undefined) result.error = error;
  return result;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node plugins/browser-operator/tests/policy.test.mjs`
Expected: PASS —— 约 38 项。判定以 exit 0 与「无 not ok」为准。

- [ ] **Step 5: 提交**

```bash
git add plugins/browser-operator/lib/loop.js plugins/browser-operator/tests/policy.test.mjs
git commit -m "feat(browser-operator): 加可注入依赖的 Jev 回路与停止判据"
```

---

## Task 6: 页面快照 reader

**Files:**

- Create: `plugins/browser-operator/lib/snapshot.js`
- Modify: `plugins/browser-operator/tests/policy.test.mjs`

**Interfaces:**

- Consumes: 无。
- Produces:
  - `ELEMENT_SELECTOR: string` —— 可交互元素的唯一选择器。
  - `MAX_ELEMENTS = 200`
  - `pageProbe(options)` —— **在页面上下文**执行的唯一探测函数,无闭包依赖。两种模式:`options.index` 是数字时返回该序号的 DOM 元素(或 `null`),否则返回完整快照。
  - `readSnapshot(page, selector?, limit?) -> Promise<snapshot>`
  - `elementHandle(page, index, selector?) -> Promise<ElementHandle>` —— 序号在执行前失效时 throw。
  - `snapshot` 形状即 Task 1 声明的那个。

- [ ] **Step 1: 写失败的测试**

补 `import { ELEMENT_SELECTOR, MAX_ELEMENTS, elementHandle, pageProbe, readSnapshot } from '../lib/snapshot.js';`,追加:

```js
check('readSnapshot 把选择器作为参数传进页面,并透传结果', async () => {
  const canned = { ...SNAPSHOT };
  let seen;
  const page = {
    evaluate: async (fn, arg) => {
      seen = arg;
      return canned;
    },
  };
  assert.deepEqual(await readSnapshot(page), canned);
  assert.equal(seen.selector, ELEMENT_SELECTOR);
  assert.equal(seen.limit, MAX_ELEMENTS);
  assert.equal(seen.index, undefined, '读快照时不该带 index');
});

check('page.evaluate 返回非对象时抛错', async () => {
  const page = { evaluate: async () => null };
  await assert.rejects(() => readSnapshot(page), /browser-operator:/);
});

check('elementHandle 用同一个选择器按序号解析元素', async () => {
  const fakeElement = { click: async () => {} };
  let seen;
  const page = {
    evaluateHandle: async (fn, arg) => {
      seen = arg;
      return { asElement: () => fakeElement };
    },
  };
  assert.equal(await elementHandle(page, 3), fakeElement);
  assert.equal(seen.selector, ELEMENT_SELECTOR);
  assert.equal(seen.index, 3);
});

check('元素在执行前消失时抛错', async () => {
  const page = {
    evaluateHandle: async () => ({ asElement: () => null, dispose: async () => {} }),
  };
  await assert.rejects(() => elementHandle(page, 3), /元素 3/);
});

check('pageProbe 真的能被序列化进页面并跑通读模式', () => {
  // 只查源码里有没有 `require(` / `import` 是**空转的**:它检测不出函数体引用了
  // 模块作用域的标识符,而那正是 Playwright 序列化时唯一会炸的东西。
  // 这里复刻 Playwright 的做法:只拿函数源码,在一个**只有页面全局、没有模块作用域**
  // 的环境里重新求值,再拿假 DOM 真调一次读模式。
  const factory = new Function(
    'document',
    'window',
    'location',
    `return (${pageProbe.toString()});`,
  );
  const fakeDocument = {
    querySelectorAll: () => [
      {
        tagName: 'BUTTON',
        innerText: 'Round trip',
        value: '',
        disabled: false,
        isContentEditable: false,
        getAttribute: () => null,
        getBoundingClientRect: () => ({ width: 10, height: 10 }),
      },
    ],
  };
  const fakeWindow = { getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) };
  const fn = factory(fakeDocument, fakeWindow, { href: 'https://example.test/' });
  const snapshot = fn({ selector: ELEMENT_SELECTOR, limit: MAX_ELEMENTS });
  assert.equal(snapshot.elements.length, 1);
  assert.equal(snapshot.elements[0].name, 'Round trip');
});
```

> ⚠ **`pageProbe` 的函数体里不许出现任何模块作用域标识符,连数字常量也不行。** Playwright 只把函数源码序列化进页面,`120` 这类名字在页面里**不存在**,读模式会对**任何非空页面**抛 `ReferenceError`。字符串截断上限就写**字面量**(120 / 200 / 4000),或者通过 `options` 传进去 —— 上面这条用例就是用来钉死这一点的。

> **为什么读快照与解析元素共用一个函数**:序号是「按同一个选择器 + 同一个可见性判定数出来的第 n 个」。两处各写一份,迟早会在某次改动后错位 —— 那时点到的是**别的元素**。共用一个函数,错位在结构上不可能发生。

- [ ] **Step 2: 跑测试确认它失败**

Run: `node plugins/browser-operator/tests/policy.test.mjs`
Expected: FAIL —— `Cannot find module '../lib/snapshot.js'`。

- [ ] **Step 3: 写实现**

创建 `plugins/browser-operator/lib/snapshot.js`:

```js
/**
 * 页面快照与元素解析。
 *
 * `pageProbe` 会经 `page.evaluate` / `page.evaluateHandle` 在**页面上下文**执行,
 * 所以它不许引用任何闭包变量、也不许 import 任何模块(Playwright 只序列化函数
 * 源码)。选择器从 Node 侧作为参数传进去。
 *
 * **读快照与解析元素共用这一个函数** —— 序号是「按同一选择器 + 同一可见性判定
 * 数出来的第 n 个」。两处各写一份,迟早会错位;那时点到的是**别的元素**。
 *
 * @module dsh-browser-operator/snapshot
 */

/** 可交互元素的唯一选择器。 */
export const ELEMENT_SELECTOR =
  'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="combobox"],' +
  '[role="textbox"],[role="checkbox"],[role="tab"],[contenteditable="true"]';

/** 元素数量上限,挡住超长页面。 */
export const MAX_ELEMENTS = 200;

// ⚠ 截断上限**不能**放在模块作用域:pageProbe 会被 Playwright 序列化进页面,
// 页面里没有这些名字。它们一律以字面量写进函数体(见下)。

/**
 * 页面侧探测函数。两种模式:
 * - `options.index` 是数字 → 返回该序号的 DOM 元素,越界返回 `null`(解析模式)
 * - 否则 → 返回完整快照(观察模式)
 *
 * @param {{ selector: string, limit?: number, index?: number }} options
 */
export function pageProbe(options) {
  const selector = options.selector;
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const collect = () => {
    const found = [];
    for (const element of document.querySelectorAll(selector)) {
      if (visible(element)) found.push(element);
    }
    return found;
  };

  const nodes = collect();
  if (typeof options.index === 'number') {
    return nodes[options.index - 1] ?? null;
  }

  const nameOf = (element) =>
    (
      element.getAttribute('aria-label') ||
      element.getAttribute('placeholder') ||
      element.innerText ||
      element.value ||
      element.getAttribute('name') ||
      ''
    )
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 120);
  const kindOf = (element) => {
    const tag = element.tagName.toLowerCase();
    const role = (element.getAttribute('role') || '').toLowerCase();
    if (tag === 'select' || role === 'combobox' || role === 'listbox') return 'selectable';
    if (tag === 'input' || tag === 'textarea' || role === 'textbox' || element.isContentEditable) {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio' || type === 'submit' || type === 'button') {
        return 'clickable';
      }
      return 'typeable';
    }
    return 'clickable';
  };

  const elements = nodes.slice(0, options.limit).map((element, position) => ({
    index: position + 1,
    role: (element.getAttribute('role') || element.tagName.toLowerCase()).trim(),
    name: nameOf(element),
    value: typeof element.value === 'string' ? element.value.slice(0, 200) : '',
    disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
    kind: kindOf(element),
  }));
  const text = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 4000);

  return {
    url: location.href,
    title: document.title,
    // freshness 由元素数 / URL / 可见文本长度拼成:执行前对不上就说明快照过期。
    freshness: `${elements.length}|${location.href}|${text.length}`,
    text,
    elements,
  };
}

/**
 * 读一次页面快照。
 * @param {{ evaluate: (fn: Function, arg: object) => Promise<unknown> }} page
 */
export async function readSnapshot(page, selector = ELEMENT_SELECTOR, limit = MAX_ELEMENTS) {
  const snapshot = await page.evaluate(pageProbe, { selector, limit });
  if (snapshot === null || typeof snapshot !== 'object' || !Array.isArray(snapshot.elements)) {
    throw new Error('browser-operator: 页面快照读取失败(没拿到 elements 数组)');
  }
  return snapshot;
}

/**
 * 按序号拿到**当前**的 DOM 元素句柄。序号已失效时抛错 —— 调用方据此重来一轮。
 * @param {{ evaluateHandle: (fn: Function, arg: object) => Promise<object> }} page
 */
export async function elementHandle(page, index, selector = ELEMENT_SELECTOR) {
  const handle = await page.evaluateHandle(pageProbe, { selector, index });
  const element = handle.asElement();
  if (element === null) {
    await handle.dispose();
    throw new Error(`browser-operator: 元素 ${index} 在执行前已经不在了`);
  }
  return element;
}
```

> `pageProbe` 是**普通函数**:Playwright 只序列化它的源码进页面执行,所以它里面**不能**引用 `ELEMENT_SELECTOR` 这类 Node 侧常量 —— 选择器必须作为参数传进去。共用同一个函数换来的就是「序号定义只有一处」这个保证。

- [ ] **Step 4: 跑测试确认通过**

Run: `node plugins/browser-operator/tests/policy.test.mjs`
Expected: PASS —— 约 43 项。判定以 exit 0 与「无 not ok」为准。

- [ ] **Step 5: 提交**

```bash
git add plugins/browser-operator/lib/snapshot.js plugins/browser-operator/tests/policy.test.mjs
git commit -m "feat(browser-operator): 加页面快照 reader 与 freshness token"
```

---

## Task 7: Jev 客户端与凭证解析

**Files:**

- Create: `plugins/browser-operator/lib/jev.js`
- Modify: `plugins/browser-operator/tests/policy.test.mjs`

**Interfaces:**

- Consumes: 无。
- Produces:
  - `TYPESAFE_REF = 'TYPESAFE_API_KEY'`
  - `resolveApiKey(credentials) -> Promise<{ value: string, source: string }>` —— `credentials` 为 `undefined` 时 throw 消息含 `凭证服务`;`resolve` 返回空时 throw 消息含 `TYPESAFE_API_KEY`。
  - `createDecide({ apiKey, model, timeoutMs, clientFactory }) -> (request) => Promise<response>` —— `clientFactory` 默认 `(options) => new TypeSafeClient(options)`,测试注入假的。**会显式关掉 SDK 默认重试**(实测:不传 `retry` 时 `client.retry.maxRetries` 是 **2**,显式传 0 才是 0),并把模型写成构造器的 **`defaultModel`**(`model` 键会被静默忽略)。

- [ ] **Step 1: 写失败的测试**

```js
import { TYPESAFE_REF, createDecide, resolveApiKey } from '../lib/jev.js';
```

追加:

```js
check('凭证服务不可用时抛出可读的错误', async () => {
  await assert.rejects(() => resolveApiKey(undefined), /凭证服务/);
});

check('凭证未配置时错误里点名 TYPESAFE_API_KEY 并给出两条配置路径', async () => {
  const credentials = { resolve: async () => undefined };
  await assert.rejects(
    () => resolveApiKey(credentials),
    (error) => error.message.includes('TYPESAFE_API_KEY') && error.message.includes('.env'),
  );
});

check('凭证就绪时返回值与来源', async () => {
  const credentials = { resolve: async (ref) => ({ value: 'k-1', source: 'env' }) };
  assert.deepEqual(await resolveApiKey(credentials), { value: 'k-1', source: 'env' });
});

check('每次解析都重新问凭证服务(不跨操作缓存)', async () => {
  let calls = 0;
  const credentials = {
    resolve: async () => {
      calls += 1;
      return { value: `k-${calls}`, source: 'env' };
    },
  };
  await resolveApiKey(credentials);
  const second = await resolveApiKey(credentials);
  assert.equal(calls, 2);
  assert.equal(second.value, 'k-2');
});

check('创建客户端时显式关掉 SDK 默认重试并传显式超时', () => {
  let seen;
  const decide = createDecide({
    apiKey: 'k-1',
    model: 'jev-latest',
    timeoutMs: 5000,
    clientFactory: (options) => {
      seen = options;
      return { systemOne: async () => ({ answers: {} }) };
    },
  });
  assert.equal(seen.apiKey, 'k-1');
  assert.equal(seen.model, 'jev-latest');
  // 真正生效的是 `defaultModel`;`model` 会被构造器静默忽略。两条都断言,免得日后
  // 有人把「看起来重复」的那个删掉 —— 删掉 defaultModel 就等于模型配置无声失效。
  assert.equal(seen.defaultModel, 'jev-latest');
  assert.equal(seen.timeout, 5000);
  assert.deepEqual(seen.retry, { maxRetries: 0 });
  assert.equal(typeof decide, 'function');
});

check('decide 把 state 与 questions 原样交给 systemOne', async () => {
  const calls = [];
  const decide = createDecide({
    apiKey: 'k-1',
    model: 'jev-latest',
    timeoutMs: 5000,
    clientFactory: () => ({
      systemOne: async (request) => {
        calls.push(request);
        return { answers: { operation: { choice: 'DONE', confidence: 1 } } };
      },
    }),
  });
  const response = await decide({ state: { goal: 'g' }, questions: { operation: {} } });
  assert.deepEqual(calls[0], { state: { goal: 'g' }, questions: { operation: {} } });
  assert.equal(response.answers.operation.choice, 'DONE');
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `node plugins/browser-operator/tests/policy.test.mjs`
Expected: FAIL —— `Cannot find module '../lib/jev.js'`。

- [ ] **Step 3: 写实现**

创建 `plugins/browser-operator/lib/jev.js`:

```js
/**
 * Jev 客户端与凭证。
 *
 * 凭证只走 `ctx.credentials` —— 那个服务自己就分层覆盖 process env / provider
 * store / `.env`,所以这里**不**自己读 `process.env`。服务契约要求每次操作重新
 * 解析、不跨操作缓存。
 *
 * @module dsh-browser-operator/jev
 */

import { TypeSafeClient } from '@typesafe-ai/sdk';

/** 环境变量名即 `CredentialRef`(运行时就是个 POSIX 环境变量名字符串)。 */
export const TYPESAFE_REF = 'TYPESAFE_API_KEY';

/**
 * 解析 TypeSafe 的 API key。
 *
 * @param {{ resolve: (ref: string) => Promise<{ value: string, source: string } | undefined> } | undefined} credentials
 * @returns {Promise<{ value: string, source: string }>}
 */
export async function resolveApiKey(credentials) {
  if (credentials === undefined || credentials === null) {
    throw new Error(
      'browser-operator: 凭证服务不可用,无法解析 ' +
        `${TYPESAFE_REF}。请在 DSH 里挂载 credentials 服务后重试。`,
    );
  }
  const resolved = await credentials.resolve(TYPESAFE_REF);
  if (resolved === undefined || typeof resolved.value !== 'string' || resolved.value === '') {
    throw new Error(
      `browser-operator: 没有配置 ${TYPESAFE_REF},browser_act 需要它才能调用 Jev。` +
        `两条配置路径:① 在 .env 里写 ${TYPESAFE_REF}=<你的 key>;` +
        '② 写进 DSH 的凭证存储(~/.dsh/.credentials.yaml)。' +
        '另外 9 个 browser_* 工具不受影响,照常可用。',
    );
  }
  return { value: resolved.value, source: resolved.source };
}

/**
 * 造一个 `decide`。
 *
 * ⚠ SDK 默认 `maxRetries: 2`(含超时与连接类错误)与 10000 ms 超时 —— 那与
 * ADR-0009 决策点 6 钉的「立即停,不静默重试」和单步 5000 ms 直接冲突,所以这里
 * **显式**关掉重试并传显式超时。
 *
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {number} options.timeoutMs
 * @param {(options: object) => object} [options.clientFactory] 测试用注入点
 */
export function createDecide({ apiKey, model, timeoutMs, clientFactory }) {
  const make = clientFactory ?? ((options) => new TypeSafeClient(options));
  const client = make({
    apiKey,
    // ⚠ 构造器上的模型配置键是 `defaultModel`,**不是** `model` —— 传 `model` 会被
    // **静默忽略**(实测:defaultModel 仍是 'jev-latest')。`model` 只在 per-call 的
    // systemOne 请求上有效。这里两个都给:`defaultModel` 才是真正生效的那个。
    defaultModel: model,
    model,
    timeout: timeoutMs,
    retry: { maxRetries: 0 },
  });
  return async function decide({ state, questions }) {
    return client.systemOne({ state, questions });
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node plugins/browser-operator/tests/policy.test.mjs`
Expected: PASS —— 约 49 项。判定以 exit 0 与「无 not ok」为准。

- [ ] **Step 5: 提交**

```bash
git add plugins/browser-operator/lib/jev.js plugins/browser-operator/tests/policy.test.mjs
git commit -m "feat(browser-operator): 加 Jev 客户端与仅走 credentials 的凭证解析"
```

---

## Task 8: 注册 `browser_act` 并接上真实依赖

**Files:**

- Modify: `plugins/browser-operator/lib/index.js`
- Modify: `plugins/browser-operator/tests/policy.test.mjs`

**Interfaces:**

- Consumes: `runLoop`(Task 5)、`readSnapshot`(Task 6)、`resolveApiKey` / `createDecide`(Task 7)、既有的 `ensurePage` / `existingPage` / `TOOL_TIMEOUT_MS` / `settings`。
- Produces: 注册名为 `browser_act` 的工具;新配置项 `maxSteps` / `budgetMs` / `jevTimeoutMs` / `jevModel`。

- [ ] **Step 1: 写失败的测试**

追加:

```js
import { apply } from '../lib/index.js';

/** 假 ctx:捕获工具定义,记住 dispose 回调,可选提供 get()。 */
function makeCtx({ credentials } = {}) {
  const tools = new Map();
  const disposers = [];
  return {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    get: (name) => (name === 'credentials' ? credentials : undefined),
    on(event, handler) {
      if (event === 'dispose') disposers.push(handler);
    },
    toolsByName: tools,
    async dispose() {
      for (const handler of disposers) await handler();
    },
  };
}

/** 工具执行上下文:只用到 agent.session.id / header.cwd。 */
const execIn = (cwd) => ({ agent: { session: { id: 'offline', header: { cwd } } } });

check('browser_act 已注册且带齐门禁要求的四件套', () => {
  const ctx = makeCtx();
  apply(ctx, {});
  const definition = ctx.toolsByName.get('browser_act');
  assert.ok(definition !== undefined, 'browser_act 没有注册');
  assert.equal(typeof definition.timeoutMs, 'number');
  assert.ok(definition.output?.schema, '缺 output.schema');
  assert.equal(typeof definition.output.render, 'function', '缺 output.render');
  assert.equal(typeof definition.presentCall, 'function', '缺 presentCall');
  assert.equal(definition.timeoutMs, 120000);
});

check('注册只发生在 apply 期,不在 apply 里解析凭证', () => {
  // makeCtx() 故意不提供 get() 之外的 credentials —— 若 apply 期解析就会抛。
  assert.doesNotThrow(() => apply(makeCtx(), {}));
});

check('browser_act 的参数只有 goal 与 maxSteps', () => {
  const ctx = makeCtx();
  apply(ctx, {});
  const parameters = ctx.toolsByName.get('browser_act').parameters;
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['goal', 'maxSteps']);
  assert.deepEqual(parameters.required, ['goal']);
  assert.equal(parameters.additionalProperties, false);
});

check('配置里的 maxSteps / budgetMs 非有限值在装载期就被拒(R1 的配置那一半)', () => {
  // 模型给的 maxSteps 由 argMaxSteps 挡;这里是**配置**那一半。两者都挡不住的话,
  // 非有限界会让 runLoop 永不返回,而且会饿死 Node 的 timer 阶段、从内部无法中断。
  // 注意:真正挡住非有限值的是 `positiveInt` / `maxStepsConfig`,**不是**调用点那句
  // `Math.min(...)` —— `Math.min(NaN, 119000)` 仍然是 NaN。
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -3, 6.5]) {
    assert.throws(() => apply(makeCtx(), { maxSteps: bad }), /browser-operator:/);
    assert.throws(() => apply(makeCtx(), { budgetMs: bad }), /browser-operator:/);
  }
  assert.doesNotThrow(() => apply(makeCtx(), { budgetMs: 100000, maxSteps: 12 }));
});

check('没打开页面时 browser_act 指向 browser_navigate(而不是先抱怨缺 key)', async () => {
  const ctx = makeCtx();
  apply(ctx, {});
  await assert.rejects(
    () => ctx.toolsByName.get('browser_act').execute({ goal: 'g' }, execIn(process.cwd())),
    /browser_navigate/,
  );
});

> 缺凭证那条路径**离线测不到** —— 它要求会话里已经有一个真实页面(实现故意先检查页面再解析凭证)。
> 那条路径由 `tests/smoke.mjs` 用真实浏览器覆盖(Task 9)。
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `node plugins/browser-operator/tests/policy.test.mjs`
Expected: FAIL —— `browser_act 没有注册`。

- [ ] **Step 3: 扩配置项**

在 `lib/index.js` 的 `readConfig` 返回对象里,`locale` 那一行之前插入:

```js
    maxSteps: maxStepsConfig(config.maxSteps),
    budgetMs: positiveInt(config.budgetMs, 100000, 'budgetMs'),
    jevTimeoutMs: positiveInt(config.jevTimeoutMs, 5000, 'jevTimeoutMs'),
    jevModel: typeof config.jevModel === 'string' && config.jevModel !== ''
      ? config.jevModel
      : 'jev-latest',
```

并在文件末尾的「配置与参数校验」段落追加:

```js
/** `maxSteps`:默认 12,硬上限 40(超了按上限截断,不报错)。 */
function maxStepsConfig(value) {
  if (value === undefined || value === null || value === '') return 12;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`browser-operator: config.maxSteps 必须是正整数(got ${JSON.stringify(value)})`);
  }
  return Math.min(value, 40);
}
```

> `budgetMs` 默认 100000 而工具声明超时是 120000 —— **必须严格小于**,否则宿主会在回路自己返回 `status:'timeout'` 的同一刻掐掉调用(ADR-0009 决策点 6)。

- [ ] **Step 4: 注册 `browser_act`**

在 `lib/index.js` 里,`browser_artifacts` 的 `ctx.tools.register({...})` 之后、`apply` 的收尾 `}` 之前插入:

```js
// 目标级工具:一次给一个目标,内部用 Jev 连跑 N 步。
// 与上面 9 个单步工具共用同一个浏览器会话,但不替代它们 —— jev-ultrafast 的
// MVP 不支持 shadow DOM / iframe / canvas / 上传 / 弹窗 tab,那些走单步工具。
ctx.tools.register({
  name: 'browser_act',
  description:
    '给一个目标,让 Jev 决策回路在当前页面上连跑若干步(观察 → 决策 → 执行),把精简的步进轨迹交回来。' +
    '适合"在这个页面上完成某件事"这种一次能说清的目标;要精确控制单步(指定选择器、读 console、截图)' +
    '就用对应的 browser_* 单步工具。**本工具不导航** —— 先去哪个页面请自己用 browser_navigate 决定。' +
    '返回的 status 为 done 时**不代表目标真的达成**,那只是回路停了;需要确认就用 browser_snapshot 复核。',
  timeoutMs: TOOL_TIMEOUT_MS,
  parameters: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: '要用自然语言说清的目标,例如「找到 2026-09-20 苏黎世到伦敦的单程机票」。',
      },
      maxSteps: {
        type: 'integer',
        description: '最多跑多少步,默认 12、上限 40。每一步都计一个单位。',
      },
    },
    required: ['goal'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: [...STATUS],
          description:
            'done / stuck / blocked / max_steps / timeout / error / uncertain / text_unavailable。',
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              step: { type: 'integer' },
              operation: { type: 'string' },
              targetIndex: { type: 'integer' },
              text: { type: 'string' },
              reason: { type: 'string' },
              confidence: { type: 'number' },
            },
            required: ['step', 'operation', 'reason', 'confidence'],
            additionalProperties: false,
          },
        },
        goalMet: { type: 'number', description: 'Jev 报的目标达成概率;不是断言。' },
        elapsedMs: { type: 'integer' },
        error: { type: 'string' },
      },
      required: ['status', 'steps', 'goalMet', 'elapsedMs'],
      additionalProperties: false,
    },
    render: (_args, value) => [
      {
        type: 'text',
        text:
          `${value.status} · ${value.steps.length} 步 · goalMet=${value.goalMet} · ${value.elapsedMs}ms` +
          (value.error ? `\n${value.error}` : '') +
          (value.steps.length > 0
            ? '\n' +
              value.steps
                .map(
                  (step) =>
                    `${step.step}. ${step.operation}` +
                    (step.targetIndex === null || step.targetIndex === undefined
                      ? ''
                      : ` [${step.targetIndex}]`) +
                    ` (${step.confidence})`,
                )
                .join('\n')
            : ''),
      },
    ],
  },
  presentCall: (args) => ({
    card: 'generic',
    title: 'Browser act',
    kind: 'fetch',
    rawInput: typeof args.goal === 'string' ? args.goal : undefined,
  }),
  async execute(args, exec) {
    const goal = assertString(args.goal, 'goal');
    const maxSteps =
      typeof args.maxSteps === 'number' ? Math.min(args.maxSteps, 40) : settings.maxSteps;

    // 先确认会话里真的有页面:没页面时说「先 browser_navigate」比说「缺 key」有用。
    existingPage();
    // 凭证在执行期解析:服务契约要求每次操作重新解析,且 apply 期没有 ctx.get。
    const credentials = ctx.get('credentials');
    const { value: apiKey } = await resolveApiKey(credentials);
    const decide = createDecide({
      apiKey,
      model: settings.jevModel,
      timeoutMs: settings.jevTimeoutMs,
    });

    const result = await runLoop({
      goal,
      maxSteps,
      budgetMs: settings.budgetMs,
      now: () => Date.now(),
      observe: async () => {
        const page = existingPage();
        return await readSnapshot(page);
      },
      decide: async ({ state, questions }) => await decide({ state, questions }),
      execute: async ({ operation, targetIndex, text, snapshot, table }) =>
        await executeAction({ operation, targetIndex, text, snapshot, table }),
    });
    return result;
  },
});

/**
 * 把回路选定的动作落到页面上。
 *
 * **执行前必须重读一次快照并比对 `freshness`** —— 只比 URL 是不够的:同 URL 下的 DOM
 * 变动会让 `elementHandle(page, n)` 解析到**当前**第 n 个可见可交互元素,于是执行器点到
 * 的元素与决策所指的不是同一个,而且**不报错、还把那一步记成已执行**。
 * `snapshot.js` 的 `freshness`(元素数|URL|文本长度)就是为这一刻准备的信号;不用它,
 * 「模型输出永不直接变成选择器」这道闸就漏在了序号上。对不上就抛,回路会记成 error。
 *
 * 分支必须**穷尽**并显式列出:`PAGE_OPERATIONS` 决定放行谁,这里的每个分支决定怎么做。
 * 两者一旦漂移(往列表里加了项却没加分支),最后那个无条件 WAIT 会把这一步**静默吞掉
 * 并记成成功** —— 那正是「静默成功」的失败模式。所以:WAIT 显式成支,末尾**无条件抛错**。
 */
async function executeAction({ operation, targetIndex, text, snapshot }) {
  const page = existingPage();
  const current = await readSnapshot(page);
  if (typeof snapshot?.freshness === 'string' && current.freshness !== snapshot.freshness) {
    throw new Error(
      `browser-operator: 页面在执行前变了(${snapshot.freshness} → ${current.freshness})`,
    );
  }

  if (operation === 'CLICK') {
    const element = await elementHandle(page, targetIndex);
    await element.click({ timeout: settings.actionTimeoutMs });
    return;
  }
  if (operation === 'TYPE_TEXT') {
    const element = await elementHandle(page, targetIndex);
    await element.fill(text, { timeout: settings.actionTimeoutMs });
    return;
  }
  if (operation === 'SELECT') {
    const element = await elementHandle(page, targetIndex);
    await element.selectOption({ index: 0 }, { timeout: settings.actionTimeoutMs });
    return;
  }
  if (operation === 'SCROLL_UP' || operation === 'SCROLL_DOWN') {
    const delta = operation === 'SCROLL_DOWN' ? 600 : -600;
    await page.mouse.wheel(0, delta);
    return;
  }
  if (operation === 'WAIT') {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return;
  }

  // 走到这里说明 PAGE_OPERATIONS 与分支漂移了 —— 大声失败,别静默当成 WAIT。
  throw new Error(`browser-operator: 执行器没有实现 operation ${String(operation)}`);
}
```

> 动作一律通过 `elementHandle(page, index)` 解析 —— 它和读快照共用 `pageProbe`,所以「第 n 个元素」在两处是同一个定义。**不要**用 `page.locator(...).nth(index - 1)`:locator 不会复用可见性判定,页面里只要有隐藏的可交互元素,序号就会错位,点到的就是别的元素。

并在 `lib/index.js` 顶部 import 区追加:

```js
import { STATUS } from './policy.js';
import { runLoop } from './loop.js';
import { elementHandle, readSnapshot } from './snapshot.js';
import { createDecide, resolveApiKey } from './jev.js';
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node plugins/browser-operator/tests/policy.test.mjs`
Expected: PASS —— 约 53 项。判定以 exit 0 与「无 not ok」为准。

- [ ] **Step 6: 提交**

```bash
git add plugins/browser-operator/lib/index.js plugins/browser-operator/tests/policy.test.mjs
git commit -m "feat(browser-operator): 注册 browser_act 并接上真实页面与 Jev"
```

---

## Task 9: 手动浏览器自检

**Files:**

- Modify: `plugins/browser-operator/tests/smoke.mjs`

**Interfaces:**

- Consumes: Task 8 注册的 `browser_act`。
- Produces: 无(自检不产出接口)。

- [ ] **Step 1: 把 `browser_act` 加进期望列表,并给假 ctx 补 `get`**

`tests/smoke.mjs:206-216` 的 `EXPECTED_TOOLS` 数组末尾追加 `'browser_act',`。

再给 `tests/smoke.mjs` 的 `makeCtx()` 补一个 `get`,返回 `undefined`:

```js
    return {
      tools: { register: (definition) => tools.set(definition.name, definition) },
      // browser_act 会 ctx.get('credentials');真实 Cordis ctx 一定有这个方法,
      // 这个假 ctx 也得有,否则拿到的是 TypeError 而不是「缺凭证」那句人话。
      get: () => undefined,
      on(event, handler) {
```

- [ ] **Step 2: 补两条错误路径检查**

在 `tests/smoke.mjs` 的「真浏览器链路」段落末尾追加:

```js
await checkAsync('browser_act 在没打开页面时指向 browser_navigate', async () => {
  const bare = makeCtx();
  apply(bare, { profileDir: path.join(scratch, 'profile-bare'), headless: false });
  await assert.rejects(
    () => callTool(bare, 'browser_act', { goal: 'g' }, project),
    /browser_navigate/,
  );
  await bare.dispose();
});

await checkAsync('browser_act 缺凭证时报可读错误而不是崩掉', async () => {
  await assert.rejects(
    () => callTool(ctx, 'browser_act', { goal: 'g' }, project),
    /凭证服务|TYPESAFE_API_KEY/,
  );
});
```

- [ ] **Step 3: 手动跑自检(会闪一个有头浏览器窗口)**

Run: `node plugins/browser-operator/tests/smoke.mjs`
Expected: 全部 `ok - ...`,末行无失败;并确认 `chrome.exe` 进程数一进一出相等。

> 这一步需要本机装有 Chrome。它**不在** `just check` 里 —— 见 ADR-0009 决策点 4。

- [ ] **Step 4: 提交**

```bash
git add plugins/browser-operator/tests/smoke.mjs
git commit -m "test(browser-operator): 自检补 browser_act 与两条错误路径"
```

---

## Task 10: 插件内文档与人设模板

**Files:**

- Modify: `plugins/browser-operator/README.md`
- Modify: `plugins/browser-operator/package.json`
- Modify: `plugins/browser-operator/cordis.yml`
- Modify: `plugins/browser-operator/preset/README.md`
- Modify: `plugins/browser-operator/preset/preset.yml`
- Modify: `plugins/browser-operator/preset/agent.cordis.yml`
- Modify: `plugins/browser-operator/lib/index.js`(注释与错误串)
- Modify: `plugins/browser-operator/tests/smoke.mjs`(**只改注释**,见 Step 7)

**Interfaces:** 无代码接口。

- [ ] **Step 1: 把所有写死的工具数改成 10**

逐个文件改(共 10 处,别只改一处):

| 文件                      | 位置           | 改法                                                  |
| ------------------------- | -------------- | ----------------------------------------------------- |
| `README.md`               | `:1` 标题      | `+ 9 个` → `+ 10 个`                                  |
| `README.md`               | `:48` 小节标题 | `## 9 个工具` → `## 10 个工具`                        |
| `README.md`               | `:62`          | 「九个工具共享同一个页面」→「十个工具共享同一个页面」 |
| `README.md`               | `:137`         | 「9 个工具全部注册」→「10 个工具全部注册」            |
| `lib/index.js`            | `:4`           | 「注册 9 个」→「注册 10 个」                          |
| `cordis.yml`              | `:3`           | 「注册 9 个」→「注册 10 个」                          |
| `preset/preset.yml`       | `:2`           | 「9 个 browser_* 工具」→「10 个」                     |
| `preset/agent.cordis.yml` | `:46`          | `All 9` → `All 10`                                    |
| `preset/agent.cordis.yml` | `:311`         | 「注册 9 个」→「注册 10 个」                          |
| `package.json`            | `:4`           | 「注册 8 个」→「注册 10 个」                          |

> `package.json` 那里的「8 个」本来就是错的(README 一直写 9)—— 顺手纠到 10。

⚠ **别只按行号改**:本任务前面的编辑会让后面几行的行号漂移。改完用这条兜底:

```sh
grep -rn "All 9\|注册 8 个\|九个工具\|9 个 browser_\* 工具\|## 9 个工具" plugins/browser-operator/ || echo "OK: 没有残留的旧工具数"
```

它必须**没有任何输出**。它只覆盖**明确表示"总数是 9"**的那几种写法 —— 上面那张 10 处的表才是权威清单。

⚠ **`9 个` 本身不是陈旧标志。**「前 9 个都是单步工具」「其余 9 个工具照常可用」「另外 9 个
`browser_*` 工具不受影响」都是在陈述一个**真事实**(除 `browser_act` 外确实有 9 个单步工具),
把它们改成 10 反而是错的。所以兜底模式刻意不含裸的 `9 个`。

⚠ 已知一处陈旧但**不归本任务**:`plugins/browser-operator/CONTEXT.md:18` 的「那 9 个工具」——
该文件由 Task 11 `git rm`,其词条会并入根 `CONTEXT.md`,Task 11 搬词条时要顺手改掉这句。

- [ ] **Step 2: 去掉归档横幅、修路径、补 `browser_act` 小节**

`README.md`:

- 删掉开头那段 `> **已归档(2026-09 退役)**…`(第 3-6 行)。
- `pnpm --dir <repo-abs-path>/plugins/obsolete/browser-operator install` → 去掉 `obsolete/`。
- preset 行里的路径同样去掉 `obsolete/`。
- 自检命令 `node plugins/obsolete/browser-operator/tests/smoke.mjs` → 去掉 `obsolete/`。
- 工具表加一行:

```markdown
| `browser_act` | 给一个目标,Jev 决策回路在当前页面上连跑若干步,返回精简轨迹 |
```

- 在「产物目录」小节之前插入新小节:

```markdown
## `browser_act`(目标级工具)

前 9 个都是单步工具;`browser_act` 是唯一的目标级工具 —— 你给一个目标,它内部用
[TypeSafe 的 Jev](https://docs.typesafe.ai/introduction) 反复「观察 → 决策 → 执行」,
最多 12 步(上限 40),只把精简轨迹交回来。

**它不导航。** 先去哪个页面由你用 `browser_navigate` 决定。

**它的边界就是上游的边界。** 回路走的是 jev-ultrafast 那套结构,所以 shadow DOM、iframe、
canvas、文件上传、弹窗新 tab、嵌套滚动、任意键盘控件**都不在它的能力内** —— 遇到这些用对应的
单步工具。

**它不做文本生成。** `TYPE_TEXT` 的文本必须是 `goal` 里的**逐字片段**;没有可用片段时它会以
`status: 'text_unavailable'` 停下,这时改用 `browser_fill`。

**`status: 'done'` 不代表目标真的达成** —— 那只是回路停了。返回里带 `goalMet` 概率,要确认就
自己 `browser_snapshot` 复核一次。

### 凭证

`browser_act` 需要 `TYPESAFE_API_KEY`(TypeSafe 是按量付费的外部服务)。凭证**只**经 DSH 的
凭证服务解析,那个服务自己就分层覆盖进程环境变量、provider store 与 `.env` 文件。两条配置路径:

1. 在 `.env` 里写 `TYPESAFE_API_KEY=<你的 key>`
2. 写进 `~/.dsh/.credentials.yaml`

**没有 key 时只有 `browser_act` 报错,其余 9 个工具照常可用。**

### 哪些测试进 `just check`

| 测试                    | 进 `just check`?   | 需要什么                                   |
| ----------------------- | ------------------ | ------------------------------------------ |
| `tests/policy.test.mjs` | ✅ 进              | 什么都不要(离线、无浏览器、无 key、无网络) |
| `tests/smoke.mjs`       | ❌ 不进,只能手动跑 | 本机装有 Chrome;会真的拉起一个有头窗口     |

门禁保持「离线」是有意的(见 ADR-0009 决策点 4):回路逻辑全在纯策略层与可注入的回路里,
所以离线单测覆盖得到;浏览器 I/O 与真实 Jev 往返只能手动验证。
```

- [ ] **Step 3: 人设补 `browser_act`**

`preset/agent.cordis.yml` 的人设里,「## How to work」小节最前面插入两段(注意 YAML 折叠块的缩进层级与上下文一致,都是 6 空格):

```yaml
      - When the whole task on the current page can be stated in one sentence, prefer
        `browser_act` with that goal: it runs its own observe/decide/act loop with Jev and
        comes back with a compact trace. It never navigates — run `browser_navigate` first.
        Treat `status: done` as "the loop stopped", not as proof: verify with
        `browser_snapshot` when the outcome matters.
      - Drop back to the single-step tools whenever the loop cannot reach something —
        shadow DOM, iframes, canvas, uploads, popup tabs, nested scrolling, arbitrary
        keyboard widgets — or when you need a screenshot, the console, or the network log.
```

并同步该文件里那两处工具数(Step 1 的表)。

- [ ] **Step 4: `preset/README.md` 从「留档快照」改写为「在役模板」**

整体替换为:

````markdown
# browser-operator 的 agent preset(模板)

这个目录是**模板**,不是自动挂载的配置 —— 它不参与任何挂载。挂载要把它拷到本机:

```sh
cp -r plugins/browser-operator/preset ~/.dsh/.agent-presets/browser-operator
# 然后把 agent.cordis.yml 里的 <repo-abs-path> 换成仓库的绝对路径
```

拷过去之后**新建会话**即可生效。改插件源码要**重启 DSH**(host 侧插件不热更)。

- `preset.yml`:preset 的名字与描述(选择器里显示的那两行)。
- `agent.cordis.yml`:一份 **shipped `standard` preset 的副本**,只改了**两处** —— 开头的 `persona`
  (人设换成「浏览器操作员」,并在人设里申明产物目录规则与 `browser_act` 的用法)与末尾的
  `browser-operator` 插件行。**其余行不是本插件的东西**,是那份 `standard` 的样子,别当成仓库配置来读。

⚠ 它是模板,不是完整组合:它与 shipped `standard` 会漂移(这是 ADR-0008 就记下的既有债)。
上游 `standard` 更新后,正确做法是重新拷一份新的 `standard`、再把 persona 与插件行两处改上去。

⚠ 插件行的 `name` 写成绝对路径 —— 预设的一条 `name` 只要是绝对路径,roster 就转成 `file:` URL
直接 import,因此**不需要**把插件装进 profile。代价是这份 preset 绑定了本机路径,仓库搬家后要跟着改。
仓库里这份用 `<repo-abs-path>` 占位符,符合仓库的路径约定。

⚠ 本文件带 `!!js` 自定义标签(`disabled: !!js process.platform === 'win32'`),PyYAML 解析不了,
所以 `.pre-commit-config.yaml` 的 `check-yaml` 把它排除了;`.prettierignore` 也排除本目录
(prettier 会重排 persona 的 `>-` 折叠块缩进,那会改变语义)。
````

- [ ] **Step 5: 修 `lib/index.js` 与 `cordis.yml` 里的归档路径**

- `lib/index.js:62`、`:91`:`plugins/obsolete/browser-operator` → `plugins/browser-operator`。
- `cordis.yml:17`、`:21`:同上。
- `cordis.yml` 里那段说明「纯 host 插件…不需要 isolate realm」的注释保留不动。

- [ ] **Step 6: 修 `tests/smoke.mjs` 的头部注释(只改注释,不动代码)**

它的第 4 行运行命令仍写着 `plugins/obsolete/browser-operator/tests/smoke.mjs`,而插件早已移回
`plugins/browser-operator/`;同一段还该补一句它**不在**门禁里(会拉起有头浏览器)。这是 T9 评审
指出的遗留 —— 它在 Task 9 的范围之外,当时正确地没被动。

只改这两处注释,`EXPECTED_TOOLS`、`makeCtx` 与所有用例都不许动(那是 Task 9 的成果)。

- [ ] **Step 7: 提交**

```bash
git add plugins/browser-operator/README.md plugins/browser-operator/package.json plugins/browser-operator/cordis.yml plugins/browser-operator/preset plugins/browser-operator/lib/index.js plugins/browser-operator/tests/smoke.mjs
git commit -m "docs(browser-operator): 去归档口径并补 browser_act 的用法与边界"
```

---

## Task 11: 仓库级同步与门禁全绿

**Files:**

- Modify: `README.md`(根)
- Modify: `CONTEXT.md`(根)
- Delete: `plugins/browser-operator/CONTEXT.md`
- Modify: `CHANGELOG.md`
- Modify: `justfile`

**Interfaces:** 无代码接口。

- [ ] **Step 1: 根 `README.md` 的插件清单与安装说明**

`:21` 那一行改为:

```markdown
| `browser-operator` | 维护中 | 常驻可见浏览器 + 10 个 `browser_*` 工具(含目标级 `browser_act`;纯 host,挂 agent preset) |
```

并在「插件使用说明」里恢复一节。那一节在退役时被删掉了,用 git 取回原文再改:

```sh
git show 7a2c457^:README.md | grep -n "browser-operator"      # 7a2c457 = browser-operator 的退役提交
```

(若该 revision 取不到,用 `git log -p --follow -- README.md` 找到删除那一节的提交。)

取回后至少覆盖这几点:它是**纯 host 插件**;装法是把 `preset/` 拷进 `~/.dsh/.agent-presets/`;
改 host 侧代码要**重启 DSH**;`browser_act` 需要 `TYPESAFE_API_KEY`,没有它时其余 9 个工具照常;
`just check` **不跑**它的浏览器自检(那条只能手动跑,需要本机装有 Chrome)。

- [ ] **Step 2: 根 `CONTEXT.md`**

- 第 3 行:把「纯 host 插件挂进 **agent preset**(本仓库当前没有在役的纯 host 插件;归档例子见 `plugins/obsolete/browser-operator/`)」改为「纯 host 插件挂进 **agent preset**(在役例子见 `plugins/browser-operator/`)」。
- 追加一节,词条从 `plugins/browser-operator/CONTEXT.md` 搬来说明并去掉「留档」字样(四条:**浏览器会话** / **独立浏览器 profile** / **浏览器操作预设** / **浏览器产物目录**),再按同样的「正名 + `_Avoid_`」格式补三条新词条。
- ⚠ 搬**浏览器操作预设**那条时顺手改掉它里面的陈旧计数:原文写「给一个会话装上**那 9 个工具**」,而现在是 10 个。这是 T10 明确留给本任务的一处(T10 不许碰 `CONTEXT.md`,因为它归本任务 `git rm`)。

```markdown
## browser-operator(浏览器操作插件 + 预设)

**目标级工具(goal-level tool)**:
`browser_act` —— 接一个自然语言目标,内部用 Jev 决策回路连跑若干步才返回的工具。与 9 个**单步工具**(一次调用一个操作)相对。
_Avoid_: 高层工具、智能工具、agent 工具、复合工具

**Jev 决策回路(Jev decision loop)**:
`browser_act` 内部的那个循环:读一次页面快照 → 把索引元素表交给 TypeSafe 的 Jev 一次请求(同时问 operation 与所有兼容 target)→ 校验并执行 → 再来一轮。停在 `goal_met` / `stuck` 阈值、`BLOCKED`、步数或预算上;`status` 闭合在 8 个取值上。
_Avoid_: 循环、agent 循环、思考循环、System 2

**索引元素表(indexed element table)**:
回路每一步产出的那张表 —— 每个可见可交互元素一行,带一个当次快照内有效的序号(`[1] button "Round trip"`)。Jev 只能用这些序号指代元素,执行前会校验序号仍在白名单里且未被停用。**序号不跨快照有效。**
_Avoid_: DOM 摘要、元素列表、快照 id、选择器列表
```

- [ ] **Step 3: 删除插件的 `CONTEXT.md`**

```bash
git rm plugins/browser-operator/CONTEXT.md
```

- [ ] **Step 4: `CHANGELOG.md` 的 `[Unreleased]`**

在 `### Removed` 之前插入 `### Added`,在 `### Removed` 之后插入 `### Changed` 的条目:

```markdown
### Added

- `browser-operator`:新增目标级工具 `browser_act` —— 给一个目标,内部用 TypeSafe 的 Jev
  连跑「观察 → 决策 → 执行」,最多 12 步(上限 40),返回精简轨迹与 `goalMet` 概率。需要
  `TYPESAFE_API_KEY`;没有它时只有这个工具报错,其余 9 个照常。决策与边界见 `docs/adr/0009`
- `browser-operator`:新增离线单测 `tests/policy.test.mjs`(策略层 + 回路 + 注册形状),进 `just check`

### Changed

- `browser-operator`:**复活** —— 从 `plugins/obsolete/` 移回 `plugins/browser-operator/`
  (ADR-0008 写明的回滚路径),源码行为除新增 `browser_act` 外未改;它的 preset 快照改造成在役模板
- `justfile` / 根 `package.json`:`test` / `check` 加入 `browser-operator` 的离线单测;
  `audit` 加跑插件目录(`pnpm --dir plugins/browser-operator audit`)—— 仓库没有 pnpm workspace,
  根 `pnpm audit` 覆盖不到插件的依赖
- `.pre-commit-config.yaml` / `.prettierignore`:两处针对 browser-operator preset 的排除路径
  随插件移出 `obsolete/` 而更新
```

- [ ] **Step 5: `justfile` 的 `audit` recipe**

在 `pnpm audit` 之后追加一行(缩进 4 空格):

```
    pnpm --dir plugins/browser-operator audit
```

同时把第 15 行注释里的 `plugins/obsolete/browser-operator/README.md` 改成 `plugins/browser-operator/README.md`。

- [ ] **Step 6: 跑全量门禁**

Run: `just check`
Expected: lint 无错、prettier 无差异、全部测试通过(含新的 `policy.test.mjs`)、`pnpm audit` 与插件目录的 audit 都干净。

若 `pnpm --dir plugins/browser-operator audit` 在 CI 上因未安装依赖而失败:把它从 `audit` recipe 里撤掉,改为在本 ADR 的「依赖覆盖缺口」与插件 README 里写明手动跑法,然后重新跑 `just check`。

- [ ] **Step 7: 提交**

```bash
git add README.md CONTEXT.md CHANGELOG.md justfile
git commit -m "docs(browser-operator): 同步 README、CONTEXT、CHANGELOG 与依赖审计"
```

---

## 收尾检查(不在任务里,发布前手动过一遍)

- [ ] `git status` 干净;`plugins/obsolete/browser-operator` 已不存在。
- [ ] `grep -rn "obsolete/browser-operator" --include="*.md" --include="*.yml" --include="*.json" --include="*.js" --include="*.mjs" .` 只剩 `docs/adr/0008` 与 `CHANGELOG.md` 里的历史条目、以及 `docs/adr/0009` 里对它的引用。
- [ ] `node plugins/browser-operator/tests/policy.test.mjs` 离线通过(断网跑一次更保险)。
- [ ] `node plugins/browser-operator/tests/smoke.mjs` 手动通过,且 `chrome.exe` 进程数一进一出相等。
- [ ] 本机重建 preset:`cp -r plugins/browser-operator/preset ~/.dsh/.agent-presets/browser-operator`,把 `<repo-abs-path>` 换成真实绝对路径,**重启 DSH**,新建会话确认 10 个工具都在。
- [ ] 配上 `TYPESAFE_API_KEY` 后,对 `https://en.wikipedia.org/wiki/Main_Page` 跑一次
      `browser_act("打开关于哥德尔不完备定理的条目")`,记录实际步数、`goalMet`、`elapsedMs`
      与该次 Jev 调用延迟 —— 这是 ADR-0009 里唯一还没被验证过的环节(真实 Jev 往返)。
- [ ] 把上面那次实测的数字补进 ADR-0009 的「后果」,或另开一条 ADR 记录结论。
