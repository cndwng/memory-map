#!/usr/bin/env python3
"""Memory Map — generates data/memory-map.json from your ~/.claude/ directory.

Outputs a JSON file consumed by MemoryMap.app at runtime. The .app's local
server reads this file plus the bundle's template/styles/js and synthesizes the
final HTML on each request.

Run:
    python3 build.py
"""
import datetime
import glob
import html
import json
import os
import re

# ---------- paths ----------

HOME = os.path.expanduser('~')
# Runtime data lives under macOS's standard per-user data dir, NOT inside the
# .app bundle. The bundle is read-only after install (and once code-signed),
# while user data should survive app updates. Same convention as Chrome
# profiles, app preferences, etc.
SELF_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HOME, 'Library', 'Application Support', 'MemoryMap')
OUT_FILE = os.path.join(OUT_DIR, 'memory-map.json')
ROUTINES_FILE = os.path.join(OUT_DIR, 'routines.json')
CONFIG_FILE = os.path.join(OUT_DIR, 'config.local.json')

# Per-machine config. Optional.
#   workspace_dirs: list of dirs to scan for */.claude/ — defaults to
#                   auto-detection (~/workspace, ~/dev, ~/code, ...).
#   data_file:      override for which JSON the *viewer* reads (server-only).
def load_config():
    if not os.path.isfile(CONFIG_FILE):
        return {}
    try:
        return json.load(open(CONFIG_FILE))
    except Exception:
        return {}


def expand(p):
    return os.path.expanduser(p) if isinstance(p, str) else p


_cfg = load_config()
_explicit_ws = [expand(p) for p in (_cfg.get('workspace_dirs') or []) if p]
if _explicit_ws:
    WORKSPACE_DIRS = [p for p in _explicit_ws if os.path.isdir(p)]
else:
    # Auto-detect: first existing common dev-dir name.
    _candidates = ['workspace', 'dev', 'code', 'Projects', 'projects', 'repos', 'src']
    WORKSPACE_DIRS = []
    for _name in _candidates:
        _path = os.path.join(HOME, _name)
        if os.path.isdir(_path):
            WORKSPACE_DIRS.append(_path)
            break

os.makedirs(OUT_DIR, exist_ok=True)

# Discover the user's primary memory dir under ~/.claude/projects/.
# Claude Code names this dir after the escaped HOME path: slashes AND dots
# both become dashes (e.g. "/Users/cindy.q.wang" → "-Users-cindy-q-wang").
# Other dirs under projects/ correspond to per-repo session contexts and have
# their own (mostly empty) memory subfolders — we want the HOME-rooted one.
_escaped_home = HOME.replace('/', '-').replace('.', '-')
_primary_mem = f'{HOME}/.claude/projects/{_escaped_home}/memory'
MEM_DIR = _primary_mem if os.path.isdir(_primary_mem) else None
MEM_DIR_DISPLAY = MEM_DIR.replace(HOME, '~') if MEM_DIR else '~/.claude/projects/(none)/memory'

# ---------- parsing ----------

def parse_frontmatter(path):
    try:
        text = open(path).read()
    except Exception:
        return None, ''
    m = re.match(r'^---\s*\n(.*?\n)---', text, re.DOTALL)
    if not m:
        return None, text
    return m.group(1), text


def get_field(fm, field):
    m = re.search(rf'^{field}:\s*(.+?)(?=\n[a-z_-]+:|\n---|\Z)',
                  fm, re.MULTILINE | re.DOTALL)
    if not m:
        return ''
    raw = m.group(1).strip()
    if raw.startswith('>') or raw.startswith('|'):
        raw = raw.lstrip('>').lstrip('|').strip()
    return re.sub(r'\s+', ' ', raw)


def triggers_from_desc(desc):
    out, seen = [], set()
    for t in re.findall(r'"([^"]+)"', desc):
        k = t.lower()
        if k not in seen and 1 < len(t) < 50:
            seen.add(k)
            out.append(t)
    return out


def parse_tools(fm):
    if not fm:
        return []
    block = re.search(r'^(?:tools|allowed-tools):\s*\n((?:\s+-\s+.+\n?)+)',
                      fm, re.MULTILINE)
    if block:
        return [re.sub(r'\s*#.*$', '', l.strip().lstrip('-').strip())
                for l in block.group(1).splitlines() if l.strip()]
    inline = re.search(r'^(?:tools|allowed-tools):\s*\[(.*?)\]', fm, re.MULTILINE)
    if inline:
        return [t.strip() for t in inline.group(1).split(',') if t.strip()]
    line = re.search(r'^(?:tools|allowed-tools):\s*(.+)$', fm, re.MULTILINE)
    if line:
        v = line.group(1).strip()
        if v and not v.startswith('|') and not v.startswith('>'):
            return [t.strip() for t in v.split(',') if t.strip()]
    return []


