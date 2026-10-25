// Fuzz 强化版：更大的随机空间 + 动态 DOM 抖动 + 长时间运行
// 目标：把"偶发 bug"逼出来，而不是靠运气通过。
'use strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../beeline-autocourse.user.js', import.meta.url), 'utf8');

function matchOne(el, s) {
  let rest = s;
  const tagM = rest.match(/^[a-zA-Z][a-zA-Z0-9]*/);
  if (tagM) { if (el.tagName !== tagM[0].toUpperCase()) return false; rest = rest.slice(tagM[0].length); }
  const parts = rest.match(/\.[\w-]+|\[[^\]]+\]/g) || [];
  if (!parts.length) return !!tagM;
  for (const p of parts) {
    if (p.startsWith('.')) {
      if (!(el.className || '').split(/\s+/).includes(p.slice(1))) return false;
    } else {
      const inner = p.slice(1, -1);
      const m = inner.match(/^([\w-]+)([*^$]?)=(?:"([^"]*)"|'([^']*)'|([^\]]*))$/);
      if (m) {
        const want = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[5]);
        const actual = m[1] === 'class' ? (el.className || '') : (el.getAttribute(m[1]) || '');
        if (m[2] === '*') { if (!String(actual).includes(want)) return false; }
        else if (String(actual) !== want) return false;
      } else if (!el.getAttribute(inner)) return false;
    }
  }
  return true;
}
function matchSel(el, sel) {
  for (const s of sel.split(',').map((x) => x.trim())) {
    if (!s) continue;
    if (s === '*') return true;
    if (matchOne(el, s)) return true;
  }
  return false;
}

