// 点击闸门行为验证（配合 10 秒扫描器）
// 关注点：① 弹窗挂着不走时严格不狂点 ② 连续换节每节都能点 ③ 绝不点「重新观看本节」
// 注：响应延迟相关的断言已移入 verify-scan.mjs（扫描周期用例）
'use strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../beeline-autocourse.user.js', import.meta.url), 'utf8');
let now = 1_700_000_000_000;
const timers = [];
let timerId = 1;
let ACTIVE_VIDEOS = [];
const OBSERVERS = [];
let IN_APPEND = false;

class ET {
  constructor() { this._ls = {}; }
  addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); }
  removeEventListener() {}
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    if (ev.type === 'click') { this.clicked = (this.clicked || 0) + 1; this.clickAt = now; }
    for (const f of (this._ls[ev.type] || []).slice()) { try { f.call(this, ev); } catch (e) {} }
    return true;
  }
}
class CL {
  constructor(el) { this.el = el; }
  _a() { return (this.el.className || '').split(/\s+/).filter(Boolean); }
  contains(c) { return this._a().includes(c); }
  add(c) { if (!this.contains(c)) this.el.className = (this.el.className + ' ' + c).trim(); }
  remove(c) { this.el.className = this._a().filter((x) => x !== c).join(' '); }
}
class El extends ET {
  constructor(tag, o = {}) {
    super();
    this.tagName = tag.toUpperCase(); this.nodeType = 1;
    this.id = o.id || ''; this.className = o.className || '';
    this.classList = new CL(this);
    this._text = o.text || '';
    this.attrs = o.attrs || {};
    this.children = []; this.parentElement = null;
    this._bg = o.bg || 'rgba(0, 0, 0, 0)';
    this.style = { cssText: '' };
    this._vis = o.visible !== false;
    this._rect = o.rect || { left: 10, top: 10, width: 100, height: 30 };
    this.isConnected = true;
    this.offsetHeight = this._rect.height; this.offsetWidth = this._rect.width;
    this._rate = 1; this.muted = false; this.paused = true; this.ended = false;
    this.currentTime = 0; this.duration = 528; this.readyState = 4; this.src = '';
  }
  get playbackRate() { return this._rate; }
  set playbackRate(v) { this._rate = v; }
  get textContent() { return this._text + this.children.map((c) => c.textContent || '').join(''); }
  set textContent(v) { this._text = v; this.children = []; }
  get innerText() { return this._text; }
  set innerHTML(v) { this._html = v; }
  get innerHTML() { return this._html || ''; }
  getAttribute(k) { return this.attrs[k] !== undefined ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getBoundingClientRect() { return this._vis ? this._rect : { left: 0, top: 0, width: 0, height: 0 }; }
  appendChild(c) {
    c.parentElement = this; this.children.push(c);
    if (!IN_APPEND) {
      IN_APPEND = true;
      try { for (const o of OBSERVERS.slice()) { try { o.cb([{ type: 'childList', addedNodes: [c], target: this }], o); } catch (e) {} } }
      finally { IN_APPEND = false; }
    }
    return c;
  }
  remove() {
    this.isConnected = false;
    const markGone = (n) => { n.isConnected = false; (n.children || []).forEach(markGone); };
    (this.children || []).forEach(markGone);
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((x) => x !== this);
  }
  contains(el) { let p = el; while (p) { if (p === this) return true; p = p.parentElement; } return false; }
  closest(sel) {
    let p = this; const ss = sel.split(',').map((s) => s.trim());
    while (p) {
      for (const s of ss) {
        if (s.startsWith('.') && p.classList.contains(s.slice(1))) return p;
        if (!s.startsWith('.') && p.tagName === s.toUpperCase()) return p;
      }
      p = p.parentElement;
    }
    return null;
  }
  matches(sel) {
    for (const s of sel.split(',').map((x) => x.trim())) {
      if (s.startsWith('.') && this.classList.contains(s.slice(1))) return true;
      if (!s.startsWith('.') && this.tagName === s.toUpperCase()) return true;
    }
    return false;
  }
  scrollIntoView() {}
  querySelectorAll(sel) { return docQSA(this, sel); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  play() { this.playCalls = (this.playCalls || 0) + 1; this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  click() { this.dispatchEvent({ type: 'click' }); }
}

// 支持复合选择器：tag.class1.class2 / .class / [attr*="x"] / 逗号组合
function matchOne(el, s) {
  s = s.trim();
  if (!s) return false;
  if (s === '*') return true;
  let rest = s;
  // 前导 tag（可省略）
  const tagM = rest.match(/^[a-zA-Z][a-zA-Z0-9]*/);
  if (tagM) {
    if (el.tagName !== tagM[0].toUpperCase()) return false;
    rest = rest.slice(tagM[0].length);
  }
  // 依次匹配 .class 与 [attr]
  const parts = rest.match(/\.[\w-]+|\[[^\]]+\]/g) || [];
  if (!parts.length) return !!tagM;
  for (const p of parts) {
    if (p.startsWith('.')) {
      if (!(el.className || '').split(/\s+/).includes(p.slice(1))) return false;
    } else {
      const inner = p.slice(1, -1);
      const m = inner.match(/^([\w-]+)([*^$]?)=(?:"([^"]*)"|'([^']*)'|([^\]]*))$/);
      if (m) {
        const [, attr, op, v1, v2, v3] = m;
        const want = v1 !== undefined ? v1 : (v2 !== undefined ? v2 : v3);
        let actual = '';
        if (attr === 'class') actual = el.className || '';
        else actual = (el.attrs && el.attrs[attr]) || el.getAttribute(attr) || '';
        if (op === '*') { if (!String(actual).includes(want)) return false; }
        else if (op === '^') { if (!String(actual).startsWith(want)) return false; }
        else if (op === '$') { if (!String(actual).endsWith(want)) return false; }
        else { if (String(actual) !== want) return false; }
      } else {
        if (el.attrs && el.attrs[inner] === undefined && !el.getAttribute(inner)) return false;
      }
    }
  }
  return true;
}
function matchSel(el, sel) {
  for (const s of sel.split(',')) { if (matchOne(el, s)) return true; }
  return false;
}
let PAGE_NODES = [];
function docQSA(root, sel) {
  const out = [];
  const walk = (n) => { for (const c of n.children) { if (matchSel(c, sel)) out.push(c); walk(c); } };
  walk(root);
  for (const n of PAGE_NODES) if (matchSel(n, sel) && !out.includes(n)) out.push(n);
  return out;
}

const doc = new El('#document');
doc.nodeType = 9; doc.readyState = 'complete'; doc.hidden = false;
const body = new El('body'); const html = new El('html');
doc.body = body; doc.documentElement = html; doc.head = new El('head');
html.appendChild(body);
doc.appendChild(html);        // ★ 必须把 html 挂到 document 上，否则 docQSA(doc) 遍历不到任何元素
doc.createElement = (t) => new El(t);
doc.querySelectorAll = (sel) => docQSA(doc, sel);
doc.querySelector = (sel) => doc.querySelectorAll(sel)[0] || null;
doc.hasFocus = () => true;

const video = new El('video', { rect: { left: 100, top: 300, width: 1800, height: 700 } });
video.duration = 528; video.currentTime = 527.9; video.ended = true;
body.appendChild(video);

const sections = [];
const mkRing = (state, left, top) => {
  const col = state === 'done' ? 'rgb(103,194,58)' : state === 'progress' ? 'rgb(45,120,245)' : 'rgb(200,200,200)';
  return new El('i', { className: 'status-ring', bg: col, rect: { left: left + 450, top: top + 15, width: 20, height: 20 } });
};
['sec A', 'sec B', 'sec C'].forEach((n, i) => {
  const top = 300 + i * 56;
  const li = new El('li', { className: 'el-menu-item' + (i === 0 ? ' is-active' : ''), rect: { left: 2000, top, width: 480, height: 50 } });
  li.appendChild(new El('span', { className: 'chapter-name', text: n, rect: { left: 2060, top: top + 10, width: 260, height: 30 } }));
  li.appendChild(mkRing('progress', 2000, top));
  body.appendChild(li); sections.push(li);
});

let curDialog = null, curNext = null, curReplay = null;
const NAV_LOG = [];

function placeDialog() {
  PAGE_NODES.length = 0;
  curDialog = new El('div', { className: 'el-dialog', rect: { left: 790, top: 640, width: 500, height: 240 } });
  curReplay = new El('button', {
    className: 'el-button', text: '重新观看本节', bg: 'rgb(255,255,255)',
    rect: { left: 810, top: 800, width: 180, height: 44 }
  });
  curNext = new El('button', {
    className: 'el-button el-button--primary', text: '观看下一章节', bg: 'rgb(22,93,255)',
    rect: { left: 1010, top: 800, width: 180, height: 44 }
  });
  const origNext = curNext.dispatchEvent.bind(curNext);
  let n = 0;
  // 真实平台：点击后约 1 秒完成换节。
  // 这里用 sandbox 的虚拟定时器（宿主 setTimeout 不随 advance 推进，会导致时序错乱）。
  curNext.dispatchEvent = (ev) => {
    if (ev.type === 'click') {
      n++;
      NAV_LOG.push({ evt: 'click', t: now });
      // 挂到虚拟定时器队列，由 advance() 驱动（真实平台点击后约 1 秒完成换节）
      timers.push({
        id: timerId++, at: now + 900,
        fn: () => { NAV_LOG.push({ evt: 'nav', t: now, ok: nextSection() }); }
      });
    }
    return origNext(ev);
  };
  curDialog.appendChild(curReplay); curDialog.appendChild(curNext);
  PAGE_NODES.push(curDialog, curReplay, curNext);
  body.appendChild(curDialog);
  return { cnt: () => n, el: curNext };
}
function clearDialog() {
  if (curDialog) curDialog.remove();
  PAGE_NODES.length = 0;
  curDialog = null; curNext = null; curReplay = null;
}
function nextSection() {
  const cur = sections.findIndex((s) => s.classList.contains('is-active'));
  if (cur >= 0 && cur + 1 < sections.length) {
    sections[cur].classList.remove('is-active');
    sections[cur + 1].classList.add('is-active');
    return true;
  }
  return false;
}

function run() {
  ACTIVE_VIDEOS = [video];
  class FD extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
  const logs = [];
  const sb = {
    document: doc, Date: FD, innerWidth: 2549, innerHeight: 1422,
    localStorage: { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = v; } },
    console: { log: (...a) => logs.push(a.join(' ')), error: () => {}, warn: () => {} },
    setTimeout: (fn, ms) => { const id = timerId++; timers.push({ id, fn, at: now + (ms || 0) }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    setInterval: (fn, ms) => { const id = timerId++; timers.push({ id, fn, at: now + (ms || 1), every: ms || 1 }); return id; },
    clearInterval: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; }
      observe() { OBSERVERS.push(this); }
      disconnect() { const i = OBSERVERS.indexOf(this); if (i >= 0) OBSERVERS.splice(i, 1); }
    },
    PointerEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    MouseEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    KeyboardEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    getComputedStyle: (el) => ({
      display: 'block', visibility: 'visible', opacity: '1',
      backgroundColor: (el && el._bg) || 'rgba(0,0,0,0)',
      color: 'rgb(0,0,0)', borderColor: 'rgba(0,0,0,0)', fill: '', stroke: ''
    }),
    HTMLMediaElement: El,
    sessionStorage: { _d: {}, getItem(k) { return this._d[k] || null; }, setItem() {}, removeItem() {} },
    location: { reload: () => {}, hash: '' },
    Math, JSON, Object, Array, String, Number, Promise, isFinite, parseFloat, WeakMap, Error, RegExp,
  };
  sb.window = sb; sb.globalThis = sb; sb.top = sb; sb.self = sb;
  const ctx = vm.createContext(sb);
  let threw = null;
  try { vm.runInContext(SRC.replace('function boot() {',
    'globalThis.__sig = sectionSignature; globalThis.__active = activeMenuItem; globalThis.__gate = function(){return {open:gateOpen};}; function boot() {'),
    ctx, { filename: 'bl.js' }); } catch (e) { threw = e; }
  return { sb, threw, logs };
}

function advance(ms) {
  const end = now + ms; let g = 0; let lastT = now;
  while (g++ < 500000) {
    const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at);
    if (!due.length) break;
    const t = due[0];
    const step = Math.max(0, t.at - lastT);
    for (const v of ACTIVE_VIDEOS) {
      if (!v.paused && !v.ended && isFinite(v.duration)) v.currentTime = Math.min(v.duration, v.currentTime + (step / 1000) * (v._rate || 1));
    }
    now = Math.max(now, t.at); lastT = now;
    if (t.every) { t.at = now + t.every; } else { timers.splice(timers.indexOf(t), 1); }
    try { t.fn(); } catch (e) {}
  }
  now = end;
}

