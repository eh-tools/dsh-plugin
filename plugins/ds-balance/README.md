# DeepSeek 余额/调用量状态栏 (DSH 静态双半插件)

在 DSH Web 的官方 stats 状态栏**下方**显示独立第二行:

```
DeepSeek ¥68.64 | 今日 646 次 · 98M tok | 本月 25084 次 · 4B tok
```

- 每 5 分钟自动刷新;悬停可看明细(总余额 / 赠送 / 充值 / 今日与本月输入输出 token 拆分)。
- **非官方 API 不显示**:base URL 的主机不是 `api.deepseek.com`(如网关/代理/自建中转),或未配置 `DEEPSEEK_API_KEY` 时,第二行整体隐藏,状态栏保持官方原样。
- **未配置 `DEEPSEEK_USER_TOKEN` 时不显示调用量**:用量接口拿不到时,第二行退化为只显示余额。

## 数据来源

| 数据            | 接口                                                                 | 认证                  |
| --------------- | -------------------------------------------------------------------- | --------------------- |
| 余额            | `GET https://api.deepseek.com/user/balance`                          | `DEEPSEEK_API_KEY`    |
| 今日/本月调用量 | `GET https://platform.deepseek.com/api/v0/usage/amount?month=&year=` | `DEEPSEEK_USER_TOKEN` |

用量接口是平台用量页 dashboard 的私有接口(未公开文档,可能变动):响应
`data.biz_data.days[]` 按天返回,每天 `data[].usage[]` 含
`PROMPT_CACHE_HIT_TOKEN` / `PROMPT_CACHE_MISS_TOKEN` / `RESPONSE_TOKEN`(token 数)
与 `REQUEST`(调用次数)。

> **口径(时区)**:`days[].date` 按 **UTC** 切天(接口忽略 `tz` 参数,实测
> 请求发生在 UTC 时段的调用计入对应 UTC 日)。因此"今日"取**当前 UTC 日**的桶:
> 对 UTC+8 用户,每天本地 `00:00~08:00` 的请求会**计入上一天(UTC)**的记录,
> 这正是当天早上"今日"仍显示较多、而本地日期桶为 0 的原因——与平台官网用量页
> 一致,不是插件瑕疵。相应的 `month`/`year` 也按 UTC 取,保证响应总是包含
> 今日的 UTC 桶。

未配置 userToken 时退回 `by_api_key/amount`(API key 认证,实测返回 `40003`),
同样退化只显示余额。

### userToken 获取(平台网页登录态, 与 API key 无关)

1. Chrome 登录 https://platform.deepseek.com;
2. F12 → Application → Local Storage → `https://platform.deepseek.com`;
3. 复制键 `userToken` 的 JSON 值中的 `.value` 字段(等价于
   `JSON.parse(localStorage.getItem('userToken')).value`);
4. 或 F12 → Network → 刷新页面 → 点任意接口(如 `users/get_user_summary`),
   复制请求头 `Authorization: Bearer <token>`。

token 过期/退出登录后接口返回 `code: 40002/40003`,重新复制即可。

### 配置

写入 `~/.dsh/.credentials.yaml`(或环境变量),插件经 credentials 服务读取,
不进代码明文:

```yaml
DEEPSEEK_API_KEY: sk-xxxx
DEEPSEEK_USER_TOKEN: <上面复制的 userToken>
```

> 自测(验证你的 userToken 能否查用量):
>
> ```bash
> UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36'
> TOKEN='<你的 userToken>'
> MONTH=$(date +%-m); YEAR=$(date +%Y)            # Linux: date +%-m 换成 date +%m
> curl -fsS -H "User-Agent: $UA" -H 'Origin: https://platform.deepseek.com' \
>   -H 'Referer: https://platform.deepseek.com/usage' -H 'x-app-version: 1.0.0' \
>   -H "Authorization: Bearer $TOKEN" \
>   "https://platform.deepseek.com/api/v0/usage/amount?month=$MONTH&year=$YEAR"
> ```
>
> 返回 `data.biz_data.days[]` 即成功;`code: 40002/40003` 说明 token 已过期。

### 界面内获取 token(浏览器一键登录)

