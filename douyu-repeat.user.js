// ==UserScript==
// @name         烂梗复读器
// @namespace    local.douyu.repeat
// @version      1.6.1
// @description  跟随当前直播间，按不同观众统计热门弹幕，带发送间隔和同句冷却。
// @match        https://www.douyu.com/*
// @match        https://douyu.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';
  const defaults = {
    windowSeconds: 30, threshold: 5, intervalSeconds: 30, cooldownSeconds: 300,
    maxLength: 30, suffix: '', blocked: '', ownName: '',
    filterMode: 'blacklist', whitelist: '',
    list: '.Barrage-list', row: '.Barrage-listItem',
    content: '.Barrage-content', user: '.Barrage-nickName',
    input: '.ChatSend-txt', send: '.ChatSend-button',
    autoStart: false, hideFullscreen: true, preview: false,
  };
  function editorKind(element) {
    if (!element) return null;
    if (element.tagName === 'TEXTAREA' || (element.tagName === 'INPUT' && ['text', 'search', ''].includes(element.type))) return 'value';
    return element.isContentEditable ? 'editable' : null;
  }
  function editorText(element) { return editorKind(element) === 'value' ? element.value : element.textContent.replace(/\u200B/gu, '').trim(); }
  function fillsViewport(rect, width, height) {
    return width > 0 && height > 0 && rect.width >= width - 16 && rect.height >= height - 16 && Math.abs(rect.left) <= 16 && Math.abs(rect.top) <= 16;
  }
  function writeEditor(element, text) {
    if (editorKind(element) === 'value') {
      const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, text);
    } else element.textContent = text;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function normalize(text) { return String(text).normalize('NFKC').replace(/\s+/gu, ' ').trim(); }
  function composeMessage(text, suffix = '') { return text + suffix; }
  class Counter {
    constructor(config) { this.config = config; this.entries = new Map(); this.sent = new Map(); this.lastSent = -Infinity; }
    prune(now) {
      for (const [key, entry] of this.entries) {
        for (const [user, time] of entry.users) if (now - time >= this.config.windowSeconds * 1000) entry.users.delete(user);
        if (!entry.users.size) this.entries.delete(key);
      }
      for (const [key, time] of this.sent) if (now - time >= this.config.cooldownSeconds * 1000) this.sent.delete(key);
    }
    add(text, user, now) {
      this.prune(now);
      const key = normalize(text);
      user = normalize(user);
      if (!user || !key || user === normalize(this.config.ownName) || [...key].length > this.config.maxLength) return;
      const whitelistMode = this.config.filterMode === 'whitelist';
      const words = String((whitelistMode ? this.config.whitelist : this.config.blocked) || '').split(/[,，\n]/u).map(x => normalize(x).toLowerCase()).filter(Boolean);
      const matches = words.some(word => key.toLowerCase().includes(word));
      if ((whitelistMode ? !matches : matches) || this.sent.has(key)) return;
      let entry = this.entries.get(key);
      if (!entry) {
        if (this.entries.size >= 2000) this.entries.delete(this.entries.keys().next().value);
        entry = { text: key, users: new Map() }; this.entries.set(key, entry);
      }
      entry.users.set(user, now);
    }
    top(now) { this.prune(now); return [...this.entries.values()].sort((a, b) => b.users.size - a.users.size); }
    candidate(now) {
      if (now - this.lastSent < this.config.intervalSeconds * 1000) return null;
      return this.top(now).find(entry => entry.users.size >= this.config.threshold && !this.sent.has(entry.text)) || null;
    }
    mark(text, now) { this.lastSent = now; this.sent.set(normalize(text), now); this.entries.delete(normalize(text)); }
  }
  // The same counting code is exercised by the Node tests.
  if (typeof module !== 'undefined' && module.exports && typeof document === 'undefined') {
    module.exports = { Counter, normalize, defaults, editorKind, editorText, writeEditor, fillsViewport, composeMessage }; return;
  }

  let config = { ...defaults, ...GM_getValue('config', {}) };
  // Apply the requested default once to existing installations, then respect user choices.
  if (!config.previewDefaultApplied) {
    config.preview = false;
    config.previewDefaultApplied = true;
    GM_setValue('config', config);
  }
  // Upgrade the original selector even for existing installations with saved settings.
  if (config.input === 'textarea.ChatSend-txt') config.input = defaults.input;
  let counter = new Counter(config), enabled = Boolean(config.autoStart), preview = config.preview === true;
  let lastSentText = GM_getValue('lastSentText', '');
  let room = location.pathname, list = null, observer = null, seen = new WeakMap();
  let received = 0, attempts = 0, status = '等待弹幕列表', lastAction = '尚未触发';
  let busy = false, generation = 0;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:24px;bottom:32px;z-index:2147483647';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{all:initial;color-scheme:light} *{box-sizing:border-box}
    .dock{font:13px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif;color:#4D5B70}
    section{position:absolute;right:0;bottom:70px;width:min(310px,calc(100vw - 32px));max-height:calc(100dvh - 128px);overflow:auto;padding:20px;background:#E0E5EC;border:1px solid #FFFFFF;border-radius:24px;box-shadow:0 16px 44px #4D5B702e,0 3px 8px #4D5B7014;transform-origin:calc(100% - 26px) calc(100% + 40px);opacity:1;transform:translateY(0) scale(1);visibility:visible;transition:transform 420ms cubic-bezier(.16,1,.3,1),opacity 260ms ease-out,visibility 0s;scrollbar-width:thin;scrollbar-color:#A3B1C6 transparent}
    .closed section{opacity:0;transform:translateY(18px) scale(.88);visibility:hidden;pointer-events:none;transition:transform 220ms cubic-bezier(.4,0,1,1),opacity 160ms ease-in,visibility 0s 220ms}
    header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px} .eyebrow{font-size:10px;letter-spacing:2px;color:#6D7C94} header b{display:block;font-size:16px;letter-spacing:.5px}
    button{font:inherit;cursor:pointer;border:1px solid transparent;border-radius:10px;padding:7px 10px;background:#FFFFFF;color:#4D5B70;transition:background 180ms ease,transform 220ms cubic-bezier(.16,1,.3,1)} button:hover{background:#f4f6fa} button:active{transform:scale(.96)} button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid #6D7C94;outline-offset:3px}
    #collapse{width:30px;height:30px;padding:0;background:transparent;font-size:22px;color:#6D7C94} #toggle{width:100%;height:46px;border-radius:14px;background:#4D5B70;color:#FFFFFF;font-size:16px;font-weight:650;letter-spacing:4px;box-shadow:0 5px 12px #4D5B7025} #toggle:hover{background:#6D7C94} #toggle[data-running=true]{background:#6D7C94}
    .launcher{width:54px;height:54px;padding:0;display:grid;place-items:center;border-radius:19px;border:1px solid #FFFFFF;background:#E0E5EC;box-shadow:0 6px 20px #4D5B7033;font-size:27px;line-height:1;position:relative;transform-origin:center;transition:transform 220ms cubic-bezier(.16,1,.3,1),box-shadow 220ms ease} .launcher-icon{display:flex;align-items:center;justify-content:center;width:36px;height:36px;line-height:1;font-family:"Segoe UI Emoji","Apple Color Emoji",sans-serif} .launcher:hover{transform:scale(1.08);background:#E0E5EC;box-shadow:0 10px 30px #4D5B7050} .launcher:active{transform:scale(1.02)} .launcher::after{content:'';position:absolute;right:7px;top:7px;width:7px;height:7px;border-radius:50%;background:#A3B1C6;border:2px solid #E0E5EC} .launcher[data-running=true]::after{background:#4D5B70}
    .launcher{touch-action:none;user-select:none;cursor:grab}.launcher.dragging{cursor:grabbing;transform:scale(1.08);box-shadow:0 10px 30px #4D5B7050}.launcher-icon{transform:translate(1px,-2px);pointer-events:none}
    .preferences{margin:15px 0 17px;display:grid;gap:10px}.switch-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0}.switch-row span{font-weight:550}
    input[type=checkbox]{appearance:none;width:30px;height:18px;padding:0;border:0;border-radius:10px;background:#A3B1C6;position:relative;cursor:pointer;flex-shrink:0;transition:background 200ms ease}input[type=checkbox]::after{content:'';position:absolute;top:3px;left:3px;width:12px;height:12px;background:#FFFFFF;border-radius:50%;transition:transform 240ms cubic-bezier(.16,1,.3,1)}input[type=checkbox]:checked{background:#4D5B70}input[type=checkbox]:checked::after{transform:translateX(12px)}
    .last{display:flex;justify-content:space-between;gap:8px;font-size:12px}.last span{font-weight:550}.last output{color:#6D7C94;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
    .settings{background:#FFFFFF;border:1px solid #FFFFFF;border-radius:14px;padding:5px 12px}.settings label{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0;padding:7px 0;border-bottom:1px solid #E0E5EC;font-size:12px}.settings label:last-child{border:0}
    input{font:inherit;min-width:0;background:#f2f4f7;color:#4D5B70;border:1px solid #E0E5EC;border-radius:7px;padding:5px 7px;width:100%}input[type=number]{width:67px;font-variant-numeric:tabular-nums}
    .advanced-fields label{display:block;margin:10px 0;font-size:12px}.advanced-fields input{display:block;margin-top:5px}details{margin-top:14px}summary{cursor:pointer;color:#6D7C94;font-size:12px}#save{width:100%;margin-top:10px;background:#A3B1C6;color:#28364b;font-weight:600}p{margin:9px 0;overflow-wrap:anywhere;white-space:pre-line}#state{font-size:11px;color:#6D7C94;margin:12px 0 0}#action,#controls{font-size:12px}ol{padding-left:20px;margin:8px 0;max-height:110px;overflow:auto;font-size:12px}li{overflow-wrap:anywhere}small{color:#6D7C94;font-size:11px}.tools{display:flex;gap:8px}.tools button{flex:1;font-size:11px;padding:6px}
    .filter-mode{display:flex;align-items:center;justify-content:space-between;margin:14px 0 8px;padding:10px 12px;background:#FFFFFF;border-radius:10px;font-size:12px}.filter-mode span{color:#6D7C94}.filter-mode span[data-active=true]{color:#4D5B70;font-weight:700}.advanced-fields textarea{display:block;width:100%;min-height:64px;resize:vertical;margin-top:5px;padding:7px;font:inherit;color:#4D5B70;background:#f2f4f7;border:1px solid #E0E5EC;border-radius:7px}
    @media(prefers-reduced-motion:reduce){section,.closed section,button,input[type=checkbox],input[type=checkbox]::after{transition:none}}
    </style><div class="dock" id="dock"><section id="panel" aria-label="烂梗复读器控制面板"><header><div><span class="eyebrow">trash spammer</span><b>烂梗复读器</b></div><button id="collapse" aria-label="关闭面板">×</button></header>
    <button id="toggle">开始</button><div class="preferences">
    <label class="switch-row"><span>自动开始</span><input id="autoStart" type="checkbox" aria-label="自动开始"></label>
    <div class="last"><span>上次发送</span><output id="lastSent">暂无</output></div>
    <label class="switch-row"><span>全屏隐藏</span><input id="hideFullscreen" type="checkbox" aria-label="全屏隐藏"></label>
    <label class="switch-row"><span>仅预览</span><input id="preview" type="checkbox" aria-label="仅预览"></label></div>
    <div class="settings" id="settings"></div><button id="save">保存设置</button><p id="state"></p>
    <details><summary>热门弹幕与运行记录</summary><ol id="hot"></ol><p id="action"></p></details>
    <details><summary>过滤与页面识别</summary><label class="filter-mode"><span id="blacklistLabel">黑名单</span><input id="filterMode" type="checkbox" role="switch" aria-label="白名单模式"><span id="whitelistLabel">白名单</span></label><small id="filterHint"></small><div class="advanced-fields" id="advanced"></div><p id="controls"></p><div class="tools"><button id="pickInput">点选输入框</button><button id="pickSend">点选发送按钮</button></div><small>修改后点击保存设置。取消仅预览后会实际发送。</small></details>
    </section><button class="launcher" id="launcher" aria-label="打开或关闭复读面板" aria-controls="panel" aria-expanded="true"><span class="launcher-icon" aria-hidden="true">🐷</span></button></div>`;
  document.body.append(host);
  // Keep send notifications separate from the panel that hides during fullscreen.
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;inset:auto;top:24px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;display:none;margin:0;padding:0;border:0;background:transparent;width:max-content;max-width:90vw;overflow:visible;color-scheme:light';
  // A z-index alone cannot place a toast above browser top-layer UI.
  if (typeof toast.showPopover === 'function') toast.setAttribute('popover', 'manual');
  const toastShadow = toast.attachShadow({ mode: 'open' });
  const toastStyle = document.createElement('style');
  toastStyle.textContent = ':host{all:initial}:host::backdrop{background:transparent;pointer-events:none} div{box-sizing:border-box;max-width:min(520px,90vw);padding:12px 18px;border-radius:14px;background:#E0E5EC;color:#4D5B70;box-shadow:0 6px 24px #4D5B7033;font:14px/1.6 system-ui;white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #FFFFFF;border-left:4px solid #6D7C94}';
  const toastMessage = document.createElement('div');
  toastMessage.setAttribute('role', 'status');
  toastMessage.setAttribute('aria-live', 'polite');
  toastShadow.append(toastStyle, toastMessage);
  let toastTimer, toastUntil = 0;
  function mountToast() {
    const fullscreen = document.fullscreenElement || document.webkitFullscreenElement;
    const parent = fullscreen && !['VIDEO', 'IFRAME'].includes(fullscreen.tagName) ? fullscreen : document.body;
    if (toast.parentNode !== parent) parent.append(toast);
    if (toastUntil > Date.now()) {
      toast.style.display = 'block';
      if (toast.hasAttribute('popover')) {
        try { if (!toast.matches(':popover-open')) toast.showPopover(); } catch { /* Older browsers use the fixed overlay. */ }
      }
    }
  }
  function showToast(message, duration = 3500) {
    clearTimeout(toastTimer);
    toastMessage.textContent = message;
    toastUntil = Date.now() + duration; mountToast();
    toastTimer = setTimeout(() => {
      toastUntil = 0;
      if (toast.hasAttribute('popover')) { try { toast.hidePopover(); } catch { /* Already closed. */ } }
      toast.style.display = 'none';
    }, duration);
  }
  // Native fullscreen plus web fullscreen, where a player container fills the viewport.
  function syncFullscreen() {
    mountToast();
    let fullscreen = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    if (!fullscreen) {
      for (const video of document.querySelectorAll('video')) {
        let element = video;
        for (let depth = 0; element && element !== document.body && depth < 6; depth++, element = element.parentElement) {
          if (fillsViewport(element.getBoundingClientRect(), innerWidth, innerHeight)) { fullscreen = true; break; }
        }
        if (fullscreen) break;
      }
    }
    host.style.display = fullscreen && config.hideFullscreen ? 'none' : '';
    const fullscreenRoot = document.fullscreenElement || document.webkitFullscreenElement;
    const panelParent = !config.hideFullscreen && fullscreenRoot && !['VIDEO', 'IFRAME'].includes(fullscreenRoot.tagName) ? fullscreenRoot : document.body;
    if (host.parentNode !== panelParent) panelParent.append(host);
  }
  document.addEventListener('fullscreenchange', syncFullscreen);
  document.addEventListener('webkitfullscreenchange', syncFullscreen);
  window.addEventListener('resize', syncFullscreen);
  setInterval(syncFullscreen, 500);
  syncFullscreen();
  const $ = id => shadow.getElementById(id);
  $('preview').checked = preview;
  $('autoStart').checked = config.autoStart;
  $('hideFullscreen').checked = config.hideFullscreen;
  const fields = [
    ['windowSeconds', '统计窗口（秒）', 5, 300], ['threshold', '不同观众阈值', 2, 100],
    ['intervalSeconds', '发送间隔（秒）', 10, 3600], ['cooldownSeconds', '同句冷却（秒）', 60, 86400],
    ['maxLength', '最大字数', 1, 100], ['suffix', '句末词'], ['whitelist', '白名单关键词（逗号或换行分隔）'], ['ownName', '我的昵称（排除自己）'], ['blocked', '黑名单关键词（逗号分隔）'],
    ['list', '弹幕列表 CSS'], ['row', '单条弹幕 CSS'], ['content', '弹幕内容 CSS'],
    ['user', '观众昵称 CSS'], ['input', '输入框 CSS'], ['send', '发送按钮 CSS'],
  ];
  for (const [key, title, min, max] of fields) {
    const label = document.createElement('label'); label.textContent = title;
    const input = document.createElement(key === 'whitelist' ? 'textarea' : 'input'); input.id = key; input.value = config[key];
    if (key === 'whitelist') input.placeholder = '默认为空；白名单模式下只复读包含这些关键词的弹幕';
    if (key !== 'whitelist') input.type = min === undefined ? 'text' : 'number';
    if (min !== undefined) { input.min = min; input.max = max; input.step = 1; }
    if (key === 'suffix') { input.placeholder = '默认留空'; input.style.width = '130px'; }
    label.append(input); $(min === undefined && key !== 'suffix' ? 'advanced' : 'settings').append(label);
  }
  function reset() {
    generation++; observer?.disconnect(); observer = null; list = null; seen = new WeakMap();
    // Keep cooldowns across tab visibility, start/stop, settings, and room changes.
    // Otherwise switching tabs could immediately replay a recently sent message.
    const previous = counter;
    counter = new Counter(config); counter.sent = previous.sent; counter.lastSent = previous.lastSent;
    received = 0;
  }
  $('save').onclick = () => {
    const next = { ...config };
    try {
      for (const [key, , min, max] of fields) {
        const value = $(key).value.trim();
        if (min !== undefined) {
          const n = Number(value);
          if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${key} 必须在 ${min}–${max} 之间`);
          next[key] = n;
        } else next[key] = value;
      }
      for (const key of ['list', 'row', 'content', 'user', 'input', 'send']) {
        if (!next[key]) throw new Error('CSS 选择器不能为空');
        document.querySelector(next[key]);
      }
      GM_setValue('config', next); config = next; reset(); lastAction = '已保存，重新统计';
    } catch (error) { lastAction = `设置未保存：${error.message}`; }
    render();
  };
  $('toggle').onclick = () => { enabled = !enabled; reset(); lastAction = enabled ? '开始统计新增弹幕' : '已停止'; render(); };
  $('preview').onchange = () => { preview = $('preview').checked; config.preview = preview; GM_setValue('config', config); reset(); lastAction = preview ? '预览模式' : '自动发送模式'; render(); };
  $('autoStart').onchange = () => { config.autoStart = $('autoStart').checked; GM_setValue('config', config); showToast(config.autoStart ? '已开启自动开始，下次打开页面按当前模式运行' : '已关闭自动开始'); };
  $('hideFullscreen').onchange = () => { config.hideFullscreen = $('hideFullscreen').checked; GM_setValue('config', config); syncFullscreen(); };
  function renderFilterMode() {
    const white = config.filterMode === 'whitelist';
    $('filterMode').checked = white;
    $('blacklistLabel').dataset.active = String(!white);
    $('whitelistLabel').dataset.active = String(white);
    $('filterHint').textContent = white ? '只匹配白名单关键词；为空时不复读。' : '排除黑名单关键词；为空时不过滤内容。';
  }
  $('filterMode').onchange = () => {
    config.filterMode = $('filterMode').checked ? 'whitelist' : 'blacklist';
    GM_setValue('config', config); reset(); renderFilterMode();
    lastAction = '过滤模式已切换，重新统计；关键词修改后需保存设置'; render();
  };
  renderFilterMode();
  let panelOpen = true;
  let buttonPosition = GM_getValue('buttonPosition', null);
  let drag = null, suppressClickUntil = 0;
  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
  function placePanel() {
    const rect = host.getBoundingClientRect();
    const width = $('panel').offsetWidth;
    const left = clamp(rect.right - width, 12, innerWidth - width - 12);
    $('panel').style.right = `${rect.right - left - width}px`;
    const above = rect.top - 28, below = innerHeight - rect.bottom - 28;
    const openAbove = above >= below;
    $('panel').style.bottom = openAbove ? '70px' : 'auto';
    $('panel').style.top = openAbove ? 'auto' : '70px';
    $('panel').style.maxHeight = `${Math.max(80, openAbove ? above : below)}px`;
    $('panel').style.transformOrigin = `${clamp(rect.left + 27 - left, 0, width)}px ${openAbove ? 'bottom' : 'top'}`;
  }
  function placeButton() {
    if (buttonPosition && Number.isFinite(buttonPosition.x) && Number.isFinite(buttonPosition.y)) {
      buttonPosition = { x: clamp(buttonPosition.x, 12, innerWidth - 66), y: clamp(buttonPosition.y, 12, innerHeight - 66) };
      host.style.left = `${buttonPosition.x}px`; host.style.top = `${buttonPosition.y}px`;
      host.style.right = 'auto'; host.style.bottom = 'auto';
    }
    placePanel();
  }
  $('launcher').addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    const rect = host.getBoundingClientRect();
    drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: rect.left, y: rect.top, moved: false };
    $('launcher').setPointerCapture(event.pointerId);
  });
  $('launcher').addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true; event.preventDefault(); $('launcher').classList.add('dragging');
    buttonPosition = { x: drag.x + dx, y: drag.y + dy }; placeButton();
  });
  function finishDrag(event) {
    if (!drag || drag.id !== event.pointerId) return;
    if (drag.moved) { suppressClickUntil = Date.now() + 400; GM_setValue('buttonPosition', buttonPosition); }
    drag = null; $('launcher').classList.remove('dragging');
    if ($('launcher').hasPointerCapture(event.pointerId)) $('launcher').releasePointerCapture(event.pointerId);
  }
  $('launcher').addEventListener('pointerup', finishDrag);
  $('launcher').addEventListener('pointercancel', finishDrag);
  $('launcher').addEventListener('lostpointercapture', finishDrag);
  window.addEventListener('resize', placeButton);
  document.addEventListener('fullscreenchange', placeButton);
  placeButton();
  function setPanelOpen(open) {
    placePanel();
    panelOpen = open;
    $('dock').classList.toggle('closed', !open);
    $('panel').inert = !open;
    $('panel').setAttribute('aria-hidden', String(!open));
    $('launcher').setAttribute('aria-expanded', String(open));
    if (!open) $('launcher').focus({ preventScroll: true });
  }
  $('collapse').onclick = () => setPanelOpen(false);
  $('launcher').onclick = event => {
    if (Date.now() < suppressClickUntil) { event.preventDefault(); return; }
    setPanelOpen(!panelOpen);
  };
  shadow.addEventListener('keydown', event => { if (event.key === 'Escape' && panelOpen) setPanelOpen(false); });

  let cancelPick = null;
  function pickControl(key) {
    cancelPick?.(); enabled = false; reset();
    lastAction = `请点击网页上的${key === 'input' ? '弹幕输入框' : '发送按钮'}（Esc 取消，本次点击不会发送）`;
    const cleanup = () => {
      document.removeEventListener('click', capture, true);
      document.removeEventListener('keydown', escape, true); cancelPick = null;
    };
    const escape = event => { if (event.key === 'Escape') { cleanup(); lastAction = '已取消点选'; render(); } };
    const capture = event => {
      if (event.composedPath().includes(host)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      let element = event.target;
      if (!(element instanceof Element)) return;
      if (key === 'input') {
        element = element.closest('textarea,input,[contenteditable]');
        if (!editorKind(element)) { lastAction = '未选中可编辑输入框，请再点一次，或按 Esc 取消'; render(); return; }
      } else element = element.closest('button,[role="button"],.ChatSend-button') || element;
      const parts = [];
      for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
        if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
        parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${[...node.parentElement.children].indexOf(node) + 1})`);
      }
      config[key] = parts.join(' > '); $(key).value = config[key]; GM_setValue('config', config);
      cleanup(); lastAction = '已保存所选控件；请先预览，再点击开始'; render();
    };
    cancelPick = cleanup;
    document.addEventListener('click', capture, true); document.addEventListener('keydown', escape, true); render();
  }
  $('pickInput').onclick = () => pickControl('input');
  $('pickSend').onclick = () => pickControl('send');

  function readRow(row) {
    const content = row.querySelector(config.content), user = row.querySelector(config.user);
    if (!content || !user) return null;
    const text = content.textContent.trim();
    const name = (user.getAttribute('title') || user.textContent).replace(/[:：]\s*$/u, '').trim();
    return text && name ? { text, name, signature: JSON.stringify([text, name]) } : null;
  }
  function consume(row, seed = false) {
    const data = readRow(row);
    if (!data || seen.get(row) === data.signature) return;
    seen.set(row, data.signature);
    if (seed || !enabled || document.hidden) return;
    received++; counter.add(data.text, data.name, Date.now());
  }
  function attach() {
    const next = document.querySelector(config.list);
    if (next === list && next?.isConnected) return;
    observer?.disconnect(); list = next; seen = new WeakMap();
    if (!list) { status = '未找到弹幕列表，请进入直播间或检查选择器'; return; }
    // Ignore history already rendered when attaching, starting, or changing rooms.
    list.querySelectorAll(config.row).forEach(row => consume(row, true));
    observer = new MutationObserver(records => {
      const rows = new Set();
      for (const record of records) {
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        const parentRow = target?.closest(config.row);
        if (parentRow && list.contains(parentRow)) rows.add(parentRow);
        for (const node of record.addedNodes) if (node.nodeType === 1) {
          if (node.matches(config.row)) rows.add(node);
          node.querySelectorAll(config.row).forEach(row => rows.add(row));
        }
      }
      rows.forEach(row => consume(row));
    });
    observer.observe(list, { childList: true, subtree: true, characterData: true });
  }
  function visible(element) { return element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'; }
  function findVisible(selector) { return [...document.querySelectorAll(selector)].find(visible); }
  function controls() {
    let input = null;
    for (const match of document.querySelectorAll(config.input)) {
      const candidates = [match, ...match.querySelectorAll('textarea,input,[contenteditable]')];
      input = candidates.find(element => visible(element) && editorKind(element));
      if (input) break;
    }
    return { input, button: findVisible(config.send) };
  }
  async function send(entry) {
    const message = composeMessage(entry.text, config.suffix);
    if (document.hidden || !document.hasFocus()) { status = '等待当前标签页获得焦点'; return; }
    const { input, button } = controls();
    if (!input || !button) { status = `未识别${!input ? '输入框' : ''}${!input && !button ? '和' : ''}${!button ? '发送按钮' : ''}，请使用面板点选`; return; }
    if (editorText(input) || input.contains(document.activeElement)) { status = '正在手动输入，暂不发送'; return; }
    if (input.disabled || input.readOnly || button.disabled || button.getAttribute('aria-disabled') === 'true' || /disabled/i.test(button.className)) { status = '发送控件不可用，请检查登录或禁言状态'; return; }
    if ([...message].length > config.maxLength || (input.maxLength > 0 && message.length > input.maxLength)) { counter.entries.delete(entry.text); lastAction = '已跳过：加上句末词后超过字数限制'; return; }
    const version = generation;
    const write = text => writeEditor(input, text);
    busy = true;
    try {
      write(message);
      await new Promise(resolve => setTimeout(resolve, 150));
      if (version !== generation || !enabled || preview || room !== location.pathname || document.hidden || !document.hasFocus() || !input.isConnected || !button.isConnected || editorText(input) !== message || input.disabled || input.readOnly || button.disabled || button.getAttribute('aria-disabled') === 'true' || /disabled/i.test(button.className)) {
        if (input.isConnected && editorText(input) === message) write('');
        return;
      }
      // Mark attempts before clicking, including failed sends, so no retry loop occurs.
      counter.mark(entry.text, Date.now()); attempts++;
      counter.mark(message, Date.now());
      button.click(); lastAction = `已点击发送：${message}（平台是否成功需看回显）`;
      showToast(`已尝试复读：${message}`);
      lastSentText = message;
      try { GM_setValue('lastSentText', lastSentText); } catch { /* Storage failure must not interrupt the send notification. */ }
      await new Promise(resolve => setTimeout(resolve, 1200));
      if (version === generation && input.isConnected && editorText(input) === message) {
        enabled = false; lastAction = '发送后输入框未清空，已暂停。请检查登录、验证码或发送限制后重新开始。';
        showToast('复读已暂停：发送后输入框未清空，请检查登录或发送限制。', 5000);
      }
    } finally { busy = false; }
  }
  function render() {
    $('toggle').textContent = enabled ? '停止' : '开始';
    $('toggle').dataset.running = String(enabled);
    $('launcher').dataset.running = String(enabled);
    $('lastSent').textContent = lastSentText ? [...lastSentText].slice(0, 10).join('') : '暂无';
    $('lastSent').title = lastSentText ? `上次发送尝试：${lastSentText}` : '尚未发送';
    $('state').textContent = `${enabled ? (preview ? '预览中' : '自动复读中') : '已停止'} · ${status}\n新增 ${received} 条 / 发送尝试 ${attempts} 次`;
    $('action').textContent = lastAction;
    try {
      const { input, button } = controls();
      $('controls').textContent = `输入框：${input ? (editorKind(input) === 'editable' ? '已识别（富文本）' : '已识别') : '未识别'} · 发送按钮：${button ? '已识别' : '未识别'}`;
    } catch { $('controls').textContent = '控件选择器无效，请重新点选'; }
    $('hot').replaceChildren();
    for (const entry of counter.top(Date.now()).slice(0, 3)) {
      const li = document.createElement('li'); li.textContent = `${entry.users.size} 人 · ${entry.text}`; $('hot').append(li);
    }
  }
  document.addEventListener('visibilitychange', () => { reset(); });
  setInterval(async () => {
    if (busy) return;
    try {
      if (room !== location.pathname) { room = location.pathname; reset(); lastAction = '已切换直播间，重新统计'; }
      attach();
      if (list) status = document.hidden ? '后台暂停' : '已连接弹幕列表';
      if (enabled && list && !document.hidden) {
        const entry = counter.candidate(Date.now());
        if (entry) {
          if ([...composeMessage(entry.text, config.suffix)].length > config.maxLength) { counter.entries.delete(entry.text); lastAction = '已跳过：加上句末词后超过最大字数'; }
          else if (preview) { counter.mark(entry.text, Date.now()); lastAction = `预览命中：${composeMessage(entry.text, config.suffix)}（${entry.users.size} 人）`; }
          else await send(entry);
        }
      }
      render();
    } catch (error) { enabled = false; status = `已暂停：${error.message}`; render(); }
  }, 1000);
  render();
})();
