// dsh-stylevault-localchrome — client half(静态浏览器 bundle)
//
// 职责: 在「安装/首次启动」时, 读取本机 Chrome 配色并生成 StyleVault 1.0 预设,
// 然后**受控地**把它应用到上游 StyleVault 的主题引擎。应用前有两道闸:
//   1) 必须有上游 stylevault(即 window.__STYLEVAULT__ 存在) —— 没有就不应用, 只生成 JSON;
//   2) 必须得到用户同意 —— 首次启动弹 confirm; 「确定」→ 应用并记住(下次启动自动应用),
//      「取消」→ 只生成预设 JSON、不应用(记为 never, 不再弹)。
//
// 已同意(consent==='apply')后, 每次启动自动把当前 Chrome 配色应用到 StyleVault(静默)。
// 控制台助手 __SVLC__ 提供手动应用/生成/改选择; 设置面板设置卡片显示状态与手动开关。
//
// 与动态插件 client 半不同: React 经 require('react') 解析(loader 种子模块),
// 槽位注册 API(slots.inject / slots.register)与动态完全一致。不触碰运行时主题
// 之外的布局 —— 应用动作完全交给 __STYLEVAULT__.import()(上游实现)。
window.__ModuleLoader__.load({
  id: 'dsh-stylevault-localchrome',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var React = require('react');

    exports.name = 'dsh-stylevault-localchrome';
    exports.inject = ['slots'];
    exports.apply = function (ctx) {
      var slots = ctx.slots;

      var BASE = '/svlc/api';
      var CONSENT_KEY = 'svlc.consent';
      var LS = window.localStorage;

      function jsonReq(path, body) {
        var opts = {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-plugin': '1' },
        };
        if (body !== undefined) opts.body = JSON.stringify(body || {});
        return fetch(BASE + path, opts).then(function (r) {
          return r.json();
        });
      }

      function shareText(p) {
        return (
          '🎨 StyleVault 配置：' +
          (p.name || '') +
          '\n' +
          (p.description || '') +
          '\n\n基于：' +
          (p.basePreset || '') +
          ' · ' +
          (p.colorScheme || '') +
          '\n\n```json\n' +
          JSON.stringify(p, null, 2) +
          '\n```' +
          '\n\n导入：打开 DSH → Settings → StyleVault → 导入'
        );
      }

      // ---- 预设获取: 优先 chrome 取色, 失败回退内置 Sage Mist ----
      function fetchPreset(opts) {
        return jsonReq('/preset', opts || {})
          .then(function (p) {
            if (p && p.stylevault === '1.0' && p.tokens) return p;
            return jsonReq('/sage', {});
          })
          .catch(function () {
            return jsonReq('/sage', {});
          });
      }

      // ---- 应用到 StyleVault ----
      // 一次性写进「我的方案」: 首次(同名方案不存在)用 saveAs 入列并应用;
      // 之后再应用同名方案就不再新增, 只更新当前主题(避免每次启动堆积重复方案)。
      function applyToStyleVault(payload) {
        var sv = window.__STYLEVAULT__;
        if (!sv || typeof sv.import !== 'function')
          return { ok: false, reason: 'stylevault-missing' };
        try {
          var exists = false;
          if (typeof sv.schemes === 'function') {
            var schemes = sv.schemes() || [];
            for (var i = 0; i < schemes.length; i++) {
              if (
                schemes[i] &&
                schemes[i].name === payload.name &&
                schemes[i].basePreset === payload.basePreset
              ) {
                exists = true;
                break;
              }
            }
          }
          // saveAs 会再 push 一条; 仅当同名方案不存在时才入列, 否则只应用
          var r = exists ? sv.import(payload) : sv.import(payload, { saveAs: true });
          return {
            ok: !!(r && r.ok),
            reason: r && r.error ? r.error : '',
            name: payload.name,
            savedToSchemes: !exists,
          };
        } catch (e) {
          return { ok: false, reason: String((e && e.message) || e).slice(0, 120) };
        }
      }

      function appliedMsg(r) {
        if (!r || !r.ok) return '应用失败: ' + ((r && r.reason) || '');
        return '已应用 ' + r.name + (r.savedToSchemes ? '，并写入「我的方案」' : '');
      }

      function waitForStyleVault(timeoutMs) {
        return new Promise(function (resolve) {
          var deadline = Date.now() + (timeoutMs || 4000);
          (function poll() {
            if (window.__STYLEVAULT__) return resolve(true);
            if (Date.now() > deadline) return resolve(false);
            setTimeout(poll, 150);
          })();
        });
      }

      // ---- 状态 store(供设置卡片订阅) ----
      var state = {
        consent: LS.getItem(CONSENT_KEY),
        chromeColor: '',
        presetName: '',
        status: '',
        lastError: '',
      };
      var listeners = [];
      function notify() {
        for (var i = 0; i < listeners.length; i++) {
          try {
            listeners[i]();
          } catch (_e) {
            /* ignore */
          }
        }
      }
      function patch(p) {
        for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) state[k] = p[k];
        notify();
      }
      function subscribe(fn) {
        listeners.push(fn);
        return function () {
          var i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      }

      function bgInfo(payload) {
        if (!payload || !payload.tokens) return { color: '', name: '' };
        return {
          color: payload.tokens['--dsw-alias-brand-primary'] || '',
          name: payload.name || '',
        };
      }

      // 预取一次 chrome 配色信息(不管是否应用, 设置卡/提示都用它)
      fetchPreset({})
        .then(function (p) {
          var b = bgInfo(p);
          patch({ chromeColor: b.color, presetName: b.name });
        })
        .catch(function () {});

      // ---- 启动流程: 受控自动应用 ----
      (function boot() {
        var consent = LS.getItem(CONSENT_KEY);
        if (consent === 'never') {
          patch({ status: '未授权自动应用 — 仅生成预设 JSON。可在设置卡片选择“同意并应用”。' });
          return;
        }
        if (consent !== 'apply') {
          // 首次启动: 需要拿到 stylevault + 用户同意才应用
          waitForStyleVault().then(function (ready) {
            if (!ready) {
              patch({
                status:
                  '未检测到上游 StyleVault(window.__STYLEVAULT__)，未应用。可先安装上游，或仅生成预设手动导入。',
              });
              return;
            }
            fetchPreset({}).then(function (p) {
              var b = bgInfo(p);
              patch({ chromeColor: b.color, presetName: b.name });
              var msg =
                'StyleVault · Local Chrome\n\n检测到本机 Chrome 配色 ' +
                (b.color || '') +
                '。是否立即应用为 DSH 主题(导入 StyleVault)?\n\n' +
                '「确定」应用并记住(下次启动自动应用)\n' +
                '「取消」仅生成预设 JSON, 不应用';
              var ok = false;
              try {
                ok = window.confirm(msg);
              } catch (_e) {
                ok = false;
              }
              if (ok) {
                LS.setItem(CONSENT_KEY, 'apply');
                var r = applyToStyleVault(p);
                patch({ consent: 'apply', status: appliedMsg(r) });
              } else {
                LS.setItem(CONSENT_KEY, 'never');
                patch({
                  consent: 'never',
                  status: '已取消 — 仅生成预设 JSON (见 __SVLC__.preset()), 未应用。',
                });
              }
            });
          });
          return;
        }
        // consent==='apply': 等待 stylevault 后静默自动应用
        waitForStyleVault().then(function (ready) {
          if (!ready) {
            patch({ status: '未检测到上游 StyleVault，未应用。可仅生成预设手动导入。' });
            return;
          }
          fetchPreset({}).then(function (p) {
            var r = applyToStyleVault(p);
            patch({ status: appliedMsg(r) });
          });
        });
      })();

      // ---- 控制台 API ----
      window.__SVLC__ = {
        version: '1.0',
        chrome: function (opts) {
          return jsonReq('/chrome', opts || {});
        },
        preset: function (opts) {
          return jsonReq('/preset', opts || {});
        },
        sage: function () {
          return jsonReq('/sage', {});
        },
        consent: function (v) {
          if (v === undefined) return LS.getItem(CONSENT_KEY);
          LS.setItem(CONSENT_KEY, v);
          patch({ consent: v });
          return v;
        },
        /** 手动应用当前 chrome 配色到 StyleVault; else 生成预设返回 */
        apply: function (opts) {
          return fetchPreset(opts).then(function (p) {
            var r = applyToStyleVault(p);
            patch({ status: appliedMsg(r) });
            return { ok: r.ok, reason: r.reason, savedToSchemes: r.savedToSchemes, preset: p };
          });
        },
        copyShare: function (opts) {
          return fetchPreset(opts).then(function (p) {
            var text = shareText(p);
            return navigator.clipboard
              .writeText(text)
              .then(function () {
                return { ok: true, name: p.name };
              })
              .catch(function () {
                return { ok: false, text: text };
              });
          });
        },
      };

      // ---- 设置面板: 状态 + 授权开关(不推送状态到主题, 只操作同意和应用) ----
      function useStore() {
        var s = React.useState(state);
        React.useEffect(function () {
          return subscribe(function () {
            s[1](state);
          });
        }, []);
        return s[0];
      }

      function SectionCard(props) {
        var st = useStore();
        var sw = st.chromeColor;
        var agreed = st.consent === 'apply';
        var btnStyle = function (primary) {
          return {
            padding: '6px 12px',
            borderRadius: 8,
            fontFamily: 'inherit',
            fontSize: 13,
            lineHeight: 20,
            cursor: 'pointer',
            background: primary ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-2)',
            color: primary
              ? 'var(--dsw-alias-label-primary-foreground,#111)'
              : 'var(--dsw-alias-label-primary)',
            border: primary ? 'none' : '1px solid var(--dsw-alias-border-l2)',
          };
        };
        var row = { display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0 0' };
        var dot = {
          width: 14,
          height: 14,
          borderRadius: 4,
          flex: 'none',
          background: sw || 'transparent',
          border: '1px solid var(--dsw-alias-border-l2)',
        };

        function agree() {
          handleConsent('apply');
        }
        function decline() {
          handleConsent('never');
        }
        function handleConsent(v) {
          window.__SVLC__.consent(v);
          if (v === 'apply') {
            window.__SVLC__.apply().then(function (r) {
              patch({ status: appliedMsg(r) });
            });
          } else {
            patch({
              consent: 'never',
              status: '已取消 — 仅生成预设 JSON (见 __SVLC__.preset()), 未应用。',
            });
          }
        }

        return React.createElement(
          'div',
          { style: { fontSize: 13, lineHeight: 20, color: 'var(--dsw-alias-label-primary)' } },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            React.createElement('div', { style: dot }),
            React.createElement(
              'span',
              { style: { fontWeight: 600 } },
              'Chrome 配色：' + (sw || '—'),
            ),
          ),
          React.createElement(
            'div',
            { style: { marginTop: 6, color: 'var(--dsw-alias-label-secondary)' } },
            st.status || (agreed ? '已同意自动应用。' : '尚未授权自动应用。'),
          ),
          React.createElement(
            'div',
            { style: row },
            React.createElement(
              'button',
              { type: 'button', style: btnStyle(true), onClick: agree },
              '同意并应用',
            ),
            React.createElement(
              'button',
              { type: 'button', style: btnStyle(false), onClick: decline },
              '仅生成预设(不应用)',
            ),
          ),
          React.createElement(
            'div',
            { style: { marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } },
            agreed
              ? '已记住，下次启动自动应用当前 Chrome 配色。'
              : '应用前需已安装上游 StyleVault；否则仅生成预设 JSON 供手动导入。',
          ),
        );
      }

      try {
        slots.inject('settings.section', function () {
          return slots.register(
            {
              name: 'settings.section',
              id: 'stylevault-localchrome',
              order: 36,
              label: function () {
                return 'StyleVault · Local Chrome';
              },
            },
            SectionCard,
          );
        });
      } catch (e) {
        console.warn('[stylevault-localchrome] settings section failed', e);
      }

      console.info(
        '[stylevault-localchrome] ready — 受控自动应用。__SVLC__.apply() / __SVLC__.preset() / __SVLC__.consent()',
      );
    };

    return module.exports;
  },
});