const checks = [];
const ok = (n, c, x) => { checks.push(c); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x ? '  -> ' + x : '')); };

// ===== 1. 弹窗挂着不走 → 严格限次 =====
console.log('测试 1：弹窗挂着不走时不狂点');
{
  timers.length = 0; OBSERVERS.length = 0; clearDialog();
  run();
  advance(2000);
  const { cnt } = placeDialog();
  advance(30000);
  const c1 = cnt();
  advance(120000);   // 再挂 2 分钟
  const c2 = cnt();
  console.log('  [diag] 30 秒 =', c1, ' 150 秒累计 =', c2);
  ok('30 秒内有点击', c1 > 0, c1 + ' 次');
  // 设计变更说明：退避从"指数增长到几分钟"改为"温和 6~30 秒"，
  // 目的是修复"按钮在却长期卡在退避中"的问题（用户实测反馈）。
  // 现在的保证是：点击频率**不超过扫描周期**（每 10 秒最多一次），
  // 而不是把次数压到个位数。150 秒 / 10 秒周期 = 理论上限 15 次。
  const maxByScanPeriod = Math.ceil(150 / Math.max(2, 10)) + 3;
  ok('150 秒内点击不超过扫描周期上限（<= ' + maxByScanPeriod + ' 次）', c2 <= maxByScanPeriod,
    c2 + ' 次（无闸门时约 75 次）');
}

