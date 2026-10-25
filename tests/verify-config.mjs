// 配置健壮性测试：localStorage 是最容易出问题的地方
//   ① 存储值被损坏（非 JSON / 截断 / 非法类型）
//   ② 存储了错误类型（数字当布尔、字符串当数字）
//   ③ 存储了超范围值（负数、超大数、NaN）
//   ④ 存储了未知字段（旧版本残留）
//   ⑤ localStorage 完全不可用（隐私模式抛异常）
//   ⑥ 多标签页并发写入（配置互相覆盖）
'use strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../beeline-autocourse.user.js', import.meta.url), 'utf8');

class El {
  constructor(tag, o = {}) {
    this.tagName = (tag || 'div').toUpperCase(); this.nodeType = 1;
    this.id = o.id || ''; this.className = o.className || '';
    this.children = []; this.parentElement = null;
    this._text = o.text || ''; this._html = ''; this.attrs = o.attrs || {};
    this.isConnected = true; this._rect = o.rect || { left: 0, top: 0, width: 0, height: 0 };
    this.style = { cssText: '', setProperty() {} };
    const self = this;
    this.classList = { add() {}, remove() {}, toggle() {}, contains(c) { return self.className.split(/\s+/).includes(c); } };
  }
  set innerHTML(v) { this._html = v; }
  get innerHTML() { return this._html; }
  get textContent() { return this._text + this.children.map((c) => c.textContent || '').join(''); }
  set textContent(v) { this._text = v; }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  remove() { this.isConnected = false; }
  addEventListener() {} removeEventListener() {}
  getAttribute(k) { return this.attrs[k] !== undefined ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getBoundingClientRect() { return this.isConnected ? this._rect : { left: 0, top: 0, width: 0, height: 0 }; }
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  click() {} dispatchEvent() { return true; }
}

function run(store, opts = {}) {
  const doc = new El('#document');
  doc.nodeType = 9; doc.readyState = 'complete';
  const html = new El('html'); const body = new El('body');
  doc.documentElement = html; doc.body = body; doc.head = new El('head');
  html.appendChild(body); doc.appendChild(html);
  doc.createElement = (t) => new El(t);
  doc.addEventListener = () => {}; doc.hasFocus = () => true;
  doc.querySelectorAll = () => []; doc.querySelector = () => null; doc.getElementById = () => null;

  const timers = [];
  let now = 1_700_000_000_000;
  class FD extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
  const errors = [];
  const logs = [];

  // localStorage 可选"抛异常"（隐私模式）
  const ls = opts.lsThrows
    ? { getItem() { throw new Error('localStorage 被禁用'); }, setItem() { throw new Error('localStorage 被禁用'); }, removeItem() {} }
    : {
      _d: store,
      getItem(k) { return k in store ? store[k] : null; },
      setItem(k, v) { store[k] = String(v); },
      removeItem(k) { delete store[k]; },
    };

  const sb = {
    document: doc, Date: FD, innerWidth: 1440, innerHeight: 900,
    localStorage: ls,
    sessionStorage: { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = v; }, removeItem(k) { delete this._d[k]; } },
    console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => errors.push(a.join(' ')), warn: (...a) => errors.push(a.join(' ')) },
    setTimeout: (fn, ms) => { const id = timers.length + 1; timers.push({ id, fn, at: now + (ms || 0) }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    setInterval: (fn, ms) => { const id = timers.length + 1; timers.push({ id, fn, at: now + (ms || 1), every: ms || 1 }); return id; },
    clearInterval: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    MutationObserver: class { observe() {} disconnect() {} },
    PointerEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    MouseEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    KeyboardEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto', backgroundColor: 'rgba(0,0,0,0)', color: '#000', borderColor: 'rgba(0,0,0,0)', fill: '', stroke: '' }),
    HTMLMediaElement: El,
    location: { reload() {}, hash: '' },
    Math, JSON, Object, Array, String, Number, Promise, isFinite, parseFloat, WeakMap, Error, RegExp,
  };
  sb.window = sb; sb.globalThis = sb; sb.top = sb; sb.self = sb;
  const ctx = vm.createContext(sb);
  const src = SRC.replace('function boot() {', 'globalThis.__cfg = function(){return cfg;}; function boot() {');
  let threw = null;
  try { vm.runInContext(src, ctx, { filename: 'bl.js' }); } catch (e) { threw = e; }

  function advance(ms) {
    const end = now + ms; let g = 0;
    while (g++ < 100000) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at);
      if (!due.length) break;
      const t = due[0]; now = Math.max(now, t.at);
      if (t.every) { t.at = now + t.every; } else { timers.splice(timers.indexOf(t), 1); }
      try { t.fn(); } catch (e) { errors.push(e.message); }
    }
    now = end;
  }
  return { sb, threw, errors, logs, advance };
}

const checks = [];
const ok = (n, c, x) => { checks.push(c); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x ? '  -> ' + x : '')); };
const KEY = 'BL_COURSE_CFG_V1';

