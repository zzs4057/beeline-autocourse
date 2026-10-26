// ==UserScript==
// @name         芯位蜜线课程连播与章节导航助手
// @version      1.4.2
// @description  通过页面 DOM 辅助课程连播与章节导航。默认关闭，必须由用户在课程窗口前台手动启用；不伪造可见性、不模拟键鼠、不处理或规避平台风控。
// @author       Beeline Autocourse Contributors
// @match        https://www.beeline-ai.com/*
// @match        https://beeline-ai.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // 只在主文档运行；平台内容都在主 frame，iframe 内不启动
  if (window.top !== window.self) return;
  if (window.__BL_COURSE_LOADED__) return;
  window.__BL_COURSE_LOADED__ = true;
  const SCRIPT_VERSION = '1.4.2';

  // ==========================================================================
  //  0. 配置
  // ==========================================================================
  const DEFAULTS = {
    enabled: false,       // 总开关（默认关闭，必须显式启用）
    autoNext: true,       // 自动下一节
    autoPlay: true,       // 暂停自动续播
    pptDwell: 5,          // 静态/PPT 课件停留秒数
    minWatch: 30,         // 最少观看秒数（防过早跳节）
    cooldown: 0,          // 跳节冷却秒数（0=点到蓝色按钮就立刻点，不做等待）
    instantClick: false,  // 立即点击模式：看到蓝色「观看下一章节」就点
    scanEvery: 10,        // 每 10 秒扫描一次是否出现蓝色按钮（用户指定）
    clickDelayMin: 0.3,   // 发现按钮后随机等待最短秒数
    clickDelayMax: 2.5,   // 发现按钮后随机等待最长秒数
    guardSkipAhead: true, // 防跳过头：视频未到末尾时不自动跳
    interval: 0.5,        // 主循环间隔（秒）——立即模式需要更密的检测
    endThreshold: 1.0,    // 距末尾多少秒算看完
    completionPercent: 100, // 播放到该百分比视为达到完成目标
    playRate: 1.0,        // 播放倍速（1.0=正常；可试 1.5 / 2.0）
    skipCourseware: false,// 课件是否可跳过由用户显式决定
  };

  // ==========================================================================
  //  配置校验：localStorage 里的值可能被损坏、类型错误、超范围，
  //  或被其他脚本/旧版本污染。不校验就使用会导致严重后果：
  //    · scanEvery="abc" → Math.max(2,"abc")=NaN → 定时器疯狂触发（CPU 空转）
  //    · playRate=0     → 倍速计算异常 / 视频卡住
  //    · cooldown=-5    → 冷却逻辑失效
  //  所以逐字段按"类型 + 范围"校正，非法值回退到默认。
  // ==========================================================================
  const NUM_RANGE = {
    scanEvery: [2, 3600],
    clickDelayMin: [0, 60],
    clickDelayMax: [0, 60],
    cooldown: [0, 600],
    minWatch: [0, 3600],
    pptDwell: [0, 3600],
    endThreshold: [0.1, 60],
    completionPercent: [1, 100],
    playRate: [0.25, 4],
    interval: [0.2, 60],
  };

  function sanitizeConfig(raw) {
    const fixed = [];
    const out = Object.assign({}, DEFAULTS);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { cfg: out, fixed };

    for (const k of Object.keys(DEFAULTS)) {
      if (!(k in raw)) continue;               // 用默认值
      const v = raw[k];
      const def = DEFAULTS[k];

      if (typeof def === 'boolean') {
        if (typeof v === 'boolean') out[k] = v;
        else { fixed.push(k); }                // 类型不对 → 保留默认
      } else if (typeof def === 'number') {
        const n = typeof v === 'number' ? v : parseFloat(v);
        const rng = NUM_RANGE[k];
        if (isFinite(n) && (!rng || (n >= rng[0] && n <= rng[1]))) out[k] = n;
        else { fixed.push(k + '(' + String(v).slice(0, 12) + ')'); }
      } else if (typeof def === 'string') {
        if (typeof v === 'string') out[k] = v;
        else { fixed.push(k); }
      }
    }
    // 逻辑约束：最小值不能超过最大值（否则随机区间反转）
    for (const [lo, hi] of [['clickDelayMin', 'clickDelayMax']]) {
      if (out[lo] > out[hi]) { out[hi] = out[lo]; fixed.push(hi + '>= ' + lo); }
    }
    return { cfg: out, fixed };
  }

  const STORE = 'BL_COURSE_CFG_V1';
  const LOG_MAX = 150;
  const logs = [];
  let cfg = Object.assign({}, DEFAULTS, safeLoad());
  // 逐字段校验并校正（非法值回退默认），记录被修正的字段供启动日志提示
  let configFixed = [];
  try {
    const _s = sanitizeConfig(safeLoad());
    cfg = _s.cfg;
    configFixed = _s.fixed;
  } catch (e) { cfg = Object.assign({}, DEFAULTS); }
  let video = null;
  let lastJump = 0;
  let scriptStart = Date.now();
  let pptSince = 0;
  let coursewareSkipAt = 0;
  let lastCoursewareSkipLogAt = 0;
  let finishCandidateVideo = null;
  let finishCandidateKey = '';
  let finishCandidateSince = 0;
  let blockedByCollapsedGroup = null;
  let blockedByCourseHeader = null;
  let courseGroupExpandAt = 0;
  let lastVideoPageEvidenceAt = 0;
  const expandedCourseHeaders = new WeakSet();
  let lastActiveMenuNode = null;
  let tick = 0;
  let consecutiveJumps = 0;
  let mainTimerId = null;
  let panel = null;
  let lastJumpSig = '';        // 上次跳转前的章节指纹（用于确认是否真的换节了）
  let consecutiveJumpFails = 0; // 连续"点击后没换节"次数
  let jumpBackoffUntil = 0;     // 退避截止时间
  let pendingJumpAttempt = false; // 跳转尝试互斥锁（防定时器堆积）

  // ==========================================================================
  //  1. 工具
  // ==========================================================================
  function safeLoad() {
    try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { return {}; }
  }
  function safeSave() {
    try { localStorage.setItem(STORE, JSON.stringify(cfg)); } catch (e) {}
  }
  function log(msg) {
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    logs.push('[' + t + '] ' + msg);
    if (logs.length > LOG_MAX) logs.shift();
    renderLog();
    try { console.log('[课程导航]', msg); } catch (e) {}
  }
  const rnd = (a, b) => a + Math.random() * (b - a);
  const rndInt = (a, b) => Math.floor(rnd(a, b + 1));
  const qsa = (sel, root) => {
    try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); } catch (e) { return []; }
  };
  const text = (el) => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
  const textAll = (el) => ((el && el.textContent) || '').replace(/\s+/g, '');
  // 判断元素是否属于脚本自己的 UI（面板 / 悬浮球 / 注入的样式）。
  function isOwnUI(el) {
    try {
      let p = el;
      let depth = 0;
      while (p && depth++ < 30) {
        if (p.id === 'bl-panel' || p.id === 'bl-mini' || p.id === 'bl-style') return true;
        p = p.parentElement;
      }
    } catch (e) {}
    return false;
  }

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    let st;
    try { st = getComputedStyle(el); } catch (e) { return true; }
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    return true;
  }
  function clickEl(el) {
    if (!el) return false;
    // 只有元素不在视口内时才滚动——否则会让页面"抖一下"，很显眼
    try {
      const r0 = el.getBoundingClientRect();
      const vh = window.innerHeight || 0;
      if (vh && (r0.top < 0 || r0.bottom > vh)) {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
      }
    } catch (e) {}
    let r;
    try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    if (!r || r.width <= 0) return false;
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const o = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', o));
      el.dispatchEvent(new MouseEvent('mousedown', o));
      el.dispatchEvent(new PointerEvent('pointerup', o));
      el.dispatchEvent(new MouseEvent('mouseup', o));
      el.dispatchEvent(new MouseEvent('click', o));
      return true;
    } catch (e) {
      // 兜底：仅对"语义上可点"的元素使用原生 click()。
      // 对 div/span 调 .click() 可能触发意外行为，宁可放弃本次点击。
      const tag = el.tagName;
      if (tag === 'BUTTON' || tag === 'A' ||
        (el.getAttribute && el.getAttribute('role') === 'button')) {
        try { el.click(); return true; } catch (e2) { return false; }
      }
      return false;
    }
  }

  // ==========================================================================
  //  2. 前台播放守卫：不伪造可见性，失焦时停止自动化
  // ==========================================================================
  let foregroundAutoPaused = false;
  let foregroundWarningLogged = false;

  function isForegroundActive() {
    try {
      const visibility = document.visibilityState;
      return !document.hidden && (visibility === undefined || visibility === 'visible') && document.hasFocus();
    } catch (e) {
      return false;
    }
  }

  function pauseForBackground() {
    const v = mainVideo();
    if (v && !v.paused && !v.ended) {
      foregroundAutoPaused = true;
      try { v.pause(); } catch (e) {}
    }
  }

  function installForegroundGuard() {
    const check = () => {
      if (!isForegroundActive()) {
        pauseForBackground();
        if (!foregroundWarningLogged) {
          foregroundWarningLogged = true;
          log('课程窗口不在前台，已暂停自动操作；请保持播放器窗口在最上方');
        }
      }
    };
    try { document.addEventListener('visibilitychange', check); } catch (e) {}
    try { window.addEventListener('blur', check); } catch (e) {}
    try {
      window.addEventListener('focus', () => {
        foregroundWarningLogged = false;
        if (foregroundAutoPaused) {
          foregroundAutoPaused = false;
          if (cfg.autoPlay) keepPlay();
        }
      });
    } catch (e) {}
  }

  // ==========================================================================
  //  3. 视频处理：静音 + 续播
  // ==========================================================================
  function allVideos() {
    const out = [];
    for (const d of docsToScan()) {
      for (const v of qsa('video', d)) {
        if (v && v.tagName === 'VIDEO' && out.indexOf(v) === -1) out.push(v);
      }
    }
    return out;
  }
  function mainVideo() {
    const vs = allVideos();
    if (!vs.length) return null;
    vs.sort((a, b) => {
      const pa = (!a.paused && !a.ended) ? 1 : 0, pb = (!b.paused && !b.ended) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      const da = isFinite(a.duration) ? a.duration : 0, db = isFinite(b.duration) ? b.duration : 0;
      return db - da;
    });
    return vs[0];
  }
  // 倍速只来自用户显式选择；不拦截平台重置，也不点击播放器隐藏菜单。
  function applyRate(v) {
    if (!v || !isFinite(cfg.playRate) || cfg.playRate <= 0) return;
    if (Math.abs((v.playbackRate || 1) - cfg.playRate) > 0.01) {
      try {
        // 走原始 setter，避开拦截逻辑
        const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
        if (d && d.set) d.set.call(v, cfg.playRate);
        else v.playbackRate = cfg.playRate;
      } catch (e) {
        try { v.playbackRate = cfg.playRate; } catch (e2) {}
      }
    }
  }
  function keepPlay() {
    for (const v of allVideos()) {
      if (v.paused && !v.ended && v.readyState >= 2) {
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
      }
    }
  }

  // ==========================================================================
  //  4. 判定"本节是否已完成"
  // ==========================================================================
  // 当前高亮的章节项。
  // 平台实现可能变化，或用别的 class 标记"当前节"，所以做多层兜底。
  let lastMenuDiag = '';
  function activeMenuItem() {
    const sels = [
      'li.el-menu-item.is-active',
      'li.el-menu-item.active',
      '.el-menu-item.is-active',
      '[class*="menu-item"][class*="active"]',
      '[class*="chapter"][class*="active"]',
      '[class*="section"][class*="active"]',
    ];
    for (const d of docsToScan()) {
      for (const s of sels) {
        try {
          const el = d.querySelector(s);
          if (el && visible(el)) {
            lastActiveMenuNode = el;
            return el;
          }
        } catch (e) {}
      }
    }
    // 诊断：记录一次为什么没找到（供面板显示与日志排查）
    try {
      const total = qsa('li.el-menu-item').length;
      const menuLike = qsa('[class*="menu-item"], [class*="chapter-item"], [class*="catalog"]').length;
      const frames = qsa('iframe').length;
      lastMenuDiag = '章节项=' + total + '，类章节元素=' + menuLike + '，iframe=' + frames;
    } catch (e) { lastMenuDiag = ''; }
    return null;
  }

  // 需要扫描的文档集合：主文档 + 同源 iframe（有些平台把目录放在 iframe 里）
  function docsToScan() {
    const out = [document];
    try {
      const walk = (doc, depth) => {
        if (depth > 4) return;
        for (const f of Array.prototype.slice.call(doc.querySelectorAll('iframe'))) {
          let d = null;
          try { d = f.contentDocument; } catch (e) { d = null; }   // 跨域会抛错
          if (d && d !== doc && out.indexOf(d) === -1) { out.push(d); walk(d, depth + 1); }
        }
      };
      walk(document, 0);
    } catch (e) {}
    return out;
  }
  function isStaticOrPpt() {
    if (hasVideoPageEvidence()) return false;
    if (isEmptyLearningNode()) return true;
    // 没有可见视频 → 可能是 PPT/文档课件
    const active = activeMenuItem();
    if (active) {
      const activeText = text(active);
      if (/课件|PPT|PDF|文档|讲义/i.test(activeText)) return true;
      const notAssessment = !/考试|作业|测验|测试|练习|讨论|问卷|题目?/i.test(activeText);
      if (notAssessment && !hasVideoDuration(active) &&
        (looksLikeDocumentItem(active) || hasLargeDocumentViewer())) return true;
    }
    for (const f of qsa('iframe')) {
      const src = (f.src || '').toLowerCase();
      if (src && /powerpointframe|pptframe|\/ppt|slideshow|slideviewer|courseware|pdfviewer|officeviewer|wopi/.test(src)) return true;
    }
    return false;
  }

  function isEmptyLearningNode() {
    const nodes = qsa('div, p, section, span, h1, h2, h3, h4');
    for (const el of nodes) {
      if (!el.isConnected || isOwnUI(el) || !isElementDisplayed(el)) continue;
      const t = normalizeText(el.textContent);
      if (t.length <= 60 && /该节点暂无文件|暂无文件|暂无内容|资源不存在|内容不存在|节点暂无/.test(t)) {
        return true;
      }
    }
    return false;
  }

  function attemptCoursewareSkip() {
    const now = Date.now();
    if (now < coursewareSkipAt || pendingJumpAttempt) return;
    if (hasVideoPageEvidence()) {
      coursewareSkipAt = now + 10000;
      return;
    }

    const active = activeMenuItem() ||
      (lastActiveMenuNode && lastActiveMenuNode.isConnected ? lastActiveMenuNode : null);
    const next = active ? findNextMenuItem(active) : findFirstIncompleteVideoItem();
    if (!next) {
      if ((blockedByCourseHeader && expandBlockedCourseHeader()) ||
        (blockedByCollapsedGroup && expandBlockedCourseGroup())) {
        coursewareSkipAt = now + 1000;
        setTimeout(() => { try { attemptCoursewareSkip(); } catch (e) {} }, 1000);
        return;
      }
      coursewareSkipAt = now + 60000;
      if (now - lastCoursewareSkipLogAt > 60000) {
        lastCoursewareSkipLogAt = now;
        log('当前是课件，但没有找到下一个可点击的视频章节');
      }
      return;
    }

    pendingJumpAttempt = true;
    coursewareSkipAt = now + Math.max(15000, (cfg.pptDwell || 5) * 1000);
    const emptyNode = isEmptyLearningNode();
    const started = gotoNextSection();
    if (started) {
      log((emptyNode ? '空节点' : '课件') + '不是考核点：停留 ' +
        cfg.pptDwell + ' 秒后，跳转到下一个视频章节');
    } else {
      log('当前是课件，但侧边栏暂时无法跳转到下一个视频');
    }
    setTimeout(() => { pendingJumpAttempt = false; }, 5000);
  }
  // 读取章节项右侧状态圆环的状态（截图实测：绿✓=已完成 / 蓝●=进行中 / 灰○=未开始）
  // 依据是视觉颜色，比 class 名可靠（平台改版常改 class，但状态颜色语义稳定）
  function ringState(item) {
    if (!item) return 'unknown';
    // 候选：章节项内所有小尺寸元素（不限定标签，兼容 i/svg/span/img/em 等实现）
    let nodes = [];
    try {
      nodes = qsa('*', item).concat(qsa('i, svg, span, div, em, img', item));
    } catch (e) { nodes = []; }
    // 去重
    nodes = nodes.filter((el, i) => nodes.indexOf(el) === i);
    const pick = nodes.filter((el) => {
      const w = el.offsetWidth || 0, h = el.offsetHeight || 0;
      if (w < 8 || h < 8 || w > 40 || h > 40) return false;
      if (!visible(el)) return false;
      // 只看靠右侧的（状态环在行尾）
      const ir = item.getBoundingClientRect(), er = el.getBoundingClientRect();
      return er.left > ir.left + ir.width * 0.6;
    });
    for (const el of pick) {
      let st;
      try { st = getComputedStyle(el); } catch (e) { continue; }
      const colorStr = (st.color || '') + ' ' + (st.backgroundColor || '') + ' ' +
        (st.borderColor || '') + ' ' + (st.fill || '') + ' ' + (st.stroke || '');
      const m = colorStr.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g);
      if (!m) continue;
      for (const c of m) {
        const p = c.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (!p) continue;
        const r = +p[1], g = +p[2], b = +p[3];
        // 绿色（已完成）：G 明显高于 R 和 B
        if (g > 120 && g > r + 30 && g > b + 30) return 'done';
        // 蓝色（进行中）：B 明显高于 R
        if (b > 120 && b > r + 40 && b >= g) return 'progress';
      }
    }
    // class 兜底
    if (item.querySelector('.done-icon, .icon-done, .is-done, [class*="done"], [class*="complete"]')) return 'done';
    if (item.querySelector('.inProgress-icon, [class*="progress"], [class*="active"]')) return 'progress';
    return 'unknown';
  }

  function sectionComplete() {
    const now = Date.now();
    if (now < lastJump) return false;   // 跳节冷却中

    const playback = playbackProgressState();
    const active = activeMenuItem();
    if (active) {
      const rs = ringState(active);
      // ① 状态环=已完成时仍要看视频是否已经到末尾。仅凭圆环颜色就跳，
      //    在平台状态延迟、缓存错误或视觉元素串色时会直接跳过正在播放的视频。
      if (rs === 'done') {
        if (!cfg.guardSkipAhead || !playback.hasVideo || playback.finished) return true;
        return false;
      }
      // ② 状态环=进行中 → 不能直接判完成，但要看视频是否播完（下方统一判断）
      //    注意：视频播完是强信号，优先于"进行中"标记（平台更新状态有延迟）
      if (rs === 'progress' && !playback.finished) return false;
      // ③ 状态环未识别 → 走 class 兜底
      if (rs === 'unknown') {
        if (active.querySelector('.inProgress-icon, .unStart-icon')) return false;
        if (active.querySelector('.done-icon, .icon-done, .el-icon-check, .el-icon-circle-check, .el-icon-check-circle, .is-done')) {
          return !cfg.guardSkipAhead || !playback.hasVideo || playback.finished;
        }
      }
    }

    if (isStaticOrPpt()) {
      if (pptSince === 0) pptSince = now;
      if (now - pptSince > cfg.pptDwell * 1000) return true;
      return false;
    }
    pptSince = 0;

    if (now - scriptStart < cfg.minWatch * 1000 / Math.max(1, cfg.playRate)) return false;

    return playback.finished;
  }

  // 可见视频的真实播放进度。自动跳节只认可"已经结束/接近末尾"的视频；
  // 视频仍在播放时，即使页面里残留了蓝色按钮或绿色状态环也不跳。
  function hasVideoPageEvidence() {
    const now = Date.now();
    const current = allVideos().some((v) => {
      if (!v || !v.isConnected) return false;
      return isElementDisplayed(v) || !v.paused;
    });
    if (current) lastVideoPageEvidenceAt = now;
    return current || now - lastVideoPageEvidenceAt < 3000;
  }

  function hasVisibleLoadingIndicator() {
    const selectors = [
      '.vjs-waiting', '.vjs-loading-spinner', '.video-loading', '.player-loading',
      '.el-loading-mask', '[class*="loading-spinner"]', '[class*="video-loading"]'
    ];
    for (const sel of selectors) {
      if (qsa(sel).some((el) => visible(el))) return true;
    }
    return false;
  }

  function hasLargeDocumentViewer() {
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const selectors = 'iframe, embed, object, canvas, [class*="pdf"], [class*="ppt"], [class*="document-viewer"], [class*="file-viewer"]';
    return qsa(selectors).some((el) => {
      if (!isElementDisplayed(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width >= Math.min(520, vw * 0.4) && r.height >= Math.min(320, vh * 0.35);
    });
  }

  function playbackProgressState() {
    const videos = allVideos().filter((v) => v && v.isConnected && (isElementDisplayed(v) || !v.paused));
    if (!videos.length) {
      finishCandidateVideo = null;
      finishCandidateKey = '';
      finishCandidateSince = 0;
      return { hasVideo: false, finished: false, loading: false, currentTime: 0, duration: 0, remaining: 0 };
    }
    const v = videos.find((item) => visible(item) && !item.paused && !item.ended) ||
      videos.find((item) => !item.paused && !item.ended) ||
      videos.find((item) => visible(item) && !item.ended) ||
      videos.find((item) => !item.ended) || videos[0];
    const duration = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    const currentTime = isFinite(v.currentTime) && v.currentTime > 0 ? v.currentTime : 0;
    const remaining = duration > 0 ? Math.max(0, duration - currentTime) : Infinity;
    const readyState = isFinite(v.readyState) ? Number(v.readyState) : 4;
    const loading = !!v.seeking || readyState < 3 || hasVisibleLoadingIndicator();
    const completionPercent = Math.max(1, Math.min(100, Number(cfg.completionPercent) || 100));
    const targetTime = duration > 0 ? duration * completionPercent / 100 : Infinity;
    const progressPercent = duration > 0 ? currentTime / duration * 100 : 0;
    const atTarget = !!v.ended || (duration > 0 &&
      (currentTime >= targetTime || remaining <= Math.max(0.5, cfg.endThreshold || 1)));
    const key = (v.currentSrc || v.src || '') + '|' + Math.round(duration * 10);
    const now = Date.now();

    if (!atTarget || loading) {
      finishCandidateVideo = v;
      finishCandidateKey = key;
      finishCandidateSince = 0;
    } else if (finishCandidateVideo !== v || finishCandidateKey !== key || !finishCandidateSince) {
      finishCandidateVideo = v;
      finishCandidateKey = key;
      finishCandidateSince = now;
    }

    const finishStable = finishCandidateVideo === v && finishCandidateKey === key &&
      finishCandidateSince > 0 && now - finishCandidateSince >= 1500;
    const finished = atTarget && !loading && finishStable;
    return { hasVideo: true, finished, loading, readyState, currentTime, duration, remaining,
      progressPercent, completionPercent, targetTime, video: v };
  }

  // 当前视频是否达到配置的完成百分比
  function videoFinished() {
    return playbackProgressState().finished;
  }

  // ==========================================================================
  //  5. 识别「观看下一章节」按钮（强化识别版）
  // ==========================================================================
  // ★ 强识别：不再要求"整串文本严格相等"。
  //   实测按钮内部可能含图标/换行/零宽字符/额外 span，严格匹配会漏掉。
  //   改为：归一化文本后"包含「观看下一章节」"即可，同时用排除词挡住「重新观看本节」。
  const NEXT_BTN_TEXT = /观看下一章节|观看下一节|观看下一课/;
  const NEXT_BTN_LOOSE = /观看[^]{0,4}下[一1][章节课]|下[一1][章节课]/;
  const REJECT_BTN_TEXT = /重新观看|重播|重新播放|上一节|上一章|previous/i;

  function normalizeText(s) {
    return String(s || '')
      .replace(/[\u200b-\u200f\ufeff]/g, '')   // 零宽字符
      .replace(/\s+/g, '')                      // 所有空白
      .trim();
  }

  // 判断一个元素是否"看起来是主按钮"（蓝底/实心背景）
  function looksLikePrimary(el) {
    try {
      const st = getComputedStyle(el);
      // 自身或祖先的背景都要看（有些实现背景画在父元素上）
      for (const node of [el, el.parentElement, el.parentElement && el.parentElement.parentElement]) {
        if (!node) continue;
        let s = st;
        try { s = getComputedStyle(node); } catch (e) {}
        const bg = s.backgroundColor || '';
        const m = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?/);
        if (!m) continue;
        const r = +m[1], g = +m[2], b = +m[3];
        const alpha = m[4] === undefined ? 1 : +m[4];
        if (alpha < 0.5) continue;                 // 透明背景不算
        const isBlue = b > r + 40 && b > 120;      // 蓝色系
        if (isBlue) return true;
      }
      return false;
    } catch (e) { return false; }
  }

  // ==========================================================================
  //  ★ 决定性判据：元素是否"真的在屏幕上、真的能点"
  //
  //  旧实现只检查元素自身（尺寸/opacity），漏掉了两种真实情况：
  //    ① 平台关闭弹窗时用 opacity:0 + pointer-events:none 淡出，
  //       元素自身尺寸仍在、自身 opacity 仍是 1（0 设在父容器上）
  //       → 被误判为"可见"，脚本锲而不舍地去点一个屏幕上不存在的东西
  //    ② 元素被其他元素遮挡
  //
  //  唯一可靠的验证方式：取元素中心点，用 elementFromPoint 做命中测试——
  //  如果那个坐标上返回的不是它（或它的子孙/祖先），说明屏幕上那个位置根本不是它。
  // ==========================================================================
  function isElementDisplayed(el) {
    if (!el || !el.isConnected) return false;
    let p = el, depth = 0;
    while (p && depth++ < 40) {
      let st;
      try { st = getComputedStyle(p); } catch (e) { st = null; }
      if (st) {
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        if (Number(st.opacity) === 0) return false;
        if (p !== el && st.pointerEvents === 'none') return false;
      }
      p = p.parentElement;
    }

    let r;
    try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    if (r.width <= 0 || r.height <= 0) return false;

    const vw = window.innerWidth || 0, vh = window.innerHeight || 0;
    if (vw && vh) {
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return false;
    }
    return true;
  }

  function isReallyClickable(el) {
    if (!isElementDisplayed(el)) return false;

    // 尺寸必须真的可点
    let r;
    try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    if (r.width < 24 || r.height < 12) return false;

    // 决定性命中测试：中心点上取到的必须是它自己（或它的子孙/祖先）
    //    若环境不支持 elementFromPoint（极少数情况），降级为"祖先链检查已通过"，
    //    此时仍比旧版严格得多（旧版连祖先都没查）。
    if (typeof document.elementFromPoint !== 'function') return true;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let hit = null;
    try { hit = document.elementFromPoint(cx, cy); } catch (e) { hit = null; }
    if (!hit) {
      // 取不到命中元素：若 elementFromPoint 本身返回 null，说明该坐标上确实没有可点元素
      // （但某些浏览器在滚动/变换期间也会返回 null，所以给一次容错机会）
      return false;
    }
    if (hit === el) return true;
    // 命中的是它的子孙（例如按钮内的 span / 图标）
    try { if (el.contains && el.contains(hit)) return true; } catch (e) {}
    // 命中的是它的祖先 —— 只有一种合理情况：按钮本体 pointer-events:none，
    // 事件穿透到父容器（此时点父容器才是有效点击）。其它情况说明那个坐标上不是按钮。
    try {
      if (hit.contains && hit.contains(el)) {
        let q = el, d3 = 0;
        while (q && q !== hit && d3++ < 12) {
          let st = null;
          try { st = getComputedStyle(q); } catch (e) {}
          if (st && st.pointerEvents === 'none') return true;   // 确实穿透，可点父容器
          q = q.parentElement;
        }
        return false;   // 祖先可点但按钮本身也参与命中 → 说明坐标不在按钮上
      }
    } catch (e) {}
    return false;
  }

  // 自动点击必须同时命中文案和弹窗上下文。仅凭"蓝色主按钮"会在普通播放器里
  // 误把目录、播放器等蓝色控件当成下一章节按钮。
  function nextChapterDialogFor(el) {
    if (isOwnUI(el)) return null;
    let p = el, depth = 0;
    while (p && p !== document.body && depth++ < 12) {
      if (!isOwnUI(p) && isElementDisplayed(p)) {
        const t = normalizeText(p.textContent);
        if (t.length <= 260 && /下一章节|下一(节|课)/.test(t)) return p;
      }
      p = p.parentElement;
    }
    return null;
  }

  function findNextChapterCandidates(options = {}) {
    const out = [];
    const strict = options.strict === true;
    const accept = (el) => {
      if (isOwnUI(el)) return false;
      if (!isReallyClickable(el)) return false;
      return !strict || !!nextChapterDialogFor(el);
    };
    const sels = 'button, a, [role="button"], [class*="btn"], [class*="button"], .el-button, div, span';
    for (const el of qsa(sels)) {
      if (!el.isConnected) continue;
      // ★ 双重可见性：visible() 快筛 + isReallyClickable() 屏幕命中测试
      if (!visible(el)) continue;
      const t = normalizeText(el.textContent);
      if (!t) continue;
      if (t.length > 24) continue;                 // 放宽：原来 20 太紧
      if (REJECT_BTN_TEXT.test(t)) continue;       // 先排除「重新观看本节」等
      if (NEXT_BTN_TEXT.test(t)) { if (accept(el)) out.push(el); continue; }
    }
    if (out.length) return out;

    // ---- 兜底 1：宽松文案（可能平台改了措辞） ----
    for (const el of qsa('button, a, [role="button"], [class*="btn"], .el-button')) {
      if (!el.isConnected || !visible(el)) continue;
      const t = normalizeText(el.textContent);
      if (!t || t.length > 24) continue;
      if (REJECT_BTN_TEXT.test(t)) continue;
      if (NEXT_BTN_LOOSE.test(t)) { if (accept(el)) out.push(el); continue; }
    }
    if (out.length) return out;

    // ---- 兜底 2：结构化 —— 含「下一章节」标题的弹窗里的蓝色主按钮 ----
    const dialogs = qsa('.el-dialog, .ant-modal, [class*="dialog"], [class*="modal"], [class*="popup"], [class*="popover"], [class*="mask"]')
      .filter((d) => d.isConnected && visible(d) && /下一章节|下一节|下一课/.test(normalizeText(d.textContent)));
    for (const d of dialogs) {
      const btns = qsa('button, [role="button"], .el-button, [class*="btn"]', d).filter((b) => {
        if (!b.isConnected || !visible(b)) return false;
        const t = normalizeText(b.textContent);
        if (REJECT_BTN_TEXT.test(t)) return false;
        if (t.length > 24) return false;
        if (!looksLikePrimary(b)) return false;
        return accept(b);                     // 屏幕命中 + 弹窗上下文
      });
      if (btns.length) {
        btns.sort((a, b) => ((b.offsetWidth || 0) * (b.offsetHeight || 0)) - ((a.offsetWidth || 0) * (a.offsetHeight || 0)));
        out.push(btns[0]);
        break;
      }
    }
    return out;
  }

  // ★ 点击闸门（严格版）：
  //   点过一次后，在"确认结果"出来之前，绝不再点同一个按钮。
  //   只在这三种情况解锁：① 换节成功 ② 弹窗消失 ③ 确认失败且退避结束。
  //   这实现了用户要的"看到就点"，同时避免弹窗挂着不走时被狂点。
  let gateOpen = true;          // 闸门是否开放
  let gatedEl = null;           // 已点击过的按钮（弱引用，便于判断是否还在页面上）
  let lastBtnClickAt = 0;

  function gateUnlock(reason) {
    if (gateOpen) return;
    gateOpen = true;
    gatedEl = null;
    log('已解锁，可点击下一节（' + reason + '）');
  }

  // 返回 true=已点击；返回 false=未点击（原因见 lastClickSkipReason）
  let lastClickSkipReason = '';
  let lastClickVideoTime = -1;   // 点击前的视频进度（判断是否真的换节）
  function doClickNext(el, label, strict) {
    lastClickSkipReason = '';
    if (!el) { lastClickSkipReason = '目标元素为空'; return false; }
    const now = Date.now();
    // 闸门关闭中：说明上一次点击还在等确认结果，不能再点。
    // ⚠️ 必须返回 false（而不是 true）：否则调用方会误以为"刚点过了"，
    //    从而重复启动 confirmJump 会话，把真正的确认会话作废，导致闸门永不解锁。
    if (!gateOpen) { lastClickSkipReason = '闸门关闭中（上一次点击还在等确认）'; return false; }
    // 点击前再做一次命中测试：延迟期间弹窗可能已经收起/被覆盖
    if (!isReallyClickable(el)) {
      lastClickSkipReason = '元素此刻不在屏幕上（已被隐藏/覆盖/移出视口）';
      return false;
    }
    if (strict && !nextChapterDialogFor(el)) {
      lastClickSkipReason = '按钮已不在可见的下一章节弹窗内';
      return false;
    }
    // 点击前快照视频进度：换节会让视频重新从头播，这是最客观的"已换节"信号。
    // 必须在派发点击**之前**取——平台可能在点击处理器里同步重置播放进度。
    lastClickVideoTime = -1;
    try {
      const v0 = mainVideo();
      if (v0 && isFinite(v0.currentTime)) lastClickVideoTime = v0.currentTime;
    } catch (e) {}

    if (!clickEl(el)) { lastClickSkipReason = '派发点击事件失败'; return false; }
    gateOpen = false;
    gatedEl = el;
    lastBtnClickAt = now;
    lastJump = now + (cfg.cooldown || 0) * 1000;
    pptSince = 0;
    consecutiveJumps++;
    const r0 = (function () { try { return el.getBoundingClientRect(); } catch (e) { return null; } })();
    log('已点击「观看下一章节」' + (label ? '（' + label + '）' : '') +
      (r0 ? ' @' + Math.round(r0.left + r0.width / 2) + ',' + Math.round(r0.top + r0.height / 2) : '') +
      (cfg.cooldown > 0 ? '，冷却 ' + cfg.cooldown + 's' : '（无冷却模式）'));
    return true;
  }

  function clickNextChapterButton(options = {}) {
    const strict = options.strict !== false;
    // ---------- 路线 A：精确文案「观看下一章节」（主路径）----------
    const cands = findNextChapterCandidates({ strict });
    if (cands.length) {
      // 排除误判：祖先/后代里含"重新观看本节"的不要
      const safe = cands.filter((el) => {
        const around = text(el.parentElement) + ' ' + text(el.closest('.el-dialog, .ant-modal, [class*="dialog"], [class*="modal"]'));
        return !REJECT_BTN_TEXT.test(around) || looksLikePrimary(el);
      });
      const pool = safe.length ? safe : cands;
      // 排序：① 优先"本身语义可点"的元素（防点到 btn-wrap 这类包裹层，点它不触发真实处理器）
      //       ② 再看蓝色主按钮  ③ 最后看面积
      pool.sort((a, b) => {
        const sa = (a.tagName === 'BUTTON' || a.tagName === 'A' ||
          (a.getAttribute && a.getAttribute('role') === 'button')) ? 1 : 0;
        const sb = (b.tagName === 'BUTTON' || b.tagName === 'A' ||
          (b.getAttribute && b.getAttribute('role') === 'button')) ? 1 : 0;
        if (sa !== sb) return sb - sa;
        const pa = looksLikePrimary(a) ? 1 : 0, pb = looksLikePrimary(b) ? 1 : 0;
        if (pa !== pb) return pb - pa;
        return ((b.offsetWidth || 0) * (b.offsetHeight || 0)) - ((a.offsetWidth || 0) * (a.offsetHeight || 0));
      });
      // 统一解析到真正可点的元素
      const clickTarget = resolveClickable(pool[0]);

      const isPrimary = looksLikePrimary(clickTarget) || looksLikePrimary(pool[0]);
      if (cfg.instantClick) {
        return doClickNext(clickTarget, isPrimary ? '蓝色主按钮' : '文案匹配', strict);
      }
      setTimeout(() => doClickNext(clickTarget, isPrimary ? '蓝色主按钮' : '文案匹配', strict), rndInt(800, 1800));
      return true;
    }

    // ---------- 路线 B：旧版 .right 容器（保留兼容） ----------
    for (const r of qsa('.right, div.right')) {
      if (!visible(r)) continue;
      if (text(r).indexOf('观看下一章节') === -1) continue;
      if (REJECT_BTN_TEXT.test(text(r)) && !/观看下一章节/.test(text(r))) continue;

      let target = null;
      const inner = r.querySelector('button, a, [role="button"], [class*="btn"], [class*="Btn"]');
      if (inner && visible(inner)) target = inner;
      if (!target) {
        const leaves = qsa('button, a, span, div, [role="button"]', r)
          .filter((el) => text(el).indexOf('观看下一章节') !== -1)
          .sort((a, b) => (a.offsetHeight * a.offsetWidth) - (b.offsetHeight * b.offsetWidth));
        if (leaves.length) target = leaves[0];
      }
      if (!target) target = r;
      target = resolveClickable(target);   // 统一落到真正可点的元素
      if (strict && !nextChapterDialogFor(target)) continue;

      if (cfg.instantClick) return doClickNext(target, '.right 容器·立即', strict);
      setTimeout(() => doClickNext(target, '.right 容器', strict), rndInt(800, 1800));
      return true;
    }

    // ---------- 路线 C：模糊兜底 ----------
    for (const el of qsa('button, a, [role="button"], .el-button')) {
      if (!visible(el)) continue;
      const t = normalizeText(el.textContent);
      if (t.length > 24) continue;
      if (REJECT_BTN_TEXT.test(t)) continue;                    // 严格排除重播/上一节
      if (/观看下一章节|观看下一节|下一章节|下一节/.test(t)) {
        if (doClickNext(resolveClickable(el), '模糊匹配:"' + t + '"', strict)) return true;
      }
    }
    return false;
  }

  function ensureVisible(el) {
    try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); } catch (e) {}
    // 侧边栏可能是虚拟滚动容器，逐级调整 scrollTop
    let p = el.parentElement, steps = 0;
    while (p && steps < 6) {
      if (p.scrollHeight > p.clientHeight) {
        try { p.scrollTop = el.offsetTop - p.clientHeight / 2; } catch (e) {}
      }
      p = p.parentElement; steps++;
    }
  }

  function hasVideoDuration(item) {
    if (!item) return false;
    const t = text(item);
    if (/\d+\s*分\s*\d+\s*秒?|\d{1,3}\s*:\s*\d{2}/.test(t)) return true;
    return !!item.querySelector('.time, .duration, [class*="duration"], [class*="time"]');
  }

  function looksLikeDocumentItem(item) {
    if (!item) return false;
    const hintPattern = /pdf|ppt|pptx|docx?|word|excel|document|file|wenjian|kejian/i;
    const nodes = [item].concat(Array.from(item.querySelectorAll ? item.querySelectorAll('*') : []));
    for (const node of nodes) {
      const cls = typeof node.className === 'string' ? node.className : '';
      const hints = [
        cls, node.id || '', node.getAttribute && node.getAttribute('data-icon'),
        node.getAttribute && node.getAttribute('aria-label'),
        node.getAttribute && node.getAttribute('title'),
        node.getAttribute && node.getAttribute('alt'),
        node.getAttribute && node.getAttribute('src'),
        node.getAttribute && node.getAttribute('href'),
        node.getAttribute && node.getAttribute('xlink:href')
      ].filter(Boolean).join(' ');
      if (hintPattern.test(hints)) return true;
    }
    return false;
  }

  function collapsedCourseGroupTitle(node) {
    if (!node || !node.matches) return null;
    const cls = typeof node.className === 'string' ? node.className : '';
    const aria = node.getAttribute && node.getAttribute('aria-expanded');
    if (/el-sub-menu__title/.test(cls) && aria === 'false') return node;
    if (/el-sub-menu__title/.test(cls) && node.parentElement &&
      /(^|\s)el-sub-menu(\s|$)/.test(String(node.parentElement.className || '')) &&
      !/(^|\s)is-opened(\s|$)/.test(String(node.parentElement.className || ''))) return node;
    if (/(^|\s)el-sub-menu(\s|$)/.test(cls) && !/(^|\s)is-opened(\s|$)/.test(cls)) {
      return node.querySelector('.el-sub-menu__title');
    }
    if (aria === 'false' && /menu|chapter|section|group|chapter-list/i.test(cls)) return node;
    return null;
  }

  function expandBlockedCourseGroup() {
    if (!blockedByCollapsedGroup || !visible(blockedByCollapsedGroup)) return false;
    const now = Date.now();
    if (now - courseGroupExpandAt < 5000) return false;
    courseGroupExpandAt = now;
    clickEl(blockedByCollapsedGroup);
    log('下一视频位于折叠章节中 → 已展开后续章节');
    return true;
  }

  function isAfterInDocument(node, reference) {
    if (!node || !reference || node === reference) return false;
    try {
      if (typeof reference.compareDocumentPosition === 'function') {
        const pos = reference.compareDocumentPosition(node);
        if (pos) return !!(pos & 4); // DOCUMENT_POSITION_FOLLOWING
      }
    } catch (e) {}
    const all = qsa('*');
    const ni = all.indexOf(node), ri = all.indexOf(reference);
    return ni >= 0 && ri >= 0 && ni > ri;
  }

  function findNextVideoByDocumentOrder(reference) {
    const nodes = qsa('li.el-menu-item, [class*="menu-item"], [class*="chapter-item"], [class*="section-item"]');
    for (const node of nodes) {
      if (node === reference || !isElementDisplayed(node) || !hasVideoDuration(node)) continue;
      if (isAfterInDocument(node, reference)) return node;
    }
    return null;
  }

  function findFirstIncompleteVideoItem() {
    const items = qsa('li.el-menu-item, [class*="menu-item"], [class*="chapter-item"], [class*="section-item"]')
      .filter((node) => node && isElementDisplayed(node) && hasVideoDuration(node));
    return items.find((item) => ringState(item) === 'progress') ||
      items.find((item) => ringState(item) !== 'done') || items[0] || null;
  }

  function findNextCustomCourseHeader(reference) {
    const nodes = qsa('.el-sub-menu__title, [class*="chapter-title"], [class*="chapter-header"], ' +
      '[class*="section-title"], [class*="section-header"], [aria-expanded]');
    for (const node of nodes) {
      if (!node || node === reference || expandedCourseHeaders.has(node)) continue;
      if (!isElementDisplayed(node) || isOwnUI(node) || hasVideoDuration(node)) continue;
      const t = normalizeText(node.textContent);
      if (!t || t.length > 120 || !/第\s*[0-9一二三四五六七八九十]+\s*[讲章]/.test(t)) continue;
      const container = node.parentElement;
      const nested = Array.from(container && container.querySelectorAll ?
        container.querySelectorAll('li.el-menu-item') : []);
      const hasVisibleVideo = nested.some((item) => isElementDisplayed(item) && hasVideoDuration(item));
      if (hasVisibleVideo) continue;
      if (isAfterInDocument(node, reference)) return node;
    }
    return null;
  }

  function expandBlockedCourseHeader() {
    if (!blockedByCourseHeader || !visible(blockedByCourseHeader)) return false;
    const now = Date.now();
    if (now - courseGroupExpandAt < 5000) return false;
    courseGroupExpandAt = now;
    expandedCourseHeaders.add(blockedByCourseHeader);
    clickEl(blockedByCourseHeader);
    log('下一视频位于折叠章节中 → 已展开自定义章节标题');
    return true;
  }

  // 穿透搜索：从当前高亮节点向后找下一个可点击的视频章节项
  function findNextMenuItem(activeNode) {
    blockedByCollapsedGroup = null;
    blockedByCourseHeader = null;
    let cur = activeNode;
    for (let i = 0; i < 80; i++) {
      let sib = cur.nextElementSibling;
      if (!sib && cur.parentElement) {
        let p = cur.parentElement;
        while (p && !p.nextElementSibling) p = p.parentElement;
        if (p) sib = p.nextElementSibling;
      }
      if (!sib) break;
      const collapsedTitle = collapsedCourseGroupTitle(sib);
      if (collapsedTitle) {
        blockedByCollapsedGroup = collapsedTitle;
        break;
      }
      // 跳过子菜单标题，继续往后
      if (sib.matches && sib.matches('.el-sub-menu__title, .el-menu-item-group__title')) { cur = sib; continue; }
      const items = sib.querySelectorAll ? sib.querySelectorAll('li.el-menu-item') : [];
      if (items.length > 0) {
        for (const it of items) {
          const t = text(it);
          if (!t) continue;
          if (!hasVideoDuration(it)) continue;
          if (it.offsetHeight > 0 && it.offsetWidth > 0) return it;
        }
      } else if (sib.matches && sib.matches('li.el-menu-item')) {
        if (hasVideoDuration(sib)) return sib;
      }
      cur = sib;
    }
    if (blockedByCollapsedGroup) return null;
    const customHeader = findNextCustomCourseHeader(activeNode);
    if (customHeader) {
      blockedByCourseHeader = customHeader;
      return null;
    }
    return findNextVideoByDocumentOrder(activeNode);
  }

  // ==========================================================================
  //  侧边栏展开（幂等）
  //
  //  ⚠️ 血泪教训：.course-sidebar-switch 是一个**切换按钮**（toggle），
  //     点一下展开、再点一下收起。旧实现无条件点击它，于是：
  //       跳节失败 → 点一下（展开）→ 又失败 → 再点一下（收起）→ …
  //     表现为箭头反复开合、且永远切不到下一节（用户实测反馈）。
  //     正确做法：先判断当前是否已展开，只有收起状态才点；并加节流与次数上限。
  // ==========================================================================
  let sidebarToggleAt = 0;      // 上次点击侧边栏开关的时刻
  let sidebarToggleCount = 0;   // 连续点击次数（超限则熔断，避免刷屏/抖动）
  let sidebarToggleWarned = false;

  // 侧边栏当前是否可见（多种判据，任一成立即认为已展开）
  function isSidebarOpen() {
    // ① 能看到章节项 → 已展开
    const items = qsa('li.el-menu-item').filter((el) => visible(el));
    if (items.length > 0) return true;
    // ② 常见的侧边栏容器
    const sels = ['.course-sidebar', '.chapter-list', '.catalog', '.el-menu', '.menu-wrap',
      '[class*="sidebar"]', '[class*="catalog"]', '[class*="chapter-list"]'];
    for (const s of sels) {
      for (const el of qsa(s)) {
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 60 && r.height > 100) return true;
      }
    }
    // ③ 开关自身的状态类名（平台可能用 class 标记）
    const btn = document.querySelector('.course-sidebar-switch');
    if (btn) {
      const cls = typeof btn.className === 'string' ? btn.className : '';
      if (/active|open|expand|show|on\b/i.test(cls)) return true;
      // aria 属性
      const aria = (btn.getAttribute && (btn.getAttribute('aria-expanded') || '')) || '';
      if (aria === 'true') return true;
    }
    return false;
  }

  // 确保侧边栏展开。已展开则什么都不做（幂等）。
  function openSidebarSwitch() {
    if (isSidebarOpen()) { sidebarToggleCount = 0; return true; }   // 已展开，不动手

    const btn = document.querySelector('.course-sidebar-switch');
    if (!btn || !visible(btn)) return false;

    // 节流：5 秒内最多点一次（切换类按钮绝不能被高频点）
    const now = Date.now();
    if (now - sidebarToggleAt < 5000) return false;

    // 熔断：连续点 3 次仍没展开 → 说明这个按钮不是侧边栏开关，别再点了
    if (sidebarToggleCount >= 3) {
      if (!sidebarToggleWarned) {
        sidebarToggleWarned = true;
        log('⚠️ 侧边栏开关点击 ' + sidebarToggleCount + ' 次仍未展开 → 已停止点击它（可能不是侧边栏开关）');
      }
      return false;
    }

    sidebarToggleAt = now;
    sidebarToggleCount++;
    try { clickEl(btn); } catch (e) {}
    log('侧边栏处于收起状态 → 点击展开（第 ' + sidebarToggleCount + ' 次）');
    // 给它 500ms 展开时间
    return true;
  }

  function gotoNextSection(options = {}) {
    const force = options.force === true;
    if (!force) {
      const playback = playbackProgressState();
      if (playback.hasVideo && !playback.finished) return false;
    }
    // 幂等展开：已展开则不动手（关键修复——旧版无条件点击导致开关反复开合）
    const wasOpen = isSidebarOpen();
    if (!wasOpen) {
      const nowTried = openSidebarSwitch();
      if (nowTried) {
        // 刚点了展开，侧边栏需要渲染时间；本次先返回，让下一轮再取章节，
        // 避免"刚点完就去读 DOM、读到空 → 又点一次"的抖动。
        log('侧边栏已展开，等待渲染后再跳转');
        setTimeout(() => { try { gotoNextSection(options); } catch (e) {} }, 900);
        return true;
      }
      log('侧边栏处于收起状态且无法展开，跳过本次跳转');
      return false;
    }

    sidebarToggleCount = 0;   // 已展开，重置熔断计数
    const active = activeMenuItem() ||
      (lastActiveMenuNode && lastActiveMenuNode.isConnected ? lastActiveMenuNode : null);
    const next = active ? findNextMenuItem(active) : findFirstIncompleteVideoItem();
    if (!next) {
      if ((blockedByCourseHeader && expandBlockedCourseHeader()) ||
        (blockedByCollapsedGroup && expandBlockedCourseGroup())) {
        setTimeout(() => { try { gotoNextSection(options); } catch (e) {} }, 800);
        return true;
      }
      log('已是最后一节，或后续章节尚未展开');
      return false;
    }
    const curTxt = active ? text(active).slice(0, 20) : '当前空节点';
    const nxtTxt = text(next).slice(0, 24);
    ensureVisible(next);
    setTimeout(() => {
      if (!visible(next)) ensureVisible(next);
      if (clickEl(next)) {
        lastJump = Date.now() + cfg.cooldown * 1000;
        pptSince = 0; consecutiveJumps++;
        log('侧边栏跳转："' + curTxt + '" → "' + nxtTxt + '"');
      }
    }, 400);
    return true;
  }

  // ==========================================================================
  //  8. 主循环
  // ==========================================================================
  function mainTick() {
    tick++;
    if (!cfg.enabled) { updateStatus(); return; }

    if (!isForegroundActive()) {
      pauseForBackground();
      if (!foregroundWarningLogged) {
        foregroundWarningLogged = true;
        log('课程窗口不在前台，已暂停自动操作；请保持播放器窗口在最上方');
      }
      updateStatus();
      return;
    }
    foregroundWarningLogged = false;

    if (cfg.autoPlay) keepPlay();

    // 课件不参与考核：停留一小段时间后直接切到目录中的下一个视频。
    if (cfg.skipCourseware && !hasVideoPageEvidence() && isStaticOrPpt()) {
      if (pptSince === 0) pptSince = Date.now();
      if (Date.now() - pptSince >= Math.max(0, cfg.pptDwell) * 1000) attemptCoursewareSkip();
      updateStatus();
      return;
    }
    pptSince = 0;

    // 章节播报降频：每 60 个 tick（约 30 秒）一次，避免日志被刷屏
    if (tick % 60 === 0) {
      const a = activeMenuItem();
      log('#' + tick + ' 当前章节: ' + (a ? text(a).slice(0, 20) : '(未识别 ' + lastMenuDiag + ')'));
    }

    const v = mainVideo();
    if (v) {
      if (v !== video) {
        video = v;
        log('已接管视频：时长 ' + (isFinite(v.duration) ? Math.round(v.duration) + 's' : '未知'));
      }
      applyRate(v);
    }

    if (!cfg.autoNext) { updateStatus(); return; }

    // 注：立即点击模式已剥离为独立的 10 秒扫描器（nextScanner），
    //     这里只处理"传统判定"路径（关闭立即模式时才会走到）。

    if (!sectionComplete()) { consecutiveJumps = 0; updateStatus(); return; }
    if (Date.now() < lastJump) return;
    if (Date.now() < jumpBackoffUntil) return;   // 连续无效跳转的退避期

    // 连续跳转保护：连续 3 次说明可能节点识别有问题，暂停一会儿
    if (consecutiveJumps >= 3) {
      log('连续跳转 ' + consecutiveJumps + ' 次，暂停 50 秒（防误判）');
      lastJump = Date.now() + 50000;
      consecutiveJumps = 0;
      return;
    }

    log('本节已完成，准备跳转');
    const beforeSig = sectionSignature();
    if (clickNextChapterButton()) { confirmJump(beforeSig); return; }

    // ⚠️ 互斥：主循环每 0.5 秒一次，若不锁，这里会不断排新的 5 秒定时器；
    //    几秒后几十个定时器同时触发 gotoNextSection() → 侧边栏被疯狂开合。
    if (pendingJumpAttempt) return;
    pendingJumpAttempt = true;
    setTimeout(() => {
      pendingJumpAttempt = false;
      if (!cfg.enabled || !cfg.autoNext) return;
      // ⚠️ 只有"真的点下去了"才启动确认会话。
      //    旧版无条件调 confirmJump → jumpSession++ → 把扫描器正在等的会话作废
      //    → 扫描器的 tickCheck 提前 return，永不调用 gateUnlock → 闸门永久锁死。
      if (clickNextChapterButton()) { confirmJump(beforeSig); return; }
      gotoNextSection();
    }, 5000);
  }

  // ==========================================================================
  //  8.5 独立扫描器（用户指定）：每 10 秒检查一次是否出现蓝色「观看下一章节」
  //      出现 → 随机延迟 0.3~2.5 秒后点击 → 立即进入下一轮
  // ==========================================================================
  let scanTimer = null;
  let scanCount = 0;
  let pendingClick = false;   // 已排程的随机延迟点击，避免重复排程
  let lastScanAt = 0;         // 上次扫描时刻（供 DOM 兜底路径限频）
  let lastPlaybackGuardLogAt = 0;

  function nextScanner() {
    if (scanTimer) clearTimeout(scanTimer);
    const period = Math.max(2, cfg.scanEvery || 10) * 1000;
    scanTimer = setTimeout(() => scanTick(true), period);
  }

  // reschedule=true：正常周期扫描（完成后重排下一轮）
  // reschedule=false：DOM 变化触发的提前检查（不重排，避免打乱周期）
  function scanTick(reschedule) {
    lastScanAt = Date.now();
    // ★ 闸门看门狗：闸门是"防狂点"用的，但若因任何原因没能解锁，
    //   脚本会永久卡在"闸门关闭中"。这里做最终兜底：距上次点击超过 20 秒
    //   且闸门仍关着 → 强制解锁。
    //   ⚠️ 只解锁闸门，**不动 consecutiveJumpFails / jumpBackoffUntil**——
    //      那两个是"退避状态"，由确认流程管理。在这里清零会导致退避永远
    //      停在最小值（实测：每 60 秒点一次，31 分钟 93 次）。
    try {
      if (!gateOpen && lastBtnClickAt && Date.now() - lastBtnClickAt > 20000) {
        gateUnlock('看门狗：距上次点击超过 20 秒');
      }
    } catch (e) {}
    try {
      const onCourseware = cfg.skipCourseware && !hasVideoPageEvidence() && isStaticOrPpt();
      if (cfg.enabled && cfg.autoNext && cfg.instantClick && !pendingClick && !onCourseware) {
        scanCount++;
        const hit = primaryNextButton();
        if (hit) {
          // 防跳过头：视频本体仍在播放时，不信任页面残留的按钮/状态环。
          const playback = playbackProgressState();
          const guardBlocked = cfg.guardSkipAhead && playback.hasVideo && !playback.finished;
          if (guardBlocked) {
            if (Date.now() - lastPlaybackGuardLogAt > 60000) {
              lastPlaybackGuardLogAt = Date.now();
              const progress = playback.duration > 0
                ? Math.floor(playback.currentTime) + '/' + Math.floor(playback.duration) + 's，剩余 ' + Math.ceil(playback.remaining) + 's'
                : '时长未就绪';
              log('扫描#' + scanCount + '：检测到疑似下一章节入口，但视频仍在播放（' +
                progress + '）→ 防跳过头已拦截');
            }
          } else if (Date.now() < jumpBackoffUntil) {
            // ★ 退避要能被打破（否则"按钮在却永远不点"），但打破的门槛
            //   必须**不低于退避本身**——否则刚设的 60 秒退避会被 10 秒的
            //   "距上次点击已够久"立刻打破，退避形同虚设。
            const left = Math.ceil((jumpBackoffUntil - Date.now()) / 1000);
            const sinceLastClick = Date.now() - lastBtnClickAt;
            const backoffTotal = Math.max(1000, jumpBackoffUntil - lastBtnClickAt);
            const longEnough = sinceLastClick > Math.max(backoffTotal, (cfg.scanEvery || 10) * 1000);
            if (longEnough) {
              // 打破退避：按钮确实在，且距上次点击已超过整个退避周期 → 允许重试。
              // ⚠️ 只清退避截止时间，**不清 consecutiveJumpFails**——
              //    否则每次打破都把计数归零，退避永远停在最小值，
              //    变成"每 60 秒点一次"的稳定循环（实测 31 分钟 92 次）。
              jumpBackoffUntil = 0;
              gateUnlock('按钮持续存在 → 打破退避重试');
              log('扫描#' + scanCount + '：按钮持续存在（距上次点击 ' +
                Math.round(sinceLastClick / 1000) + 's）→ 解除退避，本次正常处理');
            } else {
              log('扫描#' + scanCount + '：发现按钮，但退避中（还剩 ' + left + 's）');
            }
          }
          if (!guardBlocked && Date.now() >= jumpBackoffUntil) {
            // 使用短随机延迟，避免与页面渲染时序发生固定碰撞。
            const delay = rnd(cfg.clickDelayMin || 0.3, Math.max(cfg.clickDelayMin || 0.3, cfg.clickDelayMax || 2.5));
            pendingClick = true;
            const hitText = normalizeText(hit.textContent).slice(0, 20) || '弹窗主按钮';
            log('扫描#' + scanCount + '：识别到下一章节弹窗按钮「' + hitText + '」，' + delay.toFixed(1) + ' 秒后点击');
            setTimeout(() => {
              pendingClick = false;
              if (!cfg.enabled || !cfg.autoNext || !cfg.instantClick) return;
              if (Date.now() < jumpBackoffUntil) return;
              const latestPlayback = playbackProgressState();
              if (cfg.guardSkipAhead && latestPlayback.hasVideo && !latestPlayback.finished) {
                log('延迟期间视频仍在播放 → 取消本次跳节');
                return;
              }
              const sig = sectionSignature();
              // 重新确认按钮还在（延迟期间可能已消失）
              const still = primaryNextButton();
              if (!still) { log('延迟期间按钮已消失，取消点击'); return; }
              if (clickNextChapterButton({ strict: true })) { confirmJump(sig); return; }
              // 准确报告原因，不要笼统写"点击未生效"（会误导排查）
              log('本次未点击：' + (lastClickSkipReason || '未知原因'));
            }, delay * 1000);
          }
        } else if (scanCount % 6 === 0) {
          // 没找到按钮 = 当前节还在播，一切正常 → 清空失败计数（避免陈旧计数累积）
          consecutiveJumpFails = 0;
          jumpBackoffUntil = 0;
          // 每 6 轮（约 1 分钟）播报一次"没找到"，便于排查
          log('扫描#' + scanCount + '：未发现「观看下一章节」按钮（诊断：候选=' +
            findNextChapterCandidates({ strict: true }).length + '，章节=' + qsa('li.el-menu-item').length + '）');
        }
      }
    } catch (e) {
      log('扫描异常: ' + (e && e.message ? e.message : e));
    }
    if (reschedule) nextScanner();
  }

  // 返回当前页面上"可点的下一章节按钮"，无则 null
  // ★ 关键：必须落到"真正可点的元素"上。
  //   实测坑：蓝色背景可能画在包裹层 <div> 上，而真按钮是它的子 <button>。
  //   点包裹层在真实浏览器里不一定触发按钮处理器 → 这里统一做"向下找真按钮"。
  function resolveClickable(el) {
    if (!el) return null;
    // ① 自身就是"语义上可点"的标签。
    //    注意：不能用 [class*="btn"] 判断——btn-wrap / btn-box 这类包裹层 class 也含 btn，
    //    会把包裹层误判成按钮，点上去不触发真实处理器。
    const isSemanticButton = (n) => !!n && (n.tagName === 'BUTTON' || n.tagName === 'A' ||
      (n.getAttribute && n.getAttribute('role') === 'button'));
    if (isSemanticButton(el)) return el;
    // ② 向下找真按钮（避免点到包裹层）
    try {
      const inner = el.querySelector && el.querySelector('button, a, [role="button"]');
      if (inner && inner.isConnected && visible(inner)) return inner;
    } catch (e) {}
    // ③ 向上找（按钮被包在容器里的情况）
    const anc = el.closest && el.closest('button, a, [role="button"]');
    if (anc && anc.isConnected && visible(anc)) return anc;
    // ④ 兜底：自身（有些实现确实用 div 当按钮，靠 click 监听器）
    return el;
  }

  function primaryNextButton() {
    const cands = findNextChapterCandidates({ strict: true });
    if (!cands.length) return null;
    const safe = cands.filter((el) => {
      const around = text(el.parentElement) + ' ' +
        text(el.closest('.el-dialog, .ant-modal, [class*="dialog"], [class*="modal"]'));
      return !REJECT_BTN_TEXT.test(around) || looksLikePrimary(el);
    });
    const pool = safe.length ? safe : cands;
    pool.sort((a, b) => {
      // ① 优先"本身可点"的元素（button/a/role=button），而不是恰好有蓝背景的包裹层
      const ca = (a.tagName === 'BUTTON' || a.tagName === 'A' ||
        (a.getAttribute && a.getAttribute('role') === 'button')) ? 1 : 0;
      const cb = (b.tagName === 'BUTTON' || b.tagName === 'A' ||
        (b.getAttribute && b.getAttribute('role') === 'button')) ? 1 : 0;
      if (ca !== cb) return cb - ca;
      // ② 再看蓝色主按钮
      const pa = looksLikePrimary(a) ? 1 : 0, pb = looksLikePrimary(b) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      // ③ 最后看面积（真按钮通常比内部 span 大）
      return ((b.offsetWidth || 0) * (b.offsetHeight || 0)) - ((a.offsetWidth || 0) * (a.offsetHeight || 0));
    });
    return resolveClickable(pool[0]);
  }

  // 当前章节指纹（用于判断点击后是否真的换节了）
  function sectionSignature() {
    const a = activeMenuItem();
    if (a) return text(a).slice(0, 40);
    const v = mainVideo();
    return v ? ('video:' + (v.currentSrc || v.src || '').slice(-40) + ':' + Math.round(v.duration || 0)) : '(none)';
  }

  // 点击后 4 秒检查是否真的换节；没换则指数退避，避免"最后一节"被无限重复点击
  // 点击后确认是否真的换节。
  // 注意：换节是异步的（视频加载 1~5 秒），所以采用"多次采样 + 任一成功即算成功"。
  // ⚠️ 必须防止并发：事件驱动 + 轮询会同时触发多次点击，若每次都起一组采样定时器，
  //    consecutiveJumpFails 会被重复累加导致退避时间失控。用会话 id 串行化。
  let jumpSession = 0;
  function confirmJump(beforeSig) {
    const mySession = ++jumpSession;

    // 点击成功后再抓"点击前"的进度已经晚了（平台可能已同步重置视频），
    // 所以用 doClickNext 在派发点击**之前**记录的快照。
    let srcTimeBefore = lastClickVideoTime;
    try {
      if (srcTimeBefore < 0) {
        const v0 = mainVideo();
        if (v0 && isFinite(v0.currentTime)) srcTimeBefore = v0.currentTime;
      }
    } catch (e) {}

    // ★ 安全网：无论确认流程因何中断（会话被作废、异常、提前 return），
    //   闸门都不能永久关闭——否则脚本会卡在"闸门关闭中"再也点不动。
    //   只解锁闸门，不动退避状态（同看门狗的理由）。
    try {
      setTimeout(() => {
        if (mySession === jumpSession && !gateOpen) {
          gateUnlock('确认超时兜底');
        }
      }, 12000);
    } catch (e) {}

    const samples = [2500, 5000, 8000];
    let idx = 0;
    const tickCheck = () => {
      if (mySession !== jumpSession) return;   // 已有更新的会话，这次作废

      const afterSig = sectionSignature();
      const sigChanged = !!(afterSig && afterSig !== beforeSig);

      // 客观判据 ①：视频重新从头播 → 明确换节成功
      // （比章节签名可靠：签名依赖侧边栏高亮，收起时读不到）
      // 判据：进度比点击前显著回退。用"回退量"而非"绝对门槛"，
      // 避免 srcTimeBefore 刚好在阈值附近时漏判。
      let videoRestarted = false;
      try {
        const v1 = mainVideo();
        if (v1 && isFinite(v1.currentTime) && srcTimeBefore > 3) {
          const back = srcTimeBefore - v1.currentTime;
          if (back > 5 && v1.currentTime < srcTimeBefore * 0.6) videoRestarted = true;
        }
        // 视频元素被整体替换（换源）也算换节
        if (video && v1 && v1 !== video) videoRestarted = true;
      } catch (e) {}

      // 客观判据 ②：点击后弹窗是否真的消失了
      const btnStillOnScreen = !!(gatedEl && gatedEl.isConnected && isReallyClickable(gatedEl));
      const anyBtnNow = !!primaryNextButton();

      if (sigChanged || videoRestarted) {
        consecutiveJumpFails = 0;
        jumpBackoffUntil = 0;
        gateUnlock('跳转成功' + (videoRestarted ? '（视频已重新开始）' : ' → ' + afterSig.slice(0, 24)));
        return;
      }

      // ★ 弹窗消失 = 成功。
      //   旧版在这里判"失败"并退避 → 退避指数增长 → 永久卡在"退避中"。
      if (!btnStillOnScreen && !anyBtnNow) {
        consecutiveJumpFails = 0;
        jumpBackoffUntil = 0;
        gateUnlock('弹窗已消失（视为跳转成功）');
        return;
      }

      idx++;
      if (idx < samples.length) {
        setTimeout(tickCheck, samples[idx] - samples[idx - 1]);
        return;
      }
      if (mySession !== jumpSession) return;

      // ★ 弹窗又出现了 —— 这**不一定是失败**！
      //   很可能是：换节成功了，而新的一节也已经播完，平台再次弹出提示。
      //   此时唯一可靠的判断是"视频有没有往前走过"：
      //   · 视频进度比点击时更靠前 → 说明确实换了节并在播放 → 视为成功
      //   · 进度几乎没动 → 才是真的卡住了
      let progressed = false;
      try {
        const v2 = mainVideo();
        if (v2 && isFinite(v2.currentTime) && srcTimeBefore >= 0) {
          progressed = v2.currentTime > srcTimeBefore + 3;
        }
      } catch (e) {}
      if (progressed) {
        consecutiveJumpFails = 0;
        jumpBackoffUntil = 0;
        gateUnlock('视频已继续播放（视为跳转成功）');
        return;
      }

      // 到这里才是真的没跳成。
      // 区分两种"没跳成"：
      //   a) 已是最后一节 → 章节列表里当前项后面没有兄弟 → 长期退避（避免无意义地反复点）
      //   b) 其他原因（网络慢/平台卡）→ 温和退避，很快重试
      let isLastSection = false;
      try {
        const cur = activeMenuItem();
        if (cur && !findNextMenuItem(cur)) isLastSection = true;
      } catch (e) {}

      consecutiveJumpFails++;
      const wait = isLastSection
        ? Math.min(60000 * consecutiveJumpFails, 600000)   // 最后一节：60s 起，最多 10 分钟
        : Math.min(6000 * consecutiveJumpFails, 30000);    // 其他：6s 起，最多 30 秒
      jumpBackoffUntil = Date.now() + wait;
      log('点击后弹窗仍在且视频无进展（第 ' + consecutiveJumpFails + ' 次' +
        (isLastSection ? '，且已是最后一节' : '') + '）→ 暂停 ' +
        Math.round(wait / 1000) + ' 秒后重试');
      setTimeout(() => gateUnlock('退避结束'), wait);
    };
    setTimeout(tickCheck, samples[0]);
  }

  // 头部状态灯：运行中(绿) / 关闭(红) / 暂停或退避(黄闪)
  function updateHeadDot() {
    if (!panel) return;
    const dot = panel.querySelector('#bl-dot');
    if (!dot) return;
    let cls = '';
    if (!cfg.enabled) cls = 'off';
    else if (Date.now() < jumpBackoffUntil || pendingClick) cls = 'busy';
    dot.className = 'bl-dot' + (cls ? ' ' + cls : '');
  }

  // 实时状态卡：章节名 + 播放进度 + 进度环
  function updateLive() {
    if (!panel) return;
    const l1 = panel.querySelector('#bl-l1');
    const l2 = panel.querySelector('#bl-l2');
    const ring = panel.querySelector('#bl-ring');
    const pct = panel.querySelector('#bl-pct');
    if (!l1 || !l2) return;

    const a = activeMenuItem();
    const v = mainVideo();

    // 第一行：当前章节
    l1.textContent = a ? text(a).replace(/\s+/g, ' ').slice(0, 26)
      : ('未识别到章节列表' + (lastMenuDiag ? '（' + lastMenuDiag + '）' : ''));

    // 第二行：播放状态 + 扫描器状态
    const bits = [];
    if (v && isFinite(v.duration) && v.duration > 0) {
      const cur = v.currentTime || 0;
      bits.push(fmtTime(cur) + ' / ' + fmtTime(v.duration));
      bits.push(v.paused ? '已暂停' : '播放中');
      if (v.playbackRate && Math.abs(v.playbackRate - 1) > 0.01) bits.push(v.playbackRate + 'x');
    } else {
      bits.push('未找到视频');
    }
    if (Date.now() < jumpBackoffUntil) {
      bits.push('退避 ' + Math.ceil((jumpBackoffUntil - Date.now()) / 1000) + 's');
    } else {
      bits.push('已扫描 ' + scanCount + ' 轮');
    }
    l2.textContent = bits.join(' · ');

    // 进度环
    if (ring && pct) {
      let deg = 0, label = '--';
      if (v && isFinite(v.duration) && v.duration > 0) {
        const ratio = Math.max(0, Math.min(1, (v.currentTime || 0) / v.duration));
        deg = ratio * 360;
        label = Math.round(ratio * 100) + '%';
      }
      ring.style.background = 'conic-gradient(#165DFF ' + deg + 'deg,#E5E6EB ' + deg + 'deg)';
      pct.textContent = label;
    }
    updateHeadDot();
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function updateStatus() {
    try { updateLive(); } catch (e) {}
  }

  // ==========================================================================
  //  9. 面板
  // ==========================================================================
  function renderLog() {
    if (!panel) return;
    const box = panel.querySelector('#bl-log');
    if (!box) return;
    // 按内容着色，便于一眼看出成功/失败
    box.innerHTML = logs.slice(-60).map((l) => {
      const esc = String(l).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      let cls = '';
      if (/失败|异常|未找到|错误/.test(l)) cls = 'bl-err';
      else if (/已点击|跳转成功|已解锁|已设置|已恢复/.test(l)) cls = 'bl-ok';
      else if (/退避|暂停|未换节|跳过/.test(l)) cls = 'bl-warn';
      return '<div' + (cls ? ' class="' + cls + '"' : '') + '>' + esc + '</div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  // CSS 常量：把样式集中到一处，避免 innerHTML 里堆叠行内样式（也便于统一改主题）
  const PANEL_CSS =
    '#bl-panel,#bl-panel *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}' +
    '#bl-panel{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:300px;' +
    'background:#fff;color:#1D2129;border-radius:14px;overflow:hidden;user-select:none;' +
    'box-shadow:0 12px 32px rgba(0,0,0,.12),0 2px 8px rgba(0,0,0,.06);border:1px solid #E5E6EB;' +
    'transition:opacity .18s ease,transform .18s ease}' +
    '#bl-panel.bl-hide{opacity:0;transform:scale(.9);pointer-events:none}' +
    /* 头部 */
    '.bl-head{display:flex;align-items:center;justify-content:space-between;padding:11px 14px;' +
    'background:linear-gradient(135deg,#165DFF,#4080FF);color:#fff;cursor:move}' +
    '.bl-title{display:flex;align-items:center;gap:7px;font-size:13.5px;font-weight:600;letter-spacing:.2px}' +
    '.bl-dot{width:7px;height:7px;border-radius:50%;background:#B7E5C4;box-shadow:0 0 0 3px rgba(183,229,196,.28)}' +
    '.bl-dot.off{background:#FFB4A0;box-shadow:0 0 0 3px rgba(255,180,160,.28)}' +
    '.bl-dot.busy{background:#FFE08A;box-shadow:0 0 0 3px rgba(255,224,138,.3);animation:bl-pulse 1.2s infinite}' +
    '@keyframes bl-pulse{0%,100%{opacity:1}50%{opacity:.35}}' +
    '.bl-hbtns{display:flex;gap:2px}' +
    '.bl-hbtn{all:unset;width:22px;height:22px;display:flex;align-items:center;justify-content:center;' +
    'border-radius:6px;cursor:pointer;font-size:13px;line-height:1;color:#fff;transition:background .15s}' +
    '.bl-hbtn:hover{background:rgba(255,255,255,.22)}' +
    /* 页签 */
    '.bl-tabs{display:flex;padding:0 8px;background:#fff;border-bottom:1px solid #F2F3F5}' +
    '.bl-tab{flex:1;text-align:center;padding:10px 0 9px;font-size:12.5px;color:#86909C;cursor:pointer;' +
    'border-bottom:2px solid transparent;transition:color .15s,border-color .15s;font-weight:500}' +
    '.bl-tab:hover{color:#165DFF}' +
    '.bl-tab.on{color:#165DFF;border-bottom-color:#165DFF;font-weight:600}' +
    '.bl-pane{display:none;padding:12px 14px}' +
    '.bl-pane.on{display:block}' +
    '.bl-body{max-height:min(62vh,520px);overflow-y:auto;overflow-x:hidden}' +
    '.bl-body::-webkit-scrollbar{width:5px}' +
    '.bl-body::-webkit-scrollbar-thumb{background:#D8DBE0;border-radius:3px}' +
    '.bl-body::-webkit-scrollbar-thumb:hover{background:#C0C4CC}' +
    /* 状态卡 */
    '.bl-card{display:flex;align-items:center;gap:9px;padding:9px 11px;border-radius:10px;' +
    'background:#F7F8FA;margin-bottom:11px}' +
    '.bl-card .bl-live{flex:1;min-width:0}' +
    '.bl-card .bl-l1{font-size:12.5px;font-weight:600;color:#1D2129;white-space:nowrap;' +
    'overflow:hidden;text-overflow:ellipsis}' +
    '.bl-card .bl-l2{font-size:11px;color:#86909C;margin-top:2px;white-space:nowrap;' +
    'overflow:hidden;text-overflow:ellipsis}' +
    '.bl-ring{width:30px;height:30px;flex-shrink:0;border-radius:50%;' +
    'background:conic-gradient(#165DFF 0deg,#E5E6EB 0deg);display:flex;align-items:center;justify-content:center}' +
    '.bl-ring i{width:22px;height:22px;border-radius:50%;background:#F7F8FA;display:flex;' +
    'align-items:center;justify-content:center;font-size:9px;font-style:normal;color:#4E5969;font-weight:600}' +
    /* 分组标题 */
    '.bl-sec{font-size:10.5px;font-weight:700;color:#86909C;letter-spacing:.8px;text-transform:uppercase;' +
    'margin:13px 0 5px;display:flex;align-items:center;gap:6px}' +
    '.bl-sec:first-child{margin-top:0}' +
    '.bl-sec::after{content:"";flex:1;height:1px;background:#F2F3F5}' +
    /* 开关行 */
    '.bl-sw{display:flex;align-items:center;justify-content:space-between;gap:10px;' +
    'padding:7px 0;cursor:pointer}' +
    '.bl-sw .bl-t{flex:1;min-width:0}' +
    '.bl-sw .bl-n{font-size:12.5px;color:#1D2129;line-height:1.35}' +
    '.bl-sw .bl-d{font-size:10.5px;color:#A9AEB8;margin-top:1px;line-height:1.3}' +
    '.bl-sw input{display:none}' +
    '.bl-sl{width:34px;height:19px;border-radius:10px;background:#D8DBE0;position:relative;' +
    'flex-shrink:0;transition:background .2s}' +
    '.bl-sl::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;' +
    'background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.18);transition:transform .2s}' +
    '.bl-sw input:checked+.bl-sl{background:#165DFF}' +
    '.bl-sw input:checked+.bl-sl::after{transform:translateX(15px)}' +
    '.bl-sw:hover .bl-n{color:#165DFF}' +
    /* 数字行 */
    '.bl-num{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:5px 0}' +
    '.bl-num .bl-lab{font-size:12.5px;color:#4E5969;flex:1;min-width:0}' +
    '.bl-num input{width:74px;flex-shrink:0;padding:5px 8px;font-size:12px;color:#1D2129;' +
    'background:#F7F8FA;border:1px solid #E5E6EB;border-radius:7px;outline:none;text-align:right;' +
    'transition:border-color .15s,background .15s}' +
    '.bl-num input:hover{background:#fff}' +
    '.bl-num input:focus{border-color:#165DFF;background:#fff;box-shadow:0 0 0 3px rgba(22,93,255,.1)}' +
    /* 按钮 */
    '.bl-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;padding:9px 0;' +
    'font-size:12.5px;font-weight:500;border-radius:9px;border:1px solid transparent;cursor:pointer;' +
    'transition:all .15s;font-family:inherit}' +
    '.bl-btn:active{transform:scale(.985)}' +
    '.bl-pri{background:#165DFF;color:#fff}' +
    '.bl-pri:hover{background:#0E4BD8;box-shadow:0 3px 10px rgba(22,93,255,.28)}' +
    '.bl-sec2{background:#fff;color:#4E5969;border-color:#E5E6EB}' +
    '.bl-sec2:hover{color:#165DFF;border-color:#B8D0FF;background:#F5F9FF}' +
    '.bl-danger{background:#fff;color:#F53F3F;border-color:#FFD2D2}' +
    '.bl-danger:hover{background:#FFF5F5;border-color:#F53F3F}' +
    '.bl-btns{display:flex;flex-direction:column;gap:7px;margin-top:11px}' +
    '.bl-btns.row2{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin:0}' +
    /* 倍速快捷 */
    '.bl-rates{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:6px 0 2px}' +
    '.bl-rate{padding:7px 0;font-size:12px;font-weight:600;color:#4E5969;background:#F7F8FA;' +
    'border:1px solid #E5E6EB;border-radius:8px;cursor:pointer;transition:all .15s;font-family:inherit}' +
    '.bl-rate:hover{color:#165DFF;border-color:#B8D0FF;background:#F5F9FF}' +
    '.bl-rate.on{background:#165DFF;color:#fff;border-color:#165DFF;box-shadow:0 3px 10px rgba(22,93,255,.25)}' +
    /* 折叠 */
    '.bl-fold{border:1px solid #F2F3F5;border-radius:9px;margin-bottom:7px;overflow:hidden}' +
    '.bl-fh{display:flex;align-items:center;justify-content:space-between;padding:8px 11px;' +
    'font-size:12px;font-weight:600;color:#4E5969;cursor:pointer;background:#FAFBFC;transition:background .15s}' +
    '.bl-fh:hover{background:#F2F6FF;color:#165DFF}' +
    '.bl-fh .bl-arw{font-size:9px;color:#C0C4CC;transition:transform .2s}' +
    '.bl-fold.open .bl-arw{transform:rotate(90deg)}' +
    '.bl-fc{display:none;padding:5px 11px 9px}' +
    '.bl-fold.open .bl-fc{display:block}' +
    /* 日志 */
    '.bl-log{height:min(46vh,340px);overflow-y:auto;padding:10px 11px;border-radius:9px;' +
    'background:#1D2129;color:#C9CDD4;font:11px/1.65 "SF Mono",Consolas,"Courier New",monospace;' +
    'white-space:pre-wrap;word-break:break-all}' +
    '.bl-log::-webkit-scrollbar{width:5px}' +
    '.bl-log::-webkit-scrollbar-thumb{background:#4E5969;border-radius:3px}' +
    '.bl-log .bl-ok{color:#7BD88F}.bl-log .bl-err{color:#FF8A8A}.bl-log .bl-warn{color:#FFD666}' +
    /* 迷你球 */
    '#bl-mini{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:46px;height:46px;' +
    'border-radius:50%;background:linear-gradient(135deg,#165DFF,#4080FF);color:#fff;' +
    'display:none;align-items:center;justify-content:center;font-size:19px;cursor:pointer;' +
    'box-shadow:0 6px 18px rgba(22,93,255,.36);transition:transform .18s}' +
    '#bl-mini:hover{transform:scale(1.08)}' +
    '#bl-mini.on{display:flex}';

  // 一行开关（自定义滑块）
  function row(label, id, checked, desc) {
    return '<label class="bl-sw">' +
      '<span class="bl-t"><span class="bl-n">' + label + '</span>' +
      (desc ? '<span class="bl-d">' + desc + '</span>' : '') + '</span>' +
      '<input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + '>' +
      '<span class="bl-sl"></span></label>';
  }
  // 一行数字
  function num(label, id, val, step) {
    return '<div class="bl-num"><span class="bl-lab">' + label + '</span>' +
      '<input type="number" id="' + id + '" value="' + val + '" step="' + step + '" min="0"></div>';
  }
  // 可折叠分组
  function fold(title, inner, open) {
    return '<div class="bl-fold' + (open ? ' open' : '') + '">' +
      '<div class="bl-fh"><span>' + title + '</span><span class="bl-arw">▶</span></div>' +
      '<div class="bl-fc">' + inner + '</div></div>';
  }
  function btn(id, label, kind) {
    return '<button id="' + id + '" class="bl-btn ' + (kind || 'bl-sec2') + '">' + label + '</button>';
  }

  let mini = null;

  function buildPanel() {
    if (panel) return;

    // 样式表只注入一次
    if (!document.getElementById('bl-style')) {
      const st = document.createElement('style');
      st.id = 'bl-style';
      st.textContent = PANEL_CSS;
      (document.head || document.documentElement).appendChild(st);
    }

    panel = document.createElement('div');
    panel.id = 'bl-panel';

    panel.innerHTML =
      // ---------- 头部 ----------
      '<div class="bl-head" id="bl-head">' +
      '<span class="bl-title"><span class="bl-dot" id="bl-dot"></span>课程导航助手</span>' +
      '<span class="bl-hbtns">' +
      '<button class="bl-hbtn" id="bl-mini-btn" title="最小化为悬浮球">—</button>' +
      '<button class="bl-hbtn" id="bl-close" title="关闭（刷新可恢复）">✕</button>' +
      '</span></div>' +

      // ---------- 页签 ----------
      '<div class="bl-tabs">' +
      '<div class="bl-tab on" data-tab="main">主控</div>' +
      '<div class="bl-tab" data-tab="cfg">参数</div>' +
      '<div class="bl-tab" data-tab="log">日志</div>' +
      '</div>' +

      '<div class="bl-body">' +

      // ========== 页签 1：主控 ==========
      '<div class="bl-pane on" data-pane="main">' +
      '<div class="bl-card">' +
      '<div class="bl-ring" id="bl-ring"><i id="bl-pct">--</i></div>' +
      '<div class="bl-live"><div class="bl-l1" id="bl-l1">正在识别页面…</div>' +
      '<div class="bl-l2" id="bl-l2">扫描器启动中</div></div></div>' +

      '<div class="bl-sec">导航</div>' +
      row('总开关', 'bl-enabled', cfg.enabled, '默认关闭；仅在允许自动化的课程页手动开启') +
      row('自动下一节', 'bl-autoNext', cfg.autoNext, '检测到「观看下一章节」就点') +
      row('防跳过头', 'bl-guardSkipAhead', cfg.guardSkipAhead, '视频未到末尾时，忽略残留按钮并继续播放') +

      '<div class="bl-sec">播放</div>' +
      row('暂停自动续播', 'bl-autoPlay', cfg.autoPlay, '被平台暂停时自动恢复') +
      row('自动跳课件', 'bl-skipCourseware', cfg.skipCourseware, '课件停留后直接进入下一个视频') +

      '<div class="bl-sec">倍速</div>' +
      '<div class="bl-rates">' +
      [1, 1.25, 1.5, 2].map((r) =>
        '<button class="bl-rate' + (Math.abs(cfg.playRate - r) < 0.01 ? ' on' : '') +
        '" data-rate="' + r + '">' + r + 'x</button>').join('') +
      '</div>' +

      '<div class="bl-btns">' +
      btn('bl-jump', '⏭ 强制跳到下一视频', 'bl-pri') +
      '<div class="bl-btns row2">' +
      btn('bl-diagnose', '🩺 诊断') +
      btn('bl-openlog', '📋 看日志') +
      '</div></div>' +
      '</div>' +

      // ========== 页签 2：参数 ==========
      '<div class="bl-pane" data-pane="cfg">' +
      fold('🎯 点击与扫描', 
        num('扫描间隔(秒)', 'bl-scanEvery', cfg.scanEvery, 1) +
        num('点击延迟最小(秒)', 'bl-clickDelayMin', cfg.clickDelayMin, 0.1) +
        num('点击延迟最大(秒)', 'bl-clickDelayMax', cfg.clickDelayMax, 0.1) +
        num('跳节冷却(秒)', 'bl-cooldown', cfg.cooldown, 1) +
        num('最少观看(秒)', 'bl-minWatch', cfg.minWatch, 5) +
        num('静态课件停留(秒)', 'bl-pptDwell', cfg.pptDwell, 1) +
        num('完成进度(%)', 'bl-completionPercent', cfg.completionPercent, 1) +
        num('末尾阈值(秒)', 'bl-endThreshold', cfg.endThreshold, 0.5), true) +

      fold('⚙️ 播放',
        num('倍速', 'bl-playRate', cfg.playRate, 0.25) +
        num('主循环间隔(秒)', 'bl-interval', cfg.interval, 0.5)) +

      '<div class="bl-btns">' +
      btn('bl-reset', '恢复默认', 'bl-danger') +
      '</div>' +
      '</div>' +

      // ========== 页签 3：日志 ==========
      '<div class="bl-pane" data-pane="log">' +
      '<div class="bl-log" id="bl-log"></div>' +
      '<div class="bl-btns">' +
      '<div class="bl-btns row2">' +
      btn('bl-clearlog', '清空日志') +
      btn('bl-diagnose2', '🩺 诊断输出到日志', 'bl-pri') +
      '</div></div>' +
      '</div>' +

      '</div>';   // /bl-body

    (document.body || document.documentElement).appendChild(panel);

    // 最小化悬浮球
    mini = document.createElement('div');
    mini.id = 'bl-mini';
    mini.textContent = '芯';
    mini.title = '课程导航助手（点击展开）';
    (document.body || document.documentElement).appendChild(mini);

    bindPanel();
    renderLog();
    updateLive();
  }

  function bindPanel() {
    const $ = (id) => panel.querySelector('#' + id);
    // 面板 UI 绑定失败不能拖垮课程导航逻辑（CSP/扩展干预/innerHTML 异常都可能发生）
    // 注意：每一项都独立 try，避免一个元素缺失导致后面全部跳过
    try {
      const closeBtn = $('bl-close');
      if (closeBtn) closeBtn.addEventListener('click', () => {
        try { panel.remove(); } catch (e) {}
        try { if (mini) mini.remove(); } catch (e) {}
        panel = null; mini = null;
      });
    } catch (e) {}

    // 拖动（按住头部）
    // ⚠️ 每项都要判空：面板元素缺失时不能抛异常（否则后面的绑定全被跳过）
    try {
      const head = $('bl-head');
      if (head) {
        let drag = null;
        head.addEventListener('mousedown', (e) => {
          try {
            const r = panel.getBoundingClientRect();
            drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
            e.preventDefault();
          } catch (e2) {}
        });
        document.addEventListener('mousemove', (e) => {
          if (!drag || !panel) return;
          try {
            // 限制在视口内，避免拖出屏幕找不回来
            const w = panel.offsetWidth || 300, h = panel.offsetHeight || 400;
            const x = Math.max(0, Math.min(e.clientX - drag.dx, (window.innerWidth || 1200) - w));
            const y = Math.max(0, Math.min(e.clientY - drag.dy, (window.innerHeight || 800) - h));
            panel.style.left = x + 'px';
            panel.style.top = y + 'px';
            panel.style.right = 'auto'; panel.style.bottom = 'auto';
          } catch (e2) {}
        });
        document.addEventListener('mouseup', () => { drag = null; });
      }
    } catch (e) {
      // 拖动是锦上添花的功能，失败不影响任何核心逻辑；用 log 而非 console.warn，
      // 避免在控制台刷出看起来像"错误"的信息干扰排查。
      try { log('面板拖动绑定失败（不影响课程导航）'); } catch (e2) {}
    }

    // 统一的 UI 事件绑定：只接受真实用户操作，避免其他页面脚本误触面板。
    const bindOrSkip = (id, evt, fn) => {
      try {
        const el = $(id);
        if (!el) return;
        el.addEventListener(evt, (e) => {
          if (e && e.isTrusted === false) {
            // 非真实操作：把控件状态回滚到真实配置，保证 UI 与 cfg 一致
            try {
              const key = id.replace(/^bl-/, '');
              if (el.type === 'checkbox' && cfg[key] !== undefined) el.checked = !!cfg[key];
              else if (el.type === 'number' && cfg[key] !== undefined) el.value = cfg[key];
            } catch (e2) {}
            return;
          }
          fn(e);
        });
      } catch (e) {}
    };

    const bools = ['enabled', 'autoNext', 'autoPlay', 'instantClick', 'guardSkipAhead',
      'skipCourseware'];
    for (const k of bools) {
      bindOrSkip('bl-' + k, 'change', (e) => {
        // bindOrSkip 已过滤非真实操作；这里再兜一层：若值未真正变化则跳过
        if (e.target.checked === cfg[k]) return;

        cfg[k] = e.target.checked; safeSave();
        log('设置 ' + k + ' = ' + e.target.checked + '（用户手动更改）');
        if (k === 'enabled') updateHeadDot();
      });
    }
    const nums = ['minWatch', 'pptDwell', 'cooldown', 'interval', 'endThreshold', 'completionPercent', 'playRate',
      'scanEvery', 'clickDelayMin', 'clickDelayMax'];
    for (const k of nums) {
      bindOrSkip('bl-' + k, 'change', (e) => {
        const v = parseFloat(e.target.value);
        if (isFinite(v)) { cfg[k] = v; safeSave(); log('设置 ' + k + ' = ' + v); }
      });
    }

    // 页签切换
    try {
      for (const t of qsa('.bl-tab', panel)) {
        t.addEventListener('click', () => {
          const name = t.getAttribute('data-tab');
          for (const x of qsa('.bl-tab', panel)) x.classList.toggle('on', x === t);
          for (const p of qsa('.bl-pane', panel)) p.classList.toggle('on', p.getAttribute('data-pane') === name);
        });
      }
    } catch (e) {}

    // 折叠分组
    try {
      for (const f of qsa('.bl-fold', panel)) {
        const h = f.querySelector('.bl-fh');
        if (h) h.addEventListener('click', () => f.classList.toggle('open'));
      }
    } catch (e) {}

    bindOrSkip('bl-mini-btn', 'click', () => {
      try {
        panel.classList.add('bl-hide');
        if (mini) mini.classList.add('on');
      } catch (e) {}
    });
    try {
      if (mini) mini.addEventListener('click', () => {
        panel.classList.remove('bl-hide');
        mini.classList.remove('on');
      });
    } catch (e) {}

    bindOrSkip('bl-openlog', 'click', () => {
      try {
        for (const x of qsa('.bl-tab', panel)) x.classList.toggle('on', x.getAttribute('data-tab') === 'log');
        for (const p of qsa('.bl-pane', panel)) p.classList.toggle('on', p.getAttribute('data-pane') === 'log');
      } catch (e) {}
    });

    bindOrSkip('bl-jump', 'click', () => {
      lastJump = 0; consecutiveJumps = 0; jumpBackoffUntil = 0;
      sidebarToggleAt = 0;        // 手动跳转 = 用户明确意图，重置侧边栏节流
      sidebarToggleCount = 0;
      sidebarToggleWarned = false;
      gateUnlock('手动跳转');
      pendingJumpAttempt = false;
      if (!gotoNextSection({ force: true }) && !clickNextChapterButton()) {
        log('未找到下一个视频入口');
      }
    });
    bindOrSkip('bl-diagnose', 'click', diagnose);
    bindOrSkip('bl-diagnose2', 'click', () => {
      diagnose();
      try {
        for (const x of qsa('.bl-tab', panel)) x.classList.toggle('on', x.getAttribute('data-tab') === 'log');
        for (const p of qsa('.bl-pane', panel)) p.classList.toggle('on', p.getAttribute('data-pane') === 'log');
      } catch (e) {}
    });
    bindOrSkip('bl-clearlog', 'click', () => { logs.length = 0; renderLog(); log('日志已清空'); });
    // 倍速快捷按钮
    try {
      for (const b of qsa('.bl-rate', panel)) {
        b.addEventListener('click', () => {
          const r = parseFloat(b.getAttribute('data-rate'));
          if (!isFinite(r)) return;
          cfg.playRate = r; safeSave();
          const v = mainVideo();
          if (v) applyRate(v);
          log('已设置倍速 ' + r + 'x' + (r > 1 ? '（平台检测严格时建议改回 1x）' : ''));
          for (const x of qsa('.bl-rate', panel)) {
            x.classList.toggle('on', Math.abs(parseFloat(x.getAttribute('data-rate')) - r) < 0.01);
          }
          const pv = $('bl-playRate');
          if (pv) pv.value = r;
        });
      }
    } catch (e) {}
    bindOrSkip('bl-reset', 'click', () => {
      cfg = Object.assign({}, DEFAULTS); safeSave();
      log('已恢复默认设置');
      try { panel.remove(); } catch (e) {}
      try { if (mini) mini.remove(); } catch (e) {}
      panel = null; mini = null; buildPanel();
    });
  }

  function diagnose() {
    const out = ['===== 芯位页面结构诊断 ====='];
    const a = activeMenuItem();
    out.push('① 高亮章节: ' + (a ? text(a).slice(0, 40) : '(未找到 li.el-menu-item.is-active)'));
    if (a) {
      out.push('   视觉状态环: ' + ringState(a) + '  (done=已完成 / progress=进行中 / unknown=未识别)');
      out.push('   class 标记: ' + (['done-icon', 'inProgress-icon', 'unStart-icon', 'el-icon-check']
        .filter((c) => a.querySelector('.' + c)).join(',') || '(无)'));
    }
    out.push('② 侧边栏章节总数: ' + qsa('li.el-menu-item').length);

    // 「观看下一章节」按钮 —— 按截图特征分路检查
    const exact = findNextChapterCandidates();
    const strict = findNextChapterCandidates({ strict: true });
    out.push('③ 下一章节候选: 宽松=' + exact.length + ' 个，自动点击严格可用=' + strict.length + ' 个');
    exact.slice(0, 5).forEach((el, i) => {
      out.push('   [' + i + '] <' + el.tagName.toLowerCase() + '> 主按钮色=' + looksLikePrimary(el) +
        ' 尺寸=' + (el.offsetWidth || 0) + 'x' + (el.offsetHeight || 0) +
        ' class="' + (typeof el.className === 'string' ? el.className : '') + '"');
    });
    const rejectHit = qsa('button, a, [role="button"], .el-button, div, span')
      .filter((el) => visible(el) && REJECT_BTN_TEXT.test(text(el)) && text(el).length < 20);
    out.push('   ⚠️ 需排除的按钮（重播/上一节）: ' + rejectHit.length + ' 个 → ' +
      rejectHit.slice(0, 3).map((e) => '"' + text(e) + '"').join(', '));
    out.push('   .right 容器路线: ' + (qsa('.right, div.right').some((r) => text(r).indexOf('观看下一章节') !== -1) ? '有' : '无'));

    out.push('④ 侧边栏: 开关' + (document.querySelector('.course-sidebar-switch') ? '存在' : '不存在') +
      '，当前状态=' + (isSidebarOpen() ? '已展开' : '已收起') +
      '，已点开关 ' + sidebarToggleCount + ' 次' +
      (sidebarToggleWarned ? '（已熔断停止点击）' : ''));
    const vs = allVideos();
    out.push('⑤ 视频数: ' + vs.length);
    vs.forEach((v, i) => {
      out.push('   [' + i + '] 可见=' + visible(v) + ' 时长=' + (isFinite(v.duration) ? v.duration.toFixed(0) : '?') +
        ' 当前=' + (v.currentTime || 0).toFixed(0) + ' 暂停=' + v.paused + ' 静音=' + v.muted);
    });
    out.push('⑥ 静态/PPT 判定: ' + isStaticOrPpt());
    out.push('⑦ 抓取到的 iframe: ' + qsa('iframe').map((f) => (f.src || '').slice(0, 60)).join(' | ') || '(无)');
    out.push('⑧ 扫描器状态: 已扫描 ' + scanCount + ' 轮，间隔 ' + (cfg.scanEvery || 10) + 's，待点击=' + pendingClick);

    // ★ 决定性排查：全页扫"含『下』字样的可见可点元素"，看看到底长什么样
    out.push('⑨ 全页含「下」字样的可见元素（前 15 个，用于定位按钮真实结构）:');
    let found = 0;
    for (const el of qsa('button, a, [role="button"], [class*="btn"], [class*="button"], .el-button, div, span, li')) {
      if (found >= 15) break;
      if (!el.isConnected || !visible(el)) continue;
      const t = normalizeText(el.textContent);
      if (!t || t.length > 30) continue;
      if (!/下/.test(t)) continue;
      // 只报"最内层"（没有同样含『下』的子元素），避免一堆祖先容器刷屏
      const hasSameChild = Array.from(el.children || []).some((c) => /下/.test(normalizeText(c.textContent)));
      if (hasSameChild) continue;
      const r = el.getBoundingClientRect();
      const bg = (function () { try { return getComputedStyle(el).backgroundColor; } catch (e) { return '?'; } })();
      out.push('   <' + el.tagName.toLowerCase() + '> "' + t + '" | 蓝=' + looksLikePrimary(el) +
        ' | bg=' + bg + ' | ' + Math.round(r.width) + 'x' + Math.round(r.height) +
        ' @' + Math.round(r.left) + ',' + Math.round(r.top) +
        ' | 匹配=' + NEXT_BTN_TEXT.test(t) + ' | 排除=' + REJECT_BTN_TEXT.test(t));
      found++;
    }
    if (!found) out.push('   （未找到任何含「下」的可见元素 —— 可能按钮在 iframe / Shadow DOM / 未渲染）');

    // Shadow DOM 检测（很多现代播放器把控件放在 shadow root 里，querySelectorAll 扫不到）
    try {
      const hosts = qsa('*').filter((el) => el.shadowRoot);
      out.push('⑪ 含 Shadow DOM 的元素: ' + hosts.length + ' 个' +
        (hosts.length ? ' → ' + hosts.slice(0, 3).map((h) => h.tagName.toLowerCase()).join(',') : ''));
    } catch (e) { out.push('⑪ Shadow DOM 检测失败: ' + e.message); }

    const s = out.join('\n');
    logs.push('===== 诊断 =====');
    s.split('\n').forEach((l) => logs.push(l));
    renderLog();
    try { console.log('[芯位诊断]\n' + s); } catch (e) {}
    return s;
  }

  // ==========================================================================
  //  10. 启动
  // ==========================================================================
  function boot() {
    // 面板是可选 UI，任何失败都不能影响课程导航逻辑。
    try { buildPanel(); } catch (e) {
      try { console.warn('[课程导航] 面板创建失败，已跳过（导航功能继续运行）', e); } catch (e2) {}
      panel = null;
    }
    try { installForegroundGuard(); } catch (e) {}
    log('脚本已启动（芯位蜜线专用版 v' + SCRIPT_VERSION + '）');
    log('前台守卫已启用：课程窗口失焦时会暂停自动操作');

    // 启动时播报关键开关状态
    try {
      const keyOn = [];
      keyOn.push('总开关' + (cfg.enabled ? '✓' : '✗'));
      keyOn.push('自动下一节' + (cfg.autoNext ? '✓' : '✗'));
      keyOn.push('点击模式' + (cfg.instantClick ? '✓' : '✗'));
      keyOn.push('扫描间隔' + cfg.scanEvery + 's');
      log('当前设置: ' + keyOn.join(' / '));
    } catch (e) {}

    if (!qsa('li.el-menu-item').length) {
      log('未检测到课程章节列表——请先进入具体课程的学习页面');
    }

    // 主循环用递归 setTimeout（而非 setInterval），这样面板改"扫描间隔"能即时生效
    const mainLoop = () => {
      try { mainTick(); } catch (e) {}
      mainTimerId = setTimeout(mainLoop, Math.max(200, (cfg.interval || 1) * 1000));
    };
    mainLoop();

    // ★ 独立扫描器：每 cfg.scanEvery 秒检查一次是否出现蓝色「观看下一章节」
    //   （用户指定方案，比事件驱动更可控、更易排查）
    nextScanner();
    log('扫描器已启动：每 ' + (cfg.scanEvery || 10) + ' 秒检查一次「观看下一章节」按钮');

    // 兜底：DOM 变化时若距上次扫描已超过 2 秒，提前补一次检查。
    // 目的：按钮出现后不必干等满一个扫描周期（体感更快），但周期本身仍是 10 秒（可控）。
    try {
      new MutationObserver(() => {
        if (!cfg.enabled || !cfg.autoNext || !cfg.instantClick) return;
        if (pendingClick) return;
        if (Date.now() - lastScanAt < 2000) return;   // 至少间隔 2 秒，防止高频
        if (!primaryNextButton()) return;
        scanTick(false);        // 不重排，保持 10 秒周期不被打乱
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}

    // 懒加载视频时及时接管
    try {
      new MutationObserver(() => {
        if (!video || !video.isConnected) video = mainVideo();
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
