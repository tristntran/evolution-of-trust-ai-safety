import { makeRules, playMatch, playTournament, evolve, rngFrom, DEFAULT_PAYOFFS } from "./engine/pd.js";
import { builtinArchetypes, normalizeArchetype, createPlayerFactory, estimateCalls, isLLM, PROMPT_DEFAULTS, DEFAULT_DECISIONS_MODEL } from "./engine/players.js";
import { createLLM, openRouterAuth } from "./engine/llm.js";
import { buildMessages, buildDecision } from "./engine/prompt.js";
import { BUILTINS } from "./engine/strategies.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- storage (this browser only; wrapped because storage can throw) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem("trustlab:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("trustlab:" + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem("trustlab:" + k); } catch {} },
};

// ---------- state ----------
const state = {
  builtins: builtinArchetypes(),
  repo: [], // shipped with the repo (lab/archetypes/*.json)
  mine: store.get("archetypes", []), // created/edited in this browser
  orKey: store.get("openrouterKey", null),
  models: { decisions: store.get("model:decisions", DEFAULT_DECISIONS_MODEL), openrouter: store.get("model:openrouter", ""), puter: store.get("model:puter", "gpt-5-nano") },
  orModelList: [],
  running: false,
  stop: false,
};
const allArchetypes = () => {
  const map = new Map();
  for (const a of [...state.builtins, ...state.repo, ...state.mine]) map.set(a.id, a);
  return [...map.values()];
};
const byId = () => Object.fromEntries(allArchetypes().map((a) => [a.id, a]));
const isMine = (id) => state.mine.some((a) => a.id === id);
const isRepo = (id) => state.repo.some((a) => a.id === id);

// ---------- LLM + persistent cache ----------
const cacheObj = store.get("cache", {});
let cacheDirty = null;
const cacheStore = {
  get: (k) => cacheObj[k],
  set: (k, v) => {
    cacheObj[k] = v;
    clearTimeout(cacheDirty);
    cacheDirty = setTimeout(() => {
      const keys = Object.keys(cacheObj);
      if (keys.length > 8000) for (const kk of keys.slice(0, keys.length - 8000)) delete cacheObj[kk];
      store.set("cache", cacheObj);
      renderUsage();
    }, 500);
  },
};
const llm = createLLM({ openrouterKey: state.orKey, puter: null, cacheStore, appUrl: location.origin + location.pathname });

function resolveModel(a) {
  if (a.kind !== "prompt" || a.provider === "mock") return a;
  if (a.api === "decisions") return { ...a, model: a.model || state.models.decisions || DEFAULT_DECISIONS_MODEL };
  return { ...a, model: a.model || state.models[a.provider] || "" };
}

function factory() {
  return (arch) => {
    let captured = null;
    const p = createPlayerFactory({ llm, onDecision: (d) => { captured = d; } })(resolveModel(arch));
    return {
      remember: p.remember,
      decide: async (view, rng) => {
        if (state.stop) throw Object.assign(new Error("Stopped."), { retryable: false });
        captured = null;
        const d = await p.decide(view, rng);
        renderUsage();
        return captured ? { ...d, debug: { system: captured.system, user: captured.user, state: captured.state, question: captured.question, raw: captured.raw } } : d;
      },
    };
  };
}

function checkReady(archs) {
  for (const a of archs) {
    if (!isLLM(a)) continue;
    const r = resolveModel(a);
    if ((a.provider === "openrouter" || a.api === "decisions") && !state.orKey) return `“${a.name}” uses OpenRouter. Connect your OpenRouter account first (Account & models tab).`;
    if (a.provider === "puter" && !window.puter) return `“${a.name}” uses Puter. Sign in with Puter first (Account & models tab).`;
    if (!r.model) return `“${a.name}” has no model. Set a default model on the Account & models tab, or give the archetype its own.`;
  }
  return null;
}

// ---------- avatars ----------
const FRAMES = { tft: 0, all_d: 1, all_c: 2, grudge: 3, prober: 4, tf2t: 5, pavlov: 6, random: 7 };
function avatar(a, h = 44) {
  if (a.kind === "builtin") {
    const f = FRAMES[a.builtin];
    const x = 10 + (f % 5) * 89, y = 10 + Math.floor(f / 5) * 150;
    const s = h / 140;
    return `<div class="avatar" style="width:${79 * s}px;height:${h}px;background-image:url(../assets/tournament/tournament_peep.png);background-size:${512 * s}px ${512 * s}px;background-position:-${x * s}px -${y * s}px"></div>`;
  }
  const initials = (a.name || a.id).split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return `<div class="avatar ai-avatar" style="width:${h * 0.8}px;height:${h * 0.8}px;background:${esc(a.color)}" title="AI">${esc(initials)}</div>`;
}
const chip = (a) => `<span style="display:inline-flex;align-items:center;gap:6px">${avatar(a, 24)}<b>${esc(a.name)}</b></span>`;