const CLICK_LOG = [];
class El {
  constructor(tag, o = {}) {
    this.tagName = (tag || 'div').toUpperCase();
    this.nodeType = 1;
    this.id = o.id || ''; this.className = o.className || '';
    this.children = []; this.parentElement = null;
    this._text = o.text || ''; this._html = '';
    this.attrs = o.attrs || {};
    this.isConnected = o.connected !== false;
    this._rect = o.rect || null;
    this._opacity = o.opacity !== undefined ? o.opacity : '1';
    this._display = o.display || 'block';
    this._pe = o.pointerEvents || 'auto';
    this._vis = o.visibility || 'visible';
    this.style = { cssText: '', setProperty() {} };
    const self = this;
    this.classList = {
      add(c) { self.className = (self.className + ' ' + c).trim(); },
      remove(c) { self.className = self.className.split(/\s+/).filter((x) => x !== c).join(' '); },
      toggle(c, f) { if (f === undefined) f = !this.contains(c); if (f) this.add(c); else this.remove(c); },
      contains(c) { return self.className.split(/\s+/).includes(c); },
    };
  }
  set innerHTML(v) { this._html = v; }
  get innerHTML() { return this._html; }
  get textContent() { return this._text + this.children.map((c) => c.textContent || '').join(''); }
  set textContent(v) { this._text = v; }
  get innerText() { return this.textContent; }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  remove() { this.isConnected = false; }
  addEventListener() {} removeEventListener() {}
  getAttribute(k) { return this.attrs[k] !== undefined ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getBoundingClientRect() {
    if (!this.isConnected) return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    let p = this;
    while (p) {
      if (p._display === 'none') return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
      p = p.parentElement;
    }
    return this._rect || { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  }
  closest(sel) { let p = this; while (p) { if (matchSel(p, sel)) return p; p = p.parentElement; } return null; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) { return pageQSA(this, sel); }
  click() { CLICK_LOG.push(this); return true; }
  dispatchEvent(ev) { if (ev && ev.type === 'click') CLICK_LOG.push(this); return true; }
}

function pageQSA(root, sel) {
  const out = [];
  const walk = (n) => { for (const c of n.children) { if (matchSel(c, sel)) out.push(c); walk(c); } };
  walk(root);
  return out;
}

// ---------- 更强的随机页面 ----------
const TEXTS = ['课程介绍', '第一章', '学习进度', '笔记', '资料', '讨论',
  '观看下一章节', '观看下一节', '重新观看本节', '上一节', '下一章', '继续',
  '播放', '暂停', '倍速', '全屏', '目录', '互动', '应用', 'AI客服'];
const CLASSES = ['el-menu-item', 'el-button', 'chapter-item', 'course-sidebar-switch',
  'toolbar-btn', 'el-dialog', 'el-message', 'video-controls', 'nav-item', 'icon-btn',
  'status-ring', 'done-icon', 'progress-bar', 'right', 'mask', 'popup', 'btn', 'no-panel'];

function rngFrom(seed) {
  let s = seed >>> 0;
  return {
    n: (m) => { s = (s * 1664525 + 1013904223) >>> 0; return s % m; },
    frac: () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; },
  };
}

function buildPage(seed) {
  CLICK_LOG.length = 0;
  const R = rngFrom(seed);
  const pick = (a) => a[R.n(a.length)];

  const doc = new El('#document');
  doc.nodeType = 9; doc.readyState = 'complete';
  const html = new El('html'); const body = new El('body');
  doc.documentElement = html; doc.body = body; doc.head = new El('head');
  html.appendChild(body); doc.appendChild(html);
  doc.createElement = (t) => new El(t);
  doc.getElementById = (id) => { const r = pageQSA(doc, '#' + id); return r[0] || null; };
  doc.addEventListener = () => {};
  doc.hasFocus = () => true;
  doc.querySelectorAll = (sel) => pageQSA(doc, sel);
  doc.querySelector = (sel) => doc.querySelectorAll(sel)[0] || null;

  const all = [];
  const mkRect = (w, h) => {
    const left = R.n(2600) - 100, top = R.n(1200) - 100;
    return { left, top, width: w, height: h, right: left + w, bottom: top + h };
  };
  const addTree = (parent, depth) => {
    if (depth <= 0) return;
    const n = R.n(4);
    for (let i = 0; i < n; i++) {
      const tag = pick(['div', 'span', 'button', 'a', 'li', 'ul', 'i', 'p', 'section', 'svg']);
      const w = R.n(4) === 0 ? R.n(10) : 20 + R.n(400);      // 有时给超小尺寸
      const h = R.n(4) === 0 ? R.n(8) : 12 + R.n(120);
      const el = new El(tag, {
        className: R.n(3) === 0 ? pick(CLASSES) : (R.n(5) === 0 ? pick(CLASSES) + ' ' + pick(CLASSES) : ''),
        text: R.n(3) === 0 ? pick(TEXTS) : '',
        rect: mkRect(w, h),
        opacity: R.n(8) === 0 ? '0' : '1',
        display: R.n(14) === 0 ? 'none' : 'block',
        visibility: R.n(16) === 0 ? 'hidden' : 'visible',
        pointerEvents: R.n(18) === 0 ? 'none' : 'auto',
        attrs: { role: R.n(4) === 0 ? 'button' : null, id: R.n(30) === 0 ? 'bl-panel' : null },
      });
      parent.appendChild(el); all.push(el);
      addTree(el, depth - 1);
    }
  };
  addTree(body, 4);   // 更深

  // 陷阱
  const traps = {};
  const trap = (key, tag, cls, text, rect) => {
    const el = new El(tag, { className: cls, text, rect });
    body.appendChild(el); all.push(el); traps[key] = el; return el;
  };
  traps.sidebarToggle = trap('sidebarToggle', 'div', 'course-sidebar-switch', '', mkRect(30, 30));
  traps.videoCtl = trap('videoCtl', 'div', 'video-controls', '播放 暂停 倍速 全屏', mkRect(600, 40));
  traps.navDir = trap('navDir', 'li', 'nav-item', '目录', mkRect(80, 40));
  traps.nextReal = trap('nextReal', 'button', 'el-button el-button--primary', '观看下一章节', mkRect(180, 44));
  traps.replay = trap('replay', 'button', 'el-button', '重新观看本节', mkRect(180, 44));

  doc.elementFromPoint = (x, y) => {
    let best = null, bestArea = Infinity;
    for (const el of all) {
      if (!el.isConnected || el._display === 'none' || el._vis === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const area = r.width * r.height;
      if (area < bestArea) { best = el; bestArea = area; }
    }
    return best;
  };

  return { doc, body, all, traps, R };
}

function run(page) {
  const timers = [];
  let now = 1_700_000_000_000;
  class FD extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
  const errors = [];
  const sb = {
    document: page.doc, Date: FD, innerWidth: 2489, innerHeight: 1041,
    localStorage: { _d: { BL_COURSE_CFG_V1: JSON.stringify({ enabled: true, instantClick: true, skipCourseware: true }) }, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = v; }, removeItem(k) { delete this._d[k]; } },
    sessionStorage: { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = v; }, removeItem(k) { delete this._d[k]; } },
    console: { log: () => {}, error: (...a) => errors.push(a.join(' ')), warn: (...a) => errors.push(a.join(' ')) },
    setTimeout: (fn, ms) => { const id = timers.length + 1; timers.push({ id, fn, at: now + (ms || 0) }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    setInterval: (fn, ms) => { const id = timers.length + 1; timers.push({ id, fn, at: now + (ms || 1), every: ms || 1 }); return id; },
    clearInterval: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    MutationObserver: class { observe() {} disconnect() {} },
    PointerEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    MouseEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    KeyboardEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    getComputedStyle: (el) => ({
      display: (el && el._display) || 'block', visibility: (el && el._vis) || 'visible',
      opacity: (el && el._opacity) || '1', pointerEvents: (el && el._pe) || 'auto',
      backgroundColor: 'rgba(0,0,0,0)', color: '#000', borderColor: 'rgba(0,0,0,0)', fill: '', stroke: '',
    }),
    HTMLMediaElement: El,
    location: { reload() {}, hash: '' },
    Math, JSON, Object, Array, String, Number, Promise, isFinite, parseFloat, WeakMap, Error, RegExp,
  };
  sb.window = sb; sb.globalThis = sb; sb.top = sb; sb.self = sb;
  const ctx = vm.createContext(sb);
  let threw = null;
  try { vm.runInContext(SRC, ctx, { filename: 'bl.js' }); } catch (e) { threw = e; }

  function advance(ms) {
    const end = now + ms; let g = 0;
    while (g++ < 500000) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at);
      if (!due.length) break;
      const t = due[0]; now = Math.max(now, t.at);
      if (t.every) { t.at = now + t.every; } else { timers.splice(timers.indexOf(t), 1); }
      try { t.fn(); } catch (e) { errors.push('timer:' + e.message); }
    }
    now = end;
  }
  return { sb, threw, errors, advance, timers };
}

