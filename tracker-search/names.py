import html
import re

LANGUAGES = {
    "русск": "Rus",
    "украин": "Ukr",
    "англ": "Eng",
    "япон": "Jap",
    "корей": "Kor",
    "китай": "Chi",
    "француз": "Fre",
    "немец": "Ger",
    "испан": "Spa",
    "итальян": "Ita",
    "белорус": "Bel",
    "казах": "Kaz",
    "польск": "Pol",
    "турец": "Tur",
    "португал": "Por",
    "хинди": "Hin",
    "russian": "Rus",
    "ukrainian": "Ukr",
    "english": "Eng",
    "japanese": "Jap",
    "korean": "Kor",
    "chinese": "Chi",
    "french": "Fre",
    "german": "Ger",
    "spanish": "Spa",
    "italian": "Ita",
}
ISO_TO_SHORT = {
    "ru": "Rus", "uk": "Ukr", "en": "Eng", "ja": "Jap", "ko": "Kor", "zh": "Chi", "fr": "Fre", "de": "Ger",
    "es": "Spa", "it": "Ita", "be": "Bel", "kk": "Kaz", "pl": "Pol", "tr": "Tur", "pt": "Por", "hi": "Hin",
}
KINDS = [
    (re.compile(r"\bdub\b|дубл", re.I), "Dub"),
    (re.compile(r"\bmvo\b|многоголос", re.I), "MVO"),
    (re.compile(r"\bdvo\b|двухголос|двуголос", re.I), "DVO"),
    (re.compile(r"\bavo\b|авторск", re.I), "AVO"),
    (re.compile(r"\bvo\b|одноголос|закадров", re.I), "VO"),
]
SOURCE_TYPES = re.compile(
    r"\b(UHD\s+BDRemux|BDRemux|Remux|UHD\s+BDRip|BDRip(?:-AVC|-HEVC)?|Blu-?Ray|UHD\s+WEB-DLRip|UHD\s+WEB-DL|"
    r"WEB-DLRip(?:-AVC)?|WEB-DL|WEBRip|HDRip(?:-AVC)?|HDTVRip|HDTV|DVDRip|DVD9|DVD5|TVRip|SATRip|CAMRip)\b",
    re.I,
)
RESOLUTION = re.compile(r"\b(2160|1440|1080|720|576|480)[pi]\b", re.I)
YEAR_GROUP = re.compile(r"\((\d{4})(?:\s*[-–]\s*(\d{4}))?\)")
VIDEO_CODECS = [
    (re.compile(r"\bav1\b", re.I), "AV1"),
    (re.compile(r"h\.?265|hevc|x265", re.I), "HEVC"),
    (re.compile(r"h\.?264|\bavc\b|x264", re.I), "AVC"),
]
AGE_MARK = re.compile(r"\s*\(?\b\d{1,2}\+\)?")
NOT_STUDIO = re.compile(r"^(?:профессиональн|любительск|закадров|полное|полный|ch\b|kbps|\d)", re.I)
AUDIO_LINE = re.compile(r"(?:Аудио|Aудио|Audio)\s*#?\s*\d*\s*:", re.I)


def human_size(size: int) -> str:
    if size >= 1024 ** 3:
        return f"{size / 1024 ** 3:.2f} GB"
    if size >= 1024 ** 2:
        return f"{size / 1024 ** 2:.1f} MB"
    return f"{max(size, 0) / 1024:.0f} KB"


def size_bytes(text: str) -> int:
    found = re.search(r"([\d.,]+)\s*(TB|GB|MB|KB)", text or "", re.I)
    if not found:
        return 0
    value = float(found.group(1).replace(",", "."))
    return int(value * {"TB": 1024 ** 4, "GB": 1024 ** 3, "MB": 1024 ** 2, "KB": 1024}[found.group(2).upper()])


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(text or "")).strip().strip("|").strip()


def short_language(text: str) -> str:
    low = text.lower()
    for stem, short in LANGUAGES.items():
        if stem in low:
            return short
    return ""


