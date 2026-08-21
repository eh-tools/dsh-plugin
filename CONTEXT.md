# dsh-plugin(DeepSeek Harness 插件仓库)

本仓库承载 DSH 的静态双半插件(Host 半 `lib/index.js` + Client bundle `lib/client.js`),每个插件是 `plugins/` 下的独立 npm 包,经 `dsh plugin --profile web add link:<abs-path>` 挂载进 web profile。插件共享同一套挂载契约:`package.json` + `manifest.json` + `cordis.patch.yml`。

## file-git-explorer(左右树浏览插件)

**cwd**:
两个树面板共同的服务根目录,始终跟随 DSH 进程的当前工作目录,是文件树与 git 树的唯一事实来源。
_Avoid_: 工作区、项目根、目录树根

**可见组(visible group)**:
cwd 下既非点开头、也未被 .gitignore 忽略的条目,构成左侧上区的可显示树。
_Avoid_: 普通文件、正常文件

**隐藏组(hidden group)**:
cwd 下以 `.` 开头的条目(不含 `.git` 内部结构),构成左侧中区,与上区一样逐级懒加载展开。
_Avoid_: 点文件、dotfile

**忽略组(ignored group)**:
被 .gitignore 排除的条目(含被忽略的点文件),构成左侧最下方分区,逐级懒加载展开。
_Avoid_: 排除项、gitignore 列表

**悬浮面板(floating panel)**:
点击树节点后浮出的内容层,允许越过主对话区;左侧文件内容面板向右浮出,右侧 diff 面板向左浮出;两个面板可同时存在、各自独立关闭。
_Avoid_: 弹窗、tooltip、popover、预览卡片

**细条(strip)**:
树面板收起后的窄条形态,吸附在对应侧,点击重新展开。与 DSH 自带侧边栏的收起态 rail 是两回事。
_Avoid_: rail

**图钉(pin)**:
树面板头部的按钮;钉住后左右两个面板都不能收起为细条;未钉住时点击面板外自动收起。
_Avoid_: 固定(易与"固定定位"混淆)

**联动(linkage)**:
点击左侧文件时,若右侧 git 树存在该文件的 diff,滚动定位并高亮该节点;绝不自动打开 diff 面板。
_Avoid_: 跳转、聚焦、自动打开

**diff 范围(diff scope)**:
右侧变更列表的内容口径——工作区相对 HEAD 的全部变更(已暂存 + 未暂存 + 未跟踪),平铺展示、每项带状态徽标。
_Avoid_: 分支间差异(不是两分支之间的 diff)

**分支(branch)**:
右侧树顶部的只读展示;当前分支始终实时读取,下拉列出本地 + 远程分组,不支持切换。
_Avoid_: 分支选择器、切换

**cwd 缓存(cwd cache)**:
按仓库根键控的 UI 状态记忆(仓库根 = cwd 向上找到的第一个 `.git` 所在目录;无仓库时退化为 cwd 本身),记「上次查看分支、面板宽度、展开状态」,切回同一仓库时恢复。分支事实(当前分支)始终实时读取,不进缓存。
_Avoid_: 分支缓存(缓存的是 UI 状态,不是分支事实)

**树面板(tree panel)**:
左右两个矩形面板本身;垂直方向夹在 header 下边框与 composer card 下边框之间,水平方向可拉伸但不覆盖主对话区。
_Avoid_: 侧栏、边栏(那是细条的称呼)
