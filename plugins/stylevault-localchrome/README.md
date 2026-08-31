# dsh-stylevault-localchrome

> 主题引擎与设置面板由上游 [GptsApp/dsh-stylevault](https://github.com/GptsApp/dsh-stylevault) 提供，
> **本插件不实现、也不替换它**。本插件做两件事：
> ① 把**本机 Google Chrome 浏览器的主题配色**读出来，生成一份可导入 StyleVault 的**预设 JSON**；
> ② 在**用户同意**的前提下，把这份预设**应用到** StyleVault（安装/首次启动时）。
> 应用前有**两道闸**：**必须先有上游 StyleVault**，**且必须得到你的同意** —— 不同意就只生成预设 JSON、不应用。

安装上游主题引擎（独立）：

```bash
dsh plugin --profile web add github:GptsApp/dsh-stylevault
```

安装本插件（取色 + 生成预设）：

```bash
dsh plugin --profile web add link:<本目录绝对路径>
```

---

## 这是什么

Chrome 的「自定义外观 / Customize Chrome」会把你选的用户色存进
`User Data\<profile>\Preferences`，字段是 `browser.theme.user_color`，以**带符号 32 位
SkColor(0xAARRGGBB)** 存储（所以 JSON 里是负数，例如 `-7882111`）。

本插件把这个值解码回 `#RRGGBB`（`-7882111 → 0xFF87BA81 → #87BA81`），再
**从这一个 accent 推导出一整套完整调色板**（背景梯度、文字层级、边框、状态色、侧栏/气泡/代码块），
用上游 StyleVault 的 `packTokens` 逻辑展开成 93 个 `--dsw-alias-* / --dsw-specific-*` 语义 token，
最后包成一个 `stylevault: "1.0"` 的导出 JSON。

## 目录结构

```
plugins/stylevault-localchrome/
├── package.json            # dsh 双半插件声明 + bin + upstream 引用
├── manifest.json           # 静态插件清单(install 指向本地, upstream 指向作者仓库)
├── cordis.patch.yml        # 挂载层(host/client 随 profile boot 自动加载)
├── lib/
│   ├── chrome-theme.js     # ★ 取色器: 读 Preferences + 解 user_color → #RRGGBB(可单独跑)
│   ├── presets.js          # packTokens 引擎 + derivePalette(accent→调色板) + 预设 payload 构建
│   ├── index.js            # host 半: 受信任 HTTP 路由(GET /svlc/api/chrome 等)
│   └── client.js           # client 半: 授权闸自动应用 + settings 卡片 + __SVLC__ 助手
├── scripts/
│   └── build-preset.js     # CLI: Chrome 配色 → 预设 JSON
└── assets/
    └── sage-mist.stylevault.json   # 当前手调的 Sage Mist 预设(示例, 可直接导入)
```

## 用法

### 1) CLI（最常用，无需挂载）

```bash
# 读本机 Chrome 配色, 生成浅色预设, 打印到 stdout
node scripts/build-preset.js

# 强制定深色预设, 写入文件
node scripts/build-preset.js --dark --name "Chrome Night" --out chrome-night.json

# 跳过 Chrome, 直接用给定 accent
node scripts/build-preset.js --accent "#87BA81"
```

把打印出来的 JSON 粘到上游 **Settings → StyleVault → 导入**。

### 2) 自动应用（带授权闸）

安装后首次启动，插件会：

1. 检测上游 `window.__STYLEVAULT__` 是否已加载 —— **没有则不应用**，只生成预设 JSON，并提示你先装上游；
2. 有上游时，弹窗询问是否把读到的 Chrome 配色**应用为 DSH 主题**：
   - **确定** → 应用并记住（`svlc.consent = 'apply'`），**以后每次启动自动应用**当前 Chrome 配色；
   - **取消** → 只生成预设 JSON、不应用（记为 `'svlc.consent = 'never'`，不再弹窗）。

之后可在 **Settings → StyleVault · Local Chrome** 卡片里改主意：**[同意并应用]** 或 **[仅生成预设(不应用)]**，
也会显示当前读到的 Chrome 配色与状态。控制台同样可以：

```js
__SVLC__.consent('apply'); // 同意(下次启动自动应用)
__SVLC__.apply(); // 立即应用当前 Chrome 配色到 StyleVault
__SVLC__.consent('never'); // 取消(仅生成预设)
__SVLC__.preset(); // 哪怕不应用, 也能拿到预设 JSON
```

> 说明：同意只影响「要不要自动应用」；预设 JSON 在任何情况下都能通过 `__SVLC__.preset()` /
> CLI / 上游面板拿到。应用动作由上游的 `__STYLEVAULT__.import()` 完成，本插件不接管主题。
> 首次应用会用 `import(payload, { saveAs: true })` **一次性写进「我的方案」**（可在上游
> StyleVault 面板重命名/设为默认）；之后再应用同名方案只会更新当前主题，不会重复入列。

### 3) 单独跑取色器

```bash
node lib/chrome-theme.js         # 打印解码后的 #RRGGBB + 元数据
```

### 4) 浏览器控制台（需挂载后 host 路由生效）

```js
__SVLC__.chrome(); // → { color: "#87BA81", scheme: "system", ... }
__SVLC__.preset(); // → StyleVault 1.0 预设 JSON
__SVLC__.sage(); // → 内置 Sage Mist 预设
__SVLC__.copyShare(); // → 复制「分享文案」(含 JSON)
```

## host 路由（受信任栅栏）

只接受 `127.0.0.1 / localhost` + `x-dsh-plugin: 1` 头，仅本机浏览器可调用：

| 方法 | 路径               | 说明                                                                |
| ---- | ------------------ | ------------------------------------------------------------------- |
| GET  | `/svlc/api/chrome` | 读本机 Chrome 配色（解码后 `#RRGGBB` + 元数据）                     |
| POST | `/svlc/api/preset` | `{ dark?, name?, accent?, basePreset?, author?, tags? }` → 生成预设 |
| POST | `/svlc/api/sage`   | 直接返回内置 Sage Mist 预设                                         |

## 判别：本机用户色 vs 商店主题

`extensions.theme.id === "user_color_theme_id"` → 是 Chrome 内建「用户色」主题，`user_color` 有效。
若 `extensions.theme.id` 是一个 **Web Store 扩展 id**，则是商店图片主题，颜色由扩展自身控制，
不在 `browser.theme` 这棵 JSON 里 —— 取色器会返回 `isUserColorTheme: false` 且 `color: null`，
此时用 `--accent` 手动指定即可。

## 示例：从 Sage Mist 预设再生成

内置的 `assets/sage-mist.stylevault.json` 就是当前这套手调配色。想基于 Chrome 当前配色生成同款，
先改 Chrome 的「自定义外观」主色，再跑：

```bash
node scripts/build-preset.js --name "My Sage" --out my-sage.json
```

## 许可

MIT。`packTokens` 逻辑照搬自上游 [GptsApp/dsh-stylevault](https://github.com/GptsApp/dsh-stylevault)（MIT，仅做 token 映射）。