def kind_of(text: str) -> str:
    for pattern, kind in KINDS:
        if pattern.search(text):
            return kind
    if re.search(r"оригинал|original", text, re.I):
        return "Original"
    return ""


def codec_of(text: str) -> str:
    for pattern, name in VIDEO_CODECS:
        if pattern.search(text):
            return name
    return ""


def source_label(text: str) -> str:
    found = SOURCE_TYPES.search(text or "")
    if not found:
        return ""
    label = re.sub(r"\s+", " ", found.group(1))
    return "BDRip" if re.fullmatch(r"blu-?ray", label, re.I) else label


def resolution_of(text: str) -> str:
    found = RESOLUTION.search(text or "")
    return f"{found.group(1)}p" if found else ""


def split_outside(text: str) -> list:
    return [part.strip() for part in re.split(r"[,;](?![^()\[\]]*[)\]])", text) if part.strip()]


def studios_in(text: str) -> list:
    found = []
    for group in re.findall(r"[(\[]([^()\[\]]*)[)\]]", text):
        for part in split_outside(group):
            part = clean(AGE_MARK.sub("", part))
            if not part or kind_of(part) or short_language(part) or NOT_STUDIO.search(part):
                continue
            if part not in found:
                found.append(part)
    return found


def voice_tracks(voices: list, original_language: str) -> list:
    original = ISO_TO_SHORT.get((original_language or "").lower(), "")
    groups: dict = {}
    order: list = []
    for voice in voices:
        language = voice.get("language") or "Rus"
        kind = voice.get("kind") or ""
        studio = clean(voice.get("studio") or "")
        if kind == "Original" or (language != "Rus" and language == original and kind in ("", "Dub")):
            key = ("Original", language)
        else:
            key = (kind, language)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(studio)
    russian = [key for key in order if key[1] == "Rus" and key[0] != "Original"]
    others = [key for key in order if key[1] != "Rus" and key[0] != "Original"]
    originals = [key for key in order if key[0] == "Original"]
    tracks = []
    for kind, language in russian + others + originals:
        if kind == "Original":
            tracks.append(f"Original ({language})")
            continue
        studios = []
        for name in groups[(kind, language)]:
            if name and name not in studios:
                studios.append(name)
        details = ([language] if language != "Rus" else []) + studios
        inner = f" ({', '.join(details)})" if details else ""
        if kind:
            tracks.append(f"{len(studios)}x {kind}{inner}" if len(studios) > 1 else f"{kind}{inner}")
        else:
            tracks.append(f"({', '.join(details) or language})")
    return tracks


def subtitle_track(languages: list) -> str:
    unique = []
    for language in languages:
        if language and language not in unique:
            unique.append(language)
    return f"Sub ({', '.join(unique)})" if unique else ""


def compose(head: str, scope: str, director: str, years: str, source: str, resolution: str, tags: list, tracks: list) -> str:
    quality = " ".join(part for part in [source, resolution] if part)
    details = ", ".join(part for part in [years, quality] if part)
    title = head.strip()
    if scope:
        title += f" / {scope}"
    if director:
        title += f" ({director})"
    title += f" [{details}]"
    for tag in tags:
        if tag:
            title += f" [{tag}]"
    if tracks:
        title += " " + " + ".join(tracks)
    return clean(title)


def episode_scope(season_first, season_last, first, last, total) -> str:
    parts = []
    if season_first:
        parts.append(f"Сезон: {season_first}" + (f"-{season_last}" if season_last and season_last != season_first else ""))
    if first:
        parts.append(f"Серии: {first}-{last or first} из {total if total else '?'}")
    return " / ".join(parts)


def valid_hash(value: str) -> str:
    value = (value or "").lower()
    return value if re.fullmatch(r"[0-9a-f]{40}", value) else ""


