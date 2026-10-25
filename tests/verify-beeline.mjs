// 芯位蜜线专用脚本验证 v2
// 按用户真实截图重建 DOM：
//   - 「下一章节:」弹窗，含 [↻ 重新观看本节]（白底次要）和 [观看下一章节]（蓝色主按钮）
//   - 右侧目录列表 li.el-menu-item + 状态圆环（绿✓完成 / 蓝●进行中 / 灰○未开始）
//   - 播放器右下角 "1x" 倍速控件
'use strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../beeline-autocourse.user.js', import.meta.url), 'utf8');
let now = 1_700_000_000_000;
const timers = [];
let timerId = 1;
let ACTIVE_VIDEOS = [];

// ---- 通用选择器匹配（与 verify-anomaly.mjs 同一实现）----
// 匹配单个子选择器：tag.class[attr*="x"] 组合
function matchOne(el, s) {
  let rest = s;
  const tagM = rest.match(/^[a-zA-Z][a-zA-Z0-9]*/);
  if (tagM) {
    if (el.tagName !== tagM[0].toUpperCase()) return false;
    rest = rest.slice(tagM[0].length);
  }
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
        else if (m[2] === '^') { if (!String(actual).startsWith(want)) return false; }
        else if (m[2] === '$') { if (!String(actual).endsWith(want)) return false; }
        else { if (String(actual) !== want) return false; }
      } else if (!el.getAttribute(inner)) return false;
    }
  }
  return true;
}
// ★ 逗号列表：命中任一即 true，未命中要继续试下一个（旧实现直接 return false 是 bug）
function matchSel(el, sel) {
  for (const s of sel.split(',').map((x) => x.trim())) {
    if (!s) continue;
    if (s === '*') return true;
    if (matchOne(el, s)) return true;
  }
  return false;
}

