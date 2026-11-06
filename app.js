/* L-CINEMA — interface. Talks to the Android side through window.Android. */
(function () {
  'use strict';
  // older TV browsers: Element.closest / matches
  if (window.Element && !Element.prototype.matches) Element.prototype.matches = Element.prototype.webkitMatchesSelector || Element.prototype.msMatchesSelector;
  // old TV browsers lay out flexbox without "gap": mark them so the stylesheet adds spacing with margins instead
  (function () {
    try {
      var f = document.createElement('div'); f.style.display = 'flex'; f.style.flexDirection = 'column'; f.style.rowGap = '1px';
      f.appendChild(document.createElement('div')); f.appendChild(document.createElement('div'));
      document.documentElement.appendChild(f); var ok = f.scrollHeight === 1; f.parentNode.removeChild(f);
      if (!ok) document.documentElement.className += ' nogap';
    } catch (e) {}
  })();
  // very old TV browsers ignore CSS variables (colours fall back to black): rewrite the stylesheet with real values
  (function () {
    var ok = false;
    try { ok = !!(window.CSS && CSS.supports && CSS.supports('--a', '0')); } catch (e) {}
    if (ok) return;
    document.documentElement.className += ' novars';
    try {
      var x = new XMLHttpRequest(); x.open('GET', 'style.css', false); x.send();
      var css = x.responseText; if (!css) return;
      var vars = {}, m, re = /--([\w-]+)\s*:\s*([^;}]+)/g;
      var rootBlock = css.match(/:root\s*\{([^}]*)\}/);
      if (rootBlock) while ((m = re.exec(rootBlock[1]))) vars[m[1]] = m[2].trim();
      for (var k = 0; k < 3; k++) css = css.replace(/var\(--([\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, function (all, n, fb) { return vars[n] || (fb ? fb.trim() : 'inherit'); });
      var st = document.createElement('style'); st.appendChild(document.createTextNode(css)); document.head.appendChild(st);
      // only the rewritten copy stays on: two full stylesheets make every redraw twice as slow on these TVs
      var ls = document.querySelectorAll('link[rel="stylesheet"]');
      for (var li = 0; li < ls.length; li++) if (/style\.css/.test(ls[li].getAttribute('href') || '')) ls[li].disabled = true;
    } catch (e) {}
  })();
  if (window.Element && !Element.prototype.closest) Element.prototype.closest = function (sel) { var el = this; while (el && el.nodeType === 1) { if (el.matches(sel)) return el; el = el.parentElement; } return null; };

  // a small health report for Claude (TV only): errors, how long things take, what pictures loaded
  var DIAG = { errs: [], tState: [], tRender: [] };
  window.addEventListener('error', function (e) { if (DIAG.errs.length < 20) DIAG.errs.push(String(e.message || e) + ' @' + (e.lineno || '') + ':' + (e.colno || '')); });

  var A = window.Android;
  var root = document.getElementById('app');

  var S = { films: [] };          // state from Android
  var lastShape = '';
  var view = { name: 'home' };    // current screen
  // the iPhone page: the screen lives in the address (#…), so pulling down to reload stays on the same screen
  var WEB_URL = /^https?:/.test(location.protocol);
  var restoreScroll = null;
  if (WEB_URL) {
    try {
      var h0 = decodeURIComponent(location.hash.slice(1));
      if (h0) { var v0 = JSON.parse(h0); if (v0 && typeof v0.name === 'string') view = v0; }
      var sc0 = JSON.parse(sessionStorage.getItem('lcScroll') || 'null');
      if (sc0 && sc0.h === location.hash) restoreScroll = sc0.y;
    } catch (e) { view = { name: 'home' }; }
    window.addEventListener('pagehide', function () {
      try { var m = document.getElementById('main'); sessionStorage.setItem('lcScroll', JSON.stringify({ h: location.hash, y: m ? m.scrollTop : 0 })); } catch (e) {}
    });
  }
  function saveViewUrl() {
    if (!WEB_URL) return;
    try {
      var v = {}; for (var k in view) if (typeof view[k] !== 'object' && typeof view[k] !== 'function') v[k] = view[k];
      var hh = view.name === 'home' ? '' : '#' + encodeURIComponent(JSON.stringify(v));
      if (hh !== location.hash && !(hh === '' && !location.hash)) history.replaceState(null, '', location.pathname + location.search + hh);
    } catch (e) {}
  }
  var stack = [];                 // back history
  var confirmKey = null;          // "press again to delete"
  var full = -1;                  // index of the screensaver open on the whole screen

  var MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  var PALETTE = ['#3A2A3A', '#46344A', '#4A2442', '#233040', '#2A3458', '#283050', '#3A2234', '#2C2A40', '#342636', '#22284A'];

  // ---------- helpers ----------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // one wide picture per film for this launch: a different one of its set each time the app is opened
  function pickBd(f) {
    var l = f.backdrops && f.backdrops.length ? f.backdrops : null;
    if (!l) return f.backdrop || '';
    return l[hash(f.id + '|' + SEED) % l.length];
  }
  function hash(s) { var h = 0; s = String(s); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
  function color(f) { return PALETTE[hash(f.id || f.title) % PALETTE.length]; }
  function isSeries(f) { return f.type === 'series' && f.episodes && f.episodes.length > 0; }
  function eps(f) { return isSeries(f) ? f.episodes : []; }
  /** One shelf per film: cartoons live only in «Мультфильмы», everything else only in its main genre. */
  function genresOf(f) {
    if (isSeries(f)) return ['Сериалы'];
    var g = f.genres || [];
    if (!g.length) return [];
    if (g.indexOf('Мультфильмы') >= 0) return ['Мультфильмы'];
    return [g[0]];
  }
  function watched(f) { return f.status === 'watched'; }
  var CYR = /[А-Яа-яЁё]/;
  function isRu(f) {
    if (f.lang) return f.lang === 'ru';
    if (f.original && !CYR.test(f.original)) return false;
    return CYR.test(f.title || '') && !f.original;
  }
  function isCartoon(f) { return (f.genres || []).indexOf('Мультфильмы') >= 0; }
  // «Мультсериалы» is a shelf inside «Сериалы»; the other chips are about the country
  function originOk(f, o) { return !o || o === 'all' || (o === 'cartoon' ? isCartoon(f) : o === 'ru' ? isRu(f) : !isRu(f)); }
  function isWant(f) { return f.status === 'want'; }
  function isNew(f) { return !watched(f) && !isWant(f); }
  function byId(id) { for (var i = 0; i < S.films.length; i++) if (S.films[i].id === id) return S.films[i]; return null; }

  function clock(ms) {
    var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return h > 0 ? h + ':' + p(m) + ':' + p(x) : m + ':' + p(x);
  }
  function dateRu(iso) {
    if (!iso) return '';
    var p = String(iso).slice(0, 10).split('-');
    if (p.length < 3) return iso;
    return parseInt(p[2], 10) + ' ' + MONTHS[parseInt(p[1], 10) - 1] + ' ' + p[0];
  }
  function gb(bytes) { return (bytes / 1073741824).toFixed(1).replace('.', ',') + ' ГБ'; }
  function starsText(r) {
    if (!r) return '';
    return '★★★★★'.slice(0, Math.floor(r)) + (r % 1 ? '½' : '');
  }
  function rnum(r) { return r ? String(r).replace('.', ',') : '—'; }
  function epLabel(ep) { return 'С' + (ep.season || 1) + ' Э' + (ep.episode || 1); }
  function pct(dl) { return dl && dl.total > 0 ? Math.min(100, Math.round(dl.done / dl.total * 100)) : 0; }

  function filmMeta(f) {
    var parts = [];
    if (f.year) parts.push(f.year);
    if (genresOf(f).length) parts.push(genresOf(f).join(', ').toLowerCase());
    if (isSeries(f)) parts.push(eps(f).length + ' сер.');
    else if (f.duration) parts.push(f.duration);
    if (f.director) parts.push('реж. ' + f.director);
    return parts.join(' · ');
  }

  /** Where to continue: { key, pos, label, active } */
  function resume(f) {
    if (!isSeries(f)) {
      // a watched film, or one stopped during the end credits, is not «in progress»
      var nearEnd = f.dur > 5 * 60000 && f.pos > f.dur * 0.92;
      var active = f.pos > 5000 && !f.watchedPart && !nearEnd && !watched(f);
      return { key: f.key, pos: active ? f.pos : 0, active: active, label: active ? 'Продолжить с ' + clock(f.pos) : (watched(f) ? 'Смотреть ещё раз' : 'Смотреть') };
    }
    var list = eps(f), idx = -1;
    for (var i = 0; i < list.length; i++) if (list[i].key === f.last) idx = i;
    if (idx < 0) return { key: list[0].key, pos: 0, active: false, label: 'Смотреть с 1 серии' };
    var ep = list[idx];
    if (ep.watchedPart && idx + 1 < list.length) {
      var nx = list[idx + 1];
      return { key: nx.key, pos: 0, active: true, label: 'Следующая: ' + epLabel(nx) };
    }
    if (ep.watchedPart) return { key: list[0].key, pos: 0, active: false, label: 'Пересмотреть с начала' };
    return { key: ep.key, pos: ep.pos, active: true, label: 'Продолжить ' + epLabel(ep) + (ep.pos > 5000 ? ' · ' + clock(ep.pos) : '') };
  }

  function progressFraction(f) {
    if (!isSeries(f)) return f.dur > 0 ? f.pos / f.dur : 0;
    var r = resume(f);
    var list = eps(f), done = 0;
    for (var i = 0; i < list.length; i++) if (list[i].watchedPart) done++;
    return list.length ? Math.max(done / list.length, r.active ? 0.02 : 0) : 0;
  }

  /** Download summary for a film or a whole series. */
  function dlSummary(f) {
    var items = isSeries(f) ? eps(f) : [f];
    var res = { done: 0, running: 0, failed: 0, none: 0, count: items.length, bytesDone: 0, bytesTotal: 0, key: items[0] && items[0].key };
    for (var i = 0; i < items.length; i++) {
      var d = items[i].dl || { status: 'none' };
      if (d.status === 'done') res.done++;
      else if (d.status === 'running' || d.status === 'paused') { res.running++; res.bytesDone += d.done || 0; res.bytesTotal += d.total || 0; }
      else if (d.status === 'failed') res.failed++;
      else res.none++;
    }
    return res;
  }

  // ---------- icons ----------

  var I = {
    share: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>',
    close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    heartO: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.5 4.5 7 4.5c2 0 3.4 1.1 5 3 1.6-1.9 3-3 5-3 3.5 0 5.6 3.5 4.3 6.8-1.8 4.6-9.3 9.2-9.3 9.2z"/></svg>',
    heartOn: '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.5 4.5 7 4.5c2 0 3.4 1.1 5 3 1.6-1.9 3-3 5-3 3.5 0 5.6 3.5 4.3 6.8-1.8 4.6-9.3 9.2-9.3 9.2z"/></svg>',
    plus: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    check: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    trash: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
    pen: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg>',
    chev: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
    phones: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>',
    repeat: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/><path d="M11 10.5l1.5-1v5" stroke-width="1.8"/></svg>',
    note: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>',
    shuffle: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>',
    book: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14v-2a9 9 0 0 1 18 0v2"/><rect x="2.5" y="14" width="5" height="7" rx="2"/><rect x="16.5" y="14" width="5" height="7" rx="2"/></svg>',
    pause: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4.5" height="16" rx="1.4"/><rect x="13.5" y="4" width="4.5" height="16" rx="1.4"/></svg>',
    prev: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg>',
    next: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg>',
    rew: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
    fwd: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
    moon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    tv: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="3"/><path d="M8 2l4 4 4-4"/></svg>',
    home: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
    grid: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    diary: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/></svg>',
    down: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/></svg>',
    saver: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8"/><path d="M7 13h2v-2h2V9h2v2h2v2h2"/></svg>',
    sync: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 0 0-14.5-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16"/><path d="M20 20v-4h-4"/></svg>',
    play: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4l13 8-13 8z"/></svg>',
    back: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
    heart: function (on) {
      return '<svg width="24" height="24" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="' +
        (on ? 'fill:#FF4FD8;stroke:#FF4FD8' : 'fill:none;stroke:#C6BCD6') + '"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>';
    },
    star: function (fill) {
      return '<svg width="40" height="40" viewBox="0 0 24 24"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z" fill="' + fill + '"/></svg>';
    }
  };

  // ---------- pieces ----------

  // TVs and the projector (1 GB, the browser shares the app's memory on old Android): posters load only near the
  // screen and are let go far away from it, so scrolling a long library doesn't run the memory out
  function lazyOn() { return !S.platform; } // Android only; the Mac and the phone have memory to spare
  function psrc(u) { return (lazyOn() ? 'data-src="' : 'src="') + esc(u) + '"'; }
  var BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  var lzT = null;
  function lazySoon() { if (!lazyOn()) return; clearTimeout(lzT); lzT = setTimeout(lazyPass, 120); }
  function lazyPass() {
    var vh = window.innerHeight || 720, vw = window.innerWidth || 1280;
    var im = document.querySelectorAll('img[data-src], img[data-lz]');
    for (var i = 0; i < im.length; i++) {
      var el = im[i], r = el.getBoundingClientRect();
      if (!r.width && !r.height && !el.getAttribute('data-src')) continue;
      var near = r.bottom > -vh * 0.8 && r.top < vh * 1.8 && r.right > -vw * 0.5 && r.left < vw * 1.6;
      var far = r.bottom < -vh * 2.5 || r.top > vh * 3.5 || r.right < -vw * 2 || r.left > vw * 3;
      if (near && el.getAttribute('data-src')) { el.src = el.getAttribute('data-src'); el.setAttribute('data-lz', el.getAttribute('data-src')); el.removeAttribute('data-src'); }
      else if (far && el.getAttribute('data-lz') && !el.getAttribute('data-src')) { el.setAttribute('data-src', el.getAttribute('data-lz')); el.src = BLANK; }
    }
  }
  document.addEventListener('scroll', lazySoon, true); window.addEventListener('resize', lazySoon);

  function posterInner(f) {
    // the title is printed on the plate only when there is no picture (or it fails to load)
    if (!f.poster) return '<span class="ph">' + esc(f.title) + '</span>';
    return '<img ' + psrc(f.poster) + ' alt="" onerror="this.nextSibling.style.display=&quot;block&quot;;this.remove()"><span class="ph" style="display:none">' + esc(f.title) + '</span>';
  }

  function card(f, row) {
    var r = resume(f), d = dlSummary(f);
    var over = '';
    if (d.running > 0) {
      var p = d.bytesTotal > 0 ? Math.round(d.bytesDone / d.bytesTotal * 100) : 0;
      over = '<div class="overlay"><span data-prog="' + esc(d.key) + '">Скачивается ' + p + '%</span><div class="bar cy"><i data-bar="' + esc(d.key) + '" style="width:' + p + '%"></i></div></div>';
    } else if (r.active) {
      var fr = Math.round(progressFraction(f) * 100);
      over = '<div class="overlay"><span>' + esc(isSeries(f) ? r.label.replace('Продолжить ', '') : clock(f.pos)) + '</span><div class="bar"><i style="width:' + fr + '%"></i></div></div>';
    }
    var sub = watched(f) && f.rating ? '<span class="stars-t">' + starsText(f.rating) + '</span>' + (f.liked ? ' <span style="color:#FF4FD8">♥</span>' : '')
      : (watched(f) ? 'посмотрела' : '<span class="want-t">' + (isWant(f) ? 'хочу' : (isSeries(f) ? 'сериал' : 'новое')) + '</span>' + (f.year ? ' · ' + f.year : ''));
    return '<div class="card' + (r.active ? ' resume' : '') + '" data-f tabindex="0" data-key="c-' + esc(row) + '-' + esc(f.id) + '" data-act="film:' + esc(f.id) + '">' +
      '<div class="poster" style="background:' + color(f) + '">' + (over ? (f.poster ? '<img ' + psrc(f.poster) + ' alt="" onerror="this.remove()">' : '') : posterInner(f)) + over + '</div>' +
      '<div class="ct">' + esc(f.title) + '</div><div class="cm">' + sub + '</div></div>';
  }

  function row(id, title, sub, films) {
    if (!films.length) return '';
    var cards = '';
    for (var i = 0; i < films.length; i++) cards += card(films[i], id);
    return '<section class="section"><div class="head"><h2 class="h2">' + esc(title) + '</h2>' + (sub ? '<span class="sub">' + esc(sub) + '</span>' : '') + '</div>' +
      '<div class="row" data-row="' + esc(id) + '">' + cards + '</div></section>';
  }

  function nav() {
    var items = [['home', 'Главная', I.home], ['genres', 'Жанры', I.grid], ['diary', 'Дневник', I.diary], ['music', 'Музыка', I.note], ['savers', 'Заставки', I.saver], ['downloads', 'Загрузки', I.down]];
    var h = '<nav class="nav glass"><div class="logo">L·C</div>';
    for (var i = 0; i < items.length; i++) {
      var on = view.name === items[i][0] || (view.name === 'film' && false);
      // audiobooks live inside «Музыка» as its second tab
      if (items[i][0] === 'music') on = on || view.name === 'books' || view.name === 'book' || view.name === 'author';
      h += '<button class="ni' + (on ? ' on' : '') + (items[i][0] === 'music' && ((MU && !MU.paused) || (AU && !AU.paused)) ? ' live' : '') + '" data-f data-key="nav-' + items[i][0] + '" data-act="go:' + items[i][0] + '" aria-label="' + items[i][1] + '">' + items[i][2] + '<span class="nl">' + items[i][1] + '</span></button>';
    }
    h += '<div class="spacer"></div><button class="ni sync' + (S.syncing ? ' spin' : '') + '" data-f data-key="nav-sync" data-act="sync" aria-label="Обновить">' + I.sync + '</button></nav>';
    return h;
  }

  function updateBanner() {
    if (!S.update) return '';
    return '<div class="upd glass"><span>Вышла новая версия L-CINEMA ' + esc(S.update) + '</span>' +
      '<button class="btn small pri" data-f data-key="upd" data-act="update">Обновить</button></div>';
  }

  function statusLine() {
    if (S.error) return '<span class="status err">' + esc(S.error) + '</span>';
    if (S.syncing) return '<span class="status">Обновляю библиотеку…</span>';
    if (S.syncedAt) return '<span class="status">Обновлено в ' + esc(String(S.syncedAt).slice(11, 16)) + (S.updErr ? ' · новая версия не скачалась: ' + esc(S.updErr) : '') + '</span>';
    return '';
  }

  function allGenres(withEmpty) {
    var seen = {}, out = [];
    if (withEmpty) { seen['Сериалы'] = 1; out.push('Сериалы'); }
    for (var i = 0; i < S.films.length; i++) {
      var g = genresOf(S.films[i]);
      for (var j = 0; j < g.length; j++) if (!seen[g[j]]) { seen[g[j]] = 1; out.push(g[j]); }
    }
    return out;
  }

  // ---------- Netflix films find their way into the Netflix shelf by themselves ----------
  // English Wikipedia names the distributor in the film's card; a Netflix film (or series) has Netflix first there.
  var NF = {};
  try { NF = JSON.parse(localStorage.getItem('nf1') || '{}') || {}; } catch (e) { NF = {}; }
  function nfKey(f) { return String(f.original || f.title || '') + '|' + (f.year || ''); }
  function isNetflix(f) { return NF[nfKey(f)] === 1; }
  var nfBusy = false, nfFound = false;
  function nfScan() {
    if (nfBusy || !window.fetch || !S.films) return;
    // Netflix makes films since 2015; Russian films aren't theirs
    var todo = S.films.filter(function (f) { return f.original && +f.year >= 2014 && f.lang !== 'ru' && !(nfKey(f) in NF); });
    if (!todo.length) return;
    nfBusy = true;
    var f = todo[0], series = isSeries(f);
    var u = 'https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrlimit=1&prop=revisions&rvprop=content&rvslots=main&rvsection=0&gsrsearch=' +
      encodeURIComponent(f.original + ' ' + f.year + (series ? ' TV series' : ' film'));
    fetch(u).then(function (r) { return r.json(); }).then(function (j) {
      var pages = j && j.query && j.query.pages, txt = '';
      for (var k in pages) { try { txt = pages[k].revisions[0].slots.main['*'] || ''; } catch (e) {} break; }
      var m = /\|\s*(?:distributor|network|channel)\s*=\s*([^\n]*(?:\n\s*\*[^\n]*)?)/i.exec(txt);
      var first = m ? m[1].replace(/\{\{\s*(?:plain ?list|ubl|unbulleted list)\s*\|/i, '').replace(/^[\s*|]+/, '') : '';
      var yes = /^\[\[\s*Netflix\s*[\]|]/i.test(first);
      NF[nfKey(f)] = yes ? 1 : 0;
      try { localStorage.setItem('nf1', JSON.stringify(NF)); } catch (e) {}
      if (yes) nfFound = true;
    }).catch(function () { NF[nfKey(f)] = 0; }).then(function () {
      nfBusy = false;
      // one question every few seconds, so the projector stays responsive
      setTimeout(nfScan, 3000);
      if (nfFound && (view.name === 'home' || view.name === 'coll')) { nfFound = false; render(null, true); }
    });
  }
  setTimeout(nfScan, 20000);
  setInterval(function () {
    if (!A || !A.beat || S.platform) return;
    var im = document.images, ld = 0; for (var i = 0; i < im.length; i++) if (im[i].complete && im[i].naturalWidth > 1) ld++;
    try { A.beat(view.name + ' imgs:' + ld + '/' + im.length + ' dom:' + document.getElementsByTagName('*').length); } catch (e) {}
  }, 4000);
  setTimeout(function () {
    if (!A || !A.report || S.platform) return;
    var im = document.images, ok = 0, bad = 0, wait = 0;
    for (var i = 0; i < im.length; i++) { if (!im[i].complete) wait++; else if (im[i].naturalWidth > 0) ok++; else bad++; }
    var badSrc = []; for (var j = 0; j < im.length && badSrc.length < 5; j++) if (im[j].complete && !im[j].naturalWidth) badSrc.push(String(im[j].src).slice(0, 90));
    try { A.report(JSON.stringify({ ua: navigator.userAgent, screen: innerWidth + 'x' + innerHeight + '@' + (window.devicePixelRatio || 1), novars: document.documentElement.className.indexOf('novars') >= 0,
      films: (S.films || []).length, imgsOk: ok, imgsBad: bad, imgsLoading: wait, badSrc: badSrc, errs: DIAG.errs, tState: DIAG.tState, tRender: DIAG.tRender, syncErr: S.error || '', syncedAt: S.syncedAt || '' })); } catch (e) {}
  }, 25000);

  function collFilms(c) {
    if (c.auto === 'liked') return S.films.filter(function (f) { return f.liked; });
    var out = [];
    (c.films || []).forEach(function (id) { var f = byId(id); if (f) out.push(f); });
    if (c.id === 'netflix') S.films.forEach(function (f) { if (isNetflix(f) && out.indexOf(f) < 0) out.push(f); });
    S.films.forEach(function (f) { if (f.collection === c.id && out.indexOf(f) < 0) out.push(f); });
    // films whose title or description mention the collection's words (Рождество, Санта…) join it by themselves
    if (c.exclude && c.exclude.length) out = out.filter(function (f) { return c.exclude.indexOf(f.id) < 0; });
    if (c.keywords && c.keywords.length) {
      var words = c.keywords.map(function (w) { return String(w).toLowerCase(); });
      S.films.forEach(function (f) {
        if (out.indexOf(f) >= 0 || (c.exclude && c.exclude.indexOf(f.id) >= 0)) return;
        var text = ((f.title || '') + ' ' + (f.original || '') + ' ' + (f.description || '')).toLowerCase();
        for (var i = 0; i < words.length; i++) if (text.indexOf(words[i]) >= 0) { out.push(f); return; }
      });
    }
    return out;
  }
  function collById(id) {
    var cs = S.collections || [];
    for (var i = 0; i < cs.length; i++) if (cs[i].id === id) return cs[i];
    return null;
  }

  function collTiles() {
    var cs = (S.collections || []).filter(function (c) { return !c.brand; });
    if (!cs.length) return '';
    var xm = cs.filter(function (c) { return c.theme === 'christmas'; })[0], rest = cs.filter(function (c) { return c !== xm; });
    var h = '<section class="section"><div class="head"><h2 class="h2">Подборки</h2></div><div class="cwrap">';
    if (xm) {
      var xn = collFilms(xm).length;
      // one wide tile: the Grinch over Whoville, «Christmas is coming», a puff of snow when pressed
      h += '<button class="xmtile" data-f data-key="coll-' + esc(xm.id) + '" data-act="xmas:' + esc(xm.id) + '"><img class="xmimg" src="stk/xmas-hill.jpg" alt=""><span class="xmsh"></span><div class="frost xmfrost"><img src="stk/frost.webp" alt=""></div>' +
        '<span class="xmtx"><span class="xmk">' + esc(xm.title) + (xn ? ' · ' + xn + ' ' + plural(xn, 'фильм', 'фильма', 'фильмов') : '') + '</span>' +
        '<span class="xmt">Christmas <br>is coming</span><span class="xmgo xmgo1">Смотреть подборку <i class="xmar">→</i></span></span><span class="xmgo xmgo2">Смотреть подборку <i class="xmar">→</i></span></button>';
    }
    if (rest.length) {
      h += '<div class="cmini">';
      rest.forEach(function (c) {
        var n = collFilms(c).length, ic = c.theme === 'halloween' ? '🎃' : (c.theme === 'love' ? '♥' : '✦');
        h += '<button class="cmtile th-' + esc(c.theme || 'default') + '" data-f data-key="coll-' + esc(c.id) + '" data-act="coll:' + esc(c.id) + '"><span class="cmic">' + ic + '</span>' +
          '<span class="cmtx"><span class="cmt">' + esc(c.title) + '</span><span class="cms">' + (n ? n + ' ' + plural(n, 'фильм', 'фильма', 'фильмов') : (c.auto === 'liked' ? 'ставь ♥' : 'скоро')) + '</span></span></button>';
      });
      h += '</div>';
    }
    return h + '</div></section>';
  }
  // pressing the Christmas tile: small snow flies out in every direction, then the collection opens
  function snowBurst(el, then) {
    try {
      var r = el.getBoundingClientRect(), wrap = document.createElement('div'), box = document.createElement('div'); wrap.className = 'snowwrap'; box.className = 'snowburst';
      box.style.left = (r.left + r.width / 2) + 'px'; box.style.top = (r.top + r.height / 2) + 'px'; wrap.appendChild(box);
      var n = document.documentElement.classList.contains('lite') ? 18 : 42, fl = [];
      for (var i = 0; i < n; i++) {
        var f = document.createElement('i'), sz = 3 + Math.random() * 7;
        f.style.width = f.style.height = sz.toFixed(1) + 'px';
        if (Math.random() < 0.35) f.className = 'fl';
        box.appendChild(f); fl.push(f);
      }
      document.body.appendChild(wrap);
      requestAnimationFrame(function () { requestAnimationFrame(function () {
        fl.forEach(function (f) {
          var ang = Math.random() * Math.PI * 2, d = (0.35 + Math.random() * 0.75) * Math.max(r.width, r.height) * 0.75;
          f.style.transform = 'translate(' + (Math.cos(ang) * d).toFixed(0) + 'px,' + (Math.sin(ang) * d * 0.8 + 30).toFixed(0) + 'px) rotate(' + (Math.random() * 360).toFixed(0) + 'deg)';
          f.style.opacity = '0';
        });
      }); });
      setTimeout(function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }, 1100);
    } catch (e) {}
    setTimeout(then, 380);
  }

  // decorative 3D stickers that pop out of a collection tile on hover / remote focus
  var STK = {
    halloween: [['pumpkin', 'a'], ['pumpkin', 'b']],
    christmas: [['mailbox', 'a'], ['snow', 'b'], ['snow', 'c']],
    love: [['heart', 'a'], ['heart', 'b'], ['heart', 'c']]
  };
  var PAGE_STK = { halloween: 'glitter', christmas: 'cane', love: 'heart' };
  function stkSrc(n) { return 'stk/' + n + '.webp'; }
  function stickers(theme) {
    var l = STK[theme] || [], h = '';
    for (var i = 0; i < l.length; i++) h += '<img class="stk stk-' + l[i][1] + '" src="' + stkSrc(l[i][0]) + '" alt="">';
    return h;
  }

  // two big tiles under the top panel: the Netflix shelf and YouTube (opens in Brave)
  function brandTiles() {
    var nf = collById('netflix'), list = nf ? collFilms(nf) : [];
    var fan = '';
    var withPoster = list.filter(function (f) { return f.poster; }).slice(0, 3);
    for (var k = 0; k < withPoster.length; k++) fan += '<img class="fan fan' + k + '" src="' + esc(withPoster[k].poster) + '" alt="" onerror="this.remove()">';
    var web = document.documentElement.classList.contains('web');
    return '<div class="btiles">' +
      (nf ? '<button class="btile b-nf" data-f data-key="b-nf" data-act="coll:netflix">' + fan +
        '<span class="btext"><span class="bname">Netflix</span><span class="bsub">' + (list.length ? (web ? '' : 'Фильмы студии · ') + list.length + ' шт.' : 'скоро') + '</span></span></button>' : '') +
      '<button class="btile b-yt" data-f data-key="b-yt" data-act="url:https://www.youtube.com">' +
        '<span class="bplay"><i></i></span><span class="btext"><span class="bname">YouTube</span><span class="bsub">' + (web ? 'Открыть сайт' : 'Открыть в Brave') + '</span></span></button>' +
      '<button class="btile b-tv" data-f data-key="b-tv" data-act="go:tv"><span class="tvglow"></span>' +
        '<span class="btext"><span class="bname">TV</span><span class="bsub">Live · СТС, ТНТ, Пятница</span></span></button>' +
      '</div>';
  }

  // a cobweb under Halloween things, a pine garland with lights under Christmas ones
  var DECO = { halloween: 'web', christmas: 'garland' };
  function decoHtml(theme) {
    // a pine garland with warm lights that twinkle in two groups
    if (theme === 'christmas') {
      // three overlapping links, so the garland stays slim on a wide screen (two on a phone)
      var g = '<div class="deco deco-gar">';
      for (var gi = 0; gi < 3; gi++) g += '<span class="gk k' + gi + '"><img src="stk/garland.webp" alt=""><img class="gl la" src="stk/garland-la.webp" alt=""><img class="gl lb" src="stk/garland-lb.webp" alt=""></span>';
      return g + '</div>';
    }
    if (theme === 'halloween') return '<div class="deco-branch"><img class="br" src="stk/branch.webp" alt="">' +
      '<img class="fcandy fc-1" src="stk/candy.webp" alt=""><img class="fcandy fc-2" src="stk/candy.webp" alt=""><img class="fcandy fc-3" src="stk/candy.webp" alt=""></div>';
    return '';
  }
  function filmTheme(f) {
    var cs = S.collections || [];
    for (var i = 0; i < cs.length; i++) if (DECO[cs[i].theme] && collFilms(cs[i]).indexOf(f) >= 0) return cs[i].theme;
    return '';
  }
  // one round back button for every screen
  function backBtn(key, cls, style) { return '<button class="rback' + (cls ? ' ' + cls : '') + '" data-f data-key="' + key + '" data-act="back" aria-label="Назад"' + (style ? ' style="' + style + '"' : '') + '>' + I.back + '</button>'; }
  function plural(n, one, few, many) { var m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? one : (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many); }

  // Christmas: a wide header where the films' own pictures change by themselves, then the films on a background of lights
  var xmTimer = null, xmIdx = 0;
  function xmasPage(c, list, seen) {
    // each slide: the film's own poster, whole and sharp, over a soft blurred copy of its picture (nothing stretched or cut)
    var lite = document.documentElement.classList.contains('lite');
    var hi = function (u, w) { return String(u || '').replace(/\/t\/p\/w\d+\//, '/t/p/' + w + '/'); };
    var pics = [];
    list.forEach(function (f) {
      if (pics.length >= 8 || (!f.poster && !f.backdrop)) return;
      var bd = (f.backdrops && f.backdrops[0]) || f.backdrop;
      // a wide still of the film (no titles on it) shown whole in its own frame; a poster only when there is no still
      pics.push({ f: f, wide: !!bd, poster: bd ? hi(bd, lite ? 'w780' : 'w1280') : hi(f.poster, lite ? 'w500' : 'w780'), bg: bd ? hi(bd, 'w780') : hi(f.poster, 'w342') });
    });
    if (xmIdx >= pics.length) xmIdx = 0;
    var cur = pics[xmIdx];
    var h = '<div class="xmbg"><i class="xg1"></i><i class="xg2"></i></div>' +
      '<section class="xmhero"><div class="ctop xmctop">' + backBtn('c-back', 'cback') + statusLine() + '</div>' + pics.map(function (p, i) { return '<div class="xs' + (i === xmIdx ? ' on' : '') + '" data-i="' + i + '"><img class="xsb" src="' + esc(p.bg) + '" alt="" onerror="this.style.display=\'none\'">' +
        (p.poster ? '<img class="xsp' + (p.wide ? ' wide' : '') + '" src="' + esc(p.poster) + '" alt="" onerror="this.style.display=\'none\'">' : '') + '</div>'; }).join('') +
        '<span class="xmhsh"></span>' +
        '<div class="xmhtop"><h1 class="xmtitle">Christmas is coming</h1>' +
          '<div class="hchips">' + (list.length ? '<span class="hchip">' + list.length + ' ' + plural(list.length, 'фильм', 'фильма', 'фильмов') + '</span>' : '') + (seen ? '<span class="hchip">посмотрела ' + seen + '</span>' : '') + '</div>' +
          (pics.length > 1 ? '<div class="xmdots">' + pics.map(function (p, i) { return '<i class="' + (i === xmIdx ? 'on' : '') + '"></i>'; }).join('') + '</div>' : '') +
          '</div>' +
        '<div class="xmhbot">' +
          (cur ? '<button class="xmnow" data-f data-key="xm-now" data-act="film:' + esc(cur.f.id) + '"><span class="xmnk">Сейчас на экране</span><span class="xmnt" id="xm-nt">' + esc(cur.f.title) + '</span><span class="xmna">Открыть →</span></button>' : '<span></span>') +
        '</div>' +
      '</section>';
    if (!list.length) return h + '<div class="empty glass"><h1>Скоро здесь будет кино</h1><p>Скажи Claude, какие фильмы положить в «' + esc(c.title) + '», и они появятся здесь.</p></div>';
    xmStart(pics);
    var grid = '<section class="xmpanel"><div class="xmph"><span class="h2">Все фильмы</span><span class="mallc">' + list.length + '</span></div><div class="grid">';
    for (var i = 0; i < list.length; i++) grid += card(list[i], 'coll');
    return h + grid + '</div></section>';
  }
  function xmStart(pics) {
    clearInterval(xmTimer);
    if (pics.length < 2) return;
    xmTimer = setInterval(function () {
      var hero = document.querySelector('.xmhero');
      if (!hero) { clearInterval(xmTimer); xmTimer = null; return; }
      xmIdx = (xmIdx + 1) % pics.length;
      var im = hero.querySelectorAll('.xs'), dots = hero.querySelectorAll('.xmdots i');
      for (var i = 0; i < im.length; i++) im[i].classList.toggle('on', +im[i].getAttribute('data-i') === xmIdx);
      for (var j = 0; j < dots.length; j++) dots[j].classList.toggle('on', j === xmIdx);
      var nt = document.getElementById('xm-nt'), bt = hero.querySelector('.xmnow');
      if (nt) nt.textContent = pics[xmIdx].f.title || '';
      if (bt) bt.setAttribute('data-act', 'film:' + pics[xmIdx].f.id);
    }, 5500);
  }
  function collection() {
    var c = collById(view.id);
    if (!c) return emptyScreen();
    var list = collFilms(c);
    var seen = list.filter(watched).length;
    var stk = PAGE_STK[c.theme] ? '<img class="cstk" src="' + stkSrc(PAGE_STK[c.theme]) + '" alt="">' : '';
    // a banner card: back button on top, then a glass card in the collection's colours with the big sticker peeking out
    if (c.theme === 'christmas') return xmasPage(c, list, seen);
    var h = '<div class="ctop">' + backBtn('c-back', 'cback') + statusLine() + '</div>' +
      '<section class="chead th-' + esc(c.theme || 'default') + '">' + stk +
      '<div class="cinfo"><span class="ckick">Подборка</span><h1 class="coll-title">' + esc(c.title) + '</h1>' +
      (c.subtitle ? '<div class="csubt">' + esc(c.subtitle) + '</div>' : '') +
      '<div class="hchips">' + (list.length ? '<span class="hchip">' + list.length + ' ' + plural(list.length, 'фильм', 'фильма', 'фильмов') + '</span>' : '') +
      (seen ? '<span class="hchip">посмотрела ' + seen + '</span>' : '') + '</div></div></section>';
    if (!list.length) return h + '<div class="empty glass"><h1>Скоро здесь будет кино</h1><p>Скажи Claude, какие фильмы положить в «' + esc(c.title) + '», и они появятся здесь.</p></div>';
    var grid = '<div class="grid">';
    for (var i = 0; i < list.length; i++) grid += card(list[i], 'coll');
    return h + grid + '</div>';
  }

  // ---------- screens ----------

  function emptyScreen() {
    var noToken = !S.hasToken;
    return '<div class="empty glass"><h1>Пока пусто</h1>' +
      '<p>Пришли Claude ссылку на фильм или сериал — он добавит его в библиотеку, а проектор сам скачает файл.</p>' +
      (noToken && S.error ? '<p class="hint">Проектор ещё не подключён к библиотеке на GitHub. Claude подскажет, как это сделать.</p>' : '') +
      '<button class="btn" data-f data-key="empty-sync" data-act="sync">' + I.sync + ' Обновить</button></div>';
  }

  var heroList = [], heroIdx = 0, heroCont = null;
  function heroSkips() { try { return JSON.parse(localStorage.getItem('heroSkip') || '{}') || {}; } catch (e) { return {}; } }
  // another film was picked over the one waiting in the top panel: next time the panel shows the new films again
  function heroPicked(id) {
    if (!heroCont || heroCont.id === id) return;
    var s = heroSkips(); s[heroCont.id] = String(heroCont.lastAt || 0);
    try { localStorage.setItem('heroSkip', JSON.stringify(s)); } catch (e) {}
  }
  var SEED = String(Math.random()).slice(2);

  function kickerOf(hero) { return resume(hero).active ? 'Продолжить просмотр' : (watched(hero) ? 'Уже смотрела' : (isWant(hero) ? 'Хочу посмотреть' : 'Новое')); }
  function setKicker(f) { var k = document.querySelector('.hkick'); if (k && f) k.textContent = kickerOf(f); }
  // Halloween films in the top panel get pumpkins popping out, Christmas ones a mailbox and snowflakes
  // a branch that grows along its own length: the picture is revealed by a thick line drawn from the root to the tip of the curl
  var VINE_PATH = 'M10,955 C30,860 60,700 52,560 C48,470 80,400 110,330 C130,270 150,200 220,120 C290,60 400,15 520,18 C610,22 670,70 685,140 C695,210 650,265 585,280 C520,290 470,240 460,195 C452,160 490,150 505,185';
  function vineSvg(n, delay, dur) {
    var id = 'vm' + n + '_' + Math.floor(Math.random() * 1e6);
    return '<svg viewBox="0 0 700 955" preserveAspectRatio="none"><defs><mask id="' + id + '" maskUnits="userSpaceOnUse" x="0" y="0" width="700" height="955">' +
      '<path d="' + VINE_PATH + '" fill="none" stroke="#fff" stroke-width="150" stroke-linecap="round" stroke-linejoin="round" pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="1">' +
      '<animate attributeName="stroke-dashoffset" from="1" to="0" begin="' + delay + 's" dur="' + dur + 's" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.35 0.1 0.35 1"/></path></mask></defs>' +
      '<image href="stk/vine.webp" x="0" y="0" width="700" height="955" mask="url(#' + id + ')"/></svg>';
  }
  function heroStickers(f) {
    var t = filmTheme(f);
    // Halloween: twisted branches creep in from the corners while it waits to turn
    if (t === 'halloween') return '<div class="vines">' + [[1, 0.2, 6.5], [2, 1.0, 5.8], [3, 1.8, 5.0], [4, 1.3, 5.5]].map(function (v) { return '<span class="v v' + v[0] + '">' + vineSvg(v[0], v[1], v[2]) + '</span>'; }).join('') + '</div>';
    // Christmas: the picture slowly frosts over from the corners while it waits to turn
    if (t === 'christmas') return '<div class="frost"><img src="stk/frost.webp" alt=""></div>';
    return '';
  }
  function heroHtml(hero, idx, n) {
    var hr = resume(hero);
    var kicker = kickerOf(hero);
    var bdUrl = pickBd(hero);
    var bgHtml = '';
    if (bdUrl) bgHtml = '<div class="bgblur"><img src="' + esc(bdUrl) + '" alt="" onerror="this.remove()"></div>' +
      '<div class="bg"><img src="' + esc(bdUrl) + '" alt="" onerror="this.remove()"></div><div class="shade"></div>';
    else if (hero.poster) bgHtml = '<div class="bg blur"><img src="' + esc(hero.poster) + '" alt="" onerror="this.remove()"></div><div class="shade"></div>';
    var side = (!bdUrl && hero.poster) ? '<div class="pst"><img src="' + esc(hero.poster) + '" alt="" onerror="this.parentNode.remove()"></div>' : '';
    var dots = '';
    if (n > 1) {
      dots = '<div class="dots">';
      for (var d = 0; d < n; d++) dots += '<button class="dot' + (d === idx ? ' on' : '') + '" data-f data-key="dot-' + d + '" data-act="hero:' + d + '" aria-label="Фильм ' + (d + 1) + '"><i></i></button>';
      dots += '</div>';
    }
    // little glass chips: year, genre, length, own rating
    var chips = [];
    if (hero.year) chips.push(String(hero.year));
    var g = genresOf(hero);
    if (g.length) chips.push(g[0]);
    if (isSeries(hero)) chips.push(eps(hero).length + ' сер.'); else if (hero.duration) chips.push(hero.duration);
    var hol = filmTheme(hero);
    var holChip = hol === 'halloween' ? '<span class="hchip hol hw">🎃 Хэллоуин</span>' : (hol === 'christmas' ? '<span class="hchip hol xm">❄ Рождество</span>' : '');
    var chipHtml = '<div class="hchips">' + chips.map(function (c) { return '<span class="hchip">' + esc(c) + '</span>'; }).join('') + holChip +
      (hero.rating ? '<span class="hchip rate">★ ' + esc(String(hero.rating).replace('.', ',')) + '</span>' : '') + '</div>';
    var desc = hero.description ? '<p class="hdesc">' + esc(hero.description) + '</p>' : '';
    var wantOn = isWant(hero);
    return '<section class="hero glass' + (bdUrl ? ' has-bd' : '') + '" data-hero="' + esc(hero.id) + '">' + bgHtml +
      '<div class="info"><div class="kicker"><i></i>' + esc(kicker) + '</div>' +
      '<h1' + (String(hero.title || '').length > 26 ? ' class="long"' : '') + '>' + esc(hero.title) + '</h1>' + chipHtml + desc +
      '<div class="btns">' +
      '<button class="btn pri hplay" data-f data-key="hero-play" data-act="play:' + esc(hero.id) + ':' + esc(hr.key) + '">' + I.play + esc(hr.label) + '</button>' +
      '<button class="btn hmore" data-f data-key="hero-more" data-act="film:' + esc(hero.id) + '">Подробнее</button>' +
      (watched(hero) ? '' : '<button class="btn hwant' + (wantOn ? ' on' : '') + '" data-f data-key="hero-want" data-act="want:' + esc(hero.id) + '" aria-label="Хочу посмотреть">' + (wantOn ? '✓' : '+') + '</button>') +
      '</div>' + dots + '</div>' + side + heroStickers(hero) + '</section>';
  }

  /** Shows film number n in the top panel; keeps the remote on the same dot. */
  function showHero(n, focusDot) {
    var sec = document.querySelector('section.hero');
    var f = byId(heroList[n]);
    if (!sec || !f) return;
    heroIdx = n;
    setKicker(f);
    var tmp = document.createElement('div');
    tmp.innerHTML = heroHtml(f, heroIdx, heroList.length);
    var next = tmp.firstChild;
    next.classList.add('fade');
    sec.parentNode.replaceChild(next, sec);
    if (focusDot) { var d = document.querySelector('[data-key="dot-' + n + '"]'); if (d) d.focus(); }
  }

  /** The top panel turns to the next new film every few seconds (not while the remote is on its buttons). */
  function rotateHero() {
    if (view.name !== 'home' || full >= 0 || heroList.length < 2) return;
    if (heroCont && heroList[heroIdx] === heroCont.id) return; // «Продолжить» stays until you choose
    var a = document.activeElement;
    if (a && a.closest && a.closest('.hero')) return;
    var sec = document.querySelector('section.hero');
    if (!sec) return;
    heroIdx = (heroIdx + 1) % heroList.length;
    var f = byId(heroList[heroIdx]);
    if (!f) return;
    setKicker(f);
    var tmp = document.createElement('div');
    tmp.innerHTML = heroHtml(f, heroIdx, heroList.length);
    var next = tmp.firstChild;
    next.classList.add('fade');
    sec.parentNode.replaceChild(next, sec);
    var after = byId(heroList[(heroIdx + 1) % heroList.length]);
    if (after && (after.backdrop || after.poster)) { var im = new Image(); im.src = after.backdrop || after.poster; }
  }
  var lastHeroTouch = 0;
  setInterval(function () { if (Date.now() - lastHeroTouch > 8000) rotateHero(); }, 8000);

  // on a phone the top panel follows the finger, keeps its speed and settles with a soft spring
  // critically damped spring (Apple: damping 1.0, response ~0.35 s), starting from the live value and velocity
  function spring(from, to, v0, set, done) {
    var w = 2 * Math.PI / 0.35, x0 = from - to, t0 = null;
    function step(ts) {
      if (t0 === null) t0 = ts;
      var t = (ts - t0) / 1000, e = Math.exp(-w * t);
      var x = to + (x0 + (v0 + w * x0) * t) * e;
      var v = (v0 - w * (v0 + w * x0) * t) * e;
      set(x);
      if (Math.abs(x - to) < 0.5 && Math.abs(v) < 8) { set(to); if (done) done(); return; }
      raf = requestAnimationFrame(step);
    }
    var raf = requestAnimationFrame(step);
    return function () { cancelAnimationFrame(raf); };
  }
  var sw = null, swStop = null;
  function heroSec() { return document.querySelector('section.hero'); }
  // the frame stays put; only the picture and the text inside it slide
  function heroParts(sec) { return sec.querySelectorAll('.bg, .info, .bgblur, .pst'); }
  // the neighbouring film rides right next to the current one, so pictures follow each other without a gap
  function heroPeek(sec, dirn) {
    if (sec._peekDir === dirn && sec._peek) return sec._peek;
    if (sec._peek) sec._peek.remove();
    var n = (heroIdx + dirn + heroList.length) % heroList.length, f = byId(heroList[n]);
    sec._peekDir = dirn; sec._peek = null;
    if (!f) return null;
    var tmp = document.createElement('div');
    tmp.innerHTML = heroHtml(f, n, heroList.length);
    var pk = document.createElement('div');
    pk.className = 'hpeek'; pk.setAttribute('aria-hidden', 'true');
    var src = tmp.firstChild, parts = src.querySelectorAll('.bgblur, .bg, .shade, .info');
    for (var i = 0; i < parts.length; i++) pk.appendChild(parts[i]);
    sec.appendChild(pk);
    sec._peek = pk;
    return pk;
  }
  function setX(sec, x) {
    var w = sec.offsetWidth || 1, ps = heroParts(sec);
    sec.setAttribute('data-x', String(x));
    for (var i = 0; i < ps.length; i++) { ps[i].style.transform = x ? 'translateX(' + x + 'px)' : ''; ps[i].style.opacity = ''; }
    if (!x) { if (sec._peek) { sec._peek.remove(); sec._peek = null; sec._peekDir = 0; } return; }
    var pk = heroPeek(sec, x < 0 ? 1 : -1);
    if (pk) pk.style.transform = 'translateX(' + (x < 0 ? x + w : x - w) + 'px)';
  }
  document.addEventListener('touchstart', function (e) {
    var t = e.touches && e.touches[0];
    var sec = t && e.target.closest ? e.target.closest('section.hero') : null;
    if (!sec || heroList.length < 2) { sw = null; return; }
    if (swStop) { swStop(); swStop = null; }
    // grab it where it is right now (it may still be settling)
    var cur = parseFloat(sec.getAttribute('data-x') || '0') || 0;
    sw = { x0: t.clientX - cur, y0: t.clientY, dir: null, hist: [{ x: cur, t: Date.now() }], sec: sec };
  }, { passive: true });
  document.addEventListener('touchmove', function (e) {
    if (!sw) return;
    var t = e.touches && e.touches[0]; if (!t) return;
    var dx = t.clientX - sw.x0, dy = t.clientY - sw.y0;
    if (!sw.dir) { if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return; sw.dir = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'; if (sw.dir === 'x') sw.sec.classList.add('drag'); }
    if (sw.dir !== 'x') return;
    lastHeroTouch = Date.now();
    setX(sw.sec, dx);
    sw.hist.push({ x: dx, t: Date.now() }); if (sw.hist.length > 6) sw.hist.shift();
  }, { passive: true });
  document.addEventListener('touchend', function () {
    if (!sw) return;
    var g = sw; sw = null;
    if (g.dir !== 'x') return;
    var h = g.hist, last = h[h.length - 1], first = h[0];
    var dt = Math.max(16, last.t - first.t), v = (last.x - first.x) / dt * 1000; // px/s
    var x = last.x, wdt = g.sec.offsetWidth || 360;
    // where the flick is going, not where the finger let go
    var projected = x + (v / 1000) * 0.998 / (1 - 0.998);
    if (Math.abs(projected) > wdt * 0.35) {
      var dirn = projected < 0 ? 1 : -1;
      // the current film slides out while the next one slides in right behind it; at the end the next one simply takes its place
      swStop = spring(x, -dirn * wdt, v, function (val) { setX(g.sec, val); }, function () {
        var n = (heroIdx + dirn + heroList.length) % heroList.length;
        showHero(n, false);
        var nx = heroSec(); if (nx) nx.classList.remove('fade');
      });
    } else {
      swStop = spring(x, 0, v, function (val) { setX(g.sec, val); }, function () { g.sec.classList.remove('drag'); setX(g.sec, 0); });
    }
  }, { passive: true });

  function home() {
    if (!S.films.length) return '<div class="topline"><span></span>' + statusLine() + '</div>' + emptyScreen() + collTiles();
    var films = S.films;
    var byAdded = function (a, b) { return String(b.addedAt || '').localeCompare(String(a.addedAt || '')); };
    // a new random order each time the app is opened (stays the same while you scroll)
    // the latest uploads to Drive come first (films without a known time are shuffled after them)
    var upl = function (f) { return String(f.uploaded || (f.addedAt ? String(f.addedAt).slice(0, 10) + 'T00:00' : '')); };
    // started or (almost) finished films live in «Продолжить» / «Недавно просмотренные», not in «Новое»
    var touched = function (f) {
      if (isSeries(f)) return eps(f).some(function (e) { return e.watchedPart || e.pos > 5000; });
      return f.watchedPart || f.pos > 5000;
    };
    // «Новое» holds what was uploaded on the latest upload day; older films just live in their genres
    // the latest upload session: everything uploaded within 30 hours of the newest upload (a night session can cross midnight)
    var lastT = 0;
    var tOf = function (f) { var u = upl(f); if (!u) return 0; var t = Date.parse(u.length <= 10 ? u + 'T00:00:00' : u + (u.length === 16 ? ':00' : '')); return isNaN(t) ? 0 : t; };
    films.forEach(function (f) { var t = tOf(f); if (t > lastT) lastT = t; });
    var fresh = films.filter(function (f) { return isNew(f) && !touched(f) && (!lastT || tOf(f) >= lastT - 30 * 3600000); }).slice().sort(function (x, y) {
      var d = upl(y).localeCompare(upl(x));
      return d || (hash(x.id + SEED) - hash(y.id + SEED));
    });
    var cont = films.filter(function (f) { return resume(f).active; }).sort(function (a, b) { return (b.lastAt || 0) - (a.lastAt || 0); });
    var want = films.filter(isWant);
    var seen = films.filter(watched).sort(function (a, b) { return String(b.watchedOn || '').localeCompare(String(a.watchedOn || '')); }).slice(0, 15);
    var downloading = films.filter(function (f) { return dlSummary(f).running > 0; });

    // top panel: new films one after another (or, if nothing is new, what you want to watch)
    var pool = (fresh.length ? fresh : (want.length ? want : films)).slice(0, 12);
    // the film you stopped last comes first, as «Продолжить» — until you pick something else instead
    var skip = heroSkips();
    heroCont = null;
    for (var ci = 0; ci < cont.length && !heroCont; ci++) if (skip[cont[ci].id] !== String(cont[ci].lastAt || 0)) heroCont = cont[ci];
    if (heroCont) pool = [heroCont].concat(pool.filter(function (f) { return f.id !== heroCont.id; })).slice(0, 12);
    var ids = pool.map(function (f) { return f.id; });
    if (ids.join('|') !== heroList.join('|')) { heroList = ids; heroIdx = 0; }
    if (heroIdx >= heroList.length) heroIdx = 0;
    var hero = byId(heroList[heroIdx]) || pool[0];

    var h = '<div class="topline"><span></span>' + statusLine() + '</div><div class="hkick">' + esc(kickerOf(hero)) + '</div>' + heroHtml(hero, heroIdx, heroList.length);
    h += row('new', 'Новое', fresh.length + ' шт.', fresh);
    h += row('cont', 'Продолжить просмотр', '', cont);
    h += brandTiles();
    h += collTiles();
    h += want.length ? row('want', 'Хочу посмотреть', want.length + ' шт.', want)
      : '<section class="section"><div class="head"><h2 class="h2">Хочу посмотреть</h2></div><div class="sub">Пока пусто. Открой фильм и нажми «+ Хочу посмотреть» — он появится здесь.</div></section>';
    h += row('seen', 'Недавно просмотренные', '', seen);
    h += row('dl', 'Скачивается', '', downloading);
    return h;
  }


  function genres() {
    var gs = ['Все'].concat(allGenres(true));
    var cur = view.genre || 'Все';
    var filter = view.filter || 'all';
    var origin = cur === 'Сериалы' ? (view.origin || 'all') : 'all';
    var side = '<aside class="side glass"><h1>Жанры</h1>';
    for (var i = 0; i < gs.length; i++) {
      var g = gs[i];
      var n = S.films.filter(function (f) { return g === 'Все' || genresOf(f).indexOf(g) >= 0; }).length;
      side += '<button class="gbtn' + (g === cur ? ' on' : '') + '" data-f data-key="g-' + esc(g) + '" data-act="pickgenre:' + esc(g) + '"><span>' + esc(g) + '</span><span>' + n + '</span></button>';
    }
    side += '</aside>';
    var list = S.films.filter(function (f) { return (cur === 'Все' || genresOf(f).indexOf(cur) >= 0) && originOk(f, origin); });
    var seenN = list.filter(watched).length;
    var titleText = origin === 'cartoon' ? 'Мультсериалы' : cur === 'Все' ? (origin === 'ru' ? 'Русские' : origin === 'foreign' ? 'Иностранные' : 'Все') : cur + (origin === 'ru' ? ' · русские' : origin === 'foreign' ? ' · иностранные' : '');
    if (filter === 'want') list = list.filter(isWant);
    if (filter === 'seen') list = list.filter(watched);
    var fl = [['all', 'Все'], ['want', 'Хочу посмотреть'], ['seen', 'Посмотрела']];
    var chips = '<div class="chips">';
    for (var j = 0; j < fl.length; j++) chips += '<button class="chip' + (filter === fl[j][0] ? ' on' : '') + '" data-f data-key="f-' + fl[j][0] + '" data-act="filter:' + fl[j][0] + '">' + fl[j][1] + '</button>';
    chips += '</div>';
    var grid = '<div class="grid">';
    for (var k = 0; k < list.length; k++) grid += card(list[k], 'grid');
    grid += '</div>';
    var total = S.films.filter(function (f) { return (cur === 'Все' || genresOf(f).indexOf(cur) >= 0) && originOk(f, origin); }).length;
    var ol = [['all', 'Все'], ['cartoon', '✦ Мультсериалы'], ['ru', 'Русские'], ['foreign', 'Иностранные']];
    var ochips = cur !== 'Сериалы' ? '' : '<div class="chips">';
    for (var q = 0; q < ol.length && cur === 'Сериалы'; q++) ochips += '<button class="chip' + (origin === ol[q][0] ? ' on' : '') + '" data-f data-key="o-' + ol[q][0] + '" data-act="origin:' + ol[q][0] + '">' + ol[q][1] + '</button>';
    if (cur !== 'Сериалы') ochips = ''; else ochips += '</div>';
    return '<div class="split">' + side + '<div class="content"><div class="topline"><div><h1 class="title-glow">' + esc(titleText) + '</h1>' +
      '<div class="sub">' + total + ' шт. · посмотрела ' + seenN + ', ещё ' + (total - seenN) + ' ждут</div></div>' + chips + '</div>' + ochips +
      (list.length ? grid : '<div class="sub">Здесь пока ничего нет.</div>') + '</div></div>';
  }

  function starsWidget(f) {
    var r = f.rating || 0, h = '';
    for (var n = 1; n <= 5; n++) {
      var w = r >= n ? 40 : (r >= n - 0.5 ? 20 : 0);
      h += '<button class="star" data-f data-key="star-' + n + '" data-act="rate:' + esc(f.id) + ':' + n + '" aria-label="' + n + ' из 5">' +
        I.star('rgba(255,255,255,0.12)') + '<span class="fill" style="width:' + w + 'px">' + I.star('#FFD84D') + '</span></button>';
    }
    return '<div class="stars">' + h + '</div>';
  }

  /** Other parts of the same franchise ("saga" + "part" in the library), in order. */
  function sagaParts(f) {
    if (!f.saga) return [];
    return S.films.filter(function (x) { return x.saga === f.saga; })
      .sort(function (a, b) { return (a.part || 0) - (b.part || 0) || (a.year || 0) - (b.year || 0); });
  }

  function sagaSection(f) {
    var parts = sagaParts(f);
    if (parts.length < 2) return '';
    var cards = '';
    var next = null;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!next && p.id !== f.id && !watched(p) && (p.part || 0) > (f.part || 0)) next = p;
      cards += '<div class="part' + (p.id === f.id ? ' cur' : '') + '">' + card(p, 'saga') +
        '<div class="pnum">' + (p.id === f.id ? 'Ты здесь' : 'Часть ' + (p.part || i + 1)) + '</div></div>';
    }
    var hint = next ? 'Дальше по порядку: ' + next.title : 'Все части по порядку';
    return '<section class="section"><div class="head"><h2 class="h2">' + esc(f.saga) + ': все части</h2><span class="sub">' + esc(hint) + '</span></div>' +
      '<div class="row" data-row="saga">' + cards + '</div></section>';
  }

  function film() {
    var f = byId(view.id);
    if (!f) return emptyScreen();
    var r = resume(f), d = dlSummary(f);
    var tags = '';
    var gl = genresOf(f);
    for (var i = 0; i < gl.length; i++) tags += '<span class="tag">' + esc(gl[i]) + '</span>';
    var fth = filmTheme(f);
    if (fth === 'halloween') tags += '<span class="tag hol hw">🎃 Хэллоуин</span>';
    else if (fth === 'christmas') tags += '<span class="tag hol xm">❄ Рождество</span>';
    if (d.done === d.count && d.count) tags += '<span class="tag ok">На проекторе</span>';
    else if (d.running) tags += '<span class="tag ok" data-prog="' + esc(d.key) + '">Скачивается ' + (d.bytesTotal ? Math.round(d.bytesDone / d.bytesTotal * 100) : 0) + '%</span>';
    else if (d.done) tags += '<span class="tag ok">Скачано ' + d.done + ' из ' + d.count + '</span>';
    else if (d.failed) tags += '<span class="tag">Не скачалось</span>';

    var btns = '<button class="btn pri" data-f data-key="f-play" data-act="play:' + esc(f.id) + ':' + esc(r.key) + '">' + I.play + esc(r.label) + '</button>';
    if (!isSeries(f) && r.active) btns += '<button class="btn" data-f data-key="f-restart" data-act="restart:' + esc(f.id) + ':' + esc(f.key) + '">Сначала</button>';
    if (S.noDownloads || f.online) {
      // the Mac plays everything straight from Drive; RUTUBE series are online only
    } else if (isSeries(f)) {
      if (d.none + d.failed > 0) btns += '<button class="btn" data-f data-key="f-dlall" data-act="dlall:' + esc(f.id) + '">' + I.down + ' Скачать все серии</button>';
    } else {
      var st = (f.dl || {}).status;
      if (st === 'none' || st === 'failed') btns += '<button class="btn" data-f data-key="f-dl" data-act="dl:' + esc(f.key) + '">' + I.down + (st === 'failed' ? ' Скачать ещё раз' : ' Скачать на проектор') + '</button>';
      if (st === 'done') {
        var ck = confirmKey === f.key;
        btns += '<button class="btn warn" data-f data-key="f-rm" data-act="rm:' + esc(f.key) + '">' + (ck ? 'Нажми ещё раз — удалю файл' : 'Удалить с проектора · ' + gb(f.dl.total || 0)) + '</button>';
      }
    }
    if (!watched(f)) btns += '<button class="btn' + (isWant(f) ? ' on' : '') + '" data-f data-key="f-want" data-act="want:' + esc(f.id) + '">' + (isWant(f) ? '✓ В «Хочу посмотреть»' : '+ Хочу посмотреть') + '</button>';
    btns += '<button class="btn" data-f data-key="f-status" data-act="status:' + esc(f.id) + '">' + (watched(f) ? 'Ещё не смотрела' : 'Посмотрела') + '</button>';

    var big = '<div class="big" style="background:' + color(f) + '">' + posterInner(f) + '</div>';

    var panel = '<section class="panel glass"><div class="ph"><h2>Моя оценка</h2><span class="hint">' +
      (f.watchedOn ? 'Посмотрела ' + esc(dateRu(f.watchedOn)) : 'Нажми на звезду · ещё раз — половинка') + '</span></div>' +
      '<div class="rate">' + starsWidget(f) + '<span class="rnum">' + rnum(f.rating) + '</span>' +
      '<button class="heart' + (f.liked ? ' on' : '') + '" data-f data-key="f-heart" data-act="like:' + esc(f.id) + '" aria-label="Любимое">' + I.heart(f.liked) + '</button></div>' +
      (f.review ? '<div class="review">«' + esc(f.review) + '»</div>' : '') + '</section>';

    var episodes = '';
    if (isSeries(f)) {
      var list = eps(f), season = null;
      // a long series shows one season at a time, with the seasons as chips on top
      var seasons = []; list.forEach(function (x) { if (seasons.indexOf(x.season || 1) < 0) seasons.push(x.season || 1); });
      var curSeason = null;
      if (list.length > 40 && seasons.length > 1) {
        var rk = null; for (var q = 0; q < list.length; q++) if (list[q].key === r.key) rk = list[q];
        curSeason = view.season || (rk ? rk.season || 1 : seasons[0]);
      }
      episodes = '<section class="section"><h2 class="h2">Серии' + (f.online ? ' <span class="sub">онлайн · RUTUBE</span>' : '') + '</h2>';
      if (curSeason !== null) {
        episodes += '<div class="chips seasons">';
        seasons.forEach(function (sn) {
          var all = list.filter(function (x) { return (x.season || 1) === sn; }), seen = all.filter(function (x) { return x.watchedPart; }).length;
          episodes += '<button class="chip' + (sn === curSeason ? ' on' : '') + (seen === all.length ? ' seen' : '') + '" data-f data-key="sn-' + sn + '" data-act="season:' + sn + '">' + sn + (seen && seen < all.length ? ' <small>' + seen + '/' + all.length + '</small>' : (seen === all.length ? ' ✓' : '')) + '</button>';
        });
        episodes += '</div>';
      }
      episodes += '<div class="eps">';
      for (var e = 0; e < list.length; e++) {
        var ep = list[e];
        if (curSeason !== null && (ep.season || 1) !== curSeason) continue;
        if (ep.season !== season) { season = ep.season; episodes += '<div class="season">Сезон ' + esc(season || 1) + '</div>'; }
        var isNext = r.active && ep.key === r.key;
        var cls = 'ep' + (ep.watchedPart ? ' done' : '') + (isNext ? ' last' : '');
        var dd = ep.dl || {};
        var state = ep.watchedPart ? 'просмотрена' : dd.status === 'done' ? 'скачана' : (dd.status === 'running' || dd.status === 'paused' ? '<span data-prog="' + esc(ep.key) + '">Скачивается ' + pct(dd) + '%</span>' : (ep.url ? 'онлайн' : 'нет ссылки'));
        var here = '';
        if (isNext && ep.pos > 5000) here = '<span class="here">Ты остановилась здесь · ' + clock(ep.pos) + '</span>';
        else if (isNext) here = '<span class="here">Следующая серия</span>';
        var prog = ep.dur > 0 && ep.pos > 0 && !ep.watchedPart ? '<div class="bar"><i style="width:' + Math.round(ep.pos / ep.dur * 100) + '%"></i></div>' : '';
        episodes += '<button class="' + cls + '" data-f data-key="ep-' + esc(ep.key) + '" data-act="play:' + esc(f.id) + ':' + esc(ep.key) + '">' +
          '<span class="n">' + (ep.watchedPart ? '✓' : esc(ep.episode || e + 1)) + '</span>' +
          '<span class="t"><b>' + esc(ep.title || ('Серия ' + (ep.episode || e + 1))) + '</b>' + here + prog + '</span>' +
          '<span class="s">' + state + '</span></button>';
      }
      episodes += '</div></section>';
    }

    // a wide picture across the top when there is one; the poster then sits on its lower edge
    // several pictures take turns; the first one shown is picked at random each time
    var one = pickBd(f);
    var bds = one ? [one] : [];
    var imgs = one ? '<img class="fbimg on" src="' + esc(one) + '" alt="" onerror="this.remove()">' : '';
    var banner = bds.length ? '<section class="fbanner" data-bds="' + bds.length + '">' + imgs + '<div class="fshade"></div>' +
      backBtn('f-back', 'fback') + '</section>' : '';
    var deco = bds.length ? decoHtml(filmTheme(f)) : '';
    if (deco) banner = '<div class="fbwrap">' + banner + deco + '</div>';
    return banner + '<div class="film' + (bds.length ? ' has-bd' : '') + (deco ? ' th-' + filmTheme(f) : '') + '"><div class="fpost">' + (bds.length ? '' : backBtn('f-back', '', 'margin-bottom:14px')) + big + '</div>' +
      '<div class="body"><div class="chips">' + tags + '</div><h1>' + esc(f.title) + '</h1>' +
      (f.original && f.original !== f.title ? '<div class="sub">' + esc(f.original) + '</div>' : '') +
      '<div class="meta">' + esc(filmMeta(f)) + '</div>' +
      (f.description ? '<p class="desc">' + esc(f.description) + '</p>' : '') +
      '<div class="btns">' + btns + '</div>' + panel + sagaSection(f) + episodes + '</div></div>';
  }

  function diary() {
    var seen = S.films.filter(watched).sort(function (a, b) { return String(b.watchedOn || '').localeCompare(String(a.watchedOn || '')); });
    var year = new Date().getFullYear();
    var thisYear = seen.filter(function (f) { return String(f.watchedOn || '').slice(0, 4) === String(year); });
    var rated = seen.filter(function (f) { return f.rating; });
    var avg = rated.length ? rated.reduce(function (s, f) { return s + f.rating; }, 0) / rated.length : 0;
    var liked = seen.filter(function (f) { return f.liked; }).length;
    var h = '<div class="topline"><h1 class="title-glow">Дневник</h1>' + statusLine() + '</div>' +
      '<div class="stats"><div class="stat glass"><b>' + thisYear.length + '</b><span>посмотрено в ' + year + '</span></div>' +
      '<div class="stat glass"><b>' + (avg ? avg.toFixed(1).replace('.', ',') : '—') + '</b><span>средняя оценка</span></div>' +
      '<div class="stat glass"><b>' + liked + '</b><span>любимых</span></div></div>';
    if (!seen.length) return h + '<div class="sub">Тут появятся фильмы, которые ты посмотрела.</div>';
    h += '<div class="list">';
    for (var i = 0; i < seen.length; i++) {
      var f = seen[i];
      h += '<button class="li glass" data-f data-key="d-' + esc(f.id) + '" data-act="film:' + esc(f.id) + '"><span class="d">' + esc(dateRu(f.watchedOn) || '—') + '</span>' +
        '<span class="m"><b>' + esc(f.title) + '</b><span class="sub">' + esc(filmMeta(f)) + '</span>' + (f.review ? '<span class="review" style="font-size:14px">«' + esc(f.review) + '»</span>' : '') + '</span>' +
        '<span class="r"><span class="stars-t">' + starsText(f.rating) + '</span>' + (f.liked ? '<span style="color:#FF4FD8;font-size:18px">♥</span>' : '') + '</span></button>';
    }
    return h + '</div>';
  }

  function downloads() {
    if (S.noDownloads) {
      return '<div class="topline"><h1 class="title-glow">Библиотека</h1>' + statusLine() + '</div>' +
        '<div class="storage glass"><div class="sub">Папки на Диске: ' + esc(S.scanReport || 'ещё не проверялись — нажми обновление') + '</div>' +
        '<div class="sub">Фильмы смотрятся прямо с Диска, без скачивания.</div></div>' +
        '<div class="hint" style="margin-top:18px">Постеры и кадры: TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB. · L-CINEMA ' + esc(S.version || '') + '</div>';
    }
    var used = S.total - S.free;
    var usedPct = S.total ? Math.round(used / S.total * 100) : 0;
    var h = '<div class="topline"><h1 class="title-glow">Загрузки</h1>' + statusLine() + '</div>' +
      '<div class="storage glass"><div class="sub">Свободно ' + gb(S.free || 0) + ' из ' + gb(S.total || 0) + '</div><div class="bar cy"><i style="width:' + usedPct + '%"></i></div>' +
      '<div class="sub">Папки на Диске: ' + esc(S.scanReport || 'ещё не проверялись — нажми обновление') + '</div>' +
      clockNote() +
      (A.homeSettings ? '<div class="btns" style="margin-top:14px"><button class="btn" data-f data-key="mk-home" data-act="mkhome">🏠 Сделать L-HOME главным экраном</button><button class="btn" data-f data-key="open-home" data-act="openhome">Открыть L-HOME</button>' + (A.androidSettings ? '<button class="btn" data-f data-key="and-set" data-act="andset">⚙ Настройки Android</button>' : '') + '</div>' : '') +
      '</div><div class="list">';
    var any = false;
    for (var i = 0; i < S.films.length; i++) {
      var f = S.films[i];
      if (f.online) continue;
      var items = isSeries(f) ? eps(f) : [f];
      for (var j = 0; j < items.length; j++) {
        var it = items[j];
        if (!it.url) continue;
        any = true;
        var d = it.dl || { status: 'none' };
        var name = isSeries(f) ? f.title + ' · ' + epLabel(it) : f.title;
        var state, act, label;
        if (d.status === 'done') { state = 'На проекторе · ' + gb(d.total || 0); act = 'rm:' + it.key; label = confirmKey === it.key ? 'Нажми ещё раз — удалю' : 'Удалить'; }
        else if (d.status === 'running' || d.status === 'paused') { state = '<span data-prog="' + esc(it.key) + '">Скачивается ' + pct(d) + '%</span>'; act = 'rm:' + it.key; label = confirmKey === it.key ? 'Нажми ещё раз — отменю' : 'Отменить'; }
        else { state = d.status === 'failed' ? 'Не скачалось' : 'Не скачано'; act = 'dl:' + it.key; label = 'Скачать'; }
        h += '<button class="li glass" data-f data-key="dl-' + esc(it.key) + '" data-act="' + esc(act) + '"><span class="m"><b>' + esc(name) + '</b><span class="sub">' + state + '</span>' +
          ((d.status === 'running' || d.status === 'paused') ? '<div class="bar cy"><i data-bar="' + esc(it.key) + '" style="width:' + pct(d) + '%"></i></div>' : '') +
          '</span><span class="r"><span class="tag">' + label + '</span></span></button>';
      }
    }
    if (!any) h += '<div class="sub">Пока нечего скачивать.</div>';
    return h + '</div><div class="hint" style="margin-top:18px">Постеры и кадры: TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB. · L-CINEMA ' + esc(S.version || '') + '</div>';
  }

  // the screensavers page: one of them plays silently behind a big header card (a new one each time you come in), the rest below
  var svPick = -1;
  function svDirect(u) {
    var m = /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=download&)?id=)([A-Za-z0-9_-]{10,})/.exec(u || '');
    return m ? 'https://drive.usercontent.google.com/download?id=' + m[1] + '&export=download&confirm=t' : '';
  }
  function savers() {
    var list = S.screensavers || [];
    if (!list.length) return '<div class="topline"><h1 class="title-glow">Заставки</h1>' + statusLine() + '</div><div class="empty glass"><h1>Пока пусто</h1><p>Пришли Claude ссылки на свои фоны с Google Диска — они появятся здесь.</p></div>';
    if (svPick < 0 || svPick >= list.length) svPick = Math.floor(Math.random() * list.length);
    var p = list[svPick];
    var big = p.thumb ? String(p.thumb).replace('sz=w800', 'sz=w1600') : '';
    var vid = p.type === 'video' ? svDirect(p.url) : '';
    var h = '<div class="ctop"><span></span>' + statusLine() + '</div>' +
      '<section class="svhero">' +
      (big ? '<img class="svbg" src="' + esc(big) + '" alt="" onerror="this.remove()">' : '') +
      (vid ? '<video class="svvid" data-src="' + esc(vid) + '" src="' + esc(vid) + '" muted autoplay loop playsinline preload="auto" onplaying="this.classList.add(\'on\')" onerror="this.remove()"></video>' : '') +
      '<div class="svshade"></div>' +
      '<div class="svinfo"><span class="hchip">' + list.length + ' ' + plural(list.length, 'заставка', 'заставки', 'заставок') + '</span>' +
      '<h1>Заставки</h1><div class="svnow">Сейчас на фоне: ' + esc(p.title || '') + '</div>' +
      '<div class="btns"><button class="btn pri" data-f data-key="sv-now" data-act="saver:' + svPick + '">' + I.play + 'Включить на весь экран</button></div></div>' +
      '</section>';
    h += '<div class="savers">';
    for (var i = 0; i < list.length; i++) {
      var sv = list[i];
      var img = sv.thumb ? '<img src="' + esc(sv.thumb) + '" alt="" onerror="this.remove()">' : '';
      h += '<div class="tile' + (i === svPick ? ' cur' : '') + '" data-f tabindex="0" data-key="sv-' + i + '" data-act="saver:' + i + '">' +
        '<div class="thumb' + (sv.pixel === false ? '' : ' px') + '">' + img + '<span class="kind">' + (sv.type === 'image' ? 'картинка' : I.play) + '</span></div>' +
        '<div class="ct">' + esc(sv.title || ('Заставка ' + (i + 1))) + '</div></div>';
    }
    return h + '</div>';
  }

  function fullScreen() {
    var list = S.screensavers || [];
    var sv = list[full];
    if (!sv) return '';
    return '<div class="full' + (sv.pixel === false ? '' : ' px') + '"><img src="' + esc(sv.url) + '" alt=""></div>';
  }

  function openSaver(i) {
    var list = S.screensavers || [];
    var sv = list[i];
    if (!sv) return;
    if (sv.type === 'image') { full = i; render(null, true); }
    else if (sv.type === 'youtube') A.openYoutube(sv.yt);
    else A.playLoop(sv.url);
  }

  function stepImage(delta) {
    var list = S.screensavers || [], n = list.length;
    for (var t = 1; t <= n; t++) {
      var j = (full + delta * t + n * 10) % n;
      if (list[j].type === 'image') { full = j; render(null, true); return; }
    }
  }


  // ---------- Russian TV: live channels that open from Thailand without VPN ----------

  // the main three are closed abroad: on the projector they switch the WireGuard tunnel «ru» on, and off when you come back
  var TV_MAIN = [
    { id: 'sts', name: 'СТС', cls: 'w-sts', url: 'https://smotrim.ru/channel/258',
      about: 'Семейные комедии и сериалы: «Воронины», «Кухня», «Папины дочки», большое кино по выходным.' },
    { id: 'tnt', name: 'ТНТ', cls: 'w-tnt', url: 'https://smotrim.ru/channel/266',
      about: 'Юмор и ситкомы: Comedy Club, «Универ», «Интерны», «Однажды в России», стендап.' },
    { id: 'friday', name: 'Пятница!', cls: 'w-fri', url: 'https://smotrim.ru/channel/265',
      about: 'Путешествия и реалити: «Орёл и решка», «Ревизорро», «Адская кухня», «Мир наизнанку».' }
  ];
  // official live streams on RUTUBE that open from Thailand without VPN (checked 26.10.2026); on the projector they play right in our player
  var TV_FREE = [
    { id: 'perviy', name: 'Первый канал', rt: 'c58f502c7bb34a8fcdd976b221fca292' },
    { id: 'r1', name: 'Россия 1', rt: '2742a3c42be661ea732705f80adb7bdd' },
    { id: 'ntv', name: 'НТВ', rt: 'c37cd74192c6bc3d6cd6077c0c4fd686' },
    { id: 'stslove', name: 'СТС Love', rt: '32dc45cf878497abe1c9695e228f039b' },
    { id: 'subbota', name: 'Суббота!', rt: '310744c10a5809da38aa445c952976da' }
  ];
  function tvUrl(c) { return c.url || ('https://rutube.ru/live/video/' + c.rt + '/'); }
  function playTv(group, i) {
    var c = (group === 'm' ? TV_MAIN : TV_FREE)[i]; if (!c) return;
    if (AU && !AU.paused) AU.pause();
    if (group === 'm' && A.openVpn) A.openVpn(tvUrl(c));
    else if (c.rt && A.playLive) A.playLive(c.rt, c.name, tvUrl(c));
    else if (A.openUrl) A.openUrl(tvUrl(c));
  }

  function tvPage() {
    var web = document.documentElement.classList.contains('web');
    var h = '<div class="ctop">' + backBtn('tv-back') + statusLine() + '</div>' +
      '<section class="tvhead glass"><span class="hchip">Live</span><h1>TV</h1>' +
      '<p>Прямой эфир российских каналов. За границей СТС, ТНТ и Пятница закрыты, поэтому они идут через VPN' +
      (web ? ' — включи его перед тем, как открыть канал.' : ': при нажатии откроется VPN — нажми «Подключить» и «Назад», эфир включится сам. Когда вернёшься, VPN откроется снова, чтобы его выключить.') + '</p></section>' +
      '<div class="tvmain">';
    for (var i = 0; i < TV_MAIN.length; i++) {
      var c = TV_MAIN[i];
      h += '<button class="tvbig ' + c.cls + '" data-f data-key="tv-' + c.id + '" data-act="tvplay:m:' + i + '">' +
        '<span class="tvlive"><i></i>Эфир · VPN</span>' +
        '<span class="tvword">' + esc(c.name) + '</span>' +
        '<span class="tvabout">' + esc(c.about) + '</span></button>';
    }
    h += '</div><section class="tvfree"><h2 class="h2">Без VPN</h2><div class="tvchips">';
    for (var j = 0; j < TV_FREE.length; j++) h += '<button class="tvchip" data-f data-key="tvf-' + TV_FREE[j].id + '" data-act="tvplay:f:' + j + '"><i></i>' + esc(TV_FREE[j].name) + '</button>';
    return h + '</div></section>';
  }

  // ---------- audiobooks: a calm player for falling asleep ----------

  var lastHintView = '';
  function glitterHtml() {
    var h = '<div class="glitter" aria-hidden="true">';
    // a fixed scatter, so it doesn't jump between renders
    for (var i = 0; i < 46; i++) {
      var x = (i * 37 + 11) % 100, y = (i * 53 + 7) % 100, sz = 2 + (i * 7 % 5), d = 6 + (i * 13 % 9), dl = -(i * 1.7 % 9);
      h += '<i class="sp s' + (i % 3) + '" style="left:' + x + '%;top:' + y + '%;width:' + sz + 'px;height:' + sz + 'px;animation-duration:' + d + 's,' + (2 + i % 4) + 's;animation-delay:' + dl + 's,' + (dl / 2) + 's"></i>';
    }
    return h + '</div>';
  }
  var abLoadT = null;
  // the projector has no clock battery: after a power cut it wakes up on an old date
  function clockNote() {
    var off = 0; try { off = A.clockOff ? +A.clockOff() : 0; } catch (e) {}
    if (!off) return '';
    var d = Math.abs(off) >= 1440 ? Math.round(Math.abs(off) / 1440) + ' ' + plural(Math.round(Math.abs(off) / 1440), 'день', 'дня', 'дней') : Math.round(Math.abs(off) / 60) + ' ч';
    return '<div class="sub" style="margin-top:12px;color:#FFD27A">🕑 Часы проектора ' + (off > 0 ? 'отстают' : 'спешат') + ' на ' + d + '. Приложение уже работает по правильному времени, но Play Store и браузер — нет. Включи «Автоматически» в дате и времени:</div>' +
      '<div class="btns" style="margin-top:8px"><button class="btn" data-f data-key="date-set" data-act="dateset">🕑 Дата и время</button></div>';
  }
  // ---------- music: tracks of the Telegram channel ----------
  // The list comes from GitHub (a bot collects the channel's posts every half hour). The files stay in Telegram:
  // right before a track plays the bot is asked for a fresh link; covers are the tracks' own, as Telegram shows them.
  var MU = null, muQueue = [], muPos = -1, muShuffle = false, muErr = '';
  var muCov = {};
  try { muCov = JSON.parse(localStorage.getItem('muCov') || '{}') || {}; } catch (e) { muCov = {}; }
  function muData() { return S.music || {}; }
  // names from Telegram often carry the bot that made the file («рехаб @Snoopmusicbot»): that tail is dropped
  function muClean(t) {
    if (t._c) return t; t._c = 1;
    var c = function (x) { return String(x || '').replace(/\s*[\(\[]?@\w+bot[\)\]]?/gi, '').replace(/\s*[\(\[]?(?:t\.me\/\w+|vk\.com\/\w+)[\)\]]?/gi, '').replace(/\s{2,}/g, ' ').trim(); };
    var a = c(t.title), b = c(t.artist);
    if (a) t.title = a; t.artist = b;
    return t;
  }
  function muTracks() {
    var base = muData().tracks || [], seen = {}, out = [];
    base.forEach(function (t) { seen[t.uid] = 1; muClean(t); });
    // tracks the app already saw itself, until the GitHub job has them too; newest first
    (typeof muExtra !== 'undefined' ? muExtra : []).forEach(function (t) { muClean(t); if (!seen[t.uid]) { seen[t.uid] = 1; out.push(t); } });
    out.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    return out.concat(base);
  }
  function tgLink(fid) {
    var m = muData();
    if (!m.bot || !window.fetch) return Promise.reject(new Error('нет связи с Telegram'));
    return fetch('https://api.telegram.org/bot' + m.bot + '/getFile?file_id=' + encodeURIComponent(fid)).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) throw new Error(j.description || 'Telegram не отдал файл');
      return 'https://api.telegram.org/file/bot' + m.bot + '/' + j.result.file_path;
    });
  }
  // covers: a link lives about an hour, so it is kept for 50 minutes and asked again after that
  var muAsking = 0, muWait = [];
  function muCoverUrl(t) {
    var c = muCov[t.uid];
    if (c && Date.now() - c.at < 50 * 60000) return c.u;
    if (t.cover && muWait.indexOf(t) < 0) { muWait.push(t); muPump(); }
    return '';
  }
  function muPump() {
    while (muAsking < 3 && muWait.length) {
      var t = muWait.shift(); muAsking++;
      (function (t) {
        tgLink(t.cover).then(function (u) {
          muCov[t.uid] = { u: u, at: Date.now() };
          try { localStorage.setItem('muCov', JSON.stringify(muCov)); } catch (e) {}
          var im = document.querySelectorAll('img[data-mc="' + t.uid + '"]');
          for (var i = 0; i < im.length; i++) { im[i].src = u; im[i].style.display = ''; }
          if (muNow() === t) muMeta(t);
        }).catch(function () {}).then(function () { muAsking--; muPump(); });
      })(t);
    }
  }
  var MU_BIG = { mfcv: 1, mfbg: 1, mbg: 1, mpcv: 1, mbig: 1 };
  function muCoverImg(t, cls) {
    var hue = hash(t.uid || t.title || '') % 360, u = (MU_BIG[cls] && t.hq) || muCoverUrl(t);
    return '<span class="' + cls + '" style="background:linear-gradient(150deg,hsl(' + hue + ',60%,38%),hsl(' + ((hue + 70) % 360) + ',65%,16%))">' + I.note +
      '<img' + (MU_BIG[cls] && t.hq ? '' : ' data-mc="' + esc(t.uid) + '"') + ' alt=""' + (u ? ' src="' + esc(u) + '"' : ' style="display:none"') + ' onerror="this.style.display=\'none\'"></span>';
  }
  // new posts show up at once: the app peeks at the bot's fresh updates itself (the GitHub job saves them later)
  var muLiveAt = 0, muLiveBusy = false, muExtra = [];
  try { muExtra = JSON.parse(localStorage.getItem('muExtra') || '[]') || []; } catch (e) { muExtra = []; }
  function muLive() {
    var m = muData(); if (!m.bot || !window.fetch || muLiveBusy || Date.now() - muLiveAt < 45000) return;
    muLiveBusy = true; muLiveAt = Date.now();
    var ch = String((m.channel || {}).username || '').toLowerCase();
    fetch('https://api.telegram.org/bot' + m.bot + '/getUpdates?timeout=0&offset=' + (m.offset || 0) + '&allowed_updates=' + encodeURIComponent('["channel_post","edited_channel_post","message"]'))
      .then(function (r) { return r.json(); }).then(function (j) {
        var have = {}, added = 0;
        muTracks().forEach(function (t) { have[t.uid] = 1; });
        (j.result || []).forEach(function (u) {
          var msg = u.channel_post || u.edited_channel_post || u.message; if (!msg) return;
          var c = msg.chat || {}, fo = msg.forward_origin || {}, fc = fo.chat || msg.forward_from_chat || {};
          var mine = c.type === 'channel' ? String(c.username || '').toLowerCase() === ch : String(fc.username || '').toLowerCase() === ch;
          var a = msg.audio || (msg.document && /^audio\//.test(msg.document.mime_type || '') ? msg.document : null);
          if (!mine || !a || have[a.file_unique_id]) return;
          var nm = String(a.file_name || '').replace(/\.[^.]+$/, '');
          var t = { uid: a.file_unique_id, file: a.file_id, title: a.title || nm || 'Без названия', artist: a.performer || '', dur: a.duration || 0, at: fo.date || msg.forward_date || msg.date || 0 };
          var th = a.thumbnail || a.thumb; if (th) t.cover = th.file_id;
          muExtra.push(t); have[t.uid] = 1; added++;
        });
        if (added) { try { localStorage.setItem('muExtra', JSON.stringify(muExtra.slice(-200))); } catch (e) {} if (view.name === 'music') render(null, true); }
      }).catch(function () {}).then(function () { muLiveBusy = false; });
  }
  setInterval(function () { if (view.name === 'music') muLive(); }, 60000);
  var muRepeat = false;
  try { muRepeat = localStorage.getItem('muRepeat') === '1'; } catch (e) {}
  // artists: «A, B» and «A feat. B» count for each of them («Rauf & Faik» stays one duo)
  function muArtists(t) { return String(t.artist || '').split(/\s*(?:,|;|\(?\bfeat\.?|\(?\bft\.?|\(?\bприн\.)\s*/i).map(function (a) { return a.replace(/\)\s*$/, ''); }).map(function (a) { return a.trim(); }).filter(Boolean); }
  function muByArtist(name) { var n = name.toLowerCase(); return muTracks().filter(function (t) { return muArtists(t).some(function (a) { return a.toLowerCase() === n; }); }); }
  function muArtistList() {
    var map = {}, order = [];
    muTracks().forEach(function (t) { muArtists(t).forEach(function (a) { var k = a.toLowerCase(); if (!map[k]) { map[k] = { name: a, n: 0, t: t }; order.push(k); } map[k].n++; if (!map[k].t.cover && t.cover) map[k].t = t; }); });
    var pc = muPlays(null);
    muTracks().forEach(function (t) { var c = pc[t.uid]; if (c) muArtists(t).forEach(function (a) { map[a.toLowerCase()].p = (map[a.toLowerCase()].p || 0) + c[0]; }); });
    return order.map(function (k) { return map[k]; }).sort(function (a, b) { return (b.p || 0) - (a.p || 0) || b.n - a.n || a.name.localeCompare(b.name, 'ru'); });
  }
  // the list on screen: all tracks, or one artist's
  // ---------- favourites and playlists (shared through sync/state.json, every device) ----------
  var muLoc = { mfav: {}, mpl: {} }; // what was changed here, until the platform's state has it too
  function muSecGet(sec) {
    var a = S[sec] || {}, b = muLoc[sec], o = {}, k;
    for (k in a) o[k] = a[k];
    for (k in b) if (!o[k] || (b[k].t || 0) >= (o[k].t || 0)) o[k] = b[k];
    return o;
  }
  function muSet(sec, key, val) { val.t = Date.now(); muLoc[sec][key] = val; try { if (A && A.muSet) A.muSet(sec, key, JSON.stringify(val)); } catch (e) {} }
  function muIsFav(uid) { var f = muSecGet('mfav')[uid]; return !!(f && f.on); }
  function muFavList() { var f = muSecGet('mfav'); return muTracks().filter(function (t) { return f[t.uid] && f[t.uid].on; }).sort(function (a, b) { return (f[b.uid].t || 0) - (f[a.uid].t || 0); }); }
  function muPls() { var p = muSecGet('mpl'), out = []; for (var k in p) if (p[k] && !p[k].del) out.push({ id: k, name: p[k].name || 'Плейлист', tracks: p[k].tracks || [], c: p[k].c || 0 }); return out.sort(function (a, b) { return a.c - b.c; }); }
  function muPl(id) { var p = muSecGet('mpl')[id]; return p && !p.del ? { id: id, name: p.name || 'Плейлист', tracks: p.tracks || [], c: p.c || 0 } : null; }
  function muPlTracks(pl) { var by = {}; muTracks().forEach(function (t) { by[t.uid] = t; }); return (pl.tracks || []).map(function (u) { return by[u]; }).filter(Boolean); }
  function muPlSave(pl) { muSet('mpl', pl.id, { name: pl.name, tracks: pl.tracks, c: pl.c }); }
  function muPlNew(name, firstUid) {
    var n = muPls().length + 1, pl = { id: 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), name: name || 'Плейлист ' + n, tracks: firstUid ? [firstUid] : [], c: Date.now() };
    muPlSave(pl); return pl;
  }
  var SHARE_BASE = 'https://babylolya.github.io/l-cinema-web-/share.html';
  function b64u(str) {
    var bin = unescape(encodeURIComponent(str));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function muShareUrl(name, list) {
    var pack = function (u) { return String(u || '').replace('https://cdn-images.dzcdn.net/images/cover/', '~d').replace(/^https:\/\/is(\d)-ssl\.mzstatic\.com\/image\/thumb\//, '~a$1'); };
    var doc = { n: name, t: list.slice(0, 120).map(function (t) { return [t.title || '', t.artist || '', pack(t.hq), t.dur || 0]; }) };
    return SHARE_BASE + '#' + b64u(JSON.stringify(doc));
  }
  var shareNote = '';
  function muShare(name, list) {
    var url = muShareUrl(name, list), done = function (m) { shareNote = m; render('pl-share', true); setTimeout(function () { shareNote = ''; if (view.pl) render(null, true); }, 3500); };
    if (navigator.share) { navigator.share({ title: name, text: 'Плейлист «' + name + '»', url: url }).catch(function () {}); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(url).then(function () { done('Ссылка скопирована'); }, function () { done('Не получилось скопировать'); }); return; }
    done('Поделиться можно с айфона или Mac');
  }
  function muView() {
    if (view.pl === 'fav') return muFavList();
    if (view.pl) { var pl = muPl(view.pl); return pl ? muPlTracks(pl) : []; }
    return view.artist ? muByPlays(muByArtist(view.artist)) : muTracks();
  }
  // a little picture for a playlist: the covers of its first four tracks
  function muPlArt(list, cls) {
    if (!list.length) return '<span class="' + cls + ' plempty">' + I.note + '</span>';
    if (list.length < 4) return '<span class="' + cls + '">' + muCoverImg(list[0], 'plone') + '</span>';
    return '<span class="' + cls + ' plquad">' + list.slice(0, 4).map(function (t) { return muCoverImg(t, 'plq'); }).join('') + '</span>';
  }
  // ---------- plays: counted on every device, summed from sync/state.json ----------
  var muPC = { s: null, all: null };
  function muPlays(year) {
    if (!year && muPC.s === S.plays && muPC.all) return muPC.all;
    var out = {}, pl = S.plays || {};
    for (var d in pl) {
      var ys = (pl[d] || {}).y || {};
      for (var y in ys) {
        if (year && y !== String(year)) continue;
        var u = ys[y];
        for (var k in u) { var c = out[k] || (out[k] = [0, 0]); c[0] += +(u[k] || [])[0] || 0; c[1] += +(u[k] || [])[1] || 0; }
      }
    }
    if (!year) { muPC.s = S.plays; muPC.all = out; }
    return out;
  }
  function muCount(uid) { var c = muPlays(null)[uid]; return c ? c[0] : 0; }
  function muByPlays(l) { return l.map(function (t, i) { return [t, i]; }).sort(function (a, b) { return muCount(b[0].uid) - muCount(a[0].uid) || a[1] - b[1]; }).map(function (x) { return x[0]; }); }
  function muYm() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2); }
  var muL = null; // the listening going on now: seconds heard, counted as a play after 30 s
  function muFlush() {
    if (!muL) return;
    var n = muL.counted && !muL.cSent ? 1 : 0, sec = Math.floor(muL.sec - muL.sent);
    if (!n && sec < 1) return;
    if (n) muL.cSent = true;
    muL.sent += sec;
    try { if (A && A.addPlay) A.addPlay(muL.uid, n, sec, muYm()); } catch (e) {}
  }
  function muTrack() {
    var t = muNow(); if (!t || !MU) return;
    var c = MU.currentTime || 0;
    if (!muL || muL.uid !== t.uid) { muFlush(); muL = { uid: t.uid, sec: 0, sent: 0, counted: false, cSent: false, last: c }; return; }
    var d = c - muL.last; muL.last = c;
    if (d < -5) { muFlush(); muL = { uid: t.uid, sec: 0, sent: 0, counted: false, cSent: false, last: c }; return; } // started over (repeat)
    if (d > 0 && d < 3 && !MU.paused) muL.sec += d;
    if (!muL.counted && muL.sec >= Math.min(30, (t.dur || 60) * 0.5)) { muL.counted = true; muFlush(); }
    else if (muL.sec - muL.sent >= 120) muFlush();
  }
  document.addEventListener('visibilitychange', function () { if (document.hidden) muFlush(); });
  // artist photos come from Deezer (collected on GitHub with the tracks)
  function muArtInfo(name) { return ((muData().artists || {})[String(name || '').toLowerCase()]) || null; }
  function muArtImg(name, t, cls, big) {
    var a = muArtInfo(name), u = a && (big ? (a.big || a.img) : a.img);
    if (!u) return muCoverImg(t, cls);
    var hue = hash(name) % 360;
    return '<span class="' + cls + '" style="background:linear-gradient(150deg,hsl(' + hue + ',55%,34%),hsl(' + ((hue + 70) % 360) + ',60%,14%))">' + I.note +
      '<img alt="" src="' + esc(u) + '" onerror="this.style.display=\'none\'"></span>';
  }
  // the length Telegram gives with the post is exact; Safari guesses wrong on some MP3s (a 3-minute song showed as 6)
  function muDur(t) {
    var d = MU && isFinite(MU.duration) && MU.duration > 0 ? MU.duration : 0;
    if (t && t.dur > 0) return d && Math.abs(d - t.dur) < 3 ? d : t.dur;
    return d;
  }
  function muNow() { return muPos >= 0 ? muQueue[muPos] : null; }
  function muEnsure() {
    if (MU) return MU;
    MU = document.createElement('audio'); MU.loop = muRepeat;
    MU.preload = 'auto'; MU.style.display = 'none';
    document.body.appendChild(MU);
    MU.addEventListener('ended', function () { if (muRepeat) { try { MU.currentTime = 0; } catch (e) {} var p = MU.play(); if (p && p.catch) p.catch(function () {}); return; } muStep(1); });
    MU.addEventListener('play', muUi); MU.addEventListener('pause', muUi); MU.addEventListener('loadedmetadata', muUi);
    var muLast = 0;
    MU.addEventListener('timeupdate', function () { muTrack(); muPosState(false); if (Date.now() - muLast > 900) { muLast = Date.now(); muUi(); } });
    MU.addEventListener('play', function () { muPosState(true); }); MU.addEventListener('pause', function () { muFlush(); muPosState(true); }); MU.addEventListener('loadedmetadata', function () { muPosState(true); });
    MU.addEventListener('error', function () { muErr = 'Не получилось включить трек — пробую следующий'; muUi(); setTimeout(function () { muStep(1); }, 1500); });
    return MU;
  }
  function muStart(list, i) {
    if (AU && !AU.paused) AU.pause();
    muQueue = list.slice(); muPos = i;
    muLoad(true);
  }
  function muLoad(autoplay) {
    var t = muNow(); if (!t) return;
    var a = muEnsure(); muErr = '';
    a.removeAttribute('src');
    var uid = t.uid;
    tgLink(t.file).then(function (u) {
      var now = muNow(); if (!now || now.uid !== uid) return;
      a.src = u;
      if (autoplay) { var p = a.play(); if (p && p.catch) p.catch(function () { muErr = 'Нажми ▶, чтобы начать'; muUi(); }); }
    }).catch(function (e) { var m = (e && e.message) || ''; muErr = /fetch|network|load/i.test(m) || !m ? 'Нет связи с Telegram — проверь интернет' : m; muUi(); });
    muMeta(t);
    if (view.name === 'music') render(null, true);
  }
  // the lock screen and Control Center of the phone: cover, names, progress bar and buttons
  var muPosAt = 0;
  function muMeta(t) {
    var ms = navigator.mediaSession;
    if (!ms || !window.MediaMetadata || !t) return;
    try {
      var cu = t.hq || muCoverUrl(t), ic = location.href.replace(/[#?].*$/, '').replace(/[^\/]*$/, '') + 'icon-512.png';
      var art = cu ? (t.hq ? [{ src: cu, sizes: '1000x1000', type: 'image/jpeg' }] : [{ src: cu, sizes: '320x320', type: 'image/jpeg' }, { src: cu, sizes: '512x512', type: 'image/jpeg' }]) : [{ src: ic, sizes: '512x512', type: 'image/png' }];
      ms.metadata = new MediaMetadata({ title: t.title || '', artist: t.artist || '', album: (muData().channel || {}).title || 'L-CINEMA · Музыка', artwork: art });
      var hs = {
        play: function () { if (MU) { var p = MU.play(); if (p && p.catch) p.catch(function () {}); } },
        pause: function () { if (MU) MU.pause(); },
        nexttrack: function () { muStep(1); },
        previoustrack: function () { if (MU && MU.currentTime > 4) MU.currentTime = 0; else muStep(-1); },
        seekto: function (d) { if (MU && d && d.seekTime != null) { MU.currentTime = d.seekTime; muPosState(true); } }
      };
      for (var k in hs) { try { ms.setActionHandler(k, hs[k]); } catch (e) {} }
      // no ±10 s buttons: then the lock screen shows ⏮ ⏭ for tracks
      try { ms.setActionHandler('seekbackward', null); ms.setActionHandler('seekforward', null); } catch (e) {}
    } catch (e) {}
  }
  function muPosState(now) {
    var ms = navigator.mediaSession;
    if (!ms || !ms.setPositionState || !MU) return;
    if (!now && Date.now() - muPosAt < 4000) return;
    muPosAt = Date.now();
    var t = muNow(), dur = muDur(t);
    if (!dur) return;
    try { ms.setPositionState({ duration: dur, playbackRate: MU.playbackRate || 1, position: Math.min(dur, Math.max(0, MU.currentTime || 0)) }); } catch (e) {}
    try { ms.playbackState = MU.paused ? 'paused' : 'playing'; } catch (e) {}
  }
  function muStep(d) {
    if (!muQueue.length) return;
    muPos = (muPos + d + muQueue.length) % muQueue.length;
    muLoad(true);
  }
  function muToggle() {
    if (!MU || !muNow()) { var l = muTracks(); if (l.length) muStart(muShuffle ? shuffled(l) : l, 0); return; }
    if (MU.paused) { var p = MU.play(); if (p && p.catch) p.catch(function () {}); } else MU.pause();
  }
  function shuffled(l) { var a = l.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var x = a[i]; a[i] = a[j]; a[j] = x; } return a; }
  function muUi() {
    muNative();
    var t = muNow();
    var bt = document.getElementById('mu-pp'); if (bt) bt.innerHTML = MU && !MU.paused ? I.pause : I.play;
    var mb = document.getElementById('mm-pp'); if (mb) mb.innerHTML = MU && !MU.paused ? I.pause : I.play;
    var mm = document.querySelector('.mmini');
    if (mm && (!muMiniOn() || mm.getAttribute('data-uid') !== (t && t.uid))) { if (mm.contains(document.activeElement)) mm = null; else { mm.parentNode.removeChild(mm); mm = null; } }
    if (!mm && muMiniOn()) { var d0 = document.createElement('div'); d0.innerHTML = muMini(); if (d0.firstChild) root.appendChild(d0.firstChild); }
    // a stream from Telegram may not tell its length to old browsers (Infinity): the length from the post is used then
    var dur = muDur(t);
    var mf = document.getElementById('mm-fill'); if (mf && MU) mf.style.width = (dur ? Math.min(100, MU.currentTime / dur * 100) : 0).toFixed(2) + '%';
    var tl = document.querySelector('.mftl.drag');
    var f = tl ? null : document.getElementById('mu-fill'); if (f && MU) f.style.width = (dur ? Math.min(100, MU.currentTime / dur * 100) : 0).toFixed(2) + '%';
    var c = document.getElementById('mu-cur'); if (c && MU) c.textContent = fmtT(MU.currentTime);
    var d = document.getElementById('mu-dur'); if (d && t) d.textContent = '-' + fmtT(Math.max(0, dur - (MU ? MU.currentTime : 0)));
    var e = document.getElementById('mu-err'); if (e) { e.textContent = muErr; e.style.display = muErr ? '' : 'none'; }
    var rows = document.querySelectorAll('.mrow');
    for (var i = 0; i < rows.length; i++) { var on = !!t && rows[i].getAttribute('data-uid') === t.uid; if (on) rows[i].classList.add('cur'); else rows[i].classList.remove('cur'); }
    var nv = document.querySelector('[data-key="nav-music"]'); if (nv) nv.classList.toggle('live', (!!MU && !MU.paused) || (!!AU && !AU.paused));
  }
  setInterval(function () { if (MU && !MU.paused) muUi(); }, 1000);
  // projector: tell Android what plays, so the Bluetooth speaker's buttons come to this player
  var muSent = '', muSentAt = 0;
  function muNative() {
    if (!A || !A.mediaState) return;
    var t = muNow();
    if (!t || !MU) { if (muSent) { muSent = ''; try { A.mediaOff(); } catch (e) {} } return; }
    var key = t.uid + (MU.paused ? 'p' : 'r');
    if (key === muSent && Date.now() - muSentAt < 15000) return;
    muSent = key; muSentAt = Date.now();
    try { A.mediaState(!MU.paused, t.title || '', t.artist || '', Math.round((MU.currentTime || 0) * 1000), Math.round(muDur(t) * 1000)); } catch (e) {}
  }

  // «Музыка» has two tabs: the channel's tracks and the audiobooks (with meditations inside)
  function listenTabs(cur) {
    return '<div class="chips ltabs">' +
      '<button class="chip' + (cur === 'music' ? ' on' : '') + '" data-f data-key="lt-music" data-act="ltab:music">♪ Треки</button>' +
      '<button class="chip' + (cur === 'books' ? ' on' : '') + '" data-f data-key="lt-books" data-act="ltab:books">Аудиокниги</button>' +
      (cur === 'music' ? '<button class="chip wrchip' + (view.wrap ? ' on' : '') + '" data-f data-key="lt-wrap" data-act="muwrap">✦ Мой ' + muWrapYear() + '</button>' : '') + '</div>';
  }
  // an artist without a photo colour still gets one of its own, from the name
  function muNameColor(n) {
    var h = (hash(String(n || '').toLowerCase()) % 360) / 60, s = 0.42, v = 0.5, i = Math.floor(h), f = h - i;
    var p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f)), rgb = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
    return '#' + rgb.map(function (x) { return ('0' + Math.round(x * 255).toString(16)).slice(-2); }).join('');
  }
  function hexA(hex, al) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return 'rgba(22,18,28,' + al + ')';
    var n = parseInt(m[1], 16); return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + al + ')';
  }
  // the glass bar at the bottom while a track is on (phone: every screen; TV and Mac: in «Музыка»)
  var muFull = false, muFullShown = false;
  // focusing a button inside the big player must never scroll the sheet itself (it left a strip at the bottom)
  document.addEventListener('scroll', function (e) { var t = e.target; if (t && t.classList && (t.classList.contains('mfull') || t.classList.contains('mfcard'))) { t.scrollTop = 0; t.scrollLeft = 0; } }, true);
  function muMiniOn() { return !!(muNow() && MU) && !muFull && (document.documentElement.className.indexOf('web') >= 0 || view.name === 'music'); }
  function muMini() {
    var t = muNow();
    if (!muMiniOn()) return '';
    var web = document.documentElement.className.indexOf('web') >= 0;
    return '<div class="mmini" data-uid="' + esc(t.uid) + '"><button class="mmtx" data-f data-key="mm-open" data-act="muopen">' + muCoverImg(t, 'mmcv') +
      '<span class="mmt"><span class="mtt">' + esc(t.title) + '</span><span class="mta">' + esc(t.artist || '') + '</span></span></button>' +
      (web ? '' : '<button class="mmb" data-f data-key="mm-prev" data-act="muprev" aria-label="Предыдущий трек">' + I.prev + '</button>') +
      '<button class="mmb mmfav' + (muIsFav(t.uid) ? ' fav' : '') + '" data-f data-key="mm-fav" data-act="mufav" aria-label="В избранное">' + (muIsFav(t.uid) ? I.heartOn : I.heartO) + '</button>' +
      '<button class="mmb mmpp" id="mm-pp" data-f data-key="mm-pp" data-act="mutoggle" aria-label="Пауза">' + (MU.paused ? I.play : I.pause) + '</button>' +
      '<button class="mmb" data-f data-key="mm-next" data-act="munext" aria-label="Следующий трек">' + I.next + '</button>' +
      '<span class="mmline"><i id="mm-fill"></i></span></div>';
  }
  // tap the bar: the wide player opens (cover, artist, timeline you can drag, all the buttons)
  function muFullHtml() {
    var t = muNow();
    if (!muFull || !t) { muFullShown = false; return ''; }
    var who = muArtists(t), playing = MU && !MU.paused;
    // drawn again for the next track: no fade-in this time, or the list behind flashes through for a moment
    var still = muFullShown; muFullShown = true;
    return '<div class="mfull' + (still ? ' still' : '') + '">' + muCoverImg(t, 'mfbg') + '<span class="mfsh"></span>' +
      '<div class="mfcard">' +
        '<button class="mfclose" data-f data-key="mf-close" data-act="muclose" aria-label="Свернуть">' + I.chev + '</button>' +
        muCoverImg(t, 'mfcv') +
        '<div class="mfinfo">' +
          '<div class="mfhead">' + (who.length ? '<button class="mppill mfpill" data-f data-key="mf-art" data-act="muartist:' + esc(who[0]) + '">' + muArtImg(who[0], t, 'mpav') + '<span class="mpwho"><b>' + esc(t.artist) + '</b><small>Исполнитель</small></span></button>' : '<span></span>') +
            '<span class="mfacts"><button class="mfround' + (muIsFav(t.uid) ? ' fav' : '') + '" data-f data-key="mf-fav" data-act="mufav" aria-label="В избранное">' + (muIsFav(t.uid) ? I.heartOn : I.heartO) + '</button>' +
            '<button class="mfround" data-f data-key="mf-add" data-act="mupick" aria-label="В плейлист">' + I.plus + '</button></span></div>' +
          '<div class="mftt">' + esc(t.title) + '</div>' +
          '<div class="abst" id="mu-err" style="display:none"></div>' +
          '<div class="mftl" tabindex="0" data-f data-key="mf-tl" aria-label="Перемотка"><div class="mfbar"><i class="mffill" id="mu-fill"><b></b></i></div></div>' +
          '<div class="mftimes"><span id="mu-cur">0:00</span><span id="mu-dur">-' + fmtT(t.dur) + '</span></div>' +
          '<div class="mfbtns">' +
            '<button class="mpround' + (muShuffle ? ' on' : '') + '" data-f data-key="mu-shuf" data-act="mushuffle" aria-label="Вперемешку">' + I.shuffle + '</button>' +
            '<button class="mfb" data-f data-key="mu-prev" data-act="muprev" aria-label="Предыдущий трек">' + I.prev + '</button>' +
            '<button class="mfb mfplay" id="mu-pp" data-f data-key="mu-play" data-act="mutoggle" aria-label="Играть">' + (playing ? I.pause : I.play) + '</button>' +
            '<button class="mfb" data-f data-key="mu-next" data-act="munext" aria-label="Следующий трек">' + I.next + '</button>' +
            '<button class="mpround' + (muRepeat ? ' on' : '') + '" data-f data-key="mu-rep" data-act="murepeat" aria-label="Повторять трек">' + I.repeat + '</button>' +
          '</div></div></div>' + muPickHtml(t) + '</div>';
  }
  // «В плейлист»: a list of playlists with ticks; tap to put the track in or take it out; or make a new one
  var muPick = false;
  function muPickHtml(t) {
    if (!muPick || !t) return '';
    var h = '<div class="mpick"><div class="mpcard"><div class="mphd"><b>Добавить в плейлист</b><button class="mfround" data-f data-key="mp-close" data-act="mupickclose" aria-label="Закрыть">' + I.close + '</button></div><div class="mpls">';
    var fav = muIsFav(t.uid);
    h += '<button class="mprow' + (fav ? ' on' : '') + '" data-f data-key="mp-fav" data-act="mufav">' + '<span class="mpic favic">' + I.heartOn + '</span><span class="mpnm">Избранное</span><span class="mpck">' + (fav ? I.check : '') + '</span></button>';
    muPls().forEach(function (pl) {
      var on = pl.tracks.indexOf(t.uid) >= 0;
      h += '<button class="mprow' + (on ? ' on' : '') + '" data-f data-key="mp-' + esc(pl.id) + '" data-act="mupladd:' + esc(pl.id) + '">' + muPlArt(muPlTracks(pl), 'mpic') +
        '<span class="mpnm">' + esc(pl.name) + '<small>' + pl.tracks.length + ' ' + plural(pl.tracks.length, 'трек', 'трека', 'треков') + '</small></span><span class="mpck">' + (on ? I.check : '') + '</span></button>';
    });
    h += '</div><div class="mpnew"><input id="mp-name" class="mpin" data-f data-key="mp-in" data-enter="muplnew" maxlength="40" placeholder="Новый плейлист" autocomplete="off">' +
      '<button class="mpmk" data-f data-key="mp-mk" data-act="muplnew">' + I.plus + 'Создать</button></div></div></div>';
    return h;
  }
  // the sheet leaves the way it came: down into the bar
  function muCloseFull(fromY) {
    var f = document.querySelector('.mfull'), c = f && f.querySelector('.mfcard');
    if (!f || !c || f.classList.contains('out')) { muFull = false; render('mm-open', true); return; }
    f.classList.add('out');
    if (fromY != null) c.style.transform = 'translateY(' + fromY + 'px)';
    // next frame: let the sheet travel from where it is now to below the screen
    requestAnimationFrame(function () { c.style.transition = ''; c.style.transform = ''; f.classList.add('go'); });
    setTimeout(function () { muFull = false; render('mm-open', true); }, 300);
  }
  // phone: pull the sheet down with the finger; let go far or fast enough and it closes, otherwise it springs back
  (function () {
    var st = null;
    document.addEventListener('touchstart', function (e) {
      var c = e.target && e.target.closest ? e.target.closest('.mfcard') : null;
      if (!c || e.target.closest('.mftl') || document.documentElement.className.indexOf('web') < 0) return;
      var y = e.touches[0].clientY;
      st = { c: c, y0: y, x0: e.touches[0].clientX, dy: 0, h: [[y, Date.now()]], on: false };
    }, { passive: true });
    document.addEventListener('touchmove', function (e) {
      if (!st) return;
      var y = e.touches[0].clientY, dy = y - st.y0, dx = e.touches[0].clientX - st.x0;
      if (!st.on) { if (Math.abs(dy) < 10 && Math.abs(dx) < 10) return; if (dy < 0 || Math.abs(dx) > Math.abs(dy)) { st = null; return; } st.on = true; st.c.style.transition = 'none'; }
      st.dy = dy > 0 ? dy : -Math.pow(-dy, 0.6); // a little give upwards, then it resists
      st.c.style.transform = 'translateY(' + st.dy + 'px)';
      st.h.push([y, Date.now()]); if (st.h.length > 5) st.h.shift();
      if (e.cancelable) e.preventDefault();
    }, { passive: false });
    document.addEventListener('touchend', function () {
      if (!st || !st.on) { st = null; return; }
      var a = st.h[0], b = st.h[st.h.length - 1], v = (b[0] - a[0]) / Math.max(1, b[1] - a[1]); // px per ms
      var c = st.c, dy = st.dy; st = null;
      var land = dy + v * 1000 * 0.998 / (1 - 0.998) / 1000; // where the flick would carry it
      if (land > 160 || v > 0.6) muCloseFull(dy);
      else { c.style.transition = 'transform .45s cubic-bezier(.2,.9,.25,1)'; c.style.transform = ''; setTimeout(function () { c.style.transition = ''; }, 460); }
    });
  })();
  function muSeekTo(frac) {
    if (!MU) return; var t = muNow(), dur = muDur(t);
    if (!dur) return; try { MU.currentTime = Math.max(0, Math.min(dur - 0.5, frac * dur)); } catch (e) {} muUi(); muPosState(true);
  }
  function muSeekBy(sec) { if (!MU) return; try { MU.currentTime = Math.max(0, (MU.currentTime || 0) + sec); } catch (e) {} muUi(); muPosState(true); }
  (function () {
    var drag = null;
    function frac(e, el) { var r = el.getBoundingClientRect(), x = e.touches && e.touches.length ? e.touches[0].clientX : (e.changedTouches && e.changedTouches.length ? e.changedTouches[0].clientX : e.clientX); return Math.max(0, Math.min(1, (x - r.left) / (r.width || 1))); }
    function show(f) { var el = document.getElementById('mu-fill'); if (el) el.style.width = (f * 100).toFixed(2) + '%'; }
    function start(e) { var el = e.target && e.target.closest ? e.target.closest('.mftl') : null; if (!el) return; drag = el; el.classList.add('drag'); show(frac(e, el)); if (e.cancelable) e.preventDefault(); }
    function moveD(e) { if (!drag) return; show(frac(e, drag)); if (e.cancelable) e.preventDefault(); }
    function end(e) { if (!drag) return; var f = frac(e, drag); drag.classList.remove('drag'); drag = null; muSeekTo(f); }
    document.addEventListener('touchstart', start, { passive: false }); document.addEventListener('touchmove', moveD, { passive: false }); document.addEventListener('touchend', end);
    document.addEventListener('mousedown', start); document.addEventListener('mousemove', moveD); document.addEventListener('mouseup', end);
  })();
  // ---------- the year in music («Хей, Лоля! В этом году ты послушала…») ----------
  var MONTHS_N = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  function fmtNum(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function muLen(l) { var sec = 0; l.forEach(function (t) { sec += t.dur || 0; }); var m = Math.round(sec / 60); return m >= 60 ? Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин' : m + ' мин'; }
  function muWrapYear() { var d = new Date(); return d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear(); }
  function muYearStats(year) {
    var pc = muPlays(year), byUid = {}, tr = [], arts = {}, sec = 0, n = 0, months = {};
    muTracks().forEach(function (t) { byUid[t.uid] = t; });
    for (var u in pc) {
      sec += pc[u][1]; n += pc[u][0];
      var t = byUid[u]; if (!t) continue;
      tr.push({ t: t, n: pc[u][0], sec: pc[u][1] });
      muArtists(t).forEach(function (a) { var k = a.toLowerCase(), o = arts[k] || (arts[k] = { name: a, n: 0, sec: 0, t: t }); o.n += pc[u][0]; o.sec += pc[u][1]; });
    }
    var pl = S.plays || {};
    for (var d in pl) { var m = (pl[d] || {}).m || {}; for (var ym in m) if (ym.slice(0, 4) === String(year)) months[ym] = (months[ym] || 0) + (+m[ym] || 0); }
    var best = null; for (var k in months) if (!best || months[k] > months[best]) best = k;
    tr.sort(function (a, b) { return b.n - a.n || b.sec - a.sec; });
    var al = Object.keys(arts).map(function (k) { return arts[k]; }).sort(function (a, b) { return b.sec - a.sec || b.n - a.n; });
    return { sec: sec, n: n, tracks: tr, artists: al, month: best, monthSec: best ? months[best] : 0 };
  }
  function muWrapped(year) {
    var st = muYearStats(year), d = new Date(), final = d.getFullYear() > year || (d.getMonth() === 11 && d.getDate() === 31);
    var min = Math.round(st.sec / 60), hrs = Math.round(st.sec / 3600);
    var h = '<div class="wrhero"><div class="wrk">Итоги ' + year + '</div><div class="wrhi">Хей, Лоля!</div><p>' +
      (final ? 'Вот каким был твой ' + year + ' в музыке.' : 'Вот твой ' + year + ' в музыке на сегодня. Полные итоги соберутся 31 декабря, я покажу их сама.') + '</p></div>';
    if (!st.n && st.sec < 60) return h + '<div class="empty glass"><h1>Пока нечего считать</h1><p>Включи пару треков, и здесь появятся твои цифры. Считаются прослушивания со всех устройств: проектор, телевизор, Mac и айфон.</p></div>';
    h += '<div class="wrbig"><div class="wrnum">' + fmtNum(min) + '</div><div class="wrlbl">' + plural(min, 'минута', 'минуты', 'минут') + ' музыки' + (hrs >= 2 ? ', это ' + hrs + ' ' + plural(hrs, 'час', 'часа', 'часов') : '') + '</div></div>';
    h += '<div class="wrtiles">' +
      '<div class="wrtile"><b>' + fmtNum(st.n) + '</b><span>' + plural(st.n, 'прослушивание', 'прослушивания', 'прослушиваний') + '</span></div>' +
      '<div class="wrtile"><b>' + st.tracks.length + '</b><span>' + plural(st.tracks.length, 'трек', 'трека', 'треков') + '</span></div>' +
      '<div class="wrtile"><b>' + st.artists.length + '</b><span>' + plural(st.artists.length, 'исполнитель', 'исполнителя', 'исполнителей') + '</span></div></div>';
    var top = st.artists[0];
    if (top) h += '<button class="wrstar" data-f data-key="wr-star" data-act="muartist:' + esc(top.name) + '">' + muArtImg(top.name, top.t, 'wrsimg', true) +
      '<span class="wrstx"><span class="wrk">Исполнитель года</span><span class="wrsn">' + esc(top.name) + '</span><span class="wrss">' + fmtNum(Math.round(top.sec / 60)) + ' ' + plural(Math.round(top.sec / 60), 'минута', 'минуты', 'минут') + ' · ' + top.n + ' ' + plural(top.n, 'прослушивание', 'прослушивания', 'прослушиваний') + '</span></span></button>';
    if (st.artists.length > 1) {
      h += '<div class="h2 masub">Топ исполнителей</div><div class="marow row" data-row="wra">';
      st.artists.slice(0, 10).forEach(function (a, i) { h += '<button class="macard" data-f data-key="wa-' + esc(a.name) + '" data-act="muartist:' + esc(a.name) + '">' + '<span class="maring">' + muArtImg(a.name, a.t, 'macv') + '</span>' + '<span class="man">' + (i + 1) + '. ' + esc(a.name) + '</span><span class="mac">' + a.n + ' ' + plural(a.n, 'раз', 'раза', 'раз') + '</span></button>'; });
      h += '</div>';
    }
    h += '<div class="h2 masub">Топ треков</div>';
    st.tracks.slice(0, 10).forEach(function (x, i) {
      h += '<button class="mrow" data-f data-key="wt-' + esc(x.t.uid) + '" data-act="muwtop:' + i + '"><span class="mrank">' + (i + 1) + '</span>' + muCoverImg(x.t, 'mcv') +
        '<span class="mtx"><span class="mtt">' + esc(x.t.title) + '</span><span class="mta">' + esc(x.t.artist || '') + '</span></span><span class="mdur">' + x.n + ' ' + plural(x.n, 'раз', 'раза', 'раз') + '</span></button>';
    });
    if (st.month) h += '<div class="wrmonth"><span class="wrk">Самый музыкальный месяц</span><b>' + MONTHS_N[+st.month.slice(5, 7) - 1] + '</b><span>' + fmtNum(Math.round(st.monthSec / 60)) + ' ' + plural(Math.round(st.monthSec / 60), 'минута', 'минуты', 'минут') + '</span></div>';
    h += '<div class="wrend"><button class="btn pri" data-f data-key="wr-play" data-act="muwtop:0">' + I.play + ' Слушать мой топ</button></div>';
    return h;
  }
  // on 31 December (and through January) the year's summary opens by itself, once
  var muWrapChecked = false;
  function muWrapAuto() {
    if (muWrapChecked || !S.music) return; muWrapChecked = true;
    var d = new Date(), y = d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear();
    if (!((d.getMonth() === 11 && d.getDate() === 31) || d.getMonth() === 0)) return;
    var seen = ''; try { seen = localStorage.getItem('wrapShown') || ''; } catch (e) {}
    if (seen === String(y)) return;
    var st = muYearStats(y); if (st.sec < 600) return;
    try { localStorage.setItem('wrapShown', String(y)); } catch (e) {}
    go({ name: 'music', wrap: y }, 'lt-wrap');
  }
  function music() {
    muLive();
    var m = muData(), all = muTracks(), list = muView(), ch = m.channel || {};
    var sub = !!(view.artist || view.pl || view.wrap);
    var h = (sub ? '<div class="rbar">' + backBtn(view.pl ? 'pl-back' : (view.wrap ? 'wr-back' : 'ma-back')) + '</div>' : '') + '<div class="topline"><h1 class="title-glow">Музыка</h1>' + statusLine() + '</div>' + listenTabs('music');
    if (view.artist && !list.length && all.length) { view = { name: 'music' }; list = all; }
    if (view.wrap) return h + '<div class="mwrap"><section class="mlist mwr">' + muWrapped(view.wrap) + '</section></div>';
    if (!all.length) return h + '<div class="empty glass"><h1>Пока пусто</h1><p>Новые треки из канала' + (ch.username ? ' @' + esc(ch.username) : '') +
      ' появятся здесь сами, в течение получаса после публикации. Старые треки перешли из канала боту в личку — он их тоже заберёт.</p></div>';
    var t = muNow(), playing = MU && !MU.paused;
    h += '<div class="mwrap">';
    h += '<section class="mlist">';
    if (view.artist) {
      var ap = 0; list.forEach(function (x) { ap += muCount(x.uid); });
      var ai = muArtInfo(view.artist) || {}, col = ai.color || muNameColor(view.artist);
      h += '<div class="yahero">' + muArtImg(view.artist, list[0], 'yaimg', true) +
        '<span class="yagrad" style="background:linear-gradient(to bottom,' + hexA(col, 0) + ' 30%,' + hexA(col, 0.55) + ' 62%,' + col + ' 100%)"></span>' +
        '<div class="yain"><div class="yaname">' + esc(view.artist) + '</div>' +
          '<span class="yacap">' + I.phones + (ap ? fmtNum(ap) + ' ' + plural(ap, 'прослушивание', 'прослушивания', 'прослушиваний') : 'ещё не слушала') + ' · ' + list.length + ' ' + plural(list.length, 'трек', 'трека', 'треков') + '</span>' +
          '<div class="yabtns"><button class="btn pri" data-f data-key="ma-play" data-act="muartplay">' + I.play + ' Слушать</button>' +
          '<button class="btn" data-f data-key="ma-shuf" data-act="muartshuf">' + I.shuffle + ' Вперемешку</button></div>' +
        '</div></div>' +
        '<div class="h2 masub">Популярные треки</div>';
    }
    else if (view.pl) {
      var isFav = view.pl === 'fav', pl0 = isFav ? null : muPl(view.pl);
      if (!isFav && !pl0) { view = { name: 'music' }; return music(); }
      var nm = isFav ? 'Избранное' : pl0.name;
      h += '<div class="plhero' + (isFav ? ' isfav' : '') + '">' + (isFav ? '<span class="plbig favbig">' + I.heartOn + '</span>' : muPlArt(list, 'plbig')) +
        '<div class="plin">' +
        '<div class="plk">' + (isFav ? 'Мои любимые' : 'Плейлист') + '</div>' +
        (view.rename && !isFav ? '<div class="plren"><input id="pl-name" class="mpin" data-f data-key="pl-in" data-enter="muplsave" maxlength="40" value="' + esc(nm) + '" autocomplete="off"><button class="mpmk" data-f data-key="pl-ok" data-act="muplsave">' + I.check + 'Готово</button></div>'
          : '<div class="plname">' + esc(nm) + '</div>') +
        (shareNote ? '<div class="plnote">' + esc(shareNote) + '</div>' : '') +
        '<div class="plsub">' + list.length + ' ' + plural(list.length, 'трек', 'трека', 'треков') + (list.length ? ' · ' + muLen(list) : '') + '</div>' +
        '<div class="yabtns plbtns">' + (list.length ? '<button class="btn pri" data-f data-key="pl-play" data-act="muplay:0">' + I.play + ' Слушать</button><button class="btn" data-f data-key="pl-shuf" data-act="muallshuf:pl">' + I.shuffle + ' Вперемешку</button>' : '') +
          (list.length ? '<button class="btn" data-f data-key="pl-share" data-act="muplshare">' + I.share + ' Поделиться</button>' : '') +
          (isFav ? '' : '<button class="btn" data-f data-key="pl-ren" data-act="muplren">' + I.pen + ' Название</button><button class="btn' + (confirmKey === 'pl-del' ? ' warn' : '') + '" data-f data-key="pl-del" data-act="mupldel">' + I.trash + (confirmKey === 'pl-del' ? ' Точно удалить?' : ' Удалить') + '</button>') +
        '</div></div></div>';
      if (!list.length) h += '<div class="plnone">' + (isFav ? 'Нажми ♡ в плеере, и трек появится здесь.' : 'Пока пусто. Открой плеер и нажми «+», чтобы добавить сюда трек.') + '</div>';
    }
    else {
      // «Моя музыка»: favourites and playlists
      var pls = muPls(), favs = muFavList();
      h += '<div class="h2 masub">Моя музыка</div><div class="marow row plrow" data-row="pl">' +
        '<button class="pltile" data-f data-key="pl-fav" data-act="muplopen:fav"><span class="plart favbig">' + I.heartOn + '</span><span class="man">Избранное</span><span class="mac">' + favs.length + ' ' + plural(favs.length, 'трек', 'трека', 'треков') + '</span></button>';
      pls.forEach(function (pl) {
        var pt = muPlTracks(pl);
        h += '<button class="pltile" data-f data-key="pl-' + esc(pl.id) + '" data-act="muplopen:' + esc(pl.id) + '">' + muPlArt(pt, 'plart') + '<span class="man">' + esc(pl.name) + '</span><span class="mac">' + pt.length + ' ' + plural(pt.length, 'трек', 'трека', 'треков') + '</span></button>';
      });
      h += '<button class="pltile" data-f data-key="pl-new" data-act="muplmake"><span class="plart plnew">' + I.plus + '</span><span class="man">Новый плейлист</span><span class="mac">&nbsp;</span></button></div>';
      var arts = muArtistList();
      if (arts.length > 1) {
        h += '<div class="h2 masub">Исполнители</div><div class="marow row" data-row="ma">';
        arts.forEach(function (a) { h += '<button class="macard" data-f data-key="ma-' + esc(a.name) + '" data-act="muartist:' + esc(a.name) + '">' + '<span class="maring">' + muArtImg(a.name, a.t, 'macv') + '</span>' + '<span class="man">' + esc(a.name) + '</span><span class="mac">' + a.n + ' ' + plural(a.n, 'трек', 'трека', 'треков') + '</span></button>'; });
        h += '</div>';
      }
      h += '<div class="mallh"><span class="h2 masub">Все треки</span><span class="mallc">' + list.length + ' ' + plural(list.length, 'трек', 'трека', 'треков') + '</span></div>' +
        '<div class="mallb"><button class="mallbtn" data-f data-key="mu-all" data-act="muplay:0">' + I.play + 'Слушать</button>' +
        '<button class="mallbtn" data-f data-key="mu-allshuf" data-act="muallshuf">' + I.shuffle + 'Вперемешку</button></div>';
    }
    for (var i = 0; i < list.length; i++) {
      var x = list[i];
      h += '<button class="mrow' + (t && t.uid === x.uid ? ' cur' : '') + '" data-uid="' + esc(x.uid) + '" data-f data-key="mt-' + esc(x.uid) + '" data-act="muplay:' + i + '">' +
        (view.artist ? '<span class="mrank">' + (i + 1) + '</span>' : '') + muCoverImg(x, 'mcv') + '<span class="mtx"><span class="mtt">' + esc(x.title) + '</span><span class="mta">' + esc(x.artist || '') + (muIsFav(x.uid) ? '<i class="mfavi">' + I.heartOn + '</i>' : '') + (muCount(x.uid) ? '<i class="mplc">' + I.play + muCount(x.uid) + '</i>' : '') + '</span></span>' +
        '<span class="mdur">' + (t && t.uid === x.uid && playing ? '<i class="eq"><b></b><b></b><b></b></i>' : fmtT(x.dur)) + '</span></button>';
    }
    return h + '</section></div>';
  }

  function abDrivePlayer(fid) {
    abStatus('');
    var box = document.getElementById('abdrive');
    if (!box) return;
    box.innerHTML = '<iframe src="https://drive.google.com/file/d/' + fid + '/preview" allow="autoplay" title="Плеер Google Диска"></iframe>' +
      '<div class="abdnote">На айфоне эта часть играет через плеер Google Диска — нажми ▶ в нём. Следующая часть: кнопка ⏭ выше.</div>';
    box.style.display = '';
  }
  function abStatus(t) { var el = document.getElementById('abst'); if (el) { el.textContent = t; el.style.display = t ? '' : 'none'; } }
  var AU = null, abTick = null, abSleep = 0, abSleepEnd = 0, abFading = false, abDimT = null;
  var SLEEP_STEPS = [0, 15, 30, 45, 60, 90];

  function abList() { return S.audiobooks || []; }
  function abById(id) { var l = abList(); for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i]; return null; }
  function abSaved(id) { try { return JSON.parse(localStorage.getItem('ab:' + id) || 'null') || { c: 0, t: 0 }; } catch (e) { return { c: 0, t: 0 }; } }
  function abSave(id, c, t, d) { try { localStorage.setItem('ab:' + id, JSON.stringify({ c: c, t: Math.floor(t), d: Math.floor(d || 0), at: Date.now() })); } catch (e) {} }
  function fmtT(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), x = sec % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (x < 10 ? '0' : '') + x;
  }
  function abCover(b, cls) {
    var hue = hash(b.id) % 360;
    return '<div class="' + cls + '" style="background:linear-gradient(150deg,hsl(' + hue + ',55%,32%) 0%,hsl(' + ((hue + 60) % 360) + ',60%,14%) 100%)">' +
      '<span class="abct">' + esc(b.title || '') + '</span>' +
      (b.cover ? '<img src="' + esc(b.cover) + '" alt="" onerror="this.remove()">' : '') + '</div>';
  }

  function books() {
    var list = abList();
    var h = '<div class="topline"><h1 class="title-glow">Музыка</h1>' + statusLine() + '</div>' + listenTabs('books');
    if (!list.length && !(S.ytChannels || []).length) return h + '<div class="empty glass"><h1>Пока пусто</h1><p>Создай на Google Диске в папке с фильмами папку «аудиокниги», а в ней — по папке на каждую книгу с mp3-файлами. После «Обновить» книги появятся здесь.</p></div>';
    var cur = AU && AU.getAttribute('data-book');
    // tabs on top: everything, plain books, meditations and any other subfolder
    var cats = ['Все', 'Книги', 'Медитации'];
    list.forEach(function (b) { if (b.category && cats.indexOf(b.category) < 0) cats.push(b.category); });
    var pick = view.cat || 'Все';
    h += '<div class="chips abcats">';
    for (var ci2 = 0; ci2 < cats.length; ci2++) h += '<button class="chip' + (cats[ci2] === pick ? ' on' : '') + '" data-f data-key="abcat-' + esc(cats[ci2]) + '" data-act="abcat:' + esc(cats[ci2]) + '">' + (cats[ci2] === 'Медитации' ? '✦ ' : '') + esc(cats[ci2]) + '</button>';
    h += '</div>';
    list = list.filter(function (b) { return pick === 'Все' || (pick === 'Книги' ? !b.category : b.category === pick); });
    // videos from her own YouTube channels for this section (Hz meditations), played in YouTube's player like screensavers
    var yts = pick === 'Книги' ? '' : ytShelves(pick === 'Все' ? '' : pick);
    h += yts;
    if (!list.length) return h + (yts ? '' : '<div class="empty glass"><h1>Здесь пока пусто</h1><p>' + (pick === 'Медитации' ? 'Положи на Диске в папку «аудиокниги» папку «медитации» с аудиофайлами — они появятся тут.' : 'Нет записей в этом разделе.') + '</p></div>');
    // authors first (a round portrait each), their books one level deeper; books without an author below
    var authors = [], byAuthor = {}, loose = [];
    list.forEach(function (b) {
      if (b.author) { if (!byAuthor[b.author]) { byAuthor[b.author] = []; authors.push(b.author); } byAuthor[b.author].push(b); }
      else loose.push(b);
    });
    if (authors.length) {
      h += '<section class="absec"><h2 class="h2">Авторы</h2><div class="augrid">';
      authors.sort(function (a, b) { return a.localeCompare(b, 'ru'); }).forEach(function (a) {
        var n = byAuthor[a].length, playing = byAuthor[a].some(function (b) { return cur === b.id && AU && !AU.paused; });
        h += '<button class="aucard" data-f data-key="au-' + esc(a) + '" data-act="author:' + esc(a) + '">' + authorPic(a, 'aupic') +
          '<span class="auname">' + esc(a) + '</span><span class="aucount">' + (playing ? '<i class="eq"><b></b><b></b><b></b></i> Играет' : n + ' ' + plural(n, 'книга', 'книги', 'книг')) + '</span></button>';
      });
      h += '</div></section>';
    }
    if (loose.length) h += '<section class="absec">' + (authors.length ? '<h2 class="h2">' + (pick === 'Медитации' ? 'Медитации' : 'Без автора') + '</h2>' : '') + bookGrid(loose, cur) + '</section>';
    return h;
  }

  function ytShelves(section) {
    var out = '';
    (S.ytChannels || []).forEach(function (c) {
      if (section && c.section !== section) return;
      var v = (c.videos || []).slice();
      // a course («Day 1, Day 2…») goes in its order; everything else newest first, as YouTube lists it
      var day = function (x) { var m = /Day\s*(\d+)/i.exec(x.title || ''); return m ? +m[1] : 0; };
      if (v.some(day)) v.sort(function (a, b) { return (day(a) || 999) - (day(b) || 999); });
      if (!v.length) return;
      out += '<section class="absec"><h2 class="h2">✦ ' + esc(c.title || c.channel || 'YouTube') + '</h2><div class="ytgrid">';
      v.forEach(function (x) {
        var t = String(x.title || ''), m = /^(.*?)\s*[|·]\s*(.*)$/.exec(t), main = m ? m[1] : t, sub = m ? m[2] : '';
        out += '<button class="ytcard" data-f data-key="yt-' + esc(x.id) + '" data-act="ytplay:' + esc(x.id) + '"><span class="ytth"><img ' + psrc('https://i.ytimg.com/vi/' + x.id + '/hqdefault.jpg') + ' alt="" onerror="this.remove()"><i class="ytpl"></i></span>' +
          '<span class="ytt">' + esc(main) + '</span>' + (sub ? '<span class="yts">' + esc(sub) + '</span>' : '') + '</button>';
      });
      out += '</div></section>';
    });
    return out;
  }

  function bookGrid(list, cur) {
    var h = '<div class="abgrid">';
    for (var i = 0; i < list.length; i++) {
      var b = list[i], sv = abSaved(b.id), n = (b.chapters || []).length;
      var prog = sv.at ? 'Часть ' + (sv.c + 1) + ' из ' + n + ' · ' + fmtT(sv.t) : n + ' ' + plural(n, 'часть', 'части', 'частей');
      h += '<button class="abcard' + (cur === b.id ? ' cur' : '') + '" data-f data-key="ab-' + esc(b.id) + '" data-act="book:' + esc(b.id) + '">' + abCover(b, 'abcv') +
        '<span class="abname">' + esc(b.title || '') + '</span>' + (b.series ? '<span class="abser">' + esc(b.series) + '</span>' : '') + (b.author && view.name !== 'author' ? '<span class="abauth">' + esc(b.author) + '</span>' : '') +
        '<span class="abprog">' + (cur === b.id && AU && !AU.paused ? '<i class="eq"><b></b><b></b><b></b></i> Играет' : esc(prog)) + '</span></button>';
    }
    return h + '</div>';
  }

  function authorPage() {
    var a = view.id, list = abList().filter(function (b) { return b.author === a; });
    var cur = AU && AU.getAttribute('data-book');
    return '<div class="ctop">' + backBtn('au-back') + statusLine() + '</div>' +
      '<section class="auhead glass">' + authorPic(a, 'aubig') + '<div class="auinfo"><span class="hchip">Автор</span><h1>' + esc(a) + '</h1>' +
      '<div class="aucount2">' + list.length + ' ' + plural(list.length, 'книга', 'книги', 'книг') + '</div>' +
      (authorBio[a] ? '<p class="aubio">' + esc(authorBio[a]) + '</p>' : '') + '</div></section>' + bookGrid(list, cur);
  }

  // portraits from Wikipedia, all in one look: tinted the same violet-blue and glowing softly
  var authorImg = {}, authorBio = {}, authorAsked = {};
  try { var cachedAu = JSON.parse(localStorage.getItem('authors') || '{}'); for (var k in cachedAu) { authorImg[k] = cachedAu[k].img; authorBio[k] = cachedAu[k].bio; } } catch (e) {}
  function saveAuthors() { try { var o = {}; for (var k in authorImg) o[k] = { img: authorImg[k], bio: authorBio[k] || '' }; localStorage.setItem('authors', JSON.stringify(o)); } catch (e) {} }
  function initials(a) { return a.split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase(); }
  function authorPic(a, cls) {
    // your own picture in the author's folder wins over Wikipedia
    var own = ''; abList().forEach(function (b) { if (b.author === a && b.authorPhoto) own = b.authorPhoto; });
    if (own) authorImg[a] = own;
    else if (authorImg[a] === undefined && !authorAsked[a]) askWiki(a);
    // the same violet-blue for every author, so the row reads as one set
    return '<span class="' + cls + '" style="background:radial-gradient(120% 90% at 30% 15%,#8E6BFF 0%,#3B2E8F 45%,#141030 100%)">' +
      '<span class="auini">' + esc(initials(a)) + '</span>' +
      (authorImg[a] ? '<img src="' + esc(authorImg[a]) + '" alt="" onerror="this.remove()"><i class="autint"></i>' : '') + '</span>';
  }
  function askWiki(a) {
    authorAsked[a] = true;
    if (!window.fetch) return;
    var title = encodeURIComponent(a.replace(/\s+/g, '_'));
    fetch('https://ru.wikipedia.org/api/rest_v1/page/summary/' + title).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      // only an article about this very person (Wikipedia may redirect a name to a book or a teaching)
      var norm = function (x) { return String(x || '').toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z]+/g, ' ').trim(); };
      var same = j && j.type === 'standard' && norm(j.title).indexOf(norm(a).split(' ').pop()) >= 0;
      authorImg[a] = same && (j.originalimage || j.thumbnail) ? (j.thumbnail ? j.thumbnail.source.replace(/\/\d+px-/, '/600px-') : j.originalimage.source) : '';
      authorBio[a] = same && j.extract ? String(j.extract).split('. ').slice(0, 2).join('. ').slice(0, 260) : '';
      saveAuthors();
      if (view.name === 'books' || view.name === 'author') render(null, true);
    }).catch(function () { authorImg[a] = ''; });
  }

  function bookPlayer() {
    var b = abById(view.id);
    if (!b) return '<div class="empty glass"><h1>Книга не найдена</h1></div>';
    var ch = b.chapters || [], sv = abSaved(b.id);
    var playingThis = AU && AU.getAttribute('data-book') === b.id;
    var ci = playingThis ? +AU.getAttribute('data-ch') : Math.min(sv.c || 0, Math.max(0, ch.length - 1));
    var paused = !playingThis || AU.paused;
    var h = '<section class="abstage"><i class="ablight l1"></i><i class="ablight l2"></i><i class="ablight l3"></i><i class="abdust"></i></section>' +
      '<div class="abplayer">' +
      '<div class="abtop">' + backBtn('ab-back') + '</div>' +
      '<div class="abmain">' + abCover(b, 'abbig') +
      '<div class="abinfo"><span class="hchip">' + (b.series ? esc(b.series) : 'Аудиокнига') + '</span><h1>' + esc(b.title || '') + '</h1>' + (b.author ? '<div class="abauth2">' + esc(b.author) + '</div>' : '') +
      '<div class="abst" id="abst" style="display:none"></div><div class="abdrive" id="abdrive" style="display:none"></div>' +
      '<div class="abch" id="abch">' + esc((ch[ci] && ch[ci].title) || '') + ' · ' + (ci + 1) + ' из ' + ch.length + '</div>' +
      '<div class="abbar"><div class="abfill" id="abfill"></div></div><div class="abtimes"><span id="abcur">' + fmtT(playingThis ? AU.currentTime : sv.c === ci ? sv.t : 0) + '</span><span id="abdur">' + (playingThis && AU.duration ? fmtT(AU.duration) : (sv.d && sv.c === ci ? fmtT(sv.d) : '')) + '</span></div>' +
      '<div class="abbtns">' +
        '<button class="abb" data-f data-key="ab-prev" data-act="abprev" aria-label="Предыдущая часть">' + I.prev + '</button>' +
        '<button class="abb" data-f data-key="ab-rew" data-act="abseek:-30" aria-label="Назад 30 секунд">' + I.rew + '<small>30</small></button>' +
        '<button class="abb abplay btn pri" data-f data-key="ab-play" data-act="abplay:' + esc(b.id) + '" aria-label="Играть">' + (paused ? I.play : I.pause) + '</button>' +
        '<button class="abb" data-f data-key="ab-fwd" data-act="abseek:30" aria-label="Вперёд 30 секунд">' + I.fwd + '<small>30</small></button>' +
        '<button class="abb" data-f data-key="ab-next" data-act="abnext" aria-label="Следующая часть">' + I.next + '</button>' +
      '</div>' +
      '<button class="btn small absleep' + (abSleep ? ' on' : '') + '" data-f data-key="ab-sleep" data-act="absleep">' + I.moon + ' <span id="absl">' + sleepLabel() + '</span></button>' +
      '</div></div>';
    if (ch.length > 1) {
      h += '<section class="abchapters"><h2 class="h2">Части</h2>';
      for (var i = 0; i < ch.length; i++) h += '<button class="abrow' + (i === ci ? ' cur' : '') + '" data-f data-key="abc-' + i + '" data-act="abch:' + i + '"><span class="n">' + (i + 1) + '</span><span class="t">' + esc(ch[i].title || ('Часть ' + (i + 1))) + '</span></button>';
      h += '</section>';
    }
    return h + '</div>';
  }

  function sleepLabel() {
    if (!abSleep) return 'Таймер сна';
    var left = Math.max(0, Math.ceil((abSleepEnd - Date.now()) / 60000));
    return 'Выключу через ' + left + ' мин';
  }

  function abEnsure() {
    if (AU) return AU;
    AU = document.createElement('audio');
    AU.preload = 'auto';
    AU.style.display = 'none';
    document.body.appendChild(AU);
    AU.addEventListener('ended', function () {
      var b = abById(AU.getAttribute('data-book')); var ci = +AU.getAttribute('data-ch');
      var nx = b ? abNextOf(b, ci) : null;
      if (nx) {
        if (nx.b !== b) abSave(b.id, 0, 0, 0); // this step is finished: the next one of the cycle starts by itself
        if (nx.b !== b && view.name === 'book' && view.id === b.id) view = { name: 'book', id: nx.b.id, prev: view.prev };
        abStart(nx.b, nx.ci, 0, true);
      } else { abSave(b ? b.id : '', 0, 0, 0); abUi(); }
    });
    AU.addEventListener('play', abUi);
    AU.addEventListener('waiting', function () { abStatus('Загружаю…'); });
    AU.addEventListener('playing', function () {
      abStatus(''); clearTimeout(abLoadT);
      // in the browser the next part is fetched ahead, so it starts at once — also with the screen locked
      if (abNeedBlob) { var b = abById(AU.getAttribute('data-book')), nx = b && abNextOf(b, +AU.getAttribute('data-ch')); if (nx) abFetchBlob(nx.b.chapters[nx.ci].url); }
    });
    AU.addEventListener('pause', abUi);
    AU.addEventListener('loadedmetadata', abUi);
    AU.addEventListener('error', function () {
      // big files: let the Android side follow Drive's "download anyway" page once
      if (A.resolveUrl && !AU.getAttribute('data-resolved')) {
        try { var u = A.resolveUrl(AU.src); if (u && u !== AU.src) { var t = AU.currentTime; AU.setAttribute('data-resolved', '1'); AU.src = u; AU.currentTime = t; AU.play(); return; } } catch (e) {}
      }
      clearTimeout(abLoadT);
      var orig = AU.getAttribute('data-url') || AU.src || '';
      var fid = (/[?&]id=([A-Za-z0-9_-]{10,})/.exec(orig) || /\/files\/([A-Za-z0-9_-]{10,})/.exec(orig) || /\/drive\/([A-Za-z0-9_-]{10,})/.exec(orig) || [])[1];
      if (fid && abIsWeb()) {
        // iPhone Safari won't stream Drive's «download» files: load the part whole and play it from memory,
        // so parts still follow one another; only if even that fails, Google Drive's own player
        if (!AU.getAttribute('data-blob')) {
          var bk = AU.getAttribute('data-book'), cn = AU.getAttribute('data-ch'), at = AU.currentTime || +(AU.getAttribute('data-seek') || 0);
          AU.setAttribute('data-blob', '1'); abStatus('Загружаю часть…');
          var pr0 = abFetchBlob(orig);
          if (pr0) { pr0.then(function (u) {
            if (AU.getAttribute('data-book') !== bk || AU.getAttribute('data-ch') !== cn) return;
            abNeedBlob = true; AU.src = u;
            if (at > 0) { var once = function () { AU.removeEventListener('loadedmetadata', once); try { AU.currentTime = at; } catch (e) {} }; AU.addEventListener('loadedmetadata', once); }
            var p = AU.play(); if (p && p.catch) p.catch(function () { abStatus('Часть загружена — нажми ▶'); });
          }, function () { if (AU.getAttribute('data-book') === bk && AU.getAttribute('data-ch') === cn) abDrivePlayer(fid); }); return; }
        }
        abDrivePlayer(fid); return;
      }
      abStatus('Не получилось открыть файл' + (AU.error ? ' (код ' + AU.error.code + ')' : '') + ' — проверь, что папка на Диске открыта по ссылке');
    });
    return AU;
  }

  // the part after this one: the next file, or the first part of the next step of the same cycle
  function abNextOf(b, ci) {
    var ch = b.chapters || [];
    if (ci + 1 < ch.length) return { b: b, ci: ci + 1 };
    if (!b.series) return null;
    var same = abList().filter(function (x) { return x.series === b.series && (x.author || '') === (b.author || '') && (x.chapters || []).length; });
    var i = same.indexOf(b);
    return i >= 0 && i + 1 < same.length ? { b: same[i + 1], ci: 0 } : null;
  }
  function abIsWeb() { return document.documentElement.classList.contains('web'); }
  // browser only: a part loaded whole into memory (Safari can't stream Drive files); keep just a few
  var abNeedBlob = false, abBlobP = {}, abBlobU = {}, abBlobOrder = [];
  function abFetchBlob(url) {
    if (abBlobP[url]) return abBlobP[url];
    if (!window.fetch || !window.URL || !URL.createObjectURL || !window.Blob) return null;
    var p = fetch(url, { mode: 'cors', credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.arrayBuffer();
    }).then(function (buf) {
      var u = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
      abBlobU[url] = u; abBlobOrder.push(url);
      while (abBlobOrder.length > 3) { var old = abBlobOrder.shift(); if (AU && AU.src === abBlobU[old]) { abBlobOrder.push(old); break; } try { URL.revokeObjectURL(abBlobU[old]); } catch (e) {} delete abBlobU[old]; delete abBlobP[old]; }
      return u;
    });
    p.catch(function () { delete abBlobP[url]; });
    abBlobP[url] = p;
    return p;
  }

  function abStart(b, ci, t, autoplay) {
    if (MU && !MU.paused) MU.pause();
    var a = abEnsure(), ch = (b.chapters || [])[ci];
    if (!ch) return;
    a.removeAttribute('data-resolved'); a.removeAttribute('data-blob');
    var dbx = document.getElementById('abdrive'); if (dbx) { dbx.innerHTML = ''; dbx.style.display = 'none'; }
    a.setAttribute('data-book', b.id); a.setAttribute('data-ch', String(ci));
    a.setAttribute('data-url', ch.url); a.setAttribute('data-seek', String(t || 0));
    if (abNeedBlob && abBlobU[ch.url]) { a.setAttribute('data-blob', '1'); a.src = abBlobU[ch.url]; }
    else if (abNeedBlob && abIsWeb()) {
      // this browser can only play parts from memory: load it, then start
      a.setAttribute('data-blob', '1'); a.removeAttribute('src'); abStatus('Загружаю часть…');
      var bp = abFetchBlob(ch.url), bid = b.id, bci = String(ci);
      if (bp) bp.then(function (u) {
        if (a.getAttribute('data-book') !== bid || a.getAttribute('data-ch') !== bci) return;
        a.src = u;
        if (t > 0) { var o2 = function () { a.removeEventListener('loadedmetadata', o2); try { a.currentTime = t; } catch (e) {} }; a.addEventListener('loadedmetadata', o2); }
        if (autoplay) { var p3 = a.play(); if (p3 && p3.catch) p3.catch(function () { abStatus('Часть загружена — нажми ▶'); }); }
      }, function () { var f2 = (/[?&]id=([A-Za-z0-9_-]{10,})/.exec(ch.url) || /\/files\/([A-Za-z0-9_-]{10,})/.exec(ch.url) || [])[1]; if (f2) abDrivePlayer(f2); });
      abSave(b.id, ci, t || 0, 0);
      if (view.name === 'book') render('ab-play', true);
      return;
    }
    else a.src = ch.url;
    var seekTo = t || 0;
    if (seekTo > 0) {
      var once = function () { a.removeEventListener('loadedmetadata', once); try { a.currentTime = seekTo; } catch (e) {} };
      a.addEventListener('loadedmetadata', once);
    }
    a.volume = 1; abFading = false;
    if (autoplay) {
      abStatus('Загружаю…');
      var pr = a.play(); if (pr && pr.catch) pr.catch(function (e) { abStatus('Не запускается: ' + (e && e.name || 'ошибка') + ' — нажми ▶ ещё раз'); });
      // nothing after 15 s: ask for the file once more
      clearTimeout(abLoadT);
      abLoadT = setTimeout(function () {
        if (a.paused || a.currentTime > 0.5) return;
        abStatus('Долго грузится, пробую ещё раз…');
        var u = a.src; if (A.resolveUrl) { try { u = A.resolveUrl(u) || u; } catch (e) {} }
        a.src = u; var p2 = a.play(); if (p2 && p2.catch) p2.catch(function () {});
      }, 15000);
    }
    abSave(b.id, ci, seekTo, 0);
    if (view.name === 'book') render('ab-play', true);
  }

  function abToggle(id) {
    var b = abById(id); if (!b) return;
    var a = abEnsure();
    if (a.getAttribute('data-book') === id && a.src) {
      if (a.paused) { a.volume = 1; var pr = a.play(); if (pr && pr.catch) pr.catch(function () {}); } else a.pause();
      return;
    }
    var sv = abSaved(id);
    abStart(b, Math.min(sv.c || 0, (b.chapters || []).length - 1), sv.t || 0, true);
  }

  // refresh the bits of the player that move, without re-rendering the page
  function abUi() {
    if (!AU) return;
    var b = abById(AU.getAttribute('data-book'));
    if (b && AU.currentTime > 0) abSave(b.id, +AU.getAttribute('data-ch'), AU.currentTime, AU.duration || 0);
    var ni = document.querySelector('[data-key="nav-music"]');
    if (ni) ni.classList.toggle('live', !AU.paused || (!!MU && !MU.paused));
    if (view.name !== 'book' || !b || b.id !== view.id) return;
    var fill = document.getElementById('abfill'), cur = document.getElementById('abcur'), dur = document.getElementById('abdur');
    if (fill && AU.duration) fill.style.width = (AU.currentTime / AU.duration * 100).toFixed(2) + '%';
    if (cur) cur.textContent = fmtT(AU.currentTime);
    if (dur && AU.duration) dur.textContent = fmtT(AU.duration);
    var pb = document.querySelector('[data-key="ab-play"]');
    if (pb) { var want = AU.paused ? I.play : I.pause; if (pb.getAttribute('data-ic') !== (AU.paused ? 'p' : 'z')) { pb.innerHTML = want; pb.setAttribute('data-ic', AU.paused ? 'p' : 'z'); } }
    var sl = document.getElementById('absl'); if (sl) sl.textContent = sleepLabel();
  }

  function abSleepTick() {
    if (!abSleep || !AU) return;
    var left = abSleepEnd - Date.now();
    if (left <= 0) { var dbx2 = document.getElementById('abdrive'); if (dbx2) { dbx2.innerHTML = ''; dbx2.style.display = 'none'; } AU.pause(); AU.volume = 1; abSleep = 0; abFading = false; abUi(); var sb = document.querySelector('[data-key="ab-sleep"]'); if (sb) sb.classList.remove('on'); return; }
    if (left < 60000) { abFading = true; AU.volume = Math.max(0.05, left / 60000); }
  }

  // the screen sinks into darkness after a while; any key brings it back
  function abWake() {
    document.documentElement.classList.remove('abdim');
    clearTimeout(abDimT);
    if (view.name === 'book') abDimT = setTimeout(function () { if (view.name === 'book') document.documentElement.classList.add('abdim'); }, 15000);
  }

  setInterval(function () { if (AU && !AU.paused) abUi(); if (abSleep) abSleepTick(); }, 1000);
  document.addEventListener('keydown', abWake, true);
  document.addEventListener('mousemove', abWake, true);
  document.addEventListener('touchstart', abWake, true);

  function abAct(cmd, arg) {
    var a = abEnsure(), b = abById(a.getAttribute('data-book') || view.id);
    switch (cmd) {
      case 'book': go({ name: 'book', id: arg }, 'ab-play'); abWake(); return true;
      case 'author': go({ name: 'author', id: arg }); return true;
      case 'abcat': view = { name: 'books', cat: arg }; render('abcat-' + arg, true); return true;
      case 'abplay': abToggle(arg); abWake(); return true;
      case 'abseek': if (a.src) { try { a.currentTime = Math.max(0, a.currentTime + (+arg)); } catch (e) {} abUi(); } return true;
      case 'abprev':
        if (!b) return true;
        if (a.src && a.currentTime > 10) { a.currentTime = 0; abUi(); return true; }
        abStart(b, Math.max(0, +(a.getAttribute('data-ch') || 0) - 1), 0, true); return true;
      case 'abnext': if (b) { var n = +(a.getAttribute('data-ch') || 0) + 1; if (n < (b.chapters || []).length) abStart(b, n, 0, true); } return true;
      case 'abch': { var bk = abById(view.id); if (bk) abStart(bk, +arg, 0, true); render('abc-' + arg, true); return true; }
      case 'absleep': {
        var idx = SLEEP_STEPS.indexOf(abSleep); abSleep = SLEEP_STEPS[(idx + 1) % SLEEP_STEPS.length];
        abSleepEnd = Date.now() + abSleep * 60000; if (!abSleep && AU) AU.volume = 1;
        var sb = document.querySelector('[data-key="ab-sleep"]'); if (sb) { if (abSleep) sb.classList.add('on'); else sb.classList.remove('on'); }
        abUi(); return true;
      }
    }
    return false;
  }

  // ---------- render ----------

  function screen() {
    if (view.name === 'genres') return genres();
    if (view.name === 'film') return film();
    if (view.name === 'diary') return diary();
    if (view.name === 'downloads') return downloads();
    if (view.name === 'savers') return savers();
    if (view.name === 'books') return books();
    if (view.name === 'music') return music();
    if (view.name === 'book') return bookPlayer();
    if (view.name === 'author') return authorPage();
    if (view.name === 'tv') return tvPage();
    if (view.name === 'coll') return collection();
    return home();
  }

  function focusEl(el) {
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    // keep the focused row in the middle of the screen (TV remote), sideways just enough to show the card
    var main = document.getElementById('main');
    // «Музыка»: the player stays put and only the track list scrolls
    var ml = el.closest ? el.closest('.mlist') : null;
    var mrw = el.closest ? el.closest('.marow') : null;
    if (mrw && mrw.scrollWidth > mrw.clientWidth) {
      var mr0 = mrw.getBoundingClientRect(), me0 = el.getBoundingClientRect();
      if (me0.left < mr0.left + 30) mrw.scrollLeft -= (mr0.left + 30 - me0.left);
      else if (me0.right > mr0.right - 30) mrw.scrollLeft += (me0.right - (mr0.right - 30));
    }
    if (ml && document.body.className.indexOf('inmusic') >= 0) {
      var lr = ml.getBoundingClientRect(), er0 = el.getBoundingClientRect();
      ml.scrollTop = Math.max(0, ml.scrollTop + (er0.top + er0.height / 2) - (lr.top + lr.height / 2));
      return;
    }
    if (document.body.className.indexOf('inmusic') >= 0 && main && el.closest && el.closest('.mstage, .ltabs')) return;
    var row = el.closest ? el.closest('.row') : null;
    if (row && row.scrollWidth > row.clientWidth) {
      var rr = row.getBoundingClientRect(), er = el.getBoundingClientRect(), pad = 30;
      if (er.left < rr.left + pad) row.scrollLeft -= (rr.left + pad - er.left);
      else if (er.right > rr.right - pad) row.scrollLeft += (er.right - (rr.right - pad));
    }
    if (main && main.contains(el) && main.scrollHeight > main.clientHeight) {
      var mr = main.getBoundingClientRect(), r = el.getBoundingClientRect();
      var sec = el.closest ? (el.closest('.row') && (el.closest('.section') || el.closest('.row'))) : null;
      if (el.closest && el.closest('section.hero')) {
        // the top panel's buttons: show the panel whole, from the very top
        main.scrollTop = 0;
      } else if (sec) {
        // a row of cards: bring the whole row to the middle of the screen
        var tr = sec.getBoundingClientRect();
        var box = tr.height < mr.height * 0.9 ? tr : r;
        main.scrollTop = Math.max(0, main.scrollTop + (box.top + box.height / 2) - (mr.top + mr.height / 2));
      } else {
        // anything else: scroll only as much as needed to show it with some air around
        var air = Math.min(120, mr.height * 0.18);
        if (r.top < mr.top + air) main.scrollTop = Math.max(0, main.scrollTop - (mr.top + air - r.top));
        else if (r.bottom > mr.bottom - air) main.scrollTop += r.bottom - (mr.bottom - air);
      }
    } else if (!main || !main.contains(el)) {
      try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
    }
  }

  function render(focusKey, keepScroll) {
    if (!muWrapChecked && S.music && view.name === 'home') setTimeout(muWrapAuto, 400);
    var tr0 = Date.now();
    try {
      try { renderNow(focusKey, keepScroll); }
      catch (e) { if (view.name === 'home') throw e; view = { name: 'home' }; stack = []; renderNow(null, false); } // a remembered screen that no longer exists
      saveViewUrl();
      if (restoreScroll != null && S.films && S.films.length) { var mm = document.getElementById('main'); if (mm) mm.scrollTop = restoreScroll; restoreScroll = null; }
      if (lazyOn()) lazyPass();
    } finally { if (DIAG.tRender.length < 12) DIAG.tRender.push(view.name + ' ' + (Date.now() - tr0) + 'ms'); }
  }
  function renderNow(focusKey, keepScroll) {
    var active = document.activeElement;
    var curKey = focusKey || (active && active.getAttribute && active.getAttribute('data-key'));
    var main = document.getElementById('main');
    var top = keepScroll && main ? main.scrollTop : 0;
    var rows = {};
    if (keepScroll) {
      var rs = document.querySelectorAll('[data-row]');
      for (var i = 0; i < rs.length; i++) rows[rs[i].getAttribute('data-row')] = rs[i].scrollLeft;
    }
    var theme = '';
    if (view.name === 'coll') { var cc = collById(view.id); theme = cc ? 'theme-' + (cc.theme || 'default') : ''; }
    document.body.className = theme + (view.name === 'book' ? ' inbook' : '') + (view.name === 'music' ? ' inmusic' : '');
    // Christmas: magic glitter drifting over the dark background (the collection and its films)
    var sparkle = (view.name === 'coll' && (collById(view.id) || {}).theme === 'christmas') || (view.name === 'film' && byId(view.id) && filmTheme(byId(view.id)) === 'christmas');
    var hintNow = (view.name === 'tv' || view.name === 'book' || view.name === 'savers') && lastHintView !== view.name;
    lastHintView = view.name;
    if (view.name !== 'book') document.documentElement.classList.remove('abdim');
    var oldVid = document.querySelector('.svvid');
    var scr = screen();
    var rp = rateFor && view.name === 'film' ? ratePrompt() : '';
    if (rp) scr = '<div class="under">' + scr.replace(/ data-f/g, '') + '</div>';
    root.innerHTML = (rp ? nav().replace(/ data-f/g, '') : nav()) + '<main id="main">' + updateBanner() + scr + '</main>' + rp + (full >= 0 ? fullScreen() : '') + muMini() + muFullHtml() +
      (hintNow ? '<div class="backhint">◀ «Назад» на пульте — выйти</div>' : '') + (sparkle ? glitterHtml() : '');
    var newVid = document.querySelector('.svvid');
    if (oldVid && newVid && oldVid.getAttribute('data-src') === newVid.getAttribute('data-src')) newVid.parentNode.replaceChild(oldVid, newVid);
    main = document.getElementById('main');
    if (keepScroll) {
      main.scrollTop = top;
      var rs2 = document.querySelectorAll('[data-row]');
      for (var j = 0; j < rs2.length; j++) {
        var k = rs2[j].getAttribute('data-row');
        if (rows[k] != null) rs2[j].scrollLeft = rows[k];
      }
    }
    var el = curKey ? document.querySelector('[data-key="' + cssEsc(curKey) + '"]') : null;
    if (!el) el = main.querySelector('.btn.pri, [data-f]') || document.querySelector('[data-f]');
    if (el) {
      if (keepScroll) el.focus(); else focusEl(el);
    }
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  function shape(st) {
    return JSON.stringify(st, function (k, v) { return (k === 'done' || k === 'total' || k === 'free') ? undefined : v; });
  }

  function load() {
    var t0 = Date.now(), txt = '';
    try { txt = A.state(); S = JSON.parse(txt); } catch (e) { S = { films: [], error: 'Не получилось прочитать библиотеку' }; DIAG.errs.push('state: ' + e); }
    if (DIAG.tState.length < 12) DIAG.tState.push((Date.now() - t0) + 'ms/' + Math.round(txt.length / 1024) + 'KB');
    if (!S.films) S.films = [];
    // projector (1 GB): smaller pictures — the big ones are sharp on a 4K screen but eat the memory and make the remote lag
    if (!S.platform) {
      var sm = function (u) { return typeof u === 'string' ? u.replace('/t/p/w500/', '/t/p/w342/').replace('/t/p/w1280/', '/t/p/w780/').replace('/t/p/original/', '/t/p/w780/') : u; };
      S.films.forEach(function (f) { f.poster = sm(f.poster); f.backdrop = sm(f.backdrop); if (f.backdrops) f.backdrops = f.backdrops.map(sm); });
    }
  }

  function patchProgress() {
    var map = {};
    S.films.forEach(function (f) { (isSeries(f) ? eps(f) : [f]).forEach(function (it) { map[it.key] = it.dl; }); });
    // whole-series cards show the sum
    S.films.forEach(function (f) {
      if (!isSeries(f)) return;
      var d = dlSummary(f);
      if (d.key) map['__sum__' + d.key] = { done: d.bytesDone, total: d.bytesTotal };
    });
    var ps = document.querySelectorAll('[data-prog]');
    for (var i = 0; i < ps.length; i++) {
      var k = ps[i].getAttribute('data-prog');
      var d = map['__sum__' + k] || map[k];
      if (d) ps[i].textContent = 'Скачивается ' + pct(d) + '%';
    }
    var bs = document.querySelectorAll('[data-bar]');
    for (var j = 0; j < bs.length; j++) {
      var k2 = bs[j].getAttribute('data-bar');
      var d2 = map['__sum__' + k2] || map[k2];
      if (d2) bs[j].style.width = pct(d2) + '%';
    }
  }

  // ---------- actions ----------

  function go(next, focusKey) {
    var a = document.activeElement;
    stack.push({ view: view, focus: a && a.getAttribute && a.getAttribute('data-key') });
    if (stack.length > 30) stack.shift();
    view = next;
    confirmKey = null;
    render(focusKey || null, false);
    var main = document.getElementById('main');
    if (main) main.scrollTop = 0;
    var first = focusKey ? null : (main.querySelector('.btn.pri') || main.querySelector('[data-f]'));
    if (first) focusEl(first);
  }

  function act(a) {
    var parts = a.split(':');
    var cmd = parts[0], arg = parts.slice(1).join(':');
    if (cmd !== 'rm' && cmd !== 'mupldel') confirmKey = null;
    if (cmd === 'play' || cmd === 'restart' || cmd === 'saver') { if (AU && !AU.paused) AU.pause(); }
    if (abAct(cmd, arg)) return;
    switch (cmd) {
      case 'go':
        full = -1;
        if (view.name === arg) return;
        stack = [];
        view = { name: arg };
        if (arg === 'savers') svPick = -1; // a new background each time you come in
        render('nav-' + arg, false);
        return;
      case 'film': go({ name: 'film', id: arg }); return;
      case 'saver': openSaver(parseInt(arg, 10)); return;
      case 'hero': showHero(parseInt(arg, 10), true); return;
      case 'update': A.installUpdate(); return;
      case 'coll': go({ name: 'coll', id: arg }); return;
      case 'xmas': { var xt = document.querySelector('.xmtile'); if (xt) snowBurst(xt, function () { go({ name: 'coll', id: arg }); }); else go({ name: 'coll', id: arg }); return; }
      case 'xmgrid': { var gr = document.querySelector('#main .grid'), mm = document.getElementById('main'); if (gr && mm) { mm.scrollTop += gr.getBoundingClientRect().top - 90; var c0 = gr.querySelector('[data-f]'); if (c0) focusEl(c0); } return; }
      case 'url': if (A.openUrl) A.openUrl(arg); return;
      case 'mkhome': if (A.homeSettings) A.homeSettings(); return;
      case 'openhome': if (A.openHome) A.openHome(); return;
      case 'andset': if (A.androidSettings) A.androidSettings(); return;
      case 'dateset': if (A.dateSettings) A.dateSettings(); return;
      case 'ytplay': if (MU && !MU.paused) MU.pause(); if (AU && !AU.paused) AU.pause(); A.openYoutube(arg); return;
      case 'ltab': if (view.name !== arg) { stack = []; view = { name: arg }; render('lt-' + arg, false); } return;
      case 'mutoggle': muToggle(); muUi(); return;
      case 'munext': muStep(1); return;
      case 'muprev': if (MU && MU.currentTime > 5) { MU.currentTime = 0; } else muStep(-1); return;
      case 'mushuffle': muShuffle = !muShuffle; if (muShuffle && muQueue.length) { var cur = muNow(); muQueue = shuffled(muView()); muPos = Math.max(0, muQueue.indexOf(cur)); } render('mu-shuf', true); return;
      case 'murepeat': muRepeat = !muRepeat; if (MU) MU.loop = muRepeat; try { localStorage.setItem('muRepeat', muRepeat ? '1' : '0'); } catch (e) {} render('mu-rep', true); return;
      case 'muartist': muFull = false; muPick = false; if (arg) go({ name: 'music', artist: arg }, 'ma-play'); else { view = { name: 'music' }; render('mu-play', false); } return;
      case 'mufav': { var tf = muNow(); if (!tf) return; var nf = !muIsFav(tf.uid); muSet('mfav', tf.uid, { on: nf }); render(muPick ? 'mp-fav' : (muFull ? 'mf-fav' : 'mm-fav'), true); return; }
      case 'mupick': muPick = true; render('mp-fav', true); return;
      case 'mupickclose': muPick = false; render('mf-add', true); return;
      case 'mupladd': { var ta = muNow(), pa = muPl(arg); if (!ta || !pa) return; var ix = pa.tracks.indexOf(ta.uid); if (ix >= 0) pa.tracks.splice(ix, 1); else pa.tracks.push(ta.uid); muPlSave(pa); render('mp-' + arg, true); return; }
      case 'muplnew': { var tn = muNow(), inp = document.getElementById('mp-name'), nm0 = inp ? inp.value.trim() : ''; var np = muPlNew(nm0, tn && tn.uid); render('mp-' + np.id, true); return; }
      case 'muplmake': { var mk = muPlNew('', null); go({ name: 'music', pl: mk.id, rename: true }, 'pl-in'); return; }
      case 'muplopen': go({ name: 'music', pl: arg }, 'pl-play'); return;
      case 'muplshare': { var sp = view.pl === 'fav' ? 'Избранное' : ((muPl(view.pl) || {}).name || 'Плейлист'); muShare(sp, muView()); return; }
      case 'muplren': view.rename = true; render('pl-in', true); try { var ri = document.getElementById('pl-name'); if (ri) { ri.focus(); ri.select(); } } catch (e) {} return;
      case 'muplsave': { var ps = muPl(view.pl), ri2 = document.getElementById('pl-name'); if (ps && ri2 && ri2.value.trim()) { ps.name = ri2.value.trim().slice(0, 40); muPlSave(ps); } view.rename = false; render('pl-play', true); return; }
      case 'mupldel': { if (confirmKey !== 'pl-del') { confirmKey = 'pl-del'; render('pl-del', true); return; } confirmKey = null; muSet('mpl', view.pl, { del: true }); if (stack.length) app.back(); else { view = { name: 'music' }; render('pl-new', false); } return; }
      case 'muopen': muFull = true; render('mu-play', true); return;
      case 'muclose': muPick = false; muCloseFull(); return;
      case 'muallshuf': muShuffle = true; muStart(shuffled(arg === 'pl' ? muView() : muTracks()), 0); return;
      case 'muartplay': muShuffle = false; muStart(muView(), 0); return;
      case 'muartshuf': muShuffle = true; muStart(shuffled(muView()), 0); return;
      case 'muwrap': if (view.wrap) app.back(); else go({ name: 'music', wrap: muWrapYear() }, 'lt-wrap'); return;
      case 'muwtop': { var wt = muYearStats(view.wrap || muWrapYear()).tracks.slice(0, 30).map(function (x) { return x.t; }); if (wt.length) { muShuffle = false; muStart(wt, +arg); } return; }
      case 'muplay': { var ml = muView(), mi = +arg; if (muShuffle) { var q = shuffled(ml.filter(function (z, zi) { return zi !== mi; })); q.unshift(ml[mi]); muStart(q, 0); } else muStart(ml, mi); return; }
      case 'season': view = { name: 'film', id: view.id, season: parseInt(arg, 10) }; render('sn-' + arg, true); return;
      case 'tvplay': playTv(parts[1], parseInt(parts[2], 10)); return;
      case 'genre': go({ name: 'genres', genre: arg }, 'g-' + arg); return;
      case 'pickgenre': view = { name: 'genres', genre: arg, filter: view.filter, origin: arg === 'Сериалы' ? view.origin : 'all' }; render('g-' + arg, false); return;
      case 'filter': view = { name: 'genres', genre: view.genre, filter: arg, origin: view.origin }; render('f-' + arg, true); return;
      case 'origin':
        if (view.name !== 'genres') { go({ name: 'genres', genre: 'Сериалы', origin: arg }, 'o-' + arg); return; }
        view = { name: 'genres', genre: view.genre, filter: view.filter, origin: arg }; render('o-' + arg, true); return;
      case 'back': app.back(); return;
      case 'sync': A.sync(); S.syncing = true; render(null, true); return;
      case 'play': heroPicked(parts[1]); A.play(parts[1], parts.slice(2).join(':')); return;
      case 'restart': heroPicked(parts[1]); A.restart(parts[1], parts.slice(2).join(':')); return;
      case 'dl': A.download(arg); return;
      case 'dlall': A.downloadAll(arg); return;
      case 'rm':
        if (confirmKey === arg) { confirmKey = null; A.remove(arg); }
        else { confirmKey = arg; render(null, true); }
        return;
      case 'rate': {
        var rid = parts[1], n = parseFloat(parts[2]);
        var rf = byId(rid); if (!rf) return;
        var cur = rf.rating || 0;
        var nr = cur === n ? n - 0.5 : n;
        A.setRating(rid, nr);
        if (!watched(rf)) A.setStatus(rid, 'watched');
        refresh(true);
        return;
      }
      case 'like': {
        var f = byId(arg); if (!f) return;
        A.setLiked(arg, !f.liked); refresh(true); return;
      }
      case 'status': {
        var g = byId(arg); if (!g) return;
        A.setStatus(arg, watched(g) ? 'new' : 'watched'); refresh(true); return;
      }
      case 'rpclose': rateFor = ''; render('f-play', false); return;
      case 'want': {
        var w = byId(arg); if (!w) return;
        A.setStatus(arg, isWant(w) ? 'new' : 'want'); refresh(true); return;
      }
    }
  }

  // after a film ends: open its card with a rating window on top
  var rateFor = '';
  function checkFinished() {
    var id = S.justFinished;
    if (!id) return false;
    if (A.clearFinished) A.clearFinished();
    S.justFinished = '';
    if (!byId(id)) return false;
    rateFor = id; full = -1;
    if (!(view.name === 'film' && view.id === id)) { stack.push(view); view = { name: 'film', id: id }; }
    render('rp-3', false);
    return true;
  }
  function ratePrompt() {
    var f = byId(rateFor);
    if (!f) return '';
    var r = f.rating || 0, stars = '';
    for (var n = 1; n <= 5; n++) {
      var w = r >= n ? 100 : (r >= n - 0.5 ? 50 : 0);
      stars += '<button class="rpstar" data-f data-key="rp-' + n + '" data-act="rate:' + esc(f.id) + ':' + n + '" aria-label="' + n + '">' +
        '<span class="e">★</span><span class="o" style="width:' + w + '%">★</span></button>';
    }
    return '<div class="rpwrap"><div class="rpbox glass">' +
      '<div class="rppost" style="background:' + color(f) + '">' + posterInner(f) + '</div>' +
      '<div class="rpinfo"><span class="ckick">Фильм закончился</span><h2>' + esc(f.title) + '</h2><p>Как тебе? Нажми на звезду, ещё раз — половинка.</p>' +
      '<div class="rpstars">' + stars + '<span class="rpnum">' + (r ? String(r).replace('.', ',') : '—') + '</span></div>' +
      '<div class="btns"><button class="btn' + (f.liked ? ' on' : '') + '" data-f data-key="rp-like" data-act="like:' + esc(f.id) + '">' + I.heart(f.liked) + (f.liked ? ' В любимом' : ' В любимое') + '</button>' +
      '<button class="btn pri" data-f data-key="rp-done" data-act="rpclose">' + (r ? 'Готово' : 'Позже') + '</button></div></div></div></div>';
  }

  function refresh(force) {
    load();
    if (checkFinished()) return;
    var sh = shape(S);
    if (!force && sh === lastShape) { patchProgress(); return; }
    lastShape = sh;
    render(null, true);
  }

  // ---------- remote control ----------

  function move(dir) {
    var cur = document.activeElement;
    var all = Array.prototype.slice.call(document.querySelectorAll(muPick && document.querySelector('.mpick') ? '.mpick [data-f]' : (muFull && document.querySelector('.mfull') ? '.mfull [data-f]' : '[data-f]')));
    if (!cur || all.indexOf(cur) < 0) { focusEl(document.querySelector('#main [data-f]') || all[0]); return; }
    var r = cur.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var best = null, bs = Infinity;
    // up and down inside the page never jump into the side menu (it sits on the left: only ← goes there)
    var inNav = cur.closest ? !!cur.closest('nav') : false, vert = dir === 'up' || dir === 'down';
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el === cur) continue;
      if (vert && !inNav && el.closest && el.closest('nav')) continue;
      // artist cards scrolled out of their row are reached only from inside the row
      var erw = el.closest ? el.closest('.marow') : null;
      if (erw && !erw.contains(cur)) { var wr = erw.getBoundingClientRect(), b0 = el.getBoundingClientRect(); if (b0.left < wr.left - 2 || b0.right > wr.right + 2) continue; }
      var b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      var ex = b.left + b.width / 2, ey = b.top + b.height / 2, dp, ds;
      if (dir === 'left') { if (b.right > r.left + 2) continue; dp = r.left - b.right; ds = Math.abs(ey - cy); }
      else if (dir === 'right') { if (b.left < r.right - 2) continue; dp = b.left - r.right; ds = Math.abs(ey - cy); }
      else if (dir === 'up') { if (b.bottom > r.top + 2) continue; dp = r.top - b.bottom; ds = Math.abs(ex - cx); }
      else { if (b.top < r.bottom - 2) continue; dp = b.top - r.bottom; ds = Math.abs(ex - cx); }
      var score = dp + ds * 2;
      if (score < bs) { bs = score; best = el; }
    }
    // stepping onto the dots lands on the film that is shown now
    if (best && best.classList.contains('dot') && !cur.classList.contains('dot')) {
      var on = document.querySelector('.dot.on'); if (on) best = on;
    }
    if (best) focusEl(best);
    else if (dir === 'up') { var m = document.getElementById('main'); if (m) m.scrollTop = 0; }
  }

  function changeStars(el, delta) {
    var id = el.getAttribute('data-stars');
    var f = byId(id); if (!f) return;
    var r = Math.max(0, Math.min(5, (f.rating || 0) + delta));
    A.setRating(id, r);
    if (r > 0 && !watched(f)) A.setStatus(id, 'watched');
    refresh(true);
  }

  document.addEventListener('keydown', function (e) {
    var k = e.key, code = e.keyCode;
    var el = document.activeElement;
    var dir = null;
    // typing a playlist name: letters and Backspace belong to the field; Enter saves; ↑ ↓ leave it
    if (el && el.tagName === 'INPUT') {
      if (k === 'Enter' || code === 13 || code === 66) { e.preventDefault(); var en = el.getAttribute('data-enter'); if (en) act(en); return; }
      if (k === 'Escape' || code === 27) { e.preventDefault(); el.blur(); return; }
      if (!(k === 'ArrowUp' || code === 38 || k === 'ArrowDown' || code === 40)) return;
    }
    if (full >= 0) {
      e.preventDefault();
      if (k === 'ArrowLeft' || code === 37) stepImage(-1);
      else if (k === 'ArrowRight' || code === 39) stepImage(1);
      else if (k === 'Escape' || k === 'Backspace' || code === 27) app.back();
      return;
    }
    if (k === 'ArrowLeft' || code === 37) dir = 'left';
    else if (k === 'ArrowRight' || code === 39) dir = 'right';
    else if (k === 'ArrowUp' || code === 38) dir = 'up';
    else if (k === 'ArrowDown' || code === 40) dir = 'down';
    if (dir) {
      e.preventDefault();
      if (el && el.classList && el.classList.contains('mftl') && (dir === 'left' || dir === 'right')) { muSeekBy(dir === 'left' ? -10 : 10); return; }
      move(dir);
      return;
    }
    if (k === 'Enter' || code === 13 || code === 23 || code === 66) {
      e.preventDefault();
      if (e.repeat) return;
      if (el && el.getAttribute && el.getAttribute('data-act')) act(el.getAttribute('data-act'));
      return;
    }
    if (k === 'Escape' || k === 'Backspace' || code === 27) {
      if (app.back()) e.preventDefault();
    }
  });

  document.addEventListener('focusin', function (e) {
    var t = e.target, a = t && t.getAttribute && t.getAttribute('data-act');
    if (a && a.indexOf('hero:') === 0) { var n = parseInt(a.slice(5), 10); if (n !== heroIdx) showHero(n, true); }
  });

  document.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t !== document) {
      if (t.getAttribute && t.getAttribute('data-act')) { act(t.getAttribute('data-act')); return; }
      t = t.parentNode;
    }
  });

  // ---------- public ----------

  var app = {
    refresh: function () { refresh(false); },
    // from the L-HOME screen: "tv", "books", "savers", "home" or "film:<id>"
    open: function (where) {
      stack = []; full = -1; rateFor = '';
      if (where.indexOf('film:') === 0) { view = { name: 'home' }; go({ name: 'film', id: where.slice(5) }); return; }
      view = { name: where || 'home' };
      render(where === 'tv' ? null : 'nav-' + where, false);
    },
    // buttons of a Bluetooth speaker / headphones (from Android)
    media: function (c) {
      var book = AU && !AU.paused && !(MU && !MU.paused) || (AU && AU.src && !(MU && muNow()));
      if (book) {
        if (c === 'play' || (c === 'toggle' && AU.paused)) { var pa = AU.play(); if (pa && pa.catch) pa.catch(function () {}); }
        else if (c === 'pause' || c === 'toggle') AU.pause();
        return;
      }
      if (c === 'play') { if (!MU || MU.paused) muToggle(); }
      else if (c === 'pause') { if (MU && !MU.paused) MU.pause(); }
      else if (c === 'toggle') muToggle();
      else if (c === 'next') muStep(1);
      else if (c === 'prev') { if (MU && MU.currentTime > 4) { MU.currentTime = 0; muUi(); } else muStep(-1); }
      else if (c.indexOf('seek:') === 0 && MU) { try { MU.currentTime = (+c.slice(5) || 0) / 1000; } catch (e) {} muUi(); }
      muNative();
    },
    back: function () {
      if (rateFor) { rateFor = ''; render('f-play', false); return true; }
      if (muPick) { muPick = false; render('mf-add', true); return true; }
      if (muFull) { muCloseFull(); return true; }
      if (full >= 0) { full = -1; render(null, true); return true; }
      if (confirmKey) { confirmKey = null; render(null, true); return true; }
      if (!stack.length) {
        if (view.name !== 'home') { view = { name: 'home' }; render('nav-home', false); return true; }
        return false;
      }
      var prev = stack.pop();
      view = prev.view;
      render(prev.focus, false);
      return true;
    }
  };
  window.app = app;

  load();
  if (S.platform === 'mac') document.documentElement.classList.add('mac');
  // projector / TV: a lighter look (no live blur), so the remote stays quick on a small graphics chip
  if (!S.platform) document.documentElement.classList.add('lite');
  lastShape = shape(S);
  render(null, false);
})();