def yts_items(movie: dict, original_language: str, page: str) -> list:
    items = []
    title = clean(movie.get("title") or "")
    english = clean(movie.get("title_english") or title)
    year = str(movie.get("year") or "")
    head = title if english.lower() == title.lower() else f"{title} / {english}"
    spoken = ISO_TO_SHORT.get((original_language or movie.get("language") or "en").lower(), "Eng")
    for torrent in movie.get("torrents") or []:
        quality = str(torrent.get("quality") or "")
        info_hash = valid_hash(str(torrent.get("hash") or ""))
        if not re.fullmatch(r"\d{3,4}p", quality) or not info_hash:
            continue
        source = "BDRip" if torrent.get("type") == "bluray" else "WEBRip"
        codec = "HEVC" if "265" in str(torrent.get("video_codec") or "") else "AVC"
        tags = [codec] + (["10-bit"] if str(torrent.get("bit_depth") or "") == "10" else [])
        channels = str(torrent.get("audio_channels") or "")
        size = int(torrent.get("size_bytes") or 0)
        items.append({
            "source": "yts",
            "id": info_hash,
            "title": compose(f"{head} ({year})", "", "", year, source, quality, tags, [f"Original ({spoken})"]),
            "name": " ".join(part for part in [f"{english} ({year})", quality, source, codec, channels] if part),
            "size": human_size(size),
            "sizeBytes": size,
            "seeds": int(torrent.get("seeds") or 0),
            "leeches": int(torrent.get("peers") or 0),
            "infoHash": info_hash,
            "magnet": "",
            "page": page,
            "torrent": str(torrent.get("url") or ""),
            "minutes": int(movie.get("runtime") or 0),
        })
    return items


EZTV_PACK = re.compile(r"\bS(\d{1,2})(?!\s*E\d)\b", re.I)


def eztv_source(text: str) -> str:
    if re.search(r"web-?dl|\bweb\b", text, re.I):
        return "WEB-DL"
    if re.search(r"webrip", text, re.I):
        return "WEBRip"
    if re.search(r"bluray|bdrip|brrip", text, re.I):
        return "BDRip"
    if re.search(r"hdtv", text, re.I):
        return "HDTV"
    return "WEB-DL"


def plain_name(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower().replace("&", "and")).strip()


def same_show(name: str, shows: list) -> bool:
    plain = plain_name(name)
    plain = re.sub(r"^the ", "", plain)
    for show in shows:
        wanted = re.sub(r"^the ", "", plain_name(show))
        if wanted and (plain == wanted or plain.startswith(wanted + " ")):
            return True
    return False


def eztv_items(torrents: list, show: str, original_language: str, season, episode, shows: list | None = None) -> list:
    items = []
    spoken = ISO_TO_SHORT.get((original_language or "en").lower(), "Eng")
    known = [name for name in (shows or [show]) if name]
    for torrent in torrents:
        try:
            item_season = int(torrent.get("season") or 0)
            item_episode = int(torrent.get("episode") or 0)
        except ValueError:
            continue
        name = clean(torrent.get("title") or torrent.get("filename") or "")
        if item_season <= 0 or (season is not None and item_season != season):
            continue
        if not same_show(name, known):
            continue
        pack = item_episode == 0
        if pack and not EZTV_PACK.search(name):
            continue
        if not pack and episode is not None and item_episode != episode:
            continue
        info_hash = valid_hash(str(torrent.get("hash") or ""))
        magnet = str(torrent.get("magnet_url") or "")
        if not info_hash or not magnet.startswith("magnet:"):
            continue
        codec = codec_of(name)
        scope = episode_scope(item_season, None, None if pack else item_episode, None if pack else item_episode, None)
        size = int(torrent.get("size_bytes") or 0)
        items.append({
            "source": "eztv",
            "id": info_hash,
            "title": compose(show, scope, "", "", eztv_source(name), resolution_of(name) or "480p", [codec] if codec else [], [f"Original ({spoken})"]),
            "name": name,
            "size": human_size(size),
            "sizeBytes": size,
            "seeds": int(torrent.get("seeds") or 0),
            "leeches": int(torrent.get("peers") or 0),
            "infoHash": info_hash,
            "magnet": magnet,
            "page": f"https://eztvx.to/ep/{torrent.get('id')}/",
            "torrent": "",
            "season": item_season,
            "episodeFirst": 0 if pack else item_episode,
            "episodeLast": 0 if pack else item_episode,
        })
    return items


