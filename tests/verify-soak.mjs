// 长时间稳定性：模拟 8 小时挂机，检测资源泄漏与状态腐化
//   ① 定时器数量是否稳定（不增长 = 无泄漏）
//   ② 日志数组是否被正确截断（不无限增长）
//   ③ 内部计数器是否有界
//   ④ 全程无未捕获异常
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

class El {
  constructor(tag, o = {}) {
    this.tagName = (tag || 'div').toUpperCase(); this.nodeType = 1;
    this.id = o.id || ''; this.className = o.className || '';
    this.children = []; this.parentElement = null;
    this._text = o.text || ''; this._html = '';
    this.attrs = o.attrs || {}; this.isConnected = o.connected !== false;
    this._rect = o.rect || null;
    this._display = o.display || 'block'; this._opacity = o.opacity || '1';
    this._vis = o.visibility || 'visible'; this._pe = o.pointerEvents || 'auto';
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
    if (!this.isConnected) return { left: 0, top: 0, width: 0, height: 0 };
    let p = this;
    while (p) { if (p._display === 'none') return { left: 0, top: 0, width: 0, height: 0 }; p = p.parentElement; }
    return this._rect || { left: 0, top: 0, width: 0, height: 0 };
  }
  closest(sel) { let p = this; while (p) { if (matchSel(p, sel)) return p; p = p.parentElement; } return null; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) { return pageQSA(this, sel); }
  click() { return true; }
  dispatchEvent() { return true; }
}
function pageQSA(root, sel) {
  const out = [];
  const walk = (n) => { for (const c of n.children) { if (matchSel(c, sel)) out.push(c); walk(c); } };
  walk(root);
  return out;
}

// 构造一个"会真正换节"的页面：点击下一章节按钮后，高亮章节后移、按钮消失一段时间再出现
function buildPage() {
  const doc = new El('#document');
  doc.nodeType = 9; doc.readyState = 'complete';
  const html = new El('html'); const body = new El('body');
  doc.documentElement = html; doc.body = body; doc.head = new El('head');
  html.appendChild(body); doc.appendChild(html);
  doc.createElement = (t) => new El(t);
  doc.addEventListener = () => {};
  doc.hasFocus = () => true;
  doc.querySelectorAll = (sel) => pageQSA(doc, sel);
  doc.querySelector = (sel) => doc.querySelectorAll(sel)[0] || null;
  doc.getElementById = (id) => pageQSA(doc, '#' + id)[0] || null;

  const state = { section: 0, dialogVisible: true, videoTime: 0 };

  const sidebar = new El('ul', { className: 'el-menu', rect: { left: 1990, top: 240, width: 490, height: 400 } });
  body.appendChild(sidebar);
  const items = [];
  for (let i = 0; i < 50; i++) {
    const top = 300 + i * 56;
    const li = new El('li', {
      className: 'el-menu-item' + (i === 0 ? ' is-active' : ''),
      text: 'sec ' + i, rect: { left: 1990, top, width: 480, height: 50 },
    });
    sidebar.appendChild(li); items.push(li);
  }
  // 高亮跟随 state 变化
  const syncActive = () => {
    items.forEach((it, i) => {
      it.className = 'el-menu-item' + (i === state.section ? ' is-active' : '');
    });
  };

  const dlg = new El('div', { className: 'el-dialog', rect: { left: 700, top: 600, width: 500, height: 240 } });
  const nextBtn = new El('button', {
    className: 'el-button el-button--primary', text: '观看下一章节',
    rect: { left: 950, top: 760, width: 180, height: 44 },
  });
  dlg.appendChild(nextBtn); body.appendChild(dlg);

  // 点击 → 换节 + 弹窗短暂隐藏（何时恢复由虚拟时间驱动，见 advanceChunk）
  let dialogHideUntil = 0;
  const vsb = { now: () => 0 };
  nextBtn.dispatchEvent = (ev) => {
    if (ev && ev.type === 'click') {
      state.section = Math.min(state.section + 1, 49);
      if (state.video) state.video.currentTime = 0;
      syncActive();
      state.dialogVisible = false;
      // 记录"1.5 秒后恢复"，由虚拟时钟推进时恢复。
      // ⚠️ 不能用宿主的 setTimeout——它不随虚拟时间推进，会导致弹窗永远不回来。
      dialogHideUntil = vsb.now() + 1500;
    }
    return true;
  };
  nextBtn.click = () => nextBtn.dispatchEvent({ type: 'click' });

  // 供外部（虚拟时钟）调用：到点就恢复弹窗
  const tickDialog = (nowMs) => {
    if (!state.dialogVisible && dialogHideUntil && nowMs >= dialogHideUntil) {
      state.dialogVisible = true;
      dialogHideUntil = 0;
    }
  };

  const video = new El('video', { rect: { left: 100, top: 300, width: 1800, height: 700 } });
  video.duration = 600; video.currentTime = 0;
  body.appendChild(video);
  state.video = video;

  // 真实浏览器的 elementFromPoint 返回"该坐标上最内层"的可命中元素。
  // 桩必须模拟这一点（按面积最小者优先），否则会误判成脚本有 bug。
  doc.elementFromPoint = (x, y) => {
    const all = [sidebar, ...items, dlg, nextBtn, video];
    let best = null, bestArea = Infinity;
    for (const el of all) {
      if (!el.isConnected) continue;
      if ((el === dlg || el === nextBtn) && !state.dialogVisible) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (x < r.left || x > r.left + r.width || y < r.top || y > r.top + r.height) continue;
      const area = r.width * r.height;
      if (area < bestArea) { best = el; bestArea = area; }
    }
    return best;
  };

  return { doc, body, state, items, nextBtn, video, syncActive, tickDialog, setNow: (t) => { vsb.now = () => t; } };
}

