// LLM access. No keys are ever bundled with the app: in the browser the user
// connects their OWN account (OpenRouter OAuth or Puter sign-in); on the CLI
// you supply your own OPENROUTER_API_KEY. Works in browsers and Node 18+.

export const PROVIDERS = {
  mock: { label: "Mock (offline, free)", browser: true, node: true },
  openrouter: { label: "OpenRouter (Claude, GPT, Gemini, decision models…)", browser: true, node: true },
  puter: { label: "Puter (user-pays, browser only)", browser: true, node: false },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createLLM({ openrouterKey, puter, appUrl = "https://github.com/tristntran/evolution-of-trust-ai-safety", appTitle = "Evolution of Trust: AI Lab", cacheStore, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  const cache = cacheStore || new Map(); // anything with get/set
  const inflight = new Map();
  const stats = { calls: 0, cacheHits: 0, errors: 0, promptTokens: 0, completionTokens: 0, cost: 0 };

  async function withRetry(fn) {
    let delay = 1000;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const retryable = e.retryable !== false && attempt < 4;
        if (!retryable) throw e;
        await sleep(delay + Math.random() * 300);
        delay *= 2;
      }
    }
  }

  async function callOpenRouter({ model, system, user, temperature, maxTokens }) {
    if (!openrouterKey) throw Object.assign(new Error("Not connected to OpenRouter. Click “Connect OpenRouter” first."), { retryable: false });
    const res = await doFetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openrouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": appUrl,
        "X-Title": appTitle,
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        usage: { include: true },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
      err.retryable = res.status === 429 || res.status >= 500;
      throw err;
    }
    const json = await res.json();
    if (json.usage) {
      stats.promptTokens += json.usage.prompt_tokens || 0;
      stats.completionTokens += json.usage.completion_tokens || 0;
      stats.cost += json.usage.cost || 0;
    }
    return json.choices?.[0]?.message?.content ?? "";
  }

  // OpenRouter Decisions API: typed answers with probabilities, no free text.
  async function callDecisions({ model, state, question }) {
    if (!openrouterKey) throw Object.assign(new Error("Not connected to OpenRouter. Click “Connect OpenRouter” first."), { retryable: false });
    const res = await doFetch("https://openrouter.ai/api/alpha/decisions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openrouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": appUrl,
        "X-Title": appTitle,
      },
      body: JSON.stringify({ model, state, questions: { move: question } }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`OpenRouter Decisions ${res.status}: ${body.slice(0, 300)}`);
      err.retryable = res.status === 429 || res.status >= 500;
      throw err;
    }
    const json = await res.json();
    if (json.usage) {
      stats.promptTokens += json.usage.prompt_tokens || json.usage.input_tokens || 0;
      stats.cost += json.usage.cost || 0;
    }
    const a = json.answers?.move;
    if (!a) throw Object.assign(new Error(`Decisions reply had no answer: ${JSON.stringify(json).slice(0, 200)}`), { retryable: false });
    if (a.type === "refusal" || a.refusal) return { refusal: a.refusal || "refused" };
    return { choice: a.choice, probabilities: a.probabilities || {}, confidence: a.confidence };
  }

  async function callPuter({ model, system, user, temperature, maxTokens }) {
    if (!puter?.ai) throw Object.assign(new Error("Puter.js not loaded (browser only)."), { retryable: false });
    const res = await puter.ai.chat(
      [{ role: "system", content: system }, { role: "user", content: user }],
      { model, temperature, max_tokens: maxTokens }
    );
    const c = res?.message?.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((p) => p.text || "").join("");
    return String(res ?? "");
  }

  async function complete(provider, req) {
    const key = JSON.stringify([provider, req.model, req.temperature, req.maxTokens, req.system, req.user]);
    const cacheable = req.cache;
    if (cacheable) {
      const hit = await cache.get(key);
      if (hit !== undefined) { stats.cacheHits++; return hit; }
      if (inflight.has(key)) { stats.cacheHits++; return inflight.get(key); }
    }
    const run = (async () => {
      stats.calls++;
      try {
        const text = await withRetry(() =>
          provider === "openrouter" ? callOpenRouter(req)
          : provider === "puter" ? callPuter(req)
          : Promise.reject(Object.assign(new Error(`Unknown provider "${provider}"`), { retryable: false }))
        );
        if (cacheable) await cache.set(key, text);
        return text;
      } catch (e) {
        stats.errors++;
        throw e;
      } finally {
        inflight.delete(key);
      }
    })();
    if (cacheable) inflight.set(key, run);
    return run;
  }

  // Same caching/dedupe as complete(), for the Decisions API.
  async function decide(req) {
    const key = JSON.stringify(["decisions", req.model, req.state, req.question]);
    const hit = await cache.get(key);
    if (hit !== undefined) { stats.cacheHits++; return JSON.parse(hit); }
    if (inflight.has(key)) { stats.cacheHits++; return inflight.get(key); }
    const run = (async () => {
      stats.calls++;
      try {
        const ans = await withRetry(() => callDecisions(req));
        await cache.set(key, JSON.stringify(ans));
        return ans;
      } catch (e) { stats.errors++; throw e; }
      finally { inflight.delete(key); }
    })();
    inflight.set(key, run);
    return run;
  }

  return { complete, decide, stats, setOpenRouterKey: (k) => { openrouterKey = k; } };
}

// ---------- "Sign in with OpenRouter" (OAuth PKCE, browser only) ----------
// No client registration, no backend, no secret: the user authorizes on
// openrouter.ai and we receive an API key that belongs to *their* account
// (they control its spend limit and can revoke it any time).
export const openRouterAuth = {
  async start(callbackUrl) {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    sessionStorage.setItem("or_pkce_verifier", verifier);
    const url = new URL("https://openrouter.ai/auth");
    url.searchParams.set("callback_url", callbackUrl);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    location.href = url.toString();
  },
  // Call on page load. Returns the key if we just came back from OpenRouter.
  async finish() {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const verifier = sessionStorage.getItem("or_pkce_verifier");
    if (!code || !verifier) return null;
    sessionStorage.removeItem("or_pkce_verifier");
    history.replaceState(null, "", location.pathname + location.hash);
    const res = await fetch("https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
    });
    if (!res.ok) throw new Error(`OpenRouter sign-in failed (${res.status})`);
    const { key } = await res.json();
    return key;
  },
};

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