def strip_frontmatter(text):
    return re.sub(r'^---\s*\n.*?\n---\s*\n?', '', text, count=1, flags=re.DOTALL)


def parse_skill_like(path, name_from_filename=False):
    fm, text = parse_frontmatter(path)
    if fm is None:
        return None
    name = (os.path.basename(path).rsplit('.md', 1)[0]
            if name_from_filename
            else (get_field(fm, 'name') or os.path.basename(path).rsplit('.md', 1)[0]))
    desc = get_field(fm, 'description')
    return {
        'name': name,
        'desc': desc,
        'path': path,
        'content': strip_frontmatter(text),
        'triggers': triggers_from_desc(desc),
        'tools': parse_tools(fm),
        'nested': [],
    }


def read_text(path):
    try:
        return open(path).read()
    except Exception:
        return ''


def find_skill_nested(skill_dir):
    """Every .md under a skill dir except SKILL.md is a helper doc that
    belongs to the skill. Walking the tree (not just one level) catches
    `references/*.md` and any other subdir conventions plugins use."""
    out = []
    for f in sorted(glob.glob(f'{skill_dir}/**/*.md', recursive=True)):
        if os.path.basename(f) == 'SKILL.md':
            continue
        rel = os.path.relpath(f, skill_dir)
        out.append({
            'name': rel,
            'path': f,
            'content': read_text(f),
        })
    return out


def attribute_agent_refs(claude_dir, agents):
    """`agents/references/` is a flat shared folder. Attribute each ref to
    any agent whose body mentions the ref by basename. Returns the list of
    unattributed refs (orphans) so the tree can still surface them."""
    refs_dir = f'{claude_dir}/agents/references'
    if not os.path.isdir(refs_dir):
        return []
    refs = []
    for f in sorted(glob.glob(f'{refs_dir}/*.md')):
        refs.append({
            'name': os.path.relpath(f, f'{claude_dir}/agents'),
            'path': f,
            'content': read_text(f),
        })
    attributed = set()
    for agent in agents:
        body = agent.get('content', '')
        for ref in refs:
            stem = os.path.basename(ref['path']).rsplit('.md', 1)[0]
            if stem in body:
                agent['nested'].append(ref)
                attributed.add(ref['path'])
    return [r for r in refs if r['path'] not in attributed]


MEM_PREFIXES = ('feedback_', 'reference_', 'user_')
# Types that get their own collapsible folder (the filename prefix is a
# real convention). Other real types (project, user) sit flat at the
# parent level since they don't have a consistent filename prefix.
MEM_GROUPED_TYPES = ('feedback', 'reference', 'user')
MEM_FLAT_TYPES = ('project', 'other')


def parse_memory(path):
    fm, text = parse_frontmatter(path)
    fname = os.path.basename(path).rsplit('.md', 1)[0]
    name = fname
    desc = ''
    mtype = 'project'
    if fm:
        name = get_field(fm, 'name') or name
        desc = get_field(fm, 'description')
        # `type:` on its own line, optionally indented. Earlier versions
        # used a stricter `metadata:\n\s+type:` pattern that broke when
        # `type:` wasn't the first key under `metadata:` (e.g. when
        # `node_type:` came first), silently bucketing those files as
        # the default mtype.
        t = re.search(r'(?m)^[ \t]*type:\s*(\w+)', fm)
        if t:
            mtype = t.group(1).strip()
    else:
        lines = [l for l in text.splitlines() if l.strip()] if text else []
        if lines:
            desc = lines[0].lstrip('# ').strip()[:160]
    # Filename prefix overrides frontmatter type — defensive backstop
    # when the body `type:` drifts out of sync with the filename.
    for prefix in MEM_PREFIXES:
        if fname.startswith(prefix):
            mtype = prefix[:-1]
            break
    return {
        'name': name, 'desc': desc, 'path': path,
        'content': strip_frontmatter(text or ''),
        'mtype': mtype,
        'triggers': triggers_from_desc(desc), 'tools': [],
    }


def collect_claude_dir(claude_dir):
    items = {
        'skills': [], 'agents': [], 'commands': [],
        'agent_orphans': [], 'claude_md': None,
    }
    for d in sorted(glob.glob(f'{claude_dir}/skills/*/SKILL.md')):
        x = parse_skill_like(d)
        if x:
            x['nested'] = find_skill_nested(os.path.dirname(d))
            items['skills'].append(x)
    for f in sorted(glob.glob(f'{claude_dir}/agents/*.md')):
        x = parse_skill_like(f, name_from_filename=True)
        if x:
            items['agents'].append(x)
    items['agent_orphans'] = attribute_agent_refs(claude_dir, items['agents'])
    for f in sorted(glob.glob(f'{claude_dir}/commands/*.md')):
        x = parse_skill_like(f, name_from_filename=True)
        if x:
            items['commands'].append(x)
    claude_md_path = f'{claude_dir}/CLAUDE.md'
    if os.path.isfile(claude_md_path):
        items['claude_md'] = {
            'name': 'CLAUDE.md',
            'desc': 'Global instructions loaded into every session.',
            'path': claude_md_path,
            'content': read_text(claude_md_path),
            'triggers': [],
            'tools': [],
            'nested': [],
        }
    return items


