// The 8 classic characters from "The Evolution of Trust" (js/sims/PD.js),
// ported 1:1 so the headless engine reproduces the original game.
// Each factory returns a fresh per-match brain: { play(rng) -> move, remember(own, other) }.

import { COOPERATE, CHEAT } from "./pd.js";

const flip = (m) => (m === COOPERATE ? CHEAT : COOPERATE);

export const BUILTINS = {
  tft: {
    name: "Copycat",
    color: "#4089DD",
    description: "Starts with Cooperate, then copies whatever you did last round.",
    create() {
      let otherMove = COOPERATE;
      return { play: () => otherMove, remember: (own, other) => { otherMove = other; } };
    },
  },
  all_d: {
    name: "Always Cheat",
    color: "#52537F",
    description: "Always cheats.",
    create: () => ({ play: () => CHEAT, remember() {} }),
  },
  all_c: {
    name: "Always Cooperate",
    color: "#FF75FF",
    description: "Always cooperates.",
    create: () => ({ play: () => COOPERATE, remember() {} }),
  },
  grudge: {
    name: "Grudger",
    color: "#efc701",
    description: "Cooperates until you cheat once, then cheats forever.",
    create() {
      let everCheatedMe = false;
      return {
        play: () => (everCheatedMe ? CHEAT : COOPERATE),
        remember: (own, other) => { if (other === CHEAT) everCheatedMe = true; },
      };
    },
  },
  prober: {
    name: "Detective",
    color: "#f6b24c",
    description: "Plays C, D, C, C. If you ever retaliate, becomes Copycat; otherwise always cheats.",
    create() {
      const moves = [COOPERATE, CHEAT, COOPERATE, COOPERATE];
      let everCheatedMe = false;
      let otherMove = COOPERATE;
      return {
        play() {
          if (moves.length > 0) return moves.shift();
          return everCheatedMe ? otherMove : CHEAT;
        },
        remember(own, other) {
          if (moves.length > 0 && other === CHEAT) everCheatedMe = true;
          otherMove = other;
        },
      };
    },
  },
  tf2t: {
    name: "Copykitten",
    color: "#88A8CE",
    description: "Like Copycat, but only retaliates after being cheated twice in a row.",
    create() {
      let howManyTimesCheated = 0;
      return {
        play: () => (howManyTimesCheated >= 2 ? CHEAT : COOPERATE),
        remember: (own, other) => { howManyTimesCheated = other === CHEAT ? howManyTimesCheated + 1 : 0; },
      };
    },
  },
  pavlov: {
    name: "Simpleton",
    color: "#86C448",
    description: "Starts with Cooperate. If you cooperated, repeats its last move; if you cheated, switches.",
    create() {
      let myLastMove = COOPERATE;
      return {
        play: () => myLastMove,
        remember(own, other) {
          myLastMove = own; // remembers its (possibly noise-flipped) move, like the original
          if (other === CHEAT) myLastMove = flip(myLastMove);
        },
      };
    },
  },
  random: {
    name: "Random",
    color: "#FF5E5E",
    description: "Cooperates or cheats at random, 50/50.",
    create: () => ({ play: (rng) => (rng() > 0.5 ? COOPERATE : CHEAT), remember() {} }),
  },
};
