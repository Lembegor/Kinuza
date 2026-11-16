import html
import json
import re

SITE = "https://kinuza.channeluza.com"
IMAGES = f"{SITE}/kinuza/i/t/p"
DOWNLOAD = "https://github.com/Lembegor/Kinuza/releases/latest"
LANGUAGES = ("ru", "uk", "en")

TEXTS = {
    "ru": {
        "invite.title": "Приглашение в друзья",
        "invite.text": "Вас зовут в друзья в Kinuza. Откройте приглашение в приложении - заявка отправится в один клик, и вы будете видеть, кто что смотрит.",
        "invite.code": "Код друга:",
        "invite.badge": "Приглашение из Kinuza",
        "open": "Открыть в Kinuza",
        "download": "Скачать Kinuza",
        "movie": "Фильм",
        "tv": "Сериал",
        "opening": "Открываем Kinuza…",
        "asked": "Браузер спросит, можно ли открыть Kinuza - разрешите. Чтобы не спрашивал каждый раз, отметьте «Всегда разрешать».",
        "safari": "Нажмите «Открыть в Kinuza», и браузер предложит открыть приложение.",
        "missing": "Не открылось? Скорее всего, Kinuza ещё не установлена - скачайте её, это бесплатно.",
        "shared": "С вами поделились из Kinuza",
        "unknown": "Этот фильм или сериал не нашёлся, но его можно открыть в Kinuza.",
        "tagline": "Kinuza - фильмы, сериалы и аниме в одном приложении",
    },
    "uk": {
        "invite.title": "Запрошення в друзі",
        "invite.text": "Вас кличуть у друзі в Kinuza. Відкрийте запрошення в застосунку - заявка надішлеться в один клік, і ви бачитимете, хто що дивиться.",
        "invite.code": "Код друга:",
        "invite.badge": "Запрошення з Kinuza",
        "open": "Відкрити в Kinuza",
        "download": "Завантажити Kinuza",
        "movie": "Фільм",
        "tv": "Серіал",
        "opening": "Відкриваємо Kinuza…",
        "asked": "Браузер запитає, чи можна відкрити Kinuza - дозвольте. Щоб не питав щоразу, позначте «Завжди дозволяти».",
        "safari": "Натисніть «Відкрити в Kinuza», і браузер запропонує відкрити застосунок.",
        "missing": "Не відкрилося? Найімовірніше, Kinuza ще не встановлена - завантажте її, це безкоштовно.",
        "shared": "З вами поділилися з Kinuza",
        "unknown": "Цей фільм чи серіал не знайшовся, але його можна відкрити в Kinuza.",
        "tagline": "Kinuza - фільми, серіали та аніме в одному застосунку",
    },
    "en": {
        "invite.title": "Friend invite",
        "invite.text": "You are invited to be friends in Kinuza. Open the invite in the app - the request goes out in one click, and you will see what each other watches.",
        "invite.code": "Friend code:",
        "invite.badge": "An invite from Kinuza",
        "open": "Open in Kinuza",
        "download": "Download Kinuza",
        "movie": "Film",
        "tv": "TV show",
        "opening": "Opening Kinuza…",
        "asked": "Your browser will ask whether it may open Kinuza - allow it. Tick \"Always allow\" so it stops asking.",
        "safari": "Press \"Open in Kinuza\" and your browser will offer to open the app.",
        "missing": "Didn't open? Kinuza is probably not installed yet - download it, it's free.",
        "shared": "Shared with you from Kinuza",
        "unknown": "This film or show was not found, but you can open it in Kinuza.",
        "tagline": "Kinuza - films, shows and anime in one app",
    },
}


def pick_language(header: str) -> str:
    best, best_weight = "ru", -1.0
    for part in (header or "").split(","):
        piece = part.strip().split(";")
        code = piece[0].strip().lower()[:2]
        weight = 1.0
        for extra in piece[1:]:
            name, _, value = extra.strip().partition("=")
            if name == "q":
                try:
                    weight = float(value)
                except ValueError:
                    weight = 0.0
        if code in LANGUAGES and weight > best_weight:
            best, best_weight = code, weight
    return best