# ---------- inventory ----------

inventory = {
    'global': None, 'workspace': {}, 'memory': {},
    'plugins': {}, 'automations': {}, 'plans': [],
}
inventory['global'] = collect_claude_dir(f'{HOME}/.claude')

# Workspace: scan each configured/detected dir; skip silently if none exist.
for ws_root in WORKSPACE_DIRS:
    for ws_dir in sorted(glob.glob(f'{ws_root}/*/')):
        repo = os.path.basename(ws_dir.rstrip('/'))
        items = collect_claude_dir(f'{ws_dir}.claude')
        if any(items.values()):
            # If multiple workspace roots have a repo of the same name, the last
            # one wins. Not common enough to fuss about.
            inventory['workspace'][repo] = items

# Memory
mem_by_type = {'feedback': [], 'reference': [], 'project': [], 'user': [], 'other': []}
index_item = None
if MEM_DIR:
    for f in sorted(glob.glob(f'{MEM_DIR}/*.md')):
        if os.path.basename(f) == 'MEMORY.md':
            try:
                content = open(f).read()
            except Exception:
                content = ''
            index_item = {
                'name': 'MEMORY.md',
                'desc': 'Index loaded into every session.',
                'path': f, 'content': content, 'mtype': 'index',
                'triggers': [], 'tools': [],
            }
            continue
        it = parse_memory(f)
        bucket = mem_by_type.get(it['mtype'], mem_by_type['other'])
        bucket.append(it)
inventory['memory'] = {'index': index_item, 'by_type': mem_by_type}

# Automations: hooks (from settings) + routines (cached sidecar)
hooks = []
for settings_file in ('settings.json', 'settings.local.json'):
    p = f'{HOME}/.claude/{settings_file}'
    if not os.path.isfile(p):
        continue
    try:
        s = json.load(open(p))
    except Exception:
        continue
    for event, entries in (s.get('hooks') or {}).items():
        for entry in entries:
            matcher = entry.get('matcher', '')
            for h in (entry.get('hooks') or []):
                hooks.append({
                    'event': event,
                    'matcher': matcher,
                    'type': h.get('type', ''),
                    'command': h.get('command', ''),
                    'timeout': h.get('timeout'),
                    'source': settings_file,
                })

routines = []
if os.path.isfile(ROUTINES_FILE):
    try:
        routines = json.load(open(ROUTINES_FILE))
    except Exception:
        routines = []

inventory['automations'] = {'hooks': hooks, 'routines': routines}

# Plans
plans = []
plans_dir = f'{HOME}/.claude/plans'
if os.path.isdir(plans_dir):
    for f in glob.glob(f'{plans_dir}/*.md'):
        try:
            text = open(f).read()
        except Exception:
            continue
        mtime = os.path.getmtime(f)
        h1 = re.search(r'^#\s+(.+?)\s*$', text, re.MULTILINE)
        title = h1.group(1).strip() if h1 else os.path.basename(f).rsplit('.md', 1)[0]
        summary = ''
        for line in text.splitlines():
            s = line.strip()
            if not s or s.startswith('#') or s.startswith('```') \
                    or s.startswith('|') or s.startswith('-') or s.startswith('*'):
                continue
            summary = s[:200]
            break
        plans.append({
            'path': f, 'title': title, 'summary': summary,
            'content': text, 'mtime': mtime,
        })
plans.sort(key=lambda p: p['mtime'], reverse=True)
inventory['plans'] = plans

# Plugins
plugins_meta = f'{HOME}/.claude/plugins/installed_plugins.json'
if os.path.isfile(plugins_meta):
    try:
        installed = json.load(open(plugins_meta))
    except Exception:
        installed = {'plugins': {}}
    seen = set()
    for plugin_key, entries in installed.get('plugins', {}).items():
        for e in entries:
            p = e['installPath']
            if p in seen or not os.path.isdir(p):
                continue
            seen.add(p)
            items = collect_claude_dir(p)
            if any(items.values()):
                inventory['plugins'][plugin_key] = {
                    'path': p, 'items': items, 'version': e.get('version', ''),
                }

# ---------- file content map ----------

