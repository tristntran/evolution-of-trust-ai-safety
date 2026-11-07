import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeRules, playMatch, playTournament, evolve, rngFrom } from "../engine/pd.js";
import { builtinArchetypes, createPlayerFactory } from "../engine/players.js";
import { buildMessages, parseMove } from "../engine/prompt.js";
import { createLLM } from "../engine/llm.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ARCH = Object.fromEntries(builtinArchetypes().map((a) => [a.id, a]));
const makePlayer = createPlayerFactory({});

// Load the ORIGINAL game's PD.js in a sandbox to compare against.
function loadOriginal() {
  const src = fs.readFileSync(path.join(here, "../../js/sims/PD.js"), "utf8");
  const ctx = { subscribe() {}, publish() {}, Math, JSON };
  vm.createContext(ctx);
  vm.runInContext(src + "\nthis.PD = PD; this.L = {tft:Logic_tft,tf2t:Logic_tf2t,grudge:Logic_grudge,all_d:Logic_all_d,all_c:Logic_all_c,pavlov:Logic_pavlov,prober:Logic_prober};", ctx);
  return ctx;
}
function origAgent(ctx, id) {
  let logic, coins = 0;
  return {
    resetLogic() { logic = new ctx.L[id](); },
    play: () => logic.play(),
    remember: (a, b) => logic.remember(a, b),
    addPayoff: (p) => { coins += p; },
  };
}

test("every deterministic pairing matches the original game exactly", async () => {
  const orig = loadOriginal();
  const ids = ["tft", "tf2t", "grudge", "all_d", "all_c", "pavlov", "prober"];
  const rules = makeRules({ turns: 10 });
  for (const a of ids) for (const b of ids) {
    const o = orig.PD.playRepeatedGame(origAgent(orig, a), origAgent(orig, b), 10);
    const n = await playMatch(makePlayer(ARCH[a]), makePlayer(ARCH[b]), rules, rngFrom(1));
    assert.deepEqual([n.scoreA, n.scoreB], [o.totalA, o.totalB], `${a} vs ${b}`);
  }
});

test("classic result: with default settings, Copycat beats Always Cheat in evolution", async () => {
  const pop = [{ archetype: "tft", count: 10 }, { archetype: "all_d", count: 10 }, { archetype: "all_c", count: 5 }];
  const res = await evolve(pop, ARCH, makeRules({ seed: 7 }), { generations: 30, makePlayer });
  assert.deepEqual(res.final, [{ archetype: "tft", count: 25 }]);
});

test("population size is preserved every generation", async () => {
  const pop = Object.keys(ARCH).map((id) => ({ archetype: id, count: 3 }));
  const res = await evolve(pop, ARCH, makeRules({ seed: 3, noise: 0.05 }), { generations: 8, makePlayer });
  for (const h of res.history) assert.equal(Object.values(h.population).reduce((s, x) => s + x, 0), 24);
});

test("seeded runs are reproducible, even with noise and Random", async () => {
  const entrants = ["random", "tft", "pavlov", "random"].map((id, i) => ({ agentId: `${id}${i}`, archetype: ARCH[id] }));
  const rules = makeRules({ noise: 0.2, seed: 42 });
  const a = await playTournament(entrants, rules, { makePlayer });
  const b = await playTournament(entrants, rules, { makePlayer });
  assert.deepEqual(a.agents, b.agents);
});

test("a mock prompt archetype plays exactly like the strategy it mocks", async () => {
  const mock = { id: "m", kind: "prompt", provider: "mock", mockStrategy: "grudge", system: "x" };
  const rules = makeRules();
  for (const opp of ["tft", "prober", "pavlov", "all_d"]) {
    const x = await playMatch(makePlayer(mock), makePlayer(ARCH[opp]), rules, rngFrom(1));
    const y = await playMatch(makePlayer(ARCH.grudge), makePlayer(ARCH[opp]), rules, rngFrom(1));
    assert.deepEqual([x.scoreA, x.scoreB], [y.scoreA, y.scoreB]);
  }
});

test("prompt contains payoffs, persona and history", () => {
  const rules = makeRules({ noise: 0.05, payoffs: { R: 5 } });
  const { system, user } = buildMessages(
    { system: "Be nice." },
    { round: 3, myMoves: ["COOPERATE", "CHEAT"], theirMoves: ["CHEAT", "CHEAT"], myScore: 2, theirScore: 3, rules }
  );
  assert.match(system, /you each get 5/);
  assert.match(system, /5% chance/);
  assert.match(system, /Be nice\./);
  assert.match(user, /Round 2: you CHEAT, opponent CHEAT/);
  assert.match(user, /round 3/);
});

test("parseMove handles JSON, prose and garbage", () => {
  assert.equal(parseMove('{"reason":"r","move":"cheat"}').move, "CHEAT");
  assert.equal(parseMove('Sure!\n```json\n{"reason": "trust", "move": "COOPERATE"}\n```').move, "COOPERATE");
  assert.equal(parseMove("I will DEFECT this time.").move, "CHEAT");
  const g = parseMove("¯\\_(ツ)_/¯");
  assert.equal(g.move, "COOPERATE");
  assert.ok(g.error);
});