class ET {
  constructor() { this._ls = {}; }
  addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); }
  removeEventListener() {}
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    if (ev.type === 'click') this.clicked = (this.clicked || 0) + 1;
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
    this._fg = o.fg || 'rgb(0, 0, 0)';
    this.style = { cssText: '', setProperty() {}, removeProperty() {} };
    this._vis = o.visible !== false;
    this._rect = o.rect || { left: 10, top: 10, width: 100, height: 30 };
    this.isConnected = true;
    this.offsetHeight = this._rect.height; this.offsetWidth = this._rect.width;
    this.scrollHeight = 1000; this.clientHeight = 500; this.scrollTop = 0; this.offsetTop = 0;
    this._html = ''; this.muted = false; this.paused = true; this.ended = false;
    this.currentTime = 0; this.duration = NaN; this._rate = 1; this.readyState = 4;
    this.src = o.src || '';
  }
  get playbackRate() { return this._rate; }
  set playbackRate(v) { this._rateSetBy = (this._rateSetBy || 0) + 1; this._rate = v; }
  get innerText() { return this._text + ' ' + this.children.map((c) => c.innerText || c.textContent || '').join(' '); }
  get textContent() { return this._text + ' ' + this.children.map((c) => c.textContent || '').join(' '); }
  set textContent(v) { this._text = v; this.children = []; }
  set innerHTML(v) { this._html = v; }
  get innerHTML() { return this._html; }
  getAttribute(k) { return this.attrs[k] !== undefined ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getBoundingClientRect() { return this._vis ? this._rect : { left: 0, top: 0, width: 0, height: 0 }; }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  remove() { this.isConnected = false; }
  contains(el) { let p = el; while (p) { if (p === this) return true; p = p.parentElement; } return false; }
  get nextElementSibling() {
    if (!this.parentElement) return null;
    const i = this.parentElement.children.indexOf(this);
    return i >= 0 ? (this.parentElement.children[i + 1] || null) : null;
  }
  closest(sel) {
    let p = this; const sels = sel.split(',').map((s) => s.trim());
    while (p) {
      for (const s of sels) {
        if (s.startsWith('.') && p.classList.contains(s.slice(1))) return p;
        if (!s.startsWith('.') && p.tagName === s.toUpperCase()) return p;
      }
      p = p.parentElement;
    }
    return null;
  }
  matches(sel) {
    return matchSel(this, sel);
  }
  scrollIntoView() {}
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (matchSel(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  play() { this.playCalls = (this.playCalls || 0) + 1; this.paused = false; return Promise.resolve(); }
  pause() { this.pauseCalls = (this.pauseCalls || 0) + 1; this.paused = true; }
  click() { this.dispatchEvent({ type: 'click' }); }
}

// 状态环：绿✓ / 蓝● / 灰○
function mkRing(state, rowLeft, rowTop) {
  const col = state === 'done' ? 'rgb(103, 194, 58)' : state === 'progress' ? 'rgb(45, 120, 245)' : 'rgb(200, 200, 200)';
  // 状态环位于行尾：left = 行左 + 行宽 - 30
  const r = new El('i', {
    className: 'status-ring', bg: col, fg: col,
    rect: { left: (rowLeft || 2000) + (480 - 30), top: (rowTop || 300) + 15, width: 20, height: 20 }
  });
  return r;
}

function buildPage(opts = {}) {
  const doc = new El('#document');
  doc.nodeType = 9; doc.readyState = 'complete'; doc.hidden = false; doc.visibilityState = 'visible';
  const body = new El('body'); const html = new El('html'); const head = new El('head');
  doc.body = body; doc.documentElement = html; doc.head = head;
  html.appendChild(head); html.appendChild(body);
  doc.appendChild(html);   // ★ 必须挂到 document 上，否则 querySelectorAll 遍历不到任何元素
  doc.createElement = (t) => new El(t);

  // ===== 播放器区域 =====
  const player = new El('div', { className: 'player', rect: { left: 40, top: 250, width: 1900, height: 800 } });
  const video = new El('video', { rect: { left: 100, top: 300, width: 1800, height: 700 } });
  video.duration = opts.duration !== undefined ? opts.duration : 528;  // 截图：08分48秒
  video.currentTime = opts.currentTime || 0;
  if (opts.noVideo !== true) player.appendChild(video);

  // 播放器控制条：右下角 "1x" 倍速控件
  const rateCtl = new El('div', { className: 'rate-control', text: '1x', rect: { left: 1720, top: 1010, width: 40, height: 24 } });
  const rateMenu = new El('div', { className: 'rate-menu', visible: false });
  const rateOpts = {};
  for (const r of [0.75, 1, 1.25, 1.5, 2]) {
    const o = new El('div', { text: r + 'x', visible: false, rect: { left: 1700, top: 1000, width: 60, height: 26 } });
    rateOpts[r] = o; rateMenu.appendChild(o);
  }
  player.appendChild(rateCtl); player.appendChild(rateMenu);
  body.appendChild(player);

  // ===== 「下一章节:」弹窗（截图实测结构）=====
  const dialog = new El('div', { className: 'el-dialog next-chapter-dialog', rect: { left: 790, top: 640, width: 500, height: 240 } });
  const dlgTitle = new El('div', { className: 'dialog-title', text: '下一章节：' });
  const dlgNext = new El('div', { className: 'next-preview', text: '2.3实验室用气安全' });
  const replayBtn = new El('button', {
    className: 'el-button replay-btn', text: '重新观看本节',
    bg: 'rgb(255, 255, 255)', fg: 'rgb(96, 98, 102)',
    rect: { left: 810, top: 800, width: 180, height: 44 }
  });
  const nextBtn = new El('button', {
    className: 'el-button el-button--primary next-chapter-btn', text: '观看下一章节',
    bg: 'rgb(22, 93, 255)', fg: 'rgb(255, 255, 255)',
    rect: { left: 1010, top: 800, width: 180, height: 44 }
  });
  dialog.appendChild(dlgTitle); dialog.appendChild(dlgNext);
  dialog.appendChild(replayBtn); dialog.appendChild(nextBtn);
  if (opts.showDialog !== false) body.appendChild(dialog);

  // 点击"观看下一章节"时模拟平台换节
  let episode = 0;
  const origNextDispatch = nextBtn.dispatchEvent.bind(nextBtn);
  nextBtn.dispatchEvent = (ev) => {
    if (ev.type === 'click' && opts.simulateNav !== false) {
      episode++;
      video.currentTime = 0; video.ended = false;
      // 高亮移到下一个章节
      if (doc._sections) {
        const cur = doc._sections.findIndex((s) => s.classList.contains('is-active'));
        if (cur >= 0 && cur + 1 < doc._sections.length) {
          doc._sections[cur].classList.remove('is-active');
          doc._sections[cur + 1].classList.add('is-active');
        }
      }
    }
    return origNextDispatch(ev);
  };

  // ===== 右侧目录 =====
  const sidebar = new El('div', { className: 'chapter-sidebar' });
  const list = new El('ul', { className: 'el-menu' });
  doc._sections = [];
  const addSection = (name, state, active) => {
    const rowTop = 300 + doc._sections.length * 56;
    const li = new El('li', {
      className: 'el-menu-item' + (active ? ' is-active' : ''),
      rect: { left: 2000, top: rowTop, width: 480, height: 50 }
    });
    li.appendChild(new El('span', { className: 'chapter-name', text: name, rect: { left: 2060, top: rowTop + 10, width: 260, height: 30 } }));
    li.appendChild(new El('span', { className: 'duration', text: '10 分 10 秒', rect: { left: 2340, top: rowTop + 12, width: 100, height: 26 } }));
    li.appendChild(mkRing(state, 2000, rowTop));
    list.appendChild(li);
    doc._sections.push(li);
    return li;
  };
  addSection('2.1实验室用电安全', 'done', false);
  addSection('2.2实验室用水安全', opts.activeState || 'progress', true);
  addSection('2.3实验室用气安全', 'none', false);
  sidebar.appendChild(list);
  body.appendChild(sidebar);

  const sidebarSwitch = new El('div', { className: 'course-sidebar-switch' });
  body.appendChild(sidebarSwitch);

  // ===== querySelectorAll 路由 =====
  // 通用选择器匹配：支持 tag.class[attr*="x"] 与逗号列表。
  // 用白名单路由太脆弱（脚本每加一个选择器就得改测试），这里改用真实语义匹配。
  doc.querySelectorAll = (sel) => {
    const nodes = [];
    const collect = (n) => { for (const c of n.children) { nodes.push(c); collect(c); } };
    collect(doc);
    // 额外的"注入节点"（未挂在树上的，如异常弹窗）
    if (doc._extraNodes) for (const e of doc._extraNodes) if (!nodes.includes(e)) nodes.push(e);
    return nodes.filter((el) => matchSel(el, sel));
  };
  doc.querySelector = (sel) => doc.querySelectorAll(sel)[0] || null;
  doc.hasFocus = () => true;

  return { doc, body, video, nextBtn, replayBtn, rateCtl, rateOpts, dialog, sections: doc._sections, sidebarSwitch };
}

function run(script, page) {
  const { doc } = page;
  ACTIVE_VIDEOS = page.video ? [page.video] : [];
  script = script
    .replace('function mainTick() {', 'function mainTick() { try { globalThis.__t = globalThis.__t || []; globalThis.__t.push("tick"); } catch(e){}')
    // 暴露内部函数与配置，供测试直接驱动（真实环境不需要）
    .replace('function boot() {', 'globalThis.__applyRate = applyRate; globalThis.__cfg = cfg; globalThis.__ringState = ringState; globalThis.__sectionComplete = sectionComplete; globalThis.__isStatic = isStaticOrPpt; globalThis.__attemptCourseware = attemptCoursewareSkip; globalThis.__findNext = findNextMenuItem; globalThis.__blocked = () => blockedByCollapsedGroup; globalThis.__activeMenu = activeMenuItem; globalThis.__hasDuration = hasVideoDuration; globalThis.__looksDoc = looksLikeDocumentItem; globalThis.__videoEvidence = hasVideoPageEvidence; function boot() {')
    .replace("if (!sectionComplete()) { consecutiveJumps = 0; updateStatus(); return; }",
      'if (!sectionComplete()) { consecutiveJumps = 0; updateStatus(); try{globalThis.__t.push("notComplete");}catch(e){} return; }')
    .replace("log('本节已完成，准备跳转');",
      'try{globalThis.__t.push("COMPLETE");}catch(e){} log(\'本节已完成，准备跳转\');');

  class FD extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
  const reloads = { count: 0 };
  const logs = [];
  const sb = {
    document: doc, Date: FD, innerWidth: 2549, innerHeight: 1422,
    localStorage: { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = v; } },
    console: { log: (...a) => logs.push(a.join(' ')), error: () => {}, warn: () => {} },
    setTimeout: (fn, ms) => { const id = timerId++; timers.push({ id, fn, at: now + (ms || 0) }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    setInterval: (fn, ms) => { const id = timerId++; timers.push({ id, fn, at: now + (ms || 1), every: ms || 1 }); return id; },
    clearInterval: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    MutationObserver: class { observe() {} disconnect() {} },
    PointerEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    MouseEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    KeyboardEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    getComputedStyle: (el) => ({ display: 'block', visibility: 'visible', opacity: '1', backgroundColor: el && el._bg || 'rgba(0, 0, 0, 0)', color: el && el._fg || 'rgb(0,0,0)', borderColor: 'rgba(0,0,0,0)', fill: '' }),
    HTMLMediaElement: El,
    sessionStorage: { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = v; }, removeItem(k) { delete this._d[k]; } },
    location: { reload: () => { reloads.count++; }, hash: '' },
    Math, JSON, Object, Array, String, Number, Promise, isFinite, parseFloat, WeakMap, Error, RegExp,
  };
  sb.window = sb; sb.globalThis = sb; sb.top = sb; sb.self = sb;
  const ctx = vm.createContext(sb);
  let threw = null;
  try { vm.runInContext(script, ctx, { filename: 'bl.js' }); } catch (e) { threw = e; }
  return { sb, threw, reloads, logs };
}
function advance(ms) {
  const end = now + ms; let g = 0; let lastT = now;
  while (g++ < 300000) {
    const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at);
    if (!due.length) break;
    const t = due[0];
    const step = Math.max(0, t.at - lastT);
    for (const v of ACTIVE_VIDEOS) {
      if (!v.paused && !v.ended && isFinite(v.duration)) {
        v.currentTime = Math.min(v.duration, v.currentTime + (step / 1000) * (v._rate || 1));
        if (v.currentTime >= v.duration) { v.ended = true; v.paused = true; }
      }
    }
    now = Math.max(now, t.at); lastT = now;
    if (t.every) { t.at = now + t.every; } else { timers.splice(timers.indexOf(t), 1); }
    try { t.fn(); } catch (e) {}
  }
  const tail = Math.max(0, end - lastT);
  for (const v of ACTIVE_VIDEOS) {
    if (!v.paused && !v.ended && isFinite(v.duration)) {
      v.currentTime = Math.min(v.duration, v.currentTime + (tail / 1000) * (v._rate || 1));
      if (v.currentTime >= v.duration) { v.ended = true; v.paused = true; }
    }
  }
  now = end;
}

const checks = [];
const ok = (n, c, x) => { checks.push(c); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x ? '  → ' + x : '')); };

