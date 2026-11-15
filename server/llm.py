"""The model behind Emma. Gemini when GEMINI_API_KEY is set (in the environment or in server/.env),
otherwise one-shot `claude -p` calls on the subscription. Either way: a prompt in, a JSON object out.

    out = await ask("... Reply with JSON only: {...}")

Standard library only.
"""
import asyncio
import json
import os
import re
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
LIMIT = 8                      # calls in flight at once
_gate = None


def load_env(path=os.path.join(HERE, ".env")):
    try:
        with open(path) as f:
            for line in f:
                k, eq, v = line.strip().partition("=")
                if eq and k and not k.startswith("#"):
                    os.environ.setdefault(k.strip(), v.strip().strip("\"'"))
    except OSError:
        pass


load_env()
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("ROOMIE_GEMINI_MODEL", "gemini-flash-latest")
CLAUDE_MODEL = os.environ.get("ROOMIE_MODEL", "haiku")
ENGINE = f"gemini ({GEMINI_MODEL})" if GEMINI_KEY else f"claude -p ({CLAUDE_MODEL})"


def _json(text, err=""):
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise RuntimeError(f"no JSON from model: {text[:200]!r} {err[:200]!r}")
    return json.loads(m.group(0))


def _gemini(prompt, timeout):
    req = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent",
        data=json.dumps({"contents": [{"parts": [{"text": prompt}]}],
                         "generationConfig": {"responseMimeType": "application/json"}}).encode(),
        headers={"content-type": "application/json", "x-goog-api-key": GEMINI_KEY})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"gemini {e.code}: {e.read()[:300].decode(errors='replace')}")
    parts = ((d.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
    return _json("".join(p.get("text", "") for p in parts), json.dumps(d)[:200])


async def _claude(prompt, timeout):
    env = dict(os.environ, CLAUDE_CODE_DISABLE_CLAUDE_MDS="1")
    for k in ("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"):
        env.pop(k, None)
    proc = await asyncio.create_subprocess_exec(
        "claude", "-p", "--model", CLAUDE_MODEL, "--strict-mcp-config", "--tools", "", "--output-format", "text",
        prompt, cwd=HERE, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError("model timed out")
    return _json(out.decode(), err.decode())


async def ask(prompt, timeout=40):
    global _gate
    if _gate is None:
        _gate = asyncio.Semaphore(LIMIT)
    async with _gate:
        if GEMINI_KEY:
            return await asyncio.get_event_loop().run_in_executor(None, _gemini, prompt, timeout)
        return await _claude(prompt, timeout)