// ---------- tabs ----------
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  $$("#tabs button").forEach((x) => x.classList.toggle("on", x === b));
  $$(".tab").forEach((t) => t.classList.toggle("on", t.id === "tab-" + b.dataset.tab));
  renderSelectors();
});
const gotoTab = (name) => $(`#tabs button[data-tab=${name}]`).click();

// ---------- rules controls (shared settings, remembered) ----------
const rulesState = { turns: 10, noise: 0, selection: 5, seed: 1, revealTurns: false, ...DEFAULT_PAYOFFS, ...store.get("rules", {}) };
function renderRules() {
  for (const el of $$("[data-rules]")) {
    const evo = el.dataset.rules === "evolution";
    el.innerHTML = `
      <label>Rounds <input type="number" data-k="turns" min="1" max="200" value="${rulesState.turns}"></label>
      <label>Mistake % <input type="number" data-k="noise" min="0" max="50" step="1" value="${Math.round(rulesState.noise * 100)}"></label>
      ${evo ? `<label>Selection <input type="number" data-k="selection" min="1" value="${rulesState.selection}"></label>` : ""}
      <label title="Both cooperate">R <input type="number" data-k="R" value="${rulesState.R}" style="width:58px"></label>
      <label title="You cooperate, they cheat">S <input type="number" data-k="S" value="${rulesState.S}" style="width:58px"></label>
      <label title="You cheat, they cooperate">T <input type="number" data-k="T" value="${rulesState.T}" style="width:58px"></label>
      <label title="Both cheat">P <input type="number" data-k="P" value="${rulesState.P}" style="width:58px"></label>
      <label>Seed <input type="number" data-k="seed" value="${rulesState.seed}" style="width:70px"></label>
      <label class="inline" title="Tell AI players how many rounds the match lasts"><input type="checkbox" data-k="revealTurns" ${rulesState.revealTurns ? "checked" : ""}> AI knows match length</label>`;
  }
}
document.addEventListener("change", (e) => {
  const k = e.target.dataset?.k;
  if (!k) return;
  const v = e.target.type === "checkbox" ? e.target.checked : Number(e.target.value);
  rulesState[k] = k === "noise" ? v / 100 : v;
  store.set("rules", rulesState);
  renderRules();
});
const currentRules = () => makeRules({
  turns: rulesState.turns, noise: rulesState.noise, selection: rulesState.selection, seed: rulesState.seed,
  revealTurns: rulesState.revealTurns, concurrency: 6,
  payoffs: { R: rulesState.R, S: rulesState.S, T: rulesState.T, P: rulesState.P },
});

// ---------- archetype gallery ----------
function renderGallery() {
  const prompts = allArchetypes().filter((a) => a.kind === "prompt");
  $("#promptGrid").innerHTML = prompts.map((a) => `
    <div class="card arch" data-id="${esc(a.id)}">
      ${avatar(a)}
      <div style="min-width:0">
        <h3>${esc(a.name)}</h3>
        <div class="row" style="gap:4px">
          <span class="pill">${a.provider === "mock" ? "mock" : a.api === "decisions" ? "decisions" + (a.selection === "sample" ? " · sampled" : "") : "chat"}${a.model ? " · " + esc(a.model) : ""}</span>
          ${isMine(a.id) ? `<span class="pill ok">${isRepo(a.id) ? "edited" : "yours"}</span>` : ""}
        </div>
        <p>${esc(a.description || a.system.slice(0, 120))}</p>
      </div>
    </div>`).join("") || `<p class="muted">No prompt archetypes yet.</p>`;
  $("#builtinGrid").innerHTML = state.builtins.map((a) => `
    <div class="card arch" style="cursor:default">${avatar(a)}<div><h3>${esc(a.name)}</h3><span class="pill">${a.id}</span><p>${esc(a.description)}</p></div></div>`).join("");
}
$("#promptGrid").addEventListener("click", (e) => {
  const c = e.target.closest("[data-id]");
  if (c) openEditor(byId()[c.dataset.id]);
});

