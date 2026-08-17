# DeepSeek 余额/调用量状态栏 (DSH 动态插件)

在 DSH Web 的官方 stats 状态栏**下方**显示独立第二行:

```
DeepSeek ¥68.64 | 今日 34K tok | 本月 1.2M tok
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
`PROMPT_CACHE_HIT_TOKEN` / `PROMPT_CACHE_MISS_TOKEN` / `RESPONSE_TOKEN`(token 数)。
该接口**不返回调用次数**,因此第二行只显示 token 数。未配置 userToken 时退回
`by_api_key/amount`(API key 认证,实测返回 `40003`),同样退化只显示余额。

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
下载 playwright 自带浏览器);脚本路径与全局模块路径见 `host.js` 顶部的
`LOGIN_SCRIPT` / `GLOBAL_NODE_MODULES` 常量。

## 文件

| 文件        | 内容                                                                                                                                                                                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host.js`   | Host 端函数体 — 解析 `DEEPSEEK_API_KEY` / `DEEPSEEK_USER_TOKEN`(credentials 服务), curl 请求余额 + 用量接口(`usage/amount`, userToken 认证), 经 `harness.handle('ds-balance/query')` 暴露给 Client;带 60s 缓存 + 并发去重;非官方 host 判定;密钥走显式 env opt-in, 不进进程 argv。 |
| `client.js` | Client 端函数体 — 注册 `conversation.composer.dock` 的独立 `ds-balance` 单元格(order:1, 排在官方 stats 之下);非官方/无 key 时整行不渲染。                                                                                                                                         |

两个文件的内容就是 `cordis_define` 的 `code.host` / `code.client` 函数体, 可直接照抄。

> 安装 V2 的完整指令见 [`install-v2.md`](./install-v2.md)(含停旧版本步骤)。

## 如何在 DSH 中(重新)加载

动态插件是**进程内临时**的: DSH 重启后需要重新创建并运行, 否则第二行消失。

1. 让 agent 用本目录两个文件重建插件:

   ```
   cordis_define: kind: new, idPrefix: dsbal
     code.host   <- host.js 的内容
     code.client <- client.js 的内容
   cordis_run:   pluginId + packageId, mode: run
   ```

2. 在界面批准 Run 卡(Client 端需要授权), 激活后状态栏下方即显示第二行。

## 备注

- 依赖动态插件专属符号(`harness` / `host` / `styles` / React 内置), 不能作为静态 cordis.yml 插件直接挂载。
- 不接管官方 `stats` 单元格, 因此官方统计行永远保持原样;官方更新 stats 不影响本插件。
- 未配置 `DEEPSEEK_USER_TOKEN` 时, 调用量两格不显示, 第二行只剩余额。
- 停止: `cordis_stop`(第二行消失);彻底删除: `cordis_undefine`。