file_map = {}
meta_map = {}


def add_to_map(it):
    file_map[it['path']] = it.get('content', '')
    meta_map[it['path']] = {
        'desc': it.get('desc', ''),
        'triggers': it.get('triggers', []),
        'tools': it.get('tools', []),
    }
    for nested in it.get('nested', []) or []:
        file_map[nested['path']] = nested.get('content', '')
        meta_map[nested['path']] = {
            'desc': '', 'triggers': [], 'tools': [],
        }


def add_collected_to_map(items):
    for kind in ('skills', 'agents', 'commands'):
        for it in items[kind]:
            add_to_map(it)
    for orphan in items.get('agent_orphans', []) or []:
        file_map[orphan['path']] = orphan.get('content', '')
        meta_map[orphan['path']] = {'desc': '', 'triggers': [], 'tools': []}
    if items.get('claude_md'):
        add_to_map(items['claude_md'])


add_collected_to_map(inventory['global'])
for repo, items in inventory['workspace'].items():
    add_collected_to_map(items)
if inventory['memory']['index']:
    add_to_map(inventory['memory']['index'])
for items in inventory['memory']['by_type'].values():
    for it in items:
        add_to_map(it)
for meta in inventory['plugins'].values():
    add_collected_to_map(meta['items'])


def hook_synth_key(h, i):
    return f'~/.claude/{h["source"]}#hooks.{h["event"]}.{i}'


for i, h in enumerate(inventory['automations']['hooks']):
    key = hook_synth_key(h, i)
    body = []
    body.append(f"# {h['event']} hook")
    body.append('')
    if h['matcher']:
        body.append(f"**Matcher:** `{h['matcher']}`")
    body.append(f"**Type:** `{h['type']}`")
    if h['timeout']:
        body.append(f"**Timeout:** {h['timeout']}s")
    body.append(f"**Source:** `~/.claude/{h['source']}`")
    body.append('')
    body.append('## Command')
    body.append('```bash')
    body.append(h['command'])
    body.append('```')
    file_map[key] = '\n'.join(body)
    meta_map[key] = {
        'desc': f"Fires on {h['event']}" + (f" — matcher `{h['matcher']}`" if h['matcher'] else ''),
        'triggers': [],
        'tools': [],
        'real_path': f"{HOME}/.claude/{h['source']}",
    }


def routine_synth_key(r):
    return f'~/.claude/routines/{r["id"]}.md'


for p in inventory['plans']:
    file_map[p['path']] = p['content']
    mtime_str = datetime.datetime.fromtimestamp(p['mtime']).strftime('%b %-d, %Y')
    meta_map[p['path']] = {
        'desc': p.get('summary', ''),
        'triggers': [], 'tools': [],
        'date': mtime_str,
    }

for r in inventory['automations']['routines']:
    key = routine_synth_key(r)
    body = []
    body.append(f"# {r['name']}")
    body.append('')
    body.append(f"**ID:** `{r['id']}`")
    body.append(f"**Schedule:** {r.get('schedule_human', r.get('cron', ''))} — `{r.get('cron', '')}`")
    body.append(f"**Enabled:** {'yes' if r.get('enabled') else 'no'}")
    if r.get('model'):
        body.append(f"**Model:** {r['model']}")
    if r.get('next_run_at'):
        body.append(f"**Next run:** {r['next_run_at']}")
    if r.get('last_fired_at'):
        body.append(f"**Last run:** {r['last_fired_at']}")
    body.append('')
    if r.get('description'):
        body.append('## What it does')
        body.append('')
        body.append(r['description'])
        body.append('')
    if r.get('allowed_tools'):
        body.append('## Allowed tools')
        body.append('')
        for t in r['allowed_tools']:
            body.append(f'- `{t}`')
    file_map[key] = '\n'.join(body)
    meta_map[key] = {
        'desc': r.get('description', '')[:200],
        'triggers': [],
        'tools': r.get('allowed_tools', []),
        'real_path': None,
    }

# ---------- HTML rendering (tree strings only) ----------

def esc(s):
    return html.escape(s, quote=True)


KIND_BADGES = {
    'skills': ('skill', '#f59e0b'),
    'agents': ('agent', '#6366f1'),
    'commands': ('cmd', '#10b981'),
}
MEMORY_TYPE_COLORS = {
    'user': '#0ea5e9',
    'feedback': '#ef4444',
    'project': '#a855f7',
    'reference': '#14b8a6',
    'other': '#64748b',
    'index': '#1b1b18',
}


DOC_BADGE_COLOR = '#94a3b8'


