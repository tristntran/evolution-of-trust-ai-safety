// Headless, async version of the game logic in js/sims/PD.js + js/sims/Tournament.js.
// Async so a "player" can be an LLM call; seeded so runs are reproducible.

export const COOPERATE = "COOPERATE";
export const CHEAT = "CHEAT";

// Same defaults as the original game.
export const DEFAULT_PAYOFFS = { P: 0, S: -1, R: 2, T: 3 };

export function makeRules(o = {}) {
  return {
    payoffs: { ...DEFAULT_PAYOFFS, ...(o.payoffs || {}) },
    noise: o.noise ?? 0, // chance each move is accidentally flipped
    turns: o.turns ?? 10, // rounds per match
    selection: o.selection ?? 5, // agents eliminated / reproduced per generation
    revealTurns: o.revealTurns ?? false, // tell LLM players how long the match is?
    seed: o.seed ?? 1,
    concurrency: o.concurrency ?? 8, // matches played in parallel
  };
}

export function getPayoffs(a, b, p) {
  if (a === CHEAT && b === CHEAT) return [p.P, p.P];
  if (a === COOPERATE && b === CHEAT) return [p.S, p.T];
  if (a === CHEAT && b === COOPERATE) return [p.T, p.S];
  return [p.R, p.R];
}

// ---------- seeded randomness ----------
export function hashString(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
export function rngFrom(...parts) {
  let a = hashString(parts.join("|")) >>> 0;
  return function mulberry32() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Run async jobs with a concurrency limit, preserving order of results.
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- one repeated match ----------
// A player is { decide(view) -> Promise<{move, reason?}>, remember(own, other) }.
// Players are created fresh per match (the original calls resetLogic() before every match).
export async function playMatch(playerA, playerB, rules, rng, { onRound } = {}) {
  const hist = { a: [], b: [] };
  let scoreA = 0, scoreB = 0;
  const rounds = [];
  for (let t = 0; t < rules.turns; t++) {
    const view = (me, them, myScore, theirScore) => ({
      round: t + 1, myMoves: [...me], theirMoves: [...them], myScore, theirScore, rules,
    });
    const [da, db] = await Promise.all([
      playerA.decide(view(hist.a, hist.b, scoreA, scoreB), rng),
      playerB.decide(view(hist.b, hist.a, scoreB, scoreA), rng),
    ]);
    let A = da.move, B = db.move;
    // Noise: random mistakes, same order as the original.
    if (rng() < rules.noise) A = A === COOPERATE ? CHEAT : COOPERATE;
    if (rng() < rules.noise) B = B === COOPERATE ? CHEAT : COOPERATE;
    const payoff = getPayoffs(A, B, rules.payoffs);
    playerA.remember(A, B);
    playerB.remember(B, A);
    hist.a.push(A); hist.b.push(B);
    scoreA += payoff[0]; scoreB += payoff[1];
    const r = {
      round: t + 1,
      a: { intended: da.move, move: A, reason: da.reason, error: da.error, pCooperate: da.pCooperate, ...(da.debug ? { debug: da.debug } : {}) },
      b: { intended: db.move, move: B, reason: db.reason, error: db.error, pCooperate: db.pCooperate, ...(db.debug ? { debug: db.debug } : {}) },
      payoff,
    };
    rounds.push(r);
    onRound?.(r);
  }
  return { scoreA, scoreB, rounds };
}

// ---------- round-robin tournament ----------
// entrants: [{ agentId, archetype }]. makePlayer(archetype) -> player.
export async function playTournament(entrants, rules, { makePlayer, onMatch, keepTranscripts = true, tag = "t" } = {}) {
  const pairs = [];
  for (let i = 0; i < entrants.length; i++)
    for (let j = i + 1; j < entrants.length; j++) pairs.push([i, j]);

  const coins = new Array(entrants.length).fill(0);
  let done = 0;
  const matches = await pool(pairs, rules.concurrency, async ([i, j]) => {
    const A = entrants[i], B = entrants[j];
    const rng = rngFrom(rules.seed, tag, A.agentId, B.agentId);
    const res = await playMatch(makePlayer(A.archetype), makePlayer(B.archetype), rules, rng);
    coins[i] += res.scoreA;
    coins[j] += res.scoreB;
    const m = {
      a: A.agentId, b: B.agentId, archA: A.archetype.id, archB: B.archetype.id,
      scoreA: res.scoreA, scoreB: res.scoreB,
      ...(keepTranscripts ? { rounds: res.rounds } : {}),
    };
    onMatch?.(m, ++done, pairs.length);
    return m;
  });

  const agents = entrants.map((e, i) => ({ agentId: e.agentId, archetype: e.archetype.id, coins: coins[i] }));
  // Per-archetype summary (average coins per agent of that kind).
  const byArch = {};
  for (const a of agents) {
    byArch[a.archetype] ??= { archetype: a.archetype, count: 0, total: 0 };
    byArch[a.archetype].count++;
    byArch[a.archetype].total += a.coins;
  }
  const leaderboard = Object.values(byArch)
    .map((x) => ({ ...x, average: x.total / x.count }))
    .sort((x, y) => y.average - x.average);
  return { agents, leaderboard, matches };
}

// ---------- evolution ----------
// population: [{ archetype: id, count }], archetypes: { id -> archetype }.
// Each generation mirrors the original: play a tournament, remove the bottom
// `selection` agents, clone the top `selection` agents.
export async function evolve(population, archetypes, rules, { generations = 10, makePlayer, onGeneration, onMatch, shouldStop } = {}) {
  let pop = population.map((p) => ({ ...p })).filter((p) => p.count > 0);
  const history = [snapshot(pop, 0)];
  onGeneration?.({ generation: 0, population: pop.map((p) => ({ ...p })), leaderboard: null });

  for (let g = 1; g <= generations; g++) {
    if (shouldStop?.()) break;
    const entrants = [];
    for (const p of pop)
      for (let k = 0; k < p.count; k++) entrants.push({ agentId: `${p.archetype}#${k}`, archetype: archetypes[p.archetype] });

    const t = await playTournament(entrants, rules, {
      makePlayer, keepTranscripts: false, tag: `gen${g}`,
      onMatch: onMatch && ((m, d, n) => onMatch(m, d, n, g)),
    });

    // Random tie-breaking like the original (shuffle, then stable sort by coins).
    const rng = rngFrom(rules.seed, "select", g);
    const sorted = shuffle(t.agents.slice(), rng).sort((a, b) => a.coins - b.coins);
    const k = Math.min(rules.selection, Math.floor(sorted.length / 2));
    const counts = Object.fromEntries(pop.map((p) => [p.archetype, p.count]));
    for (const a of sorted.slice(0, k)) counts[a.archetype]--;
    for (const a of sorted.slice(sorted.length - k)) counts[a.archetype]++;
    pop = pop.map((p) => ({ archetype: p.archetype, count: counts[p.archetype] })).filter((p) => p.count > 0);

    history.push(snapshot(pop, g, t.leaderboard));
    onGeneration?.({ generation: g, population: pop.map((p) => ({ ...p })), leaderboard: t.leaderboard });
    if (pop.length <= 1) break; // one archetype has taken over
  }
  return { history, final: pop };
}

function snapshot(pop, generation, leaderboard = null) {
  return { generation, population: Object.fromEntries(pop.map((p) => [p.archetype, p.count])), leaderboard };
}
