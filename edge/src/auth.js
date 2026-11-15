/* Sign in with LinkedIn or Google (OpenID Connect, scopes openid, profile, email): the only way into PairShake.

   Both give a name, a photo and an email. Nothing about work (LinkedIn keeps headline, positions and skills
   for partners), so the context still comes from the steps after this one: ChatGPT, Claude, Emma.

   GET /auth/<provider>?ret=<origin or "app">&id=<their id, if any>   sends them to LinkedIn or Google
   GET /auth/<provider>/callback                                      they come back here

   The iPhone app gets them back at pairshake://signin?id=<id> (its sign-in sheet waits for that scheme), a
   page at <origin>/?li=<id>. The state is signed and short-lived, so nobody can hand someone else a login.
   Secrets: LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET. The redirect
   URL to register with each is <this Worker's address>/auth/<provider>/callback. */

export const PROVIDERS = {
  linkedin: {
    auth: "https://www.linkedin.com/oauth/v2/authorization",
    token: "https://www.linkedin.com/oauth/v2/accessToken",
    userinfo: "https://api.linkedin.com/v2/userinfo",
    id: env => env.LINKEDIN_CLIENT_ID, secret: env => env.LINKEDIN_CLIENT_SECRET,
    extra: {},
  },
  google: {
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
    id: env => env.GOOGLE_CLIENT_ID, secret: env => env.GOOGLE_CLIENT_SECRET,
    extra: { prompt: "select_account" },
  },
};
const RETURN_OK = /^(https:\/\/pairshake\.binjto\.workers\.dev|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
const STATE_MAX_AGE = 10 * 60 * 1000;

const enc = s => new TextEncoder().encode(s);
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

// the state is signed with the provider's own client secret
const key = (p, env) => crypto.subtle.importKey("raw", enc(p.secret(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

async function sign(p, env, data) {
  const body = b64url(enc(JSON.stringify(data)));
  return `${body}.${b64url(await crypto.subtle.sign("HMAC", await key(p, env), enc(body)))}`;
}

async function unsign(p, env, state) {
  const [body, sig] = String(state || "").split(".");
  if (!body || !sig) return null;
  try {
    if (!await crypto.subtle.verify("HMAC", await key(p, env), unb64url(sig), enc(body))) return null;
    const d = JSON.parse(new TextDecoder().decode(unb64url(body)));
    return Date.now() - d.t < STATE_MAX_AGE ? d : null;
  } catch {
    return null;
  }
}

const redirectUri = (url, name) => `${url.origin}/auth/${name}/callback`;

function back(ret, params) {
  const location = ret === "app"
    ? `pairshake://signin?${new URLSearchParams(params)}`
    : `${ret}/?${new URLSearchParams(params.id ? { li: params.id } : { li_error: params.error })}`;
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

/** GET /auth/<provider>: off to LinkedIn or Google. */
export async function start(name, req, env) {
  const p = PROVIDERS[name], url = new URL(req.url);
  if (!p.id(env) || !p.secret(env)) return Response.json({ error: `${name} sign-in isn't set up yet.` }, { status: 503 });
  const ret = url.searchParams.get("ret") || "";
  if (ret !== "app" && !RETURN_OK.test(ret)) return Response.json({ error: "Unknown return address." }, { status: 400 });
  const id = (url.searchParams.get("id") || "").replace(/[^a-z0-9]/gi, "").slice(0, 32);
  const app = ret === "app" || (req.headers.get("user-agent") || "").includes("PairShakeApp");
  const to = new URL(p.auth);
  to.search = new URLSearchParams({
    response_type: "code", client_id: p.id(env), redirect_uri: redirectUri(url, name), scope: "openid profile email",
    state: await sign(p, env, { ret, id, app, t: Date.now() }), ...p.extra,
  }).toString();
  return Response.redirect(to.toString(), 302);
}

/** GET /auth/<provider>/callback: who they are, into the room, and back to the app. */
export async function callback(name, req, env, room) {
  const p = PROVIDERS[name], url = new URL(req.url), q = url.searchParams;
  const st = await unsign(p, env, q.get("state"));
  if (!st) return new Response("This sign-in link has expired. Go back to PairShake and try again.", { status: 400 });
  if (q.get("error") || !q.get("code")) return back(st.ret, { error: "cancelled" });
  try {
    const tok = await fetch(p.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code: q.get("code"), redirect_uri: redirectUri(url, name),
        client_id: p.id(env), client_secret: p.secret(env),
      }),
    });
    if (!tok.ok) throw new Error(`token ${tok.status}: ${(await tok.text()).slice(0, 200)}`);
    const { access_token } = await tok.json();
    const me = await fetch(p.userinfo, { headers: { authorization: `Bearer ${access_token}` } });
    if (!me.ok) throw new Error(`userinfo ${me.status}: ${(await me.text()).slice(0, 200)}`);
    const u = await me.json();
    const r = await room.fetch(new Request("https://room/internal/login", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": st.app ? "PairShakeApp" : "web" },
      body: JSON.stringify({ provider: name, id: st.id, sub: u.sub, name: u.name, picture: u.picture, email: u.email }),
    }));
    if (!r.ok) throw new Error(`room ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return back(st.ret, { id: (await r.json()).id });
  } catch (e) {
    console.log(`${name} sign-in error:`, String(e));
    return back(st.ret, { error: "failed" });
  }
}
