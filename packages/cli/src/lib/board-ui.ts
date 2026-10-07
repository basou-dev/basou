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
  .bar { height: 10px; background: var(--fill); border-radius: 5px; min-width: 120px; position: relative; overflow: hidden; }
  .bar span { position: absolute; left: 0; top: 0; bottom: 0; background: var(--s1); }
  figure { margin: 16px 0; }
  figcaption { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
  svg.chart { display: block; width: 100%; min-width: 560px; height: auto; overflow: visible; }
  svg.chart text { fill: var(--fg-2); font-size: 11px; }
  svg.chart .grid { stroke: var(--grid); stroke-width: 1; }
  svg.chart .axis { stroke: var(--border); stroke-width: 1; }
  svg.chart .claude { fill: var(--s1); }
  svg.chart .codex { fill: var(--s2); }
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
  // A label beside a mark: to the left of it in the right part of a chart, so it is not cut off.
  function sideLabel(x, y, text, middle) {
    var right = x > CHART.w * 0.7;
    return svg('text', {
      class: 'ms-label', x: middle ? x : right ? x - 4 : x + 4, y: y,
      'text-anchor': middle && !right ? 'middle' : right ? 'end' : 'start', text: text
    });
  }
  function dayIndex(days, date) {
    for (var i = 0; i < days.length; i++) if (days[i].date === date) return i;
    return -1;
  }

  // Milestones on a line from the first day to the last.
  function timelineChart(days, milestones) {
    var h = 86;
    var mid = 46;
    var nodes = [svg('line', { class: 'axis', x1: CHART.left, x2: CHART.w - CHART.right, y1: mid, y2: mid })];
    monthTicks(days).forEach(function (t) {
      var x = dayX(t.i, days.length);
      nodes.push(svg('line', { class: 'grid', x1: x, x2: x, y1: mid - 4, y2: mid + 4 }));
    });
    nodes.push(svg('circle', { class: 'start', cx: dayX(0, days.length), cy: mid, r: 5 }, [
      svg('title', { text: days[0].date })
    ]));
    var placed = 0;
    milestones.forEach(function (m) {
      var i = dayIndex(days, m.date);
      if (i === -1) return;
      var x = dayX(i, days.length);
      var above = placed % 2 === 0;
      placed++;
      nodes.push(svg('circle', { class: 'dot', cx: x, cy: mid, r: 5 }, [
        svg('title', { text: m.date + '  ' + m.label + '  ' + m.ref })
      ]));
      nodes.push(sideLabel(x, above ? mid - 12 : mid + 22, m.label, true));
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
      var xh = hours(d.codex_only) * scale;
      var gap = ch > 0 && xh > 0 && band > 4 ? 2 : 0;
      if (ch > 0) nodes.push(svg('rect', { class: 'claude', x: x, y: base - ch, width: width, height: ch }));
      if (xh > 0) nodes.push(svg('rect', { class: 'codex', x: x, y: base - ch - gap - xh, width: width, height: xh }));
      nodes.push(svg('rect', { class: 'hit', x: CHART.left + i * band, y: top, width: band, height: base - top }, [
        svg('title', { text: fill(S.effort.dayDetail, {
          date: d.date, active: hm(d.union), claude: hm(d.claude), codex: hm(d.codex_only), commits: num(d.commits)
        }) })
      ]));
    });
    nodes = nodes.concat(xAxis(days, base));
    var legend = el('div', { class: 'legend' }, [
      el('span', null, [el('span', { class: 'swatch s1' }), S.effort.claude]),
      el('span', null, [el('span', { class: 'swatch s2' }), S.effort.codexAlone])
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
    var placed = 0;
    milestones.forEach(function (m) {
      var i = dayIndex(days, m.date);
      if (i === -1) return;
      var x = dayX(i, days.length);
      nodes.push(svg('line', { class: 'ms', x1: x, x2: x, y1: top, y2: base }));
      nodes.push(sideLabel(x, top + 10 + (placed % 3) * 13, m.label, false));
      placed++;
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

  function weeksTable(weeks) {
    var head = el('tr', null, [
      el('th', { text: S.effort.week }), el('th', { class: 'n', text: S.effort.active }),
      el('th', { class: 'n', text: S.effort.claude }), el('th', { class: 'n', text: S.effort.codex }),
      el('th', { class: 'n', text: S.effort.activeDays }), el('th', { class: 'n', text: S.effort.commitColumn })
    ]);
    var rows = weeks.map(function (w) {
      return el('tr', null, [
        el('td', { text: fill(S.effort.weekOf, { date: w.week }) }), el('td', { class: 'n', text: hm(w.union) }),
        el('td', { class: 'n', text: hm(w.claude) }), el('td', { class: 'n', text: hm(w.codex) }),
        el('td', { class: 'n', text: num(w.active_days) }), el('td', { class: 'n', text: num(w.commits) })
      ]);
    });
    return el('figure', null, [
      el('figcaption', { text: S.effort.weeksTitle }),
      el('div', { class: 'scroll' }, [el('table', { class: 'grid' }, [head].concat(rows))])
    ]);
  }

  function effort(b) {
    var e = b.effort;
    var tile = function (k, v, sub) {
      return el('div', { class: 'tile' }, [
        el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }),
        sub ? el('div', { class: 's', text: sub }) : null
      ]);
    };
    var union = e.active_ms.union;
    var perDay = union === null || !e.elapsed_days ? null : union / e.elapsed_days;
    var perWorked = union === null || !e.active_days ? null : union / e.active_days;
    var tokens = e.sessions_without_tokens ? fill(S.effort.withoutTokens, { n: e.sessions_without_tokens }) : null;
    var tiles = el('div', { class: 'tiles' }, [
      tile(S.effort.elapsed, e.elapsed_days === null ? S.effort.notMeasured : fill(S.effort.days, { days: e.elapsed_days }),
        e.time_zone === null ? fill(S.effort.from, { date: e.start }) : fill(S.effort.fromZone, { date: e.start, zone: e.time_zone })),
      tile(S.effort.active, hm(union), e.active_days === null ? null : fill(S.effort.daysWorked, { n: e.active_days })),
      tile(S.effort.claude, hm(e.active_ms.claude), null),
      tile(S.effort.codex, e.active_ms.codex === null && union !== null ? S.effort.noCodex : hm(e.active_ms.codex), null),
      tile(S.effort.perDay, hm(perDay), perWorked === null ? null : fill(S.effort.perDayWorked, { time: hm(perWorked) })),
      tile(S.effort.outputTokens, num(e.output_tokens), tokens)
    ]);
    var commits = e.commits === null ? S.effort.notMeasured : e.commits.map(function (c) {
      return c.repo + ' ' + num(c.count);
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
    children.push(e.milestones.length === 0
      ? el('p', { class: 'muted', text: S.effort.noMilestones })
      : el('ul', null, e.milestones.map(function (m) {
          return el('li', null, [m.date + '  ', el('b', { text: m.label }), el('span', { class: 'muted', text: '  ' + m.ref })]);
        })));
    if (e.weeks && e.weeks.length > 0) children.push(weeksTable(e.weeks));
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