// ===== 1. 核心：点「观看下一章节」，绝不点「重新观看本节」 =====
console.log('测试 1：识别「下一章节」弹窗并点蓝色主按钮');
{
  timers.length = 0;
  const page = buildPage({ duration: 528, currentTime: 527.5 });
  const { threw } = run(SRC, page);
  ok('脚本加载无异常', !threw, threw ? threw.message : 'ok');
  advance(40000);
  console.log('  [诊断] nextBtn.clicked =', page.nextBtn.clicked || 0, ' replayBtn.clicked =', page.replayBtn.clicked || 0);
  ok('点击了「观看下一章节」', (page.nextBtn.clicked || 0) > 0, (page.nextBtn.clicked || 0) + ' 次');
  ok('【关键】没有点「重新观看本节」', (page.replayBtn.clicked || 0) === 0, (page.replayBtn.clicked || 0) + ' 次');
}

// ===== 2. 防跳过头：进行中 + 视频刚开播 + 弹窗仍在 → 不应跳节 =====
console.log('\n测试 2：防跳过头（进行中 + 视频仅播 3.8%）');
{
  timers.length = 0;
  const page = buildPage({ duration: 528, currentTime: 20, activeState: 'progress' });
  run(SRC, page);
  advance(5000);   // 只推进 5 秒：视频仍在开播阶段（20+5=25s，远低于 52.8s 阈值）
  ok('刚开播的进行中章节未被跳过', (page.nextBtn.clicked || 0) === 0,
    '进度 ' + Math.round(page.video.currentTime) + 's/528s, 点击 ' + (page.nextBtn.clicked || 0) + ' 次');
}

