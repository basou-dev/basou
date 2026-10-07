/**
 * The board page of `basou view`, served verbatim at `GET /board` in single
 * mode. It draws one record of the board (`GET /api/board`, or
 * `/api/board/<ULID>` with `?record=<ULID>`) in eight sections, from the record
 * alone, with the fixed strings the server sends in the workspace's language.
 * Everything is put in with createElement / textContent (never innerHTML): a
 * record's prose is the judge's text, and a script running on this origin
 * could call the view's POST routes. Only a span between backticks in prose
 * becomes a <code> element, built as a node. The embedded script uses no
 * template literals, no backslashes and no backticks (this file is itself a
 * template literal).
 */
export const BOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>basou board</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.6 system-ui, -apple-system, Segoe UI, sans-serif; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 16px; }
  nav.records { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; font-size: 13px; margin-bottom: 8px; }
  nav.records a { color: inherit; }
  nav.records select { font: inherit; }
  h1 { font-size: 22px; margin: 4px 0; }
  h2 { font-size: 17px; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #8884; }
  h3 { font-size: 15px; margin: 0 0 4px; }
  .stamp { font-size: 13px; opacity: .8; }
  .reported { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 6px; border: 1px dashed #8888; font-size: 11px; font-weight: 400; vertical-align: middle; opacity: .85; }
  .prose { white-space: pre-wrap; }
  .prose code, td code { font-size: 12px; padding: 0 3px; border-radius: 4px; background: #8882; }
  .tiles { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0; }
  .tile { border: 1px solid #8884; border-radius: 8px; padding: 8px 14px; min-width: 150px; }
  .tile .v { font-size: 24px; font-weight: 700; }
  .tile .k, .tile .s { font-size: 12px; opacity: .75; }
  table { border-collapse: collapse; }
  th, td { text-align: left; vertical-align: top; padding: 4px 10px 4px 0; }
  table.grid td, table.grid th { border-bottom: 1px solid #8883; }
  .scroll { overflow-x: auto; }
  table.matrix th.stage { font-weight: 400; font-size: 12px; text-align: center; min-width: 64px; }
  table.matrix th.stage b { display: block; font-size: 13px; }
  table.matrix td.cell { text-align: center; font-size: 18px; line-height: 1; }
  .st::before { display: inline-block; width: 1.2em; }
  .st.done::before { content: "\\25CF"; color: #16a34a; }
  .st.part::before { content: "\\25D0"; color: #16a34a; }
  .st.blocked::before { content: "\\25A0"; color: #d97706; }
  .st.shelved::before { content: "\\2298"; opacity: .6; }
  .st.none::before { content: "\\25CB"; opacity: .45; }
  .st.unverified::before { content: "?"; color: #3b82f6; font-weight: 700; }
  td.moved { outline: 2px solid #2563eb88; outline-offset: -3px; border-radius: 6px; }
  .legend { font-size: 12px; opacity: .8; display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 6px; }
  .anomalies { font-size: 13px; color: #b45309; }
  .lane { border: 1px solid #8884; border-radius: 8px; padding: 10px 14px; margin: 10px 0; }
  .chip { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 6px; font-size: 12px; background: #8882; }
  .chip.live { background: #22c55e33; }
  .chip.blocked { background: #f59e0b33; }
  .chip.unverified { background: #3b82f633; }
  .muted { opacity: .65; }
  .bar { height: 10px; background: #8882; border-radius: 5px; min-width: 160px; position: relative; overflow: hidden; }
  .bar span { position: absolute; left: 0; top: 0; bottom: 0; background: #2563eb; }
  ol.turns li { margin-bottom: 8px; }
  .foot { font-size: 13px; }
  #status.err { color: #dc2626; }
</style>
</head>
<body>
<div class="wrap">
  <nav class="records" id="records"></nav>
  <div id="status"></div>
  <div id="board"></div>
</div>
<script>
(function () {
  var S = null;
  var lang = 'en';
  function $(id) { return document.getElementById(id); }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'text') node.textContent = attrs[k];
        else if (k === 'class') node.className = attrs[k];
        else if (k === 'onchange') node.addEventListener('change', attrs[k]);
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }
  // Fill each {name} of a fixed string, in one pass over the fixed string, so
  // that what a value holds is never filled in itself. A test lifts this function.
  function fill(template, values) {
    var t = String(template);
    var given = values || {};
    var out = '';
    var i = 0;
    while (i < t.length) {
      var open = t.indexOf('{', i);
      var close = open === -1 ? -1 : t.indexOf('}', open + 1);
      if (close === -1) { out += t.slice(i); break; }
      var key = t.slice(open + 1, close);
      out += t.slice(i, open);
      out += Object.prototype.hasOwnProperty.call(given, key) ? String(given[key]) : t.slice(open, close + 1);
      i = close + 1;
    }
    return out;
  }
  // Split prose into text and the spans between backticks, which become code.
  // An unmatched backtick, and a pair with nothing between, stay as written.
  // A test lifts this function.
  function codeSpans(text) {
    var tick = String.fromCharCode(96);
    var parts = String(text).split(tick);
    var out = [];
    var plain = function (s) {
      if (s === '') return;
      var last = out.length > 0 ? out[out.length - 1] : null;
      if (last !== null && !last.code) last.text += s;
      else out.push({ code: false, text: s });
    };
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 0) plain(parts[i]);
      else if (i === parts.length - 1) plain(tick + parts[i]);
      else if (parts[i] === '') plain(tick + tick);
      else out.push({ code: true, text: parts[i] });
    }
    return out;
  }
  function prose(text, tag) {
    var node = el(tag || 'div', { class: 'prose' });
    codeSpans(text).forEach(function (p) {
      node.appendChild(p.code ? el('code', { text: p.text }) : document.createTextNode(p.text));
    });
    return node;
  }
  function reported() { return el('span', { class: 'reported', text: S.reported }); }
  function num(n) {
    if (n === null || n === undefined) return S.tiles.notMeasured;
    if (typeof n !== 'number') return String(n);
    return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  }
  function hm(ms) {
    if (ms === null || ms === undefined) return S.effort.notMeasured;
    var minutes = Math.floor(ms / 60000);
    var m = minutes % 60;
    return Math.floor(minutes / 60) + 'h ' + (m < 10 ? '0' : '') + m + 'm';
  }
  function when(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US');
  }
  function shown(value) {
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  }
  function stateName(state) { return S.states[state] || state; }
  function setStatus(message, isErr) {
    var s = $('status');
    s.textContent = message || '';
    s.className = isErr ? 'err' : '';
  }
  function section(title, isReported, children) {
    var h = el('h2', { text: title });
    if (isReported) h.appendChild(reported());
    return el('section', null, [h].concat(children));
  }

  function records(d) {
    var nav = $('records');
    clear(nav);
    var page = d.page;
    var list = page.records || [];
    if (list.length === 0) return;
    var link = function (id, label) {
      return el('a', { href: '/board?record=' + encodeURIComponent(id), text: label });
    };
    // Around the record asked for, whether or not it could be drawn.
    if (page.older) nav.appendChild(link(page.older, S.older));
    if (page.newer) nav.appendChild(link(page.newer, S.newer));
    nav.appendChild(el('a', { href: '/board', text: S.latest }));
    var select = el('select', {
      onchange: function () { location.href = '/board?record=' + encodeURIComponent(select.value); }
    });
    var listed = list.some(function (r) { return r.id === page.id; });
    if (!listed) {
      var none = el('option', { value: '', text: '-' });
      none.selected = true;
      none.disabled = true;
      select.appendChild(none);
    }
    list.slice().reverse().forEach(function (r) {
      var option = el('option', { value: r.id, text: when(r.at) + '  ' + r.id });
      if (r.id === page.id) option.selected = true;
      select.appendChild(option);
    });
    nav.appendChild(select);
  }

  function heading(b) {
    var h = b.heading;
    var measured = h.complete ? S.heading.complete : fill(S.heading.incomplete, { n: h.not_found });
    var judged = el('span', { text: fill(S.heading.judgedBy, { model: h.model }) }, [reported()]);
    return el('header', null, [
      el('h1', { text: h.title }),
      el('div', { class: 'stamp' }, [
        fill(S.heading.recordedAt, { at: when(h.recorded_at) }) + '  /  ',
        judged,
        '  /  ' + measured
      ])
    ]);
  }

  function summary(b) {
    var s = b.summary;
    var tiles = el('div', { class: 'tiles' });
    var labels = {
      live_lanes: S.tiles.liveLanes, blocked: S.tiles.blocked, unverified: S.tiles.unverified,
      open_tracks: S.tiles.openTracks, sessions: S.tiles.sessions, turns: S.tiles.turns
    };
    s.tiles.forEach(function (t) {
      var sub = null;
      if (t.key === 'live_lanes') sub = fill(S.tiles.liveLanesOf, { n: t.detail });
      if (t.key === 'sessions' && t.detail !== null && t.detail !== undefined) {
        sub = fill(S.tiles.sessionsNotVerified, { n: num(t.detail) });
      }
      var k = el('div', { class: 'k', text: labels[t.key] || t.key });
      if (t.reported) k.appendChild(reported());
      tiles.appendChild(el('div', { class: 'tile', 'data-tile': t.key }, [
        k, el('div', { class: 'v', text: num(t.value) }), sub === null ? null : el('div', { class: 's', text: sub })
      ]));
    });
    var observed;
    if (s.observed.length === 0) {
      observed = el('p', { class: 'muted', text: S.observed.none });
    } else {
      var rows = s.observed.map(function (o) {
        var value;
        if (o.value !== null) value = shown(o.value);
        else if (o.previous && o.previous.status === 'value') value = fill(S.observed.missing, { value: shown(o.previous.value) });
        else if (o.previous && o.previous.status === 'unreadable') value = S.observed.missingPreviousUnreadable;
        else value = S.observed.missingNoPrevious;
        if (o.error) value += '  (' + o.error + ')';
        return el('tr', null, [
          el('td', { text: o.name }), el('td', { text: value }),
          el('td', { text: o.observed_at }), el('td', { text: o.source })
        ]);
      });
      observed = el('div', { class: 'scroll' }, [el('table', { class: 'grid' }, [
        el('tr', null, [
          el('th', { text: S.observed.name }), el('th', { text: S.observed.value }),
          el('th', { text: S.observed.observedAt }), el('th', { text: S.observed.source })
        ])
      ].concat(rows))]);
    }
    var observedHeading = el('h3', { text: S.observed.heading }, [reported()]);
    return section(S.sections.summary, false, [
      el('div', null, [prose(s.text), reported()]),
      tiles,
      observedHeading,
      observed
    ]);
  }

  function effort(b) {
    var e = b.effort;
    var rows = [];
    var row = function (k, v) { rows.push(el('tr', null, [el('td', { class: 'muted', text: k }), el('td', { text: v })])); };
    row(S.effort.start, e.start + (e.time_zone === null ? '' : '  (' + e.time_zone + ')'));
    row(S.effort.elapsedLabel, e.elapsed_days === null ? S.effort.notMeasured : fill(S.effort.elapsed, { days: e.elapsed_days }));
    row(S.effort.active, hm(e.active_ms.union));
    row(S.effort.claude, hm(e.active_ms.claude));
    row(S.effort.codex, e.active_ms.codex === null && e.active_ms.union !== null ? S.effort.noCodex : hm(e.active_ms.codex));
    var tokens = num(e.output_tokens);
    if (e.sessions_without_tokens) tokens += '  (' + fill(S.effort.withoutTokens, { n: e.sessions_without_tokens }) + ')';
    row(S.effort.outputTokens, tokens);
    if (e.commits === null) row(S.effort.commits, S.effort.notMeasured);
    else e.commits.forEach(function (c) { row(S.effort.commits + '  ' + c.repo, num(c.count)); });
    var milestones = e.milestones.length === 0
      ? el('p', { class: 'muted', text: S.effort.noMilestones })
      : el('ul', null, e.milestones.map(function (m) {
          return el('li', null, [m.date + '  ', el('b', { text: m.label }), el('span', { class: 'muted', text: '  ' + m.ref })]);
        }));
    return section(S.sections.effort, false, [
      el('table', null, rows), el('h3', { text: S.effort.milestones }), milestones
    ]);
  }

  function matrix(b) {
    var x = b.matrix;
    var children = [];
    if (x.anomalies.length > 0) {
      children.push(el('div', { class: 'anomalies' }, [el('b', { text: S.matrix.anomalies })].concat(
        x.anomalies.map(function (a) {
          return el('div', { text: fill(S.matrix.anomaly, { lane: a.lane, stage: a.stage, state: stateName(a.state), before: a.before }) });
        })
      )));
    }
    var head = el('tr', null, [el('th', { text: S.matrix.lane })].concat(x.stages.map(function (s) {
      return el('th', { class: 'stage' }, [el('b', { text: s.id }), s.meaning]);
    })));
    var rows = x.lanes.map(function (lane) {
      return el('tr', null, [el('th', { text: lane.name })].concat(lane.cells.map(function (c) {
        var title = stateName(c.state) + (c.reason ? ': ' + c.reason : '');
        if (c.moved_from) title += '  (' + fill(S.matrix.moved, { state: stateName(c.moved_from) }) + ')';
        return el('td', { class: 'cell' + (c.moved_from ? ' moved' : ''), title: title, 'data-state': c.state }, [
          el('span', { class: 'st ' + c.state })
        ]);
      })));
    });
    children.push(el('div', { class: 'scroll' }, [el('table', { class: 'matrix' }, [head].concat(rows))]));
    var legend = el('div', { class: 'legend' });
    ['done', 'part', 'blocked', 'shelved', 'none', 'unverified'].forEach(function (s) {
      legend.appendChild(el('span', null, [el('span', { class: 'st ' + s }), stateName(s)]));
    });
    children.push(legend);
    return section(S.sections.matrix, true, children);
  }

  function lanes(b) {
    return section(S.sections.lanes, false, b.lanes.map(function (lane) {
      var head = el('h3', { text: lane.name });
      if (lane.flags.live) head.appendChild(el('span', { class: 'chip live', text: S.lane.live }));
      if (lane.flags.blocked) head.appendChild(el('span', { class: 'chip blocked', text: S.lane.blocked }));
      if (lane.flags.unverified) head.appendChild(el('span', { class: 'chip unverified', text: S.lane.unverified }));
      // The marks are counted from the cells, which the judge reported.
      if (lane.flags.live || lane.flags.blocked || lane.flags.unverified) head.appendChild(reported());
      var body = [head];
      if (lane.about) body.push(el('div', { class: 'muted', text: lane.about }));
      body.push(el('div', null, [
        lane.now === null ? S.lane.notStarted : fill(S.lane.now, { stage: lane.now.stage, meaning: lane.now.meaning, state: stateName(lane.now.state) }),
        reported()
      ]));
      if (lane.attention.length > 0) {
        body.push(el('div', null, [el('b', { text: S.lane.attention }), reported()]));
        body.push(el('ul', null, lane.attention.map(function (a) {
          return el('li', null, [a.stage + ' ' + stateName(a.state) + (a.reason ? ': ' : ''), a.reason ? prose(a.reason, 'span') : null]);
        })));
      }
      if (lane.prose !== null) body.push(el('div', null, [prose(lane.prose), reported()]));
      if (lane.measures.length > 0) {
        body.push(el('div', { class: 'muted', text: S.lane.measures }));
        body.push(el('ul', null, lane.measures.map(function (m) {
          return el('li', { text: m.id + ': ' + num(m.value) + (m.value === null ? '' : ' ' + m.unit) });
        })));
      }
      return el('div', { class: 'lane', 'data-lane': lane.id }, body);
    }));
  }

  function composition(b) {
    if (b.composition.length === 0) {
      return section(S.sections.composition, false, [el('p', { class: 'muted', text: S.composition.none })]);
    }
    var rows = b.composition.map(function (r) {
      var share = r.value === null ? 0 : Math.max(0, Math.min(1, r.value));
      var bar = el('div', { class: 'bar' }, [el('span', { style: 'width: ' + (share * 100) + '%' })]);
      var part = function (p) { return p.id + ' ' + num(p.value) + (p.unit ? ' ' + p.unit : ''); };
      return el('tr', null, [
        el('td', { text: r.label }), el('td', { text: num(r.value) }), el('td', null, [bar]),
        el('td', { class: 'muted', text: part(r.numerator) + ' / ' + part(r.denominator) })
      ]);
    });
    return section(S.sections.composition, false, [el('div', { class: 'scroll' }, [el('table', { class: 'grid' }, rows)])]);
  }

  function turns(b) {
    if (b.turns.length === 0) {
      return section(S.sections.turns, true, [el('p', { class: 'muted', text: S.turns.none })]);
    }
    return section(S.sections.turns, true, [el('ol', { class: 'turns' }, b.turns.map(function (t) {
      return el('li', null, [prose(t.text), el('div', { class: 'muted', text: fill(S.turns.source, { source: t.source }) })]);
    }))]);
  }

  function footnotes(b) {
    var f = b.footnotes;
    var items = f.notes.map(function (n) { return el('li', null, [prose(n, 'span'), reported()]); });
    var last = f.axis.last_review;
    var review = !f.axis.last_review_known ? S.footnotes.reviewUnknown
      : last === null ? S.footnotes.noReview
      : last.from === 'record' ? fill(S.footnotes.lastReviewFromRecord, { date: last.date, model: last.model, record: last.record || '' })
      : fill(S.footnotes.lastReview, { date: last.date, model: last.model });
    var answer = f.axis.review_needed === true ? S.footnotes.reviewNeededYes
      : f.axis.review_needed === false ? S.footnotes.reviewNeededNo : S.footnotes.reviewNeededUnknown;
    items.push(el('li', { text: fill(S.footnotes.axis, { version: f.axis.version }) + '  /  ' + review + '  /  ' + fill(S.footnotes.reviewNeeded, { answer: answer }) }));
    items.push(el('li', { text: fill(S.footnotes.judgedBy, { model: f.model }) }));
    items.push(el('li', { text: S.footnotes.reportedNote }));
    if (f.not_found.length > 0) {
      items.push(el('li', null, [el('b', { text: S.footnotes.notMeasured }), el('ul', null, f.not_found.map(function (n) {
        return el('li', { text: n.at + ': ' + n.reason });
      }))]));
    }
    var build = f.measured_with.build === null ? '' : ' (' + f.measured_with.build + ')';
    items.push(el('li', { text: fill(S.footnotes.measuredWith, { basou: f.measured_with.basou, build: build }) }));
    return section(S.sections.footnotes, false, [el('ul', { class: 'foot' }, items)]);
  }

  function draw(d) {
    S = d.strings;
    lang = d.language;
    document.documentElement.lang = lang;
    document.title = S.pageTitle;
    records(d);
    var root = $('board');
    clear(root);
    var page = d.page;
    if (page.status !== 'ok') {
      var messages = {
        no_board: S.unavailable.noBoard, no_records: S.unavailable.noRecords,
        records_not_directory: S.unavailable.recordsNotDirectory,
        records_unreadable: S.unavailable.recordsUnreadable,
        not_found: S.unavailable.notFound, not_json: S.unavailable.notJson,
        unknown_version: S.unavailable.unknownVersion, not_a_record: S.unavailable.notARecord
      };
      var quiet = page.why === 'no_board' || page.why === 'no_records';
      setStatus(fill(messages[page.why] || page.why, { record: page.id || '', version: page.version }), !quiet);
      return;
    }
    setStatus('', false);
    var b = page.board;
    [heading(b), summary(b), effort(b), matrix(b), lanes(b), composition(b), turns(b), footnotes(b)]
      .forEach(function (node) { root.appendChild(node); });
  }

  var record = new URLSearchParams(location.search).get('record');
  setStatus('...', false);
  fetch('/api/board' + (record ? '/' + encodeURIComponent(record) : ''))
    .then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body && body.error ? body.error : String(res.status));
        return body;
      });
    })
    .then(draw)
    .catch(function (err) { setStatus(S ? fill(S.loadFailed, { message: err.message }) : String(err.message), true); });
})();
</script>
</body>
</html>
`;
