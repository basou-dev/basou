/**
 * The board page of `basou view`, served verbatim at `GET /board` in single
 * mode. It draws one record of the board (`GET /api/board`, or
 * `/api/board/<ULID>` with `?record=<ULID>`) in sections, from the record and
 * the one before it alone, with the fixed strings the server sends in the
 * workspace's language.
 * With no record to draw, or with `?live=1`, it draws what basou measures of
 * the workspace now (`GET /api/board/live`): the period and effort, the
 * repositories, the trail and the components, with nothing judged.
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
  :root {
    color-scheme: light;
    --bg: #fcfcfb; --fg: #0b0b0b; --fg-2: #52514e; --border: #d9d8d3; --grid: #e7e6e1;
    --fill: #efeeea; --s1: #2a78d6; --s2: #eb6834;
    --done: #15803d; --warn: #b45309; --info: #2563eb; --err: #dc2626;
    --chip-live: #dcfce7; --chip-blocked: #fef3c7; --chip-unverified: #dbeafe;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --bg: #1a1a19; --fg: #ffffff; --fg-2: #c3c2b7; --border: #3b3b38; --grid: #2d2d2b;
      --fill: #262624; --s1: #3987e5; --s2: #d95926;
      --done: #4ade80; --warn: #fbbf24; --info: #60a5fa; --err: #f87171;
      --chip-live: #14532d; --chip-blocked: #78350f; --chip-unverified: #1e3a8a;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #1a1a19; --fg: #ffffff; --fg-2: #c3c2b7; --border: #3b3b38; --grid: #2d2d2b;
    --fill: #262624; --s1: #3987e5; --s2: #d95926;
    --done: #4ade80; --warn: #fbbf24; --info: #60a5fa; --err: #f87171;
    --chip-live: #14532d; --chip-blocked: #78350f; --chip-unverified: #1e3a8a;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.6 system-ui, -apple-system, Segoe UI, sans-serif; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 16px; }
  nav.records { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; font-size: 13px; margin-bottom: 8px; }
  nav.records a { color: inherit; }
  nav.records select { font: inherit; max-width: 100%; }
  h1 { font-size: 22px; margin: 4px 0; }
  h2 { font-size: 17px; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--border); }
  h3 { font-size: 15px; margin: 12px 0 4px; }
  .stamp { font-size: 13px; color: var(--fg-2); }
  .reported { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 6px; border: 1px dashed var(--fg-2); font-size: 11px; font-weight: 400; vertical-align: middle; color: var(--fg-2); }
  .prose { white-space: pre-wrap; overflow-wrap: anywhere; }
  .prose code, td code { font-size: 12px; padding: 0 3px; border-radius: 4px; background: var(--fill); }
  .tiles { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0; }
  .tile { border: 1px solid var(--border); border-radius: 8px; padding: 8px 14px; min-width: 150px; flex: 1 1 150px; }
  .tile .v { font-size: 24px; font-weight: 700; }
  .tile .k, .tile .s { font-size: 12px; color: var(--fg-2); }
  table { border-collapse: collapse; }
  th, td { text-align: left; vertical-align: top; padding: 4px 10px 4px 0; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  table.grid td, table.grid th { border-bottom: 1px solid var(--grid); }
  .scroll { overflow-x: auto; max-width: 100%; }
  table.matrix th.stage { font-weight: 400; font-size: 12px; text-align: center; min-width: 64px; }
  table.matrix th.stage b { display: block; font-size: 13px; }
  table.matrix td.cell { text-align: center; font-size: 18px; line-height: 1; }
  .stage-meanings { display: none; list-style: none; padding: 0; margin: 6px 0 0; font-size: 12px; color: var(--fg-2); }
  /* Six stages do not fit beside their meanings below about 600px: each is
     drawn by its id, the meanings are listed under the matrix, and a lane
     name wraps. After the rules above, which it overrides. */
  @media (max-width: 600px) {
    table.matrix th.stage { min-width: 0; padding: 4px 2px; }
    table.matrix th.stage .meaning { display: none; }
    table.matrix td.cell { font-size: 16px; padding: 4px 2px; }
    table.matrix th:first-child { max-width: 10em; overflow-wrap: anywhere; }
    .stage-meanings { display: block; }
    /* A table wider than the page scrolls; its notes wrap at the width in
       view and stay at its left edge, so none is cut off on the right. The
       cell keeps no right padding, which a sticky note could not cross. */
    tr.notes td { padding-right: 0; }
    tr.notes ul.sub { position: sticky; left: 0; max-width: calc(100vw - 32px); }
  }
  .st::before { display: inline-block; width: 1.2em; }
  .st.done::before { content: "\\25CF"; color: var(--done); }
  .st.part::before { content: "\\25D0"; color: var(--done); }
  .st.blocked::before { content: "\\25A0"; color: var(--warn); }
  .st.shelved::before { content: "\\2298"; color: var(--fg-2); }
  .st.none::before { content: "\\25CB"; color: var(--fg-2); }
  .st.unverified::before { content: "?"; color: var(--info); font-weight: 700; }
  td.moved { outline: 2px solid var(--info); outline-offset: -3px; border-radius: 6px; }
  .legend { font-size: 12px; color: var(--fg-2); display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 6px; }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
  .swatch.s1 { background: var(--s1); }
  .swatch.s2 { background: var(--s2); }
  .anomalies { font-size: 13px; color: var(--warn); }
  .lane { border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; margin: 10px 0; }
  .lane h3 { margin-top: 0; }
  .chip { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 6px; font-size: 12px; background: var(--fill); }
  .chip.live { background: var(--chip-live); }
  .chip.blocked { background: var(--chip-blocked); }
  .chip.unverified { background: var(--chip-unverified); }
  .muted { color: var(--fg-2); }
  .sub { font-size: 12px; color: var(--fg-2); overflow-wrap: anywhere; }
  ul.sub { margin: 0; padding-left: 18px; }
  td.wrap { overflow-wrap: anywhere; min-width: 10em; }
  tr.notes td { padding-top: 0; }
  .chip.changed { margin-left: 0; margin-right: 6px; background: var(--chip-unverified); }
  .bar { height: 10px; background: var(--fill); border-radius: 5px; min-width: 120px; position: relative; overflow: hidden; }
  .bar span { position: absolute; left: 0; top: 0; bottom: 0; background: var(--s1); }
  figure { margin: 16px 0; }
  figcaption { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
  svg.chart { display: block; width: 100%; min-width: 560px; height: auto; overflow: visible; }
  svg.chart text { fill: var(--fg-2); font-size: 11px; }
  svg.chart .grid { stroke: var(--grid); stroke-width: 1; }
  svg.chart .axis { stroke: var(--border); stroke-width: 1; }
  svg.chart .claude { fill: var(--s1); }
  svg.chart .other { fill: var(--s2); }
  svg.chart .line { fill: none; stroke: var(--s1); stroke-width: 2; }
  svg.chart .ms { stroke: var(--fg-2); stroke-width: 1; stroke-dasharray: 3 3; }
  svg.chart .dot { fill: var(--s1); stroke: var(--bg); stroke-width: 2; }
  svg.chart .start { fill: var(--fg-2); stroke: var(--bg); stroke-width: 2; }
  svg.chart text.ms-label { fill: var(--fg); }
  svg.chart .hit { fill: transparent; }
  svg.chart .hit:hover { fill: var(--grid); fill-opacity: .6; }
  ol.turns li { margin-bottom: 8px; }
  .foot { font-size: 13px; }
  #status.err { color: var(--err); }
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
        else if (k === 'onclick') node.addEventListener('click', attrs[k]);
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
  // An http value with each of its words beside what it says of it, in the
  // order declared. Written out, not built as an object: an object would put a
  // word that reads as a number first.
  function withWords(value, words) {
    return '{' + Object.keys(value).map(function (k) {
      var v = k === 'words'
        ? '{' + words.map(function (w) { return JSON.stringify(w.word) + ':' + JSON.stringify(w.found); }).join(',') + '}'
        : JSON.stringify(value[k]);
      return JSON.stringify(k) + ':' + v;
    }).join(',') + '}';
  }
  // The parts of a value drawn on one line, and what an http value says of each word.
  var DOT = ' ' + String.fromCharCode(183) + ' ';
  var FOUND = String.fromCharCode(10003);
  var NOT_FOUND = String.fromCharCode(10007);
  // An http value read as its parts: the status, the redirects, where it
  // landed, and what it read off the body (when the status is 2xx) or that it
  // did not. Numbers and strings are drawn as they are.
  function httpText(h) {
    var parts = [String(h.status), fill(S.observed.redirects, { n: h.redirects }), h.final_url];
    if (h.body === null) parts.push(S.observed.bodyNotRead);
    else if (h.body) {
      if (h.body.words) {
        parts.push(h.body.words.map(function (w) { return w.word + ' ' + (w.found ? FOUND : NOT_FOUND); }).join('  '));
      }
      if (h.body.count !== undefined) parts.push(fill(S.observed.count, { n: h.body.count }));
      if (h.body.capture !== undefined) {
        parts.push(h.body.capture === null ? S.observed.captureNone : fill(S.observed.capture, { value: JSON.stringify(h.body.capture) }));
      }
    }
    return parts.join(DOT);
  }
  // A value of an observation as the page draws it: an http value in its
  // shape read as its parts, one with words beside what it says of each, and
  // any other as it is (a string) or as JSON. A test lifts this function.
  function observedText(value, words, http) {
    if (http) return httpText(http);
    if (words) return withWords(value, words);
    return shown(value);
  }
  // The value of an observation that moved, and what the previous record
  // held: a value whose type alone moved ("12" and 12) is drawn as JSON, so
  // that the two do not read the same. A test lifts this function.
  function movedText(o) {
    var m = o.moved;
    var now = observedText(o.value, o.words, o.http);
    if (m.status === 'none') return { now: now, then: S.observed.beforeNone };
    if (m.value === null) {
      return { now: now, then: S.observed.beforeNotObserved + (m.error ? '  (' + m.error + ')' : '') };
    }
    var then = observedText(m.value, m.words, m.http);
    if ((typeof m.value === 'string') !== (typeof o.value === 'string')) {
      then = JSON.stringify(m.value);
      if (then === now) now = JSON.stringify(o.value);
    }
    return { now: now, then: fill(S.observed.before, { value: then }) + (m.error ? '  (' + m.error + ')' : '') };
  }
  // A measure's value: the paths of a file_paths by how many, a number with
  // its unit, and a string (a file's name, a capture), which is no amount,
  // without it.
  function measureText(m) {
    if (Array.isArray(m.value)) return num(m.value.length) + ' ' + m.unit;
    return num(m.value) + (typeof m.value === 'number' ? ' ' + m.unit : '');
  }
  function signed(n) { return (n > 0 ? '+' : '') + num(n); }
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
    if (list.length > 0) recordLinks(nav, page, list);
    nav.appendChild(el('a', { href: '/board?live=1', text: S.live.measureNow }));
  }

  function recordLinks(nav, page, list) {
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
    return section(S.sections.summary, false, [el('div', null, [prose(s.text), reported()]), tiles]);
  }

  // The observations outside, which the record holds in its summary, in a
  // section of their own after the lanes.
  function observations(b) {
    var s = b.summary;
    var observed;
    if (s.observed.length === 0) {
      observed = el('p', { class: 'muted', text: S.observed.none });
    } else {
      var rows = [];
      s.observed.forEach(function (o) {
        var cell = el('td', { class: 'wrap' });
        var value;
        if (o.value !== null && o.moved) {
          var pair = movedText(o);
          cell.appendChild(el('span', { class: 'chip changed', text: S.observed.changed }));
          value = pair.now;
          cell.appendChild(el('span', { text: value + (o.error ? '  (' + o.error + ')' : '') }));
          cell.appendChild(el('div', { class: 'sub', text: pair.then }));
        } else {
          if (o.value !== null) value = observedText(o.value, o.words, o.http);
          else if (o.previous && o.previous.status === 'value') value = fill(S.observed.missing, { value: shown(o.previous.value) });
          else if (o.previous && o.previous.status === 'unreadable') value = S.observed.missingPreviousUnreadable;
          else value = S.observed.missingNoPrevious;
          if (o.error) value += '  (' + o.error + ')';
          cell.appendChild(el('span', { text: value }));
        }
        // What the record's declaration says it is and looks at, under its name.
        var what = o.kind ? [o.kind].concat(o.looks_at || []).join(DOT) : null;
        rows.push(el('tr', null, [
          el('td', null, [el('div', { text: o.name }), what === null ? null : el('div', { class: 'sub', text: what })]),
          cell,
          el('td', { text: o.observed_at }), el('td', { class: 'wrap', text: o.source })
        ]));
        if (o.notes && o.notes.length > 0) {
          rows.push(el('tr', { class: 'notes' }, [el('td', { colspan: '4' }, [
            el('ul', { class: 'sub' }, o.notes.map(function (n) { return el('li', null, [prose(n, 'span')]); }))
          ])]));
        }
      });
      observed = el('div', { class: 'scroll' }, [el('table', { class: 'grid' }, [
        el('tr', null, [
          el('th', { text: S.observed.name }), el('th', { text: S.observed.value }),
          el('th', { text: S.observed.observedAt }), el('th', { text: S.observed.source })
        ])
      ].concat(rows))]);
    }
    var children = [observed];
    if (s.previous_record === 'unreadable' && s.observed.length > 0) {
      children.push(el('p', { class: 'muted', text: S.observed.previousUnreadable }));
    }
    return section(S.observed.heading, true, children);
  }

  var SVGNS = 'http://www.w3.org/2000/svg';
  // An SVG element, built as a node like every other.
  function svg(tag, attrs, children) {
    var node = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else node.setAttribute(k, String(attrs[k]));
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }
  // A step of hours for an axis that draws at most five lines. A test lifts this function.
  function hourStep(maxHours) {
    var steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
    for (var i = 0; i < steps.length; i++) {
      if (maxHours / steps[i] <= 5) return steps[i];
    }
    return 1000 * Math.ceil(maxHours / 5000);
  }
  // The days a month starts on, and the first day, as labels for an x axis.
  function monthTicks(days) {
    var out = [];
    days.forEach(function (d, i) {
      if (i === 0 || d.date.slice(8) === '01') {
        out.push({ i: i, label: Number(d.date.slice(5, 7)) + '/' + Number(d.date.slice(8)) });
      }
    });
    return out;
  }
  var CHART = { w: 760, left: 44, right: 10 };
  function plotWidth() { return CHART.w - CHART.left - CHART.right; }
  function dayX(i, n) { return CHART.left + (i + 0.5) * plotWidth() / n; }
  function hours(ms) { return (ms || 0) / 3600000; }
  function yAxis(top, base, max, step, label) {
    var nodes = [];
    for (var v = 0; v <= max + 1e-9; v += step) {
      var y = base - (v / max) * (base - top);
      nodes.push(svg('line', { class: v === 0 ? 'axis' : 'grid', x1: CHART.left, x2: CHART.w - CHART.right, y1: y, y2: y }));
      nodes.push(svg('text', { x: CHART.left - 6, y: y + 4, 'text-anchor': 'end', text: label(v) }));
    }
    return nodes;
  }
  // The month labels under a chart, leaving out one too close to the one before.
  function xAxis(days, base) {
    var last = -Infinity;
    var out = [];
    monthTicks(days).forEach(function (t) {
      var x = dayX(t.i, days.length);
      if (x - last < 40) return;
      last = x;
      out.push(svg('text', { x: x, y: base + 16, 'text-anchor': 'middle', text: t.label }));
    });
    return out;
  }
  // About how wide a label is drawn: a wide character (CJK) counts as two narrow ones.
  function labelWidth(text) {
    var w = 0;
    for (var i = 0; i < text.length; i++) w += text.charCodeAt(i) > 11903 ? 11 : 6.2;
    return w;
  }
  // Where labels beside marks go: each kept inside the chart, centred on its mark
  // or just after it, and in the first of the rows where it does not run into
  // another (the last row when none has room). A test lifts this function.
  function placeLabels(items, rows, centred) {
    var min = CHART.left;
    var max = CHART.w - CHART.right;
    var taken = [];
    for (var r = 0; r < rows; r++) taken.push([]);
    return items.map(function (it) {
      var w = labelWidth(it.text);
      var x0 = centred ? it.x - w / 2 : it.x + 4;
      if (x0 + w > max) x0 = centred ? max - w : it.x - 4 - w;
      if (x0 < min) x0 = min;
      var row = rows - 1;
      for (var k = 0; k < rows; k++) {
        var free = taken[k].every(function (s) { return x0 + w + 6 <= s[0] || x0 >= s[1] + 6; });
        if (free) { row = k; break; }
      }
      taken[row].push([x0, x0 + w]);
      return { x: x0, row: row, text: it.text };
    });
  }
  function dayIndex(days, date) {
    for (var i = 0; i < days.length; i++) if (days[i].date === date) return i;
    return -1;
  }

  // Milestones on a line from the first day to the last.
  function timelineChart(days, milestones) {
    var h = 100;
    var mid = 50;
    var nodes = [svg('line', { class: 'axis', x1: CHART.left, x2: CHART.w - CHART.right, y1: mid, y2: mid })];
    monthTicks(days).forEach(function (t) {
      var x = dayX(t.i, days.length);
      nodes.push(svg('line', { class: 'grid', x1: x, x2: x, y1: mid - 4, y2: mid + 4 }));
    });
    nodes.push(svg('circle', { class: 'start', cx: dayX(0, days.length), cy: mid, r: 5 }, [
      svg('title', { text: days[0].date })
    ]));
    var marks = [];
    milestones.forEach(function (m) {
      var i = dayIndex(days, m.date);
      if (i === -1) return;
      var x = dayX(i, days.length);
      marks.push({ x: x, text: m.label });
      nodes.push(svg('circle', { class: 'dot', cx: x, cy: mid, r: 5 }, [
        svg('title', { text: m.date + '  ' + m.label + '  ' + m.ref })
      ]));
    });
    // Rows above and below the line, nearest first.
    var rowY = [mid - 12, mid + 22, mid - 26, mid + 36];
    placeLabels(marks, rowY.length, true).forEach(function (p) {
      nodes.push(svg('text', { class: 'ms-label', x: p.x, y: rowY[p.row], text: p.text }));
    });
    return el('figure', null, [
      el('figcaption', { text: S.effort.milestones }),
      el('div', { class: 'scroll' }, [svg('svg', { class: 'chart', viewBox: '0 0 ' + CHART.w + ' ' + h, role: 'img', 'aria-label': S.effort.milestones }, nodes)])
    ]);
  }

  // Each day's active time: Claude's, then the part of Codex's not at the same time.
  function dailyChart(days) {
    var h = 200;
    var top = 10;
    var base = h - 26;
    var maxH = 0;
    days.forEach(function (d) { maxH = Math.max(maxH, hours(d.union)); });
    var step = hourStep(Math.max(maxH, 1));
    var max = Math.ceil(Math.max(maxH, 1) / step) * step;
    var scale = (base - top) / max;
    var band = plotWidth() / days.length;
    var width = Math.max(1, band - (band > 4 ? 2 : 0));
    var nodes = yAxis(top, base, max, step, function (v) { return v + 'h'; });
    days.forEach(function (d, i) {
      var x = CHART.left + i * band + (band - width) / 2;
      var ch = hours(d.claude) * scale;
      var oh = hours(d.not_claude) * scale;
      // The gap between the two comes out of the upper one, so the top is the total.
      var gap = ch > 0 && oh > 2 && band > 4 ? 2 : 0;
      if (ch > 0) nodes.push(svg('rect', { class: 'claude', x: x, y: base - ch, width: width, height: ch }));
      if (oh > 0) nodes.push(svg('rect', { class: 'other', x: x, y: base - ch - oh, width: width, height: oh - gap }));
      nodes.push(svg('rect', { class: 'hit', x: CHART.left + i * band, y: top, width: band, height: base - top }, [
        svg('title', { text: fill(S.effort.dayDetail, {
          date: d.date, active: hm(d.union), claude: hm(d.claude), other: hm(d.not_claude), commits: num(d.commits)
        }) })
      ]));
    });
    nodes = nodes.concat(xAxis(days, base));
    var legend = el('div', { class: 'legend' }, [
      el('span', null, [el('span', { class: 'swatch s1' }), S.effort.claude]),
      el('span', null, [el('span', { class: 'swatch s2' }), S.effort.notClaude])
    ]);
    return el('figure', null, [
      el('figcaption', { text: S.effort.dailyTitle }),
      legend,
      el('div', { class: 'scroll' }, [svg('svg', { class: 'chart', viewBox: '0 0 ' + CHART.w + ' ' + h, role: 'img', 'aria-label': S.effort.dailyTitle }, nodes)])
    ]);
  }

  // The running total of active time, with the milestones as dashed lines.
  function cumulativeChart(days, milestones) {
    var h = 200;
    var top = 10;
    var base = h - 26;
    var last = 0;
    days.forEach(function (d) { if (d.cumulative !== null) last = Math.max(last, hours(d.cumulative)); });
    var step = hourStep(Math.max(last, 1));
    var max = Math.ceil(Math.max(last, 1) / step) * step;
    var y = function (ms) { return base - hours(ms) / max * (base - top); };
    var nodes = yAxis(top, base, max, step, function (v) { return v + 'h'; });
    var marks = [];
    milestones.forEach(function (m) {
      var i = dayIndex(days, m.date);
      if (i === -1) return;
      var x = dayX(i, days.length);
      marks.push({ x: x, text: m.label });
      nodes.push(svg('line', { class: 'ms', x1: x, x2: x, y1: top, y2: base }));
    });
    placeLabels(marks, 4, false).forEach(function (p) {
      nodes.push(svg('text', { class: 'ms-label', x: p.x, y: top + 10 + p.row * 13, text: p.text }));
    });
    var path = '';
    for (var i = 0; i < days.length; i++) {
      if (days[i].cumulative === null) break;
      path += (i === 0 ? 'M' : 'L') + dayX(i, days.length).toFixed(1) + ' ' + y(days[i].cumulative).toFixed(1) + ' ';
    }
    if (path !== '') nodes.push(svg('path', { class: 'line', d: path }));
    var band = plotWidth() / days.length;
    days.forEach(function (d, i) {
      nodes.push(svg('rect', { class: 'hit', x: CHART.left + i * band, y: top, width: band, height: base - top }, [
        svg('title', { text: fill(S.effort.cumulativeDetail, { date: d.date, total: hm(d.cumulative) }) })
      ]));
    });
    nodes = nodes.concat(xAxis(days, base));
    return el('figure', null, [
      el('figcaption', { text: S.effort.cumulativeTitle }),
      el('div', { class: 'scroll' }, [svg('svg', { class: 'chart', viewBox: '0 0 ' + CHART.w + ' ' + h, role: 'img', 'aria-label': S.effort.cumulativeTitle }, nodes)])
    ]);
  }

  function weeksTable(weeks, noCodex) {
    var head = el('tr', null, [
      el('th', { text: S.effort.week }), el('th', { class: 'n', text: S.effort.active }),
      el('th', { class: 'n', text: S.effort.claude }), el('th', { class: 'n', text: S.effort.codex }),
      el('th', { class: 'n', text: S.effort.activeDays }), el('th', { class: 'n', text: S.effort.commitColumn })
    ]);
    var rows = weeks.map(function (w) {
      return el('tr', null, [
        el('td', { text: fill(S.effort.weekOf, { date: w.week }) }), el('td', { class: 'n', text: hm(w.union) }),
        el('td', { class: 'n', text: hm(w.claude) }), el('td', { class: 'n', text: noCodex ? '-' : hm(w.codex) }),
        el('td', { class: 'n', text: num(w.active_days) }), el('td', { class: 'n', text: num(w.commits) })
      ]);
    });
    return el('figure', null, [
      el('figcaption', { text: S.effort.weeksTitle }),
      el('div', { class: 'scroll' }, [el('table', { class: 'grid' }, [head].concat(rows))])
    ]);
  }

  // live: the board measured now, which reads no declaration.
  function effort(b, live) {
    var e = b.effort;
    var tile = function (k, v, sub) {
      return el('div', { class: 'tile' }, [
        el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }),
        sub ? el('div', { class: 's', text: sub }) : null
      ]);
    };
    var union = e.active_ms.union;
    // Over the daily rows, today's included (one more than the days elapsed),
    // so that the first day is a day; the sub-text names the divisor.
    var perDay = union === null || !e.period_days ? null : union / e.period_days;
    var perWorked = union === null || !e.active_days ? null : union / e.active_days;
    var perDaySub = [
      perDay === null ? null : fill(S.effort.perDayOver, { days: num(e.period_days) }),
      perWorked === null ? null : fill(S.effort.perDayWorked, { time: hm(perWorked) })
    ].filter(function (part) { return part !== null; }).join(DOT);
    var tokens = e.sessions_without_tokens ? fill(S.effort.withoutTokens, { n: e.sessions_without_tokens }) : null;
    // Each tool's time is the union of its sessions' intervals, as Active is.
    var unionOf = function (ms) { return ms === null ? null : S.effort.toolUnion; };
    var tiles = el('div', { class: 'tiles' }, [
      tile(S.effort.elapsed, e.elapsed_days === null ? S.effort.notMeasured : fill(S.effort.days, { days: e.elapsed_days }),
        e.time_zone === null ? fill(S.effort.from, { date: e.start }) : fill(S.effort.fromZone, { date: e.start, zone: e.time_zone })),
      tile(S.effort.active, hm(union), e.active_days === null ? null : fill(S.effort.daysWorked, { n: e.active_days })),
      tile(S.effort.claude, hm(e.active_ms.claude), unionOf(e.active_ms.claude)),
      tile(S.effort.codex, e.active_ms.codex === null && union !== null ? S.effort.noCodex : hm(e.active_ms.codex), unionOf(e.active_ms.codex)),
      tile(S.effort.perDay, hm(perDay), perDaySub),
      tile(S.effort.outputTokens, num(e.output_tokens), tokens)
    ]);
    // A repo by its name, as the repos table draws it: a workspace that is
    // one repo is at the path '.'. The board measured on the spot holds its
    // repos as a list, a record as { list } or null.
    var names = {};
    var repos = !b.repos ? [] : Array.isArray(b.repos) ? b.repos : b.repos.list;
    repos.forEach(function (r) {
      if (r.name !== null) names[r.path] = r.name;
    });
    var commits = e.commits === null ? S.effort.notMeasured : e.commits.map(function (c) {
      var name = Object.prototype.hasOwnProperty.call(names, c.repo) ? names[c.repo] : c.repo;
      return name + ' ' + num(c.count);
    }).join('  /  ');
    var children = [tiles, el('p', { class: 'muted', text: fill(S.effort.commits, { list: commits }) })];
    var days = e.daily || [];
    if (days.length === 0) {
      children.push(el('p', { class: 'muted', text: S.effort.noDays }));
    } else {
      children.push(timelineChart(days, e.milestones));
      children.push(dailyChart(days));
      children.push(cumulativeChart(days, e.milestones));
    }
    children.push(live
      ? el('p', { class: 'muted', text: S.effort.milestonesNotRead })
      : e.milestones.length === 0
      ? el('p', { class: 'muted', text: S.effort.noMilestones })
      : el('ul', null, e.milestones.map(function (m) {
          return el('li', null, [m.date + '  ', el('b', { text: m.label }), el('span', { class: 'muted', text: '  ' + m.ref })]);
        })));
    // With no Codex session at all, its column is not a measurement that failed.
    var noCodex = e.active_ms.codex === null && union !== null;
    if (e.weeks && e.weeks.length > 0) children.push(weeksTable(e.weeks, noCodex));
    return section(S.sections.effort, false, children);
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
    // The meaning is the head's title too, as a screen reader reads it and a
    // pointer that hovers shows it, and the text beside the id is left out of
    // what a screen reader reads, so that it is read once.
    var head = el('tr', null, [el('th', { text: S.matrix.lane })].concat(x.stages.map(function (s) {
      return el('th', { class: 'stage', title: s.meaning }, [
        el('b', { text: s.id }), el('span', { class: 'meaning', 'aria-hidden': 'true', text: s.meaning })
      ]);
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
    // What each stage means, drawn where a narrow screen gives a stage its id
    // alone (and hidden where the heads say it).
    children.push(el('ul', { class: 'stage-meanings' }, x.stages.map(function (s) {
      return el('li', null, [el('b', { text: s.id }), ' ' + s.meaning]);
    })));
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
          // The paths of a file_paths measure: how many, with the list folded.
          if (Array.isArray(m.value)) {
            return el('li', null, [el('details', null, [
              el('summary', { text: m.id + ': ' + num(m.value.length) + ' ' + m.unit }),
              el('ul', null, m.value.map(function (p) { return el('li', { text: p }); }))
            ])]);
          }
          // A string (a file's name, a capture) is no amount: it takes no unit.
          return el('li', { text: m.id + ': ' + num(m.value) + (typeof m.value === 'number' ? ' ' + m.unit : '') });
        })));
      }
      return el('div', { class: 'lane', 'data-lane': lane.id }, body);
    }));
  }

  // Every measure of the record, with the lanes it is drawn in and how much a
  // number moved since the previous record.
  function measures(b) {
    if (b.measures.length === 0) {
      return section(S.sections.measures, false, [el('p', { class: 'muted', text: S.measures.none })]);
    }
    var head = el('tr', null, [
      el('th', { text: S.measures.id }), el('th', { text: S.measures.value }),
      el('th', { text: S.measures.lanes }), el('th', { class: 'n', text: S.measures.delta })
    ]);
    var rows = b.measures.map(function (m) {
      return el('tr', { 'data-measure': m.id }, [
        el('td', null, [el('code', { text: m.id })]),
        el('td', { class: 'wrap', text: measureText(m) }),
        el('td', { text: m.lanes.length === 0 ? '-' : m.lanes.join(', ') }),
        el('td', { class: 'n', text: m.delta === null || m.delta === undefined ? '' : signed(m.delta) })
      ]);
    });
    return section(S.sections.measures, false, [el('div', { class: 'scroll' }, [el('table', { class: 'grid' }, [head].concat(rows))])]);
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
    // The last review and the need were measured before the record was
    // written: when it reviews the axis itself, they are the ones before it.
    var own = f.axis.this_review || null;
    var review = !f.axis.last_review_known ? (own ? S.footnotes.previousReviewUnknown : S.footnotes.reviewUnknown)
      : last === null ? (own ? S.footnotes.noPreviousReview : S.footnotes.noReview)
      : last.from === 'record' ? fill(own ? S.footnotes.previousReviewFromRecord : S.footnotes.lastReviewFromRecord, { date: last.date, model: last.model, record: last.record || '' })
      : fill(own ? S.footnotes.previousReview : S.footnotes.lastReview, { date: last.date, model: last.model });
    var answer = f.axis.review_needed === true ? S.footnotes.reviewNeededYes
      : f.axis.review_needed === false ? S.footnotes.reviewNeededNo : S.footnotes.reviewNeededUnknown;
    items.push(el('li', { text: fill(S.footnotes.axis, { version: f.axis.version }) + '  /  ' + review + '  /  ' + fill(own ? S.footnotes.reviewNeededBefore : S.footnotes.reviewNeeded, { answer: answer }) }));
    if (own) {
      items.push(el('li', null, [
        el('span', { text: fill(S.footnotes.thisReview, { triggers: own.triggers.join(', ') }) }),
        prose(own.summary, 'span'),
        reported()
      ]));
    }
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
      // With no board or no record yet, draw what basou measures now instead.
      if (page.why === 'no_board' || page.why === 'no_records') {
        loadLive(page.why);
        return;
      }
      setStatus(fill(messages[page.why] || page.why, { record: page.id || '', version: page.version }), true);
      return;
    }
    setStatus('', false);
    var b = page.board;
    // The board's own title, so that boards open in other tabs can be told apart.
    document.title = b.heading.title;
    // Where each lane stops, right under the summary's tiles, and the lanes,
    // before the observations and the charts of the effort.
    [heading(b), summary(b), matrix(b), lanes(b), observations(b), effort(b, false), measures(b), composition(b),
      turns(b), recordRepos(b), recordComponents(b), footnotes(b)]
      .forEach(function (node) { root.appendChild(node); });
  }

  // The board measured now: the sections basou measures with nothing declared
  // or judged. why is the reason there was no record to draw, or null when
  // asked for with ?live=1.
  function liveTile(k, v, sub) {
    return el('div', { class: 'tile' }, [
      el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }),
      sub ? el('div', { class: 's', text: sub }) : null
    ]);
  }
  function liveHeading(l, why) {
    var h = l.heading;
    var measured = h.complete ? S.heading.complete : fill(S.heading.incomplete, { n: h.not_found });
    var again = el('button', { type: 'button', text: S.live.remeasure, onclick: function () { loadLive(why); } });
    return el('header', null, [
      el('h1', { text: h.title }),
      el('div', { class: 'stamp' }, [fill(S.live.measuredAt, { at: when(h.measured_at) }) + '  /  ' + measured + '  ', again])
    ]);
  }
  // Whether the measurement says why the value at a place was not measured.
  function missingIn(l) {
    return function (at) { return l.footnotes.not_found.some(function (n) { return n.at === at; }); };
  }
  // The repositories as a table. older: a record of version 1 or 2, which
  // measured no base, ahead or fetch time (drawn as '-') and held the
  // commits behind as behind_main.
  function reposTable(list, missing, older) {
    var labels = [S.live.repo, S.live.branch, S.live.head, S.live.lastCommit, S.live.commits, S.live.files, S.live.uncommitted, S.live.base, S.live.behind, S.live.ahead, S.live.fetchedAt];
    var numeric = [4, 5, 6, 8, 9];
    var head = el('tr', null, labels.map(function (label, i) { return el('th', { class: numeric.indexOf(i) !== -1 ? 'n' : '', text: label }); }));
    var rows = list.map(function (r) {
      var at = 'repos[' + r.path + ']';
      // A null the measurement says it could not measure, or one that means
      // so (a detached HEAD, no commit yet, no base, no fetch of it on
      // record), drawn as '-'.
      var value = function (field, v, show) {
        if (v !== null) return show(v);
        return missing(at) || missing(at + '.' + field) ? S.tiles.notMeasured : '-';
      };
      var unmeasured = function (field, v, show) { return older ? '-' : value(field, v, show); };
      return el('tr', null, [
        el('td', { text: r.name === null ? r.path : r.name }),
        el('td', { text: value('branch', r.branch, String) }),
        el('td', { text: value('head', r.head, function (h) { return h.slice(0, 7); }) }),
        el('td', { text: value('last_commit', r.last_commit, when) }),
        el('td', { class: 'n', text: num(r.commits) }),
        el('td', { class: 'n', text: num(r.files) }),
        el('td', { class: 'n', text: num(r.uncommitted) }),
        el('td', { text: unmeasured('base', r.base, String) }),
        el('td', { class: 'n', text: value(older ? 'behind_main' : 'behind', r.behind, num) }),
        el('td', { class: 'n', text: unmeasured('ahead', r.ahead, num) }),
        el('td', { text: unmeasured('fetched_at', r.fetched_at, when) })
      ]);
    });
    return el('div', { class: 'scroll' }, [el('table', { class: 'grid' }, [head].concat(rows))]);
  }
  function liveRepos(l) {
    return section(S.live.repos, false, [reposTable(l.repos, missingIn(l), false)]);
  }
  // The repositories as the record measured them, by its version.
  function recordRepos(b) {
    var r = b.repos;
    if (!r) return section(S.live.repos, false, [el('p', { class: 'muted', text: S.record.reposUnread })]);
    var children = [reposTable(r.list, missingIn(b), !r.base_measured)];
    if (!r.base_measured) children.push(el('p', { class: 'muted', text: fill(S.record.notMeasuredByVersion, { version: r.record_version }) }));
    return section(S.live.repos, false, children);
  }
  // The components the record found, by the lanes its registry counts them
  // in, then those in no lane (folded), those not registered, and those gone.
  function recordComponents(b) {
    var c = b.components;
    if (!c) return section(S.live.components, false, [el('p', { class: 'muted', text: S.record.componentsUnread })]);
    if (!c.measured) {
      return section(S.live.components, false, [
        el('p', { class: 'muted', text: S.record.componentsNotMeasured }),
        el('ul', null, c.reasons.map(function (reason) { return el('li', { text: reason }); }))
      ]);
    }
    var item = function (x) {
      var kinds = x.kinds === null ? S.record.notFound : x.kinds.join(', ');
      var parts = [el('code', { text: x.key }), el('span', { class: 'muted', text: '  ' + kinds })];
      if (x.kind_changed) {
        parts.push(el('span', { class: 'chip changed', text: fill(S.record.kindChanged, { before: x.kind_changed.before.join(', ') }) }));
      }
      if (x.note) parts.push(el('div', { class: 'sub', text: x.note }));
      return el('li', { 'data-component': x.key }, parts);
    };
    var group = function (title, list, empty) {
      return [el('h3', { text: title }), list.length === 0 ? el('p', { class: 'muted', text: empty }) : el('ul', null, list.map(item))];
    };
    var children = [];
    c.lanes.forEach(function (lane) {
      children = children.concat(group(lane.name, lane.components, S.record.noComponentInLane));
    });
    // Those in no lane can be most of them: folded under how many they are.
    if (c.uncounted.length > 0) {
      children.push(el('details', null, [
        el('summary', { text: fill(S.record.uncountedFolded, { n: num(c.uncounted.length) }) }),
        el('ul', null, c.uncounted.map(item))
      ]));
    } else {
      children = children.concat(group(S.record.uncounted, c.uncounted, S.record.none));
    }
    children = children.concat(group(S.record.unacknowledged, c.unacknowledged, S.record.none));
    children.push(el('h3', { text: S.record.gone }));
    children.push(c.gone === null ? el('p', { class: 'muted', text: S.record.goneUnknown })
      : c.gone.length === 0 ? el('p', { class: 'muted', text: S.record.none })
      : el('ul', null, c.gone.map(function (key) { return el('li', null, [el('code', { text: key })]); })));
    return section(S.live.components, false, children);
  }
  function liveTrail(l) {
    var t = l.trail;
    var i = l.integrity;
    var f = l.freshness;
    var missing = missingIn(l);
    var newest = f.newest_session_at !== null ? when(f.newest_session_at)
      : missing('freshness.newest_session_at') ? S.tiles.notMeasured : S.live.noSession;
    var unimported = f.unimported === null ? S.live.unimportedNotMeasured : fill(S.live.unimported, {
      new: f.unimported.new, updated: f.unimported.updated, unverifiable: f.unimported.unverifiable
    });
    var counts = function (byKey) {
      if (byKey === null) return S.tiles.notMeasured;
      return Object.keys(byKey).map(function (k) { return k + ' ' + num(byKey[k]); }).join('  /  ');
    };
    var tiles = el('div', { class: 'tiles' }, [
      liveTile(S.live.decisions, num(t.decisions_live), t.decisions_all === null ? null : fill(S.live.decisionsAll, { n: num(t.decisions_all) })),
      liveTile(S.tiles.openTracks, t.tracks_open === null ? S.tiles.notMeasured : num(t.tracks_open.length), null),
      liveTile(S.tiles.sessions, num(i.sessions), i.not_verified === null ? null : fill(S.tiles.sessionsNotVerified, { n: num(i.not_verified) })),
      liveTile(S.live.reviewGaps, num(l.review_gaps.gaps), null),
      liveTile(S.live.newestSession, newest, unimported)
    ]);
    var tracks = t.tracks_open === null ? el('p', { class: 'muted', text: S.tiles.notMeasured })
      : t.tracks_open.length === 0 ? el('p', { class: 'muted', text: S.live.noTracks })
      : el('ul', null, t.tracks_open.map(function (tr) {
          return el('li', null, [el('span', { class: 'muted', text: tr.id + '  ' }), tr.title]);
        }));
    var breakdown = el('div', { class: 'muted' }, [
      el('div', { text: fill(S.live.byStatus, { list: counts(i.by_status) }) }),
      el('div', { text: fill(S.live.byVerdict, { list: counts(l.review_gaps.by_verdict) }) })
    ]);
    return section(S.live.trail, false, [tiles, breakdown, el('h3', { text: S.live.tracks }), tracks]);
  }
  function liveComponents(l) {
    var c = l.components;
    var body = c === null ? el('p', { class: 'muted', text: S.tiles.notMeasured })
      : c.length === 0 ? el('p', { class: 'muted', text: S.live.noComponents })
      : el('ul', null, c.map(function (x) {
          return el('li', null, [el('code', { text: x.key }), el('span', { class: 'muted', text: '  ' + x.kinds.join(', ') })]);
        }));
    return section(S.live.components, false, [body]);
  }
  function liveFootnotes(l, why) {
    var f = l.footnotes;
    var items = [el('li', { text: S.live.note }), el('li', { text: S.live.judged })];
    if (why === 'no_board') items.push(el('li', { text: S.unavailable.noBoard }));
    if (f.not_found.length > 0) {
      items.push(el('li', null, [el('b', { text: S.footnotes.notMeasured }), el('ul', null, f.not_found.map(function (n) {
        return el('li', { text: n.at + ': ' + n.reason });
      }))]));
    }
    var build = f.measured_with.build === null ? '' : ' (' + f.measured_with.build + ')';
    items.push(el('li', { text: fill(S.footnotes.measuredWith, { basou: f.measured_with.basou, build: build }) }));
    return section(S.sections.footnotes, false, [el('ul', { class: 'foot' }, items)]);
  }
  var liveDrawn = 0;
  function drawLive(d, why) {
    S = d.strings;
    lang = d.language;
    document.documentElement.lang = lang;
    // As the heading names it, so that boards open in other tabs can be told apart.
    document.title = d.live.heading.title;
    var drawn = ++liveDrawn;
    var nav = $('records');
    clear(nav);
    // Asked for with ?live=1: lead back to the records, when there are any.
    if (why === null) {
      getJson('/api/board').then(function (b) {
        var list = b && b.page && b.page.records ? b.page.records : [];
        if (drawn === liveDrawn && list.length > 0) nav.appendChild(el('a', { href: '/board', text: S.live.toRecords }));
      }).catch(function () {});
    }
    var root = $('board');
    clear(root);
    setStatus('', false);
    var l = d.live;
    [liveHeading(l, why), effort(l, true), liveRepos(l), liveTrail(l), liveComponents(l), liveFootnotes(l, why)]
      .forEach(function (node) { root.appendChild(node); });
  }

  function getJson(url) {
    return fetch(url).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body && body.error ? body.error : String(res.status));
        return body;
      });
    });
  }
  function failed(err) { setStatus(S ? fill(S.loadFailed, { message: err.message }) : String(err.message), true); }
  // Measuring takes seconds, so the page says so until it is done.
  function loadLive(why) {
    setStatus(S ? S.live.measuring : '...', false);
    getJson('/api/board/live').then(function (d) { drawLive(d, why); }).catch(failed);
  }

  var params = new URLSearchParams(location.search);
  var record = params.get('record');
  if (params.get('live') !== null) {
    loadLive(null);
  } else {
    setStatus('...', false);
    getJson('/api/board' + (record ? '/' + encodeURIComponent(record) : '')).then(draw).catch(failed);
  }
})();
</script>
</body>
</html>
`;