// ===== 3. 状态环判据：绿色✓(已完成) 应触发跳节 =====
console.log('\n测试 3：状态环=已完成且视频到末尾时跳下一节');
{
  timers.length = 0;
  const page = buildPage({ duration: 528, currentTime: 527.5, activeState: 'done' });
  const { threw, sb } = run(SRC, page);
  advance(30000);
  // 诊断：看脚本内部 ringState 对当前章节的判定
  try {
    const active = page.sections.find((s) => s.classList.contains('is-active'));
    console.log('  [诊断] 当前章节文本 =', active.textContent.slice(0, 30));
    console.log('  [诊断] 章节内元素 =', active.querySelectorAll('*').map((e) => e.tagName + '.' + e.className).join(' | '));
    console.log('  [诊断] 状态环 bg =', active.querySelectorAll('*').filter((e) => e.className === 'status-ring').map((e) => e._bg).join(','));
    console.log('  [诊断] __t =', JSON.stringify(Array.from(new Set(sb.__t || []))));
  } catch (e) { console.log('  诊断异常', e.message); }
  ok('已完成章节触发跳转', (page.nextBtn.clicked || 0) > 0, '点击 ' + (page.nextBtn.clicked || 0) + ' 次');
  ok('未误点重播', (page.replayBtn.clicked || 0) === 0);
}

