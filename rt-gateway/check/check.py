import asyncio, json, os, random, time, urllib.parse
from datetime import datetime
from playwright.async_api import async_playwright

INTERVAL = int(os.environ.get("CHECK_EVERY", "1200"))
QUERIES = ["Интерстеллар", "Атака титанов", "Breaking Bad", "Дюна 2021", "Шрек", "Остаться в живых", "Наруто", "Матрица"]
LOG = "/log/checks.jsonl"

def classify(title, html):
    if "Just a moment" in title or "cf-turnstile" in html or "challenge-platform" in html[:30000] and "tor-tbl" not in html:
        return "challenge"
    if "tor-tbl" in html:
        return "ok"
    if "login_username" in html or "login-form" in html:
        return "login"
    return "unknown"

async def check(p, query):
    started = time.time()
    try:
        browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9222", timeout=15000)
        context = browser.contexts[0]
        page = await context.new_page()
        try:
            await page.goto("https://rutracker.org/forum/tracker.php?nm=" + urllib.parse.quote(query), timeout=30000)
            status = "unknown"
            for _ in range(15):
                status = classify(await page.title(), await page.content())
                if status != "unknown":
                    break
                await asyncio.sleep(1)
            rows = await page.locator("#tor-tbl tbody tr").count() if status == "ok" else 0
        finally:
            await page.close()
        return {"status": status, "rows": rows}
    except Exception as error:
        if "ECONNREFUSED" in str(error):
            raise SystemExit(1)
        return {"status": "error", "error": type(error).__name__ + ": " + str(error)[:120]}
    finally:
        pass

async def main():
    async with async_playwright() as p:
        while True:
            query = random.choice(QUERIES)
            started = time.time()
            result = await check(p, query)
            result.update({"at": datetime.now().isoformat(timespec="seconds"), "query": query, "seconds": round(time.time() - started, 1)})
            with open(LOG, "a", encoding="utf-8") as file:
                file.write(json.dumps(result, ensure_ascii=False) + "\n")
            print(json.dumps(result, ensure_ascii=False), flush=True)
            await asyncio.sleep(INTERVAL)

asyncio.run(main())