插件检测到官方 API 且未配置 `DEEPSEEK_USER_TOKEN` 时,第二行出现"浏览器登录"入口:

用 Playwright **驱动系统 Google Chrome**(`channel: 'chrome'`)打开
platform.deepseek.com,用户手动登录后脚本自动读取 localStorage 里的
`userToken` 并写入 `~/.dsh/.credentials.yaml`,状态栏自动显示调用量。
全程只多一步"登录"。

前置:系统装有 Google Chrome(本机没有时才需要 `npx playwright install chromium`
下载 playwright 自带浏览器);脚本路径自动按包相对解析,无需手动配置;
playwright 的全局模块位置(`GLOBAL_NODE_MODULES`)与 node 回退路径(`NODE_BIN`)
可用环境变量 `DSH_DS_BALANCE_PLAYWRIGHT_PATH` / `DSH_DS_BALANCE_NODE_BIN` 覆盖
(默认值见 `lib/index.js` 顶部常量)。

## 安装与自动加载(随 DSH 启动自动挂载)

本插件已从动态插件改造为**静态双半 npm 包**(`dsh-ds-balance`):host 半在
`lib/index.js`,client 半在 `lib/client.js`(浏览器 bundle),包自带
`cordis.patch.yml` 挂载层。安装后无需任何手动加载步骤,`dsh web` 每次启动
自动挂载,无 Run 卡批准,重启不丢;client 改动走 HMR 热更新,host 改动才需重启。

```sh
# 在仓库根目录执行(link: 本地安装, 无需发布到 npm;<repo-abs-path> 换成仓库绝对路径)
dsh plugin --profile web add link:<repo-abs-path>/plugins/ds-balance
```

装完**重启 DSH 并硬刷新浏览器**(Cmd/Ctrl+Shift+R),状态栏下方即显示第二行。

- 更新: `git pull` 后重跑上面同一命令;只改 `lib/client.js` 时刷新浏览器即可,
  改 `lib/index.js` 才需要重启。
- 卸载: `dsh plugin --profile web remove dsh-ds-balance`。
- 原理: 包声明了 `dsh.bundle.patch`,CLI 的 bundle 协调会自动把它加进 profile
  的 `dsh.profile.bundles`,profile boot 时合并本包的 `cordis.patch.yml` 挂载行;
  `dsh.client` 声明让 clientModules 把浏览器半编入 `__DSH_BOOT__` 图。

## 文件

| 文件               | 内容                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/index.js`     | **Host 半(静态)** — 解析 `DEEPSEEK_API_KEY` / `DEEPSEEK_USER_TOKEN`(credentials 服务), curl 请求余额 + 用量接口(`usage/amount`, userToken 认证), 经 `ctx.webServer` 暴露 `POST /ds-balance/api/{query,open-login,browser-login,login-status}`;带 60s 缓存 + 并发去重;非官方 host 判定;密钥走显式 env opt-in, 不进进程 argv。 |
| `lib/client.js`    | **Client 半(静态 bundle)** — 注册 `conversation.composer.dock` 的独立 `ds-balance` 单元格(order:1, 排在官方 stats 之下);非官方/无 key 时整行不渲染;`fetch` 调 host 路由(替代动态的 `host.call`)。                                                                                                                            |
| `package.json`     | npm 包声明(`dsh.bundle.patch` + `dsh.client`)                                                                                                                                                                                                                                                                                |
| `cordis.patch.yml` | 挂载层(profile boot 时自动合并)                                                                                                                                                                                                                                                                                              |
| `manifest.json`    | kind / files / install, 供重建使用                                                                                                                                                                                                                                                                                           |

## 备注

- client→host 通信是静态插件的 HTTP JSON 路由(与 dsh-better-sidebar 的 `/sidebar/api` 同款), 不再需要动态插件的 `harness` / `host` / `styles` 沙箱符号。
- 不接管官方 `stats` 单元格, 因此官方统计行永远保持原样;官方更新 stats 不影响本插件。
- 未配置 `DEEPSEEK_USER_TOKEN` 时, 调用量两格不显示, 第二行只剩余额。
- 移除: `dsh plugin --profile web remove dsh-ds-balance` 后重启 DSH(第二行消失)。