NNM_CATEGORY = re.compile(r'<a class="gen" href="tracker\.php\?f=\d+[^"]*">([^<]*)</a>')
NNM_TOPIC = re.compile(r'topictitle" href="viewtopic\.php\?t=(\d+)"><b>(.*?)</b>', re.S)
NNM_DOWNLOAD = re.compile(r'href="download\.php\?id=(\d+)"')
NNM_SIZE = re.compile(r"</u>\s*([\d.,]+\s*(?:TB|GB|MB|KB))", re.I)
NNM_SEEDS = re.compile(r'class="seedmed"><b>(\d+)')
NNM_LEECHES = re.compile(r'class="leechmed"><b>(\d+)')
NNM_VIDEO_CATEGORY = re.compile(
    r"фильм|сериал|мульт|аниме|кино|документ|марвел|marvel|dc comics|breaking bad|хит|новинк|театр|концерт|шоу|спорт|архив", re.I
)


def nnm_rows(page: str) -> list:
    rows = []
    for chunk in re.split(r'<tr class="prow[12]">', page)[1:]:
        chunk = chunk.split("</tr>", 1)[0]
        topic = NNM_TOPIC.search(chunk)
        seeds = NNM_SEEDS.search(chunk)
        if not topic or not seeds:
            continue
        category_match = NNM_CATEGORY.search(chunk)
        category = clean(category_match.group(1)) if category_match else ""
        title = clean(re.sub(r"<[^>]+>", "", topic.group(2)))
        if not NNM_VIDEO_CATEGORY.search(category) and not source_label(title):
            continue
        download = NNM_DOWNLOAD.search(chunk)
        size = NNM_SIZE.search(chunk)
        leeches = NNM_LEECHES.search(chunk)
        rows.append({
            "topic": topic.group(1),
            "category": category,
            "title": title,
            "download": download.group(1) if download else "",
            "size": clean(size.group(1)) if size else "",
            "seeds": int(seeds.group(1)),
            "leeches": int(leeches.group(1)) if leeches else 0,
        })
    return rows


def topic_text(page: str) -> str:
    start = page.find("postbody")
    body = page[page.find(">", start) + 1:] if start >= 0 else page
    body = re.sub(r"<br\s*/?>", "\n", body, flags=re.I)
    body = re.sub(r"</(?:div|p|li|tr)>", "\n", body, flags=re.I)
    body = re.sub(r"<[^>]+>", "", body)
    return html.unescape(body)


def audio_voice(line: str):
    if re.search(r"коммент|comment", line, re.I):
        return None
    spoken = line
    for separator in (" - ", " | ", "|"):
        if separator in line:
            spoken = line.split(separator, 1)[1]
            break
    language = short_language(spoken) or short_language(line)
    if not language:
        return None
    studios = studios_in(spoken)
    if not studios:
        bare = re.sub(r"[(\[][^()\[\]]*[)\]]", " ", spoken)
        for part in split_outside(bare)[1:]:
            part = clean(AGE_MARK.sub("", part))
            if part and not kind_of(part) and not short_language(part) and not NOT_STUDIO.search(part):
                studios.append(part)
    return {"language": language, "kind": kind_of(spoken), "studio": ", ".join(studios)}


def translation_voices(text: str) -> list:
    voices = []
    grouped = re.findall(r"([^()]*)\(([^()]*)\)", text)
    parts = [(prefix, f"({inner})") for prefix, inner in grouped] if grouped else [(part, part) for part in split_outside(text)]
    for prefix, part in parts:
        kind = kind_of(prefix) or kind_of(part)
        studios = studios_in(part)
        if not kind and not studios:
            continue
        for studio in studios or [""]:
            voices.append({"language": "Rus", "kind": kind, "studio": studio})
    return voices