def render_nested_row(nested, indent_prefix, is_last, parent_kind='doc'):
    branch = '└─ ' if is_last else '├─ '
    display = nested['name']
    search_text = (display + ' ' + (nested.get('content', '') or '')[:200]).lower()
    # Inherit the parent's data-kind so the chip filter keeps parent + children
    # together — clicking "agents" still shows nested agent helper docs.
    return (
        f'<div class="row leaf nested-doc" data-kind="{parent_kind}" data-path="{esc(nested["path"])}" '
        f'data-search="{esc(search_text)}">'
        f'<span class="branch">{indent_prefix}{branch}</span>'
        f'<span class="name clickable">{esc(display)}</span>'
        f'<span class="badge" style="background:{DOC_BADGE_COLOR}">doc</span>'
        f'</div>'
    )


def render_item_row(it, kind, indent_prefix, is_last, badge_color, badge_label, mtype=None):
    branch = '└─ ' if is_last else '├─ '
    display = (it['name'] + '/') if kind == 'skills' else os.path.basename(it['path'])
    data_kind = 'memory' if mtype else kind
    search_text = (it['name'] + ' ' + it.get('desc', '')).lower()
    nested = it.get('nested') or []
    if not nested:
        return (
            f'<div class="row leaf" data-kind="{data_kind}" data-path="{esc(it["path"])}" '
            f'data-search="{esc(search_text)}">'
            f'<span class="branch">{indent_prefix}{branch}</span>'
            f'<span class="name clickable">{esc(display)}</span>'
            f'<span class="badge" style="background:{badge_color}">{badge_label}</span>'
            f'</div>'
        )
    # With nested children: wrap row in <details>. Click on .name navigates
    # to the parent's file; click anywhere else on the row toggles the
    # native summary (same UX as the kindgroup folders). See app.js.
    out = []
    out.append('<details class="nestable" open>')
    out.append(
        f'<summary class="row leaf has-nested" data-kind="{data_kind}" '
        f'data-path="{esc(it["path"])}" data-search="{esc(search_text)}">'
        f'<span class="branch">{indent_prefix}{branch}</span>'
        f'<span class="name clickable">{esc(display)}</span>'
        f'<span class="hint nested-count">({len(nested)})</span>'
        f'<span class="badge" style="background:{badge_color}">{badge_label}</span>'
        f'</summary>'
    )
    child_indent = indent_prefix + ('   ' if is_last else '│  ')
    for i, n in enumerate(nested):
        out.append(render_nested_row(n, child_indent, i == len(nested) - 1, parent_kind=data_kind))
    out.append('</details>')
    return '\n'.join(out)


def render_claude_md_row(it, indent_prefix, is_last):
    branch = '└─ ' if is_last else '├─ '
    search_text = ('CLAUDE.md ' + (it.get('desc', '') or '')).lower()
    return (
        f'<div class="row leaf" data-kind="claudemd" data-path="{esc(it["path"])}" '
        f'data-search="{esc(search_text)}">'
        f'<span class="branch">{indent_prefix}{branch}</span>'
        f'<span class="name clickable">CLAUDE.md</span>'
        f'<span class="badge" style="background:#1b1b18">global</span>'
        f'</div>'
    )


def render_agent_orphans(orphans, indent_prefix):
    """Refs in `agents/references/` not attributed to any agent — show
    flat under agents/ as a `references/` subfolder so they're not lost."""
    if not orphans:
        return ''
    out = []
    out.append(
        f'<details class="kindgroup"><summary class="row group-row" data-kind="doc">'
        f'<span class="branch">{indent_prefix}└─ </span>'
        f'<span class="folder">references/</span> '
        f'<span class="hint">({len(orphans)})</span></summary>'
    )
    child = indent_prefix + '   '
    for i, r in enumerate(orphans):
        out.append(render_nested_row(
            {'name': os.path.basename(r['path']), 'path': r['path'], 'content': r.get('content', '')},
            child,
            i == len(orphans) - 1,
            parent_kind='agents',
        ))
    out.append('</details>')
    return '\n'.join(out)


def render_group(items_by_kind, indent=''):
    out = []
    kinds_present = [k for k in ('skills', 'agents', 'commands') if items_by_kind.get(k)]
    orphans = items_by_kind.get('agent_orphans') or []
    if items_by_kind.get('claude_md'):
        is_last_overall = not kinds_present
        out.append(render_claude_md_row(items_by_kind['claude_md'], indent, is_last_overall))
    for kidx, kind in enumerate(kinds_present):
        is_last_kind = (kidx == len(kinds_present) - 1)
        kbr = '└─ ' if is_last_kind else '├─ '
        label, color = KIND_BADGES[kind]
        items = items_by_kind[kind]
        out.append(
            f'<details class="kindgroup" open><summary class="row group-row" '
            f'data-kind="{kind}"><span class="branch">{indent}{kbr}</span>'
            f'<span class="folder">{kind}/</span> '
            f'<span class="hint">({len(items)})</span></summary>'
        )
        child_prefix = indent + '   '
        for i, it in enumerate(items):
            is_last_item = (i == len(items) - 1) and not (kind == 'agents' and orphans)
            out.append(render_item_row(it, kind, child_prefix, is_last_item, color, label))
        if kind == 'agents' and orphans:
            out.append(render_agent_orphans(orphans, child_prefix))
        out.append('</details>')
    return '\n'.join(out)


