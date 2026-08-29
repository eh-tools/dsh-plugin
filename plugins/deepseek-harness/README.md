# dsh-deepseek-harness

DeepSeek Harness 主题 —— 复刻 <https://www.deepseek.com/harness/en/> 的**粒子鲸鱼**背景，跑在自有插件上。

## 功能

- **官方 WebGL2 粒子鲸鱼**：复刻 DeepSeek 官网 hero 鲸鱼——内嵌官方 `hero-whale.svg` 纹理，逐像素采样成点云，GLSL 着色器（粒子缩放 0.5–1.5、鼠标扭曲、光线跟随鼠标、easeOutCubic 组装入场、游泳波动），`webgl2` + `gl.POINTS`，WebGL2 不可用时回退 2D canvas。
- **DeepSeek 品牌蓝粒子**：粒子用 DeepSeek 蓝（`#6799FE` 附近）、普通 alpha 混合，浅色/深色主题均可辨识；整体透明度下降一档（`alpha *= 0.7`），在清晰可辨与不干扰对话区文本阅读之间取平衡。
- **跟随官方主题**：不改官方明/暗/系统主题，不强制深色，也无设置按钮——默认开启。
- **隐藏式诊断面板**：URL 带 `?dshtest=1` 时右下角显示实时状态（theme / bodyBg / whaleGL / progs / state / count），排查用，平时不出现。

## 安装

```sh
dsh plugin --profile web add link:<repo-abs-path>/plugins/deepseek-harness
```

安装后重启 DSH（`dsh` 进程），刷新页面生效。

## 开发

```sh
node scripts/build.mjs            # 从 src/ 重新生成 lib/client.js
node scripts/build.mjs --check    # 校验 lib/client.js 与 src/ 一致
```

## 结构

| 文件 | 说明 |
| --- | --- |
| `lib/index.js` | host 半：空 apply（纯客户端插件，无宿主副作用） |
| `lib/client.js` | client 半：自动生成（build.mjs 拼接） |
| `src/*.js` | 引擎源码：`whale-shaders`(SVG/GLSL/矩阵)、`whale`、`theme`、`settings`、`dom`、`boot`、`index` |
| `src/css/00-background.css` | 背景层样式 |
| `scripts/build.mjs` | 拼接构建脚本（零依赖） |
| `cordis.patch.yml` | 本包挂载层（host 半随 profile boot 装载） |
