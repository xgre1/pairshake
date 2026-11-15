/* Traits: 44 numbers between 0 and 1 for every person, each with how sure we are, so matching can work on
   fixed values instead of free text.

   They are estimates from what someone's own AI wrote about them, not a psychological test. Research on LLMs
   reading personality from text finds modest accuracy (Peters & Matz, PNAS Nexus 2024: r about .29 with
   self-report Big Five, on a par with models trained for it) and high run-to-run stability with weak
   construct validity (Zhu et al. 2025). So every value carries a confidence, a dimension with no evidence
   stays near 0.5 with low confidence, and three independent readings are averaged (their disagreement
   lowers the confidence).

   The dimensions come from established models: Big Five (with HEXACO's honesty-humility and four IPIP-NEO
   facets), Schwartz's ten basic values, Holland's RIASEC interests, plus work-style, networking and career
   dimensions that matter for introductions. For matching: values and personality tend to work by
   similarity (value homophily predicts who forms ties), skills and interests by complementarity (skill
   complementarity predicts productive collaboration). */

import { ask, MAIN } from "./llm.js";

// [key, group, what 0 means, what 1 means]
export const DIMENSIONS = [
  // Big Five (domains; emotional stability is the reverse of neuroticism)
  ["openness", "personality", "conventional, prefers the familiar", "curious, imaginative, drawn to new ideas"],
  ["conscientiousness", "personality", "spontaneous, flexible, loose with plans", "organised, disciplined, follows through"],
  ["extraversion", "personality", "reserved, recharges alone", "outgoing, energised by people"],
  ["agreeableness", "personality", "challenging, competitive, blunt", "cooperative, trusting, accommodating"],
  ["emotional_stability", "personality", "easily stressed, anxious", "calm, steady under pressure"],
  // HEXACO's sixth factor
  ["honesty_humility", "personality", "status-seeking, self-promoting", "sincere, modest, fair"],
  // IPIP-NEO facets that matter when meeting people
  ["assertiveness", "personality", "lets others lead the conversation", "takes charge, speaks up"],
  ["warmth", "personality", "formal, keeps distance", "friendly, quick to connect"],
  ["achievement_drive", "personality", "content, relaxed about goals", "ambitious, driven to excel"],
  ["adventurousness", "personality", "prefers routine", "seeks novelty and change"],
  // Schwartz's ten basic human values
  ["self_direction", "values", "", "independent thought and action, freedom to choose own goals"],
  ["stimulation", "values", "", "excitement, novelty, challenge"],
  ["hedonism", "values", "", "pleasure, enjoying life"],
  ["achievement", "values", "", "personal success by showing competence"],
  ["power", "values", "", "status, prestige, control over people and resources"],
  ["security", "values", "", "safety, stability, harmony"],
  ["conformity", "values", "", "restraint, following norms and expectations"],
  ["tradition", "values", "", "respect for customs and ideas of one's culture or religion"],
  ["benevolence", "values", "", "caring for the people close to them"],
  ["universalism", "values", "", "understanding and protecting all people and nature"],
  // Holland's RIASEC interests
  ["realistic", "interests", "", "hands-on: building things, machines, hardware, the physical world"],
  ["investigative", "interests", "", "analysing, research, science, solving hard problems"],
  ["artistic", "interests", "", "creating, design, writing, expression"],
  ["social", "interests", "", "helping, teaching, caring for people"],
  ["enterprising", "interests", "", "leading, selling, persuading, starting ventures"],
  ["conventional", "interests", "", "organising data, process, operations, precision"],
  // How they work
  ["big_picture", "work", "focused on details and execution", "focused on vision and the big picture"],
  ["pace", "work", "careful, deliberate", "fast, ships quickly"],
  ["risk_tolerance", "work", "cautious, avoids risk", "comfortable with high risk and uncertainty"],
  ["autonomy", "work", "prefers working in a team", "prefers working alone"],
  ["structure", "work", "improvises, dislikes process", "wants clear structure and process"],
  ["directness", "work", "diplomatic, indirect", "blunt, says it straight"],
  ["leadership", "work", "prefers to support and contribute", "prefers to lead and decide"],
  ["maker", "work", "talks, sells, coordinates", "builds and makes things themselves"],
  // How they network
  ["openness_to_strangers", "networking", "hesitant with new people", "loves meeting new people"],
  ["giving", "networking", "mostly here to get help (taker)", "mostly here to help others (giver)"],
  ["collaboration_appetite", "networking", "not looking to work with anyone", "actively wants collaborators"],
  ["mentoring", "networking", "", "keen to teach and mentor others"],
  ["learning", "networking", "", "keen to learn from more experienced people"],
  ["playfulness", "networking", "serious, formal", "playful, humorous"],
  // Where they are in their career
  ["seniority", "career", "student or early career", "very senior, executive or veteran"],
  ["technical", "career", "non-technical", "deeply technical"],
  ["entrepreneurial", "career", "employee mindset", "founder, builds ventures"],
  ["urgency", "career", "no pressing need right now", "needs something urgently, this week"],
];

