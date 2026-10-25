// 面板 UI 一致性检查：HTML 里定义的 id 与 JS 里读取/绑定的 id 必须一一对应。
// 重写 UI 最容易出的错就是「绑定的 id 在 HTML 里不存在」——那样按钮点不动却毫无报错。
'use strict';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../beeline-autocourse.user.js', import.meta.url), 'utf8');

// ---- 1. 提取 HTML 模板里出现的 id ----
//   a) 字面量            id="bl-xxx"
//   b) 拼接式（row()/num()/btn() 构造） id="' + id + '" → 由 cfgKeys 覆盖
const htmlIds = new Set();
for (const m of SRC.matchAll(/id="([\w-]+)"/g)) htmlIds.add(m[1]);
// 构造函数会把传入的 id 原样写进 HTML：抓取 btn('bl-xxx', ...) 这类调用
for (const m of SRC.matchAll(/btn\(\s*'([\w-]+)'/g)) htmlIds.add(m[1]);
// row()/num() 的 id 来自 bools/nums 数组 → 下面 cfgKeys 会覆盖

// ---- 2. 提取 JS 里按 id 读取的位置 ----
//   bindOrSkip('bl-xxx', ...) / $('bl-xxx') / querySelector('#bl-xxx')
const jsIds = new Set();
for (const m of SRC.matchAll(/bindOrSkip\(\s*'([\w-]+)'/g)) jsIds.add(m[1]);
for (const m of SRC.matchAll(/\$\(\s*'([\w-]+)'\s*\)/g)) jsIds.add(m[1]);
for (const m of SRC.matchAll(/querySelector\(\s*'#([\w-]+)'\s*\)/g)) jsIds.add(m[1]);
for (const m of SRC.matchAll(/getElementById\(\s*'([\w-]+)'\s*\)/g)) jsIds.add(m[1]);

// ---- 3. 动态拼接的 id（row()/num() 构造函数生成，如 'bl-' + k） ----
//   收集 bools / nums 数组里的配置键；这些键由 row()/num() 写进 HTML
const cfgKeys = new Set();
for (const m of SRC.matchAll(/const (?:bools|nums) = \[([\s\S]*?)\];/g)) {
  for (const k of m[1].matchAll(/'([\w]+)'/g)) cfgKeys.add('bl-' + k[1]);
}
// 这些控件确实被写进了 HTML（经 row/num 构造函数）
for (const k of cfgKeys) htmlIds.add(k);

const checks = [];
const ok = (n, c, x) => { checks.push(c); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x ? '  -> ' + x : '')); };

console.log('=== 面板 ID 一致性检查 ===');
console.log('HTML 定义的 id: ' + htmlIds.size + ' 个（含 ' + cfgKeys.size + ' 个由 row/num 生成）');
console.log('JS 读取的 id  : ' + jsIds.size + ' 个');

// 检查 A：JS 里显式读取的 id 必须在 HTML 中存在
//   排除动态创建的容器（bl-style 由 createElement 建并设 id；'bl-' 是拼接前缀误抓）
const DYNAMIC_IDS = new Set(['bl-style', 'bl-panel', 'bl-mini', 'bl-']);
const missing = [...jsIds].filter((id) => !htmlIds.has(id) && !DYNAMIC_IDS.has(id));
ok('JS 读取的 id 全部存在于 HTML', missing.length === 0,
  missing.length ? '缺失: ' + missing.join(', ') : '全部匹配');

// 检查 B：配置键（bools/nums）对应的控件 id 必须都在 HTML 中
const missingCfg = [...cfgKeys].filter((id) => !htmlIds.has(id));
ok('配置项控件 id 全部存在于 HTML', missingCfg.length === 0,
  missingCfg.length ? '缺失: ' + missingCfg.join(', ') : '全部匹配');

// 检查 C：HTML 中的每个 id 都应该被用到（否则是死代码）
//   注意：配置项是通过 bindOrSkip('bl-' + k) 动态绑定的，提取器抓不到字面量，
//   所以 cfgKeys 必须视为"已使用"。
const RUNTIME_IDS = ['bl-dot', 'bl-ring', 'bl-pct', 'bl-l1', 'bl-l2', 'bl-head', 'bl-body'];
const unused = [...htmlIds].filter((id) =>
  !jsIds.has(id) && !cfgKeys.has(id) && !RUNTIME_IDS.includes(id) && !DYNAMIC_IDS.has(id));
ok('没有孤立的 HTML id（死代码）', unused.length === 0,
  unused.length ? '未使用: ' + unused.join(', ') : '无');

// 检查 D：关键交互元素必须存在
const REQUIRED = ['bl-head', 'bl-mini-btn', 'bl-close', 'bl-log', 'bl-dot',
  'bl-ring', 'bl-l1', 'bl-l2', 'bl-pct', 'bl-jump', 'bl-diagnose', 'bl-reset',
  'bl-clearlog', 'bl-openlog', 'bl-diagnose2'];
const missingReq = REQUIRED.filter((id) => !htmlIds.has(id));
ok('关键交互元素齐全', missingReq.length === 0,
  missingReq.length ? '缺失: ' + missingReq.join(', ') : REQUIRED.length + ' 个全部存在');

// 检查 E：三个页签与三个面板一一对应
const tabs = [...SRC.matchAll(/data-tab="(\w+)"/g)].map((m) => m[1]);
const panes = [...SRC.matchAll(/data-pane="(\w+)"/g)].map((m) => m[1]);
ok('页签与面板一一对应', tabs.length === panes.length && tabs.every((t) => panes.includes(t)),
  'tabs=[' + tabs.join(',') + '] panes=[' + panes.join(',') + ']');

// 检查 F：样式表必须被注入（否则面板裸奔）
ok('CSS 样式表有注入逻辑', /getElementById\('bl-style'\)/.test(SRC) && /st\.textContent = PANEL_CSS/.test(SRC));

// 检查 G：CSS 里用到的类，必须能在 HTML 模板里找到（反向：找出明显写错的选择器）
const cssClasses = new Set();
for (const m of SRC.matchAll(/\.(bl-[\w-]+)/g)) cssClasses.add(m[1]);
const htmlClasses = new Set();
// a) 静态 class="..."
for (const m of SRC.matchAll(/class="([^"]+)"/g)) {
  for (const c of m[1].split(/\s+/)) if (c) htmlClasses.add(c);
}
// b) 动态拼接：'<div class="bl-rate' + ... / class="bl-fold' + ...
for (const m of SRC.matchAll(/class="(bl-[\w-]*)/g)) htmlClasses.add(m[1]);
// c) classList.toggle/add/remove
for (const m of SRC.matchAll(/classList\.(?:toggle|add|remove)\(\s*'([\w-]+)'/g)) htmlClasses.add(m[1]);
// d) 代码里以字符串形式出现的类名
for (const m of SRC.matchAll(/'(bl-[\w-]+)'/g)) htmlClasses.add(m[1]);
const cssOrphan = [...cssClasses].filter((c) => !htmlClasses.has(c));
ok('CSS 类都有对应元素（无拼写错误）', cssOrphan.length === 0,
  cssOrphan.length ? '未匹配: ' + cssOrphan.join(', ') : cssClasses.size + ' 个类全部匹配');

console.log('\n结果：' + checks.filter(Boolean).length + '/' + checks.length + ' 通过');
process.exitCode = checks.some((c) => !c) ? 1 : 0;