def deep_link(kind: str, ident: int, season: int | None, episode: int | None) -> str:
    link = f"kinuza://title/{kind}/{ident}"
    if kind == "tv" and season is not None:
        link += f"?s={season}"
        if episode is not None:
            link += f"&e={episode}"
    return link


def shorten(text: str, limit: int) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0]
    return cut.rstrip(",.;:-") + "…"


def image(path: str, size: str) -> str:
    return f"{IMAGES}/{size}{path}" if path and re.fullmatch(r"/[A-Za-z0-9_\-]+\.(jpg|jpeg|png|webp)", path) else ""


def render(info: dict | None, kind: str, ident: int, language: str, season: int | None, episode: int | None, nonce: str) -> str:
    words = TEXTS[language]
    link = deep_link(kind, ident, season, episode)
    page_url = f"{SITE}/t/{kind}/{ident}"
    if info:
        name = info["title"]
        heading = name + (f" ({info['year']})" if info.get("year") else "")
        description = shorten(info.get("overview", ""), 300) or words["tagline"]
        poster = image(info.get("poster", ""), "w500")
        backdrop = image(info.get("backdrop", ""), "w1280")
        meta_line = " · ".join(part for part in [words[kind], info.get("year", ""), info.get("original", "") if info.get("original") != name else ""] if part)
    else:
        name = "Kinuza"
        heading = "Kinuza"
        description = words["unknown"]
        poster = ""
        backdrop = ""
        meta_line = ""
    return document(language, words, link, page_url, heading, name, description, poster, backdrop, meta_line, words["shared"], "video.movie" if kind == "movie" else "video.tv_show", nonce, bool(info))


def render_invite(code: str, language: str, nonce: str) -> str:
    words = TEXTS[language]
    link = f"kinuza://friend/{code}"
    pretty = f"{code[:4]}-{code[4:]}" if len(code) > 4 else code
    return document(language, words, link, f"{SITE}/f/{code}", words["invite.title"], words["invite.title"], words["invite.text"], "", "", f'{words["invite.code"]} {pretty}', words["invite.badge"], "website", nonce, True)


