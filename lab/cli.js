#!/usr/bin/env node
// Headless runner. Good for scripting, CI, or letting a coding agent run experiments.
// Uses YOUR OpenRouter key from the environment (OPENROUTER_API_KEY); nothing is stored.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeRules, playMatch, playTournament, evolve, rngFrom } from "./engine/pd.js";
import { builtinArchetypes, normalizeArchetype, createPlayerFactory, estimateCalls, isLLM } from "./engine/players.js";
import { createLLM } from "./engine/llm.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ARCH_DIR = path.join(ROOT, "archetypes");
const CACHE_FILE = path.join(ROOT, ".cache", "llm-cache.jsonl");

const HELP = `trust-lab: run The Evolution of Trust with LLM prompt archetypes

Usage:
  node cli.js list
  node cli.js show <id>
  node cli.js new <id> --name "Name" --system "prompt text" | --system-file p.txt
                [--api decisions|chat] [--sample] [--model M] [--temperature 0]
  node cli.js match <a> <b> [rules]                  play one match, print transcript + reasons
  node cli.js tournament <a> <b> [<c> ...] [rules]   round robin (use id:count for copies, e.g. tft:3)
  node cli.js evolve <id:count> ... [--generations 20] [rules]

Rules flags: --turns 10 --noise 0.05 --selection 5 --seed 1 --reveal-turns
             --payoffs R=2,S=-1,T=3,P=0 --concurrency 8
Other:       --model <openrouter model id>  default CHAT model for chat archetypes without one
             (decisions archetypes default to openai/gpt-6-luna-decisions)
             --json   machine-readable output     --no-cache   ignore the response cache
             --yes    skip the cost confirmation

Env: OPENROUTER_API_KEY (your own key; only needed for non-mock prompt archetypes)
Builtins: tft all_d all_c grudge prober tf2t pavlov random`;

// ---------- args ----------
function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[k] = true;
      else { flags[k] = next; i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}
function rulesFrom(f) {
  const payoffs = {};
  if (f.payoffs) for (const kv of String(f.payoffs).split(",")) { const [k, v] = kv.split("="); payoffs[k.trim().toUpperCase()] = Number(v); }
  return makeRules({
    turns: f.turns && Number(f.turns), noise: f.noise && Number(f.noise),
    selection: f.selection && Number(f.selection), seed: f.seed ?? 1,
    revealTurns: !!f["reveal-turns"], concurrency: f.concurrency && Number(f.concurrency), payoffs,
  });
}

// ---------- archetypes ----------
function loadArchetypes() {
  const all = Object.fromEntries(builtinArchetypes().map((a) => [a.id, a]));
  if (fs.existsSync(ARCH_DIR))
    for (const f of fs.readdirSync(ARCH_DIR).filter((f) => f.endsWith(".json") && f !== "index.json")) {
      const a = normalizeArchetype(JSON.parse(fs.readFileSync(path.join(ARCH_DIR, f), "utf8")));
      all[a.id] = a;
    }
  return all;
}
function writeIndex() {
  const files = fs.readdirSync(ARCH_DIR).filter((f) => f.endsWith(".json") && f !== "index.json").sort();
  fs.writeFileSync(path.join(ARCH_DIR, "index.json"), JSON.stringify(files, null, 2) + "\n");
}
function need(all, id) {
  if (!all[id]) { console.error(`Unknown archetype "${id}". Try: node cli.js list`); process.exit(1); }
  return all[id];
}

// ---------- disk cache ----------
function diskCache(enabled) {
  const map = new Map();
  if (enabled && fs.existsSync(CACHE_FILE))
    for (const line of fs.readFileSync(CACHE_FILE, "utf8").split("\n")) if (line) { try { const [k, v] = JSON.parse(line); map.set(k, v); } catch {} }
  return {
    get: (k) => map.get(k),
    set: (k, v) => {
      map.set(k, v);
      if (!enabled) return;
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      fs.appendFileSync(CACHE_FILE, JSON.stringify([k, v]) + "\n");
    },
  };
}

async function confirm(calls, flags) {
  if (calls === 0 || flags.yes || flags.json) return;
  if (!process.env.OPENROUTER_API_KEY) { console.error("This run needs OPENROUTER_API_KEY (your own key)."); process.exit(1); }
  if (!process.stdin.isTTY) return;
  process.stderr.write(`Up to ${calls} LLM calls before caching (usually far fewer). Continue? [y/N] `);
  const ans = await new Promise((r) => process.stdin.once("data", (d) => r(String(d).trim())));
  process.stdin.pause();
  if (!/^y/i.test(ans)) process.exit(0);
}

function expand(all, specs) {
  // "tft:3" -> 3 agents
  const out = [];
  for (const s of specs) {
    const [id, n] = s.split(":");
    out.push({ archetype: need(all, id).id, count: n ? Number(n) : 1 });
  }
  return out;
}