const KEYS = DIMENSIONS.map(d => d[0]);
const READINGS = 3;

const scale = DIMENSIONS.map(([k, , lo, hi]) => `- ${k}: ${lo ? `0 = ${lo}; ` : "0 = not at all; "}1 = ${hi}`).join("\n");

export const PROMPT = `You estimate a person's traits for a matchmaker that introduces people at events. You read a write-up
about them (written by their own AI assistant from what it knows of them) and its structured summary.

For every dimension below give two numbers between 0 and 1, with two decimals:
- value: where the person sits on the scale
- confidence: how much the write-up actually supports that value (0.9 = stated or clearly shown,
  0.5 = fairly implied, 0.2 = a guess, 0.05 = no evidence at all)

Rules:
- Base every value on evidence in the text: what they do, choose, say they want, how they describe working.
- With no evidence, give value 0.5 and confidence 0.1 or less. Never invent.
- Use the whole range: 0.15 and 0.85 are normal answers when the evidence is clear. Don't cluster at 0.5.
- Rate the person, not the writing style of their AI assistant.
- Values (self_direction ... universalism) and interests (realistic ... conventional) are each rated on their
  own, not as a ranking.

Dimensions:
${scale}

Also write "summary": 2 or 3 short sentences about the person for them to read about themselves, second
person, warm and specific, no numbers, no trait names.

Write-up:
{text}

Structured summary:
{persona}

Reply with JSON only: {"traits": {"openness": [0.00, 0.00], ...every dimension above...}, "summary": "..."}`;

const num = v => { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null; };
const r2 = n => Math.round(n * 100) / 100;

/** The traits as two arrays in DIMENSIONS order, for distances and similarities. */
export function vector(t) {
  return { vector: KEYS.map(k => t?.v?.[k] ?? 0.5), confidence: KEYS.map(k => t?.c?.[k] ?? 0) };
}

/** 16personalities-style letters from the Big Five (E/I extraversion, N/S openness, T/F agreeableness,
    J/P conscientiousness, -A/-T emotional stability). For show only: it is a rough mapping. */
export function typeCode(v) {
  if (!v) return "";
  return (v.extraversion >= 0.5 ? "E" : "I") + (v.openness >= 0.5 ? "N" : "S") + (v.agreeableness >= 0.5 ? "F" : "T") +
    (v.conscientiousness >= 0.5 ? "J" : "P") + "-" + (v.emotional_stability >= 0.5 ? "A" : "T");
}

/** Three independent readings, averaged by confidence; disagreement between them lowers the confidence. */
export async function readTraits(env, text, persona) {
  const prompt = PROMPT.replace("{text}", () => text).replace("{persona}", () => JSON.stringify(persona || {}));
  const runs = (await Promise.allSettled(Array.from({ length: READINGS }, () => ask(env, prompt, { model: MAIN, timeout: 45 }))))
    .filter(r => r.status === "fulfilled" && r.value && typeof r.value.traits === "object").map(r => r.value);
  if (!runs.length) throw new Error("no trait reading came back");
  return combine(runs);
}

/** The readings averaged by confidence; disagreement between them lowers the confidence. */
export function combine(runs) {
  const v = {}, c = {};
  for (const k of KEYS) {
    const got = runs.map(r => r.traits[k]).filter(Array.isArray).map(([a, b]) => [num(a), num(b)]).filter(([a, b]) => a != null && b != null);
    if (!got.length) { v[k] = 0.5; c[k] = 0; continue; }
    const w = got.reduce((s, [, b]) => s + Math.max(b, 0.01), 0);
    const mean = got.reduce((s, [a, b]) => s + a * Math.max(b, 0.01), 0) / w;
    const spread = got.length > 1 ? Math.sqrt(got.reduce((s, [a]) => s + (a - mean) ** 2, 0) / got.length) : 0.15;
    v[k] = r2(mean);
    c[k] = r2((got.reduce((s, [, b]) => s + b, 0) / got.length) * Math.max(0, 1 - 2 * spread));
  }
  const summary = String(runs.find(r => r.summary)?.summary || "").trim().slice(0, 600);
  return { v, c, type: typeCode(v), summary, readings: runs.length, version: 1 };
}
