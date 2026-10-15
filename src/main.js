import './style.css';
import { apply, viewFor, newGame, other, canGuess, canSudden, greensLeft, foundCount, TOTAL_AGENTS, DEFAULT_SETTINGS } from './game.js';
import { hostRoom, joinRoom, normalizeCode } from './net.js';
import { WORDS } from './words.js';

const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k, def, ss = false) { try { const v = (ss ? sessionStorage : localStorage).getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } },
  set(k, v, ss = false) { try { (ss ? sessionStorage : localStorage).setItem(k, JSON.stringify(v)); } catch {} },
  del(k, ss = false) { try { (ss ? sessionStorage : localStorage).removeItem(k); } catch {} },
};

const ui = {
  screen: 'home', // home | connecting | room | game
  role: null, // host | guest
  code: '',
  myName: store.get('cnduet-name', ''),
  partnerName: '',
  connected: false,
  settings: { ...DEFAULT_SETTINGS, lang: 'ja', ...store.get('cnduet-settings', {}) },
  view: null,
  selected: -1,
  partnerPoint: -1,
  showKey: store.get('cnduet-showkey', true),
  clueWord: '',
  clueNum: '',
  toast: '',
  error: '',
  homeError: '',
};

// ---------------- ホスト側 ----------------
let host = null; // { net, conn, full }
let guest = null; // { net, retry }

function startHost(fixedCode = null, resume = null) {
  ui.role = 'host';
  ui.screen = 'connecting';
  host = { net: null, conn: null, full: resume?.full || null };
  if (resume) { ui.settings = resume.settings; ui.partnerName = resume.guestName || ''; }
  render();
  host.net = hostRoom({
    onCode(code) {
      ui.code = code;
      ui.screen = host.full ? 'game' : 'room';
      history.replaceState(null, '', `?room=${code}`);
      if (host.full) ui.view = viewFor(host.full, 'A');
      persistHost();
      render();
    },
    onConnect(conn) {
      if (host.conn && host.conn !== conn) { try { host.conn.close(); } catch {} }
      host.conn = conn;
    },
    onMessage(conn, m) {
      if (conn !== host.conn) return;
      if (m.t === 'hello') {
        ui.partnerName = String(m.name || 'ゲスト').slice(0, 16);
        ui.connected = true;
        if (host.full) host.full.names.B = ui.partnerName;
        toast(`${ui.partnerName} さんが入室しました`);
        sync();
      } else if (m.t === 'act') {
        hostAction('B', m.act);
      } else if (m.t === 'point') {
        ui.partnerPoint = Number.isInteger(m.idx) ? m.idx : -1;
        renderBoardOnly();
      }
    },
    onClose(conn) {
      if (conn !== host.conn) return;
      host.conn = null;
      ui.connected = false;
      ui.partnerPoint = -1;
      toast('相手との接続が切れました。再接続を待っています…');
      render();
    },
    onError(type) {
      if (fixedCode && type === 'unavailable-id') {
        ui.homeError = '部屋を復元できませんでした。新しく部屋を作ってください。';
        store.del('cnduet-host', true);
      } else ui.homeError = `部屋を作れませんでした（${type}）`;
      leave(false);
    },
  }, fixedCode);
}

function persistHost() {
  if (ui.role !== 'host' || !ui.code) return;
  store.set('cnduet-host', { code: ui.code, full: host.full, settings: ui.settings, guestName: ui.partnerName }, true);
}

function send(m) {
  if (ui.role === 'host') { if (host.conn?.open) host.conn.send(m); }
  else guest?.net?.send(m);
}

function sync() {
  const lobby = { hostName: ui.myName, guestName: ui.partnerName, settings: ui.settings };
  send({ t: 'sync', lobby, view: host.full ? viewFor(host.full, 'B') : null });
  setView(host.full ? viewFor(host.full, 'A') : null);
  persistHost();
  render();
}