def nnm_details(page: str) -> dict:
    found = re.search(r"magnet:\?xt=urn:btih:([0-9A-Fa-f]{40})", page)
    lines = [clean(line) for line in topic_text(page).split("\n")]
    audio = []
    spoken_languages = []
    spoken_studios = []
    translation = []
    subtitles = []
    director = ""
    minutes = 0
    for line in lines:
        if not line:
            continue
        if AUDIO_LINE.match(line):
            for piece in AUDIO_LINE.split(line)[1:]:
                voice = audio_voice(piece)
                if voice:
                    audio.append(voice)
            continue
        spoken = re.match(r"^Язык озвучки\s*:\s*(.+)$", line, re.I)
        if spoken and not spoken_languages:
            for part in split_outside(spoken.group(1)):
                language = short_language(part)
                if language and language not in spoken_languages:
                    spoken_languages.append(language)
            kind = kind_of(spoken.group(1))
            for studio in studios_in(spoken.group(1)):
                spoken_studios.append({"language": "Rus", "kind": kind, "studio": studio})
            continue
        stated = re.match(r"^(?:Перевод|Озвучивание|Озвучка)\s*\d*\s*:\s*(.+)$", line, re.I)
        if stated and not translation:
            translation = translation_voices(stated.group(1))
            continue
        listed = re.match(r"^(?:Субтитры|Язык субтитров)\s*:\s*(.+)$", line, re.I)
        if listed and not subtitles:
            for part in split_outside(listed.group(1)):
                language = short_language(part)
                if language and language not in subtitles and not re.search(r"надпис", part, re.I):
                    subtitles.append(language)
            continue
        made = re.match(r"^Режисс[её]р\s*:\s*(.+)$", line, re.I)
        if made and not director:
            director = made.group(1).split(",")[0].strip()[:60]
            continue
        long = re.match(r"^Продолжительность\s*:\s*(?:~\s*)?(\d{1,2}):(\d{2})", line, re.I)
        if long and not minutes:
            minutes = int(long.group(1)) * 60 + int(long.group(2))
    spoken_by = {voice["studio"].lower(): voice["language"] for voice in audio if voice["studio"]}
    for voice in translation:
        language = spoken_by.get(voice["studio"].lower())
        if language:
            voice["language"] = language
    russian_audio = [voice for voice in audio if voice["language"] == "Rus" and (voice["kind"] or voice["studio"])]
    if translation:
        russian = translation
    elif spoken_studios:
        russian = spoken_studios
    elif russian_audio:
        russian = russian_audio
    elif "Rus" in spoken_languages or any(voice["language"] == "Rus" for voice in audio):
        russian = [{"language": "Rus", "kind": "", "studio": ""}]
    else:
        russian = []
    named = {voice["studio"].lower() for voice in russian if voice["studio"]}
    others = [voice for voice in audio if voice["language"] != "Rus" and voice["studio"].lower() not in named]
    for language in spoken_languages:
        if any(voice["language"] == language for voice in russian):
            continue
        if language != "Rus" and not any(voice["language"] == language for voice in others):
            others.append({"language": language, "kind": "", "studio": ""})
    return {
        "infoHash": found.group(1).lower() if found else "",
        "voices": russian + others,
        "subtitles": subtitles,
        "director": director,
        "minutes": minutes,
    }


NNM_SCOPE = re.compile(
    r"\(\s*сезон\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?(?:\s*из\s*\d+)?\s*,\s*(?:серии\s*)?(\d{1,4})(?:\s*[-–]\s*(\d{1,4}))?"
    r"\s*(?:серии\s*)?(?:из\s*(\d{1,4}|\?+))?[^)]*\)",
    re.I,
)
NNM_ANIME = re.compile(r"\[(\d{4})(?:\s*[-–]\s*\d{4})?,\s*(?:TV|ТВ|ONA|OVA|Movie|Фильм)([^\]]*)\]", re.I)
NNM_ANIME_RANGE = re.compile(r"(\d{1,4})(?:\s*[-–]\s*(\d{1,4}))?\s*(?:из\s*(\d{1,4}|\?+)|(эп))", re.I)
TITLE_VOICES = re.compile(r"\[\s*(dub|mvo|dvo|avo|vo)\s*\]", re.I)