const checks = [];
const ok = (n, c, x) => { checks.push(c); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x ? '  -> ' + x : '')); };

console.log('=== Fuzz 强化版：更大随机空间 + 更长时间 ===\n');

const ROUNDS = 300;
let crashes = 0, trapHits = 0, okRounds = 0, maxTimers = 0;
const detail = {};

for (let i = 0; i < ROUNDS; i++) {
  const page = buildPage(i * 7919 + 13);
  let res;
  try { res = run(page); } catch (e) {
    crashes++; detail['构造崩溃: ' + e.message.slice(0, 60)] = (detail['构造崩溃: ' + e.message.slice(0, 60)] || 0) + 1; continue;
  }
  if (res.threw) {
    crashes++; const k = '加载异常: ' + res.threw.message.slice(0, 60);
    detail[k] = (detail[k] || 0) + 1; continue;
  }
  // 跑 60 秒（覆盖多轮扫描与跳转尝试）
  res.advance(60000);
  maxTimers = Math.max(maxTimers, res.timers.length);

  for (const el of CLICK_LOG) {
    let p = el, own = false;
    while (p) { if (p.id === 'bl-panel' || p.id === 'bl-mini') { own = true; break; } p = p.parentElement; }
    if (own) { trapHits++; detail['点了自身面板'] = (detail['点了自身面板'] || 0) + 1; continue; }
    if (el === page.traps.sidebarToggle) { trapHits++; detail['点了侧边栏折叠开关'] = (detail['点了侧边栏折叠开关'] || 0) + 1; }
    if (el === page.traps.videoCtl) { trapHits++; detail['点了视频控件'] = (detail['点了视频控件'] || 0) + 1; }
    if (el === page.traps.navDir) { trapHits++; detail['点了导航目录'] = (detail['点了导航目录'] || 0) + 1; }
  }
  const realErrs = res.errors.filter((e) => !/^warn/.test(e));
  if (realErrs.length) {
    crashes++; const k = '运行异常: ' + realErrs[0].slice(0, 60);
    detail[k] = (detail[k] || 0) + 1;
  } else okRounds++;
}

console.log('  轮数: ' + ROUNDS + '，正常完成: ' + okRounds + '，最大定时器数: ' + maxTimers);
if (Object.keys(detail).length) {
  console.log('  问题分布:');
  for (const [k, v] of Object.entries(detail)) console.log('    ' + v + ' 次 — ' + k);
}

ok('随机 DOM 下无未捕获异常', crashes === 0, crashes + ' 次');
ok('未误点面板/侧边栏/视频控件/导航', trapHits === 0, trapHits + ' 次');
ok('全部轮次正常完成', okRounds === ROUNDS, okRounds + '/' + ROUNDS);
ok('定时器未泄漏（< 50）', maxTimers < 50, '最大 ' + maxTimers);

console.log('\n结果：' + checks.filter(Boolean).length + '/' + checks.length + ' 通过');
process.exitCode = checks.some((c) => !c) ? 1 : 0;