// ===== 4. 倍速：设置后 playbackRate 生效，且平台重置会被拦截 =====
console.log('\n测试 4：倍速功能');
{
  timers.length = 0;
  const page = buildPage({ duration: 528, currentTime: 0 });
  const { sb } = run(SRC, page);
  advance(5000);
  console.log('  [诊断] 默认倍速 =', page.video.playbackRate);
  ok('默认倍速为 1.0（保守）', Math.abs(page.video.playbackRate - 1) < 0.01, 'rate=' + page.video.playbackRate);

  // 模拟面板点击 2x：直接调用脚本暴露的配置 + applyRate 路径
  const applyRateFn = sb.__applyRate;
  if (applyRateFn) {
    sb.__cfg && (sb.__cfg.playRate = 2);
    applyRateFn(page.video);
    console.log('  [诊断] 设为 2x 后 rate =', page.video.playbackRate);
    ok('设置 2x 后 playbackRate 生效', Math.abs(page.video.playbackRate - 2) < 0.01, 'rate=' + page.video.playbackRate);
  } else {
    ok('applyRate 可从外部调用（用于测试）', false, '未暴露 __applyRate');
  }
}

// ===== 5. 异常弹窗自动刷新 =====
console.log('\n测试 5：观看环境异常 → 发布版不自动刷新');
{
  timers.length = 0;
  const page = buildPage({});
  // 按平台真实结构造：异常提示在 el-dialog 容器内（严谨检测只认提示容器）
  const dlg = new El('div', { className: 'el-dialog', rect: { left: 700, top: 500, width: 420, height: 200 } });
  dlg.appendChild(new El('div', { className: 'el-dialog__body', text: '学习状态异常，请刷新后继续学习', rect: { left: 720, top: 540, width: 380, height: 40 } }));
  page.body.appendChild(dlg);
  page.doc._extraNodes = [dlg, dlg.children[0]];
  const { reloads } = run(SRC, page);
  advance(30000);
  ok('发布版不自动刷新异常页面', reloads.count === 0, '刷新 ' + reloads.count + ' 次');
}

// ===== 6. 正常页面不误刷新 =====
console.log('\n测试 6：正常页面不误刷新');
{
  timers.length = 0;
  const page = buildPage({ duration: 528, currentTime: 100 });
  const { reloads } = run(SRC, page);
  advance(60000);
  ok('正常页面刷新 0 次', reloads.count === 0, reloads.count + ' 次');
}

// ===== 7. 被动暂停续播 + 静音 =====
console.log('\n测试 7：暂停自动续播 + 静音');
{
  timers.length = 0;
  const page = buildPage({ duration: 528, currentTime: 50, activeState: 'progress' });
  page.video.paused = true;
  run(SRC, page);
  advance(10000);
  ok('暂停被自动续播', (page.video.playCalls || 0) > 0, 'play() ' + (page.video.playCalls || 0) + ' 次');
  ok('视频被静音', page.video.muted === true, 'muted=' + page.video.muted);
}

// ===== 8. 最后一节退避 =====
console.log('\n测试 8：最后一节（点击后不换节）退避');
{
  timers.length = 0;
  const page = buildPage({ duration: 528, currentTime: 527.9, simulateNav: false });
  // 把高亮设到**最后一个**章节项，让脚本能识别"已是最后一节"，
  // 从而启用更长的退避（60s 起）。这正是真实"课程刷完"的情形。
  page.sections.forEach((s, i) => {
    if (i === page.sections.length - 1) s.classList.add('is-active');
    else s.classList.remove('is-active');
  });
  run(SRC, page);
  advance(60 * 1000);
  const c1 = page.nextBtn.clicked || 0;
  advance(30 * 60 * 1000);
  const c2 = page.nextBtn.clicked || 0;
  console.log('  [诊断] 第1分钟 =', c1, '，31分钟累计 =', c2);
  // 最后一节采用 60s 起的退避（上限 10 分钟），31 分钟理论最多 ~10 次
  ok('31 分钟内点击受控（<= 12）', c2 <= 12, c2 + ' 次（无退避约 150 次）');
}