def picture_tags(title: str) -> list:
    marks = []
    for group in re.findall(r"\[([^\]]*)\]", title):
        wanted = [part.strip() for part in group.split(",") if re.search(r"hdr|dolby vision|10-?\s?bit", part, re.I)]
        if wanted:
            marks.append(", ".join(wanted))
    codec = codec_of(title)
    return marks + ([codec] if codec else [])


def title_tracks(title: str, after: int) -> list:
    tail = re.split(r"\bsub\b|субтитр", SOURCE_TYPES.sub("", title[after:]), maxsplit=1, flags=re.I)[0]
    tail = re.sub(r"\[[^\]]*\]|\([^)]*\)", " ", tail)
    studios = [clean(name) for name in re.split(r",|\+", tail) if clean(name) and not re.match(r"^\d", clean(name))]
    stated = TITLE_VOICES.search(title)
    kind = ("Dub" if stated.group(1).lower() == "dub" else stated.group(1).upper()) if stated else ""
    if studios:
        return [f"{kind} ({', '.join(studios[:6])})".strip()]
    return [kind] if kind else []


def nnm_title(row: dict, details, original_language: str) -> str:
    title = row["title"]
    details = details or {}
    tracks = voice_tracks(details.get("voices") or [], original_language)
    resolution = resolution_of(title)
    source = source_label(title)
    tags = picture_tags(title)
    anime = NNM_ANIME.search(title)
    if anime:
        names = [clean(part) for part in title[: title.find("[")].split("|") if clean(part)]
        russian = next((name for name in reversed(names) if re.search(r"[а-яё]", name, re.I)), names[-1] if names else title)
        others = [name for name in names if name != russian]
        season = re.search(r"\[\s*ТВ-(\d{1,2})", title)
        head = russian + (f" (ТВ-{season.group(1)})" if season else "")
        if others:
            head += " / " + " / ".join(others[:2])
        counted = NNM_ANIME_RANGE.search(anime.group(2))
        scope = ""
        if counted:
            first = int(counted.group(1))
            last = int(counted.group(2)) if counted.group(2) else first
            total = counted.group(3) or ""
            if not counted.group(2) and first > 1 and (counted.group(4) or (total and int(total) == first)):
                first, last, total = 1, first, total or str(first)
            scope = f"Серии: {first}-{last} из {total or '?'}"
        if not tracks:
            spoken = title[anime.end():].lower()
            if "rus" in spoken:
                tracks.append("(Rus)")
            if "raw" in spoken or "jap" in spoken:
                tracks.append("Original (Jap)")
        subtitles = subtitle_track(details.get("subtitles") or [])
        return compose(head, scope, details.get("director", ""), anime.group(1), source, resolution, tags, tracks + ([subtitles] if subtitles else []))
    years = YEAR_GROUP.search(title)
    if years:
        head = clean(title[: years.start()])
        year_text = years.group(1) + (f"-{years.group(2)}" if years.group(2) else "")
    else:
        head = clean(SOURCE_TYPES.split(title, maxsplit=1)[0])
        year_text = ""
    scope_match = NNM_SCOPE.search(title)
    scope = ""
    if scope_match:
        season_first = int(scope_match.group(1))
        season_last = int(scope_match.group(2)) if scope_match.group(2) else None
        first = int(scope_match.group(3))
        last = int(scope_match.group(4)) if scope_match.group(4) else first
        total = scope_match.group(5) or ""
        if not scope_match.group(4) and total and total.isdigit() and int(total) == first and first > 1:
            first, last = 1, int(total)
        scope = episode_scope(season_first, season_last, first, last, total or None)
    if not tracks:
        tracks = title_tracks(title, scope_match.end() if scope_match else (years.end() if years else 0))
    subtitles = subtitle_track(details.get("subtitles") or [])
    if subtitles:
        tracks.append(subtitles)
    return compose(head, scope, details.get("director", ""), year_text, source, resolution, tags, tracks)