// ===== 2. 连续换节 → 每节都能点 =====
console.log('\n测试 2：连续换节每节都能点');
{
  timers.length = 0; OBSERVERS.length = 0; clearDialog();
  const { logs, sb } = run();
  advance(2000);
  const per = [];
  let mark = 0;
  for (let i = 0; i < 3; i++) {
    // 每轮重置到第 1 节，确保"点击→换节"这个因果关系成立（避免多轮累积到最后一节后无法再换）
    sections.forEach((s, k) => { if (k === 0) s.classList.add('is-active'); else s.classList.remove('is-active'); });
    NAV_LOG.length = 0;
    placeDialog();
    advance(16000);    // 扫描周期 + 随机延迟 + 换节(0.9s) + 确认采样(2.5s)
    per.push(logs.slice(mark).filter((l) => l.indexOf('已点击「观看下一章节」') !== -1).length);
    mark = logs.length;
    clearDialog();
    advance(4000);     // 闸门解锁
  }
  console.log('  [diag] 每节点击日志数 =', JSON.stringify(per));
  console.log('  [diag] 全部相关日志:');
  logs.filter((l) => /已点击|解锁|跳转成功|退避|扫描#/.test(l)).slice(0, 20).forEach((l, i) => console.log('     ' + i + ': ' + l));
  ok('每一节都产生点击', per.every((c) => c > 0), JSON.stringify(per));
  console.log('  [diag] 换节时刻表 =', JSON.stringify(NAV_LOG.map((x) => ({ t: Math.round(x.t - 1700000000000), e: x.evt || (x.ok ? 'nav-ok' : 'nav-fail') }))));
  console.log('  [diag] 脚本 sectionSignature() =', sb.__sig ? sb.__sig() : '(未暴露)');
  console.log('  [diag] 脚本 activeMenuItem() 文本 =', sb.__active ? (sb.__active() ? sb.__active().textContent : 'null') : '(未暴露)');
  console.log('  [diag] 闸门状态 =', sb.__gate ? JSON.stringify(sb.__gate()) : '(未暴露)');
  console.log('  [diag] 含 [CJ] 的日志 =', JSON.stringify(logs.filter((l) => l.indexOf('[CJ]') !== -1).slice(0, 8)));
}

// ===== 3. 绝不点「重新观看本节」 =====
console.log('\n测试 3：绝不点「重新观看本节」');
{
  timers.length = 0; OBSERVERS.length = 0; clearDialog();
  run();
  advance(2000);
  const { cnt } = placeDialog();
  const ro = curReplay.dispatchEvent.bind(curReplay);
  let rn = 0;
  curReplay.dispatchEvent = (ev) => { if (ev.type === 'click') rn++; return ro(ev); };
  advance(40000);
  ok('下一章节按钮被点击', cnt() > 0, cnt() + ' 次');
  ok('重播按钮 0 次', rn === 0, rn + ' 次');
}

console.log('\n结果：' + checks.filter(Boolean).length + '/' + checks.length + ' 通过');
process.exitCode = checks.some((c) => !c) ? 1 : 0;