// ===== 9. 视频仍在播放时，绿色状态环也不能触发自动跳节 =====
console.log('\n测试 9：已标记完成但视频仍在中段播放时不跳节');
{
  timers.length = 0;
  const page = buildPage({ duration: 528, currentTime: 120, activeState: 'done' });
  run(SRC, page);
  advance(30000);
  ok('视频播放中未被状态环误触跳节', (page.nextBtn.clicked || 0) === 0,
    '进度 ' + Math.round(page.video.currentTime) + 's/528s，点击 ' + (page.nextBtn.clicked || 0) + ' 次');
}

// ===== 10. 课件不是考核点：停留后直接切到目录中的下一个视频 =====
console.log('\n测试 10：课件停留后直接进入下一个视频');
{
  timers.length = 0;
  const page = buildPage({ noVideo: true, activeState: 'progress' });
  const coursewareItem = new El('li', {
    className: 'el-menu-item',
    rect: { left: 2000, top: 356, width: 480, height: 50 }
  });
  coursewareItem.appendChild(new El('span', {
    className: 'chapter-name', text: '3.3.0课件PPT', rect: { left: 2060, top: 366, width: 260, height: 30 }
  }));
  const list = page.sections[2].parentElement;
  const insertAt = list.children.indexOf(page.sections[2]);
  coursewareItem.parentElement = list;
  list.children.splice(insertAt, 0, coursewareItem);
  page.body.appendChild(new El('iframe', {
    src: 'https://example.test/powerpointframe/courseware-1',
    rect: { left: 100, top: 300, width: 1600, height: 700 }
  }));
  const res = run(SRC, page);
  advance(12000);
  console.log('  [诊断] isStatic=', res.sb.__isStatic ? res.sb.__isStatic() : '未暴露');
  console.log('  [诊断] 下一视频标签=', page.sections[2].textContent.slice(0, 30));
  ok('课件页自动切到下一个视频章节', (page.sections[2].clicked || 0) > 0,
    '下一视频点击 ' + (page.sections[2].clicked || 0) + ' 次');
  ok('连续课件项被跳过，不点击课件目录', (coursewareItem.clicked || 0) === 0,
    '课件目录点击 ' + (coursewareItem.clicked || 0) + ' 次');
}

// ===== 11. 无视频且不像课件时，不得误跳考试/资料页 =====
console.log('\n测试 11：普通无视频页面不触发课件跳转');
{
  timers.length = 0;
  const page = buildPage({ noVideo: true, activeState: 'progress' });
  page.sections[1].querySelector('.chapter-name').textContent = '随堂考试';
  page.body.appendChild(new El('iframe', {
    src: 'https://example.test/video/viewer',
    rect: { left: 100, top: 300, width: 1600, height: 700 }
  }));
  run(SRC, page);
  advance(15000);
  ok('考试/普通无视频页面未被误跳', (page.sections[2].clicked || 0) === 0,
    '下一章节点击 ' + (page.sections[2].clicked || 0) + ' 次');
}

// ===== 12. 页面存在广告/预加载视频时，只认当前主视频的进度 =====
console.log('\n测试 12：多个 <video> 时不得被旁路视频的结束状态触发跳节');
{
  timers.length = 0;
  const page = buildPage({ duration: 528, currentTime: 120, activeState: 'progress' });
  const sideVideo = new El('video', {
    rect: { left: 100, top: 300, width: 320, height: 180 }
  });
  sideVideo.duration = 10;
  sideVideo.currentTime = 10;
  sideVideo.ended = true;
  page.body.appendChild(sideVideo);
  run(SRC, page);
  advance(40000);
  const jumped = (page.nextBtn.clicked || 0) + (page.sections[2].clicked || 0);
  ok('旁路视频结束不会触发下一节', jumped === 0, '跳节入口点击 ' + jumped + ' 次');
}