// ---------- editor ----------
let editing = null;
$("#edMock").innerHTML = Object.entries(BUILTINS).map(([id, b]) => `<option value="${id}">${b.name}</option>`).join("");
function openEditor(a) {
  editing = a ? a.id : null;
  const x = { ...PROMPT_DEFAULTS, ...(a || { color: randomColor() }) };
  $("#edTitle").textContent = a ? "Edit prompt archetype" : "New prompt archetype";
  $("#edName").value = x.name || "";
  $("#edId").value = x.id || "";
  $("#edColor").value = x.color;
  $("#edDesc").value = x.description || "";
  $("#edProvider").value = x.provider;
  $("#edApi").value = x.provider === "puter" ? "chat" : x.api || "decisions";
  $("#edSel").value = x.selection || "argmax";
  $("#edModel").value = x.model || "";
  $("#edMock").value = x.mockStrategy || "tft";
  $("#edTemp").value = x.temperature;
  $("#edWindow").value = x.historyWindow;
  $("#edSystem").value = x.system || "";
  $("#edRules").checked = x.includeRules !== false;
  $("#edDelete").style.display = a && isMine(a.id) ? "" : "none";
  $("#edDelete").textContent = a && isRepo(a.id) ? "Revert to original" : "Delete";
  $("#edDup").style.display = a ? "" : "none";
  syncEditor();
  $("#editor").showModal();
}
function readEditor() {
  return normalizeArchetype({
    id: $("#edId").value.trim(), name: $("#edName").value.trim(), color: $("#edColor").value,
    description: $("#edDesc").value.trim(), provider: $("#edProvider").value, model: $("#edModel").value.trim(),
    api: $("#edApi").value, selection: $("#edSel").value,
    temperature: Number($("#edTemp").value) || 0, maxTokens: 300, historyWindow: Number($("#edWindow").value) || 0,
    includeRules: $("#edRules").checked, system: $("#edSystem").value,
    ...($("#edProvider").value === "mock" ? { mockStrategy: $("#edMock").value } : {}),
  });
}
function syncEditor() {
  if ($("#edProvider").value === "puter") $("#edApi").value = "chat";
  const mock = $("#edProvider").value === "mock", dec = $("#edApi").value === "decisions";
  $("#edModelWrap").style.display = mock ? "none" : "";
  $("#edMockWrap").style.display = mock ? "" : "none";
  $("#edSelWrap").style.display = dec && !mock ? "" : "none";
  $("#edTempWrap").style.display = dec || mock ? "none" : "";
  $("#edModel").setAttribute("list", dec ? "decModels" : "orModels");
  $("#edModel").placeholder = dec ? `default: ${state.models.decisions}` : `default: ${state.models[$("#edProvider").value] || "(set on Account tab)"}`;
  try {
    const a = readEditor();
    const view = { round: 3, myMoves: ["COOPERATE", "COOPERATE"], theirMoves: ["COOPERATE", "CHEAT"], myScore: 1, theirScore: 5, rules: currentRules() };
    $("#edPreview").textContent = previewText(a, view);
  } catch (e) { $("#edPreview").textContent = e.message; }
}
function previewText(a, view, raw) {
  if (a.api === "decisions" && a.provider !== "mock") {
    const { state: st, question } = buildDecision(a, view);
    return `POST https://openrouter.ai/api/alpha/decisions\n${JSON.stringify({ model: resolveModel(a).model, state: st, questions: { move: question } }, null, 2)}${raw !== undefined ? `\n\n── ANSWER ──\n${JSON.stringify(raw, null, 2)}` : ""}`;
  }
  const { system, user } = buildMessages(a, view);
  return `── SYSTEM ──\n${system}\n\n── USER ──\n${user}${raw !== undefined ? `\n\n── REPLY ──\n${raw}` : ""}`;
}
$("#edForm").addEventListener("input", (e) => {
  if (e.target.id === "edName" && !editing) $("#edId").value = slug($("#edName").value);
  syncEditor();
});
$("#edProvider").addEventListener("change", syncEditor);
$("#edApi").addEventListener("change", () => { if ($("#edApi").value === "decisions" && $("#edProvider").value === "puter") $("#edProvider").value = "openrouter"; syncEditor(); });
$("#edCancel").onclick = () => $("#editor").close();
$("#edForm").addEventListener("submit", (e) => {
  e.preventDefault();
  let a;
  try { a = readEditor(); } catch (err) { alertInline(err.message); return; }
  if (!a.system.trim()) return alertInline("Write a prompt first.");
  if (a.id !== editing && byId()[a.id]) return alertInline(`Id "${a.id}" is taken.`);
  state.mine = state.mine.filter((x) => x.id !== editing && x.id !== a.id).concat(a);
  store.set("archetypes", state.mine);
  $("#editor").close();
  renderAll();
});
$("#edDelete").onclick = () => {
  state.mine = state.mine.filter((x) => x.id !== editing);
  store.set("archetypes", state.mine);
  $("#editor").close();
  renderAll();
};
$("#edDup").onclick = () => {
  const a = readEditor();
  let n = 2; while (byId()[`${a.id}_${n}`]) n++;
  editing = null;
  $("#edId").value = `${a.id}_${n}`; $("#edName").value = `${a.name} ${n}`;
  $("#edTitle").textContent = "New prompt archetype"; $("#edDelete").style.display = "none"; $("#edDup").style.display = "none";
};
function alertInline(msg) { $("#edPreview").closest("details").open = true; $("#edPreview").textContent = "⚠ " + msg; }
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "prompt";
const randomColor = () => `hsl(${Math.floor(Math.random() * 360)} 60% 55%)`.replace(/hsl\((\d+) (\d+)% (\d+)%\)/, (m, h, s, l) => hslToHex(+h, +s, +l));
function hslToHex(h, s, l) {
  l /= 100; const a = (s * Math.min(l, 1 - l)) / 100;
  const f = (n) => { const k = (n + h / 30) % 12; const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1); return Math.round(255 * c).toString(16).padStart(2, "0"); };
  return `#${f(0)}${f(8)}${f(4)}`;
}
$("#newBtn").onclick = () => openEditor(null);