function hostAction(side, act) {
  if (act.type === 'start') {
    if (side !== 'A' || !ui.connected) return;
    host.full = newGame({ words: WORDS[ui.settings.lang] || WORDS.ja, names: { A: ui.myName, B: ui.partnerName }, settings: ui.settings });
    return sync();
  }
  if (act.type === 'lobby') {
    if (host.full && host.full.phase !== 'won' && host.full.phase !== 'lost') return;
    host.full = null;
    return sync();
  }
  if (act.type === 'settings') {
    if (side !== 'A' || host.full) return;
    ui.settings = { ...ui.settings, ...act.settings };
    store.set('cnduet-settings', ui.settings);
    return sync();
  }
  if (!host.full) return;
  const res = apply(host.full, side, act);
  if (res.error) {
    if (side === 'A') { ui.error = res.error; render(); } else send({ t: 'error', msg: res.error });
    return;
  }
  host.full = res;
  sync();
}

// ---------------- ゲスト側 ----------------
function startGuest(code) {
  ui.role = 'guest';
  ui.code = code;
  ui.screen = 'connecting';
  store.set('cnduet-guest', { code }, true);
  history.replaceState(null, '', `?room=${code}`);
  render();
  connectGuest(0);
}

function connectGuest(attempt) {
  if (ui.role !== 'guest') return;
  const net = joinRoom(ui.code, {
    onOpen() {
      ui.connected = true;
      net.send({ t: 'hello', name: ui.myName });
      if (guest) guest.attempt = 0;
    },
    onMessage(m) {
      if (m.t === 'sync') {
        ui.partnerName = m.lobby.hostName;
        ui.settings = m.lobby.settings;
        ui.screen = m.view ? 'game' : 'room';
        setView(m.view);
        render();
      } else if (m.t === 'error') {
        ui.error = m.msg;
        render();
      } else if (m.t === 'point') {
        ui.partnerPoint = Number.isInteger(m.idx) ? m.idx : -1;
        renderBoardOnly();
      }
    },
    onClose() {
      ui.connected = false;
      ui.partnerPoint = -1;
      toast('接続が切れました。再接続しています…');
      render();
      retryGuest(1);
    },
    onError(type) {
      if (ui.screen === 'connecting' && attempt === 0) {
        ui.homeError = type === 'peer-unavailable' ? 'その部屋は見つかりませんでした。コードを確認してください。' : `接続できませんでした（${type}）`;
        store.del('cnduet-guest', true);
        leave(false);
      } else retryGuest(attempt + 1);
    },
  });
  guest = { net, attempt };
}

function retryGuest(attempt) {
  if (ui.role !== 'guest') return;
  guest?.net?.close();
  if (attempt > 20) { toast('再接続できませんでした。部屋に入り直してください。'); return; }
  clearTimeout(guest?.timer);
  const timer = setTimeout(() => connectGuest(attempt), 2500);
  guest = { ...guest, timer };
}

// ---------------- 共通 ----------------
function act(a) {
  ui.error = '';
  if (ui.role === 'host') hostAction('A', a);
  else send({ t: 'act', act: a });
}

function setView(v) {
  const p = ui.view;
  ui.view = v;
  if (ui.role === 'host' && ui.screen !== 'connecting') ui.screen = v ? 'game' : 'room';
  ui.flips = new Set();
  if (!v) { ui.selected = -1; return; }
  if (ui.selected >= 0 && !selectable(ui.selected)) ui.selected = -1;
  if (v.phase !== 'clue') { ui.clueWord = ''; ui.clueNum = ''; }
  if (p && p.words.join() === v.words.join() && p.log.length < v.log.length) {
    announce(v.log.slice(p.log.length), v);
    const me = v.me, pa = other(me);
    v.words.forEach((_, i) => {
      if ((v.found[i] && !p.found[i]) || (v.byst[me][i] && !p.byst[me][i]) || (v.byst[pa][i] && !p.byst[pa][i]) || (v.assassin === i && p.assassin !== i)) ui.flips.add(i);
    });
    clearTimeout(flipTimer);
    flipTimer = setTimeout(() => { ui.flips = new Set(); }, 800);
  }
}
let flipTimer;

