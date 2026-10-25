// 扫描器 + 强化识别验证
// 1) 每 10 秒扫描一次
// 2) 发现蓝色按钮后随机延迟点击
// 3) 强化识别：能命中以前会漏掉的按钮形态（含图标/换行/零宽字符/包一层 span）
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
  get innerText() { return this._text + ' ' + this.children.map((c) => c.innerText || '').join(' '); }
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
        if (s.startsWith('[') && s.endsWith(']')) { const k = s.slice(1, -1); if (p.attrs && p.attrs[k] !== undefined) return p; }
        if (!s.startsWith('.') && !s.startsWith('[') && p.tagName === s.toUpperCase()) return p;
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

// 通用选择器匹配（支持 tag / .class / [attr] / * 及逗号组合）
function matchSel(el, sel) {
  for (const s of sel.split(',').map((x) => x.trim())) {
    if (s === '*') return true;
    if (s.startsWith('.')) {
      if ((el.className || '').split(/\s+/).includes(s.slice(1))) return true;
    } else if (s.startsWith('[') && s.endsWith(']')) {
      const k = s.slice(1, -1).replace(/[*^$]/g, '');
      if (k && (el.className || '').includes(k)) return true;
    } else if (el.tagName === s.toUpperCase()) return true;
  }
  return false;
}
// 每页可注入自定义的可选元素集合（用于让脚本"看得到"页面元素）
let PAGE_NODES = [];
function docQSA(root, sel) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children) {
      if (matchSel(c, sel)) out.push(c);
      walk(c);
    }
  };
  walk(root);
  // 合并页面注册的虚拟节点（模拟真实页面中脚本能查到的元素）
  for (const n of PAGE_NODES) {
    if (matchSel(n, sel) && !out.includes(n)) out.push(n);
  }
  return out;
}

const doc = new El('#document');
doc.nodeType = 9; doc.readyState = 'complete'; doc.hidden = false;
const body = new El('body'); const html = new El('html');
doc.body = body; doc.documentElement = html; doc.head = new El('head');
html.appendChild(body);
doc.appendChild(html);
doc.createElement = (t) => new El(t);
doc.querySelectorAll = (sel) => docQSA(doc, sel);
doc.querySelector = (sel) => doc.querySelectorAll(sel)[0] || null;
doc.hasFocus = () => true;
// 真实的 elementFromPoint：返回该坐标上"最上层"的可见元素（用几何包含测试模拟）
// 这样脚本的 isReallyClickable() 严格路径能被真实验证，而不是靠降级放行
doc.elementFromPoint = (x, y) => {
  const all = [];
  const walk = (n) => { for (const c of n.children) { all.push(c); walk(c); } };
  walk(doc);
  if (PAGE_NODES) for (const n of PAGE_NODES) if (!all.includes(n)) all.push(n);
  let best = null, bestArea = Infinity;
  for (const el of all) {
    if (!el.isConnected || el._vis === false) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (x < r.left || x > r.left + r.width || y < r.top || y > r.top + r.height) continue;
    const area = r.width * r.height;
    if (area < bestArea) { best = el; bestArea = area; }   // 最小的包含者 = 最内层
  }
  return best;
};

// 视频
const video = new El('video', { rect: { left: 100, top: 300, width: 1800, height: 700 } });
video.duration = 528; video.currentTime = 527.9; video.ended = true;
body.appendChild(video);

// 章节列表
const sections = [];
const mkRing = (state, left, top) => {
  const col = state === 'done' ? 'rgb(103,194,58)' : state === 'progress' ? 'rgb(45,120,245)' : 'rgb(200,200,200)';
  return new El('i', { className: 'status-ring', bg: col, rect: { left: left + 450, top: top + 15, width: 20, height: 20 } });
};
['sec 2.1', 'sec 2.2', 'sec 2.3'].forEach((n, i) => {
  const top = 300 + i * 56;
  const li = new El('li', { className: 'el-menu-item' + (i === 1 ? ' is-active' : ''), rect: { left: 2000, top, width: 480, height: 50 } });
  li.appendChild(new El('span', { className: 'chapter-name', text: n, rect: { left: 2060, top: top + 10, width: 260, height: 30 } }));
  li.appendChild(mkRing(i === 1 ? 'progress' : 'none', 2000, top));
  body.appendChild(li); sections.push(li);
});

