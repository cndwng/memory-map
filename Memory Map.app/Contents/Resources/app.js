// Memory Map app — runs inside Chrome --app pointed at the localhost server.
// Reads window.MEMORY_MAP_DATA injected by the server's GET / response.

(function() {
  const D = window.MEMORY_MAP_DATA || { trees: {}, counts: {}, files: {}, meta: {} };
  const FILES = D.files;
  const META = D.meta;

  // Populate trees and tab counts from the data blob.
  for (const [tab, html] of Object.entries(D.trees || {})) {
    const pane = document.querySelector(`.tree-pane[data-tab="${tab}"] .tree`);
    if (pane) pane.innerHTML = html;
  }
  for (const [tab, n] of Object.entries(D.counts || {})) {
    const el = document.querySelector(`.tab[data-tab="${tab}"] .tab-count`);
    if (el) el.textContent = n;
  }

  // ---------- DOM refs ----------
  const search = document.getElementById('search');
  const chips = document.querySelectorAll('.chip');
  const tabs = document.querySelectorAll('.tab');
  const panes = document.querySelectorAll('.tree-pane');
  const detail = document.getElementById('detail');
  const navBackBtn = document.getElementById('nav-back');
  const navForwardBtn = document.getElementById('nav-forward');

  const state = { activeKind: null, q: '' };

  // ---------- tabs ----------
  tabs.forEach(t => t.addEventListener('click', () => {
    const name = t.dataset.tab;
    tabs.forEach(x => x.setAttribute('aria-selected', String(x === t)));
    panes.forEach(p => p.classList.toggle('active', p.dataset.tab === name));
  }));

  // ---------- filter ----------
  function applyFilter() {
    const q = state.q.trim().toLowerCase();
    const active = state.activeKind;
    document.querySelectorAll('.row.leaf').forEach(r => {
      const k = r.dataset.kind;
      const text = r.dataset.search || '';
      const kindOk = !active || k === active;
      const qOk = !q || text.includes(q);
      r.classList.toggle('hidden', !(kindOk && qOk));
    });
    document.querySelectorAll('.group-row').forEach(g => {
      const k = g.dataset.kind;
      const kindOk = !active || k === active;
      g.parentElement.classList.toggle('hidden', !kindOk);
    });
    // The roving-tabindex anchor may have just been hidden — re-anchor on a
    // currently-visible row so Tab still lands somewhere useful.
    if (typeof initRovingAnchor === 'function') initRovingAnchor();
  }
  chips.forEach(c => c.addEventListener('click', () => {
    const k = c.dataset.kind;
    const wasActive = (state.activeKind === k);
    state.activeKind = wasActive ? null : k;
    chips.forEach(x => x.setAttribute('aria-pressed', String(x.dataset.kind === state.activeKind)));
    applyFilter();
  }));
  search.addEventListener('input', e => {
    state.q = e.target.value;
    if (e.target.value.trim()) {
      document.querySelectorAll('details').forEach(d => d.open = true);
    }
    applyFilter();
  });

  // ---------- splitter drag ----------
  const splitter = document.getElementById('splitter');
  let dragging = false;
  if (splitter) {
    splitter.addEventListener('mousedown', e => {
      dragging = true;
      splitter.classList.add('dragging');
      document.body.classList.add('dragging');
      e.preventDefault();
    });
  }
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const min = 240, max = window.innerWidth - 320;
    const w = Math.max(min, Math.min(max, e.clientX));
    document.documentElement.style.setProperty('--left-width', w + 'px');
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('dragging');
    document.body.classList.remove('dragging');
    try {
      const w = getComputedStyle(document.documentElement).getPropertyValue('--left-width').trim();
      if (w) localStorage.setItem('memory-map-left-width', w);
    } catch (e) {}
  });
  try {
    const saved = localStorage.getItem('memory-map-left-width');
    if (saved) document.documentElement.style.setProperty('--left-width', saved);
  } catch (e) {}

  // ---------- focus mode ----------
  function setFocus(on, opts) {
    opts = opts || {};
    document.body.classList.toggle('focus-mode', on);
    if (opts.persist !== false) {
      try { localStorage.setItem('memory-map-focus', on ? '1' : '0'); } catch (e) {}
    }
    const btn = document.querySelector('.focus-btn');
    if (btn) btn.textContent = on ? '⤡ Exit focus' : '⤢ Focus';
  }
  // If the URL has focus=1, the server pre-set the body class — don't touch
  // localStorage. Otherwise restore from localStorage. (Popups share a Chrome
  // profile with the main app, so we'd otherwise infect the main app's state.)
  // Also: focus=1 implies "this is a popup" — mark the body so we can hide
  // the focus/popout action buttons (meaningless in a popup).
  {
    const urlFocus = new URLSearchParams(window.location.search).get('focus');
    if (urlFocus === '1') {
      document.body.classList.add('is-popup');
    } else if (urlFocus === null) {
      try {
        if (localStorage.getItem('memory-map-focus') === '1') setFocus(true, { persist: false });
      } catch (e) {}
    }
  }

  // ---------- navigation history ----------
  // Mirrors the browser's History API so that back/forward buttons,
  // cmd+[ / cmd+], and the WKWebView two-finger swipe gesture all share one
  // stack. We track our own index because the History API doesn't expose it,
  // and we need it to enable/disable the buttons.
  const nav = { stack: [], index: -1 };

  function pathToUrl(path) {
    const url = new URL(window.location.href);
    url.searchParams.set('path', path);
    return url.toString();
  }

  function navigate(path, opts) {
    opts = opts || {};
    if (opts.replace) {
      nav.stack = [path];
      nav.index = 0;
      history.replaceState({ path: path, idx: 0 }, '', pathToUrl(path));
    } else if (nav.stack[nav.index] === path) {
      // Same path — just re-render, don't grow history.
    } else {
      nav.stack = nav.stack.slice(0, nav.index + 1);
      nav.stack.push(path);
      nav.index = nav.stack.length - 1;
      history.pushState({ path: path, idx: nav.index }, '', pathToUrl(path));
    }
    const ok = openByPath(path, opts);
    updateNavButtons();
    return ok;
  }

  let animClearTimer = null;
  function animateDetailNav(dir) {
    detail.classList.remove('anim-back', 'anim-forward');
    // Force reflow so a same-direction repeat actually restarts the animation.
    void detail.offsetWidth;
    detail.classList.add('anim-' + dir);
    if (animClearTimer) clearTimeout(animClearTimer);
    animClearTimer = setTimeout(() => {
      detail.classList.remove('anim-back', 'anim-forward');
    }, 250);
  }

  window.addEventListener('popstate', e => {
    const state = e.state;
    const prevIdx = nav.index;
    if (state && typeof state.idx === 'number' && state.path) {
      nav.index = state.idx;
      if (state.idx < prevIdx) animateDetailNav('back');
      else if (state.idx > prevIdx) animateDetailNav('forward');
      openByPath(state.path, { scroll: true });
    } else {
      // Back past the first pushed entry — clear the detail panel.
      if (prevIdx >= 0) animateDetailNav('back');
      nav.index = -1;
      if (lastSelected) lastSelected.classList.remove('selected');
      lastSelected = null;
      detail.innerHTML = '<div class="detail-empty">Select a file on the left to view it here.</div>';
    }
    updateNavButtons();
  });

  function canGoBack() { return nav.index > 0; }
  function canGoForward() { return nav.index + 1 < nav.stack.length; }

  // Exposed for the Swift menu items (View → Back / Forward, ⌘[ / ⌘]) so
  // they respect our nav gates instead of falling through to pre-reload
  // entries in the WKWebView's history.
  window.__mm_back = () => { if (canGoBack()) history.back(); };
  window.__mm_forward = () => { if (canGoForward()) history.forward(); };

  function updateNavButtons() {
    if (navBackBtn) navBackBtn.disabled = !canGoBack();
    if (navForwardBtn) navForwardBtn.disabled = !canGoForward();
  }

  if (navBackBtn) navBackBtn.addEventListener('click', () => { if (canGoBack()) history.back(); });
  if (navForwardBtn) navForwardBtn.addEventListener('click', () => { if (canGoForward()) history.forward(); });

  // ---------- trackpad swipe detection ----------
  // Two-finger horizontal trackpad swipes fire wheel events with deltaX.
  // We accumulate momentum until it crosses a threshold, then trigger nav.
  // Skip when the gesture begins over a horizontally-scrollable element
  // (e.g. a wide code block) so legit scrolling still works.
  (function () {
    let acc = 0;
    let lastEventAt = 0;
    let fired = false;

    function hasHorizontalScroll(target) {
      // Walk up, but stop at .pane — the pane's `overflow: auto` is mainly
      // for vertical scrolling, and counting it here would suppress swipes
      // on any tall page. Only count *inner* horizontally-scrollable
      // elements (e.g. a wide <pre> code block inside the markdown).
      let el = target;
      while (el && el !== document.body) {
        if (el.classList && el.classList.contains('pane')) return false;
        if (el.scrollWidth > el.clientWidth + 1) {
          const overflowX = getComputedStyle(el).overflowX;
          if (overflowX === 'auto' || overflowX === 'scroll') return true;
        }
        el = el.parentElement;
      }
      return false;
    }

    window.addEventListener('wheel', e => {
      const now = performance.now();
      // Idle gap → start a fresh gesture.
      if (now - lastEventAt > 200) { acc = 0; fired = false; }
      lastEventAt = now;

      // Need a meaningfully horizontal swipe.
      if (Math.abs(e.deltaX) < Math.abs(e.deltaY) * 1.5) { acc = 0; return; }
      if (hasHorizontalScroll(e.target)) { acc = 0; return; }
      // Suppress any browser-level horizontal scroll while we own the gesture,
      // so nothing else nudges during the swipe.
      e.preventDefault();
      if (fired) return;

      acc += e.deltaX;
      const THRESHOLD = 80;
      if (acc <= -THRESHOLD && canGoBack()) {
        fired = true;
        history.back();
      } else if (acc >= THRESHOLD && canGoForward()) {
        fired = true;
        history.forward();
      }
    }, { passive: false });
  })();

  // ---------- rendering ----------
  let lastSelected = null;

  function openByPath(absPath, opts) {
    const sel = (window.CSS && CSS.escape ? CSS.escape(absPath) : absPath.replace(/"/g, '\\"'));
    const row = document.querySelector('.row.leaf[data-path="' + sel + '"]');
    if (!row) return false;
    const treePane = row.closest('.tree-pane');
    if (treePane) {
      const tabName = treePane.dataset.tab;
      tabs.forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === tabName)));
      panes.forEach(p => p.classList.toggle('active', p.dataset.tab === tabName));
    }
    let el = row.parentElement;
    while (el && el !== document.body) {
      if (el.tagName === 'DETAILS') el.open = true;
      el = el.parentElement;
    }
    renderRow(row);
    if (!opts || opts.scroll !== false) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return true;
  }

  function downloadCurrent(filename, content) {
    // In the Swift WKWebView host, route through a native save panel —
    // WKWebView's default <a download> behavior doesn't trigger a file save
    // without a WKDownloadDelegate, which we don't have.
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.downloadFile) {
      window.webkit.messageHandlers.downloadFile.postMessage({
        filename: filename,
        content: content,
      });
      return;
    }
    // Browser fallback: blob URL + <a download>.
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'memory-map.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function isSynthetic(path) {
    // Hooks and routines have synthetic paths and no underlying single file to download.
    return path.startsWith('~/.claude/routines/') || path.includes('#hooks.');
  }

  function renderRow(r) {
    const path = r.dataset.path;
    const tildePath = path.replace(/^\/Users\/[^/]+/, '~');
    const content = FILES[tildePath] || FILES[path] || '';
    const meta = META[tildePath] || META[path] || { desc: '', triggers: [], tools: [] };
    if (lastSelected) lastSelected.classList.remove('selected');
    r.classList.add('selected');
    lastSelected = r;
    const name = r.querySelector('.name').textContent;
    const html = window.marked
      ? window.marked.parse(content)
      : '<pre>' + content.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'})[c]) + '</pre>';
    const esc = s => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

    const desc = (meta.desc || '').trim();
    const descHtml = desc ? '<p class="summary">' + esc(desc) + '</p>' : '';
    const triggersHtml = (meta.triggers && meta.triggers.length)
      ? '<div class="meta-row"><span class="meta-label">Trigger words</span>'
        + meta.triggers.map(t => '<span class="tag">' + esc(t) + '</span>').join('') + '</div>'
      : '';
    const toolsHtml = (meta.tools && meta.tools.length)
      ? '<div class="meta-row"><span class="meta-label">Tools</span>'
        + meta.tools.map(t => '<span class="tag tool">' + esc(t) + '</span>').join('') + '</div>'
      : '';
    const dateHtml = meta.date
      ? '<div class="meta-row"><span class="meta-label">Last modified</span><span class="tag">' + esc(meta.date) + '</span></div>'
      : '';

    const crumbDisplay = (meta.real_path !== undefined && meta.real_path)
      ? meta.real_path.replace(/^\/Users\/[^/]+/, '~')
      : tildePath;

    const inFocus = document.body.classList.contains('focus-mode');
    const downloadBtn = isSynthetic(path) ? '' :
      '<button class="action-btn download-btn" title="Download .md">↓ Download</button>';
    const popoutBtn = isSynthetic(path) ? '' :
      '<button class="action-btn popout-btn" title="Open in a new window">⇗ Pop out</button>';
    const focusBtn =
      '<button class="action-btn focus-btn">' + (inFocus ? '⤡ Exit focus' : '⤢ Focus') + '</button>';

    detail.innerHTML =
      '<div class="detail-header">' +
        '<div class="crumb-row">' +
          '<span class="crumb">' + crumbDisplay + '</span>' +
          '<div class="actions">' + downloadBtn + popoutBtn + focusBtn + '</div>' +
        '</div>' +
        '<h2>' + esc(name) + '</h2>' +
        descHtml + triggersHtml + toolsHtml + dateHtml +
      '</div>' +
      '<div class="markdown">' + html + '</div>';
    detail.scrollTop = 0;

    // wire action buttons
    const dlBtn = detail.querySelector('.download-btn');
    if (dlBtn) dlBtn.addEventListener('click', () => {
      // Filename = the displayed row name, sanitized for the filesystem and
      // forced to end in .md. Works for skills (folder/SKILL.md → folder.md),
      // plans (long H1 title → readable name), memory files (already
      // descriptive), agents, commands, MEMORY.md.
      let fname = (name || '').trim();
      if (fname.endsWith('/')) fname = fname.slice(0, -1);
      fname = fname.replace(/[/\\?%*:|"<>\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim();
      if (!fname.toLowerCase().endsWith('.md')) fname += '.md';
      if (!fname || fname === '.md') fname = path.split('/').pop() || 'file.md';
      downloadCurrent(fname, content);
    });
    const focusBtnEl = detail.querySelector('.focus-btn');
    if (focusBtnEl) focusBtnEl.addEventListener('click', () => {
      const next = !document.body.classList.contains('focus-mode');
      setFocus(next);
    });
    const popoutBtnEl = detail.querySelector('.popout-btn');
    if (popoutBtnEl) popoutBtnEl.addEventListener('click', () => {
      openInPopup(path);
    });

    // intercept relative .md links — resolve and open in our view
    const currentDir = path.replace(/\/[^/]*$/, '');
    detail.querySelectorAll('.markdown a[href]').forEach(a => {
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#') || /^[a-z]+:/.test(href)) return;
      let abs;
      try {
        abs = new URL(href, 'file://' + currentDir + '/').pathname;
      } catch (e) { return; }
      const cleanAbs = abs.split('#')[0];
      const tilde = cleanAbs.replace(/^\/Users\/[^/]+/, '~');
      if (FILES[tilde] !== undefined || FILES[cleanAbs] !== undefined) {
        a.classList.add('internal-link');
        a.addEventListener('click', e => {
          e.preventDefault();
          navigate(cleanAbs);
        });
      } else {
        a.setAttribute('href', 'file://' + cleanAbs);
        a.setAttribute('title', 'External to map: ' + tilde);
      }
    });

    // Re-run an open find against the freshly-rendered content.
    if (window.__mm_reFind) window.__mm_reFind();
  }

  // ---------- leaf clicks ----------
  // Detect the Swift WKWebView host. When present, popups go through the
  // native bridge so the Dock identity stays consistent. Outside of it (eg
  // testing in Chrome directly), fall back to the Chrome-spawning endpoint.
  const inNative = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.openPopup);

  function openInPopup(path) {
    if (inNative) {
      window.webkit.messageHandlers.openPopup.postMessage({ path: path });
    } else {
      fetch('/api/popup?path=' + encodeURIComponent(path), { method: 'POST' })
        .catch(err => console.warn('popup failed:', err));
    }
  }

  document.querySelectorAll('.row.leaf').forEach(r => {
    r.addEventListener('click', e => {
      // A nestable summary uses the native <details> toggle for the row
      // itself; only the name navigates. Anywhere else on the row falls
      // through to the summary's default toggle + animated-close handler.
      if (r.classList.contains('has-nested') && !e.target.closest('.name')) {
        return;
      }
      // cmd+click (macOS) or ctrl+click → open in a new focus-mode window
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        openInPopup(r.dataset.path);
        return;
      }
      // stopImmediatePropagation prevents the animated-close handler (also
      // bound to summary) from collapsing the details on a name click.
      e.preventDefault();
      e.stopImmediatePropagation();
      navigate(r.dataset.path, { scroll: false });
    });
  });

  // Show the full name on hover when it's been ellipsis-truncated.
  document.querySelectorAll('.row.leaf .name').forEach(n => {
    if (n.scrollWidth > n.clientWidth + 1) n.title = n.textContent.trim();
  });

  // ---------- animated <details> close ----------
  // The native <details> element only animates on open (children fade-slide in
  // via the tree-reveal keyframe). To get a matching collapse, intercept the
  // summary click when the details is currently open, play a reverse animation
  // on the children, then actually close.
  document.querySelectorAll('details > summary').forEach(s => {
    s.addEventListener('click', e => {
      const d = s.parentElement;
      if (!d.open) return; // opening — let the default reveal animation run
      e.preventDefault();
      if (d.dataset.closing === '1') return;
      d.dataset.closing = '1';
      const kids = Array.from(d.children).filter(c => c.tagName !== 'SUMMARY');
      kids.forEach(c => { c.style.animation = 'tree-collapse 0.16s ease-in forwards'; });
      setTimeout(() => {
        kids.forEach(c => { c.style.animation = ''; });
        d.open = false;
        delete d.dataset.closing;
      }, 160);
    });
  });

  // ---------- initial deep-link from URL params ----------
  (function applyInitialParams() {
    const params = new URLSearchParams(window.location.search);
    const initialPath = params.get('path');
    if (initialPath) {
      // Render synchronously so the empty-state flash doesn't show before
      // the file paints. Use replace so we don't leave an empty entry behind.
      navigate(initialPath, { replace: true, scroll: false });
    }
    // (focus param is already handled server-side by setting body.focus-mode)
  })();

  // ---------- page zoom (⌘+ / ⌘- / ⌘0) ----------
  const ZOOM_KEY = 'memory-map-zoom';
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 3.0;
  const ZOOM_STEP = 0.1;
  function readZoom() {
    try {
      const v = parseFloat(localStorage.getItem(ZOOM_KEY) || '1');
      return isNaN(v) ? 1 : v;
    } catch (e) { return 1; }
  }
  function setZoom(z) {
    z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z * 100) / 100));
    document.documentElement.style.setProperty('--zoom', z);
    try { localStorage.setItem(ZOOM_KEY, String(z)); } catch (e) {}
  }
  setZoom(readZoom());

  // ---------- keyboard shortcuts + boop suppression + tree nav ----------
  // Simple navigation model:
  //  - ALL navigable rows (leaves + group summaries) participate in ↑/↓
  //  - One fixed anchor (the first visible row) has tabindex="0" so Tab
  //    always lands on it. Arrow movement updates focus but NOT the anchor,
  //    so Tab in/out always returns to the top.
  //  - Enter / Space activates: opens the file for leaves, toggles
  //    expand/collapse for group summaries.

  function isVisibleRow(r) {
    if (r.classList.contains('hidden')) return false;
    let el = r;
    while (el && el.parentElement) {
      const parent = el.parentElement;
      if (parent.tagName === 'DETAILS' && !parent.open) {
        // Inside a closed details. Only visible if `el` IS its <summary>.
        if (el.tagName !== 'SUMMARY') return false;
      }
      if (parent.classList && parent.classList.contains('hidden')) return false;
      el = parent;
    }
    return true;
  }

  function visibleNavRows() {
    const pane = document.querySelector('.tree-pane.active');
    if (!pane) return [];
    // Every row the user might want to land on: leaves AND group summaries.
    const all = pane.querySelectorAll('.row.leaf, summary.row');
    return Array.from(all).filter(isVisibleRow);
  }

  function updateTreeTabAnchor() {
    // Reset every tree row to -1, then promote the first visible row of
    // the active pane to 0 so Tab lands there.
    document.querySelectorAll('.tree-pane .row.leaf, .tree-pane summary.row')
      .forEach(r => r.setAttribute('tabindex', '-1'));
    const first = visibleNavRows()[0];
    if (first) first.setAttribute('tabindex', '0');
  }

  function moveTreeFocus(delta) {
    const items = visibleNavRows();
    if (items.length === 0) return;
    const current = document.activeElement;
    let i = current ? items.indexOf(current) : -1;
    if (i < 0) i = delta > 0 ? -1 : items.length;
    i = (i + delta + items.length) % items.length;
    items[i].focus();
    items[i].scrollIntoView({ block: 'nearest' });
  }

  function activateTreeFocus() {
    const target = document.activeElement;
    if (!target) return false;
    // Pure group summary → toggle the parent <details>.
    if (target.tagName === 'SUMMARY' && !target.classList.contains('leaf')) {
      const details = target.parentElement;
      if (details && details.tagName === 'DETAILS') {
        details.open = !details.open;
        // The anchor may have just been hidden by a collapse — refresh.
        updateTreeTabAnchor();
      }
      return true;
    }
    // has-nested leaf summary → open the file (don't toggle).
    if (target.classList.contains('has-nested')) {
      const nameEl = target.querySelector('.name');
      if (nameEl) nameEl.click();
      return true;
    }
    // Plain leaf → click the row (its handler navigates).
    if (target.classList.contains('leaf')) {
      target.click();
      return true;
    }
    return false;
  }

  // Re-anchor when a <details> opens/closes (visibility of children flips).
  // `toggle` doesn't bubble, so listen in capture phase.
  document.addEventListener('toggle', updateTreeTabAnchor, true);

  // Initial setup + re-anchor on tab switch.
  updateTreeTabAnchor();
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', updateTreeTabAnchor));

  // Back-compat names used elsewhere (no-ops now — anchor is always first).
  const initRovingAnchor = updateTreeTabAnchor;
  const initTreeFocus = updateTreeTabAnchor;

  const isPopupBody = () => document.body.classList.contains('is-popup');
  // Keys we let the webview/native handle as-is (so cut/copy/paste,
  // selecting text, typing in inputs, etc. all keep working).
  function isPassThroughKey(e) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return true;
    if (['Meta', 'Control', 'Shift', 'Alt', 'CapsLock'].includes(e.key)) return true;
    // Standard text-editing shortcuts.
    if ((e.metaKey || e.ctrlKey) && /^[cxvazyACXVAZY]$/.test(e.key)) return true;
    return false;
  }

  document.addEventListener('keydown', e => {
    // Escape: close find / modal, exit focus mode, suppress beep.
    if (e.key === 'Escape') {
      e.preventDefault();
      const modalOpen = !document.getElementById('modal-backdrop').hidden;
      const findOpen = !document.getElementById('find-bar').hidden;
      if (!modalOpen && !findOpen && !isPopupBody()
          && document.body.classList.contains('focus-mode')) {
        setFocus(false);
      }
      return;
    }

    // Up/Down arrows when not in a field → move keyboard focus through
    // the active tree's visible rows.
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp')
        && !(e.metaKey || e.ctrlKey)
        && !isPassThroughKey(e)) {
      e.preventDefault();
      moveTreeFocus(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    // Enter or Space on a focused tree row → activate it.
    // Leaf → open file. Group summary → toggle expand/collapse.
    if ((e.key === 'Enter' || e.key === ' ') && !isPassThroughKey(e)) {
      const focused = document.activeElement;
      if (focused && focused.classList
          && (focused.classList.contains('leaf')
              || (focused.tagName === 'SUMMARY' && focused.classList.contains('row')))) {
        e.preventDefault();
        activateTreeFocus();
        return;
      }
    }

    // Cmd-shortcuts: back/forward, tab switching, zoom.
    if (e.metaKey || e.ctrlKey) {
      const inField = isPassThroughKey(e);
      if (e.key === '[' || e.key === 'ArrowLeft') {
        if (inField) return;
        if (canGoBack()) { e.preventDefault(); history.back(); }
        return;
      }
      if (e.key === ']' || e.key === 'ArrowRight') {
        if (inField) return;
        if (canGoForward()) { e.preventDefault(); history.forward(); }
        return;
      }
      if (/^[1-5]$/.test(e.key)) {
        if (inField) return;
        const tabsList = Array.from(document.querySelectorAll('.tabs .tab'));
        const target = tabsList[parseInt(e.key, 10) - 1];
        if (target) { e.preventDefault(); target.click(); }
        return;
      }
      // ⌘= / ⌘+ → zoom in. (= is the unshifted key; + is shift+=.)
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        setZoom(readZoom() + ZOOM_STEP);
        return;
      }
      // ⌘- / ⌘_ → zoom out.
      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        setZoom(readZoom() - ZOOM_STEP);
        return;
      }
      // ⌘0 → reset to 100%.
      if (e.key === '0') {
        e.preventDefault();
        setZoom(1);
        return;
      }
    }

    // Suppress the macOS "no handler" beep on stray character keys outside
    // inputs (typing letters/numbers/punctuation when nothing wants them).
    // We intentionally leave Tab, Space, arrow keys, function keys, etc.
    // alone so their normal browser behavior (focus moves, page scrolls)
    // still works.
    if (!isPassThroughKey(e) && e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
    }
  });

  // ---------- in-page find (⌘F) ----------
  // Highlights matches inside .markdown with <mark>, navigates with
  // Enter / Shift+Enter. The bar floats over the top-right of the
  // detail pane and persists across navigation (re-runs the query on
  // the new content).
  (function () {
    const bar = document.getElementById('find-bar');
    const input = document.getElementById('find-input');
    const countEl = document.getElementById('find-count');
    const nextBtn = document.getElementById('find-next');
    const prevBtn = document.getElementById('find-prev');
    const closeBtn = document.getElementById('find-close');
    if (!bar || !input) return;

    let matches = [];
    let currentIdx = -1;

    function isOpen() { return !bar.hidden; }

    function clearHighlights() {
      const root = document.getElementById('detail');
      if (!root) return;
      root.querySelectorAll('mark.find-match').forEach(m => {
        m.replaceWith(document.createTextNode(m.textContent));
      });
      root.normalize();
    }

    function highlight(query) {
      clearHighlights();
      if (!query) return [];
      const root = document.querySelector('#detail .markdown');
      if (!root) return [];
      const q = query.toLowerCase();
      const textNodes = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
          if (node.parentElement && node.parentElement.closest('button')) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let n;
      while ((n = walker.nextNode())) textNodes.push(n);
      const found = [];
      for (const node of textNodes) {
        const text = node.nodeValue;
        const lower = text.toLowerCase();
        let from = 0, idx;
        const parts = [];
        while ((idx = lower.indexOf(q, from)) !== -1) {
          if (idx > from) parts.push({ t: text.slice(from, idx), m: false });
          parts.push({ t: text.slice(idx, idx + q.length), m: true });
          from = idx + q.length;
        }
        if (!parts.some(p => p.m)) continue;
        if (from < text.length) parts.push({ t: text.slice(from), m: false });
        const frag = document.createDocumentFragment();
        for (const p of parts) {
          if (p.m) {
            const mk = document.createElement('mark');
            mk.className = 'find-match';
            mk.textContent = p.t;
            frag.appendChild(mk);
            found.push(mk);
          } else {
            frag.appendChild(document.createTextNode(p.t));
          }
        }
        node.parentNode.replaceChild(frag, node);
      }
      return found;
    }

    function updateCount() {
      if (matches.length === 0) {
        countEl.textContent = input.value ? '0' : '';
      } else {
        countEl.textContent = (currentIdx + 1) + ' / ' + matches.length;
      }
      nextBtn.disabled = matches.length === 0;
      prevBtn.disabled = matches.length === 0;
    }

    function gotoMatch(idx) {
      if (matches.length === 0) return;
      matches.forEach(m => m.classList.remove('current'));
      currentIdx = (idx + matches.length) % matches.length;
      const m = matches[currentIdx];
      m.classList.add('current');
      m.scrollIntoView({ block: 'center', behavior: 'smooth' });
      updateCount();
    }

    function runFind() {
      matches = highlight(input.value);
      if (matches.length > 0) {
        currentIdx = 0;
        matches[0].classList.add('current');
        matches[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
      } else {
        currentIdx = -1;
      }
      updateCount();
    }

    function open() {
      bar.hidden = false;
      input.focus();
      input.select();
      if (input.value) runFind();
    }

    function close() {
      bar.hidden = true;
      clearHighlights();
      matches = [];
      currentIdx = -1;
      updateCount();
    }

    input.addEventListener('input', runFind);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        gotoMatch(currentIdx + (e.shiftKey ? -1 : 1));
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });
    nextBtn.addEventListener('click', () => gotoMatch(currentIdx + 1));
    prevBtn.addEventListener('click', () => gotoMatch(currentIdx - 1));
    closeBtn.addEventListener('click', close);
    // Global Esc — handles the case where focus has moved off the find input.
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && isOpen() && document.activeElement !== input) {
        close();
      }
    });

    window.__mm_findInDetail = open;
    // Called by renderRow after the detail pane re-renders, so an open find
    // bar re-runs against the new content.
    window.__mm_reFind = () => { if (isOpen()) runFind(); };
  })();

  // ---------- settings menu ----------
  const gearBtn = document.getElementById('gear-btn');
  const settingsMenu = document.getElementById('settings-menu');
  function positionSettingsMenu() {
    if (!gearBtn || !settingsMenu) return;
    const r = gearBtn.getBoundingClientRect();
    settingsMenu.style.top = (r.bottom + 6) + 'px';
    settingsMenu.style.right = (window.innerWidth - r.right) + 'px';
  }
  if (gearBtn && settingsMenu) {
    gearBtn.addEventListener('click', e => {
      e.stopPropagation();
      positionSettingsMenu();
      settingsMenu.classList.toggle('open');
    });
    document.addEventListener('click', e => {
      if (!settingsMenu.contains(e.target) && e.target !== gearBtn) {
        settingsMenu.classList.remove('open');
      }
    });
    window.addEventListener('resize', () => {
      if (settingsMenu.classList.contains('open')) positionSettingsMenu();
    });
  }

  function toast(msg, isError) {
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' error' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), isError ? 8000 : 3000);
  }

  async function runMenuAction(endpoint, label) {
    settingsMenu.classList.remove('open');
    gearBtn.setAttribute('aria-busy', 'true');
    try {
      const res = await fetch(endpoint, { method: 'POST' });
      const body = await res.json();
      if (body.cancelled) {
        gearBtn.removeAttribute('aria-busy');
        return;
      }
      if (body.ok) {
        location.reload();
      } else {
        gearBtn.removeAttribute('aria-busy');
        toast(label + ' failed: ' + (body.stderr || 'unknown error').slice(0, 400), true);
      }
    } catch (err) {
      gearBtn.removeAttribute('aria-busy');
      toast(label + ' request failed: ' + err.message, true);
    }
  }

  const regenBtn = document.getElementById('regen-btn');
  if (regenBtn) regenBtn.addEventListener('click', () => runMenuAction('/api/rebuild', 'Rebuild'));

  const pickWorkspaceBtn = document.getElementById('pick-workspace-btn');
  if (pickWorkspaceBtn) pickWorkspaceBtn.addEventListener('click', () => runMenuAction('/api/pick-workspace', 'Pick workspace'));

  // The "Use external data file…" menu item first opens an explainer modal,
  // then lets the user trigger the native file picker from there.
  function tildify(p) {
    if (!p) return '';
    return String(p).replace(/^\/Users\/[^/]+/, '~');
  }
  function dataFileModalHTML() {
    const path = tildify(window.MEMORY_MAP_DATA_FILE || '');
    const isOverride = !!window.MEMORY_MAP_DATA_FILE_IS_OVERRIDE;
    return (
      '<h2>Use an external data file</h2>' +
      '<p>By default, Memory Map reads <code>~/Library/Application Support/MemoryMap/memory-map.json</code> — built from your local <code>~/.claude/</code> setup whenever <code>build.py</code> runs.</p>' +
      '<p>Pointing at an <strong>external</strong> data file lets you view someone else\'s setup (e.g. a teammate exported their own <code>memory-map.json</code> for you to inspect), or pin to a snapshot for archival.</p>' +
      '<p class="muted">While an external file is set, the ↻ Regenerate button still rebuilds <em>your own</em> default file but the viewer keeps showing the external one. Use "Reset to defaults" in this menu to switch back.</p>' +
      '<div class="data-file-row">' +
        '<button class="modal-cta" id="pick-data-now">Choose file…</button>' +
        '<span class="data-file-path" id="data-file-path" title="' + esc(window.MEMORY_MAP_DATA_FILE || '') + '">' +
          esc(path) +
        '</span>' +
      '</div>' +
      (isOverride ? '<p class="modal-meta">Currently overriding the default.</p>' : '<p class="modal-meta">Currently using the default.</p>')
    );
  }
  const pickDataBtn = document.getElementById('pick-data-btn');
  if (pickDataBtn) pickDataBtn.addEventListener('click', () => {
    settingsMenu.classList.remove('open');
    openModal(dataFileModalHTML());
    const trigger = document.getElementById('pick-data-now');
    if (trigger) trigger.addEventListener('click', async () => {
      trigger.disabled = true;
      trigger.textContent = 'Picking…';
      try {
        const res = await fetch('/api/pick-data-file', { method: 'POST' });
        const body = await res.json();
        if (body.cancelled) {
          trigger.disabled = false;
          trigger.textContent = 'Choose file…';
          return;
        }
        if (body.ok) {
          // Successful pick → server rebuilt + config updated; reload so the
          // viewer reads from the new file.
          location.reload();
        } else {
          trigger.disabled = false;
          trigger.textContent = 'Choose file…';
          toast('Pick data file failed: ' + (body.stderr || 'unknown').slice(0, 400), true);
        }
      } catch (err) {
        trigger.disabled = false;
        trigger.textContent = 'Choose file…';
        toast('Pick data file request failed: ' + err.message, true);
      }
    });
  });

  const resetBtn = document.getElementById('reset-config-btn');
  if (resetBtn) resetBtn.addEventListener('click', () => runMenuAction('/api/reset-config', 'Reset'));

  // ---------- About + Suggested hooks modals ----------
  const modalBackdrop = document.getElementById('modal-backdrop');
  const modalBody = document.getElementById('modal-body');
  const modalClose = document.getElementById('modal-close');

  const codeExpandIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6 L8 10 L12 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const codeCollapseIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10 L8 6 L12 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const codeCopyIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 11V4a1 1 0 011-1h7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  const codeCheckIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5 L6.5 11.5 L12.5 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function wireCodeBlocks(root) {
    root.querySelectorAll('.code-block').forEach(block => {
      const toggle = block.querySelector('.code-action.toggle');
      const copy = block.querySelector('.code-action.copy');
      const pre = block.querySelector('.code-content');
      function setExpanded(state) {
        block.classList.toggle('expanded', state);
        if (toggle) {
          toggle.innerHTML = state ? codeCollapseIcon : codeExpandIcon;
          toggle.title = state ? 'Collapse' : 'Expand';
          toggle.setAttribute('aria-label', state ? 'Collapse' : 'Expand');
        }
      }
      block.addEventListener('click', e => {
        if (e.target.closest('.code-action')) return;
        if (block.classList.contains('expanded')) return;
        setExpanded(true);
      });
      if (toggle) toggle.addEventListener('click', e => {
        e.stopPropagation();
        setExpanded(!block.classList.contains('expanded'));
      });
      if (copy && pre) copy.addEventListener('click', async e => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(pre.textContent);
          const origTitle = copy.getAttribute('title');
          copy.classList.add('flash');
          copy.setAttribute('title', 'Copied ✓');
          setTimeout(() => {
            copy.classList.remove('flash');
            copy.setAttribute('title', origTitle);
          }, 1400);
        } catch (e) {}
      });
    });
  }

  function codeBlockHTML(snippet) {
    return (
      '<div class="code-block" role="region" aria-label="Code snippet" tabindex="0">' +
        '<div class="code-actions">' +
          '<button type="button" class="code-action toggle" title="Expand" aria-label="Expand">' + codeExpandIcon + '</button>' +
          '<button type="button" class="code-action copy" title="Copy" aria-label="Copy">' +
            '<span class="icon icon-default">' + codeCopyIcon + '</span>' +
            '<span class="icon icon-success">' + codeCheckIcon + '</span>' +
          '</button>' +
        '</div>' +
        '<pre class="code-content">' + esc(snippet) + '</pre>' +
        '<div class="code-fade"></div>' +
      '</div>'
    );
  }

  function openModal(html) {
    modalBody.innerHTML = html;
    modalBackdrop.hidden = false;
    wireCodeBlocks(modalBody);
  }
  function closeModal() {
    modalBackdrop.hidden = true;
    modalBody.innerHTML = '';
  }
  if (modalClose) modalClose.addEventListener('click', closeModal);
  if (modalBackdrop) modalBackdrop.addEventListener('click', e => {
    // Click on the dimmed backdrop (not the card) closes.
    if (e.target === modalBackdrop) closeModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modalBackdrop.hidden) closeModal();
  });

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  const aboutBtn = document.getElementById('about-btn');
  if (aboutBtn) aboutBtn.addEventListener('click', () => {
    settingsMenu.classList.remove('open');
    const v = window.MEMORY_MAP_VERSION || '?';
    openModal(
      '<h2>About Memory Map</h2>' +
      '<p>Memory Map indexes every skill, agent, slash command, memory file, plan, hook, and routine Claude has access to — across your global <code>~/.claude/</code> setup, your workspace repos, and installed plugins. Pick a tab, click a name, see the file rendered on the right.</p>' +
      '<p class="muted">Useful for: figuring out what skills are available, what your plugins ship, where your memories live, and what conventions you\'ve set up over time.</p>' +
      '<div class="modal-meta">v' + esc(v) + '</div>'
    );
  });

  const shortcutsBtn = document.getElementById('shortcuts-btn');
  if (shortcutsBtn) shortcutsBtn.addEventListener('click', () => {
    settingsMenu.classList.remove('open');
    openModal(
      '<h2>Keyboard shortcuts</h2>' +
      '<ul class="shortcuts">' +
        '<li><span class="shortcut-keys"><span class="keys"><kbd>⌘</kbd> <kbd>F</kbd></span></span><span>Find in the current file</span></li>' +
        '<li><span class="shortcut-keys"><span class="keys"><kbd>⌘</kbd> <kbd>[</kbd></span><span class="sep">/</span><span class="keys"><kbd>⌘</kbd> <kbd>]</kbd></span></span><span>Back / forward</span></li>' +
        '<li><span class="shortcut-keys"><span class="keys"><kbd>⌘</kbd> <kbd>N</kbd></span></span><span>New window</span></li>' +
        '<li><span class="shortcut-keys"><span class="keys"><kbd>⌘</kbd> <kbd>W</kbd></span></span><span>Close window</span></li>' +
        '<li><span class="shortcut-keys"><span class="keys"><kbd>⌘</kbd> <kbd>R</kbd></span></span><span>Reload the page</span></li>' +
        '<li><span class="shortcut-keys"><span class="keys"><kbd>⌘</kbd> <kbd>1</kbd></span><span class="sep">–</span><span class="keys"><kbd>⌘</kbd> <kbd>5</kbd></span></span><span>Switch between tabs</span></li>' +
        '<li><span class="shortcut-keys"><span class="keys"><kbd>↑</kbd></span><span class="sep">/</span><span class="keys"><kbd>↓</kbd></span></span><span>Move through items in the directory</span></li>' +
        '<li><span class="shortcut-keys"><span class="keys"><kbd>↵</kbd></span><span class="sep">/</span><span class="keys"><kbd>Space</kbd></span></span><span>Open file or expand/collapse group</span></li>' +
        '<li><span class="shortcut-keys"><span class="keys"><kbd>⌘</kbd> <kbd>+</kbd></span><span class="sep">/</span><span class="keys"><kbd>⌘</kbd> <kbd>-</kbd></span></span><span>Zoom in / out</span></li>' +
        '<li><span class="shortcut-keys"><span class="keys"><kbd>⌘</kbd> <kbd>0</kbd></span></span><span>Reset zoom</span></li>' +
        '<li><span class="shortcut-keys"><span class="keys"><kbd>⌘</kbd> <kbd>click</kbd></span></span><span>Pop file into new window</span></li>' +
        '<li><span class="shortcut-keys"><span class="keys"><kbd>Esc</kbd></span></span><span>Close find bar / modal, or exit focus mode</span></li>' +
      '</ul>'
    );
  });

  const hooksBtn = document.getElementById('hooks-btn');
  if (hooksBtn) hooksBtn.addEventListener('click', () => {
    settingsMenu.classList.remove('open');
    const snippet = window.MEMORY_MAP_HOOKS_SNIPPET || '';
    openModal(
      '<h2>Suggested hooks</h2>' +
      '<p>Add these to <code>~/.claude/settings.json</code> under the top-level <code>"hooks"</code> key so Memory Map rebuilds its index whenever you start a Claude Code session, edit a plan, or exit plan mode.</p>' +
      codeBlockHTML(snippet) +
      '<p class="muted">Without these hooks you can still rebuild manually from this Settings menu. Memory Map also auto-rebuilds on every version update.</p>'
    );
  });
})();