test("LLM calls are cached and de-duplicated across identical situations", async () => {
  let calls = 0;
  const fakeFetch = async (url, opts) => {
    calls++;
    const body = JSON.parse(opts.body);
    const lastOpp = body.messages[1].content.match(/opponent (COOPERATE|CHEAT)\n\nYour total/);
    const move = lastOpp ? lastOpp[1] : "COOPERATE"; // an LLM that plays Copycat
    await new Promise((r) => setTimeout(r, 5));
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ reason: "copy", move }) } }] }) };
  };
  const llm = createLLM({ openrouterKey: "test", fetchImpl: fakeFetch });
  const mp = createPlayerFactory({ llm });
  const llmCopycat = { id: "llm_tft", kind: "prompt", provider: "openrouter", model: "x", temperature: 0, maxTokens: 50, system: "copy" };
  const entrants = [];
  for (let i = 0; i < 4; i++) entrants.push({ agentId: `l${i}`, archetype: llmCopycat });
  for (let i = 0; i < 4; i++) entrants.push({ agentId: `d${i}`, archetype: ARCH.all_d });
  const t = await playTournament(entrants, makeRules(), { makePlayer: mp });
  // 28 matches * up to 2 LLM moves * 10 rounds = 440 decisions, but only a handful of distinct situations.
  assert.ok(calls <= 25, `expected heavy caching, got ${calls} calls`);
  assert.equal(llm.stats.calls, calls);
  // and the LLM-copycat behaves like the real Copycat
  const lb = Object.fromEntries(t.leaderboard.map((x) => [x.archetype, x.average]));
  const ref = await playTournament(entrants.map((e) => (e.archetype.id === "llm_tft" ? { ...e, archetype: ARCH.tft } : e)), makeRules(), { makePlayer });
  const lbRef = Object.fromEntries(ref.leaderboard.map((x) => [x.archetype, x.average]));
  assert.equal(lb.llm_tft, lbRef.tft);
  assert.equal(lb.all_d, lbRef.all_d);
});

test("Decisions API: request shape, caching, argmax and reproducible sampling", async () => {
  const bodies = [];
  const fakeFetch = async (url, opts) => {
    assert.equal(url, "https://openrouter.ai/api/alpha/decisions");
    const body = JSON.parse(opts.body);
    bodies.push(body);
    // a "model" that cooperates 70% unless it was just cheated
    const cheated = /opponent CHEAT\n\nYour total/.test(body.state.situation);
    const pC = cheated ? 0.1 : 0.7;
    return { ok: true, json: async () => ({ answers: { move: { type: "choice", choice: pC > 0.5 ? "COOPERATE" : "CHEAT", probabilities: { COOPERATE: pC, CHEAT: 1 - pC }, confidence: 0.6 } } }) };
  };
  const { normalizeArchetype } = await import("../engine/players.js");
  const arch = normalizeArchetype({ id: "dec", system: "Be fair." });
  assert.equal(arch.api, "decisions");
  const llm = createLLM({ openrouterKey: "k", fetchImpl: fakeFetch });
  const mp = createPlayerFactory({ llm });

  const r1 = await playMatch(mp(arch), makePlayer(ARCH.all_d), makeRules(), rngFrom(1));
  assert.equal(bodies[0].model, "openai/gpt-6-luna-decisions");
  assert.equal(bodies[0].questions.move.type, "choice");
  assert.deepEqual(Object.keys(bodies[0].questions.move.criteria), ["COOPERATE", "CHEAT"]);
  assert.match(bodies[0].state.your_persona_and_strategy, /Be fair/);
  assert.equal(r1.rounds[0].a.move, "COOPERATE"); // argmax of 0.7
  assert.equal(r1.rounds[1].a.move, "CHEAT"); // argmax of 0.1 after being cheated
  assert.equal(r1.rounds[0].a.pCooperate, 0.7);
  const callsAfterFirst = llm.stats.calls;
  await playMatch(mp(arch), makePlayer(ARCH.all_d), makeRules(), rngFrom(1));
  assert.equal(llm.stats.calls, callsAfterFirst, "second identical match should be fully cached");

  const sampler = { ...arch, selection: "sample" };
  const s1 = await playMatch(mp(sampler), makePlayer(ARCH.all_c), makeRules({ noise: 0.1 }), rngFrom(9));
  const s2 = await playMatch(mp(sampler), makePlayer(ARCH.all_c), makeRules({ noise: 0.1 }), rngFrom(9));
  assert.deepEqual(s1.rounds.map((r) => r.a.move), s2.rounds.map((r) => r.a.move));
  const coops = s1.rounds.filter((r) => r.a.intended === "COOPERATE").length;
  assert.ok(coops > 0 && coops < 10, `sampling should mix moves, got ${coops}/10`);
});
