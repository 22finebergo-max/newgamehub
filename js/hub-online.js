/* The Game Hub — online rooms.
   Real-time 1v1 / party play over Supabase Realtime (broadcast + presence) on the
   existing *chat* project. No tables or SQL are needed: rooms are just realtime
   channels named "hub-<game>-<CODE>", so this works on plain Netlify hosting.

   Usage from a game page (loaded as ../../js/hub-online.js):
     HubOnline.openLobby({
       game: 'connectsamuel', title: 'Connect Samuel', min: 2, max: 2,
       theme: { ... },                       // optional colours
       onStart: function (room, data) {},    // host pressed Start / Rematch
       onEnd:   function (reason) {},        // room closed (host left, you left, offline)
       onClose: function () {}               // lobby closed with Back (no room)
     });
   Room API: room.me, room.isHost, room.players, room.send(ev, data), room.on(ev, fn),
             room.off(ev, fn), room.startMatch(extra), room.endMatch(), room.nameOf(id)
   Events:   'players' (list), 'left' (player), 'start' (data), plus any game events. */
(function () {
  'use strict';

  var BASE = (function () {
    var s = document.currentScript && document.currentScript.src;
    return s ? s.replace(/js\/hub-online\.js.*$/, '') : '../../';
  })();
  var FALLBACK = { url: 'https://azmeeaghohopwdwxmvbr.supabase.co', key: 'sb_publishable_00HcX4jPC-y8_OnwX1kv-g_zU_OPwcw' };
  var LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';           /* no I / O — easy to read out loud */
  var BAD = ['fuck', 'shit', 'cunt', 'nigg', 'bitch', 'wank', 'penis', 'dick', 'slut', 'rape', 'fag'];

  function makeCode() { var s = ''; for (var i = 0; i < 4; i++) s += LETTERS[Math.floor(Math.random() * LETTERS.length)]; return s; }
  function uid() { var s = ''; for (var i = 0; i < 12; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]; return s; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function cleanName(nm) {
    nm = String(nm || '').replace(/\s+/g, ' ').trim().slice(0, 14);
    var low = nm.toLowerCase().replace(/[^a-z]/g, '');
    for (var i = 0; i < BAD.length; i++) if (low.indexOf(BAD[i]) !== -1) return '';
    return nm;
  }
  function defaultName() {
    var n = lsGet('hubOnlineName', '');
    if (!n) { try { n = JSON.parse(lsGet('gamehub-profile-v1', '{}')).name || ''; } catch (e) {} }
    return cleanName(n);
  }

  /* ---------- Supabase library (lazy, reuses the hub's local bundle) ---------- */
  var libPromise = null, client = null;
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.onload = res;
      s.onerror = function () { rej(new Error('Could not load the online library. Check your connection.')); };
      document.head.appendChild(s);
    });
  }
  function lib() {
    if (window.SupabaseBrowser) return Promise.resolve();
    if (!libPromise) {
      libPromise = (window.HUB_SUPA ? Promise.resolve() : loadScript(BASE + 'games/amaan/js/supa-config.js').catch(function () {}))
        .then(function () { return loadScript(BASE + 'games/amaan/js/supabase.bundle.js'); });
      libPromise.catch(function () { libPromise = null; });
    }
    return libPromise;
  }
  function getClient() {
    if (client) return client;
    var cfg = (window.HUB_SUPA && window.HUB_SUPA.chat) || FALLBACK;
    client = window.SupabaseBrowser.createClient(cfg.url || FALLBACK.url, cfg.key || FALLBACK.key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'hub-online-auth' },
      realtime: { params: { eventsPerSecond: 30 } }
    });
    return client;
  }

  /* ---------- Room ---------- */
  function Room(game, code, name, max) {
    this.game = game; this.code = code; this.name = name; this.max = max;
    this.me = uid(); this.isHost = false; this.players = []; this.handlers = {};
    this.ch = null; this.meta = null; this.closed = false; this.round = 0; this.hadHost = false;
  }
  Room.prototype.on = function (ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); return this; };
  Room.prototype.off = function (ev, fn) { var a = this.handlers[ev]; if (a) this.handlers[ev] = a.filter(function (f) { return f !== fn; }); return this; };
  Room.prototype.emit = function (ev, d, from) {
    (this.handlers[ev] || []).slice().forEach(function (f) { try { f(d, from); } catch (e) { console.error(e); } });
  };
  Room.prototype.send = function (ev, data) {
    if (!this.ch || this.closed) return;
    this.ch.send({ type: 'broadcast', event: 'g', payload: { e: ev, f: this.me, d: data } });
  };
  Room.prototype.nameOf = function (id) {
    for (var i = 0; i < this.players.length; i++) if (this.players[i].id === id) return this.players[i].name;
    return (this.lastNames && this.lastNames[id]) || 'Player';
  };
  Room.prototype.setMeta = function (patch) {
    if (!this.ch || this.closed) return;
    for (var k in patch) this.meta[k] = patch[k];
    this.ch.track(this.meta);
  };
  Room.prototype.sync = function () {
    if (!this.ch) return;
    var st = this.ch.presenceState(), list = [], self = this;
    Object.keys(st).forEach(function (k) { var m = st[k] && st[k][0]; if (m && m.id) list.push(m); });
    list.sort(function (a, b) { return (a.at - b.at) || (a.id < b.id ? -1 : 1); });
    var prev = this.players;
    this.players = list;
    this.lastNames = this.lastNames || {};
    list.forEach(function (p) { self.lastNames[p.id] = p.name; });
    var host = null;
    for (var i = 0; i < list.length; i++) if (list[i].host) { host = list[i]; break; }
    if (host) this.hadHost = true;
    prev.forEach(function (p) {
      if (!list.some(function (q) { return q.id === p.id; })) self.emit('left', p);
    });
    this.emit('players', list);
    if (this.hadHost && !host && !this.isHost) this.emit('hostleft');
  };
  Room.prototype.connect = function (asHost) {
    var self = this;
    this.isHost = !!asHost;
    this.meta = { id: this.me, name: this.name, host: !!asHost, at: Date.now(), playing: false };
    return new Promise(function (resolve, reject) {
      var ch = getClient().channel('hub-' + self.game + '-' + self.code, {
        config: { broadcast: { self: false, ack: false }, presence: { key: self.me } }
      });
      self.ch = ch;
      ch.on('broadcast', { event: 'g' }, function (m) {
        var p = (m && m.payload) || {};
        if (!p.e || p.f === self.me) return;
        self.emit(p.e, p.d, p.f);
      });
      ch.on('presence', { event: 'sync' }, function () { self.sync(); });
      var done = false;
      var timer = setTimeout(function () {
        if (done) return; done = true;
        reject(new Error('The online server took too long to answer. Try again.'));
      }, 12000);
      ch.subscribe(function (status) {
        if (self.closed) return;
        if (status === 'SUBSCRIBED') {
          ch.track(self.meta);
          if (!done) { done = true; clearTimeout(timer); resolve(); }
        } else if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && !done) {
          done = true; clearTimeout(timer);
          reject(new Error('Could not reach the online server. Check your connection and try again.'));
        }
      });
    });
  };
  Room.prototype.waitFor = function (test, ms) {
    var self = this;
    return new Promise(function (res) {
      if (test(self.players)) return res(true);
      var t = setTimeout(function () { self.off('players', h); res(test(self.players)); }, ms);
      function h(list) { if (test(list)) { clearTimeout(t); self.off('players', h); res(true); } }
      self.on('players', h);
    });
  };
  Room.prototype.leave = function () {
    if (this.closed) return;
    this.closed = true;
    var ch = this.ch; this.ch = null;
    if (ch) { try { ch.untrack(); } catch (e) {} try { getClient().removeChannel(ch); } catch (e) {} }
  };
  /* host only: start (or restart) a match with everyone currently in the room */
  Room.prototype.startMatch = function (extra) {
    if (!this.isHost) return;
    this.round++;
    var data = { round: this.round, seed: Math.floor(Math.random() * 1e9), ids: this.players.slice(0, this.max).map(function (p) { return p.id; }), names: {} };
    var self = this;
    data.ids.forEach(function (id) { data.names[id] = self.nameOf(id); });
    if (extra) for (var k in extra) data[k] = extra[k];
    this.setMeta({ playing: true });
    this.send('start', data);
    this.emit('start', data, this.me);
  };
  Room.prototype.endMatch = function () { if (this.isHost) this.setMeta({ playing: false }); };

  /* ---------- Lobby UI ---------- */
  var CSS = '' +
    '#hoLobby{position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;padding:16px;background:var(--ho-bg);font-family:var(--ho-font);color:var(--ho-text);-webkit-user-select:none;user-select:none;touch-action:manipulation}' +
    '#hoLobby.on{display:flex;animation:hoFade .22s ease-out}' +
    '@keyframes hoFade{from{opacity:0}to{opacity:1}}' +
    '@keyframes hoPop{from{transform:translateY(14px) scale(.97);opacity:0}to{transform:none;opacity:1}}' +
    '@keyframes hoPulse{0%,100%{opacity:.55}50%{opacity:1}}' +
    '#hoLobby .ho-card{width:min(92vw,340px);max-height:92vh;overflow:auto;background:var(--ho-panel);border:3px solid var(--ho-border);border-radius:20px;padding:20px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.35);animation:hoPop .26s cubic-bezier(.2,.9,.3,1.2)}' +
    '#hoLobby h2{margin:0 0 4px;font-size:24px;color:var(--ho-title)}' +
    '#hoLobby .ho-sub{margin:0 0 12px;font-size:13px;opacity:.8;line-height:1.4}' +
    '#hoLobby label{display:block;text-align:left;font-size:12px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;opacity:.75;margin:10px 0 5px}' +
    '#hoLobby input{width:100%;box-sizing:border-box;font:700 17px var(--ho-font);padding:11px 12px;border-radius:12px;border:2px solid var(--ho-border);background:var(--ho-input);color:var(--ho-text);outline:none;-webkit-user-select:text;user-select:text;transition:border-color .15s,box-shadow .15s}' +
    '#hoLobby input:focus{box-shadow:0 0 0 3px var(--ho-ring)}' +
    '#hoLobby .ho-codein{text-transform:uppercase;letter-spacing:8px;text-align:center;font-size:24px}' +
    '#hoLobby .ho-btn{display:block;width:100%;margin-top:10px;padding:13px;border-radius:14px;border:2px solid var(--ho-border);background:var(--ho-accent);color:var(--ho-accent-text);font:800 17px var(--ho-font);cursor:pointer;box-shadow:0 4px 0 var(--ho-shadow);transition:transform .1s,box-shadow .1s,opacity .15s}' +
    '#hoLobby .ho-btn:active{transform:translateY(2px);box-shadow:0 2px 0 var(--ho-shadow)}' +
    '#hoLobby .ho-btn[disabled]{opacity:.45;cursor:not-allowed}' +
    '#hoLobby .ho-btn.ghost{background:transparent;color:var(--ho-text)}' +
    '#hoLobby .ho-or{display:flex;align-items:center;gap:8px;margin:14px 0 2px;font-size:12px;opacity:.65;font-weight:700}' +
    '#hoLobby .ho-or:before,#hoLobby .ho-or:after{content:"";flex:1;height:2px;background:var(--ho-border);opacity:.4}' +
    '#hoLobby .ho-msg{min-height:18px;font-size:13px;font-weight:700;margin-top:10px;color:var(--ho-warn)}' +
    '#hoLobby .ho-msg.ok{color:var(--ho-ok)}' +
    '#hoLobby .ho-code{display:flex;justify-content:center;gap:8px;margin:6px 0 4px}' +
    '#hoLobby .ho-code span{width:52px;height:62px;display:flex;align-items:center;justify-content:center;font:900 34px var(--ho-font);border-radius:12px;background:var(--ho-input);border:2px solid var(--ho-border);color:var(--ho-title)}' +
    '#hoLobby .ho-players{list-style:none;margin:12px 0 0;padding:0;text-align:left}' +
    '#hoLobby .ho-players li{display:flex;align-items:center;gap:8px;padding:9px 11px;margin-bottom:6px;border-radius:11px;background:var(--ho-input);border:1px solid var(--ho-border);font-weight:700;animation:hoPop .2s ease-out}' +
    '#hoLobby .ho-dot{width:12px;height:12px;border-radius:50%;flex:none}' +
    '#hoLobby .ho-tag{margin-left:auto;font-size:11px;font-weight:800;padding:2px 7px;border-radius:8px;background:var(--ho-accent);color:var(--ho-accent-text)}' +
    '#hoLobby .ho-wait{font-size:13px;margin-top:10px;animation:hoPulse 1.6s infinite}';

  var DEFAULT_THEME = {
    bg: 'rgba(8,12,30,.9)', panel: '#121a3a', border: '#ff9e40', text: '#f4f6ff', title: '#ffd27a',
    input: 'rgba(255,255,255,.07)', accent: '#ff9e40', accentText: '#fff', shadow: '#a85a12',
    ring: 'rgba(255,158,64,.35)', warn: '#ff8a8a', ok: '#8ef0b0', font: 'system-ui,-apple-system,"Segoe UI",sans-serif'
  };
  var PCOL = ['#ff4d4d', '#ffd600', '#35c6ff', '#7dff7a'];

  var el = null, opts = null, room = null, view = 'home', busy = false;

  function ensureEl() {
    if (el) return el;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    el = document.createElement('div'); el.id = 'hoLobby';
    el.setAttribute('data-testid', 'online-lobby');
    /* keep typing inside the lobby away from the game's own key handlers */
    ['keydown', 'keyup', 'pointerdown', 'touchstart'].forEach(function (t) {
      el.addEventListener(t, function (e) { e.stopPropagation(); });
    });
    document.body.appendChild(el);
    return el;
  }
  function applyTheme(t) {
    var th = {}, k;
    for (k in DEFAULT_THEME) th[k] = DEFAULT_THEME[k];
    if (t) for (k in t) th[k] = t[k];
    var map = { bg: 'bg', panel: 'panel', border: 'border', text: 'text', title: 'title', input: 'input', accent: 'accent',
      accentText: 'accent-text', shadow: 'shadow', ring: 'ring', warn: 'warn', ok: 'ok', font: 'font' };
    for (k in map) el.style.setProperty('--ho-' + map[k], th[k]);
  }
  function q(sel) { return el.querySelector(sel); }
  function msg(text, ok) { var m = q('.ho-msg'); if (m) { m.textContent = text || ''; m.className = 'ho-msg' + (ok ? ' ok' : ''); } }

  function renderHome(errText) {
    view = 'home';
    var nm = defaultName();
    el.innerHTML = '<div class="ho-card">' +
      '<h2>🌐 Play online</h2>' +
      '<p class="ho-sub">' + esc(opts.title) + ' · ' + (opts.max > 2 ? '2–' + opts.max + ' players' : '1v1') +
      '<br>Make a room and send the code to a friend, or type their code to join.</p>' +
      '<label for="hoName">Your name</label>' +
      '<input id="hoName" data-testid="online-name-input" maxlength="14" placeholder="Your name" value="' + esc(nm) + '">' +
      '<button class="ho-btn" id="hoCreate" data-testid="online-create-room-button">✨ Create room</button>' +
      '<div class="ho-or">or join a friend</div>' +
      '<input id="hoCode" class="ho-codein" data-testid="online-code-input" maxlength="4" placeholder="CODE" autocomplete="off" autocapitalize="characters" spellcheck="false">' +
      '<button class="ho-btn" id="hoJoin" data-testid="online-join-room-button">🚪 Join room</button>' +
      '<div class="ho-msg" data-testid="online-lobby-message"></div>' +
      '<button class="ho-btn ghost" id="hoBack" data-testid="online-back-button">Back</button>' +
      '</div>';
    if (errText) msg(errText);
    var codeIn = q('#hoCode');
    codeIn.addEventListener('input', function () {
      var v = codeIn.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      if (v !== codeIn.value) codeIn.value = v;
    });
    codeIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') doJoin(); });
    q('#hoCreate').onclick = doCreate;
    q('#hoJoin').onclick = doJoin;
    q('#hoBack').onclick = function () { close(); if (opts.onClose) opts.onClose(); };
  }

  function readName() {
    var raw = q('#hoName').value;
    var nm = cleanName(raw);
    if (!nm) { msg(raw.trim() ? 'Pick a different name — that one is not allowed.' : 'Type your name first.'); return ''; }
    lsSet('hubOnlineName', nm);
    return nm;
  }
  function setBusy(b, text) {
    busy = b;
    ['#hoCreate', '#hoJoin'].forEach(function (s) { var x = q(s); if (x) x.disabled = b; });
    if (text) msg(text, true);
  }

  function doCreate() {
    if (busy) return;
    var nm = readName(); if (!nm) return;
    setBusy(true, 'Making your room…');
    lib().then(function () { return tryCreate(nm, 0); }).then(function (r) {
      attach(r); renderRoom();
    }).catch(function (e) { setBusy(false); msg(e.message || String(e)); });
  }
  function tryCreate(nm, attempt) {
    var r = new Room(opts.game, makeCode(), nm, opts.max);
    return r.connect(true).then(function () {
      /* a short look round: is somebody else already hosting this code? */
      return r.waitFor(function (l) { return l.some(function (p) { return p.host && p.id !== r.me; }); }, 700);
    }).then(function (clash) {
      if (clash && attempt < 4) { r.leave(); return tryCreate(nm, attempt + 1); }
      return r;
    }, function (e) { r.leave(); throw e; });
  }

  function doJoin() {
    if (busy) return;
    var nm = readName(); if (!nm) return;
    var code = q('#hoCode').value.toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length !== 4) { msg('Room codes are 4 letters.'); return; }
    setBusy(true, 'Looking for room ' + code + '…');
    var r;
    lib().then(function () {
      r = new Room(opts.game, code, nm, opts.max);
      return r.connect(false);
    }).then(function () {
      return r.waitFor(function (l) { return l.some(function (p) { return p.host; }) && l.some(function (p) { return p.id === r.me; }); }, 3500);
    }).then(function (found) {
      if (!found || !r.players.some(function (p) { return p.host; })) { r.leave(); throw new Error('No room with code ' + code + '. Check the letters and try again.'); }
      var idx = r.players.map(function (p) { return p.id; }).indexOf(r.me);
      if (idx >= opts.max) { r.leave(); throw new Error('Room ' + code + ' is full (' + opts.max + ' players max).'); }
      var host = r.players.filter(function (p) { return p.host; })[0];
      if (host && host.playing && opts.max <= 2) { r.leave(); throw new Error('That room is already in a game.'); }
      attach(r); renderRoom();
    }).catch(function (e) { if (r && !room) r.leave(); setBusy(false); msg(e.message || String(e)); });
  }

  function attach(r) {
    room = r; busy = false;
    window.HubOnline.room = r;
    r.on('players', function () { if (view === 'room') paintPlayers(); });
    r.on('start', function (data) {
      if (data.ids.indexOf(r.me) === -1) return;      /* joined mid-round — wait for the next one */
      close();
      if (opts.onStart) opts.onStart(r, data);
    });
    r.on('hostleft', function () { endRoom('The host left the room.'); });
  }

  function endRoom(reason) {
    var r = room;
    if (!r) return;
    room = null; window.HubOnline.room = null;
    r.leave();
    if (opts && opts.onEnd) opts.onEnd(reason || '');
    show(); renderHome(reason);
  }

  function renderRoom() {
    view = 'room';
    var r = room;
    el.innerHTML = '<div class="ho-card">' +
      '<h2>' + esc(opts.title) + '</h2>' +
      '<p class="ho-sub">Room code — tell your friend to type it in 🌐 Online</p>' +
      '<div class="ho-code" data-testid="online-room-code">' + r.code.split('').map(function (c) { return '<span>' + c + '</span>'; }).join('') + '</div>' +
      '<button class="ho-btn ghost" id="hoShare" data-testid="online-share-code-button" style="padding:8px;font-size:14px">📋 Copy / share code</button>' +
      '<ul class="ho-players" data-testid="online-player-list"></ul>' +
      '<div class="ho-wait" id="hoWait" data-testid="online-wait-text"></div>' +
      '<button class="ho-btn" id="hoStart" data-testid="online-start-button">▶ Start</button>' +
      '<div class="ho-msg" data-testid="online-lobby-message"></div>' +
      '<button class="ho-btn ghost" id="hoLeave" data-testid="online-leave-button">Leave room</button>' +
      '</div>';
    q('#hoStart').style.display = r.isHost ? '' : 'none';
    q('#hoStart').onclick = function () {
      if (!room || room.players.length < (opts.min || 2)) return;
      room.startMatch();
    };
    q('#hoLeave').onclick = function () { leaveRoom(); };
    q('#hoShare').onclick = function () {
      var text = 'Join my ' + opts.title + ' room on The Game Hub — code ' + r.code;
      if (navigator.share) { navigator.share({ text: text }).catch(function () {}); return; }
      try { navigator.clipboard.writeText(r.code).then(function () { msg('Code copied!', true); }); } catch (e) { msg('Code: ' + r.code, true); }
    };
    paintPlayers();
  }

  function paintPlayers() {
    var r = room; if (!r || view !== 'room') return;
    var ul = q('.ho-players'); if (!ul) return;
    var list = r.players.slice(0, opts.max);
    ul.innerHTML = list.map(function (p, i) {
      return '<li data-testid="online-player-' + i + '"><span class="ho-dot" style="background:' + PCOL[i % 4] + '"></span>' +
        esc(p.name) + (p.id === r.me ? ' <span style="opacity:.6;font-weight:600">(you)</span>' : '') +
        (p.host ? '<span class="ho-tag">HOST</span>' : '') + '</li>';
    }).join('');
    var need = (opts.min || 2) - list.length;
    var host = r.players.filter(function (p) { return p.host; })[0];
    var wait = q('#hoWait'), start = q('#hoStart');
    if (r.isHost) {
      start.disabled = need > 0;
      start.textContent = '▶ Start (' + list.length + '/' + opts.max + ')';
      wait.textContent = need > 0 ? 'Waiting for ' + (need === 1 ? 'a friend' : need + ' more players') + ' to join…'
        : (list.length < opts.max ? 'Ready! Start now or wait for more players.' : 'Room full — start when ready!');
    } else {
      wait.textContent = host && host.playing ? 'A round is running — you will join the next one.' : 'Waiting for ' + (host ? host.name : 'the host') + ' to start…';
    }
  }

  function leaveRoom() {
    var r = room;
    room = null; window.HubOnline.room = null;
    if (r) r.leave();
    if (opts && opts.onEnd) opts.onEnd('left');
    renderHome();
  }

  function show() { ensureEl(); el.classList.add('on'); }
  function close() { if (el) el.classList.remove('on'); }

  window.HubOnline = {
    room: null,
    colors: PCOL,
    openLobby: function (o) {
      opts = o || {}; ensureEl(); applyTheme(opts.theme); show();
      if (room && !room.closed) renderRoom(); else renderHome();
      lib().catch(function () {});   /* warm the library while the player types */
    },
    /* return to the room screen between rounds */
    showRoom: function () { if (!room) return; ensureEl(); show(); renderRoom(); },
    leave: function () { if (room) leaveRoom(); close(); },
    endRoom: endRoom,
    close: close
  };
  window.addEventListener('pagehide', function () { if (room) room.leave(); });
})();
