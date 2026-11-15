/* PairShake on the web: https://pairshake.pages.dev. The same page as the iPhone app (app/web), in a browser.
   This front serves the page and Emma's hands from its own files and hands everything else (the API, the
   room's WebSocket, sign-in) to the app's backend Worker through a service binding, so the page talks to one
   address and every person, network and introduction is the same as in the app. */
const BACKEND = "https://pairshake.binjto.workers.dev";   // the backend sees its own address (sign-in builds its callback from it)

export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname;
    if (path === "/" || path === "/index.html") {
      const r = await env.ASSETS.fetch(new Request(url.origin + "/", req));
      const out = new Response(r.body, r);
      out.headers.set("cache-control", "no-store");        // never cached: a deploy shows at once
      return out;
    }
    if (path.startsWith("/hands/")) return env.ASSETS.fetch(req);
    // a network's share link: into this page, which joins it (the backend's version opens the app instead)
    const j = path.match(/^\/join\/([A-Za-z0-9]{4,12})$/);
    if (j) return Response.redirect(`${url.origin}/?join=${j[1].toUpperCase()}`, 302);
    const to = new URL(path + url.search, BACKEND);
    if (path === "/events" && !to.searchParams.has("lat") && req.cf?.latitude) {   // nearby: where Cloudflare thinks they are
      to.searchParams.set("lat", req.cf.latitude); to.searchParams.set("lon", req.cf.longitude);
    }
    return env.API.fetch(new Request(to, new Request(req, { redirect: "manual" })));
  },
};