// ---------- import / export ----------
$("#exportBtn").onclick = () => {
  const blob = new Blob([JSON.stringify(state.mine, null, 2)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "trust-archetypes.json" });
  a.click();
};
$("#importBtn").onclick = () => $("#importFile").click();
$("#importFile").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const list = (Array.isArray(data) ? data : [data]).filter((x) => x.kind !== "builtin").map(normalizeArchetype);
    const ids = new Set(list.map((x) => x.id));
    state.mine = state.mine.filter((x) => !ids.has(x.id)).concat(list);
    store.set("archetypes", state.mine);
    renderAll();
  } catch (err) { window.alert?.("Import failed: " + err.message); }
  e.target.value = "";
};

// ---------- selectors & counts ----------
function renderSelectors() {
  const opts = allArchetypes().map((a) => `<option value="${esc(a.id)}">${esc(a.name)}${a.kind === "prompt" ? " (AI)" : ""}</option>`).join("");
  for (const [sel, def] of [["#mA", "assistant_default"], ["#mB", "tft"]]) {
    const cur = $(sel).value || store.get("sel" + sel, def);
    $(sel).innerHTML = opts;
    $(sel).value = byId()[cur] ? cur : allArchetypes()[0].id;
  }
  for (const [el, key, defaults] of [["#tCounts", "tcounts", { tft: 1, all_d: 1, all_c: 1, grudge: 1, prober: 1 }], ["#eCounts", "ecounts", { tft: 5, all_d: 5, all_c: 5, grudge: 3, prober: 3, tf2t: 2, pavlov: 2 }]]) {
    const counts = store.get(key, defaults);
    $(el).innerHTML = allArchetypes().map((a) => `
      <div class="count">${avatar(a, 28)}<span>${esc(a.name)}</span><input type="number" min="0" max="50" data-count="${key}" data-id="${esc(a.id)}" value="${counts[a.id] || 0}"></div>`).join("");
  }
}
document.addEventListener("input", (e) => {
  const key = e.target.dataset?.count;
  if (!key) return;
  const counts = store.get(key, {});
  counts[e.target.dataset.id] = Math.max(0, Number(e.target.value) || 0);
  store.set(key, counts);
  updateEstimates();
});
["#mA", "#mB"].forEach((s) => $(s).addEventListener("change", () => store.set("sel" + s, $(s).value)));
function readCounts(el) {
  const all = byId();
  return $$(`${el} input[data-count]`).map((i) => ({ archetype: i.dataset.id, count: Number(i.value) || 0 })).filter((p) => p.count > 0 && all[p.archetype]);
}
function updateEstimates() {
  const all = byId(), rules = currentRules();
  const t = readCounts("#tCounts"), e = readCounts("#eCounts");
  const ents = (pop) => pop.flatMap((p) => Array(p.count).fill(all[p.archetype]));
  const tc = estimateCalls({ entrants: ents(t), turns: rules.turns });
  const ec = estimateCalls({ entrants: ents(e), turns: rules.turns }) * (Number($("#eGens").value) || 1);
  if (!state.running) {
    $("#tStatus").textContent = `${ents(t).length} agents · ${tc ? `up to ${tc.toLocaleString()} AI moves (usually far fewer thanks to caching)` : "no AI players, so this is free"}`;
    $("#eStatus").textContent = `${ents(e).length} agents · ${ec ? `up to ${ec.toLocaleString()} AI moves before caching` : "no AI players, so this is free"}`;
  }
  return { tc, ec };
}
$("#eGens").addEventListener("input", updateEstimates);

