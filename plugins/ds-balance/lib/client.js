// dsh-ds-balance — client half(静态浏览器 bundle)
//
// 与动态插件 client 半的唯一差异: 沙箱内置符号换成真实模块表依赖 ——
// React 经 require('react') 解析(loader 种子模块), host.call 换成
// fetch('/ds-balance/api/<method>'), styles.insert 换成手动 <style> 注入。
// 槽位注册 API(slots.inject / slots.register)与动态完全一致。
window.__ModuleLoader__.load({
  id: 'dsh-ds-balance',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var React = require('react');

    exports.name = 'dsh-ds-balance';
    exports.inject = ['slots', 'timer'];
    exports.apply = function (ctx) {
      var slots = ctx.slots;

      // 静态插件没有 harness 私有 RPC, 走 host 注册的 HTTP JSON 路由。
      function api(method) {
        return fetch('/ds-balance/api/' + method, {
          method: 'POST',
          headers: { 'x-dsh-plugin': '1' },
        }).then(function (res) {
          if (!res.ok) throw new Error('ds-balance: http ' + String(res.status));
          return res.json();
        });
      }

      function formatTokens(n) {
        var scaled = function (v) {
          return v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
        };
        if (n < 1000) return String(n);
        if (n < 1000000) return scaled(n / 1000) + 'K';
        if (n < 1000000000) return scaled(n / 1000000) + 'M';
        return scaled(n / 1000000000) + 'B';
      }

      function formatMoney(n) {
        return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }

      function currencySymbol(currency) {
        if (currency === 'USD') return '$';
        if (currency === 'EUR') return '€';
        return '¥';
      }

      function BalanceLine() {
        var state = React.useState(null);
        var snapshot = state[0];
        var setSnapshot = state[1];
        var loadedState = React.useState(false);
        var loaded = loadedState[0];
        var setLoaded = loadedState[1];
        var busyRef = React.useRef(false);
        // loginPending 时正在等待 Playwright 浏览器登录; loginError 记录失败原因。
        var loginState = React.useState(false);
        var loginPending = loginState[0];
        var setLoginPending = loginState[1];
        var errorState = React.useState(null);
        var loginError = errorState[0];
        var setLoginError = errorState[1];

        var refresh = React.useCallback(function () {
          if (busyRef.current) return;
          busyRef.current = true;
          api('query')
            .then(function (result) {
              setSnapshot(result);
              setLoaded(true);
              if (result && result.hasToken) setLoginPending(false);
            })
            .catch(function () {
              setSnapshot(null);
              setLoaded(true);
            })
            .finally(function () {
              busyRef.current = false;
            });
        }, []);

        // Playwright 一键登录: 弹出浏览器, 用户登录后自动保存。
        var browserLogin = React.useCallback(function () {
          setLoginError(null);
          setLoginPending(true);
          api('browser-login')
            .then(function (result) {
              if (result && !result.ok) {
                setLoginPending(false);
                setLoginError(result.error || 'failed');
              }
            })
            .catch(function () {
              setLoginPending(false);
              setLoginError('rpc-failed');
            });
        }, []);

        React.useEffect(
          function () {
            refresh();
            return ctx.interval(refresh, 5 * 60 * 1000);
          },
          [refresh],
        );

        // 等待浏览器登录: 轮询 host 的登录状态(不走 query 缓存), 完成后自动恢复。
        var checkLogin = React.useCallback(
          function () {
            api('login-status')
              .then(function (st) {
                if (!st) return;
                if (st.state === 'saved') {
                  setLoginPending(false);
                  refresh();
                } else if (st.state === 'failed') {
                  setLoginPending(false);
                  setLoginError(st.error || 'failed');
                }
              })
              .catch(function () {});
          },
          [refresh],
        );

        React.useEffect(
          function () {
            if (!loginPending) return;
            return ctx.interval(checkLogin, 2000);
          },
          [loginPending, checkLogin],
        );

        // 所有 hooks 都在早退之前, hook 顺序保持稳定。
        if (!loaded) return null;
        if (snapshot === null) {
          return React.createElement(
            'div',
            { className: 'dsbalance-line' },
            'DeepSeek 余额: 查询失败',
          );
        }
        if (!snapshot.ok) {
          return React.createElement(
            'div',
            { className: 'dsbalance-line' },
            'DeepSeek 余额不可用: ' + String(snapshot.error),
          );
        }
        if (!snapshot.official) {
          return React.createElement(
            'div',
            { className: 'dsbalance-line' },
            'DeepSeek 余额(非官方网关, 已隐藏): ' + String(snapshot.base),
          );
        }

        var symbol = currencySymbol(snapshot.currency);
        var cells = [{ text: 'DeepSeek ' + symbol + formatMoney(snapshot.total), balance: true }];
        if (snapshot.usage !== null && snapshot.usage !== undefined) {
          var usage = snapshot.usage;
          var tokens = function (u) {
            return u.promptCacheHit + u.promptCacheMiss + u.response;
          };
          // usage/amount 接口不返回调用次数(requests 为 null), 此时省略"次"。
          var usageCell = function (label, u) {
            return u.requests === null
              ? label + ' ' + formatTokens(tokens(u)) + ' tok'
              : label + ' ' + u.requests + ' 次 · ' + formatTokens(tokens(u)) + ' tok';
          };
          cells.push({ text: usageCell('今日', usage.today) });
          cells.push({ text: usageCell('本月', usage.month) });
        }
        // 未配置 userToken 时提供一键登录入口。
        if (!snapshot.hasToken) {
          cells.push({ text: '浏览器登录', kind: 'link', onClick: browserLogin });
        }

        var detail = ['DeepSeek 总余额 ' + symbol + formatMoney(snapshot.total)];
        if (snapshot.granted !== null)
          detail.push('赠送 ' + symbol + formatMoney(snapshot.granted));
        if (snapshot.toppedUp !== null)
          detail.push('充值 ' + symbol + formatMoney(snapshot.toppedUp));
        if (snapshot.usage !== null && snapshot.usage !== undefined) {
          var day = function (u) {
            return (
              '输入(缓存命中 ' +
              formatTokens(u.promptCacheHit) +
              ' / 未命中 ' +
              formatTokens(u.promptCacheMiss) +
              ') · 输出 ' +
              formatTokens(u.response)
            );
          };
          var count = function (u) {
            return u.requests === null ? '' : u.requests + ' 次: ';
          };
          detail.push('今日 ' + count(snapshot.usage.today) + day(snapshot.usage.today));
          detail.push('本月 ' + count(snapshot.usage.month) + day(snapshot.usage.month));
        }
        var title = detail.join('\n');

        // 等待浏览器登录: 提示用户在弹出的窗口登录, 登录后自动保存并恢复。
        if (loginPending) {
          return React.createElement(
            'div',
            { className: 'dsbalance-line' },
            React.createElement(
              'span',
              null,
              loginError !== null
                ? '浏览器登录失败: ' + loginError + '，'
                : '请在弹出的浏览器窗口中登录 platform.deepseek.com，登录后自动保存… ',
            ),
            React.createElement(
              'span',
              {
                className: 'dsbalance-link',
                onClick: function () {
                  setLoginPending(false);
                },
              },
              '取消',
            ),
          );
        }

        return React.createElement(
          'div',
          { className: 'dsbalance-line', title: title },
          cells.map(function (cell, i) {
            var content =
              cell.kind === 'link'
                ? React.createElement(
                    'span',
                    { className: 'dsbalance-link', onClick: cell.onClick },
                    cell.text,
                  )
                : cell.text;
            return i === 0
              ? React.createElement(
                  'span',
                  {
                    key: 'c' + i,
                    className: cell.balance ? 'dsbalance-balance' : undefined,
                  },
                  content,
                )
              : React.createElement(
                  React.Fragment,
                  { key: 'c' + i },
                  React.createElement(
                    'span',
                    { className: 'dsbalance-sep', 'aria-hidden': true },
                    '|',
                  ),
                  ' ',
                  content,
                );
          }),
        );
      }

      // 静态 bundle 没有 styles 内置符号, 手动注入 <style> 并在 dispose 时移除。
      var STYLE_CSS =
        '.dsbalance-line{display:block;text-align:center;max-width:var(--dsh-chat-content-width);' +
        'width:100%;margin:0 auto;box-sizing:border-box;padding:0 calc(var(--dsh-composer-side-clearance) + 16px) 4px;' +
        'font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;' +
        'overflow:hidden;text-overflow:ellipsis}' +
        '.dsbalance-line .dsbalance-balance{color:var(--dsw-alias-label-secondary)}' +
        '.dsbalance-line .dsbalance-sep{color:inherit;margin:0 10px}' +
        '.dsbalance-link{cursor:pointer;text-decoration:underline;color:var(--dsw-alias-label-secondary)}' +
        '.dsbalance-link:hover{color:var(--dsw-alias-label-primary)}';
      var styleTag = null;
      function ensureStyles() {
        if (styleTag !== null) return;
        styleTag = document.createElement('style');
        styleTag.setAttribute('data-plugin', 'dsh-ds-balance');
        styleTag.textContent = STYLE_CSS;
        document.head.appendChild(styleTag);
      }
      ensureStyles();
      ctx.on('dispose', function () {
        if (styleTag !== null) {
          styleTag.remove();
          styleTag = null;
        }
      });

      slots.inject('conversation.composer.dock', function () {
        return slots.register(
          // 独立单元格, 不接管官方 stats; order:1 让本行排在官方 stats 行之下。
          { name: 'conversation.composer.dock', id: 'ds-balance', order: 1 },
          BalanceLine,
        );
      });
    };

    return module.exports;
  },
});
