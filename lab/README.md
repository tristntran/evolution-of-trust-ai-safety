# Evolution of Trust: AI Lab

Put LLM **prompts** into Nicky Case's [The Evolution of Trust](https://ncase.me/trust/) and see how they do against the original characters (Copycat, Always Cheat, Grudger, Detective…) and against each other: one match, a round-robin tournament, or the full evolution sim.

A **prompt archetype** is an AI player made of a model plus a persona/strategy prompt. Every round it's shown the rules and the history so far, and it picks **COOPERATE** or **CHEAT**.

```
lab/
  index.html, app.js     the browser lab (static: no server, no keys)
  cli.js                 headless runner, for scripts/CI/coding agents
  engine/                game engine shared by both (plain ES modules)
    pd.js                rules, match, tournament, evolution (seeded, async)
    strategies.js        the 8 original characters, ported 1:1
    prompt.js            game state → prompt / Decisions request
    players.js           builtin + prompt players
    llm.js               OpenRouter (chat + Decisions), Puter, OAuth sign-in, cache
  archetypes/*.json      prompt archetypes shipped with the repo
  test/                  node --test (includes a check against the original js/sims/PD.js)
```

## Run it

```bash
cd lab
node serve.js            # → http://localhost:8080/lab/
npm test                 # engine tests, no network needed
```

It's a static page, so it also works on GitHub Pages at `https://<user>.github.io/<repo>/lab/` once Pages is enabled for the branch.

## Who pays for the AI? The user, with their own account

The app holds **no API keys** and has no backend. Each user connects their own account in the **Account & models** tab:

| Option | How it works | Models |
|---|---|---|
| **OpenRouter** (recommended) | "Sign in with OpenRouter" (OAuth PKCE). The user approves the app on openrouter.ai and the browser receives a key tied to *their* account. They can cap or revoke it there. No client registration or secret needed. | Claude, GPT, Gemini, … and the **decision models** |
| **Puter** | "User-pays" sign-in via Puter.js. Usage comes out of the user's Puter balance. Chat engine only. | GPT, Claude, Gemini, … |
| **Mock** | Offline, free. Runs a built-in strategy through the whole pipeline for testing. | n/a |

Credentials are stored only in that user's browser (`localStorage`) and sent only to the provider they connected.

**Why not "Sign in with Claude"?** Anthropic doesn't allow third-party apps to use Claude.ai/subscription logins, so Claude models go through OpenRouter. **Sign in with ChatGPT** (using a user's ChatGPT plan) is currently offered for open-source tools that run *locally*, and could be added as a provider for the CLI/local mode later.

## Two engines

**Decisions API (default).** Uses OpenRouter's Decisions endpoint (`POST https://openrouter.ai/api/alpha/decisions`), default model `openai/gpt-6-luna-decisions`. The game goes in as `state` (rules, persona, history) with one `choice` question whose options are `COOPERATE` / `CHEAT`. The model returns a choice and its probabilities, with no free text. That makes it fast and cheap (output tokens are free) and gives you **P(cooperate)** for every move. Per archetype, choose:
- `"selection": "argmax"`: always play the most likely move
- `"selection": "sample"`: draw the move from the probabilities (seeded, so still reproducible)

**Chat.** Any OpenRouter/Puter chat model writes a one-line reason, then a move. Slower and pricier, but you can read *why* it played what it did.

## Archetype format

```json
{
  "id": "golden_rule",
  "name": "Golden Rule",
  "kind": "prompt",
  "color": "#a0522d",
  "description": "Values-based: treat others as you want to be treated.",
  "api": "decisions",            // or "chat"
  "selection": "argmax",         // decisions only: or "sample"
  "provider": "openrouter",      // "openrouter" | "puter" | "mock"
  "model": "",                   // blank = default from the Account tab / CLI flag
  "historyWindow": 0,            // show only the last N rounds (0 = all)
  "includeRules": true,          // prepend the standard rules text
  "system": "You follow the golden rule: ..."
}
```

Chat archetypes also take `temperature` and `maxTokens`. Mock archetypes take `mockStrategy` (any builtin id).

In the browser, archetypes you create are saved in your browser. Use **Export mine** / **Import** to share them, or drop the JSON into `lab/archetypes/` (and list it in `index.json`) to ship it with the repo.

## CLI

```bash
export OPENROUTER_API_KEY=...          # your own key; only needed for non-mock AI players
node cli.js list
node cli.js new cautious --name "Cautious" --system "Cooperate, but never get fooled twice."
node cli.js match golden_rule prober --noise 0.05
node cli.js tournament golden_rule:2 ruthless_maximizer:2 tft all_d grudge
node cli.js evolve tft:5 all_d:5 golden_rule:5 ruthless_maximizer:5 --generations 20
node cli.js match game_theorist tft --model anthropic/claude-haiku-4.5   # chat archetypes need a chat model
```

Add `--json` for machine-readable output. That makes it easy to hand the lab to a coding agent ("run these 5 prompts in an evolution and tell me which survives").

## Keeping it cheap

An evolution run is thousands of moves. Two things keep the call count down:
- **Caching.** Identical situations (same prompt, same history) get the same answer. With deterministic decisions that's exact, and the many copies of an archetype keep meeting the same opponents in the same situations. In a test with a stub model, a 15-generation run of 33 agents needed under 100 real calls for ~29,000 moves (real models produce more varied histories, so expect more, but still far below the raw count). The browser keeps the cache in `localStorage`; the CLI uses `lab/.cache/`.
- **In-flight de-duplication.** Concurrent identical requests share one call.

The UI shows an upper-bound estimate before each run and asks for confirmation above 400 calls.

## Fidelity to the original

`engine/strategies.js` ports the eight characters line by line, and the tests load the original `js/sims/PD.js` and check that every deterministic pairing scores identically. Payoffs (R=2, S=-1, T=3, P=0), noise, rounds per match and eliminate/reproduce selection all match the original defaults.