function point(idx) {
  ui.selected = idx;
  send({ t: 'point', idx });
}

function leave(clear = true) {
  host?.net?.close();
  guest?.net?.close();
  clearTimeout(guest?.timer);
  host = guest = null;
  if (clear) { store.del('cnduet-host', true); store.del('cnduet-guest', true); }
  Object.assign(ui, { screen: 'home', role: null, code: '', connected: false, view: null, partnerName: '', selected: -1, partnerPoint: -1 });
  history.replaceState(null, '', location.pathname);
  render();
}

let toastTimer;
function toast(msg) {
  ui.toast = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast = ''; renderToast(); }, 2600);
  renderToast();
}

const sideName = (v, s) => (s === v.me ? 'あなた' : v.names[s] || '相手');

function announce(events, v) {
  for (const e of events) {
    if (e.k === 'agent') toast(`「${v.words[e.idx]}」はエージェント！`);
    else if (e.k === 'byst') toast(e.sudden ? `「${v.words[e.idx]}」は一般人…` : `「${v.words[e.idx]}」は一般人。ターン終了`);
    else if (e.k === 'clue' && e.side !== v.me) toast(`手がかり：「${e.word}」${e.num}`);
    else if (e.k === 'sudden') toast('タイマー切れ！ サドンデス突入');
  }
}

// ---------------- 描画 ----------------
function selectable(i) {
  const v = ui.view;
  if (!v) return false;
  if (v.phase === 'guess') return v.giver !== v.me && canGuess(v, i);
  if (v.phase === 'sudden') return canSudden(v, v.me, i);
  return false;
}

function render() {
  const s = ui.screen;
  if (s === 'home') $app.innerHTML = homeHTML();
  else if (s === 'connecting') $app.innerHTML = `<div class="center-msg"><div class="spinner"></div><p>${ui.role === 'host' ? '部屋を準備しています…' : '部屋に接続しています…'}</p><button class="btn ghost" data-a="leave">やめる</button></div>`;
  else if (s === 'room') $app.innerHTML = roomHTML();
  else if (s === 'game') $app.innerHTML = gameHTML();
  renderToast();
  bindAfterRender();
}

function renderBoardOnly() {
  const el = document.getElementById('board');
  if (el && ui.view) el.outerHTML = boardHTML(ui.view);
  else render();
}

function renderToast() {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = ui.toast;
  t.className = ui.toast ? 'show' : '';
}

const logoHTML = `<div class="logo"><span class="logo-mark">◆</span><span>コードネーム<b>デュエット</b></span></div>`;

function homeHTML() {
  const q = normalizeCode(new URLSearchParams(location.search).get('room') || '');
  return `
  <div class="home">
    <section class="hero">
      ${logoHTML}
      <h1>ふたりで、<br>15人のエージェントを探せ。</h1>
      <p class="lead">25枚の言葉の中に隠れた仲間を、ひとことの手がかりだけで見つけ出す協力型の言葉当てゲーム。URLを送るだけで、離れた相手と直接つながって遊べます。</p>
    </section>
    <section class="panel home-form">
      <label class="field"><span>あなたの名前</span><input id="name" maxlength="16" placeholder="例：エージェントK" value="${esc(ui.myName)}"></label>
      ${ui.homeError ? `<p class="err">${esc(ui.homeError)}</p>` : ''}
      ${q ? `
        <p class="invite">部屋 <b>${q}</b> に招待されています</p>
        <button class="btn primary big" data-a="join" data-code="${q}">この部屋に参加する</button>
        <button class="btn ghost" data-a="clearInvite">自分で部屋を作る</button>
      ` : `
        <button class="btn primary big" data-a="create">部屋を作る</button>
        <div class="or"><span>または</span></div>
        <div class="join-row"><input id="code" maxlength="5" placeholder="部屋コード" autocomplete="off"><button class="btn" data-a="join">参加</button></div>
      `}
    </section>
    ${rulesHTML()}
  </div>`;
}