// ---------- run helpers ----------
function beginRun(prefix) {
  state.running = true; state.stop = false;
  $$("#mRun,#tRun,#eRun").forEach((b) => (b.disabled = true));
  $(`#${prefix}Stop`).disabled = false;
  $(`#${prefix}Stop`).onclick = () => { state.stop = true; $(`#${prefix}Status`).textContent = "Stopping…"; };
}
function endRun(prefix) {
  state.running = false;
  $$("#mRun,#tRun,#eRun").forEach((b) => (b.disabled = false));
  $(`#${prefix}Stop`).disabled = true;
  renderUsage();
}
function confirmCost(n) {
  if (n <= 400) return true;
  return window.confirm(`This run could make up to ${n.toLocaleString()} AI calls on your account (caching usually cuts this a lot). Continue?`);
}

// ---------- MATCH ----------
$("#mRun").onclick = async () => {
  const all = byId();
  const A = all[$("#mA").value], B = all[$("#mB").value];
  const err = checkReady([A, B]);
  if (err) { $("#mStatus").innerHTML = `<span class="err">${esc(err)}</span>`; return; }
  const rules = currentRules();
  beginRun("m");
  const make = factory();
  $("#mStatus").textContent = "Playing…";
  $("#mOut").innerHTML = `
    <div class="card" style="margin-top:14px">
      <div class="row" style="justify-content:space-between;align-items:center">
        <div>${chip(A)}</div><div class="score" id="mScore">0 : 0</div><div>${chip(B)}</div>
      </div>
      <table style="margin-top:10px"><thead><tr><th>#</th><th>${esc(A.name)}</th><th>${esc(B.name)}</th><th>Coins</th></tr></thead><tbody id="mRows"></tbody></table>
    </div>`;
  let sA = 0, sB = 0;
  const cell = (s) => {
    const d = s.debug;
    return `<span class="mv ${s.move === "COOPERATE" ? "C" : "D"} ${s.intended !== s.move ? "flip" : ""}" title="${s.intended !== s.move ? "Mistake! Intended " + s.intended : ""}">${s.move === "COOPERATE" ? "COOPERATE" : "CHEAT"}</span>
      ${s.intended !== s.move ? `<span class="small muted"> (meant ${s.intended.toLowerCase()})</span>` : ""}
      ${s.pCooperate !== undefined ? `<div class="reason">P(cooperate) ${s.pCooperate.toFixed(2)}<span class="pbar"><i style="width:${(s.pCooperate * 100).toFixed(0)}%"></i></span></div>` : s.reason ? `<div class="reason">${esc(s.reason)}</div>` : ""}
      ${s.error ? `<div class="err">${esc(s.error)}</div>` : ""}
      ${d && (d.system || d.state) ? `<details><summary>what the model saw</summary><pre>${esc(d.state
        ? `${JSON.stringify({ state: d.state, questions: { move: d.question } }, null, 2)}${d.raw !== undefined ? `\n\n── ANSWER ──\n${JSON.stringify(d.raw, null, 2)}` : ""}`
        : `── SYSTEM ──\n${d.system}\n\n── USER ──\n${d.user}${d.raw !== undefined ? `\n\n── REPLY ──\n${d.raw}` : ""}`)}</pre></details>` : ""}`;
  };
  try {
    const res = await playMatch(make(A), make(B), rules, rngFrom(rules.seed, "match"), {
      onRound: (r) => {
        sA += r.payoff[0]; sB += r.payoff[1];
        $("#mScore").textContent = `${sA} : ${sB}`;
                $("#mRows").insertAdjacentHTML("beforeend", `<tr><td>${r.round}</td><td>${cell(r.a)}</td><td>${cell(r.b)}</td><td>${fmt(r.payoff[0])} / ${fmt(r.payoff[1])}</td></tr>`);
      },
    });
    $("#mStatus").textContent = res.scoreA === res.scoreB ? "It's a tie." : `${res.scoreA > res.scoreB ? A.name : B.name} wins this match.`;
  } catch (e) {
    $("#mStatus").innerHTML = `<span class="err">${esc(e.message)}</span>`;
  } finally { endRun("m"); }
};
const fmt = (n) => (n > 0 ? "+" + n : String(n));