def build_global_tree(inv):
    items_by_kind = inv['global']
    plans = inv['plans']
    kinds_present = [k for k in ('skills', 'agents', 'commands') if items_by_kind.get(k)]
    groups = list(kinds_present) + (['plans'] if plans else [])
    orphans = items_by_kind.get('agent_orphans') or []
    out = ['<div class="row root"><span class="folder root-name">~/.claude/</span></div>']
    # CLAUDE.md sits at the root, ahead of skills/agents/commands.
    if items_by_kind.get('claude_md'):
        no_groups = not groups
        out.append(render_claude_md_row(items_by_kind['claude_md'], '', no_groups))
    for gidx, group in enumerate(groups):
        is_last = (gidx == len(groups) - 1)
        gbr = '└─ ' if is_last else '├─ '
        if group == 'plans':
            out.append(
                f'<details class="kindgroup"><summary class="row group-row" data-kind="plan">'
                f'<span class="branch">{gbr}</span><span class="folder">plans/</span> '
                f'<span class="hint">({len(plans)})</span></summary>'
            )
            month_groups = {}
            for p in plans:
                d = datetime.date.fromtimestamp(p['mtime'])
                key = d.strftime('%Y-%m')
                month_groups.setdefault(key, []).append(p)
            month_keys = list(month_groups.keys())
            outer_indent = '   '
            for midx, mkey in enumerate(month_keys):
                items = month_groups[mkey]
                m_last = (midx == len(month_keys) - 1)
                mbr = '└─ ' if m_last else '├─ '
                label = datetime.datetime.strptime(mkey, '%Y-%m').strftime('%B %Y')
                open_attr = 'open' if midx == 0 else ''
                out.append(
                    f'<details class="plangroup" {open_attr}><summary class="row group-row" '
                    f'data-kind="plan"><span class="branch">{outer_indent}{mbr}</span>'
                    f'<span class="folder">{esc(label)}/</span> '
                    f'<span class="hint">({len(items)})</span></summary>'
                )
                inner_indent = outer_indent + '   '
                for i, p in enumerate(items):
                    is_last_i = (i == len(items) - 1)
                    cb = '└─ ' if is_last_i else '├─ '
                    search_text = (
                        p['title'] + ' ' + p.get('summary', '') + ' ' + os.path.basename(p['path'])
                    ).lower()
                    out.append(
                        f'<div class="row leaf" data-kind="plan" data-path="{esc(p["path"])}" '
                        f'data-search="{esc(search_text)}">'
                        f'<span class="branch">{inner_indent}{cb}</span>'
                        f'<span class="name clickable">{esc(p["title"])}</span>'
                        f'<span class="badge" style="background:#0d9488">plan</span></div>'
                    )
                out.append('</details>')
            out.append('</details>')
        else:
            kind = group
            label, color = KIND_BADGES[kind]
            items = items_by_kind[kind]
            out.append(
                f'<details class="kindgroup" open><summary class="row group-row" '
                f'data-kind="{kind}"><span class="branch">{gbr}</span>'
                f'<span class="folder">{kind}/</span> '
                f'<span class="hint">({len(items)})</span></summary>'
            )
            for i, it in enumerate(items):
                is_last_item = (i == len(items) - 1) and not (kind == 'agents' and orphans)
                out.append(render_item_row(it, kind, '   ', is_last_item, color, label))
            if kind == 'agents' and orphans:
                out.append(render_agent_orphans(orphans, '   '))
            out.append('</details>')
    return '\n'.join(out)


def build_workspace_tree(inv):
    # Show the actual workspace dir(s) being scanned, not a hardcoded ~/workspace.
    if WORKSPACE_DIRS:
        labels = ', '.join(d.replace(HOME, '~') for d in WORKSPACE_DIRS)
    else:
        labels = '(none — set workspace_dirs in ~/Library/Application Support/MemoryMap/config.local.json)'
    out = [f'<div class="row root"><span class="folder root-name">{esc(labels)}/</span></div>']
    repos = list(inv['workspace'].items())
    if not repos:
        out.append('<div class="row" style="color:var(--muted);padding-left:20px;font-style:italic;">No workspace repos with .claude/ found.</div>')
        return '\n'.join(out)
    for ridx, (repo, items) in enumerate(repos):
        is_last = (ridx == len(repos) - 1)
        br = '└─ ' if is_last else '├─ '
        out.append(
            f'<details class="repo"><summary class="row repo-row">'
            f'<span class="branch">{br}</span>'
            f'<span class="folder">{esc(repo)}/.claude/</span></summary>'
        )
        out.append(f'<div class="repo-body">{render_group(items, indent="   ")}</div>')
        out.append('</details>')
    return '\n'.join(out)