function rulesHTML() {
  return `
  <details class="panel rules">
    <summary>遊び方</summary>
    <ol>
      <li>2人はそれぞれ<b>キーカードの片面</b>だけを見ます。自分の面には <i class="dot g"></i>緑のエージェント9人・<i class="dot a"></i>暗殺者3人・残りは一般人。相手の面の配置は分かりません（緑のうち3枚は両面共通）。</li>
      <li>手番では<b>手がかりを出す人</b>が「ひとつの単語＋数」を伝えます。もう1人は手がかりを出した人のキーカードで緑だと思うカードを選びます。</li>
      <li>緑なら続けて選べます（数を超えてもOK）。<b>一般人</b>を選ぶとターン終了。<b>暗殺者</b>を選ぶと即敗北。1枚以上選べば自分の判断でやめることもできます。</li>
      <li>ターンが終わるたびにタイマーを1つ使い、手がかりを出す人が交代します。自分の緑を全員見つけてもらった人は、以後は当てる役に専念します。</li>
      <li>タイマーが尽きると<b>サドンデス</b>。手がかりなしで、相手側のエージェントだと思うカードを選びます。緑以外を選んだら敗北。</li>
      <li>両面あわせて<b>15人のエージェント</b>を全員見つけたら2人の勝利！</li>
    </ol>
    <p class="note">場に見えている単語そのものは手がかりにできません。手がかりは単語の意味に関するものにしましょう。</p>
  </details>`;
}

function roomHTML() {
  const isHost = ui.role === 'host';
  const st = ui.settings;
  const link = `${location.origin}${location.pathname}?room=${ui.code}`;
  const me = esc(ui.myName), pn = esc(ui.partnerName);
  const hostName = isHost ? me : pn, guestName = isHost ? pn : me;
  const guestHere = isHost ? ui.connected : true;
  const sel = (name, opts, val) => `<select data-set="${name}" ${isHost ? '' : 'disabled'}>${opts.map(([v, l]) => `<option value="${v}" ${String(v) === String(val) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const nums = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => [a + i, String(a + i)]);
  return `
  <div class="room">
    <header class="topbar">${logoHTML}<button class="btn ghost small" data-a="leave">退出</button></header>
    <section class="panel">
      <p class="label">部屋コード</p>
      <div class="code-big">${ui.code}</div>
      <div class="share"><input readonly value="${esc(link)}" id="link"><button class="btn" data-a="copy">招待リンクをコピー</button></div>
      <p class="hint">このリンクを相手に送ってください。データは端末同士で直接やり取りされます。</p>
    </section>
    <section class="panel players">
      <div class="player"><span class="badge">ホスト</span><b>${hostName}</b></div>
      <div class="player ${guestHere ? '' : 'waiting'}"><span class="badge">ゲスト</span><b>${guestHere ? guestName : '相手の参加を待っています…'}</b></div>
    </section>
    <section class="panel settings">
      <p class="label">ルール設定 ${isHost ? '' : '<small>（ホストが設定します）</small>'}</p>
      <label><span>単語</span>${sel('lang', [['ja', '日本語'], ['en', 'English']], st.lang)}</label>
      <label><span>タイマー（ターン数）</span>${sel('timer', nums(3, 15), st.timer)}</label>
      <label><span>許されるミス（一般人）</span>${sel('mistakes', nums(1, 15), st.mistakes)}</label>
      <label><span>最初に手がかりを出す人</span>${sel('firstGiver', [['random', 'ランダム'], ['A', 'ホスト'], ['B', 'ゲスト']], st.firstGiver)}</label>
      <p class="hint">標準ルールはタイマー9・ミス9です。数を減らすほど難しくなります（キャンペーン風の挑戦に）。</p>
    </section>
    ${isHost
      ? `<button class="btn primary big" data-a="start" ${ui.connected ? '' : 'disabled'}>ゲームを始める</button>`
      : `<p class="center-note">${ui.connected ? 'ホストがゲームを始めるのを待っています…' : '再接続しています…'}</p>`}
    ${rulesHTML()}
  </div>`;
}