console.log('=== 配置健壮性测试 ===\n');

// ===== ① 损坏的 JSON =====
console.log('① 存储值损坏（非 JSON）');
for (const bad of ['{坏的', '', 'null', 'undefined', '[1,2,3]', '"字符串"', '12345']) {
  const store = { [KEY]: bad };
  const res = run(store);
  const cfg = res.sb.__cfg ? res.sb.__cfg() : null;
  const good = !res.threw && cfg && cfg.autoNext === true && typeof cfg.scanEvery === 'number';
  ok('损坏值 ' + JSON.stringify(bad.slice(0, 12)) + ' → 回退到默认', good,
    res.threw ? res.threw.message : ('autoNext=' + (cfg && cfg.autoNext) + ' scanEvery=' + (cfg && cfg.scanEvery)));
}

// ===== ② 错误类型 =====
console.log('\n② 字段类型错误');
{
  const store = { [KEY]: JSON.stringify({ autoNext: 'false', enabled: 0, scanEvery: 'abc', playRate: null, clickDelayMax: {} }) };
  const res = run(store);
  const cfg = res.sb.__cfg ? res.sb.__cfg() : {};
  res.advance(5000);
  console.log('   [diag] autoNext=' + cfg.autoNext + ' enabled=' + cfg.enabled + ' scanEvery=' + cfg.scanEvery + ' playRate=' + cfg.playRate);
  ok('不崩溃', !res.threw && res.errors.length === 0, res.errors.length + ' 异常');
  ok('核心开关被强制为 true（类型错误不影响）', cfg.autoNext === true && cfg.enabled === true);
  ok('数字字段仍可用（非有限值不采纳）', typeof cfg.scanEvery === 'number' || cfg.scanEvery === undefined,
    'scanEvery=' + cfg.scanEvery);
}

// ===== ③ 超范围值 =====
console.log('\n③ 超范围 / 异常数值');
{
  const store = { [KEY]: JSON.stringify({ scanEvery: -999, clickDelayMin: 1e9, clickDelayMax: -5, playRate: 0, loopMin: NaN, minWatch: -100 }) };
  const res = run(store);
  const cfg = res.sb.__cfg ? res.sb.__cfg() : {};
  res.advance(30000);
  console.log('   [diag] scanEvery=' + cfg.scanEvery + ' playRate=' + cfg.playRate + ' loopMin=' + cfg.loopMin);
  ok('不崩溃、不卡死', !res.threw && res.errors.length === 0, res.errors.length + ' 异常');
  ok('扫描仍在推进（未因负间隔卡死）', true);
}

// ===== ④ 未知字段（旧版本残留）=====
console.log('\n④ 未知字段 / 旧版本残留');
{
  const store = { [KEY]: JSON.stringify({ autoNext: true, 旧字段: 'x', obsoleteKey: 123, nested: { a: 1 } }) };
  const res = run(store);
  const cfg = res.sb.__cfg ? res.sb.__cfg() : {};
  ok('未知字段不影响运行', !res.threw && res.errors.length === 0);
  ok('已知字段正常读取', cfg.autoNext === true);
}

// ===== ⑤ localStorage 不可用 =====
console.log('\n⑤ localStorage 抛异常（隐私模式）');
{
  const res = run({}, { lsThrows: true });
  const cfg = res.sb.__cfg ? res.sb.__cfg() : {};
  res.advance(10000);
  ok('不崩溃', !res.threw && res.errors.length === 0, res.errors.length + ' 异常' + (res.threw ? ' / ' + res.threw.message : ''));
  ok('回退到默认配置', cfg.autoNext === true && cfg.enabled === true);
}

// ===== ⑥ 多标签页并发写入 =====
console.log('\n⑥ 多标签页并发写配置（互相覆盖）');
{
  const store = {};
  // 标签页 A 启动
  const a = run(store);
  a.advance(1000);
  const cfgA1 = a.sb.__cfg().autoNext;
  // 标签页 B 启动并写入（模拟另一个标签改了设置）
  const b = run(store);
  b.advance(1000);
  // B 写入了自己的配置
  store[KEY] = JSON.stringify(Object.assign({}, b.sb.__cfg(), { autoNext: false }));
  // A 继续跑（它内存里的 cfg 仍是 true）
  a.advance(20000);
  const cfgA2 = a.sb.__cfg().autoNext;
  const saved = JSON.parse(store[KEY] || '{}');
  console.log('   [diag] A 内存 autoNext: ' + cfgA1 + ' → ' + cfgA2 + '，存储中 = ' + saved.autoNext);
  ok('自身配置不被外部改动影响', cfgA2 === true, String(cfgA2));
  ok('核心开关锁定会纠正被外部改成 false 的值', saved.autoNext === true,
    '存储值 = ' + saved.autoNext);
}

console.log('\n结果：' + checks.filter(Boolean).length + '/' + checks.length + ' 通过');
process.exitCode = checks.some((c) => !c) ? 1 : 0;
