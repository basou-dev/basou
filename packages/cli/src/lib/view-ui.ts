/**
 * The single-page UI for `basou view`, served verbatim at `GET /`. Kept as one
 * inline string so the CLI build needs no asset pipeline. All data is rendered
 * with createElement / textContent (never innerHTML), so session, task, and
 * command content cannot inject markup. The embedded script deliberately uses
 * no template literals (this file is itself a template literal).
 */
export const VIEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>basou view</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
  header { padding: 10px 16px; border-bottom: 1px solid #8884; display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
  header h1 { font-size: 15px; margin: 0 12px 0 0; font-weight: 700; }
  header .grow { flex: 1; }
  input[type=text] { padding: 4px 8px; border: 1px solid #8886; border-radius: 6px; min-width: 280px; font: inherit; }
  button { padding: 4px 10px; border: 1px solid #8886; border-radius: 6px; background: #8881; cursor: pointer; font: inherit; }
  button.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
  button:disabled { opacity: .5; cursor: default; }
  label.chk { font-size: 13px; opacity: .85; }
  #status { padding: 6px 16px; font-size: 13px; min-height: 20px; border-bottom: 1px solid #8884; white-space: pre-wrap; }
  #status.err { color: #dc2626; }
  nav { display: flex; gap: 2px; padding: 6px 12px; border-bottom: 1px solid #8884; flex-wrap: wrap; }
  nav button { border: none; border-radius: 6px; background: transparent; }
  nav button.active { background: #2563eb22; font-weight: 600; }
  main { display: grid; grid-template-columns: minmax(220px, 320px) 1fr; min-height: 60vh; }
  main.single { grid-template-columns: 1fr; }
  #list { border-right: 1px solid #8884; overflow: auto; max-height: 80vh; }
  #list .row { padding: 8px 12px; border-bottom: 1px solid #8883; cursor: pointer; }
  #list .row:hover { background: #8881; }
  #list .row.active { background: #2563eb22; }
  #list .row .meta { font-size: 12px; opacity: .7; }
  #detail { padding: 12px 16px; overflow: auto; max-height: 80vh; }
  .badge { display: inline-block; padding: 0 6px; border-radius: 6px; background: #8882; font-size: 12px; }
  .badge.warn { background: #f59e0b33; }
  pre { background: #8881; padding: 12px; border-radius: 8px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
  table.kv { border-collapse: collapse; }
  table.kv td { padding: 2px 10px 2px 0; vertical-align: top; }
  table.kv td.k { opacity: .7; }
  .cards { display: flex; flex-wrap: wrap; gap: 10px; }
  .card { border: 1px solid #8884; border-radius: 8px; padding: 10px 14px; min-width: 120px; }
  .card .n { font-size: 22px; font-weight: 700; }
  .card .l { font-size: 12px; opacity: .7; }
  .tl { border-left: 2px solid #8885; margin-left: 6px; padding-left: 12px; }
  .tl .ev { margin-bottom: 8px; }
  .tl .ev .t { font-size: 12px; opacity: .65; }
  .muted { opacity: .6; }
</style>
</head>
<body>
<header>
  <h1>basou view</h1>
  <input type="text" id="project" placeholder="project path" />
  <button class="primary" id="btn-refresh">Refresh all</button>
  <button id="btn-import-claude">Import claude-code</button>
  <button id="btn-import-codex">Import codex</button>
  <button id="btn-gen-handoff">Regenerate handoff</button>
  <button id="btn-gen-decisions">Regenerate decisions</button>
  <span class="grow"></span>
  <label class="chk"><input type="checkbox" id="opt-force" /> force</label>
  <label class="chk"><input type="checkbox" id="opt-dry" /> dry-run</label>
</header>
<div id="status"></div>
<nav id="tabs"></nav>
<main id="main">
  <div id="list"></div>
  <div id="detail"></div>
</main>
<script>
(function () {
  var TABS = ['overview', 'stats', 'sessions', 'tasks', 'decisions', 'approvals', 'handoff'];
  var state = { tab: 'overview', repoRoot: '' };

  function $(id) { return document.getElementById(id); }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else node.setAttribute(k, attrs[k]);
      }
    }
    if (children) {
      for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (c === null || c === undefined) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  function setStatus(msg, isErr) {
    var s = $('status');
    s.textContent = msg || '';
    s.className = isErr ? 'err' : '';
  }

  function fetchJson(path, opts) {
    return fetch(path, opts).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var m = data && data.error ? data.error : ('HTTP ' + res.status);
          throw new Error(m);
        }
        return data;
      });
    });
  }

  function single(on) { $('main').className = on ? 'single' : ''; if (on) clear($('list')); }

  // --- action bar ---------------------------------------------------------

  function actionBody() {
    var body = {};
    var project = $('project').value.trim();
    if (project) body.project = project;
    if ($('opt-force').checked) body.force = true;
    if ($('opt-dry').checked) body.dryRun = true;
    return body;
  }

  function setBusy(busy) {
    var ids = ['btn-refresh', 'btn-import-claude', 'btn-import-codex', 'btn-gen-handoff', 'btn-gen-decisions'];
    for (var i = 0; i < ids.length; i++) $(ids[i]).disabled = busy;
  }

  function post(path, label) {
    setBusy(true);
    setStatus(label + '...', false);
    fetchJson(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(actionBody())
    }).then(function (data) {
      setStatus(label + ' done: ' + summarize(data), false);
      loadTab(state.tab);
    }).catch(function (err) {
      setStatus(label + ' failed: ' + err.message, true);
    }).then(function () { setBusy(false); });
  }

  function summarize(data) {
    if (!data) return 'ok';
    if (data.claudeCode || data.codex) {
      return 'claude-code ' + imp(data.claudeCode) + ', codex ' + imp(data.codex)
        + (data.handoff && data.handoff.status === 'generated' ? '; handoff+decisions regenerated' : '');
    }
    if (data.status === 'ran') return imp(data);
    if (data.status === 'skipped') return 'skipped (' + data.reason + ')';
    if (typeof data.sessionCount === 'number') return 'sessions ' + data.sessionCount + ', decisions ' + data.decisionCount;
    if (typeof data.decisionCount === 'number') return 'decisions ' + data.decisionCount;
    return 'ok';
  }
  function imp(o) {
    if (!o) return '-';
    if (o.status === 'skipped') return 'skipped';
    return (o.dryRun ? 'would import ' : 'imported ') + o.importedCount + ' (' + o.eventTotal + ' events)';
  }

  // --- tabs ---------------------------------------------------------------

  function buildTabs() {
    var nav = $('tabs');
    clear(nav);
    TABS.forEach(function (name) {
      nav.appendChild(el('button', {
        class: name === state.tab ? 'active' : '',
        text: name,
        onclick: function () { loadTab(name); }
      }));
    });
  }

  function loadTab(name) {
    state.tab = name;
    buildTabs();
    clear($('detail'));
    clear($('list'));
    if (name === 'overview') return loadOverview();
    if (name === 'stats') return loadStats();
    if (name === 'sessions') return loadSessions();
    if (name === 'tasks') return loadTasks();
    if (name === 'decisions') return loadMarkdown('/api/decisions', 'decisions');
    if (name === 'approvals') return loadApprovals();
    if (name === 'handoff') return loadMarkdown('/api/handoff', 'handoff');
  }

  function fail(err) { setStatus(err.message, true); }

  function loadOverview() {
    single(true);
    fetchJson('/api/overview').then(function (d) {
      var detail = $('detail');
      if (!d || d.initialized === false) {
        detail.appendChild(el('p', { class: 'muted', text: 'Workspace not initialized.' }));
        return;
      }
      $('project').value = $('project').value || d.repoRoot || '';
      state.repoRoot = d.repoRoot || '';
      detail.appendChild(el('p', {}, [
        el('strong', { text: d.workspace.name }), '  ',
        el('span', { class: 'muted', text: d.workspace.id })
      ]));
      var c = d.counts;
      var cards = el('div', { class: 'cards' }, [
        card(c.sessions, 'sessions'),
        card(c.suspectSessions, 'suspect'),
        card(c.tasks, 'tasks'),
        card(c.pendingTasks, 'pending tasks'),
        card(c.decisions, 'decisions'),
        card(c.approvalsPending, 'approvals pending')
      ]);
      detail.appendChild(cards);
      detail.appendChild(el('p', { class: 'muted', text: 'repo: ' + d.repoRoot }));
    }).catch(fail);
  }
  function card(n, label) {
    return el('div', { class: 'card' }, [
      el('div', { class: 'n', text: String(n) }),
      el('div', { class: 'l', text: label })
    ]);
  }

  function numfmt(n) { return (n || 0).toLocaleString('en-US'); }
  function fmtDur(ms) {
    var s = Math.round((ms || 0) / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h > 0) return h + 'h ' + (m < 10 ? '0' : '') + m + 'm';
    if (m > 0) return m + 'm ' + (sec < 10 ? '0' : '') + sec + 's';
    return sec + 's';
  }
  function kvrow(k, v) {
    return el('tr', {}, [el('td', { class: 'k', text: k }), el('td', { text: v })]);
  }

  function loadStats() {
    single(true);
    fetchJson('/api/stats').then(function (d) {
      var detail = $('detail');
      var t = d.totals;
      detail.appendChild(el('p', { text: 'Sessions: ' + t.sessionCount }));
      detail.appendChild(el('h3', { text: 'Volume (what the AI produced)' }));
      detail.appendChild(el('div', { class: 'cards' }, [
        card(numfmt(t.tokens.output), 'output tokens'),
        (t.tokens.reasoning > 0 ? card(numfmt(t.tokens.reasoning), 'reasoning tokens') : null),
        card(t.commandCount, 'commands'),
        card(t.fileChangedCount, 'files'),
        card(t.decisionCount, 'decisions')
      ]));
      if (!t.tokensAvailable) {
        detail.appendChild(el('p', { class: 'muted', text: 'No token data captured; re-import to backfill.' }));
      }
      detail.appendChild(el('h3', { text: 'Time (proxies, not model compute)' }));
      detail.appendChild(el('table', { class: 'kv' }, [el('tbody', {}, [
        kvrow('active', fmtDur(t.activeTimeMs) + '  (idle gaps > 5m excluded)'),
        kvrow('span', fmtDur(t.sessionSpanMs) + (t.openSessionCount > 0 ? '  (' + t.openSessionCount + ' open)' : '')),
        kvrow('command', fmtDur(t.commandTimeMs) + (t.commandTimeReliable ? '' : '  (some sessions report 0)'))
      ])]));
      if (d.bySource && d.bySource.length) {
        detail.appendChild(el('h3', { text: 'By source' }));
        d.bySource.forEach(function (s) {
          var cmd = s.commandTimeReliable ? fmtDur(s.commandTimeMs) : 'n/a';
          detail.appendChild(el('div', { class: 'row' }, [
            el('span', { text: s.sourceKind + ': ' + s.sessionCount + ' sessions, ' + numfmt(s.tokens.output) + ' out tok, active ' + fmtDur(s.activeTimeMs) + ', command ' + cmd })
          ]));
        });
      }
    }).catch(fail);
  }

  function loadSessions() {
    single(false);
    fetchJson('/api/sessions').then(function (d) {
      var list = $('list');
      var rows = (d && d.sessions) || [];
      if (rows.length === 0) { list.appendChild(el('div', { class: 'row muted', text: 'no sessions' })); return; }
      rows.forEach(function (s) {
        var row = el('div', { class: 'row', onclick: function () { selectSession(row, s.sessionId); } }, [
          el('div', { text: s.label || s.sessionId }),
          el('div', { class: 'meta', text: s.sourceKind + '  ' + s.status + (s.suspect ? '  suspect' : '') })
        ]);
        list.appendChild(row);
      });
    }).catch(fail);
  }
  function selectSession(row, id) {
    var rows = $('list').querySelectorAll('.row');
    for (var i = 0; i < rows.length; i++) rows[i].classList.remove('active');
    row.classList.add('active');
    var detail = $('detail');
    clear(detail);
    fetchJson('/api/sessions/' + encodeURIComponent(id)).then(function (d) {
      var s = d.session.session;
      detail.appendChild(el('h3', { text: s.label || id }));
      detail.appendChild(kv([
        ['status', s.status], ['source', s.source.kind], ['started', s.started_at],
        ['ended', s.ended_at || '-'], ['workdir', s.working_directory]
      ]));
      if (d.degraded) detail.appendChild(el('p', { class: 'badge warn', text: 'events unreadable' }));
      var events = d.events || [];
      detail.appendChild(el('p', { class: 'muted', text: events.length + ' events' }));
      var tl = el('div', { class: 'tl' }, []);
      events.forEach(function (ev) {
        tl.appendChild(el('div', { class: 'ev' }, [
          el('div', { class: 't', text: ev.occurred_at + '  ' + ev.type }),
          el('div', { text: eventSummary(ev) })
        ]));
      });
      detail.appendChild(tl);
    }).catch(fail);
  }
  function eventSummary(ev) {
    if (ev.type === 'command_executed') {
      var cmd = (ev.args && ev.args.length) ? ev.args.join(' ') : ev.command;
      var ex = (ev.exit_code === null || ev.exit_code === undefined) ? '' : ' (exit ' + ev.exit_code + ')';
      return cmd + ex;
    }
    if (ev.type === 'file_changed') return ev.path + ' [' + ev.change_type + ']';
    if (ev.type === 'decision_recorded') return ev.title || '';
    return '';
  }

  function loadTasks() {
    single(false);
    fetchJson('/api/tasks').then(function (d) {
      var list = $('list');
      var rows = (d && d.tasks) || [];
      if (rows.length === 0) { list.appendChild(el('div', { class: 'row muted', text: 'no tasks' })); return; }
      rows.forEach(function (t) {
        var row = el('div', { class: 'row', onclick: function () { selectTask(row, t.id); } }, [
          el('div', { text: t.title || t.label || t.id }),
          el('div', { class: 'meta', text: String(t.status || '') })
        ]);
        list.appendChild(row);
      });
    }).catch(fail);
  }
  function selectTask(row, id) {
    var rows = $('list').querySelectorAll('.row');
    for (var i = 0; i < rows.length; i++) rows[i].classList.remove('active');
    row.classList.add('active');
    var detail = $('detail');
    clear(detail);
    fetchJson('/api/tasks/' + encodeURIComponent(id)).then(function (d) {
      detail.appendChild(el('h3', { text: (d.task && (d.task.title || d.task.label)) || id }));
      detail.appendChild(el('pre', { text: JSON.stringify(d.task, null, 2) }));
      if (d.body) detail.appendChild(el('pre', { text: d.body }));
    }).catch(fail);
  }

  function loadMarkdown(path, label) {
    single(true);
    fetchJson(path).then(function (d) {
      var detail = $('detail');
      var count = (typeof d.decisionCount === 'number') ? (' (' + d.decisionCount + ' decisions)') : '';
      detail.appendChild(el('p', { class: 'muted', text: label + count }));
      detail.appendChild(el('pre', { text: (d && d.body) || '(empty)' }));
    }).catch(fail);
  }

  function loadApprovals() {
    single(true);
    fetchJson('/api/approvals').then(function (d) {
      var detail = $('detail');
      var groups = [['pending', d.pending || []], ['resolved', d.resolved || []]];
      groups.forEach(function (g) {
        detail.appendChild(el('h3', { text: g[0] + ' (' + g[1].length + ')' }));
        if (g[1].length === 0) { detail.appendChild(el('p', { class: 'muted', text: 'none' })); return; }
        g[1].forEach(function (a) {
          detail.appendChild(el('div', { class: 'row' }, [
            el('span', { text: a.id + '  ' }),
            el('span', { class: a.expired ? 'badge warn' : 'badge', text: a.expired ? 'expired' : (a.approval && a.approval.status) || '' })
          ]));
        });
      });
    }).catch(fail);
  }

  function kv(pairs) {
    var tbody = el('tbody', {}, pairs.map(function (p) {
      return el('tr', {}, [el('td', { class: 'k', text: p[0] }), el('td', { text: String(p[1]) })]);
    }));
    return el('table', { class: 'kv' }, [tbody]);
  }

  // --- wire up ------------------------------------------------------------

  $('btn-refresh').addEventListener('click', function () { post('/api/refresh', 'Refresh all'); });
  $('btn-import-claude').addEventListener('click', function () { post('/api/import/claude-code', 'Import claude-code'); });
  $('btn-import-codex').addEventListener('click', function () { post('/api/import/codex', 'Import codex'); });
  $('btn-gen-handoff').addEventListener('click', function () { post('/api/handoff/generate', 'Regenerate handoff'); });
  $('btn-gen-decisions').addEventListener('click', function () { post('/api/decisions/generate', 'Regenerate decisions'); });

  buildTabs();
  loadTab('overview');
})();
</script>
</body>
</html>`;
