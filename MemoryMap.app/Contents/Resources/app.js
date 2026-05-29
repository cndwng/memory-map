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

  // ---------- keyboard shortcuts ----------
  document.addEventListener('keydown', e => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === '[' || e.key === 'ArrowLeft') {
      if (canGoBack()) { e.preventDefault(); history.back(); }
    } else if (e.key === ']' || e.key === 'ArrowRight') {
      if (canGoForward()) { e.preventDefault(); history.forward(); }
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

  const pickDataBtn = document.getElementById('pick-data-btn');
  if (pickDataBtn) pickDataBtn.addEventListener('click', () => runMenuAction('/api/pick-data-file', 'Pick data file'));

  const resetBtn = document.getElementById('reset-config-btn');
  if (resetBtn) resetBtn.addEventListener('click', () => runMenuAction('/api/reset-config', 'Reset'));

  // ---------- About + Suggested hooks modals ----------
  const modalBackdrop = document.getElementById('modal-backdrop');
  const modalBody = document.getElementById('modal-body');
  const modalClose = document.getElementById('modal-close');

  function openModal(html) {
    modalBody.innerHTML = html;
    modalBackdrop.hidden = false;
    // Wire any copy buttons inside the modal.
    modalBody.querySelectorAll('.copy[data-copy-target]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const sel = btn.getAttribute('data-copy-target');
        const el = modalBody.querySelector(sel);
        if (!el) return;
        try {
          await navigator.clipboard.writeText(el.textContent);
          const orig = btn.textContent;
          btn.textContent = 'Copied ✓';
          setTimeout(() => { btn.textContent = orig; }, 1500);
        } catch (e) {}
      });
    });
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

  const hooksBtn = document.getElementById('hooks-btn');
  if (hooksBtn) hooksBtn.addEventListener('click', () => {
    settingsMenu.classList.remove('open');
    const snippet = window.MEMORY_MAP_HOOKS_SNIPPET || '';
    openModal(
      '<h2>Suggested hooks</h2>' +
      '<p>Add these to <code>~/.claude/settings.json</code> under the top-level <code>"hooks"</code> key so Memory Map rebuilds its index whenever you start a Claude Code session, edit a plan, or exit plan mode.</p>' +
      '<div class="snippet"><button class="copy" data-copy-target="#hooks-snippet">Copy</button><span id="hooks-snippet">' + esc(snippet) + '</span></div>' +
      '<p class="muted">Without these hooks you can still rebuild manually from this Settings menu. Memory Map also auto-rebuilds on every version update.</p>'
    );
  });
})();