def document(language: str, words: dict, link: str, page_url: str, heading: str, name: str, description: str, poster: str, backdrop: str, meta_line: str, badge: str, og_type: str, nonce: str, known: bool) -> str:
    escape = html.escape
    poster_block = f'<img class="poster" src="{escape(poster)}" alt="">' if poster else '<div class="poster poster--empty">K</div>'
    backdrop_style = f" style=\"background-image:url('{escape(backdrop)}')\"" if backdrop else ""
    script_texts = json.dumps({"link": link, "asked": words["asked"], "safari": words["safari"], "missing": words["missing"], "opening": words["opening"]}, ensure_ascii=False)
    return f"""<!doctype html>
<html lang="{language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{escape(heading + ' - Kinuza' if known else 'Kinuza')}</title>
<meta name="description" content="{escape(description)}">
<meta property="og:site_name" content="Kinuza">
<meta property="og:type" content="{og_type}">
<meta property="og:title" content="{escape(heading)}">
<meta property="og:description" content="{escape(description)}">
<meta property="og:url" content="{escape(page_url)}">
{f'<meta property="og:image" content="{escape(poster)}">' if poster else ''}
<meta name="twitter:card" content="summary">
<meta name="robots" content="noindex">
<style>
:root {{ color-scheme: dark; }}
* {{ box-sizing: border-box; }}
body {{ margin: 0; min-height: 100vh; font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; background: #0e0e13; color: #f2f2f5; }}
.backdrop {{ position: fixed; inset: 0; background-size: cover; background-position: center; filter: blur(28px) brightness(0.35); transform: scale(1.1); }}
.shade {{ position: fixed; inset: 0; background: linear-gradient(180deg, rgba(14,14,19,0.4), #0e0e13 85%); }}
main {{ position: relative; max-width: 860px; margin: 0 auto; padding: 56px 24px; display: flex; gap: 36px; align-items: flex-start; }}
.poster {{ width: 240px; flex: none; border-radius: 16px; box-shadow: 0 24px 60px rgba(0,0,0,0.6); aspect-ratio: 2 / 3; object-fit: cover; }}
.poster--empty {{ display: grid; place-items: center; background: #1d1d25; font-size: 64px; font-weight: 800; color: #e5484d; }}
.shared {{ display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: #b9b9c6; margin-bottom: 14px; }}
.dot {{ width: 10px; height: 10px; border-radius: 50%; background: #e5484d; }}
h1 {{ margin: 0 0 8px; font-size: 34px; line-height: 1.15; }}
.meta {{ color: #a3a3b2; font-size: 15px; margin-bottom: 18px; }}
.overview {{ color: #d4d4dc; line-height: 1.55; margin: 0 0 26px; }}
.actions {{ display: flex; flex-wrap: wrap; gap: 12px; }}
.button {{ display: inline-flex; align-items: center; justify-content: center; height: 48px; padding: 0 22px; border-radius: 12px; font-size: 16px; font-weight: 600; text-decoration: none; border: 1px solid rgba(255,255,255,0.14); color: #f2f2f5; background: rgba(255,255,255,0.06); }}
.button--primary {{ background: #e5484d; border-color: #e5484d; color: #fff; }}
.button:hover {{ filter: brightness(1.1); }}
.note {{ margin-top: 18px; font-size: 14px; color: #a3a3b2; min-height: 20px; line-height: 1.5; }}
.note.is-warn {{ color: #f5c26b; }}
footer {{ position: relative; text-align: center; color: #6f6f7d; font-size: 13px; padding: 0 24px 32px; }}
@media (max-width: 640px) {{ main {{ flex-direction: column; align-items: center; text-align: center; padding-top: 32px; }} .poster {{ width: 180px; }} .actions {{ justify-content: center; }} }}
</style>
</head>
<body>
<div class="backdrop"{backdrop_style}></div>
<div class="shade"></div>
<main>
{poster_block}
<div>
<div class="shared"><span class="dot"></span>{escape(badge)}</div>
<h1>{escape(name)}</h1>
{f'<div class="meta">{escape(meta_line)}</div>' if meta_line else ''}
<p class="overview">{escape(description)}</p>
<div class="actions">
<a class="button button--primary" id="open" href="{escape(link)}">{escape(words["open"])}</a>
<a class="button" href="{DOWNLOAD}" rel="noopener">{escape(words["download"])}</a>
</div>
<div class="note" id="note"></div>
</div>
</main>
<footer>{escape(words["tagline"])}</footer>
<script nonce="{nonce}">
(function () {{
  var texts = {script_texts};
  var note = document.getElementById("note");
  var agent = navigator.userAgent;
  var safari = /Safari\\//.test(agent) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox/.test(agent);
  var left = false;
  window.addEventListener("blur", function () {{ left = true; }});
  document.addEventListener("visibilitychange", function () {{ if (document.hidden) left = true; }});
  var check = function () {{
    setTimeout(function () {{
      if (!left && document.hasFocus()) {{ note.textContent = texts.missing; note.className = "note is-warn"; }}
    }}, 3500);
  }};
  document.getElementById("open").addEventListener("click", function () {{ left = false; note.textContent = texts.asked; note.className = "note"; check(); }});
  if (safari) {{ note.textContent = texts.safari; return; }}
  note.textContent = texts.opening;
  setTimeout(function () {{ note.textContent = texts.asked; window.location.href = texts.link; check(); }}, 500);
}})();
</script>
</body>
</html>
"""