function statusText(v) {
  const meGiver = v.giver === v.me;
  switch (v.phase) {
    case 'clue': return meGiver ? 'あなたが手がかりを出す番です' : `${esc(v.names[v.giver])} さんが手がかりを考えています…`;
    case 'guess': return meGiver ? `${esc(v.names[other(v.me)])} さんが推理しています…` : 'あなたが当てる番です';
    case 'sudden': return 'サドンデス！ 手がかりなしで相手のエージェントを探そう';
    case 'won': return 'ミッション成功！ 15人のエージェントを全員見つけました';
    case 'lost': return { assassin: '暗殺者に接触してしまった…', mistakes: 'ミスが多すぎた…', sudden: 'サドンデスで外れを引いてしまった…' }[v.lostReason] || 'ミッション失敗';
  }
  return '';
}

function gameHTML() {
  const v = ui.view;
  if (!v) return '';
  const ended = v.phase === 'won' || v.phase === 'lost';
  const myLeft = greensLeft(v, v.me);
  return `
  <div class="game ${ended ? 'ended ' + v.phase : ''}">
    <header class="topbar">
      ${logoHTML}
      <div class="conn ${ui.connected ? 'on' : 'off'}"><i></i>${esc(ui.partnerName || '相手')}</div>
      <span class="room-code">部屋 ${ui.code}</span>
    </header>
    <div class="layout">
      <div class="main-col">
        <section class="status ${v.phase}">
          <p class="status-text">${statusText(v)}</p>
          ${v.clue ? `<div class="clue-show"><span class="clue-from">${esc(sideName(v, v.giver))}の手がかり</span><span class="clue-word">${esc(v.clue.word)}</span><span class="clue-num">${esc(v.clue.num)}</span></div>` : ''}
        </section>
        ${boardHTML(v)}
        ${panelHTML(v)}
      </div>
      <aside class="side-col">
        <section class="panel counters">
          <div class="counter"><span>見つけたエージェント</span><b>${foundCount(v)}<small>/${TOTAL_AGENTS}</small></b></div>
          <div class="counter"><span>あなたの残り緑</span><b>${myLeft}</b></div>
          <div class="counter"><span>相手の残り緑</span><b>${v.partnerLeft}</b></div>
          <div class="counter"><span>ミス</span><b>${v.mistakes}<small>/${v.mistakeMax}</small></b></div>
        </section>
        <section class="panel timer">
          <p class="label">タイマー <small>残り ${Math.max(0, v.timer)} ターン</small></p>
          <div class="tokens">${Array.from({ length: v.timerMax }, (_, i) => `<i class="tok ${i < v.timerMax - v.timer ? 'used' : ''}"></i>`).join('')}</div>
        </section>
        <section class="panel keycard-wrap">
          <div class="label-row"><p class="label">${ended ? 'キーカード（両面）' : 'あなたのキーカード'}</p>
            ${ended ? '' : `<label class="toggle"><input type="checkbox" data-a="toggleKey" ${ui.showKey ? 'checked' : ''}><span>盤面に表示</span></label>`}</div>
          ${ended ? `<div class="keys-both"><div><small>${esc(v.names.A)}</small>${keyCardHTML(v, 'A')}</div><div><small>${esc(v.names.B)}</small>${keyCardHTML(v, 'B')}</div></div>` : keyCardHTML(v, v.me)}
        </section>
        <section class="panel log">
          <p class="label">記録</p>
          <ol id="log">${v.log.map((e) => logLine(e, v)).filter(Boolean).reverse().join('')}</ol>
        </section>
      </aside>
    </div>
  </div>`;
}

