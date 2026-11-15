"""Renders stills of Emma's hands (web/hands/tools/icon_hands.html) for icon concepts, as transparent 1024 px PNGs.

    python3 tools/icon_hands.py <out_dir> [concept ...]      (serve web/ on :8780 first: python3 -m http.server 8780 -d web)
"""
import asyncio, base64, json, os, sys
from playwright.async_api import async_playwright

PAGE = "http://localhost:8780/hands/tools/icon_hands.html"
CONCEPTS = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon_concepts.json")))


async def main(out, names):
    os.makedirs(out, exist_ok=True)
    async with async_playwright() as p:
        b = await p.webkit.launch()
        pg = await b.new_page(viewport={"width": 400, "height": 400})
        pg.on("console", lambda m: m.type in ("error", "warning") and print("page:", m.text))
        await pg.goto(PAGE)
        await pg.wait_for_function("window.ready === true", timeout=60000)
        for n in names or CONCEPTS:
            url = await pg.evaluate("s => render(s)", CONCEPTS[n])
            open(os.path.join(out, f"{n}.png"), "wb").write(base64.b64decode(url.split(",", 1)[1]))
            print("wrote", os.path.join(out, f"{n}.png"))
        await b.close()

asyncio.run(main(sys.argv[1], sys.argv[2:]))
