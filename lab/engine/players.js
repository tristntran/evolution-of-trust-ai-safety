// Archetypes = the "characters" you can put in a match/tournament/evolution.
// Two kinds:
//   kind:"builtin"  - one of the 8 original hard-coded strategies
//   kind:"prompt"   - an LLM following your prompt, deciding every move
import { BUILTINS } from "./strategies.js";
import { buildMessages, buildDecision, parseMove } from "./prompt.js";

export const DEFAULT_DECISIONS_MODEL = "openai/gpt-6-luna-decisions";

export const PROMPT_DEFAULTS = {
  kind: "prompt",
  // "decisions": OpenRouter Decisions API picks COOPERATE/CHEAT and returns probabilities (cheap, fast, no prose)
  // "chat":      a chat model writes a one-line reason, then a move
  api: "decisions",
  selection: "argmax", // decisions only: "argmax" = most likely move, "sample" = draw from the probabilities
  provider: "openrouter",
  model: "",
  temperature: 0,
  maxTokens: 300,
  historyWindow: 0, // 0 = show full history
  includeRules: true,
  system: "",
  description: "",
  color: "#9b59b6",
};

export function builtinArchetypes() {
  return Object.entries(BUILTINS).map(([id, b]) => ({
    id, kind: "builtin", builtin: id, name: b.name, color: b.color, description: b.description,
  }));
}

export function normalizeArchetype(a) {
  if (a.kind === "builtin") return a;
  const out = { ...PROMPT_DEFAULTS, ...a, kind: "prompt" };
  if (out.provider === "puter") out.api = "chat"; // Puter has no Decisions API
  if (out.provider === "mock") out.api = a.api || "decisions";
  if (!/^[a-z0-9_-]+$/i.test(out.id || "")) throw new Error(`Archetype id "${out.id}" must be letters, digits, _ or -`);
  if (BUILTINS[out.id]) throw new Error(`"${out.id}" is reserved for a built-in strategy`);
  return out;
}

// makePlayer(archetype) -> { decide(view, rng), remember(own, other) }
export function createPlayerFactory({ llm, defaultModel = "", onDecision } = {}) {
  return function makePlayer(arch) {
    if (arch.kind === "builtin") {
      const brain = BUILTINS[arch.builtin].create();
      return {
        decide: async (view, rng) => ({ move: brain.play(rng) }),
        remember: (own, other) => brain.remember(own, other),
      };
    }

    // Mock provider: runs a built-in strategy but goes through the full prompt
    // path, so you can test plumbing and UI without spending anything.
    let mockBrain = arch.provider === "mock" ? BUILTINS[arch.mockStrategy || "tft"].create() : null;

    return {
      async decide(view, rng) {
        // Draw before any await, so random streams stay reproducible when moves resolve out of order.
        const u = rng();
        const { system, user } = buildMessages(arch, view);
        if (arch.api === "decisions" && !mockBrain) {
          const { state, question } = buildDecision(arch, view);
          try {
            const ans = await llm.decide({ model: arch.model || defaultModel || DEFAULT_DECISIONS_MODEL, state, question });
            if (ans.refusal) {
              const d = { move: "COOPERATE", error: `Model refused, defaulted to COOPERATE: ${ans.refusal}` };
              onDecision?.({ arch, view, state, question, raw: ans, ...d });
              return d;
            }
            const pC = Number(ans.probabilities?.COOPERATE ?? (ans.choice === "COOPERATE" ? 1 : 0));
            const move = arch.selection === "sample" ? (u < pC ? "COOPERATE" : "CHEAT") : ans.choice === "CHEAT" ? "CHEAT" : "COOPERATE";
            const d = { move, pCooperate: pC, confidence: ans.confidence, reason: `P(cooperate) = ${pC.toFixed(2)}` };
            onDecision?.({ arch, view, state, question, raw: ans, ...d });
            return d;
          } catch (e) {
            if (e.retryable === false) throw e;
            const d = { move: "COOPERATE", error: `Decisions error, defaulted to COOPERATE: ${e.message}` };
            onDecision?.({ arch, view, state, question, ...d });
            return d;
          }
        }
        if (mockBrain) {
          const move = mockBrain.play(rng);
          const d = { move, reason: `(mock: behaving like ${BUILTINS[arch.mockStrategy || "tft"].name})` };
          onDecision?.({ arch, view, system, user, ...d });
          return d;
        }
        try {
          const text = await llm.complete(arch.provider, {
            model: arch.model || defaultModel,
            system, user,
            temperature: arch.temperature,
            maxTokens: arch.maxTokens,
            cache: arch.cache ?? arch.temperature === 0,
          });
          const d = parseMove(text);
          onDecision?.({ arch, view, system, user, raw: text, ...d });
          return d;
        } catch (e) {
          if (e.retryable === false) throw e; // e.g. not connected: stop the run
          const d = { move: "COOPERATE", reason: "", error: `LLM error, defaulted to COOPERATE: ${e.message}` };
          onDecision?.({ arch, view, system, user, ...d });
          return d;
        }
      },
      remember(own, other) { mockBrain?.remember(own, other); },
    };
  };
}

// How many LLM calls (before caching) would a run cost? Useful before you press go.
export function estimateCalls({ entrants, turns }) {
  // entrants: array of archetypes (one per agent)
  let calls = 0;
  for (let i = 0; i < entrants.length; i++)
    for (let j = i + 1; j < entrants.length; j++)
      calls += turns * ((isLLM(entrants[i]) ? 1 : 0) + (isLLM(entrants[j]) ? 1 : 0));
  return calls;
}
export const isLLM = (a) => a.kind === "prompt" && a.provider !== "mock";
