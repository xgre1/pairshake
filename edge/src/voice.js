/* Emma's voice and ears.

   speak(): a line in Emma's voice. Voiced once by ElevenLabs, then kept in R2 for good (it costs from a small
   monthly allowance), under the same name the Mac's voice_cache used: sha1("<voice id>|<text>").wav. When
   ElevenLabs is down, Cloudflare's own voice speaks instead, and that line isn't kept.
   hear(): 16 kHz mono int16 PCM in, Whisper's text out. */
import { Buffer } from "node:buffer";

export const VOICE_ID = "OSxQoMnSFe6QtcNVSptL";       // Roomie's voice: Emma's own designed ElevenLabs voice
const ELEVEN_MODEL = "eleven_v4_turbo";
const SR = 24000;

export async function voiceKey(text) {
  const h = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`${VOICE_ID}|${text}`));
  return "voice/" + [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("") + ".wav";
}

function wav(pcm, sr) {
  const out = new Uint8Array(44 + pcm.byteLength), v = new DataView(out.buffer);
  const tag = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  tag(0, "RIFF"); v.setUint32(4, 36 + pcm.byteLength, true); tag(8, "WAVE");
  tag(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, "data"); v.setUint32(40, pcm.byteLength, true);
  out.set(new Uint8Array(pcm), 44);
  return out;
}

let elevenDownUntil = 0;

/** {body, type, kept}: the line as audio, from R2 when it was ever voiced before. */
export async function speak(env, text) {
  const key = await voiceKey(text);
  const hit = await env.VOICE.get(key);
  if (hit) return { body: await hit.arrayBuffer(), type: "audio/wav", kept: true };
  if (Date.now() >= elevenDownUntil && env.ELEVENLABS_API_KEY) {
    try {
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=pcm_${SR}`, {
        method: "POST",
        headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "content-type": "application/json" },
        body: JSON.stringify({ text, model_id: ELEVEN_MODEL }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const body = wav(await r.arrayBuffer(), SR);
      await env.VOICE.put(key, body, { httpMetadata: { contentType: "audio/wav" } });
      return { body, type: "audio/wav", kept: true };
    } catch (e) {
      console.log("ElevenLabs failed; Cloudflare's voice speaks for now:", String(e));
      elevenDownUntil = Date.now() + 120_000;
    }
  }
  const plain = text.replace(/\[[a-z][a-z ]{1,24}\]\s*/g, "").trim() || "Mm.";    // it would read "[laughs]" out
  const out = await env.AI.run("@cf/deepgram/aura-1", { text: plain, speaker: "asteria" });
  const body = out instanceof ReadableStream ? await new Response(out).arrayBuffer()
    : out?.audio ? Buffer.from(out.audio, "base64") : out;
  return { body, type: "audio/mpeg", kept: false };
}

/** What was said, from 16 kHz mono int16 PCM. */
export async function hear(env, pcm) {
  const audio = Buffer.from(wav(pcm, 16000)).toString("base64");
  const r = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio, task: "transcribe", vad_filter: true });
  return String(r.text || "").trim();
}
