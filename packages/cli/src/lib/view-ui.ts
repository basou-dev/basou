/**
 * The single-page UI for `basou view`, served verbatim at `GET /`. Kept as one
 * inline string so the CLI build needs no asset pipeline. All data is rendered
 * with createElement / textContent (never innerHTML), so session, task, and
 * command content cannot inject markup. The embedded script deliberately uses
 * no template literals (this file is itself a template literal).
 *
 * Two modes, distinguished by the `mode` field of `GET /api/portfolio`:
 *  - single: one workspace; the tabbed detail view drives `/api/*` directly.
 *  - portfolio: a landing of per-workspace cards; clicking one drills into the
 *    same tabbed view scoped to `/api/ws/<key>/*`. All per-workspace fetches go
 *    through `state.base`, so the single-mode code path is unchanged.
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
  /* On the portfolio landing there is no selected workspace, so the per-workspace action bar is hidden. */
  body.landing #project, body.landing label.chk,
  body.landing #btn-refresh, body.landing #btn-import-claude, body.landing #btn-import-codex,
  body.landing #btn-gen-handoff, body.landing #btn-gen-decisions { display: none; }
  #status { padding: 6px 16px; font-size: 13px; min-height: 20px; border-bottom: 1px solid #8884; white-space: pre-wrap; }
  #status.err { color: #dc2626; }
  .err { color: #dc2626; }
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
  .badge.danger { background: #ef444433; }
  .badge.ok { background: #22c55e33; }
  pre { background: #8881; padding: 12px; border-radius: 8px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
  table.kv { border-collapse: collapse; }
  table.kv td { padding: 2px 10px 2px 0; vertical-align: top; }
  table.kv td.k { opacity: .7; }
  .cards { display: flex; flex-wrap: wrap; gap: 10px; }
  .card { border: 1px solid #8884; border-radius: 8px; padding: 10px 14px; min-width: 120px; }
  .card .n { font-size: 22px; font-weight: 700; }
  .card .l { font-size: 12px; opacity: .7; }
  .pcard { min-width: 240px; max-width: 340px; }
  .pcard.open { cursor: pointer; }
  .pcard.open:hover { background: #8881; }
  .pcard .l { font-size: 14px; font-weight: 700; opacity: 1; margin-bottom: 4px; }
  .pcard .f { font-size: 13px; }
  .tl { border-left: 2px solid #8885; margin-left: 6px; padding-left: 12px; }
  .tl .ev { margin-bottom: 8px; }
  .tl .ev .t { font-size: 12px; opacity: .65; }
  .muted { opacity: .6; }
</style>
</head>
<body>
<header>
  <h1>basou view</h1>
  <button id="btn-back" style="display:none">&larr; portfolio</button>
  <input type="text" id="project" placeholder="source root (optional override)" />
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
  // base is the API prefix for the active workspace: '/api' in single mode,
  // '/api/ws/<key>' once a portfolio card is opened.
  // canAct gates the mutating action bar: true only when a concrete workspace
  // is active (single mode, or a portfolio card opened). It is the real safety
  // guard — body.landing also hides the buttons, but that is cosmetic.
  var state = { tab: 'overview', repoRoot: '', base: '/api', mode: 'single', wsKey: null, canAct: false };

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

  // Enable the action bar only when a workspace is active; disabled buttons
  // cannot post to a stale/wrong workspace even if a CSS regression un-hides them.
  function updateActionBar() {
    var ids = ['btn-refresh', 'btn-import-claude', 'btn-import-codex', 'btn-gen-handoff', 'btn-gen-decisions'];
    for (var i = 0; i < ids.length; i++) $(ids[i]).disabled = !state.canAct;
  }

  function post(path, label) {
    if (!state.canAct) { setStatus('Open a workspace first.', true); return; }
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
        + (data.handoff && data.handoff.status === 'generated'
           ? '; handoff regenerated, decisions: ' + (data.decisions ? data.decisions.decisionCount : 0)
           : '');
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

  // --- portfolio landing --------------------------------------------------

  function boot() {
    fetchJson('/api/portfolio').then(function (d) {
      if (d && d.mode === 'portfolio') { state.mode = 'portfolio'; showLanding(d); }
      else { enterSingle(); }
    }).catch(function () {
      // First-load bootstrap failure: the single-workspace view is the safe default.
      enterSingle();
    });
  }

  // Re-render the portfolio landing (the back button). Unlike boot(), a fetch
  // failure here keeps the inert landing and shows an error rather than silently
  // dropping into single mode pointed at the first workspace.
  function backToPortfolio() {
    enterLandingChrome();
    fetchJson('/api/portfolio').then(function (d) {
      if (d && d.workspaces) renderCards(d);
      else portfolioError('Portfolio unavailable.');
    }).catch(function (err) { portfolioError('Could not load portfolio: ' + err.message); });
  }

  function enterSingle() {
    state.mode = 'single';
    state.base = '/api';
    state.wsKey = null;
    state.canAct = true;
    document.body.classList.remove('landing');
    $('btn-back').style.display = 'none';
    updateActionBar();
    buildTabs();
    loadTab('overview');
  }

  // Landing chrome: no workspace is active, so actions are disabled (and hidden
  // by body.landing). The disable is the safety guard; the hide is cosmetic.
  function enterLandingChrome() {
    state.wsKey = null;
    state.canAct = false;
    document.body.classList.add('landing');
    $('btn-back').style.display = 'none';
    setStatus('', false);
    clear($('tabs'));
    updateActionBar();
    single(true);
  }

  function showLanding(d) { enterLandingChrome(); renderCards(d); }

  function renderCards(d) {
    var detail = $('detail');
    clear(detail);
    var ws = d.workspaces || [];
    detail.appendChild(el('p', { class: 'muted', text: 'Portfolio — ' + ws.length + ' workspace(s). Click a card to open it.' }));
    var cards = el('div', { class: 'cards' }, []);
    ws.forEach(function (w) { cards.appendChild(portfolioCard(w, d.generatedAt)); });
    detail.appendChild(cards);
  }

  function portfolioError(msg) {
    var detail = $('detail');
    clear(detail);
    detail.appendChild(el('p', { class: 'err', text: msg }));
    detail.appendChild(el('button', { text: 'Retry', onclick: backToPortfolio }));
  }

  function highestRisk(approvals) {
    var order = ['critical', 'high', 'medium', 'low'];
    for (var i = 0; i < order.length; i++) {
      for (var j = 0; j < approvals.length; j++) {
        if (approvals[j].risk === order[i]) return order[i];
      }
    }
    return approvals.length ? approvals[0].risk : '';
  }

  // Human-readable age of an ISO timestamp relative to the portfolio's
  // generatedAt ("now"), so a stale capture reads as "3d ago" not a raw ISO.
  function relAge(iso, nowIso) {
    if (!iso) return '(none)';
    var ms = Date.parse(nowIso) - Date.parse(iso);
    if (!isFinite(ms)) return iso;
    if (ms < 60000) return 'just now';
    var m = Math.floor(ms / 60000); if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60); if (h < 48) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  // A "run refresh" badge when a dry-run found uncaptured/changed native sessions,
  // an "up to date" badge when the capture is current, and nothing loud when the
  // staleness probe could not run (degrades to a quiet note).
  function stalenessBadge(st) {
    if (!st) return null;
    if (!st.checked) return el('span', { class: 'badge', text: 'freshness unknown' });
    if (st.unverifiableSessions > 0)
      return el('span', { class: 'badge danger', text: '⚠ ' + st.unverifiableSessions + ' unverifiable — run verify' });
    if (st.newSessions > 0)
      return el('span', { class: 'badge danger', text: '⚠ ' + st.newSessions + ' uncaptured — run refresh' });
    if (st.updatedSessions > 0)
      return el('span', { class: 'badge warn', text: st.updatedSessions + ' updated — run refresh' });
    return el('span', { class: 'badge ok', text: 'up to date' });
  }

  function portfolioCard(w, generatedAt) {
    if (!w.initialized) {
      return el('div', { class: 'card pcard muted' }, [
        el('div', { class: 'l', text: w.label }),
        el('div', { class: 'f', text: w.error ? ('unreadable: ' + w.error) : 'not initialized' })
      ]);
    }
    if (w.error) {
      return el('div', { class: 'card pcard' }, [
        el('div', { class: 'l', text: w.label }),
        el('div', { class: 'f' }, [el('span', { class: 'badge warn', text: 'unreadable: ' + w.error })])
      ]);
    }
    var pend = w.pendingApprovals || [];
    var pendText = 'pending ' + pend.length + (pend.length ? ' (' + highestRisk(pend) + ')' : '');
    var now = w.latestSession ? ((w.latestSession.label || '(session)') + ' [' + w.latestSession.status + ']') : '(no live sessions)';
    var dec = w.latestDecision ? w.latestDecision.title : '(no decisions yet)';
    var newest = (w.freshness && w.freshness.newestStartedAt) ? w.freshness.newestStartedAt : null;
    var badge = stalenessBadge(w.staleness);
    return el('div', { class: 'card pcard open', onclick: function () { openWorkspace(w.key, w.label); } }, [
      el('div', { class: 'l' }, [
        el('span', { text: w.label }),
        badge ? el('span', { text: '  ' }) : null,
        badge
      ]),
      el('div', { class: 'f', text: 'now: ' + now }),
      el('div', { class: 'f', text: 'latest: ' + dec }),
      el('div', { class: 'f', text: 'in-flight ' + w.inFlightCount + '  |  ' + pendText + '  |  suspect ' + w.suspectCount }),
      el('div', { class: 'f muted', text: 'sessions ' + w.sessionCount + '  |  newest ' + relAge(newest, generatedAt) })
    ]);
  }

  function openWorkspace(key, label) {
    state.mode = 'portfolio';
    state.wsKey = key;
    state.base = '/api/ws/' + encodeURIComponent(key);
    state.canAct = true;
    document.body.classList.remove('landing');
    $('btn-back').style.display = '';
    updateActionBar();
    setStatus('workspace: ' + label, false);
    buildTabs();
    loadTab('overview');
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
    if (name === 'decisions') return loadMarkdown(state.base + '/decisions', 'decisions');
    if (name === 'approvals') return loadApprovals();
    if (name === 'handoff') return loadMarkdown(state.base + '/handoff', 'handoff');
  }

  function fail(err) { setStatus(err.message, true); }

  function loadOverview() {
    single(true);
    fetchJson(state.base + '/overview').then(function (d) {
      var detail = $('detail');
      if (!d || d.initialized === false) {
        detail.appendChild(el('p', { class: 'muted', text: 'Workspace not initialized.' }));
        return;
      }
      // Leave the project field empty by default so refresh / import use the
      // manifest's import.source_roots (then the repo root) -- pre-filling the
      // repo root here would send it as an explicit --project and silently
      // override multi-root source roots. The field is an optional override.
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
    fetchJson(state.base + '/stats').then(function (d) {
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
      var sessions = d.sessions || [];
      var tokenSessions = sessions.filter(function (s) { return s.availability && s.availability.tokens; }).length;
      if (!t.tokensAvailable) {
        detail.appendChild(el('p', { class: 'muted', text: 'No token data captured; re-import to backfill.' }));
      } else if (tokenSessions < t.sessionCount) {
        detail.appendChild(el('p', { class: 'muted', text: 'Token data on ' + tokenSessions + ' of ' + t.sessionCount + ' sessions; re-import to backfill the rest.' }));
      }
      var degraded = sessions.filter(function (s) { return s.eventsUnreadable; }).length;
      if (degraded > 0) {
        detail.appendChild(el('p', { class: 'muted', text: degraded + ' session(s) had unreadable event logs; their counts are incomplete.' }));
      }
      detail.appendChild(el('h3', { text: 'Time (human harness labor; active = billing primary)' }));
      var turnSessions = sessions.filter(function (s) { return s.activeTimeBasis === 'engaged-turns'; }).length;
      var basisNote = turnSessions === t.sessionCount ? 'engaged turns' : (turnSessions === 0 ? 'event stream; re-import to capture conversation' : 'engaged turns on ' + turnSessions + ' of ' + t.sessionCount + ' sessions');
      var timeRows = [kvrow('billable active', fmtDur(t.billableActiveTimeMs) + '  (union; ' + basisNote + '; idle gaps > 5m excluded; tz ' + d.timeZone + ')')];
      if (t.activeTimeMs !== t.billableActiveTimeMs) {
        timeRows.push(kvrow('summed', fmtDur(t.activeTimeMs) + '  (concurrent sessions double-counted)'));
      }
      if (t.machineActiveAvailable) {
        var machineSessions = sessions.filter(function (s) { return s.availability && s.availability.machineActive; }).length;
        timeRows.push(kvrow('model working', fmtDur(t.machineActiveTimeMs) + '  (model compute, subset of active; Codex turn duration on ' + machineSessions + ' of ' + t.sessionCount + ' sessions; not wall-clock-deduped)'));
      }
      timeRows.push(kvrow('span', fmtDur(t.sessionSpanMs) + (t.openSessionCount > 0 ? '  (' + t.openSessionCount + ' open)' : '')));
      timeRows.push(kvrow('command', fmtDur(t.commandTimeMs) + (t.commandTimeReliable ? '' : '  (some sessions report 0)')));
      detail.appendChild(el('table', { class: 'kv' }, [el('tbody', {}, timeRows)]));
      if (d.bySource && d.bySource.length) {
        detail.appendChild(el('h3', { text: 'By source' }));
        d.bySource.forEach(function (s) {
          var cmd = s.commandTimeReliable ? fmtDur(s.commandTimeMs) : 'n/a';
          var machine = s.machineActiveAvailable ? ', model ' + fmtDur(s.machineActiveTimeMs) : '';
          detail.appendChild(el('div', { class: 'row' }, [
            el('span', { text: s.sourceKind + ': ' + s.sessionCount + ' sessions, ' + numfmt(s.tokens.output) + ' out tok, active ' + fmtDur(s.activeTimeMs) + machine + ', command ' + cmd })
          ]));
        });
      }
      if (d.byDay && d.byDay.length) {
        detail.appendChild(el('h3', { text: 'By day (billable time x volume)' }));
        d.byDay.forEach(function (day) {
          var dayMachine = day.machineActiveTimeMs > 0 ? ' (model ' + fmtDur(day.machineActiveTimeMs) + ')' : '';
          detail.appendChild(el('div', { class: 'row' }, [
            el('span', { text: day.date + ': ' + fmtDur(day.billableActiveTimeMs) + ' active' + dayMachine + ', ' + numfmt(day.tokens.output) + ' out tok, ' + day.commandCount + ' cmd / ' + day.fileChangedCount + ' files / ' + day.decisionCount + ' dec' })
          ]));
        });
      }
    }).catch(fail);
  }

  function loadSessions() {
    single(false);
    fetchJson(state.base + '/sessions').then(function (d) {
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
    fetchJson(state.base + '/sessions/' + encodeURIComponent(id)).then(function (d) {
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
    if (ev.type === 'decision_voided') {
      var vs = ev.superseded_by ? ' superseded by ' + ev.superseded_by : '';
      return 'voided ' + ev.decision_id + (ev.reason ? ': ' + ev.reason : '') + vs;
    }
    return '';
  }

  function loadTasks() {
    single(false);
    fetchJson(state.base + '/tasks').then(function (d) {
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
    fetchJson(state.base + '/tasks/' + encodeURIComponent(id)).then(function (d) {
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
    fetchJson(state.base + '/approvals').then(function (d) {
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

  $('btn-back').addEventListener('click', function () { backToPortfolio(); });
  $('btn-refresh').addEventListener('click', function () { post(state.base + '/refresh', 'Refresh all'); });
  $('btn-import-claude').addEventListener('click', function () { post(state.base + '/import/claude-code', 'Import claude-code'); });
  $('btn-import-codex').addEventListener('click', function () { post(state.base + '/import/codex', 'Import codex'); });
  $('btn-gen-handoff').addEventListener('click', function () { post(state.base + '/handoff/generate', 'Regenerate handoff'); });
  $('btn-gen-decisions').addEventListener('click', function () { post(state.base + '/decisions/generate', 'Regenerate decisions'); });

  boot();
})();
</script>
</body>
</html>`;