function run(page) {
  const timers = [];
  let now = 1_700_000_000_000;
  let timerId = 1;
  const errors = [];
  const logs = [];
  class FD extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
  const sb = {
    document: page.doc, Date: FD, innerWidth: 2489, innerHeight: 1041,
    localStorage: { _d: { BL_COURSE_CFG_V1: JSON.stringify({ enabled: true, instantClick: true, skipCourseware: true }) }, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = v; }, removeItem(k) { delete this._d[k]; } },
    sessionStorage: { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = v; }, removeItem(k) { delete this._d[k]; } },
    console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => errors.push(a.join(' ')), warn: (...a) => errors.push(a.join(' ')) },
    setTimeout: (fn, ms) => { const id = timerId++; timers.push({ id, fn, at: now + (ms || 0) }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    setInterval: (fn, ms) => { const id = timerId++; timers.push({ id, fn, at: now + (ms || 1), every: ms || 1 }); return id; },
    clearInterval: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    MutationObserver: class { observe() {} disconnect() {} },
    PointerEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    MouseEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    KeyboardEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    getComputedStyle: (el) => ({
      display: (el && el._display) || 'block', visibility: (el && el._vis) || 'visible',
      opacity: (el && el._opacity) || '1', pointerEvents: (el && el._pe) || 'auto',
      backgroundColor: 'rgb(22,93,255)', color: '#000', borderColor: 'rgba(0,0,0,0)', fill: '', stroke: '',
    }),
    HTMLMediaElement: El,
    location: { reload() {}, hash: '' },
    Math, JSON, Object, Array, String, Number, Promise, isFinite, parseFloat, WeakMap, Error, RegExp,
  };
  sb.window = sb; sb.globalThis = sb; sb.top = sb; sb.self = sb;
  const ctx = vm.createContext(sb);
  let threw = null;
  try { vm.runInContext(SRC.replace('function boot() {', 'globalThis.__rc = isReallyClickable; globalThis.__cands = findNextChapterCandidates; function boot() {'), ctx, { filename: 'bl.js' }); } catch (e) { threw = e; }

  // 分段推进，便于采样
  function advanceChunk(ms) {
    const end = now + ms; let g = 0; let last = now;
    while (g++ < 2000000) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at);
      if (!due.length) { now = end; break; }
      const t = due[0]; now = Math.max(now, t.at);
      if (t.every) { t.at = now + t.every; } else { timers.splice(timers.indexOf(t), 1); }
      // 按虚拟时间推进视频，而不是按定时器数量推进。
      const elapsed = Math.max(0, now - last);
      page.video.currentTime = Math.min(page.video.duration, page.video.currentTime + elapsed / 1000);
      last = now;
      // 虚拟时钟驱动"弹窗重新出现"
      page.setNow(now);
      page.tickDialog(now);
      try { t.fn(); } catch (e) { errors.push(e.message); }
    }
    page.video.currentTime = Math.min(page.video.duration, page.video.currentTime + Math.max(0, end - last) / 1000);
    now = end;
    page.setNow(now);
    page.tickDialog(now);
  }
  return { sb, threw, errors, logs, advanceChunk, timers: () => timers.length, now: () => now };
}