let curNext = null, curReplay = null, curDialog = null;

// 构造不同"形态"的按钮，验证强化识别
function mkButton(variant) {
  if (variant === 'plain') {
    return new El('button', {
      className: 'el-button el-button--primary', text: '观看下一章节',
      bg: 'rgb(22,93,255)', rect: { left: 1010, top: 800, width: 180, height: 44 }
    });
  }
  if (variant === 'icon') {
    // 按钮内含图标元素 + 文字（严格全等匹配会漏掉）
    const b = new El('button', { className: 'el-button el-button--primary', bg: 'rgb(22,93,255)', rect: { left: 1010, top: 800, width: 180, height: 44 } });
    b.appendChild(new El('i', { className: 'el-icon-play', rect: { left: 1015, top: 805, width: 16, height: 16 } }));
    b.appendChild(new El('span', { text: '观看下一章节', rect: { left: 1040, top: 810, width: 120, height: 24 } }));
    return b;
  }
  if (variant === 'zwsp') {
    // 文本中夹零宽字符 + 换行
    return new El('button', {
      className: 'el-button el-button--primary', text: '\n  观看\u200b下一\n章节  ',
      bg: 'rgb(22,93,255)', rect: { left: 1010, top: 800, width: 180, height: 44 }
    });
  }
  if (variant === 'nested') {
    // 文本在深层 span 里，按钮本身文本正常
    const b = new El('button', { className: 'ant-btn ant-btn-primary', bg: 'rgb(20,90,240)', rect: { left: 1010, top: 800, width: 180, height: 44 } });
    const s1 = new El('span', { rect: { left: 1020, top: 810, width: 160, height: 24 } });
    const s2 = new El('span', { text: '观看下一章节', rect: { left: 1020, top: 810, width: 160, height: 24 } });
    s1.appendChild(s2); b.appendChild(s1);
    return b;
  }
  if (variant === 'noblue') {
    // 背景色画在父元素上（自身透明）—— 旧版 looksLikePrimary 会漏
    const wrap = new El('div', { className: 'btn-wrap', bg: 'rgb(22,93,255)', rect: { left: 1000, top: 790, width: 200, height: 64 } });
    const b = new El('button', { className: 'el-button', text: '观看下一章节', rect: { left: 1010, top: 800, width: 180, height: 44 } });
    wrap.appendChild(b);
    return wrap;
  }
  return null;
}

function placeDialog(variant) {
  PAGE_NODES.length = 0;
  curDialog = new El('div', { className: 'el-dialog nc-dialog', rect: { left: 790, top: 640, width: 500, height: 240 } });
  curReplay = new El('button', {
    className: 'el-button', text: '重新观看本节', bg: 'rgb(255,255,255)',
    rect: { left: 810, top: 800, width: 180, height: 44 }
  });
  const nb = mkButton(variant);
  curNext = nb;
  // ★ 计数钩子必须在插入 DOM 之前挂好：
  //   插入会同步触发 MutationObserver → 脚本可能立刻点击，晚挂就漏计。
  const watched = (nb.tagName === 'DIV' && nb.children[0]) ? nb.children[0] : nb;
  const cnt = countClicks(watched);
  curDialog.appendChild(curReplay); curDialog.appendChild(nb);
  body.appendChild(curDialog);
  PAGE_NODES.push(curDialog, curReplay, nb);
  if (nb.tagName === 'DIV' && nb.children[0]) PAGE_NODES.push(nb.children[0]);
  return { nb, cnt, watched };
}
function clearDialog() {
  if (curDialog) { curDialog.remove(); PAGE_NODES.length = 0; }
  curNext = null; curReplay = null; curDialog = null;
}
// 点击计数：包装 dispatchEvent 统计真实点击
function countClicks(el) {
  if (!el) return () => 0;
  const orig = el.dispatchEvent.bind(el);
  let n = 0;
  el.dispatchEvent = (ev) => { if (ev.type === 'click') n++; return orig(ev); };
  return () => n;
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
    Math, JSON, Object, Array, String, Number, Promise, isFinite, parseFloat, WeakMap, Error, RegExp, Date: FD,
  };
  sb.window = sb; sb.globalThis = sb; sb.top = sb; sb.self = sb;
  const ctx = vm.createContext(sb);
  let threw = null;
  try { vm.runInContext(SRC, ctx, { filename: 'bl.js' }); } catch (e) { threw = e; }
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