// ===== 13. 加载转圈时保留上一节 ended 状态，也不得当成播放完成 =====
console.log('\n测试 13：视频缓冲/加载中不触发跳节');
{
  timers.length = 0;
  const page = buildPage({ duration: 528, currentTime: 527.5, activeState: 'progress' });
  page.video.ended = true;
  page.video.readyState = 1;
  page.video.paused = false;
  const loading = new El('div', {
    className: 'vjs-loading-spinner',
    rect: { left: 100, top: 300, width: 80, height: 80 }
  });
  page.body.appendChild(loading);
  run(SRC, page);
  advance(15000);
  const jumped = (page.nextBtn.clicked || 0) + (page.sections[2].clicked || 0);
  ok('加载中保留的 ended 状态不会触发跳节', jumped === 0, '跳节入口点击 ' + jumped + ' 次');
}

// ===== 14. 静止课件是当前展开章节最后一项，且下一视频位于折叠章节 =====
console.log('\n测试 14：课件末项 + 后续章节折叠时仍能找到下一视频');
{
  timers.length = 0;
  const page = buildPage({ noVideo: true, activeState: 'progress' });
  const active = page.sections[1];
  const duration = active.querySelector('.duration');
  if (duration) {
    duration.remove();
    active.children = active.children.filter((child) => child !== duration);
  }
  active.querySelector('.chapter-name').textContent = '1.1机械制造工程产业及课程简介';
  active.appendChild(new El('i', {
    className: 'ppt-file-icon',
    rect: { left: 2440, top: 325, width: 20, height: 20 }
  }));

  const rootList = page.sections[0].parentElement;
  const group1 = new El('li', { className: 'el-sub-menu is-opened' });
  const title1 = new El('div', { className: 'el-sub-menu__title', text: '第一章 绪论' });
  const list1 = new El('ul', { className: 'el-menu' });
  group1.appendChild(title1);
  group1.appendChild(list1);
  page.sections[0].parentElement = list1;
  active.parentElement = list1;
  list1.children.push(page.sections[0], active);

  const group2 = new El('li', { className: 'el-sub-menu' });
  const title2 = new El('div', { className: 'el-sub-menu__title', text: '第二章' });
  const list2 = new El('ul', { className: 'el-menu' });
  page.sections[2].parentElement = list2;
  list2.children.push(page.sections[2]);
  group2.appendChild(title2);
  title2.addEventListener('click', () => {
    group2.classList.add('is-opened');
    if (!group2.children.includes(list2)) group2.appendChild(list2);
  });
  rootList.children = [group1, group2];
  group1.parentElement = rootList;
  group2.parentElement = rootList;

  const staleVideo = new El('video', {
    src: 'https://example.test/previous-section.mp4',
    visible: false,
    rect: { left: 0, top: 0, width: 0, height: 0 }
  });
  staleVideo.duration = 362;
  staleVideo.currentTime = 362;
  staleVideo.ended = true;
  page.body.appendChild(staleVideo);

  console.log('  [诊断] active class=', active.className,
    ' docActive=', page.doc.querySelectorAll('li.el-menu-item.is-active').length,
    ' activeVisible=', !!active.getBoundingClientRect().width);
  const res = run(SRC, page);
  advance(20000);
  console.log('  [诊断] isStatic=', res.sb.__isStatic ? res.sb.__isStatic() : '未暴露',
    ' active=', res.sb.__activeMenu ? (res.sb.__activeMenu() ? res.sb.__activeMenu().textContent.slice(0, 24) : 'null') : '未暴露',
    ' hasDur=', res.sb.__hasDuration ? res.sb.__hasDuration(active) : '未暴露',
    ' looksDoc=', res.sb.__looksDoc ? res.sb.__looksDoc(active) : '未暴露',
    ' videoEvidence=', res.sb.__videoEvidence ? res.sb.__videoEvidence() : '未暴露',
    ' next=', res.sb.__findNext ? (res.sb.__findNext(active) ? res.sb.__findNext(active).textContent.slice(0, 30) : 'null') : '未暴露',
    ' blocked=', res.sb.__blocked ? (res.sb.__blocked() ? res.sb.__blocked().textContent : 'null') : '未暴露');
  console.log('  [诊断] 相关日志=', JSON.stringify(res.logs.filter((l) => /课件|折叠|跳转|下一节|修正|侧边栏/.test(l)).slice(-10)));
  ok('静止课件末项被识别并可跳转', (page.sections[2].clicked || 0) > 0,
    '下一视频点击 ' + (page.sections[2].clicked || 0) + ' 次');
  ok('后续折叠章节被展开', (title2.clicked || 0) > 0, '展开点击 ' + (title2.clicked || 0) + ' 次');
}

