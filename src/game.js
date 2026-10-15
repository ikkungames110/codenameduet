// コードネーム デュエットのルール処理（純粋関数）。ホスト端末だけがこれを実行し、結果を各プレイヤーに配る。
// 側 'A' = ホスト, 'B' = ゲスト。キーカードの値: 'g' = 緑（エージェント）, 'n' = 一般人, 'a' = 暗殺者。

export const SIDES = ['A', 'B'];
export const other = (s) => (s === 'A' ? 'B' : 'A');
export const TOTAL_AGENTS = 15;

// 両面キーカードの組み合わせ（公式と同じ分布）
// A面: 緑9・暗殺者3・一般人13 / B面も同じ。両面とも緑は3枚、暗殺者同士は1枚。
const KEY_PAIRS = [
  ['g', 'g', 3], ['g', 'a', 1], ['g', 'n', 5],
  ['a', 'g', 1], ['a', 'a', 1], ['a', 'n', 1],
  ['n', 'g', 5], ['n', 'a', 1], ['n', 'n', 7],
];

export function shuffle(arr, rand = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function makeKey(rand = Math.random) {
  const pairs = shuffle(KEY_PAIRS.flatMap(([a, b, n]) => Array(n).fill([a, b])), rand);
  return { A: pairs.map((p) => p[0]), B: pairs.map((p) => p[1]) };
}

export const DEFAULT_SETTINGS = { timer: 9, mistakes: 9, firstGiver: 'random' };

export function newGame({ words, names, settings = DEFAULT_SETTINGS, rand = Math.random }) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const giver = s.firstGiver === 'A' || s.firstGiver === 'B' ? s.firstGiver : rand() < 0.5 ? 'A' : 'B';
  return {
    phase: 'clue', // clue | guess | sudden | won | lost
    words: shuffle(words, rand).slice(0, 25),
    key: makeKey(rand),
    found: Array(25).fill(false),
    byst: { A: Array(25).fill(false), B: Array(25).fill(false) }, // byst[S][i]: S の手がかりで一般人と判明
    assassin: -1,
    timer: s.timer,
    timerMax: s.timer,
    mistakes: 0,
    mistakeMax: s.mistakes,
    giver,
    clue: null,
    guesses: 0,
    turn: 1,
    names: { ...names },
    settings: s,
    lostReason: '',
    log: [{ k: 'start', giver }],
  };
}

export const greensLeft = (st, side) => st.key[side].reduce((n, v, i) => n + (v === 'g' && !st.found[i] ? 1 : 0), 0);
export const foundCount = (st) => st.found.filter(Boolean).length;

// 通常ターン中に guesser が選べるカードか
export function canGuess(st, i) {
  return st.phase === 'guess' && !st.found[i] && !st.byst[st.giver][i];
}
// サドンデス中に side のプレイヤーが選べるカードか（相手のキーで判定される）
export function canSudden(st, side, i) {
  const o = other(side);
  return st.phase === 'sudden' && !st.found[i] && !st.byst[o][i] && greensLeft(st, o) > 0;
}

export function normalizeWord(w) {
  return String(w).normalize('NFKC').trim().toLowerCase();
}

// アクションを適用して新しい状態を返す。不正なら { error } を返す。
export function apply(st, side, act) {
  const s = structuredClone(st);
  const log = (e) => s.log.push(e);

  switch (act.type) {
    case 'clue': {
      if (s.phase !== 'clue' || side !== s.giver) return { error: 'いまは手がかりを出せません' };
      const word = String(act.word || '').trim().slice(0, 30);
      const num = String(act.num ?? '');
      if (!word) return { error: '手がかりを入力してください' };
      if (/\s/.test(word)) return { error: '手がかりは1単語にしてください' };
      if (!/^(\d|∞)$/.test(num)) return { error: '数を選んでください' };
      const nw = normalizeWord(word);
      if (s.words.some((w, i) => !s.found[i] && normalizeWord(w) === nw)) return { error: '場に見えている単語は手がかりにできません' };
      s.clue = { word, num };
      s.phase = 'guess';
      s.guesses = 0;
      log({ k: 'clue', side, word, num });
      return s;
    }
    case 'guess': {
      const i = act.idx;
      if (side !== other(s.giver)) return { error: '相手の番です' };
      if (!Number.isInteger(i) || !canGuess(s, i)) return { error: 'そのカードは選べません' };
      s.guesses++;
      const v = s.key[s.giver][i];
      if (v === 'g') {
        s.found[i] = true;
        log({ k: 'agent', side, idx: i });
        if (foundCount(s) >= TOTAL_AGENTS) return win(s);
        if (greensLeft(s, s.giver) === 0) return endTurn(s, true);
        return s;
      }
      if (v === 'a') {
        s.assassin = i;
        log({ k: 'assassin', side, idx: i });
        return lose(s, 'assassin');
      }
      s.byst[s.giver][i] = true;
      s.mistakes++;
      log({ k: 'byst', side, idx: i });
      if (s.mistakes > s.mistakeMax) return lose(s, 'mistakes');
      return endTurn(s);
    }
    case 'stop': {
      if (s.phase !== 'guess' || side !== other(s.giver)) return { error: 'いまは終われません' };
      if (s.guesses < 1) return { error: '少なくとも1枚は選んでください' };
      log({ k: 'stop', side });
      return endTurn(s);
    }
    case 'sudden': {
      const i = act.idx;
      if (!Number.isInteger(i) || !canSudden(s, side, i)) return { error: 'そのカードは選べません' };
      const v = s.key[other(side)][i];
      if (v === 'g') {
        s.found[i] = true;
        log({ k: 'agent', side, idx: i, sudden: true });
        if (foundCount(s) >= TOTAL_AGENTS) return win(s);
        return s;
      }
      if (v === 'a') s.assassin = i;
      else s.byst[other(side)][i] = true;
      log({ k: v === 'a' ? 'assassin' : 'byst', side, idx: i, sudden: true });
      return lose(s, 'sudden');
    }
    default:
      return { error: '不明な操作です' };
  }
}

function endTurn(s, auto = false) {
  s.timer--;
  s.clue = null;
  s.guesses = 0;
  s.log.push({ k: 'end', auto, timer: s.timer });
  if (s.timer <= 0) {
    s.phase = 'sudden';
    s.log.push({ k: 'sudden' });
    return s;
  }
  let next = other(s.giver);
  if (greensLeft(s, next) === 0) next = s.giver; // 自分の緑を全部見つけてもらった人はもう手がかりを出さない
  s.giver = next;
  s.turn++;
  s.phase = 'clue';
  return s;
}

function win(s) {
  s.phase = 'won';
  s.clue = null;
  s.log.push({ k: 'won' });
  return s;
}

function lose(s, reason) {
  s.phase = 'lost';
  s.lostReason = reason;
  s.clue = null;
  s.log.push({ k: 'lost', reason });
  return s;
}

// side のプレイヤーに見せてよい情報だけにする（相手のキーはゲーム終了まで隠す）
export function viewFor(st, side) {
  const v = structuredClone(st);
  v.me = side;
  v.partnerLeft = greensLeft(st, other(side));
  if (st.phase !== 'won' && st.phase !== 'lost') v.key = { [side]: st.key[side] };
  return v;
}
