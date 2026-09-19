/**
 * 页面快照与元素解析。
 *
 * `pageProbe` 会经 `page.evaluate` / `page.evaluateHandle` 在**页面上下文**执行,
 * 所以它不许引用任何闭包变量、也不许加载任何模块(Playwright 只序列化函数
 * 源码)。选择器从 Node 侧作为参数传进去。
 *
 * **读快照与解析元素共用这一个函数** —— 序号是「按同一选择器 + 同一可见性判定
 * 数出来的第 n 个」。两处各写一份,迟早会错位;那时点到的是**别的元素**。
 *
 * @module dsh-browser-operator/snapshot
 */

/** 可交互元素的唯一选择器。 */
export const ELEMENT_SELECTOR =
  'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="combobox"],' +
  '[role="textbox"],[role="checkbox"],[role="tab"],[contenteditable="true"]';

/** 元素数量上限,挡住超长页面。 */
export const MAX_ELEMENTS = 200;

const MAX_NAME_CHARS = 120;
const MAX_VALUE_CHARS = 200;
const MAX_TEXT_CHARS = 4000;

/**
 * 页面侧探测函数。两种模式:
 * - `options.index` 是数字 → 返回该序号的 DOM 元素,越界返回 `null`(解析模式)
 * - 否则 → 返回完整快照(观察模式)
 *
 * @param {{ selector: string, limit?: number, index?: number }} options
 */
/* eslint-disable no-undef -- 函数体整段在页面上下文执行,`document` / `window` /
   `location` 只有进了页面才存在,静态 no-undef 在这一段没有意义。豁免只包住本函数:
   下面的 readSnapshot / elementHandle 跑在 Node 侧,照旧受检。 */
export function pageProbe(options) {
  const selector = options.selector;
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const collect = () => {
    const found = [];
    for (const element of document.querySelectorAll(selector)) {
      if (visible(element)) found.push(element);
    }
    return found;
  };

  const nodes = collect();
  if (typeof options.index === 'number') {
    return nodes[options.index - 1] ?? null;
  }

  const nameOf = (element) =>
    (
      element.getAttribute('aria-label') ||
      element.getAttribute('placeholder') ||
      element.innerText ||
      element.value ||
      element.getAttribute('name') ||
      ''
    )
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, MAX_NAME_CHARS);
  const kindOf = (element) => {
    const tag = element.tagName.toLowerCase();
    const role = (element.getAttribute('role') || '').toLowerCase();
    if (tag === 'select' || role === 'combobox' || role === 'listbox') return 'selectable';
    if (tag === 'input' || tag === 'textarea' || role === 'textbox' || element.isContentEditable) {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio' || type === 'submit' || type === 'button') {
        return 'clickable';
      }
      return 'typeable';
    }
    return 'clickable';
  };

  const elements = nodes.slice(0, options.limit).map((element, position) => ({
    index: position + 1,
    role: (element.getAttribute('role') || element.tagName.toLowerCase()).trim(),
    name: nameOf(element),
    value: typeof element.value === 'string' ? element.value.slice(0, MAX_VALUE_CHARS) : '',
    disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
    kind: kindOf(element),
  }));
  const text = (document.body ? document.body.innerText : '')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_TEXT_CHARS);

  return {
    url: location.href,
    title: document.title,
    // freshness 由元素数 / URL / 可见文本长度拼成:执行前对不上就说明快照过期。
    freshness: `${elements.length}|${location.href}|${text.length}`,
    text,
    elements,
  };
}
/* eslint-enable no-undef */

/**
 * 读一次页面快照。
 * @param {{ evaluate: (fn: Function, arg: object) => Promise<unknown> }} page
 */
export async function readSnapshot(page, selector = ELEMENT_SELECTOR, limit = MAX_ELEMENTS) {
  const snapshot = await page.evaluate(pageProbe, { selector, limit });
  if (snapshot === null || typeof snapshot !== 'object' || !Array.isArray(snapshot.elements)) {
    throw new Error('browser-operator: 页面快照读取失败(没拿到 elements 数组)');
  }
  return snapshot;
}

/**
 * 按序号拿到**当前**的 DOM 元素句柄。序号已失效时抛错 —— 调用方据此重来一轮。
 * @param {{ evaluateHandle: (fn: Function, arg: object) => Promise<object> }} page
 */
export async function elementHandle(page, index, selector = ELEMENT_SELECTOR) {
  const handle = await page.evaluateHandle(pageProbe, { selector, index });
  const element = handle.asElement();
  if (element === null) {
    await handle.dispose();
    throw new Error(`browser-operator: 元素 ${index} 在执行前已经不在了`);
  }
  return element;
}