// ---------- TOURNAMENT ----------
$("#tRun").onclick = async () => {
  const all = byId();
  const pop = readCounts("#tCounts");
  const entrants = pop.flatMap((p) => Array.from({ length: p.count }, (_, k) => ({ agentId: `${p.archetype}#${k}`, archetype: all[p.archetype] })));
  if (entrants.length < 2) { $("#tStatus").textContent = "Add at least two agents."; return; }
  const err = checkReady(entrants.map((e) => e.archetype));
  if (err) { $("#tStatus").innerHTML = `<span class="err">${esc(err)}</span>`; return; }
  if (!confirmCost(updateEstimates().tc)) return;
  beginRun("t");
  try {
    const t = await playTournament(entrants, currentRules(), {
      makePlayer: factory(), keepTranscripts: false,
      onMatch: (m, d, n) => { $("#tStatus").textContent = `Match ${d} of ${n}…`; },
    });
    renderTournament(t, all);
    $("#tStatus").textContent = "Done.";
  } catch (e) { $("#tStatus").innerHTML = `<span class="err">${esc(e.message)}</span>`; }
  finally { endRun("t"); }
};
function renderTournament(t, all) {
  const max = Math.max(1, ...t.leaderboard.map((x) => Math.abs(x.average)));
  const ids = t.leaderboard.map((x) => x.archetype);
  // head-to-head: average coins row-archetype earns per match vs column-archetype
  const M = {};
  for (const m of t.matches) {
    for (const [me, them, s] of [[m.archA, m.archB, m.scoreA], [m.archB, m.archA, m.scoreB]]) {
      M[me] ??= {}; M[me][them] ??= { sum: 0, n: 0 };
      M[me][them].sum += s; M[me][them].n++;
    }
  }
  const P = currentRules().payoffs, best = P.R * currentRules().turns;
  const shade = (v) => { const x = Math.max(-1, Math.min(1, v / best)); return x >= 0 ? `rgba(75,178,106,${0.15 + 0.5 * x})` : `rgba(224,82,82,${0.15 + 0.5 * -x})`; };
  $("#tOut").innerHTML = `
    <h2 class="section-title">Leaderboard <span class="muted small">average coins per agent</span></h2>
    <div class="card"><table>${t.leaderboard.map((x, i) => `
      <tr><td style="width:30px">${i + 1}</td><td style="width:240px">${chip(all[x.archetype])} <span class="muted small">×${x.count}</span></td>
      <td><div class="bar" style="width:${Math.max(2, (Math.abs(x.average) / max) * 100)}%;background:${esc(all[x.archetype].color)}"></div></td>
      <td style="width:80px;text-align:right"><b>${x.average.toFixed(1)}</b></td></tr>`).join("")}</table></div>
    <h2 class="section-title">Head to head <span class="muted small">average coins the row earns per match against the column</span></h2>
    <div class="card" style="overflow:auto"><table class="matrix"><tr><th></th>${ids.map((id) => `<th title="${esc(all[id].name)}">${avatar(all[id], 28)}</th>`).join("")}</tr>
      ${ids.map((r) => `<tr><td class="rowh">${chip(all[r])}</td>${ids.map((c) => { const v = M[r]?.[c]; return v ? `<td style="background:${shade(v.sum / v.n)}">${(v.sum / v.n).toFixed(1)}</td>` : `<td class="muted">·</td>`; }).join("")}</tr>`).join("")}
    </table></div>`;
}