def build_memory_tree(inv):
    mem = inv['memory']
    out = [f'<div class="row root"><span class="folder root-name">{esc(MEM_DIR_DISPLAY)}/</span></div>']

    # Build the ordered list of top-level entries:
    #   1. MEMORY.md (index)
    #   2. Flat unprefixed files (project + user + other), alphabetical
    #   3. Grouped prefixed folders (feedback_, reference_)
    entries = []  # each is ('index', it) | ('leaf', it, mtype) | ('group', mtype, items)
    if mem['index']:
        entries.append(('index', mem['index']))
    flat = []
    for mt in MEM_FLAT_TYPES:
        for it in mem['by_type'].get(mt, []):
            flat.append((it, mt))
    flat.sort(key=lambda x: os.path.basename(x[0]['path']).lower())
    for it, mt in flat:
        entries.append(('leaf', it, mt))
    for mt in MEM_GROUPED_TYPES:
        items = mem['by_type'].get(mt, [])
        if items:
            entries.append(('group', mt, items))

    for i, entry in enumerate(entries):
        is_last = (i == len(entries) - 1)
        br = '└─ ' if is_last else '├─ '
        if entry[0] == 'index':
            idx = entry[1]
            out.append(
                f'<div class="row leaf" data-kind="memory" data-path="{esc(idx["path"])}" '
                f'data-search="memory index">'
                f'<span class="branch">{br}</span>'
                f'<span class="name clickable">MEMORY.md</span>'
                f'<span class="badge" style="background:#1b1b18">index</span>'
                f'</div>'
            )
        elif entry[0] == 'leaf':
            it, mt = entry[1], entry[2]
            color = MEMORY_TYPE_COLORS.get(mt, '#64748b')
            display = os.path.basename(it['path'])
            search_text = (display + ' ' + it.get('desc', '')).lower()
            out.append(
                f'<div class="row leaf" data-kind="memory" data-path="{esc(it["path"])}" '
                f'data-search="{esc(search_text)}">'
                f'<span class="branch">{br}</span>'
                f'<span class="name clickable">{esc(display)}</span>'
                f'<span class="badge" style="background:{color}">{esc(mt)}</span>'
                f'</div>'
            )
        else:  # 'group'
            mt, items = entry[1], entry[2]
            color = MEMORY_TYPE_COLORS.get(mt, '#64748b')
            label = mt + '_'  # honest filename prefix, not a fake folder
            out.append(
                f'<details class="memtype"><summary class="row memtype-row" data-kind="memory">'
                f'<span class="branch">{br}</span>'
                f'<span class="folder" style="color:{color}">{esc(label)}</span> '
                f'<span class="hint">({len(items)})</span></summary>'
            )
            out.append('<div class="memtype-body">')
            prefix = mt + '_'
            for j, it in enumerate(items):
                is_l = (j == len(items) - 1)
                cb = '└─ ' if is_l else '├─ '
                # Keep the full filename in the search index so the
                # stripped prefix remains findable.
                search_text = (os.path.basename(it['path']) + ' ' + it.get('desc', '')).lower()
                display = os.path.basename(it['path'])
                if display.startswith(prefix):
                    display = display[len(prefix):]
                out.append(
                    f'<div class="row leaf" data-kind="memory" data-path="{esc(it["path"])}" '
                    f'data-search="{esc(search_text)}">'
                    f'<span class="branch">   {cb}</span>'
                    f'<span class="name clickable">{esc(display)}</span>'
                    f'<span class="badge" style="background:{color}">{esc(mt)}</span>'
                    f'</div>'
                )
            out.append('</div></details>')
    return '\n'.join(out)


