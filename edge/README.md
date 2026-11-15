# edge

The Cloudflare Worker that gives Roomie its public address: **https://roomie.binjto.workers.dev**.

```sh
./tunnel.sh      # keep the Mac connected to Cloudflare (or `make tunnel`)
./deploy.sh      # deploy the Worker (or `make edge`)
```

| File | What it is |
| --- | --- |
| `src/index.js` | The Worker. The hands' heavy models come from Cloudflare's edge (checked against the Mac with `If-None-Match`); everything else, including WebSockets, goes to `server.py` through the VPC binding `ORIGIN`. |
| `wrangler.jsonc` | Worker config: the `workers.dev` route, the VPC service binding, and the static assets. |
| `deploy.sh` | Copies the models from `../server/web/hands` into `public/`, records the ETag the server gives each in `src/etags.json`, and deploys. |
| `tunnel.sh` | Runs `cloudflared` for the named tunnel `roomie` over HTTP/2. Reads the token from `~/.cloudflared/roomie.token`. |

The path from the Worker to the Mac: VPC service `roomie-origin` → named tunnel `roomie` → `127.0.0.1:8780`. No public hostname and no open port on the Mac.

Secrets stay out of this folder: the tunnel token lives in `~/.cloudflared/`, and `wrangler` uses its own login.