// ---------- EVOLUTION ----------
$("#eRun").onclick = async () => {
  const all = byId();
  const pop = readCounts("#eCounts");
  const n = pop.reduce((s, p) => s + p.count, 0);
  if (n < 2) { $("#eStatus").textContent = "Add at least two agents."; return; }
  const err = checkReady(pop.map((p) => all[p.archetype]));
  if (err) { $("#eStatus").innerHTML = `<span class="err">${esc(err)}</span>`; return; }
  if (!confirmCost(updateEstimates().ec)) return;
  const gens = Number($("#eGens").value) || 20;
  const order = pop.map((p) => p.archetype);
  const history = [];
  $("#eOut").innerHTML = `<div class="card" style="margin-top:14px"><div id="eChart"></div><div class="legend" id="eLegend"></div></div><div id="eLast"></div>`;
  $("#eLegend").innerHTML = order.map((id) => `<span><i style="background:${esc(all[id].color)}"></i>${esc(all[id].name)}</span>`).join("");
  beginRun("e");
  try {
    await evolve(pop, all, currentRules(), {
      generations: gens, makePlayer: factory(), shouldStop: () => state.stop,
      onMatch: (m, d, total, g) => { if (d % 10 === 0 || d === total) $("#eStatus").textContent = `Generation ${g}: match ${d} of ${total}…`; },
      onGeneration: ({ generation, population, leaderboard }) => {
        history.push(Object.fromEntries(population.map((p) => [p.archetype, p.count])));
        drawEvolution(history, order, all, n, gens);
        if (leaderboard) $("#eLast").innerHTML = `<p class="small muted">Generation ${generation} scores (avg coins): ${leaderboard.map((x) => `${esc(all[x.archetype].name)} ${x.average.toFixed(1)}`).join(" · ")}</p>`;
        $("#eStatus").textContent = `Generation ${generation}: ${population.map((p) => `${all[p.archetype].name} ${p.count}`).join(", ")}`;
      },
    });
    const last = history[history.length - 1];
    const alive = Object.keys(last);
    $("#eStatus").textContent = alive.length === 1 ? `${all[alive[0]].name} took over the whole population.` : state.stop ? `Stopped after ${history.length - 1} generations.` : `Finished ${history.length - 1} generations. No single archetype has taken over yet.`;
  } catch (e) { $("#eStatus").innerHTML = `<span class="err">${esc(e.message)}</span>`; }
  finally { endRun("e"); }
};
function drawEvolution(history, order, all, total, gens) {
  const W = 1000, H = 300, padL = 34, padB = 22;
  const nx = Math.max(gens, history.length - 1) || 1;
  const X = (g) => padL + (g / nx) * (W - padL - 8);
  const Y = (v) => 8 + (1 - v / total) * (H - padB - 8);
  let paths = "";
  const base = history.map(() => 0);
  for (const id of order) {
    const top = history.map((h, g) => base[g] + (h[id] || 0));
    const pts = history.map((_, g) => `${X(g)},${Y(top[g])}`);
    const back = history.map((_, g) => `${X(g)},${Y(base[g])}`).reverse();
    if (history.length === 1) { pts.push(`${X(0.15)},${Y(top[0])}`); back.unshift(`${X(0.15)},${Y(base[0])}`); }
    paths += `<path d="M${pts.join("L")}L${back.join("L")}Z" fill="${esc(all[id].color)}" stroke="#fff" stroke-width="0.8"><title>${esc(all[id].name)}</title></path>`;
    top.forEach((v, g) => (base[g] = v));
  }
  let axis = "";
  const step = Math.max(1, Math.ceil(nx / 10));
  for (let g = 0; g <= nx; g += step) axis += `<text x="${X(g)}" y="${H - 6}" font-size="11" text-anchor="middle" fill="#999">${g}</text>`;
  axis += `<text x="${padL - 6}" y="${Y(total) + 4}" font-size="11" text-anchor="end" fill="#999">${total}</text><text x="${padL - 6}" y="${Y(0)}" font-size="11" text-anchor="end" fill="#999">0</text>`;
  $("#eChart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Population by generation">${paths}${axis}</svg><div class="small muted">Population by generation</div>`;
}

// ---------- ACCOUNT ----------
async function finishOAuth() {
  try {
    const key = await openRouterAuth.finish();
    if (key) {
      state.orKey = key; store.set("openrouterKey", key); llm.setOpenRouterKey(key);
      gotoTab("account");
    }
  } catch (e) { $("#orModelInfo").innerHTML = `<span class="err">${esc(e.message)}</span>`; gotoTab("account"); }
}
$("#orConnect").onclick = () => openRouterAuth.start(location.origin + location.pathname);
$("#orDisconnect").onclick = () => { state.orKey = null; store.del("openrouterKey"); llm.setOpenRouterKey(null); renderAccount(); };
$("#puterConnect").onclick = async () => {
  try {
    if (!window.puter) await loadScript("https://js.puter.com/v2/");
    if (!window.puter.auth.isSignedIn()) await window.puter.auth.signIn();
    llmUsePuter();
  } catch (e) { $("#puterPill").textContent = "sign-in failed"; }
  renderAccount();
};
function llmUsePuter() {
  // re-create the client with Puter attached, keeping cache + stats object
  const fresh = createLLM({ openrouterKey: state.orKey, puter: window.puter, cacheStore, appUrl: location.origin + location.pathname });
  llm.complete = fresh.complete; llm.setOpenRouterKey = fresh.setOpenRouterKey;
  Object.assign(fresh.stats, llm.stats); llm.stats = fresh.stats;
}
const loadScript = (src) => new Promise((res, rej) => { const s = Object.assign(document.createElement("script"), { src, onload: res, onerror: rej }); document.head.append(s); });
$("#orModel").addEventListener("change", (e) => { state.models.openrouter = e.target.value.trim(); store.set("model:openrouter", state.models.openrouter); renderModelInfo(); renderAccount(); });
$("#decModel").addEventListener("change", (e) => { state.models.decisions = e.target.value.trim() || DEFAULT_DECISIONS_MODEL; store.set("model:decisions", state.models.decisions); renderModelInfo(); renderAccount(); });
$("#puterModel").addEventListener("change", (e) => { state.models.puter = e.target.value.trim(); store.set("model:puter", state.models.puter); renderAccount(); });
$("#cacheClear").onclick = () => { for (const k of Object.keys(cacheObj)) delete cacheObj[k]; store.del("cache"); renderUsage(); };

async function loadModelList() {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    const { data } = await res.json();
    state.orModelList = data;
    const isDecision = (m) => /decision|jev|clef/i.test(m.id) || (m.architecture?.output_modalities || []).some((x) => /decision/i.test(x));
    $("#orModels").innerHTML = data.filter((m) => !isDecision(m)).map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("");
    $("#decModels").innerHTML = data.filter(isDecision).map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("");
    if (!state.models.openrouter) {
      const prefer = ["anthropic/claude-haiku-4.5", "openai/gpt-5-mini", "openai/gpt-5-nano", "google/gemini-2.5-flash"];
      const pick = prefer.find((id) => data.some((m) => m.id === id)) || data.find((m) => /haiku|mini|flash/i.test(m.id))?.id || "";
      state.models.openrouter = pick; store.set("model:openrouter", pick);
      $("#orModel").value = pick;
    }
    renderModelInfo();
  } catch { $("#orModelInfo").textContent = "Couldn't load the model list (offline?). You can still type a model id."; }
}
function renderModelInfo() {
  const dm = state.orModelList.find((x) => x.id === state.models.decisions);
  if (dm) $("#decModelInfo").textContent = `${dm.name}: $${(Number(dm.pricing.prompt) * 1e6).toFixed(2)} per 1M input tokens, output free ≈ $${(Number(dm.pricing.prompt) * 550 * 1000).toFixed(3)} per 1,000 moves. Picks Cooperate or Cheat from a fixed list and returns probabilities.`;
  const m = state.orModelList.find((x) => x.id === state.models.openrouter);
  if (!m) { $("#orModelInfo").textContent = state.orModelList.length && state.models.openrouter ? "Not in OpenRouter's model list. Check the id." : ""; return; }
  const per = (p) => (Number(p) * 1e6).toFixed(2);
  // a move is roughly 450 prompt tokens + 40 completion tokens
  const perMove = Number(m.pricing.prompt) * 450 + Number(m.pricing.completion) * 40;
  $("#orModelInfo").textContent = `${m.name}: $${per(m.pricing.prompt)} / $${per(m.pricing.completion)} per 1M tokens in/out ≈ $${(perMove * 1000).toFixed(3)} per 1,000 moves.`;
}
function renderAccount() {
  const or = !!state.orKey, pu = !!window.puter?.auth?.isSignedIn?.();
  $("#orPill").textContent = or ? "connected" : "not connected"; $("#orPill").classList.toggle("ok", or);
  $("#puterPill").textContent = pu ? "signed in" : "not connected"; $("#puterPill").classList.toggle("ok", pu);
  $("#orConnect").textContent = or ? "Reconnect" : "Connect OpenRouter";
  $("#orDisconnect").style.display = or ? "" : "none";
  $("#orModel").value = state.models.openrouter; $("#puterModel").value = state.models.puter; $("#decModel").value = state.models.decisions;
  $("#acct").innerHTML = `
    <span class="pill ${or ? "ok" : ""}">OpenRouter ${or ? "✓" : "–"}</span>
    <span class="pill ${pu ? "ok" : ""}">Puter ${pu ? "✓" : "–"}</span>
    <button class="btn" id="acctBtn">${or || pu ? "Account" : "Connect an AI account"}</button>`;
  $("#acctBtn").onclick = () => gotoTab("account");
  renderUsage();
}
function renderUsage() {
  const s = llm.stats;
  $("#usage").innerHTML = `AI calls: <b>${s.calls}</b> · cache hits: <b>${s.cacheHits}</b> · errors: <b>${s.errors}</b>${s.cost ? ` · cost: <b>$${s.cost.toFixed(4)}</b>` : ""}`;
  $("#cacheInfo").textContent = `${Object.keys(cacheObj).length.toLocaleString()} cached answers`;
}

// ---------- boot ----------
function renderAll() { renderGallery(); renderSelectors(); renderRules(); updateEstimates(); renderAccount(); }
async function boot() {
  try {
    const files = await (await fetch("./archetypes/index.json")).json();
    state.repo = (await Promise.all(files.map((f) => fetch("./archetypes/" + f).then((r) => r.json())))).map(normalizeArchetype);
  } catch (e) { console.warn("Couldn't load shipped archetypes", e); }
  await finishOAuth();
  renderAll();
  loadModelList();
}
boot();
