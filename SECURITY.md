# 安全政策

## 支持的版本

本仓库为插件集合,无固定发布周期,以 `main` 分支为最新。安全修复会合入
`main` 并同步更新各插件包。

## 报告漏洞

本仓库插件会处理敏感凭证(`DEEPSEEK_API_KEY` / `DEEPSEEK_USER_TOKEN` 等)与本地
文件读写,请认真对待安全问题。

**发现安全漏洞请走私有渠道,不要开公开 Issue:**

- 首选:[GitHub 私有安全通告(Private vulnerability reporting)](https://github.com/eh-tools/dsh-plugin/security/advisories/new)
- 或发送邮件至仓库维护者(见 GitHub 组织页)。

报告中请包含:

1. 受影响插件与版本(commit hash 或 tag);
2. 漏洞类型与可复现步骤(最小复现优先);
3. 影响面(能否窃取凭证、越权读写文件、执行命令等);
4. 你建议的修复方案(可选)。

## 处理承诺

- 维护者会尽快确认并回复(一般 48 小时内)。
- 修复合入后,会通过安全通告或 release notes 公开披露(默认披露漏洞细节,
  若你要求匿名或延期披露请提前说明)。
- 负责任的披露:请给维护者合理的修复时间(建议 90 天),再公开细节。

## 凭证处理原则(本项目自带约定)

- API key / userToken 等凭证**只**允许写入 `~/.dsh/.credentials.yaml`(或环境变量),
  经 credentials 服务读取,**绝不入代码、不入 git**。
- 仓库已配置 gitleaks 密钥扫描钩子,疑似密钥会被拦截提交。
- `tool-vision` 会拉起本地 llama-server 并读取本地图片文件,请仅在你信任的
  模型与文件上使用;`paste-image` 会把粘贴图片落盘到会话工作目录
  `attachments/`,注意会话目录的访问权限。

## 常见安全相关 FAQ

- **问**:`DEEPSEEK_USER_TOKEN` 是什么?安全吗?
  **答**:它是你 platform.deepseek.com 网页登录态的 token(等同浏览器登录态),
  泄露等同于账号登录态泄露。仅存于本机 `~/.dsh/.credentials.yaml`,插件只在
  本地请求用量接口时使用,不会上报给任何第三方。
