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
    } catch (e) {}
  })();
  if (window.Element && !Element.prototype.closest) Element.prototype.closest = function (sel) { var el = this; while (el && el.nodeType === 1) { if (el.matches(sel)) return el; el = el.parentElement; } return null; };

  var A = window.Android;
  var root = document.getElementById('app');

  var S = { films: [] };          // state from Android
  var lastShape = '';
  var view = { name: 'home' };    // current screen
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
  function originOk(f, o) { return !o || o === 'all' || (o === 'ru' ? isRu(f) : !isRu(f)); }
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

  function posterInner(f) {
    // the title is printed on the plate only when there is no picture (or it fails to load)
    if (!f.poster) return '<span class="ph">' + esc(f.title) + '</span>';
    return '<img src="' + esc(f.poster) + '" alt="" onerror="this.nextSibling.style.display=&quot;block&quot;;this.remove()"><span class="ph" style="display:none">' + esc(f.title) + '</span>';
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
      '<div class="poster" style="background:' + color(f) + '">' + (over ? (f.poster ? '<img src="' + esc(f.poster) + '" alt="" onerror="this.remove()">' : '') : posterInner(f)) + over + '</div>' +
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
    var items = [['home', 'Главная', I.home], ['genres', 'Жанры', I.grid], ['diary', 'Дневник', I.diary], ['books', 'Книги', I.book], ['savers', 'Заставки', I.saver], ['downloads', 'Загрузки', I.down]];
    var h = '<nav class="nav glass"><div class="logo">L·C</div>';
    for (var i = 0; i < items.length; i++) {
      var on = view.name === items[i][0] || (view.name === 'film' && false);
      if (items[i][0] === 'books') on = on || view.name === 'book';
      h += '<button class="ni' + (on ? ' on' : '') + (items[i][0] === 'books' && AU && !AU.paused ? ' live' : '') + '" data-f data-key="nav-' + items[i][0] + '" data-act="go:' + items[i][0] + '" aria-label="' + items[i][1] + '">' + items[i][2] + '<span class="nl">' + items[i][1] + '</span></button>';
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

  function collFilms(c) {
    if (c.auto === 'liked') return S.films.filter(function (f) { return f.liked; });
    var out = [];
    (c.films || []).forEach(function (id) { var f = byId(id); if (f) out.push(f); });
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
    var h = '<section class="section"><div class="head"><h2 class="h2">Подборки</h2></div><div class="ctiles">';
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i], n = collFilms(c).length;
      h += '<button class="ctile th-' + esc(c.theme || 'default') + '" data-f data-key="coll-' + esc(c.id) + '" data-act="coll:' + esc(c.id) + '">' + stickers(c.theme) +
        '<span class="cchip">' + (n ? n + ' ' + plural(n, 'фильм', 'фильма', 'фильмов') : (c.auto === 'liked' ? 'ставь ♥' : 'скоро')) + '</span>' +
        '<span class="ctitle">' + esc(c.title) + '</span><span class="csub">' + esc(c.subtitle || '') + '</span></button>';
    }
    return h + '</div></section>';
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
        '<span class="btext"><span class="bname">Русское ТВ</span><span class="bsub">Прямой эфир · без VPN</span></span></button>' +
      '</div>';
  }

  // a cobweb under Halloween things, a pine garland with lights under Christmas ones
  var DECO = { halloween: 'web', christmas: 'garland' };
  function decoHtml(theme) {
    if (theme === 'christmas') return '<div class="deco deco-ice"><img src="stk/ice.webp" alt=""><i class="sheen"></i></div>';
    if (theme === 'halloween') return '<div class="deco-branch"><img class="br" src="stk/branch.webp" alt="">' +
      '<img class="fcandy fc-1" src="stk/candy.webp" alt=""><img class="fcandy fc-2" src="stk/candy.webp" alt=""><img class="fcandy fc-3" src="stk/candy.webp" alt=""></div>';
    return '';
  }
  function filmTheme(f) {
    var cs = S.collections || [];
    for (var i = 0; i < cs.length; i++) if (DECO[cs[i].theme] && collFilms(cs[i]).indexOf(f) >= 0) return cs[i].theme;
    return '';
  }
  function plural(n, one, few, many) { var m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? one : (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many); }

  function collection() {
    var c = collById(view.id);
    if (!c) return emptyScreen();
    var list = collFilms(c);
    var seen = list.filter(watched).length;
    var stk = PAGE_STK[c.theme] ? '<img class="cstk" src="' + stkSrc(PAGE_STK[c.theme]) + '" alt="">' : '';
    // a banner card: back button on top, then a glass card in the collection's colours with the big sticker peeking out
    var h = '<div class="ctop"><button class="btn small cback" data-f data-key="c-back" data-act="back">' + I.back + ' Назад</button>' + statusLine() + '</div>' +
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

  var heroList = [], heroIdx = 0;
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

  // on a phone the top panel turns with a swipe
  var sx = 0, sy = 0, sOn = false;
  document.addEventListener('touchstart', function (e) {
    var t = e.touches && e.touches[0];
    sOn = !!(t && e.target.closest && e.target.closest('section.hero'));
    if (sOn) { sx = t.clientX; sy = t.clientY; }
  }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (!sOn) return;
    sOn = false;
    var t = e.changedTouches && e.changedTouches[0];
    if (!t || heroList.length < 2) return;
    var dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
    lastHeroTouch = Date.now();
    var n = (heroIdx + (dx < 0 ? 1 : -1) + heroList.length) % heroList.length;
    showHero(n, false);
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
    var titleText = cur === 'Все' ? (origin === 'ru' ? 'Русские' : origin === 'foreign' ? 'Иностранные' : 'Все') : cur + (origin === 'ru' ? ' · русские' : origin === 'foreign' ? ' · иностранные' : '');
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
    var ol = [['all', 'Все страны'], ['ru', 'Русские'], ['foreign', 'Иностранные']];
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
    if (S.noDownloads) {
      // the Mac plays everything straight from Drive
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
      episodes = '<section class="section"><h2 class="h2">Серии</h2><div class="eps">';
      for (var e = 0; e < list.length; e++) {
        var ep = list[e];
        if (ep.season !== season) { season = ep.season; episodes += '<div class="season">Сезон ' + esc(season || 1) + '</div>'; }
        var isNext = r.active && ep.key === r.key;
        var cls = 'ep' + (ep.watchedPart ? ' done' : '') + (isNext ? ' last' : '');
        var dd = ep.dl || {};
        var state = dd.status === 'done' ? 'скачана' : (dd.status === 'running' || dd.status === 'paused' ? '<span data-prog="' + esc(ep.key) + '">Скачивается ' + pct(dd) + '%</span>' : (ep.url ? 'онлайн' : 'нет ссылки'));
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
      '<button class="btn small fback" data-f data-key="f-back" data-act="back">' + I.back + ' Назад</button></section>' : '';
    var deco = bds.length ? decoHtml(filmTheme(f)) : '';
    if (deco) banner = '<div class="fbwrap">' + banner + deco + '</div>';
    return banner + '<div class="film' + (bds.length ? ' has-bd' : '') + (deco ? ' th-' + filmTheme(f) : '') + '"><div class="fpost">' + (bds.length ? '' : '<button class="btn small" data-f data-key="f-back" data-act="back" style="margin-bottom:14px">' + I.back + ' Назад</button>') + big + '</div>' +
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
      '<div class="sub">Папки на Диске: ' + esc(S.scanReport || 'ещё не проверялись — нажми обновление') + '</div></div><div class="list">';
    var any = false;
    for (var i = 0; i < S.films.length; i++) {
      var f = S.films[i];
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

  var TV = [
    { id: 'kartina', name: 'Kartina.TV', note: 'СТС, ТНТ, Пятница · платно, 30 дней бесплатно', url: 'https://www.kartina.tv/channel', c1: '#E8452C', c2: '#5A1238' },
    { id: 'r1', name: 'Россия 1', note: 'Бесплатно · фильмы, сериалы, шоу', url: 'https://smotrim.ru/channel/1', c1: '#2B6BFF', c2: '#E2263B' },
    { id: 'kult', name: 'Культура', note: 'Бесплатно · кино, театр', url: 'https://smotrim.ru/channel/4', c1: '#B8892E', c2: '#3A2A12' }
  ];

  function tvPage() {
    var web = document.documentElement.classList.contains('web');
    var h = '<div class="ctop"><button class="btn small" data-f data-key="tv-back" data-act="back">' + I.back + ' Назад</button>' + statusLine() + '</div>' +
      '<section class="tvhead glass"><span class="hchip">Прямой эфир</span><h1>Русское ТВ</h1>' +
      '<p>Эти каналы открываются из Таиланда без VPN. ' + (web ? 'Откроется сайт канала.' : 'Откроется в Brave — нажми ▶ на плеере, если эфир не стартует сам.') + '</p>' +
      '<p class="tvnote">Бесплатно СТС, ТНТ, Пятница и Первый из Таиланда не показывают — проверено: «показ в вашем регионе запрещён правообладателем». Легально их показывает Kartina.TV — сервис для тех, кто живёт за границей.'+'</p></section>' +
      '<div class="tvgrid">';
    for (var i = 0; i < TV.length; i++) {
      var c = TV[i];
      h += '<button class="tvtile" data-f data-key="tv-' + c.id + '" data-act="url:' + esc(c.url) + '" style="background:linear-gradient(135deg,' + c.c1 + ' 0%,' + c.c2 + ' 100%)">' +
        '<span class="tvlive"><i></i>эфир</span><span class="tvname">' + esc(c.name) + '</span><span class="tvsub">' + esc(c.note) + '</span></button>';
    }
    return h + '</div>';
  }

  // ---------- audiobooks: a calm player for falling asleep ----------

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
    var h = '<div class="topline"><h1 class="title-glow">Аудиокниги</h1>' + statusLine() + '</div>';
    if (!list.length) return h + '<div class="empty glass"><h1>Пока пусто</h1><p>Создай на Google Диске в папке с фильмами папку «аудиокниги», а в ней — по папке на каждую книгу с mp3-файлами. После «Обновить» книги появятся здесь.</p></div>';
    var cur = AU && AU.getAttribute('data-book');
    h += '<p class="absub">Тихий плеер для сна: свет медленно переливается, экран сам затемняется, таймер выключит книгу.</p><div class="abgrid">';
    for (var i = 0; i < list.length; i++) {
      var b = list[i], sv = abSaved(b.id), n = (b.chapters || []).length;
      var prog = sv.at ? 'Глава ' + (sv.c + 1) + ' из ' + n + ' · ' + fmtT(sv.t) : n + ' ' + plural(n, 'часть', 'части', 'частей');
      h += '<button class="abcard' + (cur === b.id ? ' cur' : '') + '" data-f data-key="ab-' + esc(b.id) + '" data-act="book:' + esc(b.id) + '">' + abCover(b, 'abcv') +
        '<span class="abname">' + esc(b.title || '') + '</span>' + (b.author ? '<span class="abauth">' + esc(b.author) + '</span>' : '') +
        '<span class="abprog">' + (cur === b.id && !AU.paused ? '<i class="eq"><b></b><b></b><b></b></i> Играет' : esc(prog)) + '</span></button>';
    }
    return h + '</div>';
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
      '<div class="abtop"><button class="btn small" data-f data-key="ab-back" data-act="back">' + I.back + ' Назад</button></div>' +
      '<div class="abmain">' + abCover(b, 'abbig') +
      '<div class="abinfo"><span class="hchip">Аудиокнига</span><h1>' + esc(b.title || '') + '</h1>' + (b.author ? '<div class="abauth2">' + esc(b.author) + '</div>' : '') +
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
      if (b && ci + 1 < (b.chapters || []).length) abStart(b, ci + 1, 0, true);
      else { abSave(b ? b.id : '', 0, 0, 0); abUi(); }
    });
    AU.addEventListener('play', abUi);
    AU.addEventListener('pause', abUi);
    AU.addEventListener('loadedmetadata', abUi);
    AU.addEventListener('error', function () {
      // big files: let the Android side follow Drive's "download anyway" page once
      if (A.resolveUrl && !AU.getAttribute('data-resolved')) {
        try { var u = A.resolveUrl(AU.src); if (u && u !== AU.src) { var t = AU.currentTime; AU.setAttribute('data-resolved', '1'); AU.src = u; AU.currentTime = t; AU.play(); return; } } catch (e) {}
      }
      var el = document.getElementById('abch'); if (el) el.textContent = 'Не получилось открыть файл — проверь доступ к папке на Диске';
    });
    return AU;
  }

  function abStart(b, ci, t, autoplay) {
    var a = abEnsure(), ch = (b.chapters || [])[ci];
    if (!ch) return;
    a.removeAttribute('data-resolved');
    a.setAttribute('data-book', b.id); a.setAttribute('data-ch', String(ci));
    a.src = ch.url;
    var seekTo = t || 0;
    if (seekTo > 0) {
      var once = function () { a.removeEventListener('loadedmetadata', once); try { a.currentTime = seekTo; } catch (e) {} };
      a.addEventListener('loadedmetadata', once);
    }
    a.volume = 1; abFading = false;
    if (autoplay) { var pr = a.play(); if (pr && pr.catch) pr.catch(function () {}); }
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
    var ni = document.querySelector('[data-key="nav-books"]');
    if (ni) { if (AU.paused) ni.classList.remove('live'); else ni.classList.add('live'); }
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
    if (left <= 0) { AU.pause(); AU.volume = 1; abSleep = 0; abFading = false; abUi(); var sb = document.querySelector('[data-key="ab-sleep"]'); if (sb) sb.classList.remove('on'); return; }
    if (left < 60000) { abFading = true; AU.volume = Math.max(0.05, left / 60000); }
  }

  // the screen sinks into darkness after a while; any key brings it back
  function abWake() {
    document.documentElement.classList.remove('abdim');
    clearTimeout(abDimT);
    if (view.name === 'book') abDimT = setTimeout(function () { if (view.name === 'book') document.documentElement.classList.add('abdim'); }, 15000);
  }

  setInterval(function () { if (AU && !AU.paused) { abUi(); abSleepTick(); } }, 1000);
  document.addEventListener('keydown', abWake, true);
  document.addEventListener('mousemove', abWake, true);
  document.addEventListener('touchstart', abWake, true);

  function abAct(cmd, arg) {
    var a = abEnsure(), b = abById(a.getAttribute('data-book') || view.id);
    switch (cmd) {
      case 'book': go({ name: 'book', id: arg }, 'ab-play'); abWake(); return true;
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
    if (view.name === 'book') return bookPlayer();
    if (view.name === 'tv') return tvPage();
    if (view.name === 'coll') return collection();
    return home();
  }

  function focusEl(el) {
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    // keep the focused row in the middle of the screen (TV remote), sideways just enough to show the card
    var main = document.getElementById('main');
    var row = el.closest ? el.closest('.row') : null;
    if (row && row.scrollWidth > row.clientWidth) {
      var rr = row.getBoundingClientRect(), er = el.getBoundingClientRect(), pad = 30;
      if (er.left < rr.left + pad) row.scrollLeft -= (rr.left + pad - er.left);
      else if (er.right > rr.right - pad) row.scrollLeft += (er.right - (rr.right - pad));
    }
    if (main && main.contains(el) && main.scrollHeight > main.clientHeight) {
      var mr = main.getBoundingClientRect(), r = el.getBoundingClientRect();
      var sec = el.closest ? (el.closest('.row') && (el.closest('.section') || el.closest('.row'))) : null;
      if (sec) {
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
    document.body.className = theme + (view.name === 'book' ? ' inbook' : '');
    if (view.name !== 'book') document.documentElement.classList.remove('abdim');
    var oldVid = document.querySelector('.svvid');
    var scr = screen();
    var rp = rateFor && view.name === 'film' ? ratePrompt() : '';
    if (rp) scr = '<div class="under">' + scr.replace(/ data-f/g, '') + '</div>';
    root.innerHTML = (rp ? nav().replace(/ data-f/g, '') : nav()) + '<main id="main">' + updateBanner() + scr + '</main>' + rp + (full >= 0 ? fullScreen() : '');
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
    try { S = JSON.parse(A.state()); } catch (e) { S = { films: [], error: 'Не получилось прочитать библиотеку' }; }
    if (!S.films) S.films = [];
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
    if (cmd !== 'rm') confirmKey = null;
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
      case 'url': if (A.openUrl) A.openUrl(arg); return;
      case 'genre': go({ name: 'genres', genre: arg }, 'g-' + arg); return;
      case 'pickgenre': view = { name: 'genres', genre: arg, filter: view.filter, origin: arg === 'Сериалы' ? view.origin : 'all' }; render('g-' + arg, false); return;
      case 'filter': view = { name: 'genres', genre: view.genre, filter: arg, origin: view.origin }; render('f-' + arg, true); return;
      case 'origin':
        if (view.name !== 'genres') { go({ name: 'genres', genre: 'Сериалы', origin: arg }, 'o-' + arg); return; }
        view = { name: 'genres', genre: view.genre, filter: view.filter, origin: arg }; render('o-' + arg, true); return;
      case 'back': app.back(); return;
      case 'sync': A.sync(); S.syncing = true; render(null, true); return;
      case 'play': A.play(parts[1], parts.slice(2).join(':')); return;
      case 'restart': A.restart(parts[1], parts.slice(2).join(':')); return;
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
    var all = Array.prototype.slice.call(document.querySelectorAll('[data-f]'));
    if (!cur || all.indexOf(cur) < 0) { focusEl(document.querySelector('#main [data-f]') || all[0]); return; }
    var r = cur.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var best = null, bs = Infinity;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el === cur) continue;
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
    back: function () {
      if (rateFor) { rateFor = ''; render('f-play', false); return true; }
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
  lastShape = shape(S);
  render(null, false);
})();