const C = { reset: "\x1b[0m", dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", bold: "\x1b[1m" };
const mv = (m) => (m === "COOPERATE" ? `${C.green}COOP ${C.reset}` : `${C.red}CHEAT${C.reset}`);

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...args] = pos;
  if (!cmd || flags.help) return console.log(HELP);
  const all = loadArchetypes();
  const rules = rulesFrom(flags);
  const llm = createLLM({ openrouterKey: process.env.OPENROUTER_API_KEY, cacheStore: diskCache(!flags["no-cache"]) });
  const makePlayer = createPlayerFactory({ llm, defaultModel: flags.model || process.env.TRUST_LAB_MODEL || "" });
  const out = (obj) => console.log(JSON.stringify(obj, null, 2));
  const footer = () => !flags.json && console.error(`${C.dim}LLM calls: ${llm.stats.calls}, cache hits: ${llm.stats.cacheHits}, errors: ${llm.stats.errors}${llm.stats.cost ? `, cost: $${llm.stats.cost.toFixed(4)}` : ""}${C.reset}`);

  for (const a of Object.values(all)) if (isLLM(a) && a.api === "chat" && !a.model && !flags.model && !process.env.TRUST_LAB_MODEL && [cmd].some((c) => ["match", "tournament", "evolve"].includes(c)) && args.some((s) => s.split(":")[0] === a.id)) {
    console.error(`"${a.id}" uses the chat engine but has no model. Pass --model <openrouter chat model id> (e.g. --model anthropic/claude-haiku-4.5).`); process.exit(1);
  }

  if (cmd === "list") {
    if (flags.json) return out(Object.values(all));
    for (const a of Object.values(all)) console.log(`${a.id.padEnd(24)} ${(a.kind === "prompt" ? a.api : a.kind).padEnd(10)} ${(a.kind === "prompt" ? `${a.provider}${a.model ? ":" + a.model : ""}` : "").padEnd(26)} ${a.name}`);
    return;
  }
  if (cmd === "show") return out(need(all, args[0]));

  if (cmd === "new") {
    const id = args[0];
    const system = flags["system-file"] ? fs.readFileSync(flags["system-file"], "utf8") : flags.system;
    if (!id || !system) { console.error("Usage: node cli.js new <id> --system \"...\""); process.exit(1); }
    const a = normalizeArchetype({
      id, name: flags.name || id, system, description: flags.description || "",
      provider: flags.provider || "openrouter", model: flags.model || "",
      api: flags.api || "decisions", selection: flags.sample ? "sample" : "argmax",
      temperature: flags.temperature !== undefined ? Number(flags.temperature) : 0,
      ...(flags.color ? { color: flags.color } : {}),
    });
    fs.mkdirSync(ARCH_DIR, { recursive: true });
    fs.writeFileSync(path.join(ARCH_DIR, `${id}.json`), JSON.stringify(a, null, 2) + "\n");
    writeIndex();
    return console.log(`Saved archetypes/${id}.json`);
  }

  if (cmd === "match") {
    const A = need(all, args[0]), B = need(all, args[1]);
    await confirm(rules.turns * (isLLM(A) + isLLM(B)), flags);
    const res = await playMatch(makePlayer(A), makePlayer(B), rules, rngFrom(rules.seed, "match"), {
      onRound: flags.json ? undefined : (r) => {
        const why = (s) => (s.reason ? `${C.dim}${s.reason}${C.reset}` : "");
        const flip = (s) => (s.intended !== s.move ? " (noise!)" : "");
        console.log(`${String(r.round).padStart(2)}  ${A.name}: ${mv(r.a.move)}${flip(r.a)}  ${B.name}: ${mv(r.b.move)}${flip(r.b)}   ${r.payoff[0] >= 0 ? "+" : ""}${r.payoff[0]} / ${r.payoff[1] >= 0 ? "+" : ""}${r.payoff[1]}`);
        if (r.a.reason) console.log(`      ${A.name}: ${why(r.a)}`);
        if (r.b.reason) console.log(`      ${B.name}: ${why(r.b)}`);
        for (const s of [r.a, r.b]) if (s.error) console.log(`      ${C.red}! ${s.error}${C.reset}`);
      },
    });
    if (flags.json) out({ a: A.id, b: B.id, rules, ...res });
    else console.log(`${C.bold}Final: ${A.name} ${res.scoreA}  vs  ${B.name} ${res.scoreB}${C.reset}`);
    return footer();
  }

  if (cmd === "tournament") {
    const pop = expand(all, args);
    const entrants = pop.flatMap((p) => Array.from({ length: p.count }, (_, k) => ({ agentId: `${p.archetype}#${k}`, archetype: all[p.archetype] })));
    await confirm(estimateCalls({ entrants: entrants.map((e) => e.archetype), turns: rules.turns }), flags);
    const t = await playTournament(entrants, rules, { makePlayer, keepTranscripts: !!flags.json });
    if (flags.json) out({ rules, ...t });
    else {
      console.log(`${C.bold}Average coins per agent${C.reset}`);
      t.leaderboard.forEach((x, i) => console.log(`${i + 1}. ${all[x.archetype].name.padEnd(24)} ${x.average.toFixed(1).padStart(7)}  (${x.count} agent${x.count > 1 ? "s" : ""})`));
    }
    return footer();
  }

  if (cmd === "evolve") {
    const pop = expand(all, args);
    const n = pop.reduce((s, p) => s + p.count, 0);
    const gens = Number(flags.generations || 20);
    const entrants = pop.flatMap((p) => Array(p.count).fill(all[p.archetype]));
    await confirm(estimateCalls({ entrants, turns: rules.turns }) * gens, flags);
    const res = await evolve(pop, all, rules, {
      generations: gens, makePlayer,
      onGeneration: flags.json ? undefined : ({ generation, population }) => {
        const bar = population.map((p) => `${all[p.archetype].name}:${p.count}`).join("  ");
        console.log(`gen ${String(generation).padStart(3)}  ${bar}`);
      },
    });
    if (flags.json) out({ rules, ...res });
    else console.log(`${C.bold}Final (${n} agents): ${res.final.map((p) => `${all[p.archetype].name} ×${p.count}`).join(", ")}${C.reset}`);
    return footer();
  }

  console.log(HELP);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
