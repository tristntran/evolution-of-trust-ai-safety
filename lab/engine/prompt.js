// Turns the game state into a prompt for an LLM player, and parses its reply.
import { COOPERATE, CHEAT } from "./pd.js";

export const DEFAULT_RULES_TEMPLATE = `You are a player in a repeated trust game (the iterated Prisoner's Dilemma) against one other player.

Each round, you and your opponent each secretly choose one move:
- COOPERATE: put one coin into the machine.
- CHEAT: put nothing in.

Payoffs each round:
- You both COOPERATE: you each get {{R}}.
- You COOPERATE, they CHEAT: you get {{S}}, they get {{T}}.
- You CHEAT, they COOPERATE: you get {{T}}, they get {{S}}.
- You both CHEAT: you each get {{P}}.
{{NOISE_LINE}}{{TURNS_LINE}}You don't know who your opponent is. Your score is the total number of coins you earn.`;

function fill(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export function buildMessages(archetype, view) {
  const r = view.rules;
  const vars = {
    ...r.payoffs,
    NOISE_LINE: r.noise > 0
      ? `- Mistakes happen: each move has a ${Math.round(r.noise * 100)}% chance of being accidentally flipped to the opposite move.\n`
      : "",
    TURNS_LINE: r.revealTurns
      ? `This match lasts exactly ${r.turns} rounds.\n`
      : "You don't know how many rounds this match will last.\n",
    ROUND: view.round,
    TURNS: r.turns,
  };
  const rules = archetype.includeRules === false ? "" : fill(archetype.rulesTemplate || DEFAULT_RULES_TEMPLATE, vars);
  const persona = (archetype.system || "").trim();
  const system = [rules, persona && `YOUR STRATEGY / PERSONA:\n${persona}`].filter(Boolean).join("\n\n");

  const n = view.myMoves.length;
  const window = archetype.historyWindow > 0 ? archetype.historyWindow : n;
  const start = Math.max(0, n - window);
  let history;
  if (n === 0) {
    history = "This is the first round. There is no history yet.";
  } else {
    const lines = [];
    if (start > 0) {
      const theyCheated = view.theirMoves.slice(0, start).filter((m) => m === CHEAT).length;
      lines.push(`(Rounds 1-${start} omitted: opponent cheated ${theyCheated} of ${start} times.)`);
    }
    for (let i = start; i < n; i++) lines.push(`Round ${i + 1}: you ${view.myMoves[i]}, opponent ${view.theirMoves[i]}`);
    history = `History so far:\n${lines.join("\n")}\n\nYour total: ${view.myScore} coins. Opponent's total: ${view.theirScore} coins.`;
  }

  const situation = `${history}\n\nIt is now round ${view.round}. Choose your move.`;
  const user = `${situation}
Reply with only a JSON object, reason first:
{"reason": "<one short sentence>", "move": "COOPERATE" or "CHEAT"}`;

  return { system, user, situation, rules, persona };
}

// For the Decisions API: the game goes in as `state`, and the move is a
// single `choice` question whose options are the two moves.
export function buildDecision(archetype, view) {
  const { rules, persona, situation } = buildMessages(archetype, view);
  const state = {
    ...(rules ? { game_rules: rules } : {}),
    ...(persona ? { your_persona_and_strategy: persona } : {}),
    situation,
  };
  const question = {
    type: "choice",
    instructions: persona
      ? "You are the player described in your_persona_and_strategy, playing this game. Following that persona and strategy, which move do you make this round?"
      : "You are a player in this game. Which move do you make this round?",
    criteria: {
      COOPERATE: "Put one coin into the machine this round.",
      CHEAT: "Put nothing into the machine this round.",
    },
  };
  return { state, question };
}

export function parseMove(text) {
  const raw = String(text ?? "");
  // 1) JSON object anywhere in the reply
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      const mv = String(obj.move || "").toUpperCase();
      if (mv === COOPERATE || mv === CHEAT) return { move: mv, reason: obj.reason ? String(obj.reason) : undefined };
    } catch {}
  }
  // 2) last mention of a move word
  const words = [...raw.toUpperCase().matchAll(/\b(COOPERATE|CHEAT|DEFECT)\b/g)];
  if (words.length) {
    const w = words[words.length - 1][1];
    return { move: w === "DEFECT" ? CHEAT : w, reason: raw.slice(0, 200), error: "unstructured reply" };
  }
  // 3) give up: cooperate, and flag it so you can see the prompt is misbehaving
  return { move: COOPERATE, reason: raw.slice(0, 200), error: "unparseable reply, defaulted to COOPERATE" };
}