function keyCardHTML(v, side) {
  const key = v.key[side];
  if (!key) return '';
  return `<div class="keycard">${key.map((k, i) => {
    const done = v.found[i] && k === 'g';
    const nb = v.byst[side][i];
    return `<i class="kc ${k} ${done ? 'done' : ''} ${nb ? 'nb' : ''} ${v.assassin === i ? 'hit' : ''}" title="${esc(v.words[i])}"></i>`;
  }).join('')}</div>`;
}

const ICON_AGENT = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a4 4 0 0 1 4 4v1a4 4 0 0 1-8 0V7a4 4 0 0 1 4-4zm-7 17c0-3.5 3.1-6 7-6s7 2.5 7 6v1H5z"/><path d="M6 7.5h12v1.6H6z" opacity=".55"/></svg>`;
const ICON_SKULL = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C7 2 3.5 5.5 3.5 10c0 2.6 1.2 4.6 3 5.8V19a1 1 0 0 0 1 1h1.5v-2h1.5v2h3v-2h1.5v2H16.5a1 1 0 0 0 1-1v-3.2c1.8-1.2 3-3.2 3-5.8C20.5 5.5 17 2 12 2zM8.5 13a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm7 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg>`;

function boardHTML(v) {
  const me = v.me, pa = other(me);
  const ended = v.phase === 'won' || v.phase === 'lost';
  return `<div id="board" class="board">${v.words.map((w, i) => {
    const cls = ['card'];
    const mk = v.key[me]?.[i];
    if ((ui.showKey || ended) && mk) cls.push('key-' + mk);
    const sel = selectable(i);
    if (sel) cls.push('can');
    if (ui.selected === i && sel) cls.push('selected');
    if (ui.partnerPoint === i && !v.found[i]) cls.push('pointed');
    const bMe = v.byst[me][i], bPa = v.byst[pa][i];
    if (v.found[i]) cls.push('found');
    else if (v.assassin === i) cls.push('assassin');
    else if (bMe && bPa) cls.push('byst-both');
    if (ui.flips?.has(i)) cls.push('flip');
    let inner = `<span class="word">${esc(w)}</span>`;
    if (v.found[i]) inner = `<span class="cover agent">${ICON_AGENT}<span class="word">${esc(w)}</span></span>`;
    else if (v.assassin === i) inner = `<span class="cover skull">${ICON_SKULL}<span class="word">${esc(w)}</span></span>`;
    else {
      if (bPa) inner += `<span class="bt top" title="相手のキーでは一般人">一般人</span>`;
      if (bMe) inner += `<span class="bt bottom" title="あなたのキーでは一般人">一般人</span>`;
    }
    if (ended && v.key[pa]) inner += `<span class="reveal"><i class="rv ${v.key[pa][i]}" title="${esc(v.names[pa])}"></i><i class="rv ${v.key[me][i]}" title="あなた"></i></span>`;
    if (ui.partnerPoint === i && !v.found[i]) inner += `<span class="point-tag">相手</span>`;
    return `<button class="${cls.join(' ')}" data-card="${i}" ${sel ? '' : 'tabindex="-1"'}>${inner}</button>`;
  }).join('')}</div>`;
}

function panelHTML(v) {
  const meGiver = v.giver === v.me;
  const err = ui.error ? `<p class="err">${esc(ui.error)}</p>` : '';
  const selWord = ui.selected >= 0 && selectable(ui.selected) ? v.words[ui.selected] : null;
  const confirm = selWord ? `<div class="confirm"><span>「<b>${esc(selWord)}</b>」を選びますか？</span><button class="btn primary" data-a="confirm">決定</button><button class="btn ghost" data-a="unselect">取消</button></div>` : '';
  if (v.phase === 'clue' && meGiver) {
    const nums = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '∞'];
    return `<section class="panel action">
      <p class="label">手がかりを出す <small>あなたのキーで緑のカードを相手に当ててもらおう（残り${greensLeft(v, v.me)}人）</small></p>
      <div class="clue-form">
        <input id="clueWord" maxlength="30" placeholder="ひとつの単語" value="${esc(ui.clueWord)}" autocomplete="off">
        <div class="nums">${nums.map((n) => `<button class="num ${ui.clueNum === n ? 'on' : ''}" data-num="${n}">${n}</button>`).join('')}</div>
        <button class="btn primary" data-a="clue">手がかりを伝える</button>
      </div>${err}</section>`;
  }
  if (v.phase === 'guess' && !meGiver) {
    return `<section class="panel action">
      <p class="label">カードを選ぶ <small>${esc(v.names[v.giver])} さんのキーで緑だと思うカードをタップ（${v.guesses}枚選択済み）</small></p>
      ${confirm}
      <div class="row"><button class="btn" data-a="stop" ${v.guesses < 1 ? 'disabled' : ''}>ここでやめる（ターン終了）</button></div>${err}</section>`;
  }
  if (v.phase === 'sudden') {
    const can = v.partnerLeft > 0;
    return `<section class="panel action sudden">
      <p class="label">サドンデス <small>${can ? '相手のキーで緑だと思うカードを選ぼう。緑以外なら即敗北。相談はOK、ただし手がかりは出せません。' : 'あなたが探す相手のエージェントはもう残っていません。相手を信じて待ちましょう。'}</small></p>
      ${confirm}${err}</section>`;
  }
  if (v.phase === 'won' || v.phase === 'lost') {
    return `<section class="panel action result ${v.phase}">
      <p class="result-title">${v.phase === 'won' ? 'MISSION COMPLETE' : 'MISSION FAILED'}</p>
      <p>${v.phase === 'won' ? `残りタイマー ${v.timer}・ミス ${v.mistakes} でクリア！` : `見つけたエージェント ${foundCount(v)}/${TOTAL_AGENTS}`}</p>
      <p class="hint">盤面の左上の丸が相手のキー、右下の丸があなたのキーです。</p>
      <div class="row"><button class="btn primary" data-a="lobby">もう一度遊ぶ</button><button class="btn ghost" data-a="leave">退出</button></div></section>`;
  }
  return `<section class="panel action waiting"><p>${v.phase === 'guess' ? '相手がカードを選んでいます。指差し中のカードが盤面に表示されます。' : '相手の手がかりを待っています…'}</p>${err}</section>`;
}

function logLine(e, v) {
  const n = (s) => esc(sideName(v, s));
  const w = (i) => `「${esc(v.words[i])}」`;
  switch (e.k) {
    case 'start': return `<li class="sys">ゲーム開始。最初の手がかりは${n(e.giver)}</li>`;
    case 'clue': return `<li><b>${n(e.side)}</b>の手がかり：<span class="lc">${esc(e.word)} ${esc(e.num)}</span></li>`;
    case 'agent': return `<li class="g">${n(e.side)}が${w(e.idx)}を選択 → エージェント</li>`;
    case 'byst': return `<li class="n">${n(e.side)}が${w(e.idx)}を選択 → 一般人</li>`;
    case 'assassin': return `<li class="a">${n(e.side)}が${w(e.idx)}を選択 → 暗殺者！</li>`;
    case 'stop': return `<li>${n(e.side)}がターンを終了</li>`;
    case 'end': return `<li class="sys">タイマー −1（残り ${e.timer}）</li>`;
    case 'sudden': return `<li class="sys">サドンデス突入</li>`;
    case 'won': return `<li class="sys g">ミッション成功！</li>`;
    case 'lost': return `<li class="sys a">ミッション失敗</li>`;
  }
  return '';
}

// ---------------- 入力 ----------------
function bindAfterRender() {
  const cw = document.getElementById('clueWord');
  if (cw) {
    cw.addEventListener('input', () => { ui.clueWord = cw.value; });
    cw.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) submitClue(); });
  }
  const nm = document.getElementById('name');
  if (nm) nm.addEventListener('input', () => { ui.myName = nm.value.trim().slice(0, 16); store.set('cnduet-name', ui.myName); });
  const code = document.getElementById('code');
  if (code) code.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(code.value); });
  const log = document.getElementById('log');
  if (log) log.scrollTop = 0;
}

function needName() {
  if (!ui.myName) { ui.homeError = '名前を入力してください'; render(); document.getElementById('name')?.focus(); return true; }
  return false;
}

function doJoin(c) {
  if (needName()) return;
  const code = normalizeCode(c);
  if (code.length !== 5) { ui.homeError = '5文字の部屋コードを入力してください'; render(); return; }
  ui.homeError = '';
  startGuest(code);
}

function submitClue() {
  act({ type: 'clue', word: ui.clueWord, num: ui.clueNum });
}

$app.addEventListener('click', (e) => {
  const card = e.target.closest('[data-card]');
  if (card) {
    const i = Number(card.dataset.card);
    if (!selectable(i)) return;
    if (ui.selected === i) return confirmSel();
    point(i);
    ui.error = '';
    render();
    return;
  }
  const num = e.target.closest('[data-num]');
  if (num) { ui.clueNum = num.dataset.num; document.querySelectorAll('.num').forEach((b) => b.classList.toggle('on', b === num)); return; }
  const btn = e.target.closest('[data-a]');
  if (!btn || btn.disabled) return;
  const a = btn.dataset.a;
  if (a === 'create') { if (needName()) return; ui.homeError = ''; startHost(); }
  else if (a === 'join') doJoin(btn.dataset.code || document.getElementById('code')?.value || '');
  else if (a === 'clearInvite') { history.replaceState(null, '', location.pathname); render(); }
  else if (a === 'leave') { if (ui.screen !== 'game' || confirm('部屋から退出しますか？')) leave(); }
  else if (a === 'copy') {
    const link = document.getElementById('link');
    navigator.clipboard?.writeText(link.value).then(() => toast('招待リンクをコピーしました'), () => { link.select(); document.execCommand('copy'); toast('コピーしました'); });
  }
  else if (a === 'start') act({ type: 'start' });
  else if (a === 'lobby') act({ type: 'lobby' });
  else if (a === 'clue') submitClue();
  else if (a === 'stop') { point(-1); act({ type: 'stop' }); }
  else if (a === 'confirm') confirmSel();
  else if (a === 'unselect') { point(-1); render(); }
});

$app.addEventListener('change', (e) => {
  const s = e.target.closest('[data-set]');
  if (s && ui.role === 'host') {
    const k = s.dataset.set;
    act({ type: 'settings', settings: { [k]: ['timer', 'mistakes'].includes(k) ? Number(s.value) : s.value } });
  }
  if (e.target.matches('[data-a="toggleKey"]')) {
    ui.showKey = e.target.checked;
    store.set('cnduet-showkey', ui.showKey);
    renderBoardOnly();
  }
});

function confirmSel() {
  const v = ui.view, i = ui.selected;
  if (!v || i < 0) return;
  point(-1);
  act({ type: v.phase === 'sudden' ? 'sudden' : 'guess', idx: i });
  render();
}

window.addEventListener('online', () => host?.net?.reconnectSignal());

// ---------------- 起動 ----------------
const savedHost = store.get('cnduet-host', null, true);
const savedGuest = store.get('cnduet-guest', null, true);
const qRoom = normalizeCode(new URLSearchParams(location.search).get('room') || '');
if (savedHost?.code && (!qRoom || qRoom === savedHost.code) && ui.myName) startHost(savedHost.code, savedHost);
else if (savedGuest?.code && (!qRoom || qRoom === savedGuest.code) && ui.myName) startGuest(savedGuest.code);
else render();
