// L-CINEMA for iPhone: the same interface, with the library logic of the Mac version, running in Safari.
(function () {
  'use strict';
  var REPO = 'babylolya/L-CINEMA-';
  var LS = window.localStorage;
  function get(k, d) { try { var v = LS.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function put(k, v) { try { LS.setItem(k, JSON.stringify(v)); } catch (e) { } }

  var TOKEN = get('lc_token', '');
  document.documentElement.classList.add('web');

  // ---------- first start: ask for the pass ----------
  if (!TOKEN) {
    var setup = document.getElementById('setup');
    setup.hidden = false;
    document.getElementById('save').onclick = async function () {
      var t = document.getElementById('tok').value.trim();
      var err = document.getElementById('setupErr');
      if (!/^gh[po]_|^github_pat_/.test(t)) { err.textContent = 'Похоже, это не пропуск — он начинается с github_pat_'; return; }
      err.textContent = 'Проверяю…';
      var r = await fetch('https://api.github.com/repos/' + REPO + '/contents/library.json', { headers: { Authorization: 'Bearer ' + t, Accept: 'application/vnd.github.raw+json' } }).catch(function () { return null; });
      if (!r || r.status !== 200) { err.textContent = 'Не получилось открыть библиотеку' + (r ? ' (код ' + r.status + ')' : ' — нет интернета'); return; }
      put('lc_token', t);
      location.reload();
    };
    return;
  }
  window.__ready = true;

  // ---------- data ----------
  var LIB = get('lc_lib', {});
  var SHARED = get('lc_shared', {});
  var P = get('lc_prefs', {});
  P.local = P.local || {}; P.progress = P.progress || {}; P.last = P.last || {};
  function saveP() { put('lc_prefs', P); }
  var syncing = false, lastError = '', syncNote = '';

  function gh(path, opts) {
    opts = opts || {};
    var h = Object.assign({ Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github+json' }, opts.headers || {});
    return fetch('https://api.github.com/repos/' + REPO + path, { method: opts.method || 'GET', headers: h, body: opts.body, cache: 'no-store' });
  }
  function nowIso() { var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
  function b64(s) { return btoa(unescape(encodeURIComponent(s))); }
  function unb64(s) { return decodeURIComponent(escape(atob(String(s).replace(/\s/g, '')))); }

  function driveId(url) { var m = /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=download&)?id=)([A-Za-z0-9_-]{10,})/.exec(url || ''); return m ? m[1] : null; }
  function youtubeId(url) { var m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|live\/|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(url || ''); return m ? m[1] : null; }
  function epId(ep) { return ep.id || ('s' + (ep.season || 1) + 'e' + (ep.episode || 1)); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function films() {
    var lib = (LIB.films || []).map(clone);
    var known = {};
    lib.forEach(function (f) { var d = driveId(f.url); if (d) known[d] = 1; (f.episodes || []).forEach(function (e) { var x = driveId(e.url); if (x) known[x] = 1; }); });
    (LIB.screensavers || []).forEach(function (s) { var x = driveId(s.url); if (x) known[x] = 1; });
    var tm = SHARED.tmdb || {};
    var extra = [];
    (SHARED.films || []).forEach(function (a) {
      if (known[a.driveId]) return;
      var nf = function (x) { x = String(x || ''); return x.normalize ? x.normalize('NFC') : x; };
      var fn = nf(a.fileName).toLowerCase();
      var owner = null;
      for (var i = 0; i < lib.length; i++) if (lib[i].fileMatch && fn.indexOf(nf(lib[i].fileMatch).toLowerCase()) >= 0) { owner = lib[i]; break; }
      if (owner) {
        if (!owner.url && a.url) owner.url = a.url;
        if (!owner.episodes && a.episodes) owner.episodes = a.episodes;
        if (!owner.collection && a.collection) owner.collection = a.collection;
        if (a.uploaded) owner.uploaded = a.uploaded;
        return;
      }
      var f = clone(a), meta = (tm[f.id] || {}).meta;
      if (meta) ['title', 'original', 'year', 'genres', 'description', 'lang'].forEach(function (k) { if (meta[k] !== undefined && String(meta[k]) !== '' && !(Array.isArray(meta[k]) && !meta[k].length)) f[k] = meta[k]; });
      extra.push(f);
    });
    return lib.filter(function (f) { return f.id; }).concat(extra);
  }
  function items() {
    var out = [];
    films().forEach(function (f) {
      if (f.type === 'series' && f.episodes) f.episodes.forEach(function (ep) {
        out.push({ key: f.id + '__' + epId(ep), filmId: f.id, url: ep.url, title: f.title + ' · С' + (ep.season || 1) + ' Э' + (ep.episode || 1) });
      });
      else out.push({ key: f.id, filmId: f.id, url: f.url, title: f.title });
    });
    return out;
  }
  function screensavers() {
    var src = clone(LIB.screensavers || []), have = {};
    src.forEach(function (s) { var d = driveId(s.url); if (d) have[d] = 1; });
    (SHARED.screensavers || []).forEach(function (a) { if (!have[a.driveId]) src.push(a); });
    return src.map(function (c) {
      var yt = youtubeId(c.url);
      if (yt) return Object.assign(c, { type: 'youtube', yt: yt, thumb: c.thumb || 'https://i.ytimg.com/vi/' + yt + '/hqdefault.jpg' });
      var id = driveId(c.url);
      if (!c.thumb && id) c.thumb = 'https://drive.google.com/thumbnail?id=' + id + '&sz=w800';
      c.drive = id;
      return c;
    });
  }

  // a public key, usable only from this site and only to read Drive files shared by link:
  // Safari plays these straight away (with seeking), so audiobook parts follow one another
  var DRIVE_API = 'https://www.googleapis.com/drive/v3/files/', DRIVE_KEY = 'AIzaSyDiMJRkIt6Rp_KnIeQwvXPDSSW995YUQfk';
  function audiobooks() {
    var src = clone(LIB.audiobooks || []), have = {};
    src.forEach(function (b) { if (b.driveId) have[b.driveId] = 1; });
    (SHARED.audiobooks || []).forEach(function (a) { if (!have[a.driveId]) src.push(clone(a)); });
    src.forEach(function (b) { (b.chapters || []).forEach(function (c) { var id = driveId(c.url); if (id) c.url = DRIVE_API + id + '?alt=media&key=' + DRIVE_KEY; }); });
    return src;
  }

  function putProgress(o, key) {
    var p = P.progress[key] || {};
    o.key = key; o.dl = { status: 'none', done: 0, total: 0 };
    o.pos = p.done ? 0 : (p.pos || 0); o.dur = p.dur || 0; o.watchedPart = !!p.done;
  }
  function state() {
    var tm = SHARED.tmdb || {};
    var out = films().map(function (f) {
      var id = f.id, l = P.local[id];
      var applyLocal = l && (!('base' in l) || !l.base || String(f.updated || '') <= String(l.base));
      if (applyLocal) ['rating', 'liked', 'status', 'watchedOn'].forEach(function (k) { if (k in l) f[k] = l[k]; });
      if (f.type === 'series' && f.episodes) f.episodes.forEach(function (ep) { putProgress(ep, id + '__' + epId(ep)); });
      else putProgress(f, id);
      var t = tm[id] || {};
      if (!f.poster && t.poster) f.poster = t.poster;
      if (!f.backdrop && t.backdrop) f.backdrop = t.backdrop;
      if (!f.backdrops && t.backdrops) f.backdrops = t.backdrops;
      if (!f.lang && t.lang) f.lang = t.lang;
      f.last = (P.last[id] || {}).key || ''; f.lastAt = (P.last[id] || {}).t || 0;
      return f;
    });
    return {
      films: out, platform: 'web', noDownloads: true, syncedAt: P.syncedAt || '', syncing: syncing, error: lastError,
      free: 0, total: 0, hasToken: true, version: 'iPhone', screensavers: screensavers(), audiobooks: audiobooks(), collections: LIB.collections || [],
      scanReport: 'список файлов приходит с проектора и Mac' + (syncNote ? ' · ' + syncNote : ''), update: ''
    };
  }

  // ---------- sync ----------
  function mergeUser(local, remote) {
    var out = { v: 1 }, lc = false, rc = false;
    ['films', 'progress', 'last'].forEach(function (sec) {
      var l = local[sec] || {}, r = remote[sec] || {}, m = {}, keys = {};
      Object.keys(l).forEach(function (k) { keys[k] = 1; }); Object.keys(r).forEach(function (k) { keys[k] = 1; });
      Object.keys(keys).forEach(function (k) {
        var a = l[k], b = r[k];
        if (!a) { m[k] = b; lc = true; } else if (!b) { m[k] = a; rc = true; }
        else if ((a.t || 0) > (b.t || 0)) { m[k] = a; rc = true; } else if ((b.t || 0) > (a.t || 0)) { m[k] = b; lc = true; } else m[k] = a;
      });
      out[sec] = m;
    });
    return { out: out, localChanged: lc, remoteChanged: rc };
  }
  async function syncUser() {
    var g = await gh('/contents/sync/state.json');
    var sha = null, remote = {};
    if (g.status === 200) { var j = await g.json(); sha = j.sha; try { remote = JSON.parse(unb64(j.content)); } catch (e) { remote = {}; } }
    else if (g.status !== 404) { syncNote = 'синхронизация: код ' + g.status; return; }
    var m = mergeUser({ films: P.local, progress: P.progress, last: P.last }, remote);
    if (m.localChanged) { P.local = m.out.films; P.progress = m.out.progress; P.last = m.out.last; saveP(); }
    if (m.remoteChanged) {
      var body = { message: 'Синхронизация с iPhone', content: b64(JSON.stringify(m.out)) };
      if (sha) body.sha = sha;
      var p = await gh('/contents/sync/state.json', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      syncNote = p.ok ? 'синхронизировано' : 'синхронизация: ошибка ' + p.status;
    } else syncNote = 'синхронизировано';
  }
  function refreshUi() { if (window.app && app.refresh) app.refresh(); }
  async function sync() {
    if (syncing) return;
    syncing = true; refreshUi();
    try {
      var r = await gh('/contents/library.json', { headers: { Accept: 'application/vnd.github.raw+json' } });
      if (r.status === 200) {
        LIB = await r.json(); put('lc_lib', LIB);
        var a = await gh('/contents/sync/auto.json', { headers: { Accept: 'application/vnd.github.raw+json' } });
        if (a.status === 200) { SHARED = await a.json(); put('lc_shared', SHARED); }
        lastError = ''; P.syncedAt = nowIso();
        try { await syncUser(); } catch (e) { syncNote = 'синхронизация не удалась'; }
        saveP();
      } else if (r.status === 401) { lastError = 'Пропуск не подходит — открой страницу заново'; LS.removeItem('lc_token'); }
      else lastError = 'Нет доступа к библиотеке (код ' + r.status + ')';
    } catch (e) {
      lastError = 'Нет интернета — показываю сохранённое';
    } finally { syncing = false; refreshUi(); }
  }
  var pushTimer = null;
  function pushSoon() { clearTimeout(pushTimer); pushTimer = setTimeout(function () { syncUser().then(refreshUi).catch(function () { }); }, 1500); }

  function setLocal(id, key, value) {
    var o = P.local[id] || {};
    o[key] = value; o.updated = nowIso(); o.t = Date.now();
    var lf = (LIB.films || []).filter(function (f) { return f.id === id; })[0];
    o.base = lf ? (lf.updated || '') : '';
    P.local[id] = o; saveP(); pushSoon();
  }
  function markWatched(id) { setLocal(id, 'status', 'watched'); if (!P.local[id].watchedOn) setLocal(id, 'watchedOn', nowIso().slice(0, 10)); }

  // ---------- player ----------
  var box = document.getElementById('player');
  function closePlayer() { box.hidden = true; box.innerHTML = ''; document.body.classList.remove('playing'); refreshUi(); pushSoon(); }
  function openPlayer(list, i, filmId) {
    var it = list[i];
    P.last[filmId] = { key: it.key, t: Date.now() }; saveP();
    var id = driveId(it.url);
    var next = i + 1 < list.length;
    // Safari often can't start Google's player inside a page, so the Drive app / page is one tap away
    var rtId = (/rutube\.ru\/video\/([a-f0-9]{32})/.exec(it.url) || [])[1];
    var from = Math.floor(((P.progress[it.key] || {}).done ? 0 : ((P.progress[it.key] || {}).pos || 0)) / 1000);
    var media = rtId
      ? '<div class="pwrap"><iframe id="rtf" src="https://rutube.ru/play/embed/' + rtId + '/?autoplay=1' + (from > 5 ? '&t=' + from : '') + '" allow="autoplay; fullscreen; encrypted-media" allowfullscreen></iframe></div>'
      : id
      ? '<div class="pwrap"><iframe src="https://drive.google.com/file/d/' + id + '/preview" allow="autoplay; fullscreen" allowfullscreen></iframe></div>' +
        '<a class="btn pri pdrive" href="https://drive.google.com/file/d/' + id + '/view" target="_blank" rel="noopener">▶ Открыть в Google Диске</a>' +
        '<p class="phint">Если видео не запускается здесь, нажми кнопку — фильм откроется в приложении Google Диск или в новой вкладке.</p>'
      : '<div class="pwrap"><video src="' + it.url.replace(/"/g, '&quot;') + '" controls autoplay playsinline></video></div>';
    box.innerHTML = '<div class="pbar"><button class="btn small" id="pClose">← Назад</button><b>' + it.title.replace(/</g, '&lt;') + '</b>' +
      (next ? '<button class="btn small pri" id="pNext">Следующая серия →</button>' : (list.length > 1 || !id ? '' : '<button class="btn small" id="pDone">Досмотрела</button>')) + '</div>' + media;
    box.hidden = false; document.body.classList.add('playing');
    document.getElementById('pClose').onclick = closePlayer;
    var nb = document.getElementById('pNext');
    if (nb) nb.onclick = function () { P.progress[it.key] = { pos: 0, done: true, t: Date.now() }; saveP(); openPlayer(list, i + 1, filmId); };
    var db = document.getElementById('pDone');
    if (db) db.onclick = function () { P.progress[it.key] = { pos: 0, done: true, t: Date.now() }; markWatched(filmId); closePlayer(); };
    // RUTUBE: the embedded player reports its time, so the place you stopped is saved like everywhere else
    if (rtId) {
      var rt = { time: 0, dur: 0, saved: 0 };
      if (window.__rtMsg) window.removeEventListener('message', window.__rtMsg);
      window.__rtMsg = function (e) {
        if (!/rutube\.ru$/.test((function () { try { return new URL(e.origin).hostname; } catch (x) { return ''; } })())) return;
        var m = e.data; try { if (typeof m === 'string') m = JSON.parse(m); } catch (x) { return; }
        if (!m || !m.type) return; var d = m.data || {};
        if (m.type === 'player:ready' && from > 5) { try { document.getElementById('rtf').contentWindow.postMessage(JSON.stringify({ type: 'player:setCurrentTime', data: { time: from } }), '*'); } catch (x) {} }
        if (m.type === 'player:durationChange' && d.duration) rt.dur = d.duration;
        if (m.type === 'player:currentTime' && d.time != null) {
          rt.time = d.time;
          if (Date.now() - rt.saved > 5000 && rt.dur) { rt.saved = Date.now(); P.progress[it.key] = { pos: Math.round(rt.time * 1000), dur: Math.round(rt.dur * 1000), done: rt.time > rt.dur - 60, t: Date.now() }; saveP(); }
        }
        if (m.type === 'player:changeState' && d.state === 'ended') { P.progress[it.key] = { pos: 0, done: true, t: Date.now() }; saveP(); if (next) openPlayer(list, i + 1, filmId); else { markWatched(filmId); closePlayer(); } }
      };
      window.addEventListener('message', window.__rtMsg);
    }
    var v = box.querySelector('video');
    if (v) {
      var p0 = (P.progress[it.key] || {}).pos || 0;
      v.addEventListener('loadedmetadata', function () { if (p0 > 5000) v.currentTime = p0 / 1000; });
      v.addEventListener('pause', function () { P.progress[it.key] = { pos: Math.round(v.currentTime * 1000), dur: Math.round((v.duration || 0) * 1000), done: false, t: Date.now() }; saveP(); });
      v.addEventListener('ended', function () { P.progress[it.key] = { pos: 0, done: true, t: Date.now() }; saveP(); if (next) openPlayer(list, i + 1, filmId); else { markWatched(filmId); closePlayer(); } });
    }
  }
  function play(filmId, key) {
    var all = items().filter(function (x) { return x.filmId === filmId && x.url; });
    var i = 0; all.forEach(function (x, n) { if (x.key === key) i = n; });
    if (!all.length) { alert('У этого фильма нет ссылки на файл'); return; }
    var it = all[i], id = driveId(it.url);
    if (id) {
      // on iPhone Google's own player (Drive app or page) works best and goes full screen properly
      P.last[filmId] = { key: it.key, t: Date.now() };
      if (all.length > 1 && i > 0) { var prev = all[i - 1]; P.progress[prev.key] = { pos: 0, done: true, t: Date.now() }; }
      saveP(); pushSoon(); refreshUi();
      window.open('https://drive.google.com/file/d/' + id + '/view', '_blank');
      return;
    }
    openPlayer(all.slice(i), 0, filmId);
  }
  function playLoop(url) {
    var id = driveId(url);
    box.innerHTML = '<div class="pbar"><button class="btn small" id="pClose">← Назад</button></div>' +
      (id ? '<div class="pwrap"><iframe src="https://drive.google.com/file/d/' + id + '/preview" allow="autoplay; fullscreen" allowfullscreen></iframe></div>' +
        '<a class="btn pri pdrive" href="https://drive.google.com/file/d/' + id + '/view" target="_blank" rel="noopener">▶ Открыть в Google Диске</a>'
        : '<div class="pwrap"><video src="' + url + '" autoplay loop muted playsinline></video></div>');
    box.hidden = false; document.body.classList.add('playing');
    document.getElementById('pClose').onclick = closePlayer;
  }

  // ---------- the bridge the interface expects ----------
  var noop = function () { };
  window.Android = {
    state: function () { return JSON.stringify(state()); },
    sync: function () { sync(); },
    download: noop, downloadAll: noop, remove: noop, installUpdate: noop,
    play: play, restart: function (f, k) { P.progress[k] = { pos: 0, done: false, t: Date.now() }; saveP(); play(f, k); },
    playLoop: function (u) { var s = screensavers().filter(function (x) { return x.url === u; })[0]; if (s && s.drive) { window.open('https://drive.google.com/file/d/' + s.drive + '/view', '_blank'); return; } playLoop(u); },
    openYoutube: function (id) { window.open('https://www.youtube.com/watch?v=' + id, '_blank'); },
    openUrl: function (u) { window.open(u, '_blank'); },
    setRating: function (id, r) { setLocal(id, 'rating', r); },
    setLiked: function (id, v) { setLocal(id, 'liked', v); },
    setStatus: function (id, s) { if (s === 'watched') markWatched(id); else setLocal(id, 'status', s); }
  };
  setTimeout(sync, 50);
  setInterval(sync, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) sync(); });
})();