// ===== A. 各种按钮形态都要能被识别并点击 =====
const VARIANTS = [
  ['plain', '标准 button + 纯文本'],
  ['icon', '按钮内含图标元素'],
  ['zwsp', '文本夹零宽字符/换行'],
  ['nested', '文本在深层 span 里'],
  ['noblue', '蓝色背景在父容器上'],
];
console.log('测试 A：强化识别 —— 各种按钮形态');
const variantResults = {};
for (const [v, desc] of VARIANTS) {
  timers.length = 0; OBSERVERS.length = 0;
  clearDialog();
  video.currentTime = 200;
  const { threw, logs } = run();
  advance(3000);
  const { nb, cnt, watched: watchedRef } = placeDialog(v);
  advance(20000);   // 覆盖 10 秒扫描周期 + 随机延迟
  const c = cnt();
  variantResults[v] = c;
  ok('[' + v + '] ' + desc + ' → 被点击', c > 0, c + ' 次');
  if (c === 0) {
    // 诊断：确认 resolveClickable 的落点
    const cands = docQSA(doc, 'button, a, [role="button"], [class*="btn"], [class*="button"], .el-button, div, span');
    console.log('     [diag] 候选数 =', cands.length);
    const wrap = cands.find((el) => el.tagName === 'DIV' && (el.className || '').includes('btn-wrap'));
    if (wrap) {
      console.log('     [diag] wrap.children =', wrap.children.map((x) => x.tagName + '.' + x.className).join(','));
      console.log('     [diag] 内部 button 的 clicked 计数 =', wrap.children[0].clicked || 0);
      console.log('     [diag] wrap 自身的 clicked 计数 =', wrap.clicked || 0);
      console.log('     [diag] 是否同一对象 =', wrap.children[0] === watchedRef);
    }
    console.log('     [diag] 日志:'); logs.slice(-6).forEach((l) => console.log('       ' + l));
  }
  if (threw) console.log('    脚本异常: ' + threw.message);
}

// ===== B0. 普通蓝色按钮没有下一章节弹窗上下文 → 自动点击必须拒绝 =====
console.log('\n测试 B0：普通蓝色按钮不能被当成「观看下一章节」');
{
  timers.length = 0; OBSERVERS.length = 0;
  clearDialog();
  run();
  advance(3000);
  const unrelated = new El('button', {
    className: 'el-button el-button--primary', text: '目录', bg: 'rgb(22,93,255)',
    rect: { left: 1200, top: 640, width: 120, height: 40 }
  });
  let unrelatedClicks = 0;
  const origDispatch = unrelated.dispatchEvent.bind(unrelated);
  unrelated.dispatchEvent = (ev) => {
    if (ev && ev.type === 'click') unrelatedClicks++;
    return origDispatch(ev);
  };
  body.appendChild(unrelated);
  PAGE_NODES.push(unrelated);
  advance(30000);
  ok('无下一章节弹窗时蓝色按钮 0 次点击', unrelatedClicks === 0, unrelatedClicks + ' 次');

  const ownPanel = new El('div', {
    id: 'bl-panel', className: 'panel', rect: { left: 50, top: 50, width: 300, height: 200 }
  });
  const ownLogButton = new El('button', {
    className: 'el-button el-button--primary', text: '已点击「观看下一章节」',
    rect: { left: 100, top: 100, width: 180, height: 40 }
  });
  let ownClicks = 0;
  const ownOrig = ownLogButton.dispatchEvent.bind(ownLogButton);
  ownLogButton.dispatchEvent = (ev) => {
    if (ev && ev.type === 'click') ownClicks++;
    return ownOrig(ev);
  };
  ownPanel.appendChild(ownLogButton);
  body.appendChild(ownPanel);
  PAGE_NODES.push(ownPanel, ownLogButton);
  advance(30000);
  ok('自身面板日志不会成为下一章节候选', ownClicks === 0, ownClicks + ' 次');
  unrelated.remove();
  ownPanel.remove();
  PAGE_NODES.length = 0;
}

