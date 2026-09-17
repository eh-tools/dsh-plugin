// dsh-file-git-explorer — client half(静态浏览器 bundle)
//
// 与动态插件 client 半的差异: 沙箱内置符号换成真实模块表依赖 —— React 与 primitives
// 经 require 解析(loader 的种子模块表是封闭 9 项, 两者都在表内), host.call 换成
// fetch('/fge/api/<method>')(带 x-dsh-plugin: 1 头), styles.insert 换成手动 <style> 注入。
//
// 本插件的浏览器半边只有四件事:
//   1. kind 'fge-git'   右侧栏「git 页签」: 变更列表 + 提交历史, 提交**就地展开**;
//   2. kind 'fge-diff'  diff 详情页签: 一开出来就被浮起, 内容交给官方 primitives.DiffBlock;
//   3. conversation.composer.dock  终端抽屉的「抽屉舌」(居中、点击向上展开);
//   4. **影子替换**官方文档页签的芯片槽(`sidebar.right.pane.tab.title`, key = 官方 text
//      类型 id), 借它拿到该页签的 `tabId`, 再把官方正文页签 `ctx.sidebarRight.float()`
//      成一个悬浮面板 —— 于是 markdown / 代码 / 图片 / html / pdf 全是官方原版, 本插件零正文
//      渲染代码。拿 tabId 的路为什么只有这一条, 见 docs/adr/0003。
//
// 两条对所有详情都成立的保证(成因与实测见 docs/adr/0004):
//   · **详情只以浮层出现**: 浮起前那次"座位绑定空隙"用**微任务**重试(定时器会把详情页签在
//     页签条上画出 3–5 帧 —— 就是使用者说的"先加一个 tag, 闪一下, 消失");
//   · **右栏不自己跳页签**: 浮起之后把用户原本选中的那一格 `focus()` 回来(dockkit 的 float 会把
//     活动页签改成"详情左边那一格", 从「文件」点文件就会跳去 git 树)。
//
// ⚠ 影子替换的机制(实测 SlotCore.register): keyed 槽**同 key 同 priority 会直接抛错**,
//   渲染取的是排序后该 key 的**第一条**, 而排序按 priority **升序**(最低者渲染)。
//   官方 `text` 类型的 title 注册没有 priority(即 0), 所以本插件必须用**负数** priority。
//   (ADR-0003 原文写的"注册已占用的 key 会替换该占用者"不够准确, 已在 ADR 里补正。)
//
// ⚠ 单一悬浮面板: 文档详情与 diff 详情共用同一个 `floatTarget` 记账, 开新的先关旧的, 于是观感
//   就是"内容就地更换"。
window.__ModuleLoader__.load({
  id: 'dsh-file-git-explorer',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var React = require('react');
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    exports.name = 'dsh-file-git-explorer';

    /**
     * 官方右侧栏注册表 / 槽位注册表 / 悬浮面板控制面, 以及**官方终端内核**
     * (`webTerminals`: 抽屉里的终端由它提供, 见 ADR-0006 与 package.json 的 `dsh.client.inject`)。
     */
    exports.inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'webTerminals'];

    // ---- 按目录归类(纯函数) ----
    //
    // 变更列表与提交展开出来的文件列表**共用**这一套: 一批路径折成一棵目录树, 同一目录只出现一次
    // 目录行、文件名缩进列在下面 —— 而不是每个文件都把完整路径从头平铺一遍
    // (`a/a1` + `a/a2` → `a/` 底下 `a1`、`a2`)。
    //
    // ⚠ 放在 apply 外面是为了让 `tests/verify-client-bundles.mjs` 能离线直接跑这两个函数
    //   (浏览器 bundle 不能 require 本包自己的模块), 见 exports.__pathTree。

    /** 目录树节点: `name` 是本段目录名, `path` 是根到这里的完整路径(做 React key 用)。 */
    function newDirNode(name, path) {
      return { name: name, path: path, dirs: [], files: [] };
    }

    /**
     * 一批带路径的东西 → 目录树。`pathOf(item)` 取路径, 结果挂在 `files[].item` 上原样带回。
     * 顺序: 目录在前(首次出现的次序, 即 host 排好的路径序), 文件跟在后面。
     */
    function buildPathTree(items, pathOf) {
      var root = newDirNode('', '');
      for (var i = 0; i < items.length; i += 1) {
        var item = items[i];
        var path = String(pathOf(item) || '');
        var segs = path.split('/');
        var node = root;
        for (var s = 0; s < segs.length - 1; s += 1) {
          var next = null;
          for (var d = 0; d < node.dirs.length; d += 1) {
            if (node.dirs[d].name === segs[s]) {
              next = node.dirs[d];
              break;
            }
          }
          if (next === null) {
            next = newDirNode(segs[s], node.path === '' ? segs[s] : node.path + '/' + segs[s]);
            node.dirs.push(next);
          }
          node = next;
        }
        node.files.push({ name: segs[segs.length - 1], path: path, item: item });
      }
      return root;
    }

    /**
     * 单链目录压缩: `plugins` → `file-git-explorer` → `lib` 这种**自己没文件、又只套着一个目录**
     * 的链并成一行 `plugins/file-git-explorer/lib` —— 否则一个文件的深路径要白吃三行。
     */
    function compactDirNode(node) {
      var name = node.name;
      var cur = node;
      while (cur.files.length === 0 && cur.dirs.length === 1) {
        cur = cur.dirs[0];
        name = name + '/' + cur.name;
      }
      var out = newDirNode(name, cur.path);
      out.files = cur.files;
      for (var i = 0; i < cur.dirs.length; i += 1) {
        out.dirs.push(compactDirNode(cur.dirs[i]));
      }
      return out;
    }

    /** 整棵树的入口: 根自己不是一行, 只把它的直接子目录逐个压一遍。 */
    function compactPathTree(root) {
      var out = newDirNode('', '');
      out.files = root.files;
      for (var i = 0; i < root.dirs.length; i += 1) {
        out.dirs.push(compactDirNode(root.dirs[i]));
      }
      return out;
    }

    /**
     * 层级线(纵向虚线)的网格: 与 `indentPx` 同一套步长(每深一层 +12px)。
     * `GUIDE_X0 = 9 + 12/2 = 15` —— 正好是**第 0 层目录的文件夹图标中心**, 线就吊在父目录的图标下面。
     */
    var GUIDE_X0 = 15;
    var GUIDE_STEP = 12;

    /**
     * 一行(或一个目录行)要画的层级线 —— **纯函数**, 只吐描述, 由调用方画成绝对定位的元素。
     *
     * 一列 k 代表"第 k 层那个目录的**子项**连线", 画在 x = GUIDE_X0 + 12k 上。本行的每一列:
     *   · k < depth-1(祖先的祖先): 只有当"第 k+1 层那个祖先**还有后续兄弟**"时才继续贯穿本行 ——
     *     它已经是最后一个子项的话, 那一列早在它自己那一行就收住了。
     *   · k = depth-1(父那一列): 本行就是它的子项, 一定有线; 本行是父的**最后一个**子项时收到**行中**。
     *   · k = depth(自己那一列): 只在"本行是有子项的目录"时, 从**行中**起头连下去。
     *
     * @param pos `{ depth, isLast, continues }` —— 行在树里的位置(见 makeTreeRows)
     * @param hasChildren 本行是不是"有子项的目录"
     * @returns `[{ x, part }]`, part = 'full'(整行) | 'top'(上半行) | 'bottom'(下半行)
     *          ⚠ 叫 `part` 不叫 `h`: 这个文件里 `h` 是 `React.createElement` 的别名, 别撞。
     */
    function guideSegments(pos, hasChildren) {
      var depth = pos.depth;
      var continues = pos.continues;
      var out = [];
      for (var k = 0; k < depth - 1; k += 1) {
        if (continues[k] === true) out.push({ x: GUIDE_X0 + k * GUIDE_STEP, part: 'full' });
      }
      if (depth > 0) {
        out.push({ x: GUIDE_X0 + (depth - 1) * GUIDE_STEP, part: pos.isLast ? 'top' : 'full' });
      }
      if (hasChildren === true) out.push({ x: GUIDE_X0 + depth * GUIDE_STEP, part: 'bottom' });
      return out;
    }

    /** 行缩进: 9px 是 `.fge-row` / `.fge-dir` 的左右内边距, 每深一层再加 12px。 */
    function indentPx(depth) {
      return String(9 + depth * 12) + 'px';
    }

    /**
     * 目录树 → 行数组的**工厂**: 把 `h` 注入进来, 于是 apply 外层也能**真跑**它
     * (见 `exports.__treeRows` —— 离线护栏里那次真的是把树跑成行数组, 不是 grep 源码)。
     *
     * 对外只暴露两个:
     *   · `root(tree, keyPrefix, makeFileRow)` —— **顶层入口**。顶层没有祖先列(`continues` 恒为空),
     *     包这一层是为了让两个调用点都只传三个参数: 少一个位置就传不出错。
     *     ⚠ 之前这里出过一次事故: 顶层调用直接把 `[]` 塞进了 `makeFileRow` 那一格, 而按目录归类
     *     只在"有目录"时才触发, 于是 grep 式的护栏完全没拦住, 一渲染就炸。参数变少 + 有真调用,
     *     这类错才拦得住。
     *   · `fileRow(pos, props)` —— 文件行的**壳**(缩进 + 层级线 + 完整路径 title + basename),
     *     两份列表共用;调用方只给"行首那块"和点下去做什么。
     *
     * `pos = { depth, isLast, continues }`: `continues[j] = 第 j+1 层祖先还有后续兄弟`(见 guideSegments)。
     */
    function makeTreeRows(h) {
      /** guideSegments 的描述 → 绝对定位的虚线片(行自身 `position:relative`)。 */
      function guideSpans(segments) {
        var out = [];
        for (var i = 0; i < segments.length; i += 1) {
          out.push(
            h('span', {
              key: 'g:' + String(segments[i].x),
              className: 'fge-guide',
              'data-part': segments[i].part,
              style: { left: String(segments[i].x) + 'px' },
            }),
          );
        }
        return out;
      }

      /** 文件行的壳: 层级线一律在这里挂上 —— 新加一份列表照着用它, 就不会漏画线。 */
      function fileRow(pos, props) {
        return h(
          'div',
          {
            key: props.key,
            className: 'fge-row',
            style: { paddingLeft: indentPx(pos.depth) },
            title: props.title,
            onClick: props.onClick,
          },
          guideSpans(guideSegments(pos, false)),
          props.leading,
          h('span', { className: 'fge-name' }, props.name),
        );
      }

      /** 递归本体。`continues` 只在这里往下传(把自己"还有没有后续兄弟"追加到末尾)。 */
      function rows(node, depth, keyPrefix, makeFileRow, continues) {
        var total = node.dirs.length + node.files.length;
        var out = [];
        for (var d = 0; d < node.dirs.length; d += 1) {
          var dir = node.dirs[d];
          var lastDir = d === total - 1;
          var kids = dir.dirs.length + dir.files.length > 0;
          out.push(
            h(
              'div',
              {
                key: keyPrefix + 'd:' + dir.path,
                className: 'fge-dir',
                style: { paddingLeft: indentPx(depth) },
                title: dir.path,
              },
              guideSpans(guideSegments({ depth: depth, isLast: lastDir, continues: continues }, kids)),
              h(primitives.IconFolderClose16, { size: 12, className: 'fge-dir-glyph' }),
              h('span', { className: 'fge-name' }, dir.name),
            ),
          );
          out = out.concat(
            rows(dir, depth + 1, keyPrefix, makeFileRow, continues.concat([!lastDir])),
          );
        }
        for (var f = 0; f < node.files.length; f += 1) {
          out.push(
            makeFileRow(node.files[f], {
              depth: depth,
              isLast: node.dirs.length + f === total - 1,
              continues: continues,
            }),
          );
        }
        return out;
      }

      return {
        root: function (tree, keyPrefix, makeFileRow) {
          return rows(tree, 0, keyPrefix, makeFileRow, []);
        },
        fileRow: fileRow,
      };
    }

    /**
     * 终端里的 **16 色 ANSI 调色板** —— 纯函数, 明暗各一套(离线护栏会拿它算对比度, 见 `exports.__terminalPalette`)。
     *
     * ⚠ 为什么必须自己给: xterm 只设 `background` / `foreground` 时, 其余 16 色回落成它**内置的默认调色板**,
     *   而那套是**为深色背景设计的** —— 亮白 `#ffffff` / 亮黄 `#ffff00` / 亮青之类落到浅色终端面上
     *   (官方浅色 `#f9fafb`, 本机主题 `#E4EAE0`)几乎看不见; 更糟的是 `drawBoldTextInBrightColors`
     *   默认开着, **加粗**的文字会切到那排"亮色"上 —— 就是用户报的"字体高亮导致看不清"。
     *
     * ⚠ **亮色那一排是反的: 浅色主题下"亮"要更暗、更深**(对比度才是"更亮"), 深色主题下才是更亮。
     *   两套都保证每个颜色与终端面的对比度达标(浅色 ≥ 4.5:1, 深色的 `black` 是"暗淡槽" ≥ 3:1),
     *   所以 `drawBoldTextInBrightColors` 开着也不会掉进看不清的坑。
     *
     * ⚠ 这里**确实写死了颜色**: 主题里没有 ANSI 调色板这组 token(只有面/状态色), 官方也没定义。
     *   面与前景仍走主题 token(见 terminalTheme), 只有这 16 个"语法色"是常量 —— 与 diff 行数用的
     *   `#3fa34d` / `#d9534f` 同一种性质。改色时**必须**跑一遍离线对比度断言。
     */
    function terminalPalette(dark) {
      if (dark) {
        return {
          black: '#6b7280',
          red: '#f87171',
          green: '#4ade80',
          yellow: '#facc15',
          blue: '#60a5fa',
          magenta: '#e879f9',
          cyan: '#22d3ee',
          white: '#d1d5db',
          brightBlack: '#9ca3af',
          brightRed: '#fca5a5',
          brightGreen: '#86efac',
          brightYellow: '#fde68a',
          brightBlue: '#93c5fd',
          brightMagenta: '#f0abfc',
          brightCyan: '#67e8f9',
          brightWhite: '#f9fafb',
        };
      }
      return {
        black: '#24292f',
        red: '#b91c1c',
        green: '#166534',
        yellow: '#854d0e',
        blue: '#1d4ed8',
        magenta: '#86198f',
        cyan: '#155e75',
        white: '#4b5563',
        brightBlack: '#57606a',
        brightRed: '#991b1b',
        brightGreen: '#14532d',
        brightYellow: '#713f12',
        brightBlue: '#1e3a8a',
        brightMagenta: '#701a75',
        brightCyan: '#164e63',
        brightWhite: '#111827',
      };
    }

    /**
     * 页签左右切换的**纯逻辑**: 给当前下标、总个数、方向(`-1` 左 / `+1` 右), 返回该切过去的下标;
     * **越界返回 -1**(调用方据此什么都不做)。
     *
     * ⚠ 刻意**不环绕**(用户口径: "不做无限切换"): 已经在最左一格还按 Alt+J, 就让它什么都不发生 ——
     *   环绕会让人从"最右"突然跳到"最左", 反而失去方位感。
     */
    function tabNeighbor(index, count, step) {
      if (index < 0 || count <= 1) return -1;
      var next = index + step;
      if (next < 0 || next >= count) return -1;
      return next;
    }

    /** git 数据快照的**新鲜窗口**(毫秒): 窗口内切会话**一个请求都不发**(见 gitDataDecision)。 */
    var GIT_DATA_FRESH_MS = 30 * 1000;

    /**
     * 工作区键: 归一化 cwd —— 反斜杠折成 `/`、去掉尾斜杠、Windows 盘符与 UNC 折大小写,
     * 于是 `E:\a\b\` 与 `e:/a/b` 是同一个工作区。空 / 非字符串返回 null(= 没有工作区, 不缓存也不复用)。
     */
    function workspaceKey(cwd) {
      if (typeof cwd !== 'string') return null;
      var key = cwd.trim().replace(/\\/g, '/').replace(/\/+$/, '');
      if (key === '') return null;
      var foldable = /^[A-Za-z]:/.test(key) || key.slice(0, 2) === '//';
      return foldable ? key.toLowerCase() : key;
    }

    /**
     * 挂载 / 切会话时该怎么对待这份**工作区快照** —— 纯函数, 离线护栏直接跑它
     * (出口见 `exports.__gitDataDecision`)。三选一:
     *   `'skip'`       同工作区且快照还新鲜: 一个请求都不发, 快照原样铺上屏;
     *   `'revalidate'` 同工作区但快照旧了: 先把快照铺上屏, 再在后台重取一次(不白屏、不等待);
     *   `'load'`       没有这个工作区的快照(或工作区还不知道): 按老规矩从头取。
     */
    function gitDataDecision(snapshot, sessionCwd, now, freshMs) {
      var key = workspaceKey(sessionCwd);
      if (key === null) return 'load'; // 工作区还不知道: 不能拿别的仓库的数据顶上
      if (snapshot === undefined || snapshot === null) return 'load';
      if (workspaceKey(snapshot.cwd) !== key) return 'load';
      return now - snapshot.at < freshMs ? 'skip' : 'revalidate';
    }

    /**
     * 「最后一行有内容」的**纯逻辑**: 从 `from` 往上找第一行有文字的行号(全是空行给 `-1`)。
     * `readLine(i)` 给第 `i` 行的文本(**已右侧裁剪**), 空行给 `''`。
     *
     * ⚠ 只用来收**尾巴**: 中间的空行是内容的一部分(两条命令之间本来就可能是空行), 绝不许动它。
     *   终端里真正"一个字都没有"的, 只有**最深那行有内容的下方**那一整块。
     * ⚠ 扫描上界是确定有界的: xterm 的光标之上才是内容, 从底往上最多扫 `rows` 行就撞到光标那行。
     */
    function findLastContentRow(readLine, from) {
      for (var i = from; i >= 0; i--) {
        var text = readLine(i);
        if (typeof text === 'string' && text !== '') return i;
      }
      return -1;
    }

    /**
     * 把选区的**尾端**收到 `lastRow`(最后一行有内容的那行) —— 纯逻辑, 离线可断言。
     * `range` 是 `term.getSelectionPosition()` 的结果(xterm 给的已经是**归一化**过的, `start` 在前)。
     * `expandTail` = "这次拖拽被边界挡过"(见 `onMoveCapture` 里那个吃事件的开关)。
     *
     * - 尾巴本来就在 `lastRow` 以内 → `null`(这次选区不用动);
     * - **两端都**在 `lastRow` 以下(整段都拖在空白里) → `{clear:true}` —— 那儿一个字都没有, 不该有选区;
     * - 尾巴越过 `lastRow`, 或**正好贴在 `lastRow` 但这次被边界挡过** → 补到 `lastRow` 的 `lastCol` 列
     *   (= **该行文字末尾**)。⚠ 跟 xterm 自己的口径一致 —— 它拖出视口下方时也是把 `selectionEnd[0]`
     *   直接设成 `cols`(整行), 而不是留着鼠标那一列在那儿拖一片空格底色的假选区。
     *   ⚠ `expandTail` 不能省: 拖到一半被挡住时, 鼠标那一列已经冻在越界的那一刻了(继续往右拖也收不到
     *     事件), 不补的话"拖到底"会把最后一行**截断**(实测: `gamma-here` 只选到 `gamma-h`);
     *     而**没被挡过**的时候绝不能补 —— 那可能是双击选词、或用户就是要选到某一列。
     *
     * `length` 是**线性格子数**: xterm 的 `select(col,row,len)` 就是按"起点 + 长度"、用列数折行算终点的。
     */
    function clampSelectionTail(range, lastRow, lastCol, cols, expandTail) {
      if (range === null || typeof range !== 'object' || !range.start || !range.end) return null;
      if (!(lastRow >= 0) || !(cols > 0)) return null;
      var start = range.start;
      var end = range.end;
      if (end.y < lastRow) return null;
      if (start.y > lastRow) return { clear: true };
      var col = Math.min(Math.max(lastCol, 0), cols);
      if (end.y === lastRow && (expandTail !== true || end.x >= col)) return null;
      var length = (lastRow - start.y) * cols + (col - start.x);
      if (!(length > 0)) return { clear: true };
      return { column: start.x, row: start.y, length: length };
    }

    /**
     * 鼠标 y → **绝对行号** —— 纯逻辑, 离线可断言。算法与 xterm 自己的 `getCoords` 同款
     * (按格高取整 + 夹到 `[1, rows]`, 再换算成绝对行), 所以"内容下方"这条边界跟 xterm 认的边界
     * 处处对得上: 指针跑到视口下方时它夹到最后一行、上方时夹到第一行。
     * `-1` = 这次算不出来(容器还没布局、参数不合理), 调用方据此什么都别做。
     */
    function mouseRowAt(clientY, rectTop, rectHeight, rows, viewportY) {
      if (!(rectHeight > 0) || !(rows > 0)) return -1;
      var row = Math.ceil((clientY - rectTop) / (rectHeight / rows));
      row = Math.min(Math.max(row, 1), rows);
      return viewportY + row - 1;
    }

    /**
     * 把官方终端的一帧交给 xterm, 返回**新的 `lastRevision`**(原值 = 这一帧被丢掉)。
     *
     * - `snapshot`: 先 `reset()` + 按 host 的 `info.cols/rows` `resize()`, 再写 `frame.screen`
     *   —— 顺序反了就是串屏;
     * - `output`: 直接写 `frame.data`;
     * - **两者都要在 `write` 回调里 `acknowledge(revision)`**: 官方那条流是 await 这次 ack 才放下一帧的,
     *   漏掉就再也没有输出了(见 ADR-0006)。
     *
     * 放在工厂作用域(而不是 apply 里)是为了离线护栏能拿假 xterm / 假 view 把这条契约直接跑一遍。
     */
    function applyTerminalFrame(term, view, render, lastRevision) {
      if (term === null || view === null || render === undefined || render === null) {
        return lastRevision;
      }
      if (render.revision <= lastRevision) return lastRevision;
      var frame = render.frame;
      if (frame.type === 'snapshot') {
        try {
          term.reset();
          term.resize(frame.info.cols, frame.info.rows);
        } catch (e) {
          // 尺寸异常也照旧写屏: 宁可先看见内容, 也别整屏丢掉
        }
      }
      term.write(frame.type === 'snapshot' ? frame.screen : frame.data, function () {
        try {
          view.acknowledge(render.revision);
        } catch (e) {
          // view 已经拆了: ack 不再有意义
        }
      });
      return render.revision;
    }

    exports.apply = function (ctx) {
      var slots = ctx.slots;
      var h = React.createElement;

      // ---- 身份 ----

      var GIT_ID = 'dsh-file-git-explorer/git';
      var GIT_KIND = 'fge-git';
      var DIFF_ID = 'dsh-file-git-explorer/diff';
      var DIFF_KIND = 'fge-diff';
      /** 官方 text 正文类型的实现 id(= 页签芯片槽的 key, 见 ADR-0003)。 */
      var DOC_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview';
      /** 影子注册必须**低于**官方的 0, 否则同 key 同档直接抛错。 */
      var DOC_PRIORITY = -1;

      var API_BASE = '/fge/api';
      var VENDOR_BASE = '/fge/vendor';
      /**
       * 抽屉这个终端在**官方终端 view 表**里的 occurrence key(官方按 `(sessionId, key)` 缓存)。
       *
       * 用固定字面量, 所以同一个会话反复开关抽屉拿回的是**同一个**终端 —— 与官方 `terminal` 页签
       * (multiple: true, key = 每次新铸的页签 id)不在一个空间, 两种入口互不干扰。
       */
      var TERM_KEY = 'fge-dock';
      var TERM_HEIGHT_KEY = 'fge-term-height-v1';
      /**
       * 终端「选中即复制」开关的存储键。**默认开**(用户要的就是"选中就复制"), 关掉只停**自动**那一条 ——
       * Alt+C 兜底不受开关影响。整机一个偏好, 不按工作区/会话分。
       */
      var TERM_COPY_KEY = 'fge-term-copy-v1';
      var TERM_MIN_PCT = 20;
      var TERM_MAX_PCT = 70;
      var TERM_DEFAULT_PCT = 40;
      var COMMIT_PAGE = 50;
      var DIFF_KEEP = 8;
      /**
       * git 页签正文的**上下两栏**分栏比例: 上栏 = 变更列表(当前 diff), 下栏 = 提交历史 / 聚焦提交。
       *
       * 上栏默认占正文的 **3/4**(用户口径); 中间那条 5px 拖柄可以拖, 拖过的值记在 `localStorage`
       * (与终端抽屉高度同款), 双击拖柄回到 75。比例是**整个页签**的偏好, 不按会话分。
       *
       * 可拖区间 `[GIT_SPLIT_MIN, GIT_SPLIT_MAX]`: 上限是"下栏至少留一条", 下限由
       * **下栏最多 60%** 反推(用户口径: 往上拉别把变更列表挤没)。正文高度 = 整页高度减页签头那 38px,
       * 所以"下栏 ≤ 60% 正文"一定 ≤ 60% 页面高度 —— 不需要再去量视口, 这个常量就是那条约束。
       * 聚焦一条提交时下栏放到最大(上栏收到 `GIT_SPLIT_MIN`), 返回时再还回去(见 §14)。
       */
      var GIT_SPLIT_KEY = 'fge-git-split-v1';
      var GIT_SPLIT_DEFAULT = 75;
      var GIT_SPLIT_BOTTOM_MAX = 60;
      var GIT_SPLIT_MIN = 100 - GIT_SPLIT_BOTTOM_MAX;
      var GIT_SPLIT_MAX = 90;
      /** 右侧栏最大宽度(视口百分比)。官方的首开宽度是 45%、上限 70%, 这里按用户要求压到 15。 */
      var RIGHTBAR_MAX_VW = 15;
      /**
       * 右侧栏拖动下限(px)。上限仍是 `RIGHTBAR_MAX_VW`, 可拖区间 = [200px, 15vw]
       * (1600 宽 → 200–240, 1920 宽 → 200–288)。宽度拖完记住, 见 readRightbarWidth/persistRightbarWidth。
       */
      var RIGHTBAR_MIN_PX = 200;
      /** 拖动后宽度的存储键(与终端高度同款: localStorage, 刷新 / 切会话都在)。 */
      var RIGHTBAR_WIDTH_KEY = 'fge-rightbar-w-v1';
      /** 第三轨 / 面板宽度 / 拖柄位置共用的那一个值: 拖动过的 px 优先, 没拖过就按上限 15vw。 */
      var RIGHTBAR_TRACK = 'min(var(--fge-rightbar-px,' + String(RIGHTBAR_MAX_VW) + 'vw),' + String(RIGHTBAR_MAX_VW) + 'vw)';
      /**
       * 终端表面色 = 官方的「代码 / 终端卡片」底色(`--dsw-alias-markdown-code-block`)。
       *
       * ⚠ 不能用 `--dsw-alias-bg-base` / `bg-layer-*`: 官方浅色主题里这几个 token **全是纯白**,
       * 终端就与页面完全融合(实测: 用户主题下整个抽屉糊进背景, 连标题条的分隔线都看不出来)。
       * 官方终端卡片(`TerminalBlock` / `ioCard`)用的正是 code-block 底色 + `border-l1` 描边。
       * 兜底: 旧主题没有该 token 时回落到 `bg-base`。
       */
      var TERM_SURFACE = 'var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-base))';
      /** xterm 只吃具体颜色: JS 侧按这个名字读 token 再归一(见 terminalTheme)。 */
      var TERM_SURFACE_TOKEN = '--dsw-alias-markdown-code-block';
      /** float() 的重试预算: 座位瞬时缺位(见 floatWithRetry)下一次就够, 这里留足余量。 */
      var FLOAT_ATTEMPTS = 6;
      var FLOAT_RETRY_MS = 60;
      /**
       * 座位绑定空隙用微任务重试的次数(见 retryFloat): 空隙在同一次 effect flush 收尾就补好,
       * 1 次就够, 留 2 次只是容错。之后才退回定时器。
       */
      var FLOAT_MICRO_ATTEMPTS = 2;
      /** 右侧栏默认页签的重试预算(等座位绑定 + files 类型到位)。 */
      var SEED_ATTEMPTS = 20;
      var SEED_RETRY_MS = 150;

      // ---- host 调用 ----

      function api(method, payload) {
        return fetch(API_BASE + '/' + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-plugin': '1' },
          body: JSON.stringify(payload || {}),
        }).then(function (res) {
          if (!res.ok) throw new Error('fge: http ' + String(res.status));
          return res.json();
        });
      }

      // ---- 会话根目录 ----

      /**
       * 当前会话工作区 cwd; 会话没有 cwd 时回退 null(由调用方落到 info.cwd)。
       * 快照形状: { current, byId: { [id]: { cwd, running } } }。
       */
      function useSessionCwd(useSessions, sessionId) {
        var value = null;
        if (typeof useSessions === 'function') {
          value = useSessions(function (s) {
            var id = sessionId || (s && s.current);
            var sess = s && s.byId && id ? s.byId[id] : null;
            return sess && typeof sess.cwd === 'string' && sess.cwd !== '' ? sess.cwd : null;
          });
        }
        if (typeof value !== 'string' && value !== null) return null;
        return value || null;
      }

      /** 当前会话的 agent 运行态: true→false 即 turn 结束。 */
      function useSessionRunning(useSessions, sessionId) {
        var value = false;
        if (typeof useSessions === 'function') {
          value = useSessions(function (s) {
            var id = sessionId || (s && s.current);
            var sess = s && s.byId && id ? s.byId[id] : null;
            return !!(sess && sess.running);
          });
        }
        return value === true;
      }

      // ---- 样式 ----

      function ensureStyles() {
        if (typeof document === 'undefined') return;
        var id = 'fge-styles';
        // ⚠ 已经插过也要**换掉**, 不能直接 return: 插件被热重载(不刷新页面)时旧的那个 <style> 还在,
        //   return 会把**旧 CSS** 一直留在页面上 —— 改样式的人会以为"改了没生效"。
        var old = document.getElementById(id);
        if (old !== null && typeof old.remove === 'function') old.remove();
        var el = document.createElement('style');
        el.id = id;
        el.textContent = [
          '.fge-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px;color:var(--dsw-alias-text-base,inherit)}',
          // git 页签头部: **高度必须 38px**(border-box)—— 页签条占 0–38, 官方的「文件」页签头也是 38px,
          // 于是头部底边线正好落在 y=76, 与会话头部(`wSkVaW_header`)的底边线、以及官方文件页签的下缘对齐。
          // 写成 padding 撑出来的高度(33.8px)会差 4px, 看上去就是"这条线跟上面那条没对齐"。
          '.fge-head{display:flex;align-items:center;gap:6px;box-sizing:border-box;height:38px;padding:0 8px;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:0 0 auto}',
          '.fge-btn{border:0;background:transparent;cursor:pointer;padding:2px 5px;border-radius:4px;color:inherit;font-size:12px;line-height:1.4}',
          '.fge-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
          '.fge-btn[disabled]{opacity:.45;cursor:default}',
          // 刷新键的图标换成**官方 SVG**(`primitives.IconRefreshOutline14`): 原来那个 `⟳` 是**文字字形**,
          // 同一个码位在不同平台/字体回退下画出来的粗细、大小、字形都不一样(Windows 上明显偏细偏小),
          // 与旁边那些官方图标(分支 / 上下箭头)不是一个画风。换成官方图标后三者同一套线条。
          // 这一格只管**自己的**居中和 busy 动画, 不动 `.fge-btn` 的通用盒子(返回键 / ■ 还各有自己的排版)。
          '.fge-refresh{display:inline-flex;align-items:center;justify-content:center}',
          // busy 时按钮本来就是 `disabled`(上面那条 .45), 图标**借这个状态转起来**当"正在 fetch"的提示 ——
          // 原来是用一个 `…` 字符表示, 换成图标后它和图标不能并存(会变成"图标 + 省略号")。
          '.fge-refresh[disabled] svg{animation:fge-spin 1s linear infinite}',
          '@keyframes fge-spin{to{transform:rotate(360deg)}}',
          // 分支按钮**撑满到刷新键之前**(用户口径: "加长到 fge-btn 前面"): 不再卡 `max-width:11em`,
          // 改成吃掉头部剩余空间。名字那一格 `min-width:0` 才能在里面省略号。
          // 头部的 `.fge-spacer` 因此不再需要(branch 自己就是那个弹性项), 否则两者会平分空白。
          '.fge-branch{display:flex;align-items:center;gap:4px;flex:1 1 auto;min-width:0;padding:2px 6px;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer}',
          '.fge-branch:hover{background:var(--dsw-alias-interactive-bg-hover)}',
          '.fge-branch-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          '.fge-branch-caret{flex:0 0 auto;color:var(--dsw-alias-label-tertiary)}',
          // 头部那颗分支按钮的小浮窗: 位置由官方 useAnchoredPosition 算(视口坐标), 所以 position:fixed
          // —— 这样既不被右栏面板的 overflow 裁掉, 也不受面板 transform 影响(展开态 transform:none)。
          '.fge-branch-menu{position:fixed;z-index:70;width:280px;max-width:70vw;max-height:min(60vh,420px);overflow:auto;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);font-size:12px}',
          '.fge-branch-group{padding:5px 6px 2px;font-size:10px;color:var(--dsw-alias-label-tertiary)}',
          '.fge-branch-item{display:flex;align-items:center;gap:4px;padding:3px 6px;border-radius:4px;color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer}',
          '.fge-branch-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
          '.fge-branch-item[data-viewed="1"]{color:var(--dsw-alias-brand-primary);font-weight:600}',
          '.fge-branch-sub{padding-left:16px}',
          '.fge-branch-mark{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-tertiary)}',
          // worktree 切换器(主仓 / 各 worktree): 触发按钮和分支那颗**共用菜单样式**,
          // 但**不能也 flex:1** —— 弹性项只能有一个, 否则两者平分空白、分支按钮就长不到 ⟳ 前面。
          // 所以这里 `flex:0 0 auto` + 自己的最大宽度; 菜单内部照旧用 .fge-branch-menu / -item / -group。
          '.fge-wt{display:flex;align-items:center;gap:4px;flex:0 0 auto;max-width:11em;padding:2px 6px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}',
          '.fge-wt:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
          '.fge-wt[data-away="1"]{color:var(--dsw-alias-brand-primary)}',
          '.fge-wt-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          '.fge-wt-sub{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-tertiary)}',
          '.fge-branch-item[data-current="1"]{color:var(--dsw-alias-brand-primary);font-weight:600}',
          '.fge-ab{display:inline-flex;gap:4px;font-variant-numeric:tabular-nums;opacity:.85}',
          '.fge-spacer{flex:1 1 auto}',
          // git 页签正文 = **上下两栏**(上 = 变更列表 / 当前 diff, 默认 3/4; 下 = 提交历史),
          // 两栏**各自滚动**、各自吸顶, 中间一条 5px 拖柄调占比(见 GIT_SPLIT_*)。
          // 上栏的 flex-basis 由行内样式给(拖动/记忆都在 GitTabBody 里), 这里只管排布。
          '.fge-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;padding:0}',
          // ⚠ 两栏**都不显示滚动条**(用户口径: "fge-pane fge-pane-bottom 的滚动条也隐藏, 同理 fge-pane 也隐藏")。
          //   隐藏之后:
          //   · 仍然可滚(滚轮 / 键盘照常), 只是没有那条可见轨道;
          //   · **不会再有"形变"** —— 滚动条从不占位, 内容宽度恒定(这正是当初加 `scrollbar-gutter:stable`
          //     要解决的问题, 现在由"压根没有滚动条"更彻底地解决了, 所以那条留白**去掉**:
          //     留白本来就是给滚动条占位的, 没有滚动条它就是死代码);
          //   · 两栏内容宽度一起变宽 8px, 彼此仍然对齐(只隐藏其中一条才会错开 8px —— 那是不能做的)。
          //   · 展开的**提交说明自己那条滚动条保留**(`.fge-msg-text`), 那是"该滚的那一条"。
          //   两行都写: `scrollbar-width` 管标准属性, `::-webkit-scrollbar` 管 Chromium 当下的那条路
          //   (官方 CSS 把 `scrollbar-width` 藏在 `@supports not selector(::-webkit-scrollbar)` 里)。
          // ⚠ **上栏不留底部内边距**: 它原来有 `padding:0 0 6px`, 与下面那条 5px 拖柄叠起来就是**两栏
          //   之间一块约 11px 的空白带** —— 两栏底色都透出面板底色, 于是那一带看着就是"缺口"
          //   (用户口径: "fge-grip 导致两栏之间背景色不一致, 有空隙")。留白只留给**下栏最底缘**
          //   (见 `.fge-pane-bottom`), 夹在两栏中间的那一份彻底去掉。
          '.fge-pane{min-height:0;overflow:auto;scrollbar-width:none;padding:0}',
          '.fge-pane::-webkit-scrollbar{display:none}',
          '.fge-pane-bottom{flex:1 1 auto;padding:0 0 6px}',
          // ⚠ 与终端抽屉的上缘拖柄**同一口径**: 没有 hover 底色 —— 它同样是一整条通宽横带, 一亮就是
          //   一整条; 而这条正好夹在两块长得很像的列表之间, 变色会被读成"这一条跟别处不是一个颜色",
          //   不是"提示"。可拖的提示一样交给 `cursor:ns-resize`, 底色常驻 `transparent`。
          //
          // ⚠ 布局高度 = **1px**(就是那条分界线本身), 热区交给伪元素压上去 —— 5px 的实体盒子会在
          //   两栏之间再占出 4px 空隙, 正是上面那条要消掉的东西。热区仍是 5px(线 + 线上方 4px),
          //   与原来那条 5px 实体拖柄**一样好拖**, 只是不再撑出空隙。
          // ⚠ 必须 `z-index:2`: 两个 sticky 标题栏都是 `z-index:1`, 不压过它们, 热区在线那一带会被
          //   下栏的标题栏抢走(实测 elementFromPoint 命中 fge-section)—— 拖柄有一半按不动。
          //   热区**不向下越线**: 下栏顶上那几 px 留给标题栏, 免得连滚轮翻页都被吃掉。
          '.fge-grip{flex:0 0 auto;box-sizing:border-box;height:1px;position:relative;z-index:2;cursor:ns-resize;border-top:1px solid var(--dsw-alias-border-l3);background:transparent}',
          '.fge-grip::after{content:"";position:absolute;left:0;right:0;top:-4px;height:5px}',
          // 标题栏(上下两栏各一条): **不透明**的实色横条 + 下边一条 `.5px` 细线 ——
          // 官方的真 sticky 分组头(model-selection 的 groupTitle)就是这个配方
          // (`sticky/top:0/z-index:1`, 12px/500, label-tertiary, padding 5px 8px 3px)。
          //
          // ⚠ 底色是**两层**: 先铺 `--dsw-alias-bg-base`(右栏面板自己的底色, 按构造一定不透明),
          //   再把 `--dsw-alias-markdown-tag` 作为 `background-image` **叠在它上面**。
          //   为什么不直接把 markdown-tag 当 `background-color`: 它是**标签/芯片的填充色**,
          //   语义上就是一层淡强调色 —— 官方两套主题恰好把它定成实色(#f1f3f5 / #2c2c2e),
          //   但由强调色派生的主题会把它做成半透明(本机 Sage Mist 就是
          //   `rgba(135,186,129,0.14)`)。那样横条是透的, 滚上来的行照样从字缝里透出来
          //   (实测: 用户报"内容还是跨越到 fge-section 底部, 双重文字")。
          //   叠在实色面之上就与强调色的 alpha 无关了: 再怎么半透明, 挡住下面那层的也是底座;
          //   万一 token 无效, 这一层 `background-image` 整个失效, 剩下的 `bg-base` 仍然是实色。
          // ⚠ 原先是 `opacity:.72` + `background:var(--dsw-alias-bg-base,…)`: 浅色主题下 bg-base 恰好
          //   就是面板自己的颜色, 再叠 0.72 的不透明度 ⇒ 滚上来的行直接透过去。
          // ⚠ 横条**上边不画线**: 上栏那条来自 `.fge-head` 的 38px 底边线、下栏那条来自 `.fge-grip`
          //   的分界线;自己再画一条会叠成双线(两条 .5px 挨在一起就是 1px 的粗线)。
          '.fge-section{display:flex;align-items:center;gap:6px;position:sticky;top:0;z-index:1;box-sizing:border-box;padding:5px 8px 3px;font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-tertiary);background-color:var(--dsw-alias-bg-base,#fff);background-image:linear-gradient(var(--dsw-alias-markdown-tag,rgba(0,0,0,.05)),var(--dsw-alias-markdown-tag,rgba(0,0,0,.05)));border-bottom:.5px solid var(--dsw-alias-border-l3)}',
          // 聚焦提交的头部: `← 返回` 在左、`作者 · 时间` 居中可截断、hash 胶囊在右(两头永不被截断)。
          '.fge-back{display:inline-flex;align-items:center;gap:2px;flex:0 0 auto;margin-left:-3px;color:var(--dsw-alias-label-secondary);font-weight:600}',
          '.fge-focus-meta{flex:1 1 auto;min-width:0;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          // 聚焦态: 整栏一层**极淡的品牌色底**当容器感(上栏的变更列表不受影响)——
          // 一眼看出"这一栏不是列表, 我在某一条里面"。
          '.fge-pane-bottom[data-focus="1"]{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 6%, transparent)}',
          // 聚焦态下栏**不用再单独藏滚动条** —— `.fge-pane` 已经不显示滚动条了(见上), 这里不再重复。
          '.fge-row{display:flex;align-items:center;gap:6px;position:relative;padding:3px 9px;cursor:pointer;white-space:nowrap}',
          '.fge-row:hover{background:rgba(128,128,128,.16)}',
          // 目录行(按目录归类): 比文件行重一档, 只出现一次目录名, 文件名缩进在它下面。
          '.fge-dir{display:flex;align-items:center;gap:5px;position:relative;padding:3px 9px;font-weight:600;opacity:.82;white-space:nowrap}',
          // 层级线(纵向虚线): **1px** dashed —— 官方没有先例(官方文件树完全不画缩进线, 最近的
          // subagent 树是 .5px **实线**), 而 .5px 的虚线在屏幕上会碎成看不见, 所以刻意用 1px 虚线。
          // 线挂在行的**绝对定位**子元素上, 一行的长短由 guideSegments 算(见 §14)。
          '.fge-guide{position:absolute;top:0;bottom:0;width:0;border-left:1px dashed var(--dsw-alias-border-l2);pointer-events:none}',
          '.fge-guide[data-part="top"]{bottom:50%}',
          '.fge-guide[data-part="bottom"]{top:50%}',
          '.fge-dir-glyph{flex:0 0 auto;color:var(--dsw-alias-label-tertiary)}',
          // 文件名只出 basename(完整路径在 title 里), 长名尾部省略 —— min-width:0 是 flex 行里能截断的前提。
          '.fge-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          '.fge-badge{flex:0 0 auto;width:1.15em;text-align:center;font-weight:700;border-radius:3px;font-size:11px;background:rgba(128,128,128,.2)}',
          '.fge-badge[data-b="M"]{color:#c9822b}.fge-badge[data-b="A"]{color:#3fa34d}.fge-badge[data-b="D"]{color:#d9534f}',
          '.fge-badge[data-b="R"]{color:#4a7fd9}.fge-badge[data-b="C"]{color:#4a7fd9}.fge-badge[data-b="U"]{color:#d9534f}',
          '.fge-empty{padding:14px 10px;opacity:.65;text-align:center}',
          '.fge-dl-add{color:#3fa34d}.fge-dl-del{color:#d9534f}',
          '.fge-commit{display:flex;flex-direction:column;gap:1px;padding:4px 9px;cursor:pointer;border-bottom:1px solid rgba(128,128,128,.14)}',
          '.fge-commit:hover{background:rgba(128,128,128,.16)}',
          '.fge-commit-sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          // 提交行第二行: `作者 · 时间` + hash 胶囊。胶囊单独一层 —— 不跟着 .6 的透明度一起发灰。
          '.fge-commit-meta{display:flex;align-items:center;gap:5px;font-size:11px}',
          '.fge-commit-meta-text{flex:1 1 auto;min-width:0;opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          // hash 胶囊: 长着 `.fge-chip` 的样子(999px 圆角 + hover 底), 点一下复制**完整** hash。
          '.fge-hash{flex:0 0 auto;border:0;color:inherit;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;line-height:1.6;cursor:pointer}',
          '.fge-hash:hover{color:var(--dsw-alias-label-primary)}',
          '.fge-hash[data-s="done"]{color:#3fa34d}',
          '.fge-hash[data-s="failed"]{color:#d9534f}',
          // 提交说明(展开一条提交后最上面那块): **折叠态只显示两行**, 放不下才出现「展开 / 收起」。
          // 右栏最窄 200px, 一段带 body 的 message 直接铺开会占掉半屏 —— 展开文件清单都看不见了。
          // ⚠ 用 `-webkit-box` + `-webkit-line-clamp` 折行截断, 是否放得下**量** `scrollHeight > clientHeight`
          //   (Chromium 实测: 5 行 → clientHeight 36 / scrollHeight 90; 正好两行 → 两边都是 36, 不误报)。
          // ⚠ 开关(`.fge-msg-bar`)画在**文字上方**: 展开后它原地不动, 不用拉滚动条去找「收起」(用户口径)。
          '.fge-msg{margin:0;padding:6px 9px 4px;border-bottom:1px solid rgba(128,128,128,.16)}',
          // 开关**独占一行**、左对齐 —— 左对齐意味着它的 x 与容器宽度无关(右对齐会随滚动条/右栏拖宽漂移),
          // 这就是用户要的"固定位置"。它画在文字**上方**, 所以展开后也不会跑到全文末尾去。
          '.fge-msg-bar{margin:0 0 2px;text-align:left;line-height:1}',
          '.fge-msg-text{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit;font-size:12px;line-height:1.5}',
          '.fge-msg-text[data-clamp="1"]{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}',
          // 展开态: **自己滚**, 不再把整栏撑长(用户口径: 展开后滚动条该出现在这一段里, 而不是 fge-pane)——
          // 说明顶多占 ~14 行, 下面的文件清单与开关都留在原地, 整栏也不会因此重排。
          // `:not([data-clamp="1"])` 就是展开态(clamp 只在折叠时挂)。`scrollbar-gutter:stable` 同理:
          // 这一段自己出滚动条时, 里面的文字宽度也不许变。
          '.fge-msg-text:not([data-clamp="1"]){max-height:calc(1.5em * 14);overflow:auto;scrollbar-gutter:stable}',
          '.fge-msg-toggle{padding:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font:inherit;font-size:11px;line-height:1.4;cursor:pointer}',
          '.fge-msg-toggle:hover{color:var(--dsw-alias-label-primary)}',
          '.fge-numstat{flex:0 0 auto;display:flex;gap:6px;align-items:baseline;font-size:11px;font-variant-numeric:tabular-nums}',
          // diff 悬浮面板的正文: 官方 FloatLayer 的 body 自己会滚, 这里只管排布与留白。
          '.fge-diff{padding:6px 8px 10px}',
          // diff 页签的芯片文字: 截断交给官方那层(它有 min-width:0 + overflow:hidden + mask 渐隐)。
          // ⚠ **不再自己钉 `max-width:22em`**: 浮窗是半屏宽, 22em(≈253px)会在有地方的时候先把路径截掉 ——
          //   与"文件名显示不全"是同一个病。页签条里它照样被官方那层的宽度挤着, 不会溢出。
          '.fge-chip-label{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          // 影子芯片上的「复制内容」: 只占一枚小图标, 不吃掉页签的点击。
          '.fge-copy{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));cursor:pointer}',
          '.fge-copy:hover{color:var(--dsw-alias-label-primary);background:rgba(128,128,128,.18)}',
          '.fge-copy[data-s="done"]{color:#3fa34d}',
          '.fge-copy[data-s="failed"]{color:#d9534f}',
          // 详情标题里的**文件名**: 点一下复制它自己(见 DocName)。
          // ⚠ 不动文字(不换成"已复制") —— 那样就看不见自己点的是哪个文件了, 只**染一下色**当反馈。
          // ⚠ 不能给它 padding/margin —— 官方页签用 scrollWidth>clientWidth 判断"被裁剪",
          //   那 2px 会给一个**已经完整显示**的文件名点亮右侧渐隐(mask-image)。
          '.fge-doc-name{cursor:pointer;border-radius:3px}',
          '.fge-doc-name:hover{background:rgba(128,128,128,.18)}',
          '.fge-doc-name[data-s="done"]{color:#3fa34d}',
          '.fge-doc-name[data-s="failed"]{color:#d9534f}',
          // 终端抽屉: 座位在 composer 之下(conversation.composer.dock), **宽度贯穿整个座位**,
          // 顶部两角圆角; 颜色全走主题 token(--dsw-alias-*), 不写死蓝/黑, 于是明暗主题都跟得上。
          //
          // ⚠ 表面色用**官方的"代码/终端卡片"底色** `--dsw-alias-markdown-code-block`, 不要用 `bg-base`:
          //   官方浅色主题里 `bg-base` / `layer-1/2/3` **全是纯白**, 拿它们当终端底 = 与页面完全融合,
          //   标题条那条分隔线也跟着看不出来(实测: 用户主题下整个抽屉糊进背景)。
          //   官方终端卡片(`TerminalBlock` / `ioCard`)用的就是 code-block 底色 + `border-l1` 描边。
          //   ⚠ 抽屉宽度 = **上方对话区宽度**(`--dsh-chat-content-width`, 就是那条
          //   `wSkVaW_widthHandle` 拖出来的宽度): 座位本身是整条中栏, `width:100%` 会比 composer
          //   卡片宽出一截, 看着不像"同一个对话区"。max-width + 居中即可, 纯 CSS 零测量;
          //   拖那条手柄时变量一变抽屉跟着变, 里面的 xterm 由 ResizeObserver 自动 refit。
          // ⚠ 抽屉宽度 = **composer 卡片(uV2eYG_card)的宽度**, 不是对话正文那一列:
          //   官方 `--dsh-chat-content-width` = 正文列宽(clamp(680px…920px)),
          //   而 composer 卡片是 `min(容器宽 - 2*side-clearance, --dsh-composer-card-max-width)`,
          //   其中 `--dsh-composer-card-max-width = calc(chat-content-width + 32px)`、`side-clearance = 16px`。
          //   只写 `max-width: chat-content-width` 会比卡片**窄 32px**(左右各 16) —— 用户报的"宽度跟卡片不一致"。
          //   所以这里照卡片的公式写, 并用官方那两个变量名(不写死 16 / 32):
          //     width     = 100% - 2*side-clearance   (本抽屉的容器就是整条中栏, 官方 dock 座位也是自己减掉它)
          //     max-width = --dsh-composer-card-max-width
          //   变量缺失时依次回落到老写法(`chat-content-width` / 100%), 不会变成没约束的整栏。
          // ⚠ 描边要**左右都有**(下边不画): 原来只写了 `border-top`, 左右两侧没有边 —— 标题条那一段自己
          //   不带底色, 它与终端体的接缝就只剩下面那条分隔线, 于是"grip 与 body 之间看着断了一截"
          //   (用户口径的"断层感")。官方 composer 座里的横条本来就是四周描边的
          //   (`.nLMEza_bar{border:.5px solid var(--dsw-alias-border-l1)}`), 这里按同样的意思补齐左右两条;
          //   下边贴着座位底, 不画。
          '.fge-term{display:flex;flex-direction:column;box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-side-clearance,0px));max-width:var(--dsh-composer-card-max-width,var(--dsh-chat-content-width,100%));margin-inline:auto;border:1px solid var(--dsw-alias-border-l2);border-bottom:0;border-radius:12px 12px 0 0;background:' +
            TERM_SURFACE +
            // 拖柄高只在这里声明一次: 拖柄自己的 height 与标题条的**下内边距**都读它(见下面那条)。
            '--fge-term-grip:5px;color:var(--dsw-alias-label-primary)}',
          // 标题条(terminal title bar): 长得像 Windows Terminal 的页签栏, 但**不是多页签容器**
          // —— 每工作区仍只有一个终端(见 CONTEXT.md「工作区终端」), 所以条里恒定一枚页签。
          // 条本身仍是收起开关(点空白处 = 点页签上的 `×`: 只收抽屉, 不杀进程)。
          // ⚠ 底色**不设**(用户口径: 把那块色去掉) —— 直接透出抽屉表面, 条 / 体的分界交给下面那条
          //   `border-l3` 分隔线; 页签用同样的表面色, 于是条里只有页签这一块"面"。
          //   分隔线跟官方面板 header 同款(border-l3, 官方浅色主题实测 rgba(0,0,0,.12), 是三级边框里最深的)。
          // ⚠ 上下内边距**故意不对称**(下比上多 `拖柄高 - 分隔线高`): 拖柄(5px)在条的上面、分隔线(1px)在
          //   条的下面, 这两条把"拖柄 + 标题条"这条带子的垂直中心往上推了 2px; 用下内边距补回来,
          //   条里的内容(页签 / ■)才落在**带子的垂直中心**上(用户口径: 页签处在 grip+strip 高度的居中位置)。
          //   改拖柄高度只要改 `--fge-term-grip`, 这里跟着走。
          '.fge-term-strip{display:flex;align-items:center;gap:2px;padding:3px 8px calc(3px + var(--fge-term-grip,5px) - 1px);font-size:11.5px;cursor:pointer;background:none;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l3)}',
          // 页签: 只有当前工作区这一枚, 恒为活动态 —— 底色与终端体同色(于是"连着终端"), 与条形成对比, 两角圆角。
          // ⚠ **不再用"1px 投影盖掉条的底边"那套**: 那样页签底下就没有那条线了(用户点名要线是连续的)。
          //   现在页签**垂直居中在那条带子里**(`align-self:center` + 上面那条不对称内边距), 停在分隔线**上面**,
          //   于是 strip 的底边线在页签下面照样看得见。
          '.fge-term-tab{display:flex;align-items:center;align-self:center;gap:5px;min-width:0;max-width:42%;padding:3px 6px 3px 8px;border-radius:6px 6px 0 0;background:' +
            TERM_SURFACE +
            ';color:var(--dsw-alias-label-primary);cursor:pointer}',
          // 页签字形: primitives 里没有终端图标(75 枚图标全表最接近的只有 IconCodeOutline16),
          // 所以自绘 `>_` —— 与 `■` 同款做法, 不引依赖。
          '.fge-term-tab-glyph{flex:0 0 auto;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;opacity:.7}',
          // 标题 = 工作区路径: 单行, 尾部省略号(与 Windows Terminal 的页签标题同款)。
          '.fge-term-tab-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          // 页签上的 `×`: 平时不占位, hover / 键盘聚焦才出现(WT 同款); 语义是**收起抽屉, 不杀进程**。
          '.fge-term-tab-close{flex:0 0 auto;display:none;align-items:center;justify-content:center;width:14px;height:14px;padding:0;border:0;border-radius:3px;background:transparent;color:inherit;font-size:11px;line-height:1;cursor:pointer}',
          '.fge-term-tab:hover .fge-term-tab-close,.fge-term-tab-close:focus-visible{display:inline-flex}',
          '.fge-term-tab-close:hover{background:var(--dsw-alias-interactive-bg-hover)}',
          // 条右端的 `■` 位: 终止整棵终端进程树(危险色) —— 人停止终端的唯一入口, 与 `×`(收起)分开。
          // ⚠ 它原来跟着页签一起**贴底**(`margin-bottom:3px`); 页签改成在带子里垂直居中之后, 这里就交给
          //   `align-items:center` 一起居中, 两边不再各算各的。
          // ⚠ 里的图标已换成**官方 SVG**(`IconStopFill16`, 原来是文字字形 `■`), 所以这里不再需要
          //   `font-size` / `line-height` —— 盒子高 18 与开关一致, 条里两项同一相位。
          '.fge-term-glyph{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:18px;padding:0 4px}',
          '.fge-term-kill{color:var(--dsw-alias-state-error-primary)}',
          '.fge-term-kill:hover{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}',
          // 条右端的「选中即复制」开关(用户口径: 做成开关放在 strip 右侧)。
          // ⚠ 它长在**整条可点即收起**的标题条里, 所以它的 onClick 必须 stopPropagation —— 否则一按开关
          //   就把抽屉收起来。hover 底色与 `×` / `■` 同款, 提示"这是个控件, 不是条的一部分"。
          // ⚠ 尺寸**全套取偶数**(盒子 18 与终止键一致、轨道 12、滑块 8、文字行盒 12): 条里内容行高是奇数
          //   (页签 21px), 控件自己若是 17 / 轨道 13 / 行盒 11.5, 居中就会落在 .5px 上 —— 相邻元素的
          //   **文字与几何各自吸到不同的半像素**, 看着就是"文字和开关垂直没对齐"。全取偶数后,
          //   盒子落在 .5px 时内部每一项仍是整数, 文字与轨道共一条中心线、同一个像素相位。
          '.fge-term-switch{display:flex;flex:0 0 auto;align-items:center;gap:5px;height:18px;padding:0 5px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1;cursor:pointer}',
          '.fge-term-switch:hover{background:var(--dsw-alias-interactive-bg-hover)}',
          '.fge-term-switch:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
          // 轨道 + 滑块: 自己画的(primitives 里没有开关组件, 与 `>_` / `■` 同款做法, 不引依赖)。
          // 关 = 边框色轨道, 开 = 品牌色轨道(active 态用品牌色是本仓库既有口径)。
          '.fge-term-switch-track{position:relative;flex:0 0 auto;width:24px;height:12px;border-radius:6px;background:var(--dsw-alias-border-l2);transition:background-color .12s}',
          '.fge-term-switch-knob{position:absolute;top:2px;left:2px;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-bg-base,#fff);transition:left .12s}',
          '.fge-term-switch[aria-checked="true"] .fge-term-switch-track{background:var(--dsw-alias-brand-primary)}',
          // 开的滑块位置 = 轨道宽 − 滑块宽 − 左边距 = 24 − 8 − 2 = 14(全是整数 px, 不做百分比计算, 免得又落半像素)
          '.fge-term-switch[aria-checked="true"] .fge-term-switch-knob{left:14px}',
          // 文字行盒取 12px(偶数, 且与轨道同高): 它跟轨道**共一条中心线**, 谁也不会多出半个像素。
          '.fge-term-switch-label{white-space:nowrap;line-height:12px}',
          // ⚠ 拖柄**没有 hover 底色**(用户口径: "想拉伸抽屉时鼠标 hover 到边缘, 看到这条的底色跟旁边不一样") ——
          //   它是一整条 5px 通宽的横带, 一亮就是一整条, 在抽屉边缘上非常扎眼。
          //   可拖的提示交给 `cursor:ns-resize`(悬停时指针就变了), 这里保持完全透明。
          '.fge-term-grip{height:var(--fge-term-grip,5px);cursor:ns-resize;background:transparent}',
          // 状态行: 终端连着且可写时**整行不渲染**(component 返回 null), 所以这里只管"要说一句话"时的样子。
          // 底色与终端体同一只 token, 于是它读起来是"终端上方的一行说明", 而不是另起一块面板。
          '.fge-term-status{display:flex;align-items:center;gap:6px;padding:3px 8px;font-size:11.5px;color:var(--dsw-alias-label-secondary);background:' +
            TERM_SURFACE +
            ';border-bottom:1px solid var(--dsw-alias-border-l2)}',
          '.fge-term-status-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          '.fge-term-status-action{flex:0 0 auto;padding:1px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}',
          '.fge-term-status-action:hover{background:var(--dsw-alias-interactive-bg-hover)}',
          '.fge-term-body{flex:1 1 auto;min-height:0;padding:2px 4px 4px;background:' + TERM_SURFACE + '}',
          '.fge-term-body .xterm{height:100%}',
          // xterm 自带的滚动条(vscode 血统)是 **14px** 宽, 在这么窄的抽屉里显得又粗又占地方;
          // 而且它的宽/高是 **内联样式** 写死的(`domNode.setWidth(...)`), 只有 `!important` 能压住。
          // 这里收到 6px(抽屉里其它滚动区也是 5px 细滚条), 滑块交给 xterm 主题自己算色(跟随前景色)。
          '.fge-term-body .xterm-scrollable-element > .scrollbar.vertical{width:6px!important}',
          // 滑块跟着收窄 + **圆角**(用户口径: 参考 dsh 自己的滚动条 —— 细条 + 两端圆角)。
          // 颜色不用管: xterm 按 `scrollbarSliderBackground`(默认 = 前景色 20% 透明)自己注入样式, 天然跟主题。
          '.fge-term-body .xterm-scrollable-element > .scrollbar.vertical > .slider{width:100%!important;border-radius:3px}',
          // xterm 自带的 xterm.css 把 `.xterm-viewport` 写死成 `background:#000`, xterm 自己**不会**改它
          // (主题色只落在 `.xterm-scrollable-element` 上) —— 于是终端底边会漏出一条黑带。
          // 这里按**与画布同一个**表面 token 覆盖, 主题一换跟着变(纯 CSS, 不需要 JS 参与)。
          '.fge-term-body .xterm-viewport{background-color:' + TERM_SURFACE + '!important}',
          // 抽屉舌: 宽度与抽屉同宽(同一个 `--dsh-chat-content-width`), 中间一枚透明无边框 chevron
          // (旧实现的观感, 见 v0.2 的 .fge-strip)。
          // 抽屉舌与抽屉**同一列**(同一个宽度公式, 见上): 它是收起态, 只有一枚居中的 chevron、
          // 不带底色, 所以 32px 的差别在屏幕上看不出来 —— 但两处必须同一个来源, 否则以后改宽度会漏一个。
          '.fge-tongue{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-side-clearance,0px));max-width:var(--dsh-composer-card-max-width,var(--dsh-chat-content-width,100%));margin-inline:auto;padding:1px 0 3px;background:transparent;border:0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));cursor:pointer;user-select:none}',
          '.fge-tongue:hover{color:var(--dsw-alias-label-primary)}',
          '.fge-chip{font-size:11px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);white-space:nowrap}',
          // ---- 右栏外观调整(改的是官方 layout / sidebar-right 的 chrome, 用户点名要的) ----
          //
          // 1) 右栏宽度 = **可拖**, 上限 15vw、下限 200px(用户口径: 上限保留, 但得能拖)。
          //    官方没有公开的宽度 API: `setRightbar` 只在 layout 内部, 还被钳制到 [300px, 0.7×视口];
          //    首开宽度更是 45% of frame(`RIGHTBAR_DEFAULT_RATIO`)。所以这里**只改画法**:
          //    把 frame 第三轨定成 `RIGHTBAR_TRACK`(拖动过的 px, 没拖过回落 15vw)、面板也限到同样宽 ——
          //    于是右栏**占真实的一格轨道**, 打开时把中栏挤窄(而不是浮在它上面)。
          //    ⚠ 第三轨**不能写成 0**: 轨道为 0 时官方面板(`position:absolute; right:0`)会向左挂到中栏上面
          //    (官方注释原话 "it can hang over the centre when there is no track"), 看起来就是浮层 —— 实测踩过。
          //    ⚠ 折叠时必须把这一轨**还给中栏**, 所以按官方的 `data-rightbar-collapsed` 分成两条规则。
          //    左栏那一轨交给 `auto`(官方侧栏组件自带宽度), 于是收起成 56px 细条、拖动变宽都照旧。
          //    改上限/下限就改 RIGHTBAR_MAX_VW / RIGHTBAR_MIN_PX 两个常量。
          'div:has(> [data-rightbar-col]):not([data-rightbar-collapsed]){grid-template-columns:auto minmax(0,1fr) ' +
            RIGHTBAR_TRACK +
            '!important}',
          '[data-rightbar-collapsed]:has(> [data-rightbar-col]){grid-template-columns:auto minmax(0,1fr) 0px!important}',
          '[data-sidebar-right-panel="push"]{max-width:' + RIGHTBAR_TRACK + '!important}',
          //    拖柄: 官方那根 8px 的 col-resize 手柄本来就在边界上, 但它的 `left` 跟的是**官方**宽度
          //    (本插件不采用), 而且 `position:absolute` 在 frame 里 —— 这里改成按本插件轨道从右边定位,
          //    于是它始终骑在真实边界上。拖动本身由 JS 接管(见 attachRightbarDrag), 官方那套钳制不参与。
          '[data-side="rightbar"]{left:auto!important;right:calc(' + RIGHTBAR_TRACK + ' - 4px)!important;display:block}',
          //    hover / 拖动时的可见性提示: 一条 3px 圆角竖条(跟官方会话宽度手柄同款 token)。
          '[data-side="rightbar"]:after{content:"";position:absolute;top:0;bottom:0;right:2px;width:3px;border-radius:3px;background:transparent}',
          '[data-side="rightbar"]:hover:after,[data-fge-resizing] [data-side="rightbar"]:after{background:var(--dsw-alias-scrollbar-hover-l1,var(--dsw-alias-border-l2))}',
          //    拖动中关掉 frame 的宽度过渡(官方 `transition:grid-template-columns …` 会让面板追不上指针),
          //    并把光标钉成 col-resize —— 指针滑出那 8px 手柄时也还在拖。
          '[data-fge-resizing]{transition:none!important}',
          '[data-fge-resizing],[data-fge-resizing] *{cursor:col-resize!important}',
          // 2) 隐藏右栏 chrome 的「分栏」与「进全屏」按钮(「收起」「+ 新页签」保留)。
          //    ⚠ 这两枚曾一起藏, 后来把「进全屏」放回来过一轮 —— 用户随后指出**位置放错了**:
          //      全屏要落在**详情浮窗**上(见下面 4) 那枚), 不是右栏页签条这一格。所以又藏了回去。
          //      顺带留下容易再踩的那点: `data-sidebar-right-mode` 的值是**下一个**模式, 页签条那枚
          //      「进全屏」/「退出全屏」是**同一个按钮**(非全屏时才是 `"fullscreen"`, 全屏时变 `"push"`)。
          '[data-dockkit-split-button]{display:none}',
          '[data-sidebar-right-mode="fullscreen"]{display:none}',
          //    「详情浮窗」头上的**「送回侧栏」**(`data-dockkit-float-dock`)也藏掉(用户口径):
          //    它的效果是把详情变回右栏页签 —— 与"详情只以浮层出现"这条设计相反(误点后还得再点一次
          //    同一个文件才重新浮起, 见 ADR-0002 / ADR-0003 的影子芯片), 留着只会让人误触。
          //    ⚠ **必须按"这是不是我们的浮窗"限定**, 不能写成裸的 `[data-dockkit-float-dock]{display:none}`:
          //      官方浮动宿主是所有页签共用的, 别的插件/官方页签被浮起来时(拖页签 / 页签菜单)也长这个按钮,
          //      一起藏了人家就送不回侧栏。判据取**标题里的文件名芯片**(本插件两种详情标题都有它:
          //      文档详情的 `DocName` 与 diff 的 `.fge-chip-label > DocName`)。
          '[data-dockkit-float]:has([data-dockkit-float-title] .fge-doc-name) [data-dockkit-float-dock]{display:none}',
          // 3) 详情(浮窗)头部的**页签宽度** —— "文件名经常显示不全"的真因在这里, 不在标题上:
          //    官方给页签钉的是 `min-width:80px; max-width:170px`(`._tab_17p4l_156`), 于是半屏宽的浮窗里
          //    文件名可用宽度也只有 **170px**。
          //    ⚠ 标题自己(`[data-dockkit-tab-title]`)本来就没有 max-width(`flex:1 1 auto; min-width:0;
          //      overflow:hidden` + 裁切时加 `mask-image`), 所以**改它是空操作** —— 这条踩过。
          //    ⚠ **浮窗里那格不带 `data-dockkit-tab`**(实测: 开着详情时 DOM 里只有「文件」「Git」两格带它,
          //      详情那格已经被搬到浮窗里, 是 `_float_` / `_floatHeader_` 那套另一份渲染) —— 所以第一版按
          //      `[data-dockkit-tab][class*="_floatTitle_"]` 选**永远匹配不到浮窗**, 名字照旧截断。
          //      现在两条**各自独立生效**的钩子钉住它: 前者盯着"谁夹着标题"(类名将来变了也还在),
          //      后者是官方那格自己的类(`Ce(me.tab, me.floatTitle)`; `_floatTitle_` 是 CSS Module 的局部名,
          //      哈希后缀变了前缀还在)。`:has()` 在官方这套里本来就在用(见 §11 的第三轨规则), 不是新依赖。
          //    ⚠ 只管**浮窗里**的: 页签条上那两格还靠官方 80/170 维持版式, 不动。
          '[class*="_float_"] *:has(> [data-dockkit-tab-title]){max-width:none!important}',
          '[class*="_floatTitle_"]{max-width:none!important}',
          // 4) 详情浮窗头上的**「全屏」开关** —— 本插件自己加的一枚按钮(见 FloatFullButton)。
          //    用户口径: 全屏要落在**详情面板**上, 不是右栏页签条那一格。
          //    ⚠ 为什么只能"改画法": 官方没有移动 / 缩放悬浮面板的公开接口(`ctx.sidebarRight` 只有
          //      close/focus/float/dock/split), 而 `float()` 对已浮起的页签是 no-op ⇒ 尺寸重新算不了。
          //      所以给浮窗元素打一个标记, 用 `!important` 压掉官方 inline 的 left/top/width/height ——
          //      与上面第 1 条右栏宽度同一个手法(author 的 `!important` 压得过 inline 的普通声明)。
          //    ⚠ 按钮**只在浮窗里露面**: 标题槽在页签条与浮窗头部**两处都渲染**, 所以先 `display:none`,
          //      再由 `[data-dockkit-float] .fge-float-full` 放开它 —— 用 JS 判据分不清这两处
          //      (`tab.visible` 的定义里还包含"右栏展开且是本格", 条上与浮窗里都是 true)。
          //    ⚠ 「退出全屏」没有单独的官方图标(primitives 只有 `IconFullscreenOutline16`),
          //      所以两态同一个图标, 靠按钮自身的 `data-s="on"`(底色 + 主文字色)表示"正在全屏"。
          '.fge-float-full{display:none;align-items:center;justify-content:center;flex:none;width:20px;height:20px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer}',
          '[data-dockkit-float] .fge-float-full{display:inline-flex}',
          '.fge-float-full:hover,.fge-float-full[data-s="on"]{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18))}',
          '.fge-float-full:hover{color:var(--dsw-alias-label-primary,inherit)}',
          //    全屏态: `inset:0` 一次盖住四个方向(浮窗是 `position:fixed`); 圆角归零 —— 官方是 20px,
          //    铺满视口时那圈圆角会把后面的东西露出来; z-index 抬到别的浮窗之上; 右下角的缩放手柄此时没意义。
          '[data-dockkit-float][data-fge-float-full]{inset:0!important;width:auto!important;height:auto!important;border-radius:0!important;z-index:50!important}',
          '[data-dockkit-float][data-fge-float-full] [data-dockkit-float-resize]{display:none}',
        ].join('\n');
        document.head.appendChild(el);
      }

      // ---- 文件地址 + 读原文(lib/address.js 的内联副本; bundle 无法 import host ESM) ----

      var FILE_ADDRESS_PREFIX = 'dsh-resource://file/';

      function isDriveSegment(segment) {
        return segment !== undefined && /^[A-Za-z]:$/.test(segment);
      }

      function parseFileAddress(address) {
        try {
          if (typeof address !== 'string' || address.indexOf(FILE_ADDRESS_PREFIX) !== 0) return null;
          var end = address.search(/[?#]/);
          var body = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end);
          var parts = body.split('/');
          var scope = parts[0];
          var rest = parts.slice(1);

          if (scope === 'session') {
            var id = rest[0];
            var segments = rest.slice(1);
            if (id === undefined || id === '' || segments.length === 0) return null;
            return {
              scope: scope,
              sessionId: decodeURIComponent(id),
              path: segments.map(decodeURIComponent).join('/'),
            };
          }

          if (scope === 'absolute') {
            var unc = rest[0] === '' && rest.length > 1;
            var segs = (unc ? rest.slice(1) : rest).map(decodeURIComponent);
            if (segs.length === 0 || segs[0] === '') return null;
            if (unc) return { scope: scope, path: '//' + segs.join('/') };
            return {
              scope: scope,
              path: isDriveSegment(segs[0]) ? segs.join('/') : '/' + segs.join('/'),
            };
          }

          return null;
        } catch (e) {
          return null;
        }
      }

      function extensionOf(path) {
        var value = String(path === undefined || path === null ? '' : path);
        var base = value.slice(value.lastIndexOf('/') + 1).slice(value.lastIndexOf('\\') + 1);
        var dot = base.lastIndexOf('.');
        if (dot <= 0 || dot === base.length - 1) return '';
        return base.slice(dot + 1).toLowerCase();
      }

      var RENDERED_EXTENSIONS = [
        'html',
        'htm',
        'xhtml',
        'pdf',
        'png',
        'jpg',
        'jpeg',
        'gif',
        'webp',
        'bmp',
        'ico',
        'avif',
        'svg',
      ];

      function isCopyableSource(path) {
        var ext = extensionOf(path);
        if (ext === '') return false;
        return RENDERED_EXTENSIONS.indexOf(ext) === -1;
      }

      function bytesToText(candidate) {
        if (typeof candidate === 'string') return candidate;
        if (candidate instanceof Uint8Array) return new TextDecoder().decode(candidate);
        if (Array.isArray(candidate)) return new TextDecoder().decode(Uint8Array.from(candidate));
        return null;
      }

      /** base64 → 文本(按字节解码, UTF-8 原文原样回来); 非法 base64 返回 null。 */
      function base64ToText(value) {
        try {
          var binary = atob(value);
          var bytes = new Uint8Array(binary.length);
          for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
          return new TextDecoder().decode(bytes);
        } catch (e) {
          return null;
        }
      }

      /**
       * 把 Remote 的读取结果归一成文本。
       * ⚠ `workspaceFiles.readAll` 的 `value.data` 是 **base64**(不是明文), 必须按字节解 ——
       *   否则要么乱码, 要么把 base64 串本身复制进剪贴板。
       */
      function extractDocumentText(result) {
        if (result === null || result === undefined) return null;
        if (typeof result === 'string') return result;
        var direct = bytesToText(result);
        if (direct !== null) return direct;
        if (typeof result !== 'object') return null;
        if (result.ok === false) return null;
        var value = result.value !== undefined ? result.value : result;
        if (value === null || value === undefined) return null;
        if (typeof value === 'string') return value;
        var fromValue = bytesToText(value);
        if (fromValue !== null) return fromValue;
        if (typeof value !== 'object') return null;
        if (typeof value.text === 'string') return value.text;
        if (value.data !== undefined) {
          var fromData;
          if (typeof value.data === 'string') {
            fromData = base64ToText(value.data);
            if (fromData === null) fromData = value.data; // 不是合法 base64 就当普通字符串
          } else {
            fromData = bytesToText(value.data);
          }
          if (fromData !== null) return fromData;
        }
        return bytesToText(value.bytes);
      }

      /** 把"读不出文本"变成一句能查的话(而不是静默 null)。 */
      function readFailureReason(res) {
        if (res && res.ok === false && res.error !== undefined && res.error !== null) {
          return typeof res.error === 'string' ? res.error : JSON.stringify(res.error);
        }
        return '无法识别的返回形状';
      }

      // ---- 单一悬浮面板 ----

      /**
       * 当前由本插件浮起的详情: `{tabId, sessionId}` 或 null。
       * 两者一同生效、一同清掉 —— 会话换掉时也要知道旧的那个属于谁。
       */
      var floatTarget = null;

      /** 关页签; 返回是否成功(座位瞬时缺位时会抛错, 由调用方决定要不要重试)。 */
      function tryClose(tabId) {
        if (tabId === null || tabId === undefined) return true;
        try {
          ctx.sidebarRight.close(tabId);
          return true;
        } catch (err) {
          return false;
        }
      }

      /** 关掉本插件当前浮起的详情(幂等, 失败也不吵)。 */
      function closeOwnedFloat() {
        var target = floatTarget;
        floatTarget = null;
        if (target !== null) tryClose(target.tabId);
      }

      // ---- 浮起之后把「用户原本在看的那一格」focus 回来 ----
      //
      // 详情页签总是**追加在来源 pane 的末尾**, 而官方的 float 会把该 pane 的 activeTabId 改成
      // `tabs[index - 1]`(dockkit 的 float reducer: `W3(tabs, s)` = 去掉被浮起的那格后的
      // `tabs[max(0, s - 1)]`)。于是浮起「文件详情」之后右栏会跳到详情左边那一格 —— 而那一格
      // 通常正是先打开的 git 树, 观感就是"右栏自己切回 git 树了"。
      //
      // 修法不是猜"左边那格应该是谁", 而是记住用户动手之前页签条上真正选中的那一格:
      // 详情浮起后 focus 回去, 右栏就停在用户原本看的地方(文件详情 → 停在「文件」, diff → 停在「Git」)。
      var userTabId = null;

      /**
       * 记下用户这次动作之前右栏选中的页签。
       *
       * 读的是页签条上的 `aria-selected`(而不是问 `sidebarRight.active()`): 捕获阶段拿到的就是
       * 动作发生前的状态, 而且**每次都重新读**, 不存在"上次读到的是什么时候"的陈旧问题。
       * 点在页签条本身上时跳过 —— 那是用户在切页签, 记下旧值只会把下次的回落目标指错。
       */
      function rememberUserTab(ev) {
        if (typeof document === 'undefined') return;
        var target = ev.target;
        if (target !== null && typeof target.closest === 'function' && target.closest('[data-dockkit-tab]') !== null) {
          return;
        }
        var active = document.querySelector('[data-dockkit-strip] [data-dockkit-tab][aria-selected="true"]');
        userTabId = active === null ? null : active.getAttribute('data-dockkit-tab');
      }

      /**
       * 浮起详情之后把用户那一格 focus 回来; 它已经被关掉(或座位又瞬时缺位)就保持官方落点。
       * @param {string} detailTabId 刚浮起的那一格, 等于用户那一格时不动
       */
      function restoreUserTab(detailTabId) {
        var id = userTabId;
        if (id === null || id === undefined || id === detailTabId) return;
        try {
          ctx.sidebarRight.focus(id);
        } catch (err) {
          // 座位瞬时缺位: 不影响详情已经浮起这件事, 只是右栏停在官方那格上。
        }
      }

      /**
       * 右栏可视区域的左缘(视口 x)。
       *
       * ⚠ 本插件把右栏宽度限死在 `RIGHTBAR_MAX_VW`(见 ensureStyles), 于是官方那个 grid 第三轨恒为 0 宽、
       * `[data-rightbar-col]` 贴在视口右缘 —— **不能再拿它的宽度/位置当锚点**了(那会恒为 null)。
       * 改从面板自己量: 面板右缘贴视口右缘、`max-width` 已经生效, 而 `transform` 只平移不改宽度,
       * 所以展开动画期间量它的 `width` 也是准的(量 `left` 才会拿到中间值)。
       * @returns {number|null} 右栏没显示时 null
       */
      function rightbarLeft() {
        if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
          return null;
        }
        var panel = document.querySelector('[data-sidebar-right-panel="push"]');
        if (panel === null) return null;
        var width = panel.getBoundingClientRect().width;
        if (!(width > 0)) return null;
        return window.innerWidth - width;
      }

      /**
       * 悬浮面板矩形: 视口宽度 1/2、满高顶到底、右缘贴右栏左缘。
       *
       * ⚠ 只在**浮起那一刻**算一次: 官方没有移动 / 缩放悬浮面板的公开接口
       * (`ctx.sidebarRight` 只有 close/focus/float/dock/split, `ctx.layout` 只有面板选择与右栏显隐),
       * 而 float() 对已浮起的页签是 no-op。所以换窗口尺寸之后面板不会自动重排 —— 见 README 已知限制。
       * (唯一的例外是浮窗自己那枚「全屏」开关: 它**只改画法**, 不动官方这份 rect —— 见 ensureStyles 第 4 条。)
       */
      function measureFloatRect() {
        var left = rightbarLeft();
        if (left === null) return null;
        var width = Math.round(window.innerWidth / 2);
        return {
          x: Math.round(left - width),
          y: 0,
          width: width,
          height: window.innerHeight,
        };
      }

      // ---- 右栏宽度: 可拖, 钳在 [RIGHTBAR_MIN_PX, 15vw] ----

      /** 当前右栏可视宽度(px); 面板没渲染(右栏折叠)时 null。 */
      function rightbarWidth() {
        if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null;
        var panel = document.querySelector('[data-sidebar-right-panel="push"]');
        if (panel === null) return null;
        var width = panel.getBoundingClientRect().width;
        return width > 0 ? width : null;
      }

      /** 上限的像素值(`RIGHTBAR_MAX_VW` 换算)。 */
      function rightbarMaxPx() {
        return (window.innerWidth * RIGHTBAR_MAX_VW) / 100;
      }

      /** 钳进 [下限, 上限]; 视口窄到上限比下限还小时**以上限为准**(上限是用户的硬要求)。 */
      function clampRightbarWidth(px) {
        var max = rightbarMaxPx();
        var next = px < RIGHTBAR_MIN_PX ? RIGHTBAR_MIN_PX : px;
        return next > max ? max : next;
      }

      /** 落宽度: 只写一个 CSS 变量, 第三轨 / 面板 max-width / 拖柄位置三条规则都读它。 */
      function applyRightbarWidth(px) {
        if (typeof document === 'undefined') return;
        document.documentElement.style.setProperty('--fge-rightbar-px', String(Math.round(px)) + 'px');
      }

      /** 读上次拖动后的宽度; 没有 / 读不出(隐私模式)返回 null。 */
      function readRightbarWidth() {
        try {
          var raw = window.localStorage.getItem(RIGHTBAR_WIDTH_KEY);
          if (raw === null) return null;
          var px = Number.parseFloat(raw);
          return Number.isFinite(px) && px > 0 ? px : null;
        } catch (err) {
          return null;
        }
      }

      function persistRightbarWidth(px) {
        try {
          window.localStorage.setItem(RIGHTBAR_WIDTH_KEY, String(Math.round(px)));
        } catch (err) {
          // 隐私模式 / 配额: 记不住而已, 不影响这次拖动
        }
      }

      /**
       * 接管官方那根右栏拖柄。捕获阶段吃掉 pointerdown(`stopPropagation` 之后 React 的委托处理器
       * 收不到), 于是官方的拖动(写 layout store, 还钳到 [300px, 0.7×视口])完全不参与 ——
       * 本插件自己按指针位置算宽度、自己钳到 [200px, 15vw]、自己存。
       *
       * ⚠ 拖动期间给 frame 挂 `data-fge-resizing`: 官方的 `transition:grid-template-columns` 是
       * 慢过渡, 不关掉面板会追不上指针(顺带把光标钉成 col-resize, 指针滑出那 8px 手柄也还在拖)。
       * @returns {() => void} 卸下监听
       */
      function attachRightbarDrag() {
        function finishDrag(state, upEv) {
          window.removeEventListener('pointermove', state.move, true);
          window.removeEventListener('pointerup', state.finish, true);
          window.removeEventListener('pointercancel', state.finish, true);
          if (state.frame !== null) state.frame.removeAttribute('data-fge-resizing');
          if (upEv !== undefined && upEv !== null && typeof upEv.clientX === 'number') {
            setDragWidth(state, state.startWidth + (state.startX - upEv.clientX));
          }
          // ⚠ 存**本插件落下去的那个值**, 不要存"量出来的面板宽度": 面板是 border-box,
          // 量出来会比变量多 1px, 存下去下次再 +1 —— 每拖一次胖一点。
          if (state.width !== null) persistRightbarWidth(state.width);
        }

        function setDragWidth(state, px) {
          state.width = clampRightbarWidth(px);
          applyRightbarWidth(state.width);
        }

        function onPointerDown(ev) {
          var target = ev.target;
          if (target === null || typeof target.closest !== 'function') return;
          var handle = target.closest('[data-side="rightbar"]');
          if (handle === null) return;
          ev.preventDefault();
          ev.stopPropagation();
          var startWidth = rightbarWidth();
          var max = rightbarMaxPx();
          // 没有可视宽度(右栏折叠中)时从变量 / 上限起算, 免得拖出个负数起点。
          if (startWidth === null) startWidth = clampRightbarWidth(max);
          var state = {
            frame: handle.parentElement,
            startX: ev.clientX,
            startWidth: startWidth,
            width: clampRightbarWidth(startWidth),
            move: null,
            finish: null,
          };
          state.move = function (moveEv) {
            setDragWidth(state, state.startWidth + (state.startX - moveEv.clientX));
          };
          state.finish = function (upEv) {
            finishDrag(state, upEv);
          };
          if (state.frame !== null) state.frame.setAttribute('data-fge-resizing', '');
          window.addEventListener('pointermove', state.move, true);
          window.addEventListener('pointerup', state.finish, true);
          window.addEventListener('pointercancel', state.finish, true);
        }

        document.addEventListener('pointerdown', onPointerDown, true);
        return function () {
          document.removeEventListener('pointerdown', onPointerDown, true);
        };
      }

      /**
       * 把某个页签采纳为唯一的悬浮详情: 关掉上一个(维持单面板), 再把它浮起来。
       *
       * 幂等: 对**已经浮起**的页签, 官方 float() 是 no-op, 所以重复调用是安全的 ——
       * 这也顺带解决了"详情被送回右栏页签之后, 再点同一个文件应当重新浮起"(`data-dockkit-float-dock`
       * 已被本插件藏掉, 见 ensureStyles; 但官方还有拖页签/页签菜单这条路, 所以这条仍要成立)。
       */
      function adoptFloat(tabId, sessionId) {
        if (tabId === null || tabId === undefined) return;
        var previous = floatTarget !== null && floatTarget.tabId !== tabId ? floatTarget.tabId : null;
        floatTarget = { tabId: tabId, sessionId: sessionId === undefined ? null : sessionId };
        floatWithRetry(tabId, 0, previous);
      }

      /**
       * 重试一次的两种时钟。
       *
       * ⚠ 座位绑定空隙在同一**次** effect flush 的收尾就补好了: 卸载阶段先跑整棵树,
       * 装载阶段子先父后, 我们这个芯片的 effect 夹在中间 —— 所以一次微任务足够, 而且微任务
       * 天然落在 paint 之前。用 `setTimeout(FLOAT_RETRY_MS)` 会把这 60ms 的中间态画到屏幕上
       * (实测: 页签条上冒出详情页签 45–66ms / 3–5 帧), 那正是"先加一个 tag、闪一下"的来源。
       * 只有"量不出 rect"(右栏还在展开、没有轨道)那一路才真的需要等下一帧, 仍走定时器。
       */
      function retryFloat(tabId, attempt, previous) {
        if (attempt < FLOAT_MICRO_ATTEMPTS) {
          Promise.resolve().then(function () {
            floatWithRetry(tabId, attempt + 1, previous);
          });
          return;
        }
        window.setTimeout(function () {
          floatWithRetry(tabId, attempt + 1, previous);
        }, FLOAT_RETRY_MS);
      }

      /**
       * 浮起 + 重试。**关掉上一个的动作也放在这个重试循环里** —— 理由见下。
       *
       * ⚠ 实测(真 boot + 真浏览器): **新页签挂载的那一次 commit 里, 直接调 sidebarRight 的
       * 命令会抛 `sidebarRight: no session surface is mounted`**。原因是官方座位的绑定写在
       * `useEffect(() => bindService({...}), [..., surfaces])` 里, 而新页签让 `surfaces` 变了:
       * 那次 flush 先跑**卸载**阶段(座位释放绑定)、再跑**挂载**阶段, 而挂载阶段是子先父后 ——
       * 我们这个芯片的 effect 正好夹在"座位已释放、尚未重绑"的空隙里。**空隙在同一轮 flush 的收尾
       * 就补好了**(父的装载 effect 就在后面), 所以重试用微任务而不是定时器 —— 见 retryFloat。
       *
       * 所以 close() 与 float() **都要重试**, 且必须在同一次尝试里按"先关后浮"的顺序做:
       * 只重试 float 的话, 第一次 close 悄悄失败, 结果就是两个悬浮面板并存(实测确实如此)。
       * 要么都成功, 要么一起再来一次。
       *
       * 另一种瞬时是右栏还没有轨道(列宽 0, 正在展开): 那时 rect 量不出来, 也要等一帧再量,
       * 否则面板会落在官方默认的级联位上。重试预算用尽还失败, 才按"右侧栏确实没有已挂载的会话
       * 座位"处理(官方文档明确这种情况会抛错, 调用点必须容错)。
       */
      function floatWithRetry(tabId, attempt, previous) {
        if (floatTarget === null || floatTarget.tabId !== tabId) return; // 期间用户又打开了别的详情
        var rect = measureFloatRect();
        if (rect === null && attempt < FLOAT_ATTEMPTS) {
          window.setTimeout(function () {
            floatWithRetry(tabId, attempt + 1, previous);
          }, FLOAT_RETRY_MS);
          return;
        }
        // 先关旧的。关不掉(座位瞬时缺位)就整体重来, 不能带着两个悬浮面板继续。
        if (previous !== null && !tryClose(previous) && attempt < FLOAT_ATTEMPTS) {
          retryFloat(tabId, attempt, previous);
          return;
        }
        try {
          ctx.sidebarRight.float(tabId, rect === null ? undefined : rect);
          restoreUserTab(tabId);
        } catch (err) {
          if (attempt < FLOAT_ATTEMPTS) {
            retryFloat(tabId, attempt, previous);
            return;
          }
          console.warn('[fge] 悬浮详情不可用(右侧栏没有已挂载的会话座位)', err);
          if (floatTarget !== null && floatTarget.tabId === tabId) floatTarget = null;
        }
      }

      // ---- 影子芯片:官方文档页签的标题(顺带把页签浮起来 + 复制内容) ----

      /**
       * 复刻官方芯片(`FileTypeIcon` + `tab.title`), 多一枚「复制内容」。
       * 它同时出现在**页签条**和**悬浮面板头部**两个位置(官方文档如此), 所以两种位置都得站得住。
       *
       * ⚠ 副作用放到 useEffect 里而不是渲染期: 渲染期调 float/close 会改布局 store。
       * 代价是"页签被浮起前会有一帧出现在页签条上" —— 官方 chrome 没有可注入的槽,
       * 这是影子替换方案已知且可接受的瞬时(见 ADR-0003)。
       */
      function DocTitle(props) {
        var sessionId = props.sessionId;
        var tab = tabOf(props.useTabInfo);
        var tabId = tab ? tab.id : null;
        var title = tab && typeof tab.title === 'string' ? tab.title : '';
        var visible = !!(tab && tab.visible);
        // 每导航到这个页签都会 +1(reveal 已存在的页签也算), 用它把"重新点同一个文件"也
        // 变成一次采纳 —— 详情被送回右栏页签之后, 再点该文件应当重新浮起。
        var revision = tab && tab.navigation ? tab.navigation.revision : 0;
        var address = tab
          ? typeof tab.contentId === 'string' && tab.contentId !== ''
            ? tab.contentId
            : tab.navigation && typeof tab.navigation.address === 'string'
              ? tab.navigation.address
              : ''
          : '';

        // 会话换了: 旧悬浮面板属于上一个会话, 先关掉再采纳这一个。
        React.useEffect(
          function () {
            if (floatTarget !== null && sessionId !== undefined && floatTarget.sessionId !== sessionId) {
              closeOwnedFloat();
            }
          },
          [sessionId],
        );

        React.useEffect(
          function () {
            if (tabId === null || tabId === undefined) return undefined;
            // 右栏收起时页签不可见, 此刻不要浮起; 展开后这个 effect 会再跑一次。
            if (!visible) return undefined;
            adoptFloat(tabId, sessionId);
            return undefined;
          },
          [tabId, revision, visible, sessionId],
        );

        return h(
          React.Fragment,
          null,
          h(primitives.FileTypeIcon, {
            kind: primitives.classifyFileType(title),
            size: 16,
          }),
          h(DocName, { name: title }),
          h(FileCopyButton, { address: address, sessionId: sessionId }),
          h(FloatFullButton, null),
        );
      }

      /**
       * 标题里的**文件名**(用户口径: "点击文件名的时候自动复制")。
       *
       * - 复制的就是**文件名本身** —— 点的是什么就复制什么; 路径另有出处(地址在 `title` 属性上,
       *   内容复制走旁边那枚「复制内容」芯片)。
       * - ⚠ **不能挂 `onClick`**: 这个标题**同时出现在页签条与浮窗头部**(见 DocTitle 的注释),
       *   而这两处的官方代码都在 `pointerdown` 时对**自己**调 `setPointerCapture` —— 页签是
       *   `onTabPressed`, 浮窗是带 `data-dockkit-float-grip` 的那条 header。指针一旦被捕获,
       *   其后的 mouse/click 全部重定向到那个元素: 官方自己的 `onClick`("选中页签")照常触发
       *   (捕获元素正是它), 而**更深的子元素永远收不到 click** —— 实测 `click` 计数 0,
       *   连自身的 `pointerup` 也是 0。所以这里改用「按下 → 抬起, 位移未达拖拽阈值」自己判定。
       *   窗口级的 `pointerup`(捕获阶段)不受该重定向影响, 一定收得到。
       * - 阈值与官方拖拽起手判据**逐字对齐**(`|dx|>=4 || |dy|>=4` 即官方认定这是拖拽):
       *   "官方开始拖页签"与"我们不再复制"是同一条线, 拖一次不会顺手复制一个文件名。
       * - ⚠ **不吃掉这次事件**(不 `preventDefault` / 不 `stopPropagation`): 在页签条里让点击继续走到官方
       *   那层去"选中这个页签"才是对的 —— 复制只是搭个便车。
       * - 反馈沿用仓库既有的 `data-s`(done / failed, 1.2s), 只**染一下色**: 把文件名换成"已复制"
       *   会让人看不见自己点的是哪个文件。
       */
      function DocName(props) {
        var name = props.name;
        var pair = React.useState('idle');
        var state = pair[0];
        var setState = pair[1];
        var down = React.useRef(null);

        React.useEffect(
          function () {
            if (state === 'idle') return undefined;
            var timer = window.setTimeout(function () {
              setState('idle');
            }, 1200);
            return function () {
              window.clearTimeout(timer);
            };
          },
          [state],
        );

        // 抬起时结算: 只有还在我们身上按下、且位移没到拖拽阈值的那一次才算"点击"。
        // 挂在 window 上(而非本元素)是**必须**的 —— 见上面关于 pointer capture 的注释。
        React.useEffect(
          function () {
            function settle(ev) {
              var from = down.current;
              down.current = null;
              if (from === null || ev.pointerId !== from.id) return;
              if (ev.type === 'pointercancel') return;
              if (Math.abs(ev.clientX - from.x) >= 4 || Math.abs(ev.clientY - from.y) >= 4) return;
              copyName();
            }
            window.addEventListener('pointerup', settle, true);
            window.addEventListener('pointercancel', settle, true);
            return function () {
              window.removeEventListener('pointerup', settle, true);
              window.removeEventListener('pointercancel', settle, true);
            };
          },
          [name],
        );

        function onPointerDown(ev) {
          // 只认主指针的左键: 右键/中键抬起, 以及多点触控的第二根手指, 都不该复制。
          if (ev.button !== 0 || ev.isPrimary === false) {
            down.current = null;
            return;
          }
          down.current = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
        }

        function copyName() {
          if (typeof name !== 'string' || name === '') return;
          try {
            Promise.resolve(primitives.writeClipboard(name))
              .then(function (ok) {
                setState(ok === false ? 'failed' : 'done');
              })
              .catch(function (err) {
                console.warn('[fge] 复制文件名失败', err);
                setState('failed');
              });
          } catch (err) {
            console.warn('[fge] 复制文件名失败', err);
            setState('failed');
          }
        }

        return h(
          'span',
          {
            className: 'fge-doc-name',
            'data-s': state,
            title: '点击复制文件名',
            onPointerDown: onPointerDown,
          },
          name,
        );
      }

      /** 芯片上的「复制内容」: 复制该文件**磁盘上的原文**(不是预览出来的富文本)。 */
      function FileCopyButton(props) {
        var address = props.address;
        var sessionId = props.sessionId;
        var parsed = parseFileAddress(address);
        var pair = React.useState('idle');
        var state = pair[0];
        var setState = pair[1];

        React.useEffect(
          function () {
            if (state === 'idle' || state === 'busy') return undefined;
            var timer = window.setTimeout(function () {
              setState('idle');
            }, 1200);
            return function () {
              window.clearTimeout(timer);
            };
          },
          [state],
        );

        if (parsed === null || !isCopyableSource(parsed.path)) return null;

        function onClick(ev) {
          ev.preventDefault();
          ev.stopPropagation();
          if (state === 'busy') return;
          setState('busy');
          // ⚠ 只用 ctx.get 可选读取, 且**必须取点名的服务**:
          //   cordis 的 Context 对未 inject 的属性访问直接抛 `cannot get property "X" without inject`,
          //   而 `remote` 本身是个命名空间式服务 —— 取 ctx.get('remote') 拿回来的是它的 Context,
          //   再读 `.workspaceFiles` 会按点名 `remote.workspaceFiles` 触发同一道栅栏(实测的 pageerror)。
          //   官方 ui-sidebar-files 的做法是把 'remote' 与 'remote.workspaceFiles' 都写进 inject;
          //   本插件读的是可选的"附加能力", 所以改用 ctx.get 点名读取, 缺了只是不出复制图标。
          var readAll = null;
          try {
            var files = typeof ctx.get === 'function' ? ctx.get('remote.workspaceFiles') : undefined;
            var fn = files === undefined || files === null ? null : files.readAll;
            if (typeof fn === 'function') readAll = fn;
          } catch (err) {
            console.warn('[fge] 读不到 remote.workspaceFiles(复制内容不可用)', err);
          }
          if (readAll === null) {
            setState('failed');
            return;
          }
          Promise.resolve(readAll(parsed.sessionId || sessionId, parsed.path, undefined))
            .then(function (res) {
              var text = extractDocumentText(res);
              if (text === null) throw new Error('读不到文本: ' + readFailureReason(res));
              return primitives.writeClipboard(text);
            })
            .then(function (ok) {
              setState(ok === false ? 'failed' : 'done');
            })
            .catch(function (err) {
              console.warn('[fge] 复制内容失败', err);
              setState('failed');
            });
        }

        var label = state === 'done' ? '已复制' : state === 'failed' ? '复制失败' : '复制内容';
        var Icon =
          state === 'done'
            ? primitives.IconCheckOutline16
            : state === 'failed'
              ? primitives.IconWarningOutline16
              : primitives.IconCopyOutline16;

        return h(
          'button',
          {
            type: 'button',
            className: 'fge-copy',
            'data-s': state,
            title: label + ' · ' + parsed.path,
            'aria-label': label,
            // 页签条与悬浮面板头部都靠 pointerdown 起拖拽/选中, 这里必须吃掉, 否则点图标会拖走页签。
            onPointerDown: function (ev) {
              ev.stopPropagation();
            },
            onClick: onClick,
          },
          h(Icon, { size: 14 }),
        );
      }

      /**
       * 详情浮窗头上的**「全屏」开关**(用户口径: 全屏落在**这个详情面板**上, 不是右栏页签条那格)。
       *
       * - 状态就用 `useState`, 但**标记打在浮窗元素上**(`data-fge-float-full`), 由 CSS 用 `!important`
       *   压掉官方 inline 的 `left/top/width/height` —— 官方没有移动 / 缩放浮窗的公开接口
       *   (`ctx.sidebarRight` 只有 close/focus/float/dock/split), 而 `float()` 对已浮起页签是 no-op。
       *   见 ensureStyles 第 4 条。
       * - 卸载(关详情 / 换文件)时把标记摘掉 —— 所以下一次浮起一定从"非全屏"开始, 不会记着上一次。
       * - ⚠ `onPointerDown` 必须 `stopPropagation`: 官方浮窗的**整条 header 都是拖拽柄**, 它在
       *   pointerdown 里对自己 `setPointerCapture`, 那之后子元素的 `click` 永远不派发
       *   (实测 click 计数 0 —— 与「文件名点击复制」同一个坑, 见 §11 那条)。同层那枚「复制内容」芯片
       *   也是这么办的。
       * - ⚠ 按钮在**页签条上也渲染**(标题槽两处都渲染), 靠 CSS `.fge-float-full{display:none}` +
       *   `[data-dockkit-float] .fge-float-full{display:inline-flex}` 只在浮窗里露面。
       * - 两态同一个官方图标(`IconFullscreenOutline16`, primitives 没有"退出全屏"那枚), 靠 `data-s="on"`
       *   的底色 + 主文字色表示"正在全屏"; 提示文字 / aria 会跟着切。
       */
      function FloatFullButton() {
        var pair = React.useState(false);
        var on = pair[0];
        var setOn = pair[1];
        var ref = React.useRef(null);

        React.useEffect(
          function () {
            var el = ref.current;
            var float = el === null || el === undefined ? null : el.closest('[data-dockkit-float]');
            if (float === null) return undefined;
            if (on) float.setAttribute('data-fge-float-full', '');
            else float.removeAttribute('data-fge-float-full');
            return function () {
              float.removeAttribute('data-fge-float-full');
            };
          },
          [on],
        );

        var label = on ? '退出全屏' : '全屏';
        return h(
          'button',
          {
            type: 'button',
            ref: ref,
            className: 'fge-float-full',
            'data-s': on ? 'on' : 'off',
            title: label,
            'aria-label': label,
            'aria-pressed': on ? 'true' : 'false',
            onPointerDown: function (ev) {
              ev.stopPropagation();
            },
            onClick: function () {
              setOn(!on);
            },
          },
          h(primitives.IconFullscreenOutline16, { size: 14 }),
        );
      }

      // ---- diff 页签(第二个 kind): 开出来即被浮起 ----

      /** token → diff 详情。只把 token 放进页签的 navigation.params, 免得把 diff 正文写进会话布局记录。 */
      var diffs = new Map();
      var diffSeq = 0;

      var DIFF_LABELS = {
        copy: '复制',
        copied: '已复制',
        files: function (n) {
          return String(n) + ' 个文件';
        },
        expand: function (n) {
          return '展开另外 ' + String(n) + ' 行';
        },
        expandAria: function (n) {
          return '展开另外 ' + String(n) + ' 行';
        },
        collapse: '收起',
        collapseAria: '收起',
      };

      function putDiff(detail) {
        diffSeq += 1;
        var token = String(diffSeq);
        diffs.set(token, detail);
        while (diffs.size > DIFF_KEEP) {
          var oldest = diffs.keys().next();
          if (oldest.done === true) break;
          diffs.delete(oldest.value);
        }
        return token;
      }

      /**
       * 把一份 diff 详情开成(并浮起)悬浮面板。
       * 页面类型在同一个 pane 内会**去重**, 所以第二次点文件是"就地换内容": 页签不新增,
       * 但 navigation 会重新下发(params 变、revision 递增), 标题与正文据此重渲染。
       */
      function openDiff(detail) {
        var token = putDiff(detail);
        try {
          ctx.sidebarRight.openTab(DIFF_KIND, { params: { token: token } });
        } catch (err) {
          console.warn('[fge] 打不开 diff 悬浮面板', err);
        }
      }

      /**
       * 从 `useTabInfo()` 派生的页签信息里读回本页签指向的 diff 详情。
       * 标题芯片与正文都要这一步(同一个 token 记账), 所以只写一遍。
       * @returns {{tabId: string|null, revision: number, detail: object|undefined}}
       */
      function diffDetailOf(tab) {
        var params = tab && tab.navigation ? tab.navigation.params : null;
        var token = params && typeof params.token === 'string' ? params.token : null;
        return {
          tabId: tab ? tab.id : null,
          revision: tab && tab.navigation ? tab.navigation.revision : 0,
          detail: token === null ? undefined : diffs.get(token),
        };
      }

      /** 页签信息 hook → 当前 tab 记录(拿不到时 null)。 */
      function tabOf(useTabInfo) {
        var info = typeof useTabInfo === 'function' ? useTabInfo() : null;
        return info && info.tab ? info.tab : null;
      }

      function DiffTabTitle(props) {
        var found = diffDetailOf(tabOf(props.useTabInfo));
        var sessionId = props.sessionId;

        React.useEffect(
          function () {
            if (found.tabId === null || found.tabId === undefined) return undefined;
            adoptFloat(found.tabId, sessionId);
            return undefined;
          },
          [found.tabId, found.revision, sessionId],
        );

        var label = found.detail && found.detail.path ? found.detail.path : 'diff';
        // 路径也走 click-to-copy(用户口径"点击文件名的时候自动复制"): diff 详情里显示的就是**路径**,
        // 所以复制的就是它 —— 点的是什么就复制什么。
        // 「全屏」那枚按钮放在芯片**外面**(芯片是 `overflow:hidden` + 省略号, 塞进去会被截掉)。
        return h(
          React.Fragment,
          null,
          h('span', { className: 'fge-chip-label', title: label }, h(DocName, { name: label })),
          h(FloatFullButton, null),
        );
      }

      function DiffTabBody(props) {
        var detail = diffDetailOf(tabOf(props.useTabInfo)).detail;

        if (detail === undefined) {
          return h('div', { className: 'fge-empty' }, '(详情已失效, 请重新点开)');
        }
        if (detail.error) {
          return h('div', { className: 'fge-empty' }, '读取失败(' + detail.error + ')');
        }
        if (detail.kind === 'untracked') {
          return h(
            'div',
            { className: 'fge-empty' },
            '未跟踪文件 —— git 没有 diff 可比(可在编辑器里查看内容)',
          );
        }
        if (!Array.isArray(detail.hunks) || detail.hunks.length === 0) {
          return h('div', { className: 'fge-empty' }, '(无内容差异: 纯 mode 变化 / 二进制 / 纯改名)');
        }
        return h(
          'div',
          { className: 'fge-diff' },
          h(primitives.DiffBlock, { diffs: detail.hunks, labels: DIFF_LABELS }),
        );
      }

      /** 官方「工作区文件」页签的 kind(ui-sidebar-files 注册; 它是 page 类型, 用 openTab 开)。 */
      var FILES_KIND = 'files';
      /** 官方 guide 页签的 kind(sidebar-right 自带, `canCloseTab` 也按这个字面量判断)。 */
      var GUIDE_KIND = 'guide';
      /** 已经铺过默认页签的会话: 每个会话只做一次, 免得跟用户手动关掉的动作打架。 */
      var seededSessions = new Set();

      /**
       * 右侧栏的默认页签 —— 铺**两格**: 官方「工作区文件」+ 本插件的「Git」, 且 **Git 是活动的那一格**。
       *
       * 官方 `defaultSeed` 的规则是: **guide 里恰好只有一条时**, 默认页签就是那一条; 有两条及以上
       * 就落回 guide 列表页。本插件自己也带一条 guide 条目(少了它 git 页签就没有入口), 于是默认
       * 变成列表页 —— 这里补一步, 把它还原成"打开右栏就有东西看": 右栏还是空的 / 只有 guide 时,
       * 先开官方的「工作区文件」, 再开本插件的「Git」(后开的这格成为活动页签), 顺手把 guide 占位页收掉
       * (此时它不是唯一页签, `canCloseTab` 允许关)。
       *
       * 用户口径: **git 侧栏也像文件侧栏一样默认打开** —— 两格都在页签条上, 打开右栏直接是变更列表,
       * 官方的文件树就在左边一格。想让「文件」当默认那一格, 把两次 `openTab` 调过来即可。
       *
       * 不抢用户已经打开的页签: 每次尝试前都看一眼当前活动页签的 kind(用户开的既不是 guide、
       * 就已经是本插件铺好的那两格)。失败(座位还没挂上 / 类型还没到位)按次数退避重试,
       * 用尽就静默放弃 —— 这只是锦上添花, 不该影响别的功能。
       */
      function seedRightbar(sessionId) {
        if (seededSessions.has(sessionId)) return;
        seededSessions.add(sessionId);
        openFilesDefault(0);
      }

      function openFilesDefault(attempt) {
        var active;
        try {
          active = ctx.sidebarRight.active();
        } catch (err) {
          active = undefined;
        }
        if (active !== undefined && active.kind !== GUIDE_KIND) return; // 用户已经开了别的页签
        try {
          ctx.sidebarRight.openTab(FILES_KIND);
          ctx.sidebarRight.openTab(GIT_KIND);
        } catch (err) {
          if (attempt < SEED_ATTEMPTS) {
            window.setTimeout(function () {
              openFilesDefault(attempt + 1);
            }, SEED_RETRY_MS);
          }
          return;
        }
        if (active !== undefined) {
          try {
            ctx.sidebarRight.close(active.id);
          } catch (err) {
            // 已被关掉: 不是错误
          }
        }
      }

      /** 只跑副作用、不渲染任何东西: 给每个会话铺一次右侧栏默认页签。 */
      function SessionSeed(props) {
        var sessionId = props.sessionId;
        React.useEffect(
          function () {
            if (typeof sessionId !== 'string' || sessionId === '') return;
            seedRightbar(sessionId);
          },
          [sessionId],
        );
        return null;
      }

      // ---- vendor 资产: xterm 走静态资源路由 ----
      //
      // 刻意不把 xterm 内联进 client bundle: 那会 +300KB, 且浏览器模块表解析不到
      // 任意 node_modules。改由 host 的白名单路由伺服官方构建产物。

      var xtermPromise = null;
      /** xterm.css 的 `<link>` 是否已插入(重试路径不重复插, 见 ensureXterm)。 */
      var xtermCssLinked = false;

      function loadScript(src) {
        return new Promise(function (resolve, reject) {
          var el = document.createElement('script');
          el.src = src;
          el.async = false;
          el.onload = function () {
            resolve();
          };
          el.onerror = function () {
            // 加载失败的 <script> 留在 head 里没有意义, 且重试时还会再插一枚 —— 立即摘掉。
            if (el.parentNode !== null) el.parentNode.removeChild(el);
            reject(new Error('fge: failed to load ' + src));
          };
          document.head.appendChild(el);
        });
      }

      // ---- 终端配色: 跟主题 token, 不跟 xterm 的默认黑 ----
      //
      // ⚠ xterm 的 `theme.background` 只认**具体颜色**。原来传的是 `rgba(0,0,0,0)`(想"透明、露出容器底色"),
      // 实测被判为无效值 → 静默回落到 xterm 自家的默认黑 `#000`, 于是浅色主题下标题条(白)与终端体(黑)
      // 对不上 —— 标题条那条"接缝"用的是 `box-shadow: 0 1px 0 var(--dsw-alias-bg-base)`, 白线压在黑底上,
      // 看起来就是"标题条错位/断开"。所以这里按主题色算出**不透明**的 #rrggbb 再交给 xterm。
      /** 所有活着的 xterm 实例: 主题一换要就地更新(组件重挂才算的话, 抽屉不关就一直是旧主题)。 */
      var liveTerms = new Set();
      /**
       * 当前挂着的官方终端 view: **会话 id → view**。
       *
       * 抽屉里的 xterm 体是唯一创建 view 的地方, 而标题条上那枚终止键在**外面**(TerminalDock) ——
       * 它按会话来这里取(见 killTerminal)。收起抽屉时组件卸载, 这条登记也一并摘掉。
       */
      var termViews = new Map();
      /** 最近一次 theme/change 的快照: 新开的终端直接用它算色, 不必等下次主题切换。 */
      var lastThemeSnapshot = null;

      /**
       * 把一个 CSS 颜色(hex / rgb() / oklch() / color-mix()…)换成 **xterm 一定认**的写法:
       * `alpha = 1` → `#rrggbb`, 否则 → `rgba(r,g,b,a)`;认不出来就回 null 交给调用方回落。
       *
       * ⚠ 不能直接把 canvas 的 `fillStyle` 交出去: 它对 `color-mix()` 回的是 **`color(srgb …)`**、对 `oklch()`
       *   原样回 `oklch(…)`, 而这两种写法 **xterm 自己的颜色解析器都不认** —— 它会把整条设置**静默忽略**,
       *   回落到内置默认值(底色 = 黑)。所以这里把颜色画进 1×1 画布再读回像素, 拿到确定的 sRGB 通道
       *   (`getImageData` 给的是**非预乘** RGBA), 顺便把 alpha 也算出来。
       * ⚠ 哨兵值不是 `#000000`: canvas 遇到不认识的写法会**静默保留上一个值**, 用纯黑当哨兵会把"不认"
       *   误判成纯黑。这里用 `rgba(1,2,3,.5)`(不可能与任何真实输入撞), 于是"不变"就是"不认"。
       */
      function normalizeColor(value) {
        if (typeof value !== 'string' || value.trim() === '') return null;
        try {
          var canvas = document.createElement('canvas');
          canvas.width = 1;
          canvas.height = 1;
          var ctx2d = canvas.getContext('2d');
          ctx2d.fillStyle = 'rgba(1,2,3,0.5)';
          var sentinel = ctx2d.fillStyle;
          ctx2d.fillStyle = value.trim();
          if (ctx2d.fillStyle === sentinel) return null;
          ctx2d.clearRect(0, 0, 1, 1);
          ctx2d.fillRect(0, 0, 1, 1);
          var px = ctx2d.getImageData(0, 0, 1, 1).data;
          if (px[3] >= 255) {
            return (
              '#' +
              [px[0], px[1], px[2]]
                .map(function (v) {
                  return ('0' + v.toString(16)).slice(-2);
                })
                .join('')
            );
          }
          return (
            'rgba(' + px[0] + ',' + px[1] + ',' + px[2] + ',' + String(Math.round((px[3] / 255) * 100) / 100) + ')'
          );
        } catch (err) {
          return null;
        }
      }

      /** 主题 token → xterm theme。token 缺位时给一组中性的明色, 绝不回落成 xterm 的黑。 */
      function terminalTheme(snapshot) {
        function token(name, fallback) {
          var raw =
            snapshot !== undefined && snapshot !== null && snapshot.tokens !== undefined
              ? snapshot.tokens[name]
              : undefined;
          if (typeof raw === 'string' && raw.trim() !== '') return raw;
          if (typeof document !== 'undefined' && document.body !== null) {
            return getComputedStyle(document.body).getPropertyValue(name);
          }
          return fallback;
        }
        var dark =
          snapshot !== undefined && snapshot !== null && snapshot.active !== undefined
            ? snapshot.active.colorScheme === 'dark'
            : false;
        // 底色必须与 CSS 里那只 `.fge-term-body / .xterm-viewport` 的 `TERM_SURFACE` 一致(都是 code-block),
        // 否则 xterm 画出来的画布与容器不同色, 又会出现"接缝"。见 TERM_SURFACE 的注释。
        var backgroundToken = token(TERM_SURFACE_TOKEN, '');
        if (typeof backgroundToken !== 'string' || backgroundToken.trim() === '') {
          backgroundToken = token('--dsw-alias-bg-base', dark ? '#151517' : '#ffffff');
        }
        var background = normalizeColor(backgroundToken);
        var foreground = normalizeColor(token('--dsw-alias-label-primary', dark ? '#f9fafb' : '#0f1115'));
        // 选区: 用**主题的品牌色**调一层淡底(不再写死那个蓝), 让选中文字仍然读得出来。
        // 品牌色 token 缺失 / canvas 不认 color-mix 时回落到中性灰蓝(此时 normalizeColor 会如实返回 null)。
        var brand = token('--dsw-alias-brand-primary', '');
        var selection =
          typeof brand === 'string' && brand.trim() !== ''
            ? normalizeColor('color-mix(in srgb, ' + brand.trim() + ' 32%, transparent)')
            : null;
        var theme = {
          background: background === null ? (dark ? '#151517' : '#ffffff') : background,
          foreground: foreground === null ? (dark ? '#f9fafb' : '#0f1115') : foreground,
          cursor: foreground === null ? (dark ? '#f9fafb' : '#0f1115') : foreground,
          cursorAccent: background === null ? (dark ? '#151517' : '#ffffff') : background,
          selectionBackground: selection === null ? 'rgba(128,128,128,.35)' : selection,
        };
        // 16 色 ANSI 调色板(见 terminalPalette 的注释: 不给的话会回落成"为深色背景设计"的那套, 浅色下看不清)。
        var palette = terminalPalette(dark);
        for (var name in palette) {
          if (Object.prototype.hasOwnProperty.call(palette, name)) theme[name] = palette[name];
        }
        return theme;
      }

      /** 主题变了就更新每个活着的终端(snapshot 可能早于 CSS 落盘, 下一帧再读一次 token 也无妨)。 */
      function applyTerminalTheme(snapshot) {
        var theme = terminalTheme(snapshot);
        liveTerms.forEach(function (term) {
          try {
            term.options.theme = theme;
          } catch (err) {
            // 实例已销毁: 忽略
          }
        });
      }

      /**
       * 懒加载 xterm(vendor 白名单路由), 结果缓存在 `xtermPromise`。
       *
       * ⚠ **失败不能把拒绝态永久缓存**: vendor 资产缺失(host 返回 503, 例如插件换了目录却
       * 没跑 `pnpm --dir plugins/obsolete/file-git-explorer install`)是一次性的环境问题 —— 环境修好后
       * 应该「重开抽屉」就恢复。若把 rejected promise 缓存住, 用户只能**整页刷新**,
       * 而界面提示(「终端不可用(检查依赖与 host 日志)」)根本没提要刷新。
       * 所以失败时把 `xtermPromise` 置回 null, 下次调用重新拉一遍(`<link>` 只插一次,
       * 失败的 `<script>` 已被 loadScript 摘掉)。
       */
      function ensureXterm() {
        if (xtermPromise !== null) return xtermPromise;
        if (!xtermCssLinked) {
          xtermCssLinked = true;
          var link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = VENDOR_BASE + '/xterm.css';
          document.head.appendChild(link);
        }
        xtermPromise = loadScript(VENDOR_BASE + '/xterm.js')
          .then(function () {
            return loadScript(VENDOR_BASE + '/addon-fit.js');
          })
          .then(function () {
            var Terminal = window.Terminal;
            var ns = window.FitAddon;
            var Fit = ns && (ns.FitAddon || ns);
            if (typeof Terminal !== 'function' || typeof Fit !== 'function') {
              throw new Error('fge: xterm 全局未按预期暴露');
            }
            return { Terminal: Terminal, FitAddon: Fit };
          })
          .catch(function (err) {
            xtermPromise = null; // 见上方: 失败不缓存, 允许「重开抽屉」重试
            throw err;
          });
        return xtermPromise;
      }

      // ---- 终端抽屉的共享开关 ----

      var drawerListeners = new Set();
      var drawerOpen = false;

      function setDrawer(next) {
        if (drawerOpen === next) return;
        drawerOpen = next;
        drawerListeners.forEach(function (fn) {
          fn(next);
        });
      }

      function useDrawerOpen() {
        var pair = React.useState(drawerOpen);
        var value = pair[0];
        var setValue = pair[1];
        React.useEffect(function () {
          drawerListeners.add(setValue);
          setValue(drawerOpen);
          return function () {
            drawerListeners.delete(setValue);
          };
        }, []);
        return value;
      }

      /** 按工作区记忆的抽屉高度(占视口百分比)。 */
      function readTermHeight(key) {
        try {
          var raw = window.localStorage.getItem(TERM_HEIGHT_KEY);
          var map = raw ? JSON.parse(raw) : {};
          var pct = map && typeof map[key] === 'number' ? map[key] : TERM_DEFAULT_PCT;
          return Math.min(TERM_MAX_PCT, Math.max(TERM_MIN_PCT, pct));
        } catch (e) {
          return TERM_DEFAULT_PCT;
        }
      }

      function writeTermHeight(key, pct) {
        try {
          var raw = window.localStorage.getItem(TERM_HEIGHT_KEY);
          var map = raw ? JSON.parse(raw) : {};
          map[key] = pct;
          window.localStorage.setItem(TERM_HEIGHT_KEY, JSON.stringify(map));
        } catch (e) {
          // localStorage 不可写时只是不记忆, 不影响功能
        }
      }

      /** 终端「选中即复制」是否开着(默认开)。读写都吞异常: 存不下只是不记忆, 功能照旧。 */
      function readTermCopy() {
        try {
          return window.localStorage.getItem(TERM_COPY_KEY) !== '0';
        } catch (e) {
          return true;
        }
      }

      function writeTermCopy(on) {
        try {
          window.localStorage.setItem(TERM_COPY_KEY, on === true ? '1' : '0');
        } catch (e) {
          // localStorage 不可写时只是不记忆, 不影响功能
        }
      }

      /** git 页签上下两栏的比例(上栏占正文高度的百分比)。 */
      function readGitSplit() {
        try {
          var raw = window.localStorage.getItem(GIT_SPLIT_KEY);
          var pct = raw === null || raw === '' ? NaN : Number(raw);
          if (!isFinite(pct)) return GIT_SPLIT_DEFAULT;
          return Math.min(GIT_SPLIT_MAX, Math.max(GIT_SPLIT_MIN, pct));
        } catch (e) {
          return GIT_SPLIT_DEFAULT;
        }
      }

      function writeGitSplit(pct) {
        try {
          window.localStorage.setItem(GIT_SPLIT_KEY, String(pct));
        } catch (e) {
          // localStorage 不可写时只是不记忆, 不影响功能
        }
      }

      // ---- 终端视图(内核 = 官方 ctx.webTerminals, 外壳 = 本插件的抽屉) ----

      /**
       * 一个 xterm 实例 ↔ 官方 `ctx.webTerminals` 的一个 view(每会话一个)。
       * 帧由官方推来(`snapshot` → `output`), 本组件只负责把它交给 xterm 并 ack。
       */
      function TerminalView(props) {
        var sessionId = props.sessionId;
        var visible = props.visible !== false;
        var hostRef = React.useRef(null);
        var termRef = React.useRef(null);
        var fitRef = React.useRef(null);
        /** 这个会话的官方终端 view(取或建见 effect 里的 `ctx.webTerminals.view`)。 */
        var viewRef = React.useRef(null);
        var statePair = React.useState(null);
        /** 官方 `view.state` 的最新快照: `{phase, writable, info, environment, render, error, issue}`。 */
        var viewState = statePair[0];
        var setViewState = statePair[1];
        /**
         * 「选中即复制」开关的当前值。⚠ 终端 effect 只按 `[sessionId, visible]` 重挂(重挂 = 重建终端),
         * 所以开关**不能**进依赖数组, 只能走 ref 让 mouseup 那条闭包读到最新值。
         */
        var copyRef = React.useRef(props.copyOnSelect !== false);

        React.useEffect(
          function () {
            copyRef.current = props.copyOnSelect !== false;
          },
          [props.copyOnSelect],
        );

        React.useEffect(
          function () {
            // 终端**按会话**取(官方 view 归 Session, 见 ADR-0006): 没有会话 id 就没有终端可开。
            if (!visible || typeof sessionId !== 'string' || sessionId === '') return undefined;
            var disposed = false;
            var term = null;
            var view = null;
            var fit = null;
            var ro = null;
            var onData = null;
            /** 官方 state 的退订函数; 以及 `view.mount()` 返回的 detach(**只摘流, 不杀进程**)。 */
            var unsubscribe = null;
            var detach = null;
            /** 已经交给 xterm 的最大帧号 —— 官方按 revision 递增推送, 只认更大的。 */
            var lastRevision = 0;
            /** 本次挂上去的所有监听 —— `[target, type, fn, capture]`, cleanup 照着这张表逐个摘。 */
            var listeners = [];
            /** 上一次**已经写进剪贴板**的选区文字, 用来避免同一段被反复重写(见下面的 mouseup)。 */
            var lastCopied = null;
            /** 这次拖拽是不是**从终端里**开始的 —— 只用来决定要不要吃掉 mousemove(见 onMoveCapture)。 */
            var dragFromTerm = false;
            /** 拖拽开始时算好的「最后一行有内容」的绝对行号(mouseup 时会重算一次)。 */
            var dragLastRow = -1;
            /** 这次拖拽被"内容下方那条边界"挡过没有 —— 挡过说明用户想拖到底, 松手时尾巴要补到行尾。 */
            var dragBlocked = false;

            /** 挂一个监听并记账(cleanup 时照表摘, 不用逐个记变量)。 */
            function listen(target, type, fn, capture) {
              if (target === null || target === undefined) return;
              if (typeof target.addEventListener !== 'function') return;
              target.addEventListener(type, fn, capture === true);
              listeners.push([target, type, fn, capture === true]);
            }

            /** 第 `i` 行的文本(右侧裁剪后) —— 空行给 `''`。 */
            function lineText(i) {
              if (term === null || i < 0) return '';
              var buf = term.buffer.active;
              if (i >= buf.length) return '';
              var line = buf.getLine(i);
              if (line === undefined || line === null) return '';
              if (typeof line.translateToString !== 'function') return '';
              return line.translateToString(true);
            }

            /** 当前「最后一行有内容」的绝对行号(整屏都空给 -1)。 */
            function lastContentRow() {
              if (term === null) return -1;
              return findLastContentRow(lineText, term.buffer.active.length - 1);
            }

            /**
             * 把选区的**尾巴**收到最后一行有内容的那行 —— 用户报的 "拖到底选中一堆空行, 复制出一串换行"。
             * 只在 mouseup / Alt+C 这种"这次选区定下来了"的时刻做, 因为 xterm 唯一的公开落选区接口
             * `select()` 会先 `_removeMouseDownListeners()` —— 拖拽途中调用会把这次拖拽弄断。
             * @param expandTail 这次拖拽被边界挡过 → 尾巴补到该行文字末尾(见 clampSelectionTail)
             * @returns 收敛后是否还留着选区
             */
            function settleSelection(expandTail) {
              if (term === null) return false;
              var row = lastContentRow();
              if (row < 0) return false;
              var pos = null;
              try {
                pos =
                  typeof term.getSelectionPosition === 'function' ? term.getSelectionPosition() : null;
              } catch (e) {
                pos = null;
              }
              if (pos === null || pos === undefined) return false;
              var plan = clampSelectionTail(pos, row, lineText(row).length, term.cols, expandTail);
              if (plan === null) return true;
              try {
                if (plan.clear === true) term.clearSelection();
                else term.select(plan.column, plan.row, plan.length);
              } catch (e) {
                // 收敛失败就保持原样: 宁可多带几个空行, 也别把用户刚选的那段弄没了
              }
              return plan.clear !== true;
            }

            /** 从终端里按下左键 = 这次拖拽归我们管(抽屉上缘那条拖柄因此完全不受影响)。 */
            function onMouseDownCapture(ev) {
              dragFromTerm = ev.button === 0;
              dragLastRow = dragFromTerm ? lastContentRow() : -1;
              dragBlocked = false;
            }

            /**
             * xterm 允许把选区一路拖到视口里**任何一格**, 包括内容下方那一大片空白 —— 这就是那条 bug。
             * 做法: 在 **document 捕获阶段**吃掉这次 mousemove。xterm 的拖拽监听挂在 document 的
             * **冒泡**阶段(捕获一定先跑), 收不到这次移动, 选区就停在最后一行有内容处, 拖蓝也不会漫过去。
             * ⚠ 三个与门缺一不可: **从终端里开始**的拖拽 + 还按着左键 + 指针落在"内容下方那一块";
             *   否则别处的拖拽(抽屉高度、git 分栏)或正常移动都会被误吃。
             * ⚠ 应用开了鼠标上报(全屏 TUI: vim / htop …)时一概不碰 —— 那时鼠标归应用, 不是我们在选字。
             */
            function onMoveCapture(ev) {
              if (disposed || !dragFromTerm) return;
              if (!ev.buttons) {
                dragFromTerm = false;
                return;
              }
              if (term === null) return;
              var modes = term.modes;
              if (modes === undefined || modes === null) return;
              if (modes.mouseTrackingMode !== 'none') return;
              var el = term.element;
              if (el === null || el === undefined || typeof el.querySelector !== 'function') return;
              var rect = (el.querySelector('.xterm-screen') || el).getBoundingClientRect();
              var row = mouseRowAt(
                ev.clientY,
                rect.top,
                rect.height,
                term.rows,
                term.buffer.active.viewportY,
              );
              if (row >= 0 && row > dragLastRow) {
                dragBlocked = true;
                ev.stopPropagation();
              }
            }

            /**
             * 把终端当前选区写进剪贴板 —— **"选中即复制" 与 Alt+C 共用这一条**, 免得两条路走岔。
             * @param force Alt+C 走 true: 即使与上次复制的内容相同也**重写一遍**(它是"兜底" ——
             *              自动那次没成功时, 内容当然可能一模一样, 这时不能跳过)。
             * @param expandTail 这次拖拽被内容边界挡过 → 尾巴补到行尾(见 clampSelectionTail)。
             * @returns 是否真的写了
             */
            function copySelection(force, expandTail) {
              // 先把尾巴收干净再读文本 —— 两个入口(mouseup / Alt+C)都走这条, 复制出来就不会带空行。
              settleSelection(expandTail);
              var selected = typeof term.getSelection === 'function' ? term.getSelection() : '';
              if (typeof selected !== 'string' || selected === '') {
                lastCopied = null; // 选区没了(普通单击清掉) —— 下次重新选同一段要能再复制
                return false;
              }
              if (force !== true && selected === lastCopied) return false;
              lastCopied = selected;
              try {
                Promise.resolve(primitives.writeClipboard(selected)).catch(function (err) {
                  console.warn('[fge] 复制终端选区失败', err);
                });
              } catch (err) {
                console.warn('[fge] 复制终端选区失败', err);
              }
              return true;
            }

            ensureXterm()
              .then(function (mod) {
                if (disposed || hostRef.current === null) return;
                term = new mod.Terminal({
                  convertEol: false,
                  cursorBlink: true,
                  fontSize: 12,
                  scrollback: 2000,
                  theme: terminalTheme(lastThemeSnapshot),
                });
                fit = new mod.FitAddon();
                term.loadAddon(fit);
                term.open(hostRef.current);
                termRef.current = term;
                fitRef.current = fit;
                liveTerms.add(term);
                // **打开抽屉就把焦点给终端**(用户口径: 省掉"再用鼠标点一下终端才能打字"这一步)。
                // ⚠ 必须放在 `open()` **之后**: xterm 的 focus() 是打到它自己那个隐藏 textarea 上的,
                //   元素还没挂上去就没有焦点可给(静默失败)。
                // ⚠ 只在**挂载时**做一次(effect 依赖是 [sessionId, visible], 不是每次渲染) —— 否则用户
                //   刚点去 composer 打字, 一次无关重渲染就会把焦点抢回来。
                // ⚠ 副作用要说清: 焦点一进来, **Esc 就归终端了**(与"焦点在终端里"那条分流一致),
                //   开抽屉后 Esc 不再收起抽屉 —— 想收起点条空白处 / 页签上的 `×`。
                try {
                  term.focus();
                } catch (e) {
                  // 焦点拿不到就算了(比如容器还不可见), 不影响终端本身
                }
                // **选中即复制**(用户口径: 终端里选中就复制, Alt+C 只是兜底; 条右侧那枚开关能关掉自动那条)。
                // 拖选 / 双击选词 / 三击选行都以 mouseup 收尾, 所以在 mouseup 上读一次选区。
                // ⚠ 必须在 mouseup **同步**读 + 同步发起写入: 剪贴板 API 要"用户手势",
                //   挪进 setTimeout 就可能被拒(那时手势已经过期)。
                // ⚠ 挂在**终端体**上(不是 document): 鼠标在终端外松开时不去动剪贴板。
                // ⚠ 开关关着时**也要收选区**(settleSelection) —— 那是选区本身的口径, 与"要不要复制"无关。
                listen(hostRef.current, 'mouseup', function () {
                  if (disposed || term === null) return;
                  // 这次拖拽被边界挡过 → 尾巴补到那行文字末尾("拖到底"就该整行选上, 不许把最后一行截断)
                  var blocked = dragBlocked;
                  dragBlocked = false;
                  if (copyRef.current) copySelection(false, blocked);
                  else settleSelection(blocked);
                });
                // 收尾两件事: 记下"这次拖拽从终端里开始"(供 onMoveCapture 判定), 以及拖拽结束就作废该标记。
                listen(hostRef.current, 'mousedown', onMouseDownCapture, true);
                listen(document, 'mousemove', onMoveCapture, true);
                listen(
                  document,
                  'mouseup',
                  function () {
                    dragFromTerm = false;
                  },
                  true,
                );
                // ⚠ Alt+C 仍然保留, 而且是**强制**重写那一条(见 copySelection 的 force): 它就是给
                // 自动那次没成功时兜底用的, 内容当然可能一样。
                // 不用 Ctrl+C —— 那是 SIGINT, 必须原样送给 PTY;
                // 也不占 Ctrl+Shift+C(那是浏览器/DevTools 的"检查元素", 抢了很碍事)。
                // `attachCustomKeyEventHandler` 返回 false = 这次按键不送给 PTY。
                term.attachCustomKeyEventHandler(function (ev) {
                  if (ev.type !== 'keydown') return true;
                  if (!ev.altKey) return true;
                  if (!(ev.key === 'c' || ev.key === 'C' || ev.code === 'KeyC')) return true;
                  // 兜底那条只按当前选区复制, 不做"补到行尾"的推断(那是拖拽手势才有的信息)
                  copySelection(true, false);
                  return false;
                });
                // ---- 内核 = 官方 terminal-controller(见 ADR-0006) ----
                //
                // `view()` 就是"取或建": 官方按 (会话, key) 缓存 view, 所以同一个会话反复开关抽屉拿回的是
                // **同一个**终端; 而且官方在 `view()` 里就 `refresh()`(探测 shell + 起进程),
                // 这里没有"连接"这一步 —— 挂 DOM 生命周期走 `mount()`。
                try {
                  view = ctx.webTerminals.view(sessionId, TERM_KEY);
                } catch (err) {
                  if (!disposed) {
                    setViewState({ phase: 'failed', writable: false, error: errText(err) });
                  }
                  return;
                }
                viewRef.current = view;
                termViews.set(sessionId, view);

                /** 官方 view 的最新快照 —— 帧以外的地方(只读态 / 尺寸上限)读它。 */
                var latest = null;

                /**
                 * 按官方上限 refit(与官方正文的 `fitScreen` 同一口径: `proposeDimensions()` 的结果
                 * 先夹到 `environment.maxCols/maxRows`, 再同时告诉 xterm 与 host)。
                 */
                function fitToHost() {
                  if (fit === null || term === null) return;
                  var dims = null;
                  try {
                    dims = fit.proposeDimensions();
                  } catch (e) {
                    return; // 容器尚未布局
                  }
                  if (dims === undefined || dims === null) return;
                  var env = latest === null ? undefined : latest.environment;
                  var cols = env === undefined ? dims.cols : Math.min(dims.cols, env.maxCols);
                  var rows = env === undefined ? dims.rows : Math.min(dims.rows, env.maxRows);
                  if (cols < 2 || rows < 1) return;
                  try {
                    term.resize(cols, rows);
                  } catch (e) {
                    return;
                  }
                  view.resize(cols, rows); // 非 writable 时官方自己忽略
                }

                /** 官方快照的落点: 存下来 → 交给 React → 同步只读态 → 有帧就写屏。 */
                function syncViewState() {
                  if (disposed || view === null) return;
                  latest = view.state.getSnapshot();
                  if (term !== null) term.options.disableStdin = latest.writable !== true;
                  lastRevision = applyTerminalFrame(term, view, latest.render, lastRevision);
                  setViewState(latest);
                }

                unsubscribe = view.state.subscribe(syncViewState);
                syncViewState();
                // 挂上 DOM 生命周期。返回的 detach **只摘流, 不杀进程** —— 收起抽屉走的正是这一条。
                detach = view.mount();
                // ⚠ 必须在 `mount()` 之后: 尺寸上限只有 `environment` 到了才有。
                fitToHost();

                onData = term.onData(function (data) {
                  // 输入原样交给官方(它自己排队 + 限流, 非 writable 时直接丢弃)。
                  if (view !== null) view.write(data);
                });

                // 尺寸变化 → 重新 refit 并同步给 host 的 PTY
                if (typeof ResizeObserver === 'function') {
                  ro = new ResizeObserver(function () {
                    if (disposed) return;
                    fitToHost();
                  });
                  ro.observe(hostRef.current);
                }
              })
              .catch(function (err) {
                if (!disposed) {
                  setViewState({ phase: 'failed', writable: false, error: errText(err) });
                }
              });

            return function () {
              disposed = true;
              if (ro !== null) ro.disconnect();
              if (onData !== null) onData.dispose();
              // 照登记表逐个摘 —— 包括挂在 document 捕获阶段那两个(不摘就会随着 effect 重跑越挂越多)。
              for (var li = 0; li < listeners.length; li++) {
                var rec = listeners[li];
                if (typeof rec[0].removeEventListener === 'function') {
                  rec[0].removeEventListener(rec[1], rec[2], rec[3]);
                }
              }
              listeners = [];
              dragFromTerm = false;
              dragLastRow = -1;
              dragBlocked = false;
              // 收起抽屉: 只摘订阅 + detach —— **不 close**(进程与屏幕都由 host 的官方终端留着,
              // 再展开就是同一个终端 + 一帧新快照)。
              if (unsubscribe !== null) {
                try {
                  unsubscribe();
                } catch (e) {
                  // 忽略
                }
              }
              if (detach !== null) {
                try {
                  detach();
                } catch (e) {
                  // 忽略
                }
              }
              if (view !== null && termViews.get(sessionId) === view) termViews.delete(sessionId);
              if (term !== null) {
                liveTerms.delete(term);
                try {
                  term.dispose();
                } catch (e) {
                  // 忽略
                }
              }
              termRef.current = null;
              fitRef.current = null;
              viewRef.current = null;
            };
          },
          [sessionId, visible],
        );

        var status = terminalStatus(viewState);

        return h(
          'div',
          { className: 'fge-root' },
          status === null
            ? null
            : h(
                'div',
                { className: 'fge-term-status' },
                h('span', { className: 'fge-term-status-text' }, status.text),
                status.action === null
                  ? null
                  : h(
                      'button',
                      {
                        type: 'button',
                        className: 'fge-term-status-action',
                        onClick: function () {
                          termAction(viewRef.current, status.action.run);
                        },
                      },
                      status.action.label,
                    ),
              ),
          h('div', { className: 'fge-term-body', ref: hostRef }),
        );
      }

      /** 错误 → 一行文案(取 view 本身也可能抛, 那时没有 `message`)。 */
      function errText(err) {
        if (err === null || err === undefined) return '未知原因';
        var msg = err.message === undefined ? String(err) : String(err.message);
        return msg === '' ? '未知原因' : msg;
      }

      /**
       * 官方 view 的状态 → 抽屉顶上那行提示 + 至多一枚动作。
       *
       * 口径照官方终端正文的状态条(`phase` / `info.state` / `writable` / `issue`), 但只取**一条文案
       * 加一枚动作** —— 抽屉的标题条是照 Windows Terminal 做的, 不再引入第二条状态栏。
       * 可写且连着时返回 `null`: 什么都不显示(`fge-term-status` 那一行是占位的, 不该常驻)。
       */
      function terminalStatus(viewState) {
        if (viewState === null || viewState === undefined) return null;
        var issue = viewState.issue;
        if (issue === 'inputFull') return { text: '终端输入队列已满, 这次输入被拒绝', action: null };
        if (issue === 'terminalLimit') return { text: '该会话的终端数已达上限', action: null };
        if (issue === 'missingTerminal') return { text: '这个终端已不存在, 收起再展开即可新建', action: null };
        if (issue === 'attachmentEnded') return { text: '终端连接已被替换', action: { label: '接管输入', run: 'connect' } };
        var info = viewState.info;
        if (viewState.phase === 'failed' || viewState.phase === 'disconnected') {
          var text =
            viewState.phase === 'disconnected'
              ? '连接已断开'
              : '终端失败: ' + (viewState.error === undefined ? '未知原因' : viewState.error);
          // 与官方正文那条 retry 同款: 还没有进程信息就重新拉一次, 有了就重连。
          return info === undefined
            ? { text: text, action: { label: '重试', run: 'refresh' } }
            : { text: text, action: { label: '重新连接', run: 'connect' } };
        }
        if (viewState.phase === 'closed') return { text: '进程已结束, 收起再展开可新建终端', action: null };
        if (info !== undefined && info.state === 'exited') {
          return {
            text:
              '进程已结束' +
              (info.exitCode === null || info.exitCode === undefined
                ? ''
                : '(退出码 ' + String(info.exitCode) + ')'),
            action: null,
          };
        }
        if (info !== undefined && info.state === 'failed') {
          return { text: '终端不可用: ' + (info.error === undefined ? '未知原因' : info.error), action: null };
        }
        if (viewState.phase === 'connected' && viewState.writable !== true) {
          return { text: '只读(另一处持有输入权)', action: { label: '接管输入', run: 'connect' } };
        }
        if (viewState.phase !== 'connected') return { text: '正在连接终端…', action: null };
        return null;
      }

      /** 状态行上那枚动作按钮: `connect` = 重新连接 / 接管输入, `refresh` = 重新拉一次终端。 */
      function termAction(view, run) {
        if (view === null || view === undefined) return;
        try {
          if (run === 'connect') view.connect();
          else if (run === 'refresh') view.refresh();
        } catch (err) {
          console.warn('[fge] 终端动作失败', err);
        }
      }

      /**
       * 终止终端的进程(标题条右端那枚终止键)。
       *
       * 走官方 `view.close()` —— 它的语义是**请求结束进程**(后台清理, 失败会留在 `closeFailures` 里
       * 可重试), 不再是本插件自己 `proc.kill()` 一棵进程树。失败会落进 view 的 state,
       * 由 `terminalStatus` 那行提示带出来。
       */
      function killTerminal(sessionId) {
        var view = termViews.get(sessionId);
        if (view === undefined) return;
        Promise.resolve()
          .then(function () {
            return view.close();
          })
          .catch(function (err) {
            console.warn('[fge] 终止终端失败', err);
          });
      }

      // ---- Git 页签: 变更列表 + 提交历史 ----

      function formatTime(sec) {
        try {
          return new Date(sec * 1000).toLocaleString();
        } catch (e) {
          return '';
        }
      }

      /**
       * 按**会话**缓存的 git 页签**视图状态** —— 只记「你看到哪儿了」, 不装 git 数据本体:
       * `{cwd, viewedRef, focused, splitBefore, msgOpen}`。重挂 / 切回来时靠它恢复(见 §10)。
       */
      var gitViews = new Map();

      /**
       * git **数据**快照, 按**工作区**缓存: 键 = `workspaceKey(cwd)`, 值 = `{cwd, info, status, history, at}`。
       *
       * ⚠ 「数据」与「视图状态」分成两份, 是这一步修的东西: 两者原来一起挂在**会话 id** 上, 于是
       *   "同一个工作区、换个会话"被当成全新工作区, 从头 `info → status → log` 再读一遍 —— 面板先白成
       *   「读取中… / 读取历史…」再回填, 用户看到的就是"切个会话又要等它读一遍"(实测: 每次切换固定
       *   三条请求 200–730ms)。同一个工作区的两个会话看的是**同一个仓库**, 数据本来就该共享;
       *   真正该按会话分的只有上面那份"你看到哪儿了"。
       *
       * `history` 只收**当前分支第一页**(`history.ref === null`): 切回来时 `viewedRef` 会被重置成 `''`,
       *   只有这一页与它对得上; 看过别的分支的历史只留在那个会话自己的视图里, 不进快照。
       */
      var gitData = new Map();


      /**
       * 「从聚焦提交返回列表」的回调: 只在聚焦态叠着时才有值(GitTabBody 每次渲染写一次)。
       * 放在模块级, 是为了让 apply 里那条**唯一的** Esc 监听能做分层 ——
       * 悬浮面板 → 分支小浮窗 → 聚焦提交 → 都不做(见 §14)。
       */
      var focusEsc = { current: null };

      /**
       * 「刷新 git」的回调(**Alt+Ctrl+R** 用): GitTabBody 每次渲染写进来, 卸载时清掉 —— 与 `focusEsc` 同款,
       * 放在模块级是为了让 apply 里那条全局 keydown 够得着页签体内部的 `manualRefresh`。
       *
       * ⚠ **卸载必须清空**: 右栏收起 / 切到别的页签时页签体会卸载, 留着一个陈旧闭包会把"上一个会话的
       *   工作区"再刷一遍(闭包里 captured 的是那时的 cwd 与状态); 清空后快捷键自然变成"什么都不做"。
       * ⚠ 它指向的就是页签上那枚 `⟳` 的 `manualRefresh`(先 sync 再 info → status → 历史首页),
       *   不是另写一套刷新逻辑 —— 一个动作只有一个入口。
       */
      var gitRefresh = { current: null };

      /**
       * 「按了 Alt+Ctrl+R, 但页签体还没挂载」这一笔: 右栏收起 / 当前那格不是 Git 时, 快捷键先把这一位置 1
       * 并切到 Git 页签, 页签体挂载时看到它就立刻刷一次(见 GitTabBody 里注册 `gitRefresh` 的那个 effect)。
       * 一次性标志, 用完就清 —— 否则之后每次重挂都会莫名其妙刷一遍。
       */
      var gitRefreshPending = { current: false };

      /**
       * 按目录归类 + 层级线的行数组工厂(见 makeTreeRows 的注释)。
       * ⚠ 两个顶层入口都走 `root`(三参数形式) —— 位置少一个就传不出错
       *   (这里翻过一次车, 见 makeTreeRows 的注释)。
       */
      var treeRows = makeTreeRows(h);

      /**
       * 一条提交的**说明块**: 折叠态只显示**两行**, 放不下才给「展开 / 收起」。
       *
       * ⚠ 「放不下」是**量出来的**(`scrollHeight > clientHeight`, 见 .fge-msg CSS 注释), 不按行数猜 ——
       *   一行很长的 subject 折行后同样得给出口, 猜短了就是把内容永久藏起来。
       * ⚠ 只在**折叠态**量: 展开态 `scrollHeight === clientHeight`, 量了会让「收起」自己消失。
       * ⚠ 开关画在**文字上方**: 展开后它不会跟着内容跑到最底下, 不用再拉滚动条去找「收起」(用户口径)。
       * ⚠ 用 `useLayoutEffect` 而不是 `useEffect`: 按钮在**同一帧**就位, 下面的文件清单不会先跳一下。
       * ⚠ 还盯一个 `ResizeObserver`: 右栏宽度可拖, 变宽可能就放得下了 —— 不重量的话「展开」会一直挂着;
       *   反过来变窄时更糟(没按钮 = 内容被永久藏住)。
       * 展开态本身**不放在这里** —— 与 `focused` 同款, 按会话缓存在 GitTabBody 里(见 §10)。
       */
      function CommitMessage(props) {
        var open = props.open === true;
        var ref = React.useRef(null);
        var overPair = React.useState(false);
        var over = overPair[0];
        var setOver = overPair[1];
        React.useLayoutEffect(
          function () {
            var el = ref.current;
            if (el === null) return undefined;
            function measure() {
              if (open) return; // 展开态量不出真话(两者相等)
              if (el.scrollHeight > el.clientHeight + 1) setOver(true);
              else setOver(false);
            }
            measure();
            if (typeof ResizeObserver !== 'function') return undefined;
            var observer = new ResizeObserver(measure);
            observer.observe(el);
            return function () {
              observer.disconnect();
            };
          },
          [open, props.text],
        );
        return h(
          'div',
          { className: 'fge-msg' },
          over === true
            ? h(
                'div',
                { className: 'fge-msg-bar' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'fge-msg-toggle',
                    'aria-expanded': open ? 'true' : 'false',
                    onClick: props.onToggle,
                  },
                  open ? '收起' : '展开',
                ),
              )
            : null,
          h(
            'pre',
            {
              ref: ref,
              className: 'fge-msg-text',
              // 折叠态一律挂 data-clamp: 放不下时**首帧就是两行**, 不会先闪一下全文。
              'data-clamp': open ? undefined : '1',
            },
            props.text,
          ),
        );
      }

      /**
       * 提交 hash 的**胶囊**: 显示短的, 点一下复制**完整** hash(粘进终端就能 `git show <hash>`)。
       *
       * ⚠ 必须 `stopPropagation`: 它长在"点这条提交就聚焦"的那一行里, 不拦一下复制会连带导航。
       * 反馈沿用本仓库既有的那套(`data-s` = done / failed, 1.2s 后回到短 hash); 复制走
       * `primitives.writeClipboard` —— 与「复制内容」芯片、终端选中即复制同一条路, host 侧零改动。
       */
      function HashChip(props) {
        var statePair = React.useState(null);
        var state = statePair[0];
        var setState = statePair[1];
        var timer = React.useRef(null);
        React.useEffect(function () {
          return function () {
            if (timer.current !== null) window.clearTimeout(timer.current);
          };
        }, []);
        function onCopy(ev) {
          // 先吃掉冒泡: 这一行整行都是"进聚焦"的点击区。
          ev.stopPropagation();
          Promise.resolve(primitives.writeClipboard(props.hash))
            .then(function (ok) {
              setState(ok === false ? 'failed' : 'done');
            })
            .catch(function () {
              setState('failed');
            })
            .then(function () {
              if (timer.current !== null) window.clearTimeout(timer.current);
              timer.current = window.setTimeout(function () {
                setState(null);
              }, 1200);
            });
        }
        return h(
          'button',
          {
            type: 'button',
            className: 'fge-chip fge-hash',
            'data-s': state === null ? undefined : state,
            title: '点击复制完整 hash: ' + props.hash,
            onPointerDown: function (ev) {
              ev.stopPropagation();
            },
            onClick: onCopy,
          },
          state === 'done' ? '已复制' : state === 'failed' ? '复制失败' : props.short,
        );
      }

      /**
       * 本插件的常驻 git 页签。
       *
       * 正文是**上下两栏**(见 GIT_SPLIT_*): 上栏**变更列表**, 下栏在**历史列表态**与**聚焦态**之间二选一 ——
       * 点一条提交就**聚焦**它(整栏只剩这一条, 顶上带返回键), 见 focusCommit / exitFocus。
       * 无论哪个形态, 点任一文件(变更行的、聚焦里的)都把 diff 送进**悬浮面板** —— git 本体不开悬浮面板。
       *
       * ⚠ 本组件**会被卸载重挂**: dockkit 只渲染活动页签的页签体, 而点文件打开的 diff 页签会成为
       * 活动页签, 于是 git 页签体被卸载; diff 页签浮起后离开页签条, git 页签又成为活动页签、重新挂载。
       * **切会话也是重挂** —— 每个会话的右栏页签是各自的一份, 所以这一步挂在会话 id 上就会重来一遍。
       * 状态若只放组件里, 就会出现"点一下文件, 历史列表闪一下、你正看的那条被顶掉"(实测复现)。
       *
       * 于是模块级放**两份**缓存, 按两种不同的东西分:
       *   · `gitViews`(键 = **会话 id**)—— **视图状态**: 查看分支 / 聚焦态 / 列表滚动位置 / 分栏比例 /
       *     说明展开态。这些是"你看到哪儿了", 换会话本来就该各看各的;
       *   · `gitData`(键 = **工作区**)—— **数据**: info / status / 历史首页。同一个工作区的两个会话
       *     看的是同一个仓库, 没有理由各存一份、更没有理由切一次就重读一次(见下面 mount effect)。
       */
      function GitTabBody(props) {
        var useTabInfo = props.useTabInfo;
        var sessionId = props.sessionId;
        var useSessions = props.useSessions;

        var tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : null;
        var visible = !!(tabInfo && tabInfo.tab && tabInfo.tab.visible);

        var sessionCwd = useSessionCwd(useSessions, sessionId);
        var running = useSessionRunning(useSessions, sessionId);

        // 视图状态按**会话**复用(同一个工作区的重挂 / 切回来都还在); 数据按**工作区**取(见 gitData)。
        var viewKey = sessionId || '(no-session)';
        var cachedView = gitViews.get(viewKey);
        var restored =
          cachedView !== undefined && cachedView.cwd === sessionCwd ? cachedView : null;
        var dataKey = workspaceKey(sessionCwd);
        var snapshot = dataKey === null ? undefined : gitData.get(dataKey);

        var infoPair = React.useState(snapshot === undefined ? null : snapshot.info);
        var info = infoPair[0];
        var setInfo = infoPair[1];
        var statusPair = React.useState(snapshot === undefined ? null : snapshot.status);
        var status = statusPair[0];
        var setStatus = statusPair[1];
        var errorPair = React.useState(null);
        var error = errorPair[0];
        var setError = errorPair[1];
        var busyPair = React.useState(false);
        var busy = busyPair[0];
        var setBusy = busyPair[1];
        var refPair = React.useState(restored === null ? '' : restored.viewedRef);
        var viewedRef = refPair[0];
        var setViewedRef = refPair[1];
        var histPair = React.useState(snapshot === undefined ? null : snapshot.history);
        var history = histPair[0];
        var setHistory = histPair[1];
        // 聚焦提交: null = 下栏是提交历史列表; 否则下栏整栏只有这一条(见 focusCommit)。
        // 与其它视图状态一样按会话缓存, 重挂 / 切会话回来都还在那一条里(见 §10)。
        // ⚠ 作者 / 时间 / 短 hash 一起缓存在这里 —— `show` 不回这几个字段, 别回头去列表里找。
        var focusPair = React.useState(restored === null ? null : restored.focused || null);
        var focused = focusPair[0];
        var setFocused = focusPair[1];
        // 进聚焦前列表滚到哪儿了 —— 返回时原样还回去(用户口径: 返回不要重新刷新, 也别丢位置)。
        // ⚠ 用 ref 而不是状态 + 缓存: 它只在**同一次挂载内**的"聚焦 → 返回"有意义; 组件重挂
        //   (点文件开 diff 再回来)时并没有可信的列表位置, 那种情况下什么都不该动(见下面那条 layout effect)。
        var scrollBefore = React.useRef(0);
        var restoreScroll = React.useRef(false);
        // 进聚焦前那个分栏比例; 聚焦期间如果自己又拖过拖柄, 就清空(那时"新值"才是你的偏好)。
        var beforePair = React.useState(restored === null ? null : restored.splitBefore || null);
        var splitBefore = beforePair[0];
        var setSplitBefore = beforePair[1];
        // 提交说明的「展开全文」表(键 = commit hash)。跟 focused 同款按会话缓存, 重挂后还在。
        var msgPair = React.useState(restored === null ? {} : restored.msgOpen || {});
        var msgOpen = msgPair[0];
        var setMsgOpen = msgPair[1];
        var menuPair = React.useState(false);
        var menuOpen = menuPair[0];
        var setMenuOpen = menuPair[1];
        // 上下两栏的比例(上栏 = 变更列表), 与终端抽屉高度同款: 拖过就记, 没拖过就是 3/4。
        var splitPair = React.useState(readGitSplit);
        var split = splitPair[0];
        var setSplit = splitPair[1];
        var bodyRef = React.useRef(null);
        // 下栏那个滚动容器(列表态与聚焦态共用同一个元素): 进出聚焦时靠它摆正滚动位置。
        var paneBottomRef = React.useRef(null);

        // 分支小浮窗的锚点(头部那颗分支按钮)与面板; 定位与"点外面关掉"都用官方原语:
        // useAnchoredPosition 给视口坐标 + 视口内钳制, useDismissOnOutsidePointer 管外部 pointerdown。
        var branchAnchorRef = React.useRef(null);
        var branchMenuRef = React.useRef(null);
        var branchMenuPos = primitives.useAnchoredPosition({
          open: menuOpen,
          anchorRef: branchAnchorRef,
          panelRef: branchMenuRef,
          side: 'bottom',
          gap: 4,
          margin: 8,
        });
        primitives.useDismissOnOutsidePointer(
          branchAnchorRef,
          menuOpen,
          setMenuOpen,
          branchMenuRef,
        );

        // ---- worktree 切换器(主仓 / 各 worktree) ----
        //
        // ⚠ 为什么需要它: git 页签的数据根是**会话的工作区**(DSH 的 workspace 就是那个目录, 不会因为
        //   仓库里存在 worktree 就变), 而实际干活常常在 `.worktrees/<名字>` 里 —— 于是页签一直显示主仓
        //   所在的 `main`。这里给一个显式选择: 选谁, 之后 status / log / diff 就都拿谁的路径当 `root`。
        // ⚠ 选中的路径由 host 用 `git worktree list` 校验(见 handleWorktrees), 不是"客户端报什么信什么"。
        // ⚠ 选中项**按会话记**(与 viewedRef 同款存进 gitViews): 视角属于会话, 数据属于仓库。
        var wtPair = React.useState(restored === null ? null : restored.worktree || null);
        var worktreePath = wtPair[0];
        var setWorktreePath = wtPair[1];
        // worktree 列表也是**工作区数据**: 重挂 / 同工作区切会话时直接从快照恢复,
        // 于是"切会话零请求"那条承诺不受影响(见 reload 尾部的注释)。
        var wtListPair = React.useState(
          snapshot === undefined || !Array.isArray(snapshot.worktrees) ? [] : snapshot.worktrees,
        );
        var wtEntries = wtListPair[0];
        var setWtEntries = wtListPair[1];
        var wtMenuPair = React.useState(false);
        var wtMenuOpen = wtMenuPair[0];
        var setWtMenuOpen = wtMenuPair[1];
        var wtAnchorRef = React.useRef(null);
        var wtMenuRef = React.useRef(null);
        var wtMenuPos = primitives.useAnchoredPosition({
          open: wtMenuOpen,
          anchorRef: wtAnchorRef,
          panelRef: wtMenuRef,
          side: 'bottom',
          gap: 4,
          margin: 8,
        });
        primitives.useDismissOnOutsidePointer(wtAnchorRef, wtMenuOpen, setWtMenuOpen, wtMenuRef);

        // Esc 关小浮窗(焦点分流与终端一致: 终端里的 Esc 归终端)。两个浮窗一起管:
        // 同时开着的情况极罕见, 但"按一下 Esc 只关一个、另一个还在"更让人困惑。
        React.useEffect(
          function () {
            if (!menuOpen && !wtMenuOpen) return undefined;
            function onKey(ev) {
              if (ev.key === 'Escape') {
                setMenuOpen(false);
                setWtMenuOpen(false);
              }
            }
            document.addEventListener('keydown', onKey, true);
            return function () {
              document.removeEventListener('keydown', onKey, true);
            };
          },
          [menuOpen, wtMenuOpen],
        );

        /**
         * 最近一次 info/status 得到的根, 供各次 git 调用复用(避免把 status 塞进所有依赖)。
         * 重挂时直接从工作区快照里恢复 —— 否则刚挂载就点文件会带着空的 repoRoot 去请求。
         */
        var repoRef = React.useRef({
          root: snapshot === undefined || snapshot.info === null ? null : snapshot.info.cwd,
          repoRoot:
            snapshot === undefined || snapshot.status === null ? null : snapshot.status.repoRoot,
        });
        var handlers = React.useRef({});

        var root = sessionCwd || (info ? info.cwd : null);
        /**
         * git 数据要看的根: 选了 worktree 就是它, 否则是会话自己的工作区。
         * ⚠ 只有 git 数据该跟着 worktree 走 —— 终端抽屉(`TerminalView`)仍然拿 `root`, 那是"会话的 shell"。
         */
        var dataRoot = worktreePath || sessionCwd;

        /** 拉一份 worktree 列表(主仓 + 各 worktree)。列表里只有主仓时切换器不露面。 */
        function loadWorktrees() {
          var reqRoot = sessionCwd || (info ? info.cwd : null);
          if (!reqRoot) {
            setWtEntries([]);
            return Promise.resolve(null);
          }
          return api('worktrees', { root: reqRoot })
            .then(function (res) {
              setWtEntries(res && res.ok === true && Array.isArray(res.entries) ? res.entries : []);
              return res;
            })
            .catch(function () {
              setWtEntries([]);
              return null;
            });
        }

        function loadStatus() {
          return api('info', dataRoot ? { root: dataRoot } : {})
            .then(function (res) {
              if (!res || res.ok !== true) throw new Error((res && res.error) || 'info-failed');
              // ⚠ 选中的 worktree 被删掉 / prune 之后, host 会从那个不存在的路径**向上**找到主仓 ——
              //   这时必须把选中项清掉: 否则按钮写着 worktree 的名字, 屏上其实是主仓的数据。
              if (worktreePath !== null && workspaceKey(res.repoRoot) !== workspaceKey(worktreePath)) {
                setWorktreePath(null);
              }
              setInfo(res);
              repoRef.current.root = res.cwd;
              return api('status', { root: res.cwd, repoRoot: res.repoRoot || undefined });
            })
            .then(function (res) {
              if (!res || res.ok !== true) {
                setStatus(null);
                setError((res && res.error) || 'status-failed');
                return null;
              }
              setError(null);
              setStatus(res);
              repoRef.current.repoRoot = res.repoRoot;
              return res;
            })
            .catch(function (err) {
              setError(String((err && err.message) || err));
              return null;
            });
        }

        function loadHistory(ref, skip) {
          var append = skip > 0;
          if (!append) {
            setHistory({ commits: [], loading: true, done: false, ref: ref || null, error: null });
          }
          return api(
            'log',
            gitPayload({
              ref: ref || undefined,
              skip: skip,
              limit: COMMIT_PAGE,
            }),
          )
            .then(function (res) {
              if (!res || res.ok !== true) {
                setHistory({
                  commits: [],
                  loading: false,
                  done: true,
                  ref: ref || null,
                  error: (res && res.error) || 'log-failed',
                });
                return;
              }
              setHistory(function (prev) {
                var base = append && prev && prev.commits ? prev.commits : [];
                var commits = base.concat(res.commits);
                return {
                  commits: commits,
                  loading: false,
                  done: res.commits.length < COMMIT_PAGE,
                  ref: res.ref || null,
                  error: null,
                };
              });
            })
            .catch(function (err) {
              setHistory({
                commits: [],
                loading: false,
                done: true,
                ref: ref || null,
                error: String((err && err.message) || err),
              });
            });
        }

        /** 首次 / 切工作区 / 切 worktree: 重取 info → status, 再看一次历史首页。 */
        function reload() {
          return loadStatus()
            .then(function (stat) {
              if (stat !== null) return loadHistory(viewedRef || null, 0);
              return null;
            })
            .then(function (done) {
              // worktree 列表与这份数据同属"工作区" ⇒ 放在同一条链的尾部一起取、一起进快照。
              // ⚠ 顺序上**必须**排在 git 数据之后: 它是切换器要用的, 不该插在 info/status/log 中间;
              //   而"同工作区切会话零请求"那条承诺靠的是快照(snapshot.worktrees)而不是这条调用。
              loadWorktrees();
              return done;
            });
        }

        /**
         * 切到某个 worktree(`entry === null` / `entry.main` = 回主仓, 也就是会话自己的工作区)。
         *
         * ⚠ 必须**清掉属于上一份仓库的视图状态**: 查看中的分支、聚焦的提交换了仓库就不成立
         *   (拿另一个仓库的 ref 去查历史只会报错); 详情浮层里的 diff 也是旧仓库的内容, 一并关掉。
         */
        function pickWorktree(entry) {
          setWtMenuOpen(false);
          var next = entry === null || entry.main === true ? null : entry.path;
          if (workspaceKey(next) === workspaceKey(worktreePath)) return;
          setViewedRef('');
          setFocused(null);
          setSplitBefore(null);
          setMsgOpen({});
          closeOwnedFloat();
          setHistory(null);
          setWorktreePath(next);
        }

        // 每次渲染都把最新闭包放进 ref, 供 effect / 延时回调取用(避免依赖数组抖动)。
        handlers.current = { reload: reload, loadHistory: loadHistory };

        // 进出聚焦时把下栏的滚动位置摆正: 进聚焦滚到顶; **从聚焦返回**时回到离开时那一处。
        // ⚠ 只在"刚返回"那一次还原(`restoreScroll` 是一次性闸门): 组件重挂(点文件开 diff 再回来)
        //   并没有可信的列表位置, 那时不该按一个陈旧的值把列表跳走 —— 什么都不动就是浏览器给的位置。
        // ⚠ 用 useLayoutEffect: 摆在 paint 之前, 不会先画一帧"列表停在别处"再跳回去。
        // ⚠ 依赖是 `focused === null`(布尔)而不是 `focused` 本身 —— 详情到达时 focused 会换个对象,
        //   拿它当依赖会在那一刻又动一次滚动。
        React.useLayoutEffect(
          function () {
            var pane = paneBottomRef.current;
            if (pane === null) return;
            if (focused !== null) {
              pane.scrollTop = 0;
              return;
            }
            if (restoreScroll.current) {
              restoreScroll.current = false;
              pane.scrollTop = scrollBefore.current;
            }
          },
          [focused === null],
        );

        // 把「从聚焦提交返回列表」交给 apply 里那条**唯一的** Esc 监听做分层(悬浮面板优先, 见 §14)。
        // ⚠ 分支小浮窗开着时**不交**:它是最内层的临时浮窗, Esc 该只关它 —— 否则一次 Esc 会
        //   既关菜单又把你从聚焦里踢回列表(那条全局监听注册得早、跑在菜单自己的监听之前)。
        // 每次渲染重写一次, 卸载时清掉 —— 与 handlers 同款, 避免依赖数组抖动。
        React.useEffect(function () {
          focusEsc.current = focused === null || menuOpen ? null : exitFocus;
          return function () {
            focusEsc.current = null;
          };
        });

        // 把「刷新 git」交给全局 **Alt+Ctrl+R**(与 focusEsc 同款: 每次渲染重写、卸载清掉)。
        // 注册的是同一个 `manualRefresh` —— 快捷键与页签上那枚 `⟳` 必须是同一条路。
        // ⚠ 不再因为 `busy` 而不接: `manualRefresh` 自己会早退, 而"按了完全没反应"比"按了但忙"更难排查。
        // ⚠ 若快捷键是在页签体没挂载时按的(`gitRefreshPending`), 就在这里补刷一次 —— 一次性标志, 清掉即止。
        React.useEffect(function () {
          gitRefresh.current = manualRefresh;
          if (gitRefreshPending.current) {
            gitRefreshPending.current = false;
            manualRefresh();
          }
          return function () {
            gitRefresh.current = null;
          };
        });

        /**
         * 工作区数据快照落盘: 只有 **info + status + 当前分支第一页历史**都齐了才写。
         * `history.ref` 必须是 null(见 gitData 的注释): 看过别的分支的历史不进快照。
         *
         * ⚠ 只在数据**真的换了对象**时才推进 `at`: `gitData.set` 每次渲染都跑, 若无条件刷新时间戳,
         *   一次重渲染(开个分支浮窗、拖一下拖柄)就会把"新鲜窗口"一直往后推, 快照永远不过期。
         */
        function publishGitData() {
          if (info === null || status === null || history === null) return;
          if (history.loading === true || history.error != null) return;
          if (history.ref !== null && history.ref !== '') return;
          var key = workspaceKey(info.cwd);
          if (key === null) return;
          var prev = gitData.get(key);
          if (prev !== undefined && prev.status === status && prev.history === history) {
            // ⚠ 列表变了也要推进 at(否则"新开了 worktree"在新鲜窗口内永远不进快照)。
            if (prev.worktrees === wtEntries) return;
          }
          gitData.set(key, {
            cwd: info.cwd,
            info: info,
            status: status,
            history: history,
            worktrees: wtEntries,
            at: Date.now(),
          });
        }

        // 视图状态回写缓存(每次渲染后都写)。重挂时就是靠它恢复的。
        React.useEffect(function () {
          gitViews.set(viewKey, {
            cwd: sessionCwd,
            worktree: worktreePath,
            viewedRef: viewedRef,
            focused: focused,
            splitBefore: splitBefore,
            msgOpen: msgOpen,
          });
          publishGitData();
        });

        React.useEffect(
          function () {
            // 同一会话的重挂(点文件开了 diff 页签又回来): 视图状态与数据都还在, 什么都不做、不重新拉取。
            if (restored !== null) return;
            setViewedRef('');
            setFocused(null);
            setSplitBefore(null);
            setMsgOpen({});
            closeOwnedFloat(); // 切会话 / 切工作区: 详情悬浮面板关掉
            // 数据按**工作区**复用 —— 这一条就是"同工作区切会话不再等一遍"的地方:
            //   还新鲜 → 一个请求都不发(快照已经在屏上了);
            //   旧了   → 快照照样铺在屏上, 后台再取一次, 取到就地回填(不白屏、不阻塞);
            //   没快照 → 从头取(下栏先回到「读取历史…」, 与老行为一致)。
            var decision = gitDataDecision(snapshot, sessionCwd, Date.now(), GIT_DATA_FRESH_MS);
            // 屏上铺的要是**别的工作区**的数据(工作区在原地被换掉、组件没重挂), 那就不是"可以复用", 是"得换掉"。
            var shownKey = info === null ? null : workspaceKey(info.cwd);
            if (shownKey !== null && shownKey !== dataKey) decision = 'load';
            if (decision === 'skip') return;
            if (decision === 'load') setHistory(null);
            handlers.current.reload();
          },
          [sessionCwd],
        );

        // 切换 worktree → 重新取数据。⚠ 挂载那次**不重跑**(由上面那条 sessionCwd effect 负责),
        // 所以用 ref 记住上一次的值: 否则每次挂载都白发一轮请求。
        var prevWorktree = React.useRef(worktreePath);
        React.useEffect(
          function () {
            if (prevWorktree.current === worktreePath) return;
            prevWorktree.current = worktreePath;
            handlers.current.reload();
          },
          [worktreePath],
        );

        // worktree 菜单一打开就**重取列表**: 新开的 worktree(比如刚 `just wt` 建的)要能立刻看到。
        React.useEffect(
          function () {
            if (wtMenuOpen) loadWorktrees();
          },
          [wtMenuOpen],
        );

        // 自动刷新: 仅 turn 结束(true→false)触发, 1s 冷却。
        // 页签不可见时**挂起**、可见时**补刷**(CONTEXT「刷新」的语义), 所以记一个 pending 标记。
        // ⚠ 聚焦一条提交时是**另一种挂起**: 这一条边被吃掉且**不补刷** —— 你看的是不会变的历史,
        //   不该在返回列表时把背后的列表换掉(用户口径); 下一次 turn 结束或手动 ⟳ 才刷。
        var prevRunning = React.useRef(running);
        var lastAuto = React.useRef(0);
        var pendingAuto = React.useRef(false);
        React.useEffect(
          function () {
            var was = prevRunning.current;
            prevRunning.current = running;
            if (!was || running) return;
            if (focused !== null) return; // 聚焦提交: 挂起且不补刷
            if (!visible) {
              pendingAuto.current = true;
              return;
            }
            var now = Date.now();
            if (now - lastAuto.current < 1000) return;
            lastAuto.current = now;
            // 只重取会变的东西: 变更列表与历史首页。提交详情是不可变的, 不必重取。
            handlers.current.reload();
          },
          [running, visible, focused],
        );

        // 补刷: 页签重新可见且挂起过, 就补一次(同样受 1s 冷却约束)。
        React.useEffect(
          function () {
            if (!visible || !pendingAuto.current) return;
            var now = Date.now();
            if (now - lastAuto.current < 1000) return;
            pendingAuto.current = false;
            lastAuto.current = now;
            handlers.current.reload();
          },
          [visible],
        );

        /** ⟳ 手动刷新: 先 sync(fetch, 限时 8s 失败放行), 再 info → status → 历史首页。 */
        function manualRefresh() {
          if (busy) return;
          setBusy(true);
          var payload = dataRoot ? { root: dataRoot } : {};
          var timer = new Promise(function (resolve) {
            window.setTimeout(function () {
              resolve('timeout');
            }, 8000);
          });
          Promise.race([api('sync', payload).catch(function () {
            return null;
          }), timer])
            .then(function () {
              return handlers.current.reload();
            })
            .then(function () {
              setBusy(false);
            })
            .catch(function () {
              setBusy(false);
            });
        }

        /** 每次 git 调用都要带的根: repoRoot 由上一次 status 带回, root 是当前工作区(或选中的 worktree)。 */
        function gitPayload(extra) {
          var payload = { root: dataRoot || undefined };
          if (repoRef.current.repoRoot) payload.repoRoot = repoRef.current.repoRoot;
          for (var key in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, key)) payload[key] = extra[key];
          }
          return payload;
        }

        /**
         * 一次 git 请求 → diff 悬浮面板。变更行(`diff` 路由)与提交里的文件行(`show` 路由)
         * 只有请求不同, 落地方式完全一样, 所以只写一遍。
         */
        function openDiffFrom(path, request) {
          request
            .then(function (res) {
              if (res && res.ok === true) {
                openDiff({
                  path: path,
                  kind: res.kind,
                  hunks: res.hunks || [],
                  text: res.text || '',
                });
              } else {
                openDiff({ path: path, error: (res && res.error) || 'diff-failed' });
              }
            })
            .catch(function (err) {
              openDiff({ path: path, error: String((err && err.message) || err) });
            });
        }

        /** 变更行 → diff 悬浮面板(diff 范围: 工作区相对 HEAD)。 */
        function openChangeDiff(change) {
          openDiffFrom(
            change.path,
            api(
              'diff',
              gitPayload({
                path: change.path,
                status: change.badge,
                from: change.origPath || undefined,
              }),
            ),
          );
        }

        /** 聚焦提交里的文件行 → 该提交相对其父提交的 diff。 */
        function openCommitFileDiff(hash, filePath) {
          openDiffFrom(filePath, api('show', gitPayload({ hash: hash, path: filePath })));
        }

        /**
         * 聚焦一条提交: **下栏整栏**换成"只有这一条"的聚焦态(带返回键)。
         *
         * 进聚焦前先把列表的滚动位置与分栏比例记下来(返回时原样还回去 —— 用户口径: 返回不要重新
         * 刷新, 也别丢掉你翻到哪儿了), 再把下栏放到最大(下栏 60% ⇔ 上栏收到下限), 让这一条有地方站。
         * 详情仍旧走 host 的 `show`, 与"就地展开"时代同一个路由、同一份数据。
         *
         * ⚠ 作者 / 时间 / 短 hash 是**从列表行一起带进来的**, 不靠回头去列表里找: `show` 不回这几个字段,
         *   而列表会被手动 ⟳ 重建 —— 那条提交不在前 50 条时, "回头看列表"会查到空, 头部就白了。
         */
        function focusCommit(commit) {
          var pane = paneBottomRef.current;
          scrollBefore.current = pane === null ? 0 : pane.scrollTop;
          setSplitBefore(split);
          setFocused({
            hash: commit.hash,
            short: commit.short,
            author: commit.author,
            at: commit.at,
            loading: true,
          });
          setSplit(GIT_SPLIT_MIN);
          api('show', gitPayload({ hash: commit.hash }))
            .then(function (res) {
              setFocused(function (prev) {
                if (prev === null || prev.hash !== commit.hash) return prev; // 已经返回列表了
                if (!res || res.ok !== true) {
                  return focusWith(prev, {
                    loading: false,
                    error: (res && res.error) || 'show-failed',
                  });
                }
                return focusWith(prev, { loading: false, detail: res });
              });
            })
            .catch(function (err) {
              setFocused(function (prev) {
                if (prev === null || prev.hash !== commit.hash) return prev;
                return focusWith(prev, {
                  loading: false,
                  error: String((err && err.message) || err),
                });
              });
            });
        }

        /** 聚焦态的一次不可变更新(复制 + 打补丁): React 要新对象才会重渲染。 */
        function focusWith(prev, patch) {
          var next = {};
          for (var key in prev) {
            if (Object.prototype.hasOwnProperty.call(prev, key)) next[key] = prev[key];
          }
          for (var name in patch) {
            if (Object.prototype.hasOwnProperty.call(patch, name)) next[name] = patch[name];
          }
          return next;
        }

        /**
         * 返回提交历史列表: **不重新拉取、也不补刷**(列表本来就还在, 只是被聚焦态顶掉了),
         * 滚动位置交给上面那条 layout effect 还原(只还原**这一次** —— 见那条注释)。
         * 聚焦期间自己拖过拖柄(`splitBefore` 已被清空)就保留那个新值 —— 不弹回进聚焦前的比例。
         */
        function exitFocus() {
          if (splitBefore !== null) {
            setSplit(splitBefore);
            setSplitBefore(null);
          }
          restoreScroll.current = true;
          setFocused(null);
        }

        /**
         * 展开 / 收起一条提交的**说明全文**(折叠态只给两行, 见 CommitMessage)。
         * 只影响这一条提交, 跟"聚焦到这条提交"是两件事。
         */
        function toggleMessage(hash) {
          setMsgOpen(function (prev) {
            var next = {};
            for (var key in prev) {
              if (Object.prototype.hasOwnProperty.call(prev, key)) next[key] = prev[key];
            }
            if (prev[hash] === true) delete next[hash];
            else next[hash] = true;
            return next;
          });
        }

        /** 切「查看分支」: 只决定看哪个分支的历史, 不动工作区的实际分支。 */
        function pickBranch(name) {
          setMenuOpen(false);
          setViewedRef(name);
          setHistory(null);
          loadHistory(name, 0);
        }

        /**
         * 拖中间那条拖柄调整上下两栏的比例(做法与终端抽屉的上缘拖柄一致: move/up 挂 document)。
         * 比例按正文容器的实际高度算, 所以右栏宽度、窗口高度变化都不影响手感。
         */
        function onSplitDown(ev) {
          var el = bodyRef.current;
          if (el === null) return;
          ev.preventDefault();
          var rect = el.getBoundingClientRect();
          var final = null;
          function onMove(e) {
            if (rect.height <= 0) return;
            final = Math.min(
              GIT_SPLIT_MAX,
              Math.max(GIT_SPLIT_MIN, ((e.clientY - rect.top) / rect.height) * 100),
            );
            setSplit(final);
          }
          function onUp() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            if (final !== null) {
              writeGitSplit(final);
              // 聚焦期间自己拖过 = 你在表达新偏好: 返回时不再弹回进聚焦前那个比例(见 §14)。
              setSplitBefore(null);
            }
          }
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        }

        /** 双击拖柄: 回到默认的 3/4(同样是"重新表态", 于是聚焦返回时不再还原)。 */
        function resetSplit() {
          setSplit(GIT_SPLIT_DEFAULT);
          writeGitSplit(GIT_SPLIT_DEFAULT);
          setSplitBefore(null);
        }

        // ---- 头部 ----
        var current = status ? status.current : null;
        var detached = !!(status && status.detached);
        var branchLabel =
          current || (detached ? '(分离 HEAD)' : status && status.initial ? '(无提交)' : '—');

        // ---- worktree 切换器(仓库里真有别的 worktree 时才露面) ----
        /** 当前正在看的那份工作区: 选中项优先; 没选就是 host 解析出来的仓库根。 */
        var wtCurrentKey = workspaceKey(worktreePath || (info ? info.repoRoot : null));
        var wtCurrent = null;
        for (var wtIdx = 0; wtIdx < wtEntries.length; wtIdx += 1) {
          if (workspaceKey(wtEntries[wtIdx].path) === wtCurrentKey) {
            wtCurrent = wtEntries[wtIdx];
            break;
          }
        }
        var wtAway = wtCurrent !== null && wtCurrent.main !== true;
        var wtLabel =
          wtCurrent === null
            ? worktreePath === null
              ? '主仓'
              : 'worktree'
            : wtCurrent.main === true
              ? '主仓'
              : wtCurrent.name;
        var wtVisible = worktreePath !== null || wtEntries.length > 1;

        var head = h(
          'div',
          { className: 'fge-head' },
          h(
            'button',
            {
              type: 'button',
              className: 'fge-branch',
              ref: branchAnchorRef,
              title: '本地 / 远程分支: 点一个查看它的提交历史与 diff(不改工作区的实际分支)',
              'aria-expanded': menuOpen ? 'true' : 'false',
              onClick: function () {
                setMenuOpen(function (open) {
                  return !open;
                });
              },
            },
            h(primitives.IconBranchOutline16, { size: 14 }),
            h('span', { className: 'fge-branch-name' }, branchLabel),
            h(primitives.IconChevronDownOutline14, {
              size: 12,
              className: 'fge-branch-caret',
            }),
          ),
          status && (status.ahead > 0 || status.behind > 0)
            ? h(
                'span',
                { className: 'fge-ab', title: '相对上游 ahead/behind' },
                status.ahead > 0 ? '↑' + String(status.ahead) : null,
                status.behind > 0 ? '↓' + String(status.behind) : null,
              )
            : null,
          // worktree 切换器: 只有仓库里存在别的 worktree 时才出现(平时头部与以前**一模一样**)。
          // 看的是"哪份工作区", 与左边那颗"看哪个分支"是两件事, 所以分成两个按钮。
          wtVisible
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'fge-wt',
                  ref: wtAnchorRef,
                  'data-away': wtAway ? '1' : undefined,
                  title: '这份仓库的多个 worktree(工作树): 点一个就**看它**的分支与变更(不动任何 checkout)',
                  'aria-label': '切换 worktree',
                  'aria-expanded': wtMenuOpen ? 'true' : 'false',
                  onClick: function () {
                    setWtMenuOpen(function (open) {
                      return !open;
                    });
                  },
                },
                h(primitives.IconFolderOpenOutline16, { size: 13 }),
                h('span', { className: 'fge-wt-name' }, wtLabel),
                h(primitives.IconChevronDownOutline14, { size: 12, className: 'fge-branch-caret' }),
              )
            : null,
          // 这里**不放** `.fge-spacer`, worktree 那颗按钮也**不是**弹性项: 分支按钮自己就是那唯一的
          // 弹性项(flex:1), 多一个弹性项会把空白平分, 按钮就长不到 ⟳ 前面了。
          // 刷新键: 官方 `IconRefreshOutline14`(SVG) —— 不再用 `⟳` 字形, 也不再在忙时换成 `…`
          // (忙 = `disabled`, 图标由 `.fge-refresh[disabled] svg` 转起来当进度提示)。
          // ⚠ 图标按钮**没有文字**, 所以补一枚 `aria-label`(原来那个 `⟳` 至少还是个字符, 现在什么都没了)。
          h(
            'button',
            {
              className: 'fge-btn fge-refresh',
              title: '刷新(先 fetch --all --prune)',
              'aria-label': '刷新',
              disabled: busy,
              onClick: manualRefresh,
            },
            h(primitives.IconRefreshOutline14, { size: 14 }),
          ),
        );

        // ---- 变更列表(按目录归类) ----
        var changes = status ? status.changes : [];
        var changeRows = [];
        if (status === null) {
          changeRows.push(h('div', { key: 'loading', className: 'fge-empty' }, '读取中…'));
        } else if (changes.length === 0) {
          changeRows.push(h('div', { key: 'clean', className: 'fge-empty' }, '(工作区干净)'));
        } else {
          changeRows = treeRows.root(
            compactPathTree(
              buildPathTree(changes, function (change) {
                return change.path;
              }),
            ),
            'c:',
            function (file, pos) {
              var change = file.item;
              return treeRows.fileRow(pos, {
                key: 'c:f:' + file.path,
                title: change.origPath ? change.path + ' ← ' + change.origPath : change.path,
                leading: h('span', { className: 'fge-badge', 'data-b': change.badge }, change.badge),
                name: file.name,
                onClick: function () {
                  openChangeDiff(change);
                },
              });
            },
          );
        }

        var changesSection = h(
          'div',
          null,
          h(
            'div',
            { className: 'fge-section' },
            '变更列表',
            changes.length > 0 ? h('span', { className: 'fge-chip' }, String(changes.length)) : null,
          ),
          error !== null && status === null
            ? h('div', { className: 'fge-empty' }, '非 git 工作区或 git 不可用(' + error + ')')
            : h('div', null, changeRows),
        );

        // ---- 提交历史 ----
        var branches = status && Array.isArray(status.branches) ? status.branches : [];
        /** 本地 / 远程两组; 远程再按 remote 名分成子树(展示用"树", 点击看该分支的历史)。 */
        var branchTree = { local: [], remotes: [] };
        var remoteIndexOf = {};
        for (var bi = 0; bi < branches.length; bi += 1) {
          var branch = branches[bi];
          if (!branch.remote) {
            branchTree.local.push({ full: branch.name, short: branch.name, remote: null });
            continue;
          }
          var slash = branch.name.indexOf('/');
          var remoteName = slash === -1 ? branch.name : branch.name.slice(0, slash);
          var shortName = slash === -1 ? branch.name : branch.name.slice(slash + 1);
          if (remoteIndexOf[remoteName] === undefined) {
            remoteIndexOf[remoteName] = { remote: remoteName, branches: [] };
            branchTree.remotes.push(remoteIndexOf[remoteName]);
          }
          remoteIndexOf[remoteName].branches.push({
            full: branch.name,
            short: shortName,
            remote: remoteName,
          });
        }

        /** 小浮窗里的一行分支。 */
        function branchRow(item) {
          var isCurrent = current !== null && item.full === current;
          var isViewed = viewedRef !== '' && viewedRef === item.full;
          var mark = isCurrent ? '当前' : isViewed ? '查看中' : '';
          return h(
            'div',
            {
              key: 'br:' + item.full,
              className: 'fge-branch-item' + (item.remote === null ? '' : ' fge-branch-sub'),
              'data-viewed': isViewed ? '1' : undefined,
              title: item.full,
              onClick: function () {
                pickBranch(item.full);
              },
            },
            h('span', { className: 'fge-branch-name' }, item.short),
            h('span', { className: 'fge-branch-mark' }, mark),
          );
        }

        var branchMenu = null;
        if (menuOpen) {
          var menuRows = [];
          menuRows.push(h('div', { key: 'g:local', className: 'fge-branch-group' }, '本地分支'));
          if (branchTree.local.length === 0) {
            menuRows.push(h('div', { key: 'g:local:none', className: 'fge-branch-item' }, '(无)'));
          }
          for (var li = 0; li < branchTree.local.length; li += 1) {
            menuRows.push(branchRow(branchTree.local[li]));
          }
          menuRows.push(h('div', { key: 'g:remote', className: 'fge-branch-group' }, '远程分支'));
          if (branchTree.remotes.length === 0) {
            menuRows.push(h('div', { key: 'g:remote:none', className: 'fge-branch-item' }, '(无)'));
          }
          for (var ri = 0; ri < branchTree.remotes.length; ri += 1) {
            var group = branchTree.remotes[ri];
            menuRows.push(
              h('div', { key: 'g:r:' + group.remote, className: 'fge-branch-group' }, group.remote),
            );
            for (var gi = 0; gi < group.branches.length; gi += 1) {
              menuRows.push(branchRow(group.branches[gi]));
            }
          }
          branchMenu = h(
            'div',
            {
              className: 'fge-branch-menu',
              ref: branchMenuRef,
              role: 'listbox',
              // 面板先渲染才能被量到(useAnchoredPosition 量的是面板自己的 offsetWidth):
              // 位置未算出时先藏起来, 布局 effect 跑完就可见 —— 中间不会有闪动。
              style: {
                left: branchMenuPos === null ? 0 : branchMenuPos.left,
                top: branchMenuPos === null ? 0 : branchMenuPos.top,
                visibility: branchMenuPos === null ? 'hidden' : 'visible',
              },
            },
            menuRows,
          );
        }

        // ---- worktree 小浮窗(与分支那个共用菜单样式, 只有触发按钮不同) ----
        var wtMenu = null;
        if (wtMenuOpen) {
          var wtRows = [];
          wtRows.push(h('div', { key: 'wt:g', className: 'fge-branch-group' }, 'worktree(工作树)'));
          for (var wr = 0; wr < wtEntries.length; wr += 1) {
            var wtEntry = wtEntries[wr];
            // 目录已被删 / prunable 的不列出来: 选了 host 只会从那个不存在的路径向上回落到主仓。
            if (wtEntry.prunable === true) continue;
            var wtIsCurrent = workspaceKey(wtEntry.path) === wtCurrentKey;
            wtRows.push(
              h(
                'div',
                {
                  key: 'wt:' + wtEntry.path,
                  className: 'fge-branch-item' + (wtEntry.main === true ? '' : ' fge-branch-sub'),
                  'data-current': wtIsCurrent ? '1' : undefined,
                  title: wtEntry.path,
                  onClick: (function (row) {
                    return function () {
                      pickWorktree(row);
                    };
                  })(wtEntry),
                },
                h('span', { className: 'fge-branch-name' }, wtEntry.main === true ? '主仓' : wtEntry.name),
                h(
                  'span',
                  { className: 'fge-branch-mark' },
                  wtIsCurrent
                    ? '当前'
                    : wtEntry.branch !== null
                      ? wtEntry.branch
                      : wtEntry.detached === true
                        ? '分离 HEAD'
                        : '',
                ),
              ),
            );
          }
          if (wtRows.length === 1) {
            wtRows.push(h('div', { key: 'wt:none', className: 'fge-branch-item' }, '(只有主仓)'));
          }
          wtMenu = h(
            'div',
            {
              className: 'fge-branch-menu',
              ref: wtMenuRef,
              role: 'listbox',
              style: {
                left: wtMenuPos === null ? 0 : wtMenuPos.left,
                top: wtMenuPos === null ? 0 : wtMenuPos.top,
                visibility: wtMenuPos === null ? 'hidden' : 'visible',
              },
            },
            wtRows,
          );
        }

        var historyRows = [];
        if (history === null || history.loading) {
          historyRows.push(h('div', { key: 'loading', className: 'fge-empty' }, '读取历史…'));
        } else if (history.error) {
          historyRows.push(
            h('div', { key: 'err', className: 'fge-empty' }, '历史失败(' + history.error + ')'),
          );
        } else if (history.commits.length === 0) {
          historyRows.push(h('div', { key: 'none', className: 'fge-empty' }, '(无提交)'));
        } else {
          for (var hi = 0; hi < history.commits.length; hi += 1) {
            var commit = history.commits[hi];
            historyRows.push(
              h(
                'div',
                {
                  key: 'h:' + commit.hash,
                  className: 'fge-commit',
                  title: '点击聚焦到这条提交',
                  onClick: (function (row) {
                    return function () {
                      focusCommit(row);
                    };
                  })(commit),
                },
                h('div', { className: 'fge-commit-sub' }, commit.subject),
                h(
                  'div',
                  { className: 'fge-commit-meta' },
                  h(
                    'span',
                    { className: 'fge-commit-meta-text' },
                    commit.author + ' · ' + formatTime(commit.at),
                  ),
                  h(HashChip, { hash: commit.hash, short: commit.short }),
                ),
              ),
            );
          }
          if (history.done === false) {
            historyRows.push(
              h(
                'div',
                {
                  key: 'more',
                  className: 'fge-row',
                  onClick: function () {
                    loadHistory(history.ref, history.commits.length);
                  },
                },
                h('span', { className: 'fge-empty' }, '加载更多…'),
              ),
            );
          }
        }

        var historySection = h(
          'div',
          null,
          h(
            'div',
            { className: 'fge-section' },
            '提交历史',
            h(
              'span',
              { className: 'fge-chip', title: '正在查看哪个分支的历史(点头部的分支按钮可换)' },
              '查看 ' + (viewedRef || current || '当前分支'),
            ),
          ),
          h('div', null, historyRows),
        );

        // ---- 聚焦提交(下栏整栏只有这一条) ----
        //
        // 与列表态**共用同一个滚动容器**(下栏那个 .fge-pane), 所以进出聚焦时滚动位置由上面那条
        // layout effect 摆正。返回键在**左**、`作者 · 时间` 居中可截断、hash 胶囊在**右**(两头不被截断)。
        var focusSection = null;
        if (focused !== null) {
          var focusRows = [];
          if (focused.loading === true) {
            focusRows.push(h('div', { key: 'l', className: 'fge-empty' }, '读取提交…'));
          } else if (focused.error !== undefined) {
            focusRows.push(
              h('div', { key: 'e', className: 'fge-empty' }, '提交失败(' + focused.error + ')'),
            );
          } else {
            var focusDetail = focused.detail;
            focusRows.push(
              h(CommitMessage, {
                key: 'm',
                text: focusDetail.message || '(无提交说明)',
                open: msgOpen[focused.hash] === true,
                onToggle: (function (hash) {
                  return function () {
                    toggleMessage(hash);
                  };
                })(focused.hash),
              }),
            );
            var focusFiles = Array.isArray(focusDetail.files) ? focusDetail.files : [];
            if (focusDetail.kind === 'merge') {
              focusRows.push(
                h(
                  'div',
                  { key: 'merge', className: 'fge-empty' },
                  'merge 提交只显示说明, 不展开文件',
                ),
              );
            } else if (focusFiles.length === 0) {
              focusRows.push(h('div', { key: 'nf', className: 'fge-empty' }, '(无文件变更)'));
            } else {
              // 文件清单: 与变更列表同一套目录归类 + 层级线, 深度从 0 起(这条提交自己就是根)。
              focusRows = focusRows.concat(
                treeRows.root(
                  compactPathTree(
                    buildPathTree(focusFiles, function (file) {
                      return file.path;
                    }),
                  ),
                  'f:',
                  (function (hash) {
                    return function (file, pos) {
                      var entry = file.item;
                      return treeRows.fileRow(pos, {
                        key: 'f:' + file.path,
                        title: entry.path,
                        leading: h(
                          'span',
                          { className: 'fge-numstat' },
                          h(
                            'b',
                            { className: 'fge-dl-add' },
                            entry.adds === null ? '·' : '+' + String(entry.adds),
                          ),
                          h(
                            'b',
                            { className: 'fge-dl-del' },
                            entry.dels === null ? '·' : '−' + String(entry.dels),
                          ),
                        ),
                        name: file.name,
                        onClick: function () {
                          openCommitFileDiff(hash, entry.path);
                        },
                      });
                    };
                  })(focused.hash),
                ),
              );
            }
          }
          focusSection = h(
            'div',
            null,
            h(
              'div',
              { className: 'fge-section' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'fge-btn fge-back',
                  title: '返回提交历史(Esc)',
                  onClick: exitFocus,
                },
                h(primitives.IconChevronLeftOutline14, { size: 12 }),
                '返回',
              ),
              h(
                'span',
                { className: 'fge-focus-meta' },
                focused.author === undefined
                  ? ''
                  : focused.author + ' · ' + formatTime(focused.at),
              ),
              h(HashChip, {
                hash: focused.hash,
                short: focused.short === undefined ? focused.hash.slice(0, 7) : focused.short,
              }),
            ),
            focusRows,
          );
        }

        return h(
          'div',
          { className: 'fge-root' },
          head,
          branchMenu,
          wtMenu,
          // 正文 = 上下两栏: 上栏**变更列表 / 当前 diff**(默认 3/4), 下栏**提交历史**。两栏各自滚动。
          h(
            'div',
            { className: 'fge-body', ref: bodyRef },
            h(
              'div',
              {
                className: 'fge-pane',
                style: {
                  flexBasis: String(split) + '%',
                  flexGrow: 0,
                  flexShrink: 0,
                },
              },
              changesSection,
            ),
            h('div', {
              className: 'fge-grip',
              title: '拖动调整两栏高度(双击回到 3/4)',
              onMouseDown: onSplitDown,
              onDoubleClick: resetSplit,
            }),
            h(
              'div',
              {
                className: 'fge-pane fge-pane-bottom',
                ref: paneBottomRef,
                // 聚焦态整栏一层极淡的品牌色底(容器感), 见 §14。
                'data-focus': focused === null ? undefined : '1',
              },
              focused === null ? historySection : focusSection,
            ),
          ),
        );
      }

      function GitTabTitle() {
        return h('span', null, 'Git');
      }

      // ---- 终端抽屉(composer 座里的抽屉舌 + 向上展开) ----

      function TerminalDock(props) {
        var sessionId = props.sessionId;
        var useSessions = props.useSessions;
        var open = useDrawerOpen();
        var sessionCwd = useSessionCwd(useSessions, sessionId);
        var root = sessionCwd || '';
        var pctPair = React.useState(function () {
          return readTermHeight(root);
        });
        var pct = pctPair[0];
        var setPct = pctPair[1];
        /**
         * 「选中即复制」开关(条右侧那枚)。**整机一个偏好**, 不按工作区/会话分 —— 与抽屉高度那种
         * "每个工作区各记各的"不一样。默认开。
         */
        var copyPair = React.useState(readTermCopy);
        var copyOn = copyPair[0];
        var setCopyOn = copyPair[1];

        React.useEffect(
          function () {
            setPct(readTermHeight(root));
          },
          [root],
        );

        // 切工作区: 上一个工作区的详情悬浮面板关掉(终端本身按工作区常驻, 不动)。
        var prevCwd = React.useRef(sessionCwd);
        React.useEffect(
          function () {
            if (prevCwd.current !== sessionCwd) {
              prevCwd.current = sessionCwd;
              closeOwnedFloat();
            }
          },
          [sessionCwd],
        );

        // Esc 焦点分流: 焦点在终端内 → 交给终端; 否则关闭抽屉。
        React.useEffect(
          function () {
            if (!open) return undefined;
            function onKey(ev) {
              if (ev.key !== 'Escape') return;
              var el = document.activeElement;
              var host = document.getElementById('fge-term-host');
              if (host !== null && el !== null && host.contains(el)) return;
              setDrawer(false);
            }
            document.addEventListener('keydown', onKey, true);
            return function () {
              document.removeEventListener('keydown', onKey, true);
            };
          },
          [open],
        );

        function onGripDown(ev) {
          ev.preventDefault();
          var startY = ev.clientY;
          var startPct = pct;
          function onMove(e) {
            var deltaPct = ((startY - e.clientY) / window.innerHeight) * 100;
            var next = Math.min(TERM_MAX_PCT, Math.max(TERM_MIN_PCT, startPct + deltaPct));
            setPct(next);
          }
          function onUp() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            setPct(function (final) {
              writeTermHeight(root, final);
              return final;
            });
          }
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        }

        if (!open) {
          return h(
            'button',
            {
              type: 'button',
              className: 'fge-tongue',
              title: '展开终端抽屉',
              'aria-label': '展开终端抽屉',
              onClick: function () {
                setDrawer(true);
              },
            },
            h(primitives.IconChevronUpOutline14, { size: 14 }),
          );
        }

        return h(
          'div',
          { className: 'fge-term', style: { height: String(pct) + 'vh' } },
          h('div', {
            className: 'fge-term-grip',
            onMouseDown: onGripDown,
            title: '拖动调整高度',
          }),
          // 条 = Windows Terminal 观感的「标题条」: 点条空白处收起(不杀进程), 与点页签上的 `×` 等价;
          // 页签里**恒定只有当前工作区这一枚**(外观档, 不引入多终端, 见 CONTEXT.md「终端标题条」)。
          // 条内按钮上的点击要 stopPropagation, 否则会连带收起。
          h(
            'div',
            {
              className: 'fge-term-strip',
              title: '点击收起(不杀进程)',
              onClick: function () {
                setDrawer(false);
              },
            },
            h(
              'div',
              {
                className: 'fge-term-tab',
                title: root || '(无工作区)',
              },
              h('span', { className: 'fge-term-tab-glyph' }, '>_'),
              h('span', { className: 'fge-term-tab-title' }, root || '(无工作区)'),
              h(
                'button',
                {
                  className: 'fge-term-tab-close',
                  title: '收起(不杀进程)',
                  'aria-label': '收起终端抽屉',
                  onClick: function (ev) {
                    ev.stopPropagation();
                    setDrawer(false);
                  },
                },
                '×',
              ),
            ),
            h('span', { className: 'fge-spacer' }),
            // 「选中即复制」开关: 放在条右侧、`■` 左边(用户口径)。
            // ⚠ `role="switch"` + `aria-checked` 而不是靠样式表达状态; 关掉只停**自动**那条,
            //   Alt+C 兜底照旧(它跟开关无关)。
            h(
              'button',
              {
                type: 'button',
                className: 'fge-term-switch',
                role: 'switch',
                'aria-checked': copyOn ? 'true' : 'false',
                'aria-label': '终端选中即复制',
                title: copyOn
                  ? '选中即复制: 开(选中就把文字放进剪贴板, 点一下关掉)'
                  : '选中即复制: 关(点一下打开; Alt+C 复制始终可用)',
                onClick: function (ev) {
                  ev.stopPropagation();
                  setCopyOn(function (prev) {
                    var next = prev !== true;
                    writeTermCopy(next);
                    return next;
                  });
                },
              },
              h(
                'span',
                { className: 'fge-term-switch-track' },
                h('span', { className: 'fge-term-switch-knob' }),
              ),
              h('span', { className: 'fge-term-switch-label' }, '选中复制'),
            ),
            h(
              'button',
              {
                className: 'fge-btn fge-term-glyph fge-term-kill',
                title: '结束这个终端的进程',
                'aria-label': '结束终端进程',
                onClick: function (ev) {
                  ev.stopPropagation();
                  killTerminal(sessionId);
                },
              },
              // `■` 原来是个**文字字形**: 同一个码位在不同平台/字体回退下大小与粗细都不一样
              // (与刷新键那个 `⟳` 同一个毛病), 换成官方 SVG 图标 —— `IconStopFill16` 是实心方块,
              // 语义与 `■` 完全一致, 取色走 `currentColor`(危险色由 .fge-term-kill 给)。
              h(primitives.IconStopFill16, { size: 12 }),
            ),
          ),
          h(
            'div',
            { className: 'fge-term-body', id: 'fge-term-host' },
            root === ''
              ? h('div', { className: 'fge-empty' }, '等待会话工作区…')
              : h(TerminalView, {
                  sessionId: sessionId,
                  visible: open,
                  copyOnSelect: copyOn,
                }),
          ),
        );
      }

      // ---- 注册 ----

      ensureStyles();

      ctx.effect(
        function () {
          return ctx.sidebarRightTabs.register({
            id: GIT_ID,
            kind: GIT_KIND,
            // extension 档: 声明的 kind 是全新的, 不与任何 builtin 争位。
            priority: 'extension',
            title: function () {
              return 'Git';
            },
            guide: [
              {
                order: 60,
                title: function () {
                  return 'Git';
                },
                description: function () {
                  return '变更列表 / 提交历史 / diff 详情悬浮面板';
                },
              },
            ],
          });
        },
        'fge: git tab type',
      );

      ctx.effect(
        function () {
          return ctx.sidebarRightTabs.register({
            id: DIFF_ID,
            kind: DIFF_KIND,
            priority: 'extension',
            title: function () {
              return 'diff';
            },
          });
        },
        'fge: diff tab type',
      );

      ctx.effect(function () {
        return slots.inject('sidebar.right.pane.tab', function () {
          return slots.register({ name: 'sidebar.right.pane.tab', key: GIT_ID }, GitTabBody);
        });
      }, 'fge: git tab body');

      ctx.effect(function () {
        return slots.inject('sidebar.right.pane.tab.title', function () {
          return slots.register({ name: 'sidebar.right.pane.tab.title', key: GIT_ID }, GitTabTitle);
        });
      }, 'fge: git tab title');

      ctx.effect(function () {
        return slots.inject('sidebar.right.pane.tab', function () {
          return slots.register({ name: 'sidebar.right.pane.tab', key: DIFF_ID }, DiffTabBody);
        });
      }, 'fge: diff tab body');

      ctx.effect(function () {
        return slots.inject('sidebar.right.pane.tab.title', function () {
          return slots.register({ name: 'sidebar.right.pane.tab.title', key: DIFF_ID }, DiffTabTitle);
        });
      }, 'fge: diff tab title');

      // 影子替换官方文档页签的芯片: 拿到 tabId 才能把官方正文页签浮起来。
      ctx.effect(function () {
        return slots.inject('sidebar.right.pane.tab.title', function () {
          return slots.register(
            { name: 'sidebar.right.pane.tab.title', key: DOC_ID, priority: DOC_PRIORITY },
            DocTitle,
          );
        });
      }, 'fge: doc tab title shadow');

      ctx.effect(function () {
        return slots.inject('conversation.composer.dock', function () {
          return slots.register(
            { name: 'conversation.composer.dock', id: 'fge-terminal', order: 50 },
            TerminalDock,
          );
        });
      }, 'fge: terminal dock');

      // 空渲染的座位, 只用来给每个会话铺一次右侧栏默认页签(见 seedRightbar)。
      ctx.effect(function () {
        return slots.inject('conversation.composer.dock', function () {
          return slots.register(
            { name: 'conversation.composer.dock', id: 'fge-session-seed', order: 40 },
            SessionSeed,
          );
        });
      }, 'fge: rightbar default tab');

      // 右栏宽度: 启动时落上次拖动过的值, 再把官方那根拖柄接管过来(钳在 [200px, 15vw], 见 attachRightbarDrag)。
      ctx.effect(
        function () {
          var stored = readRightbarWidth();
          if (stored !== null) applyRightbarWidth(stored);
          return attachRightbarDrag();
        },
        'fge: rightbar width drag',
      );

      // 终端配色跟主题走(见 terminalTheme): 官方主题一换, 已经开着的 xterm 就地更新, 不必重开抽屉。
      ctx.effect(
        function () {
          function onTheme(snapshot) {
            lastThemeSnapshot = snapshot;
            applyTerminalTheme(snapshot);
          }
          var off = ctx.on('theme/change', onTheme);
          return function () {
            if (typeof off === 'function') off();
          };
        },
        'fge: terminal follows theme',
      );

      // 记「用户动手之前右栏选中的那一格」: 浮起详情之后 focus 回去, 右栏不会自己跳走(见 restoreUserTab)。
      // 捕获阶段: 要在官方正文里的点击处理之前读到页签条的选中态。
      ctx.effect(
        function () {
          document.addEventListener('click', rememberUserTab, true);
          return function () {
            document.removeEventListener('click', rememberUserTab, true);
          };
        },
        'fge: remember the user tab before a detail opens',
      );

      // 右栏页签的左右切换: **Alt+J 左一格, Alt+L 右一格**(用户口径; 到边就什么都不做, 不环绕)。
      //
      // 为什么走 DOM 而不是问 `sidebarRight.active()`: 页签条上真正选中的那一格只有 DOM 说得准
      // (`[data-dockkit-tab][aria-selected="true"]`, 与 rememberUserTab 同一条契约), 而且这样拿到的是
      // **视觉上的左右邻居** —— 页签条里还有别的插件 / 官方的格子时也照样成立。
      //
      // ⚠ 焦点在终端里时让给终端(与 Esc 的分流一致: 终端里的键归终端); 右栏收起时不切(切了也看不见)。
      // ⚠ 输入框里**不禁用**: Alt+J/L 不会输入任何字符, 而在 composer 里打字时想切页签恰恰是最常见的场景。
      //   已确认官方没有任何 Alt+J / Alt+L 绑定(官方那几个 `altKey: "any"` 全在 ArrowUp/ArrowDown/Enter 上)。
      ctx.effect(
        function () {
          /** 当前右栏页签条里的格子(按 DOM 顺序 = 视觉左右顺序)。找不到就返回空。 */
          function stripTabs() {
            if (typeof document === 'undefined') return [];
            var active = document.querySelector(
              '[data-sidebar-right-panel] [data-dockkit-tab][aria-selected="true"]',
            );
            if (active === null || typeof active.closest !== 'function') return [];
            var strip = active.closest('[data-dockkit-strip]');
            if (strip === null) return [];
            return Array.prototype.slice.call(strip.querySelectorAll('[data-dockkit-tab]'));
          }

          function onKey(ev) {
            if (!ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
            var step =
              ev.key === 'j' || ev.key === 'J' ? -1 : ev.key === 'l' || ev.key === 'L' ? 1 : 0;
            if (step === 0) return;
            // 焦点在终端里 → 这一按归终端。
            var active = typeof document === 'undefined' ? null : document.activeElement;
            var host = typeof document === 'undefined' ? null : document.getElementById('fge-term-host');
            if (host !== null && active !== null && host.contains(active)) return;
            // 右栏收起着 → 不切(切了也看不见, 收起来时那几格根本不在视野里)。
            if (document.querySelector('[data-rightbar-collapsed]') !== null) return;
            var tabs = stripTabs();
            var index = -1;
            for (var i = 0; i < tabs.length; i += 1) {
              if (tabs[i].getAttribute('aria-selected') === 'true') {
                index = i;
                break;
              }
            }
            var next = tabNeighbor(index, tabs.length, step);
            if (next === -1) return; // 到边了 —— 不做无限切换
            var id = tabs[next].getAttribute('data-dockkit-tab');
            if (typeof id !== 'string' || id === '') return;
            ev.preventDefault();
            try {
              ctx.sidebarRight.focus(id);
            } catch (err) {
              // 座位瞬时缺位: 与 restoreUserTab 同样的容错, 不影响别的东西。
            }
          }

          document.addEventListener('keydown', onKey, true);
          return function () {
            document.removeEventListener('keydown', onKey, true);
          };
        },
        'fge: alt+j / alt+l switch right sidebar tabs',
      );

      // git 树刷新: **Alt+Ctrl+R**(用户口径)。与页签上那枚 `⟳` 走**同一条** `manualRefresh`
      // (先 sync/fetch, 再 info → status → 历史首页), 不是另写一套刷新逻辑。
      //
      // 为什么带 Ctrl 而不是光 Alt: 光 Alt+R 在终端里是 readline 的 revert-line, 而**展开抽屉后焦点就在
      // 终端里**(见「终端自动聚焦」), 那时它会被我们主动让给终端 —— 用户看到的就是"按了没反应"(实测就是这么
      // 翻的车)。加上 Ctrl 之后终端侧没有对应绑定, 于是这一按可以**从任何焦点**触发, 不再需要那道门。
      // ⚠ 挂在 **window** 的捕获阶段(不是 document): 官方自己的快捷键也走捕获阶段, window 比 document 更靠前,
      //   万一官方先把它当别的用了, 我们仍然收得到。
      // ⚠ 认下就 `preventDefault` + `stopPropagation`: 既不让浏览器/官方再拿它做别的, 也不让它落到 xterm
      //   变成一串发给 PTY 的字节(它现在连终端焦点也不放过了, 必须自己吃掉)。
      // ⚠ 输入框里**不禁用**(与 Alt+J/L 同一口径): 这组键不输入任何字符, 而在 composer 里打字时想刷新很常见;
      //   已确认官方没有 Alt+R / Alt+Ctrl+R 绑定(官方那几个 `altKey: "any"` 全在 ArrowUp / ArrowDown / Enter 上)。
      // ⚠ **页签体没挂载**(右栏收起 / 当前那格不是 Git)时不干等: 切到 Git 页签 + 记一笔 `gitRefreshPending`,
      //   它挂载时立刻刷一次 —— 否则这条快捷键只在"正看着 git"时才灵。
      ctx.effect(
        function () {
          function onKey(ev) {
            if (!ev.altKey || !ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
            if (!(ev.key === 'r' || ev.key === 'R' || ev.code === 'KeyR')) return;
            ev.preventDefault();
            ev.stopPropagation();
            var run = gitRefresh.current;
            if (typeof run === 'function') {
              run();
              return;
            }
            // 页签体没挂载: 记一笔并切过去, 它挂载时自己刷(见 gitRefreshPending)。
            gitRefreshPending.current = true;
            try {
              ctx.sidebarRight.focus(GIT_ID);
            } catch (err) {
              // 座位瞬时缺位: 与 restoreUserTab / Alt+J 同款容错, 不影响别的东西。
            }
          }

          window.addEventListener('keydown', onKey, true);
          return function () {
            window.removeEventListener('keydown', onKey, true);
          };
        },
        'fge: alt+ctrl+r refresh git tree',
      );

      // Esc 关掉本插件浮起的详情; 悬浮面板没开时才轮到"从聚焦提交返回列表"。
      // 分层与本插件的其它逻辑一致:
      //   1. 焦点在终端里 → Esc 归终端(与终端抽屉自己的 keydown 一致), 什么都不做;
      //   2. 浮着的 diff 面板优先 —— 这一按只关它, 再按一次才返回列表;
      //   3. 都没有 → 无事发生。
      ctx.effect(
        function () {
          function onKey(ev) {
            if (ev.key !== 'Escape') return;
            var host =
              typeof document === 'undefined' ? null : document.getElementById('fge-term-host');
            var active = typeof document === 'undefined' ? null : document.activeElement;
            if (host !== null && active !== null && host.contains(active)) return;
            if (floatTarget !== null) {
              closeOwnedFloat();
              return;
            }
            if (focusEsc.current !== null) focusEsc.current();
          }
          document.addEventListener('keydown', onKey, true);
          return function () {
            document.removeEventListener('keydown', onKey, true);
          };
        },
        'fge: close float on Escape',
      );

      // 详情浮窗里 **Alt + 滚轮 = 横向滚动**(用户口径: "代替横向滚动条")。
      // 面板只有半屏宽, 长行(代码 / diff / 宽表格)要想看右边那段, 只能去够面板最下面那条横向滚动条 ——
      // 它离指针太远, 所以给一条手势。
      // ⚠ 必须 `{ capture: true, passive: false }`: 被动监听里的 `preventDefault()` 会被忽略(还可能在
      //   console 里报一句), 那样横滚的同时竖滚也会发生。
      // ⚠ 只认**本插件自己的详情浮窗** —— 判据同「送回侧栏」那条: 标题里有我们的文件名芯片。
      //   官方浮动宿主是所有页签共用的, 不去改别人的浮窗行为。
      // ⚠ **滚不动的那一下不吃**: 横向已经到边、或这个浮窗里根本没有能横滚的盒子时直接放行 ——
      //   于是 Alt+滚轮在没横向余量时还是普通竖滚, 不会变成"滚轮失灵"。
      // ⚠ 只认 Alt: 不带 Alt 的竖滚、带 Ctrl/Meta 的(浏览器缩放 / 系统手势)一概不碰。
      ctx.effect(
        function () {
          /**
           * 从事件目标往上找**第一个真的能横滚**的盒子(含浮窗体本身):
           * 有横向溢出 + `overflow-x` 是 auto/scroll(官方的浮窗体是 `overflow:auto`,
           * 代码块 / diff 内部还可能有自己的一层, 就近滚那一层更符合直觉)。
           */
          function horizontalBox(from, float) {
            var node = from;
            while (node !== null && node.nodeType === 1) {
              if (node.scrollWidth > node.clientWidth + 1) {
                var overflowX = window.getComputedStyle(node).overflowX;
                if (overflowX === 'auto' || overflowX === 'scroll') return node;
              }
              if (node === float) break;
              node = node.parentElement;
            }
            return null;
          }

          function onWheel(ev) {
            if (ev.altKey !== true || ev.ctrlKey === true || ev.metaKey === true) return;
            var target = ev.target;
            if (target === null || typeof target.closest !== 'function') return;
            var float = target.closest('[data-dockkit-float]');
            if (float === null) return;
            if (float.querySelector('[data-dockkit-float-title] .fge-doc-name') === null) return;
            var box = horizontalBox(target, float);
            if (box === null) return;
            // deltaMode=1 是"行", 换算成像素; 纯横向滚轮(deltaY=0)交给浏览器自己那条路。
            var step = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
            if (step === 0) return;
            var max = box.scrollWidth - box.clientWidth;
            var next = Math.max(0, Math.min(max, box.scrollLeft + step));
            if (next === box.scrollLeft) return;
            ev.preventDefault();
            box.scrollLeft = next;
          }

          window.addEventListener('wheel', onWheel, { capture: true, passive: false });
          return function () {
            window.removeEventListener('wheel', onWheel, { capture: true });
          };
        },
        'fge: alt+wheel scrolls the float sideways',
      );

      // 右栏折叠 → 关掉本插件浮起的详情: 悬浮面板在 document.body 上的一个 fixed portal 里
      // (z-index 60), 不随右栏一起滑走, 所以必须显式关。
      ctx.effect(
        function () {
          if (typeof MutationObserver !== 'function' || typeof document === 'undefined') {
            return function () {};
          }
          function check() {
            if (floatTarget === null) return;
            if (document.querySelector('[data-rightbar-collapsed]') !== null) closeOwnedFloat();
          }
          var observer = new MutationObserver(check);
          observer.observe(document.documentElement, {
            attributes: true,
            subtree: true,
            attributeFilter: ['data-rightbar-collapsed'],
          });
          return function () {
            observer.disconnect();
          };
        },
        'fge: close float when rightbar collapses',
      );

      // 插件卸载: 撤掉本插件浮起的详情, 不留孤儿页签与缓存。
      ctx.effect(
        function () {
          return function () {
            closeOwnedFloat();
            diffs.clear();
            gitViews.clear();
            gitData.clear();
            seededSessions.clear();
          };
        },
        'fge: dispose float state',
      );

      console.info('[fge] ready — 右侧栏「git 页签」+ 详情悬浮面板, composer 下的终端抽屉');
    };

    // 离线校验出口: `tests/verify-client-bundles.mjs` 直接跑这几个**纯的 / 注入了 `h` 的**函数
    // 验「按目录归类」「层级线」「整棵树上屏的行数组」(浏览器 bundle 不能 require 本包的模块,
    // 所以只能这样递出去)。不是插件契约的一部分。
    exports.__pathTree = { build: buildPathTree, compact: compactPathTree, guides: guideSegments };
    exports.__treeRows = makeTreeRows;
    /** 终端的 16 色 ANSI 调色板 —— 离线护栏拿它逐个算与终端面的对比度(见 §13)。 */
    exports.__terminalPalette = terminalPalette;
    /**
     * 官方终端帧 → xterm 的那条契约(snapshot 先 reset+resize 再写屏 / 写完 ack)——
     * 离线护栏用假 xterm 与假 view 直接跑它(见 ADR-0006)。
     */
    exports.__applyTerminalFrame = applyTerminalFrame;
    /** 右栏页签左右切换的下标计算 —— 离线护栏验它的**不环绕**语义(见 §14)。 */
    exports.__tabNeighbor = tabNeighbor;
    /**
     * git 数据的复用判据 —— 离线护栏直接跑它: 同工作区切会话**不许**再发一遍请求
     * (「加载过慢」那条 bug 的回归锁, 见 §10 与上面 gitData 的注释)。
     */
    exports.__gitDataDecision = gitDataDecision;
    /** 工作区键的归一化 —— 与判据配套验(盘符 / 尾斜杠 / 大小写 / 反斜杠)。 */
    exports.__workspaceKey = workspaceKey;
    /**
     * 终端选区**尾巴收敛**的两个纯函数(见 §13): 找"最后一行有内容" + 把尾巴收到那行。
     * 离线护栏直接拿假行数据跑 —— 这条 bug("拖到空白区, 复制出一堆空行")就是它们兜住的。
     */
    exports.__findLastContentRow = findLastContentRow;
    exports.__clampSelectionTail = clampSelectionTail;
    /** 鼠标 y → 绝对行号(与 xterm 的 getCoords 同款算法, 见 §13 的"内容下方"边界)。 */
    exports.__mouseRowAt = mouseRowAt;

    return module.exports;
  },
});
