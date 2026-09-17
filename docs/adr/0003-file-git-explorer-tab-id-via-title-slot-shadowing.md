# 0003 — 用影子替换页签芯片槽取得 tabId,而不是自绘正文

- 状态:已接受(`file-git-explorer` 2026-09 退役归档,本 ADR 仅作历史记录)
- 日期:2026-09-11
- 关联词条:`plugins/obsolete/file-git-explorer/CONTEXT.md`(悬浮面板)
- 关联决策:ADR-0002(详情由官方 float 承载)

## 背景

按 ADR-0002,详情要"把官方正文的页签浮起来"。但要把某个页签浮起来,必须先拿到它的 **`tabId`**。实测在当前 dsh(0.1.5-rc.1,打包的客户端 UI 为 0.1.5-rc.2)上,拿 `tabId` 的路全部堵死:

- `ctx.sidebarRight.openResource(address, options)` / `openTab(kind, options)` **返回 `void`**,且选项里**没有 host / rect** —— 打开时无法指定悬浮面板,也拿不到回执;
- 公开接口**没有"地址 → tabId"查询**(`active()` 只给当前活动面板的活动页签);
- 客户端**全部事件只有 4 个**:`connection/reset`、`locale/change`、`slots/changed`、`theme/change` —— **没有任何 tab / sidebar 打开事件**;
- 官方六种正文组件**未导出**(正文渲染只发生在官方包内部);
- 硬约束:**官方插件不能改**。

唯一未被堵死的观察点是"某格官方 UI 由谁渲染":官方 text 页签的**芯片**注册在 keyed 槽 `sidebar.right.pane.tab.title`,`key` = 官方 text 类型 id。

## 决策

影子注册 `sidebar.right.pane.tab.title`,**`key` 用官方 text 类型 id**,从而在官方页签出现时,由本插件的组件拿到它的 `useTabInfo()` → `tab.id`,随即 `ctx.sidebarRight.float(tab.id, rect)`。

**实现补正(v0.7 落地时实测)**:keyed 槽**同 key 同 priority 会直接抛错**,而不是"替换占用者";渲染取的是按 priority **升序**排序后该 key 的**第一条**,即**最低者渲染**(`SlotCore.register` 的报错原文:`register at a different priority to shadow it (lowest renders)`)。官方那条 title 注册没有声明 priority(即 `0`),所以影子注册**必须用负数** priority ≤ -1 —— 写成 `0` 会在 boot 期抛错。仓库根的 `scripts/verify-client-bundles.mjs` 把这一条做成了离线护栏。

复刻成本极小 —— 官方芯片的全部内容就是:

```js
<FileTypeIcon kind={classifyFileType(tab.title)} size={16} /> {tab.title}
```

两者都是 `@deepseek-ai/dsh-client-ui-primitives` 的导出。**关闭按钮、⋯ 菜单、悬浮面板头部与手柄都不在这个槽里**,由 dockkit 单独渲染(有 `data-dockkit-tab-close` / `-tab-menu` / `-float-close` / `-float-dock` / `-float-resize` 等稳定属性为证),所以替换这一格**不丢任何交互**。

## 备选方案(被放弃的)

| 方案                              | 放弃原因                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 用 `canOpen` 否决官方 text 类型   | `canOpen` 只把**自己**从候选里剔除;若没有替代类型,点击会**同步抛错**;而且它换的是"类型"不是"呈现",仍然开成页签 |
| 以同 kind 注册顶掉官方 text 类型  | `coexists()` 对 `fallback` 档不成立,同 kind 再注册直接抛错                                                     |
| 同 key 同 priority 覆盖官方 title | keyed 槽同 key 同档直接抛错;能压住官方的是**更低**的 priority(见决策的"实现补正")                              |
| 监听"页签打开"事件                | 客户端事件面只有 4 个,不存在这样的事件                                                                         |
| 自绘正文,不借官方渲染             | 见 ADR-0002:markdown / 代码之外,官方渲染器不可复用,html 与 pdf 会退化                                          |
| 改官方包或给它打补丁              | 硬约束禁止;且会被 dsh 升级覆盖                                                                                 |

## 后果

- **正面**:`tabId` 有据可得;替换足迹最小(只动页签标题那一格);官方正文照常由官方渲染;本插件卸载后官方芯片**自动复位**。
- **代价**:该槽**同一时刻只能有一个占用者** —— 因为本插件必须占它(否则浮不起来),这直接决定了:
  - 那枚「复制内容」图标只能由本插件自己渲染,并因此并入本插件(独立的 `doc-copy` 插件在 A′ 形态下**无法存在**);
  - 占位者的实现要同时经得起两个位置:**页签条上的芯片**与**悬浮面板头部的标题**(官方文档明确该槽两处都渲染);
- **可接受副产物**:页签被浮起后不再位于页签条上,所以「复制内容」图标只在悬浮面板头部出现,不污染页签条。
  **补正(见 ADR-0004)**:原文写的"未浮起的一帧可能短暂出现在页签条上,属可忽略的瞬时"低估了它 —— 重试走的是 60ms 定时器,真 boot 实测会在页签条上画出 **45–66ms / 3–5 帧**;改成微任务重试后**一帧都不出现**。