def build_automations_tree(inv):
    out = ['<div class="row root"><span class="folder root-name">automations</span></div>']
    hooks = inv['automations']['hooks']
    routines = inv['automations']['routines']
    if hooks:
        is_last_group = not routines
        gbr = '└─ ' if is_last_group else '├─ '
        out.append(
            f'<details class="autogroup" open><summary class="row group-row" data-kind="hook">'
            f'<span class="branch">{gbr}</span><span class="folder">hooks/</span> '
            f'<span class="hint">({len(hooks)})</span></summary>'
        )
        for i, h in enumerate(hooks):
            is_last = (i == len(hooks) - 1)
            cb = '└─ ' if is_last else '├─ '
            key = hook_synth_key(h, i)
            label = f"{h['event']}" + (f" [{h['matcher']}]" if h['matcher'] else '')
            search_text = f"{h['event']} {h['matcher']} {h['command']}".lower()
            out.append(
                f'<div class="row leaf" data-kind="hook" data-path="{esc(key)}" '
                f'data-search="{esc(search_text)}">'
                f'<span class="branch">   {cb}</span>'
                f'<span class="name clickable">{esc(label)}</span>'
                f'<span class="badge" style="background:#ec4899">hook</span></div>'
            )
        out.append('</details>')
    if routines:
        gbr = '└─ '
        out.append(
            f'<details class="autogroup" open><summary class="row group-row" data-kind="routine">'
            f'<span class="branch">{gbr}</span><span class="folder">routines/</span> '
            f'<span class="hint">({len(routines)})</span></summary>'
        )
        for i, r in enumerate(routines):
            is_last = (i == len(routines) - 1)
            cb = '└─ ' if is_last else '├─ '
            key = routine_synth_key(r)
            search_text = f"{r['name']} {r.get('cron','')} {r.get('description','')}".lower()
            enabled_glyph = '' if r.get('enabled') else ' (disabled)'
            out.append(
                f'<div class="row leaf" data-kind="routine" data-path="{esc(key)}" '
                f'data-search="{esc(search_text)}">'
                f'<span class="branch">   {cb}</span>'
                f'<span class="name clickable">{esc(r["name"])}{enabled_glyph}</span>'
                f'<span class="badge" style="background:#0ea5e9">routine</span></div>'
            )
        out.append('</details>')
    if not hooks and not routines:
        out.append('<div class="row" style="color:var(--muted);padding-left:20px;font-style:italic;">No hooks or routines configured.</div>')
    return '\n'.join(out)


def build_plugins_tree(inv):
    out = ['<div class="row root"><span class="folder root-name">~/.claude/plugins/ <span class="hint">(installed)</span></span></div>']
    plugins = sorted(inv['plugins'].items(), key=lambda kv: kv[0])
    for pidx, (key, meta) in enumerate(plugins):
        is_last = (pidx == len(plugins) - 1)
        br = '└─ ' if is_last else '├─ '
        ver = f' <span class="version">v{esc(meta["version"])}</span>' if meta.get('version') else ''
        out.append(
            f'<details class="plugin"><summary class="row plugin-row">'
            f'<span class="branch">{br}</span>'
            f'<span class="folder">{esc(key)}/</span>{ver}</summary>'
        )
        out.append(f'<div class="plugin-body">{render_group(meta["items"], indent="   ")}</div>')
        out.append('</details>')
    return '\n'.join(out)


trees = {
    'global': build_global_tree(inventory),
    'memory': build_memory_tree(inventory),
    'workspace': build_workspace_tree(inventory),
    'automations': build_automations_tree(inventory),
    'plugins': build_plugins_tree(inventory),
}

# ---------- counts ----------

def _count_items(items):
    n = sum(len(items.get(k, [])) for k in ('skills', 'agents', 'commands'))
    n += len(items.get('agent_orphans') or [])
    if items.get('claude_md'):
        n += 1
    return n


n_global = _count_items(inventory['global'])
n_workspace = sum(_count_items(items) for items in inventory['workspace'].values())
n_plugins = sum(_count_items(m['items']) for m in inventory['plugins'].values())
n_memory = sum(len(v) for v in inventory['memory']['by_type'].values()) + (1 if inventory['memory']['index'] else 0)
n_automations = len(inventory['automations']['hooks']) + len(inventory['automations']['routines'])
n_plans = len(inventory['plans'])

counts = {
    'global': n_global + n_plans,
    'memory': n_memory,
    'workspace': n_workspace,
    'automations': n_automations,
    'plugins': n_plugins,
}

# ---------- write JSON ----------

# Keys in files/meta are stored tilde-prefixed for portability across users.
files_out = {k.replace(HOME, '~'): v for k, v in file_map.items()}
meta_out = {k.replace(HOME, '~'): v for k, v in meta_map.items()}

payload = {
    'trees': trees,
    'counts': counts,
    'files': files_out,
    'meta': meta_out,
    'generated_at': datetime.datetime.now().isoformat(timespec='seconds'),
}

with open(OUT_FILE, 'w') as f:
    json.dump(payload, f)

size_kb = os.path.getsize(OUT_FILE) // 1024
print(f'wrote {OUT_FILE} ({size_kb} KB)')
print(f'global={n_global} memory={n_memory} plans={n_plans} workspace={n_workspace} '
      f'automations={n_automations} plugins={n_plugins}')