// ===== 15. 活动项无课件关键词/文档图标，但存在大型文档查看器 =====
console.log('\n测试 15：大型文档查看器可作为静止课件兜底信号');
{
  timers.length = 0;
  const page = buildPage({ noVideo: true, activeState: 'progress' });
  const active = page.sections[1];
  const duration = active.querySelector('.duration');
  if (duration) {
    duration.remove();
    active.children = active.children.filter((child) => child !== duration);
  }
  active.querySelector('.chapter-name').textContent = '1.2课程内容';
  page.body.appendChild(new El('iframe', {
    src: 'https://example.test/blob/opaque-document-id',
    rect: { left: 100, top: 300, width: 1600, height: 700 }
  }));
  run(SRC, page);
  advance(15000);
  ok('大型文档查看器页面可识别并跳转', (page.sections[2].clicked || 0) > 0,
    '下一视频点击 ' + (page.sections[2].clicked || 0) + ' 次');
}

// ===== 16. 上一章最后一项为课件，下一章使用自定义折叠标题 =====
console.log('\n测试 16：自定义折叠章节标题也能展开并找到下一视频');
{
  timers.length = 0;
  const page = buildPage({ noVideo: true, activeState: 'progress' });
  const active = page.sections[1];
  const duration = active.querySelector('.duration');
  if (duration) {
    duration.remove();
    active.children = active.children.filter((child) => child !== duration);
  }
  active.querySelector('.chapter-name').textContent = '1.3商业模式设计与创新课件';

  const rootList = page.sections[0].parentElement;
  const group1 = new El('div', { className: 'custom-chapter-group' });
  const header1 = new El('div', { className: 'chapter-title', text: '第1讲 商业模式设计' });
  const list1 = new El('ul', { className: 'el-menu' });
  group1.appendChild(header1);
  group1.appendChild(list1);
  page.sections[0].parentElement = list1;
  active.parentElement = list1;
  list1.children.push(page.sections[0], active);

  const group2 = new El('div', { className: 'custom-chapter-group' });
  const header2 = new El('div', { className: 'chapter-title', text: '第2讲 商业模式模式' });
  const list2 = new El('ul', { className: 'el-menu' });
  page.sections[2].parentElement = list2;
  list2.children.push(page.sections[2]);
  group2.appendChild(header2);
  header2.addEventListener('click', () => {
    if (!group2.children.includes(list2)) group2.appendChild(list2);
  });
  rootList.children = [group1, group2];
  group1.parentElement = rootList;
  group2.parentElement = rootList;

  run(SRC, page);
  advance(20000);
  ok('自定义折叠章节被展开', (header2.clicked || 0) > 0, '标题点击 ' + (header2.clicked || 0) + ' 次');
  ok('折叠章节内下一视频被点击', (page.sections[2].clicked || 0) > 0,
    '下一视频点击 ' + (page.sections[2].clicked || 0) + ' 次');
}

// ===== 17. “该节点暂无文件”空节点直接进入下一视频 =====
console.log('\n测试 17：空节点直接进入下一视频');
{
  timers.length = 0;
  const page = buildPage({ noVideo: true, activeState: 'progress' });
  page.body.appendChild(new El('div', {
    className: 'empty-state',
    text: '该节点暂无文件',
    rect: { left: 400, top: 300, width: 800, height: 300 }
  }));
  run(SRC, page);
  advance(15000);
  ok('该节点暂无文件时自动进入下一视频', (page.sections[2].clicked || 0) > 0,
    '下一视频点击 ' + (page.sections[2].clicked || 0) + ' 次');
}

// ===== 18. 空节点没有 is-active 高亮时，选择第一个未完成视频 =====
console.log('\n测试 18：空节点无高亮时仍可继续');
{
  timers.length = 0;
  const page = buildPage({ noVideo: true, activeState: 'progress' });
  const active = page.sections[1];
  const duration = active.querySelector('.duration');
  if (duration) {
    duration.remove();
    active.children = active.children.filter((child) => child !== duration);
  }
  active.classList.remove('is-active');
  page.body.appendChild(new El('div', {
    className: 'empty-state',
    text: '该节点暂无文件',
    rect: { left: 400, top: 300, width: 800, height: 300 }
  }));
  run(SRC, page);
  advance(15000);
  ok('无活动项时仍能找到未完成视频', (page.sections[2].clicked || 0) > 0,
    '下一视频点击 ' + (page.sections[2].clicked || 0) + ' 次');
}

console.log('\n结果：' + checks.filter(Boolean).length + '/' + checks.length + ' 通过');
process.exitCode = checks.some((c) => !c) ? 1 : 0;
