/* The model behind Emma: Gemini, a prompt in and a JSON object out.

   Two speeds. QUICK (flash-lite, about 1 s) for everything said in the chat and the many small jobs of a
   match; MAIN (flash, about 3 s) for the writing that matters most: the spark and the agents' talk.
   At most LIMIT calls are in flight at once, so a full room never floods the API. */

export const QUICK = "gemini-flash-lite-latest";
export const MAIN = "gemini-flash-latest";
const LIMIT = 16;

let busy = 0;
const waiting = [];
async function slot() {
  if (busy < LIMIT) { busy++; return; }
  await new Promise(r => waiting.push(r));
}
function free() {
  const next = waiting.shift();
  if (next) next(); else busy--;
}

function jsonOf(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON from model: ${String(text).slice(0, 200)}`);
  return JSON.parse(m[0]);
}

async function call(env, model, prompt, timeout) {
  const config = { responseMimeType: "application/json" };
  if (model === MAIN) config.thinkingConfig = { thinkingBudget: 0 };     // a reply in ~3 s instead of ~4.5 s
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: config }),
    signal: AbortSignal.timeout(timeout * 1000),
  });
  if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  const parts = d.candidates?.[0]?.content?.parts || [];
  return jsonOf(parts.map(p => p.text || "").join(""));
}

/** One answer as an object. A failed call is tried once more (on the other model when the first was busy). */
export async function ask(env, prompt, { model = QUICK, timeout = 25 } = {}) {
  await slot();
  try {
    try {
      return await call(env, model, prompt, timeout);
    } catch (e) {
      console.log("llm retry:", String(e).slice(0, 200));
      const other = /gemini (429|5\d\d)/.test(String(e)) ? (model === QUICK ? MAIN : QUICK) : model;
      return await call(env, other, prompt, timeout);
    }
  } finally {
    free();
  }
}