ANI_SEASON = re.compile(r"(?:\s(\d{1,2})$|(\d{1,2})(?:-?й)?\s*сезон|season\s*(\d{1,2})|(\d{1,2})(?:st|nd|rd|th)\s+season)", re.I)


def ani_items(release: dict, torrents: list, page: str) -> list:
    name = release.get("name") or {}
    main = clean(name.get("main") or "")
    english = clean(name.get("english") or "")
    year = str(release.get("year") or "")
    total = release.get("episodes_total") or None
    season = None
    for text in (main, english):
        found = ANI_SEASON.search(text)
        if found:
            season = next(int(group) for group in found.groups() if group)
            break
    head = main + (f" (ТВ-{season})" if season and season > 1 else "")
    if english and english.lower() != main.lower():
        head += f" / {english}"
    items = []
    for torrent in torrents:
        info_hash = valid_hash(str(torrent.get("hash") or ""))
        if not info_hash:
            continue
        numbers = re.match(r"^\s*(\d{1,4})(?:\s*[-–]\s*(\d{1,4}))?\s*$", str(torrent.get("description") or ""))
        first = int(numbers.group(1)) if numbers else None
        last = int(numbers.group(2)) if numbers and numbers.group(2) else first
        quality = str((torrent.get("quality") or {}).get("value") or "")
        source = str((torrent.get("type") or {}).get("value") or "WEBRip")
        codec = codec_of(str((torrent.get("codec") or {}).get("value") or ""))
        tracks = ["MVO (AniLiberty)", "Original (Jap)"] + (["Sub (Rus)"] if torrent.get("is_hardsub") else [])
        size = int(torrent.get("size") or 0)
        items.append({
            "source": "aniliberty",
            "id": str(torrent.get("id") or info_hash),
            "title": compose(head, f"Серии: {first}-{last} из {total or '?'}" if first else "", "", year, source, quality, [codec] if codec else [], tracks),
            "name": clean(torrent.get("label") or ""),
            "size": human_size(size),
            "sizeBytes": size,
            "seeds": int(torrent.get("seeders") or 0),
            "leeches": int(torrent.get("leechers") or 0),
            "infoHash": info_hash,
            "magnet": str(torrent.get("magnet") or ""),
            "page": page,
            "torrent": "",
            "mal": release.get("mal") or None,
        })
    return items


SUKEBEI_ITEM = re.compile(r"<item>(.*?)</item>", re.S)
SUKEBEI_TRACKERS = (
    "&tr=http%3A%2F%2Fsukebei.tracker.wf%3A8888%2Fannounce"
    "&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce"
    "&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce"
    "&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce"
)
SUKEBEI_EPISODES = re.compile(
    r"(?:\s[-–]\s|\s#|\sep(?:isode)?\.?\s?|\se)(\d{1,3})(?:\s*[-~–]\s*(\d{1,3}))?(?:v\d)?(?=[\s\[(]|$)", re.I
)
SUKEBEI_EXTRA = re.compile(r"\bpv\b|preview|trailer|teaser|\bcm\b|\bncop\b|\bnced\b|artbook|soundtrack|\bost\b", re.I)
SUKEBEI_SEASON = re.compile(r"\bS(\d{1,2})\b|\b(\d{1,2})(?:st|nd|rd|th)\s+season\b|\bseason\s*(\d{1,2})\b", re.I)


def rss_field(chunk: str, name: str) -> str:
    found = re.search(rf"<{name}>(.*?)</{name}>", chunk, re.S)
    return clean(re.sub(r"^<!\[CDATA\[|\]\]>$", "", found.group(1).strip())) if found else ""


