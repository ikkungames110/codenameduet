import Peer from 'peerjs';

// PeerJS (WebRTC) による 1対1 通信。ホスト端末が進行役となり、ゲストと直接つながる。
// シグナリングのみ PeerJS 公開ブローカーを使い、ゲーム中のデータは端末同士で直接やり取りされる。
const PREFIX = 'cnduet-room-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];
if (import.meta.env.VITE_TURN_URL) {
  iceServers.push({
    urls: import.meta.env.VITE_TURN_URL,
    username: import.meta.env.VITE_TURN_USER,
    credential: import.meta.env.VITE_TURN_PASS,
  });
}
const peerOptions = { config: { iceServers } };

export const normalizeCode = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
const randomCode = () => Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

// ホスト: 部屋コードを発行して待ち受ける。fixedCode を渡すと（再読み込み時など）同じコードを取り直す。
// ev: onCode(code), onConnect(conn), onMessage(conn, msg), onClose(conn), onError(type)
export function hostRoom(ev, fixedCode = null) {
  let peer, destroyed = false, opened = false, tries = 0;
  const start = () => {
    const code = fixedCode || randomCode();
    peer = new Peer(PREFIX + code, peerOptions);
    peer.on('open', () => { if (!opened) { opened = true; ev.onCode(code); } });
    peer.on('connection', (conn) => {
      conn.on('open', () => ev.onConnect(conn));
      conn.on('data', (d) => { if (d && typeof d === 'object') ev.onMessage(conn, d); });
      const end = () => { if (!destroyed) ev.onClose(conn); };
      conn.on('close', end);
      conn.on('error', end);
    });
    peer.on('error', (e) => {
      if (destroyed) return;
      if (!opened && e.type === 'unavailable-id' && tries++ < (fixedCode ? 8 : 5)) {
        peer.destroy();
        // 再読み込み直後は古い接続がブローカーに残っているので少し待って取り直す
        setTimeout(start, fixedCode ? 2500 : 0);
        return;
      }
      if (!opened) ev.onError(e.type);
      else console.warn('peer error', e.type);
    });
    peer.on('disconnected', () => { if (!destroyed && !peer.destroyed) peer.reconnect(); });
  };
  start();
  return {
    reconnectSignal: () => { if (!destroyed && peer && !peer.destroyed && peer.disconnected) peer.reconnect(); },
    close: () => { destroyed = true; peer?.destroy(); },
  };
}

// ゲスト: コードで参加
// ev: onOpen(), onMessage(msg), onClose(), onError(type)
export function joinRoom(code, ev) {
  const peer = new Peer(peerOptions);
  let conn = null, destroyed = false, opened = false, closed = false;
  const fail = (type) => { if (!destroyed && !closed) { closed = true; clearTimeout(timer); ev.onError(type); } };
  const timer = setTimeout(() => { if (!opened) fail('timeout'); }, 15000);
  peer.on('open', () => {
    conn = peer.connect(PREFIX + code, { reliable: true });
    conn.on('open', () => { opened = true; clearTimeout(timer); ev.onOpen(); });
    conn.on('data', (d) => { if (!destroyed && d && typeof d === 'object') ev.onMessage(d); });
    const end = () => { if (!destroyed && !closed && opened) { closed = true; ev.onClose(); } };
    conn.on('close', end);
    conn.on('error', end);
  });
  peer.on('error', (e) => { if (!opened) fail(e.type); else console.warn('peer error', e.type); });
  peer.on('disconnected', () => { if (!destroyed && !peer.destroyed && opened) peer.reconnect(); });
  return {
    send: (m) => { if (conn?.open) conn.send(m); },
    close: () => { destroyed = true; clearTimeout(timer); peer.destroy(); },
  };
}