// ===== B1. 视频仍在播放时，即使出现完整弹窗也不自动跳 =====
console.log('\n测试 B1：视频中段不因残留弹窗自动跳节');
{
  timers.length = 0; OBSERVERS.length = 0;
  clearDialog();
  video.currentTime = 200; video.ended = false; video.paused = true;
  const { logs } = run();
  advance(3000);
  const { cnt } = placeDialog('plain');
  advance(20000);
  logs.filter((l) => /扫描#|防跳过头|已点击/.test(l)).slice(-8).forEach((l) => console.log('     ' + l));
  ok('视频未到末尾时完整弹窗也不点击', cnt() === 0, cnt() + ' 次');
}

// ===== B. 绝不点「重新观看本节」 =====
console.log('\n测试 B：绝不点「重新观看本节」');
{
  timers.length = 0; OBSERVERS.length = 0;
  clearDialog();
  run();
  advance(3000);
  placeDialog('plain');
  // 单独钩住「重新观看本节」，确认它永远不被点
  const rcOrig = curReplay.dispatchEvent.bind(curReplay);
  let rcN = 0;
  curReplay.dispatchEvent = (ev) => { if (ev.type === 'click') rcN++; return rcOrig(ev); };
  advance(20000);
  ok('重播按钮 0 次点击', rcN === 0, rcN + ' 次');
}

// ===== C. 扫描周期：按钮出现后应在 ~10 秒内被处理 =====
console.log('\n测试 C：扫描周期（10 秒）');
{
  timers.length = 0; OBSERVERS.length = 0;
  clearDialog();
  video.currentTime = 527.9; video.ended = true;
  const { logs } = run();
  advance(3000);
  const appearedAt = now;
  const { nb, cnt } = placeDialog('plain');
  advance(15000);
  const clickedAt = cnt() > 0 ? nb.clickAt : null;
  const gap = clickedAt ? clickedAt - appearedAt : null;
  console.log('  [diag] 出现 → 点击 间隔 =', gap === null ? '未点击' : Math.round(gap) + 'ms',
    '（扫描周期 10s：最坏情况需等到下一个周期点）');
  logs.filter((l) => /扫描#/.test(l)).slice(0, 5).forEach((l) => console.log('     ' + l));
  ok('15 秒内完成点击', cnt() > 0, cnt() + ' 次');
  ok('间隔不超过一个扫描周期 + 随机延迟', gap !== null && gap <= 13000, Math.round(gap) + 'ms');
}

// ===== D. 随机延迟：不是 0ms 秒点 =====
console.log('\n测试 D：点击带随机延迟（拟人）');
{
  const delays = [];
  for (let k = 0; k < 4; k++) {
    timers.length = 0; OBSERVERS.length = 0;
    clearDialog();
    video.currentTime = 527.9; video.ended = true;
    run();
    advance(3000);
    const appeared = now;
    const { nb, cnt } = placeDialog('plain');
    advance(15000);
    if (cnt() > 0 && nb.clickAt) delays.push(nb.clickAt - appeared);
  }
  console.log('  [diag] 各次 出现→点击 延迟 =', JSON.stringify(delays));
  const uniq = Array.from(new Set(delays));
  ok('至少完成 3 次测量', delays.length >= 3, delays.length + ' 次');
  ok('延迟不为固定值（存在随机性）', uniq.length > 1, uniq.length + ' 种不同值');
}

console.log('\n结果：' + checks.filter(Boolean).length + '/' + checks.length + ' 通过');
process.exitCode = checks.some((c) => !c) ? 1 : 0;