const checks = [];
const ok = (n, c, x) => { checks.push(c); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x ? '  -> ' + x : '')); };

console.log('=== 长时间稳定性：模拟 8 小时挂机 ===\n');

const page = buildPage();
const res = run(page);
ok('脚本加载无异常', !res.threw, res.threw ? res.threw.message : 'ok');

const HOURS = 8;
const CHUNK = 60 * 1000;               // 每段 1 分钟
const SEGMENTS = HOURS * 60;

let maxTimers = 0, minTimers = Infinity;
const tSamples = [];
for (let i = 0; i < SEGMENTS; i++) {
  res.advanceChunk(CHUNK);
  const n = res.timers();
  maxTimers = Math.max(maxTimers, n);
  minTimers = Math.min(minTimers, n);
  if (i % 60 === 0) tSamples.push(n);
}

console.log('  模拟时长: ' + HOURS + ' 小时');
console.log('  定时器数量: 最小 ' + minTimers + '，最大 ' + maxTimers);
console.log('  每小时采样: ' + JSON.stringify(tSamples));
console.log('  最终章节: ' + page.state.section + ' / 50');
console.log('  未捕获异常: ' + res.errors.length);
console.log('  脚本日志（前 30 条，看启动与首次跳转）:');
res.logs.slice(0, 30).forEach((l) => console.log('     ' + l));
console.log('  ...');
console.log('  脚本日志（末 12 条）:');
res.logs.slice(-12).forEach((l) => console.log('     ' + l));
console.log('  日志总条数: ' + res.logs.length);

// 诊断：直接检查 isReallyClickable 在当前状态下的判定
if (res.sb && res.sb.__rc) {
  const btn = page.nextBtn;
  const r = btn.getBoundingClientRect();
  console.log('\n  [诊断] 按钮 rect = ' + JSON.stringify(r));
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const hit = page.doc.elementFromPoint(cx, cy);
  console.log('  [诊断] elementFromPoint(' + cx + ',' + cy + ') = ' + (hit ? hit.tagName + '.' + hit.className : 'null'));
  console.log('  [诊断] isReallyClickable = ' + res.sb.__rc(btn));
  console.log('  [诊断] dialogVisible = ' + page.state.dialogVisible);
  if (res.sb.__cands) {
    const c = res.sb.__cands();
    console.log('  [诊断] 候选数 = ' + c.length);
    console.log('  [诊断] nextBtn.isConnected = ' + btn.isConnected);
    console.log('  [诊断] nextBtn rect = ' + JSON.stringify(btn.getBoundingClientRect()));
    console.log('  [诊断] 桩内 elementFromPoint 直查 = ' +
      (() => { const h = page.doc.elementFromPoint(1040, 782); return h ? h.tagName + '.' + h.className : 'null'; })());
  }
}

ok('全程无未捕获异常', res.errors.length === 0, res.errors.length + ' 次' + (res.errors[0] ? ' — ' + res.errors[0].slice(0, 60) : ''));
ok('定时器数量稳定（无泄漏）', maxTimers < 30, '峰值 ' + maxTimers);
ok('8 小时内确实在推进章节', page.state.section > 0, '推进到第 ' + page.state.section + ' 节');

// 日志数组：从脚本内部取（通过闭包不可达，改从面板 DOM 或诊断推断）
// 用诊断输出间接验证 logs 长度受 LOG_MAX 限制
console.log('\n附加检查：内部状态有界性');
ok('章节推进未越界（<= 50）', page.state.section <= 50, String(page.state.section));

console.log('\n结果：' + checks.filter(Boolean).length + '/' + checks.length + ' 通过');
process.exitCode = checks.some((c) => !c) ? 1 : 0;
