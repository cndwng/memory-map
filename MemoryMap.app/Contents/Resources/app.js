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
  {
    const urlFocus = new URLSearchParams(window.location.search).get('focus');
    if (urlFocus === null) {
      try {
        if (localStorage.getItem('memory-map-focus') === '1') setFocus(true, { persist: false });
      } catch (e) {}
    }
    // If urlFocus is '1' the body already has focus-mode from the server.
    // If urlFocus is '0' we leave it un-focused (no class).
  }

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

  function downloadCurrent(path, content) {
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = path.split('/').pop() || 'memory-map.md';
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
      '<button class="action-btn inline-action download-btn" title="Download .md">↓ Download</button>';
    const popoutBtn = isSynthetic(path) ? '' :
      '<button class="action-btn popout-btn" title="Open in a new window">⇗ Pop out</button>';
    const focusBtn =
      '<button class="action-btn focus-btn">' + (inFocus ? '⤡ Exit focus' : '⤢ Focus') + '</button>';

    detail.innerHTML =
      '<div class="detail-header">' +
        '<div class="crumb-row">' +
          '<span class="crumb">' + crumbDisplay + '</span>' +
          '<div class="actions">' + popoutBtn + focusBtn + '</div>' +
        '</div>' +
        '<h2 class="title-row"><span class="title-name">' + esc(name) + '</span>' + downloadBtn + '</h2>' +
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
          openByPath(cleanAbs);
        });
      } else {
        a.setAttribute('href', 'file://' + cleanAbs);
        a.setAttribute('title', 'External to map: ' + tilde);
      }
    });
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
      // cmd+click (macOS) or ctrl+click → open in a new focus-mode window
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        openInPopup(r.dataset.path);
        return;
      }
      e.stopPropagation();
      renderRow(r);
    });
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
      // the file paints.
      openByPath(initialPath, { scroll: false });
    }
    // (focus param is already handled server-side by setting body.focus-mode)
  })();

  // ---------- settings menu ----------
  const gearBtn = document.getElementById('gear-btn');
  const settingsMenu = document.getElementById('settings-menu');
  if (gearBtn && settingsMenu) {
    gearBtn.addEventListener('click', e => {
      e.stopPropagation();
      settingsMenu.classList.toggle('open');
    });
    document.addEventListener('click', e => {
      if (!settingsMenu.contains(e.target) && e.target !== gearBtn) {
        settingsMenu.classList.remove('open');
      }
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
})();
