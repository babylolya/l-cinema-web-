/* L-CINEMA — interface. Talks to the Android side through window.Android. */
(function () {
  'use strict';

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
      var active = f.pos > 5000 && !f.watchedPart;
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
    var items = [['home', 'Главная', I.home], ['genres', 'Жанры', I.grid], ['diary', 'Дневник', I.diary], ['savers', 'Заставки', I.saver], ['downloads', 'Загрузки', I.down]];
    var h = '<nav class="nav glass"><div class="logo">L·C</div>';
    for (var i = 0; i < items.length; i++) {
      var on = view.name === items[i][0] || (view.name === 'film' && false);
      h += '<button class="ni' + (on ? ' on' : '') + '" data-f data-key="nav-' + items[i][0] + '" data-act="go:' + items[i][0] + '" aria-label="' + items[i][1] + '">' + items[i][2] + '</button>';
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
    if (S.syncedAt) return '<span class="status">Обновлено в ' + esc(String(S.syncedAt).slice(11, 16)) + '</span>';
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
    if (c.keywords && c.keywords.length) {
      var words = c.keywords.map(function (w) { return String(w).toLowerCase(); });
      S.films.forEach(function (f) {
        if (out.indexOf(f) >= 0) return;
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
        '<span class="ctitle">' + esc(c.title) + '</span><span class="csub">' + esc(c.subtitle || '') + (n ? ' · ' + n + ' шт.' : (c.auto === 'liked' ? ' · ставь ♥' : ' · скоро')) + '</span></button>';
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
    var nf = collById('netflix'), n = nf ? collFilms(nf).length : 0;
    return '<div class="btiles">' +
      (nf ? '<button class="btile b-nf" data-f data-key="b-nf" data-act="coll:netflix"><span class="bname">Netflix</span><span class="bsub">' + (n ? n + ' шт.' : 'скоро') + '</span></button>' : '') +
      '<button class="btile b-yt" data-f data-key="b-yt" data-act="url:https://www.youtube.com"><span class="bplay"></span><span class="bname">YouTube</span><span class="bsub">' + (document.documentElement.classList.contains('web') ? 'открыть' : 'открыть в Brave') + '</span></button>' +
      '</div>';
  }

  function collection() {
    var c = collById(view.id);
    if (!c) return emptyScreen();
    var list = collFilms(c);
    var h = '<div class="topline"><div><button class="btn small" data-f data-key="c-back" data-act="back" style="margin-bottom:14px">' + I.back + ' Назад</button>' +
      '<div class="ctrow"><h1 class="title-glow coll-title">' + esc(c.title) + '</h1>' + (PAGE_STK[c.theme] ? '<img class="cstk" src="' + stkSrc(PAGE_STK[c.theme]) + '" alt="">' : '') + '</div><div class="sub">' + esc(c.subtitle || '') + '</div></div>' + statusLine() + '</div>';
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
  function heroHtml(hero, idx, n) {
    var hr = resume(hero);
    var kicker = kickerOf(hero);
    var bgHtml = '';
    if (hero.backdrop) bgHtml = '<div class="bg"><img src="' + esc(hero.backdrop) + '" alt="" onerror="this.remove()"></div><div class="shade"></div>';
    else if (hero.poster) bgHtml = '<div class="bg blur"><img src="' + esc(hero.poster) + '" alt="" onerror="this.remove()"></div><div class="shade"></div>';
    var side = (!hero.backdrop && hero.poster) ? '<div class="pst"><img src="' + esc(hero.poster) + '" alt="" onerror="this.parentNode.remove()"></div>' : '';
    var dots = '';
    if (n > 1) {
      dots = '<div class="dots">';
      for (var d = 0; d < n; d++) dots += '<button class="dot' + (d === idx ? ' on' : '') + '" data-f data-key="dot-' + d + '" data-act="hero:' + d + '" aria-label="Фильм ' + (d + 1) + '"><i></i></button>';
      dots += '</div>';
    }
    return '<section class="hero glass' + (hero.backdrop ? ' has-bd' : '') + '" data-hero="' + esc(hero.id) + '">' + bgHtml + '<div class="info"><div class="kicker">' + esc(kicker) + '</div><h1' + (String(hero.title || '').length > 26 ? ' class="long"' : '') + '>' + esc(hero.title) + '</h1>' +
      '<div class="meta">' + esc(filmMeta(hero)) + '</div><div class="btns">' +
      '<button class="btn pri" data-f data-key="hero-play" data-act="play:' + esc(hero.id) + ':' + esc(hr.key) + '">' + I.play + esc(hr.label) + '</button>' +
      '<button class="btn" data-f data-key="hero-more" data-act="film:' + esc(hero.id) + '">Подробнее</button></div>' + dots + '</div>' +
      side + '</section>';
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
    var lastDay = '';
    films.forEach(function (f) { var d = upl(f).slice(0, 10); if (d > lastDay) lastDay = d; });
    var fresh = films.filter(function (f) { return isNew(f) && !touched(f) && (!lastDay || upl(f).slice(0, 10) === lastDay); }).slice().sort(function (x, y) {
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

    return '<div class="film"><div>' + '<button class="btn small" data-f data-key="f-back" data-act="back" style="margin-bottom:14px">' + I.back + ' Назад</button>' + big + '</div>' +
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

  function savers() {
    var list = S.screensavers || [];
    var h = '<div class="topline"><h1 class="title-glow">Заставки</h1>' + statusLine() + '</div>';
    if (!list.length) return h + '<div class="empty glass"><h1>Пока пусто</h1><p>Пришли Claude ссылки на свои фоны с Google Диска — они появятся здесь.</p></div>';
    h += '<div class="savers">';
    for (var i = 0; i < list.length; i++) {
      var sv = list[i];
      var img = sv.thumb ? '<img src="' + esc(sv.thumb) + '" alt="" onerror="this.remove()">' : '';
      h += '<div class="tile" data-f tabindex="0" data-key="sv-' + i + '" data-act="saver:' + i + '">' +
        '<div class="thumb' + (sv.pixel === false ? '' : ' px') + '">' + img + '<span class="kind">' + (sv.type === 'image' ? 'картинка' : (sv.type === 'youtube' ? 'YouTube' : 'видео')) + '</span></div>' +
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

  // ---------- render ----------

  function screen() {
    if (view.name === 'genres') return genres();
    if (view.name === 'film') return film();
    if (view.name === 'diary') return diary();
    if (view.name === 'downloads') return downloads();
    if (view.name === 'savers') return savers();
    if (view.name === 'coll') return collection();
    return home();
  }

  function focusEl(el) {
    if (!el) return;
    el.focus();
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { el.scrollIntoView(false); }
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
    document.body.className = theme;
    root.innerHTML = nav() + '<main id="main">' + updateBanner() + screen() + '</main>' + (full >= 0 ? fullScreen() : '');
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
    switch (cmd) {
      case 'go':
        full = -1;
        if (view.name === arg) return;
        stack = [];
        view = { name: arg };
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
      case 'want': {
        var w = byId(arg); if (!w) return;
        A.setStatus(arg, isWant(w) ? 'new' : 'want'); refresh(true); return;
      }
    }
  }

  function refresh(force) {
    load();
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