def sukebei_head(title: str) -> tuple:
    text = re.sub(r"^\s*(?:\[[^\]]*\]\s*|\([^)]*\)\s*)+", "", title)
    text = re.sub(r"\.(?:mkv|mp4|avi)$", "", text, flags=re.I)
    plain = re.sub(r"\[[^\]]*\]|\([^)]*\)|（[^）]*）", " ", text)
    plain = re.sub(r"[~～_]+", " ", plain)
    plain = clean(re.split(r"\s+/\s+", clean(plain))[0])
    episodes = SUKEBEI_EPISODES.search(" " + plain)
    first = last = None
    if episodes:
        first = int(episodes.group(1))
        last = int(episodes.group(2)) if episodes.group(2) else first
        plain = (" " + plain)[: episodes.start()].strip()
    season_mark = SUKEBEI_SEASON.search(plain)
    season = next((int(group) for group in season_mark.groups() if group), None) if season_mark else None
    head = re.split(r"\s+[-–|]\s+|\s{2,}", plain)[0].strip(" -–:")
    head = re.sub(r"\s+(?:OVA|ONA|TV|Uncensored|Censored|Batch|Complete)\b.*$", "", head, flags=re.I).strip(" -–:")
    return head, first, last, season


def sukebei_items(rss: str, shows: list, season, episode) -> list:
    items = []
    known = [name for name in shows if name]
    for chunk in SUKEBEI_ITEM.findall(rss or ""):
        if rss_field(chunk, "nyaa:categoryId") not in ("1_1", ""):
            continue
        title = rss_field(chunk, "title")
        info_hash = valid_hash(rss_field(chunk, "nyaa:infoHash"))
        view = re.search(r"sukebei\.nyaa\.si/view/(\d+)", chunk)
        if not title or not info_hash or not view:
            continue
        if SUKEBEI_EXTRA.search(title):
            continue
        head, first, last, item_season = sukebei_head(title)
        if not head or (known and not same_show(head, known)):
            continue
        show = next((name for name in known if same_show(head, [name])), "")
        if show:
            rest = re.sub(r"^the ", "", plain_name(head))[len(re.sub(r"^the ", "", plain_name(show))):]
            numbers = re.match(r"^\s*(\d{1,3})(?:\s+(\d{1,3}))?(?:\s|$)", rest)
            if first is None and numbers and int(numbers.group(1)) >= 1:
                first = int(numbers.group(1))
                last = int(numbers.group(2)) if numbers.group(2) and int(numbers.group(2)) >= first else first
            head = show
        wanted_season = season if season else 1
        if item_season and item_season != wanted_season:
            continue
        if first and episode and not first <= episode <= (last or first):
            continue
        resolutions = [int(value) for value in RESOLUTION.findall(title)]
        resolution = f"{max(resolutions)}p" if resolutions else ""
        tracks = ["Original (Jap)"]
        if re.search(r"\brus(?:sian)?\b", title, re.I):
            tracks.append("Sub (Rus)")
        elif re.search(r"\beng(?:lish)?\b|softsub|subbed|\bsubs?\b", title, re.I):
            tracks.append("Sub (Eng)")
        scope = f"Серии: {first}-{last or first} из ?" if first else ""
        codec = codec_of(title)
        tags = ([codec] if codec else []) + ([] if first else ["TV"])
        size = size_bytes(re.sub(r"([KMGT])iB", r"\1B", rss_field(chunk, "nyaa:size")))
        ident = view.group(1)
        items.append({
            "source": "sukebei",
            "id": ident,
            "title": compose(head, scope, "", "", source_label(title) or eztv_source(title), resolution, tags, tracks),
            "name": title,
            "size": human_size(size),
            "sizeBytes": size,
            "seeds": int(rss_field(chunk, "nyaa:seeders") or 0),
            "leeches": int(rss_field(chunk, "nyaa:leechers") or 0),
            "infoHash": info_hash,
            "magnet": f"magnet:?xt=urn:btih:{info_hash}{SUKEBEI_TRACKERS}",
            "page": f"https://sukebei.nyaa.si/view/{ident}",
            "torrent": ident,
            "season": wanted_season if first else 0,
            "episodeFirst": first or 0,
            "episodeLast": (last or first) if first else 0,
        })
    return items
