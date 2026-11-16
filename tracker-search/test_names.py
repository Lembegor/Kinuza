import unittest

import names


ROW = (
    '<tr class="prow1"><td align="center"><a class="gen" href="tracker.php?f=954&nm=x">Зарубежные Новинки</a></td>'
    '<td><a class="genmed topictitle" href="viewtopic.php?t=1870807"><b>Локи / Loki (2023) WEB-DL [H.264/1080p] '
    "(сезон 2, серии 1-6 из 6) HDRezka, LostFilm</b></a></td>"
    '<td><a href="download.php?id=1418568" rel="nofollow">[ DL ]</a></td>'
    '<td class="gensmall"><u>1649276275</u> 23.8 GB</td><td class="seedmed"><b>16</b></td><td class="leechmed"><b>2</b></td></tr>'
)
BOOK = (
    '<tr class="prow2"><td><a class="gen" href="tracker.php?f=1">Программирование</a></td>'
    '<td><a class="genmed topictitle" href="viewtopic.php?t=5"><b>ASP.Net Core в действии (2024) [PDF]</b></a></td>'
    '<td class="gensmall"><u>1</u> 39.2 MB</td><td class="seedmed"><b>9</b></td><td class="leechmed"><b>0</b></td></tr>'
)


def topic(lines: list[str]) -> str:
    return '<div class="postbody">' + "<br>".join(lines) + "</div> magnet:?xt=urn:btih:" + "a" * 40


class NnmRows(unittest.TestCase):
    def test_video_rows_are_read_and_books_skipped(self):
        rows = names.nnm_rows("<table>" + ROW + BOOK + "</table>")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["topic"], "1870807")
        self.assertEqual(rows[0]["download"], "1418568")
        self.assertEqual(rows[0]["seeds"], 16)
        self.assertEqual(rows[0]["size"], "23.8 GB")


class NnmDetails(unittest.TestCase):
    def test_grouped_translation_line_keeps_kinds_and_languages(self):
        page = topic([
            "Перевод: дублированный неофициальный (Red Head Sound, Iron Voice) профессиональный многоголосый (LostFilm, Цікава Ідея)",
            "Язык озвучки: русский, украинский, английский",
            "Аудио01: AC3, 6 ch, 640 Kbps - Русский, Red Head Sound",
            "Аудио11: AC3, 6 ch, 448 Kbps - Украинский, Цікава Ідея",
            "Аудио13: AC3, 6 ch, 640 Kbps - Английский",
            "Субтитры: Русские (forced, full), английские",
            "Режиссер: Кейт Херрон",
            "Продолжительность: 00:50:12",
        ])
        details = names.nnm_details(page)
        self.assertEqual(details["infoHash"], "a" * 40)
        self.assertEqual(details["minutes"], 50)
        self.assertEqual(details["director"], "Кейт Херрон")
        tracks = names.voice_tracks(details["voices"], "en")
        self.assertEqual(tracks, ["2x Dub (Red Head Sound, Iron Voice)", "MVO (LostFilm)", "MVO (Ukr, Цікава Ідея)", "Original (Eng)"])
        self.assertEqual(details["subtitles"], ["Rus", "Eng"])

    def test_audio_lines_in_brackets_and_parentheses(self):
        details = names.nnm_details(topic([
            "Перевод: Дублированный",
            "Аудио 1: Dolby AC3, 48000Hz, 6ch, 640 Kbps [Русский]",
            "Аудио 2: Dolby AC3, 48000Hz, 6ch, 640 Kbps [Английский]",
        ]))
        self.assertEqual(names.voice_tracks(details["voices"], "en"), ["Dub", "Original (Eng)"])

    def test_anime_voices_from_the_language_line(self):
        details = names.nnm_details(topic([
            "Язык озвучки: Русский закадровый (Dream Cast), (AniBaza)",
            "Аудио 1: AAC, 48.0 KHz, 196 kbps, 2 ch (Русский, Dream Cast) (18+)",
            "Аудио 3: AC3, 48.0 KHz, 224 kbps, 2 ch (Японский, Madhouse)",
        ]))
        self.assertEqual(names.voice_tracks(details["voices"], "ja"), ["2x VO (Dream Cast, AniBaza)", "Original (Jap)"])

    def test_comment_tracks_are_ignored(self):
        details = names.nnm_details(topic(["Аудио 3: AC3 - Английский (комментарии режиссёра)"]))
        self.assertEqual(details["voices"], [])


class NnmTitles(unittest.TestCase):
    def test_series_title_follows_the_rutracker_shape(self):
        row = {"title": "Локи / Loki (2023) BDRip [H.265/1080p] [10-bit] (сезон 2, серии 1-6 из 6) LostFilm"}
        title = names.nnm_title(row, None, "en")
        self.assertEqual(title, "Локи / Loki / Сезон: 2 / Серии: 1-6 из 6 [2023, BDRip 1080p] [10-bit] [HEVC] (LostFilm)")

    def test_whole_season_count_becomes_a_range(self):
        row = {"title": "Лучше звоните Солу / Better Call Saul (2015) WEBRip [H.264/1080p] (сезон 1, серии 10 из 10) LostFilm + Sub / Rus, Eng"}
        title = names.nnm_title(row, None, "en")
        self.assertIn("Сезон: 1 / Серии: 1-10 из 10", title)
        self.assertTrue(title.endswith("(LostFilm)"))

    def test_anime_title(self):
        row = {"title": "Sousou no Frieren TV-2 | Фрирен, провожающая в последний путь [ТВ-2] | Frieren 2 [2026, TV, 10 из 10] WEBRip 1080p Raw+Rus"}
        title = names.nnm_title(row, None, "ja")
        self.assertTrue(title.startswith("Фрирен, провожающая в последний путь (ТВ-2) / Sousou no Frieren TV-2"))
        self.assertIn("Серии: 1-10 из 10 [2026, WEBRip 1080p]", title)
        self.assertTrue(title.endswith("(Rus) + Original (Jap)"))

    def test_movie_with_voice_mark_in_brackets(self):
        row = {"title": "Возвращение в Сайлент Хилл / Return to Silent Hill (2026) WEBRip [H.264/1080p] [MVO]"}
        self.assertEqual(names.nnm_title(row, None, "en"), "Возвращение в Сайлент Хилл / Return to Silent Hill [2026, WEBRip 1080p] [AVC] MVO")


class OpenTrackers(unittest.TestCase):
    def test_yts_movie(self):
        movie = {
            "title": "Silent Hill", "title_english": "Silent Hill", "year": 2006, "runtime": 125, "language": "en",
            "torrents": [
                {"hash": "74B6387D4CC7DA9D5CE5AA980CE4842D52BEF23C", "quality": "1080p", "type": "bluray", "video_codec": "x264",
                 "bit_depth": "8", "audio_channels": "5.1", "seeds": 100, "peers": 6, "size_bytes": 1717986918, "url": "https://yts/t"},
                {"hash": "BAD", "quality": "1080p"},
                {"hash": "74B6387D4CC7DA9D5CE5AA980CE4842D52BEF23D", "quality": "3D"},
            ],
        }
        items = names.yts_items(movie, "en", "https://yts/m")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["title"], "Silent Hill (2006) [2006, BDRip 1080p] [AVC] Original (Eng)")
        self.assertEqual(items[0]["infoHash"], "74b6387d4cc7da9d5ce5aa980ce4842d52bef23c")
        self.assertEqual(items[0]["minutes"], 125)

    def test_eztv_keeps_the_wanted_episode_and_season_packs(self):
        def torrent(title, season, episode, letter):
            return {"title": title, "season": season, "episode": episode, "hash": letter * 40,
                    "magnet_url": "magnet:?xt=urn:btih:" + letter * 40, "seeds": 5, "peers": 1, "size_bytes": "100", "id": 1}
        torrents = [
            torrent("South Park S28E03 1080p WEB h264-ETHEL EZTV", "28", "3", "a"),
            torrent("South Park S28E04 1080p WEB h264-ETHEL EZTV", "28", "4", "b"),
            torrent("South Park S28 1080p x265-ELiTE EZTV", "28", "0", "c"),
            torrent("South Park S27E03 720p x264-FENiX EZTV", "27", "3", "d"),
        ]
        torrents.append(torrent("South Park Studios Special S28E03 720p", "28", "3", "e"))
        torrents.append(torrent("Breaking Brad S28E03 720p", "28", "3", "f"))
        items = names.eztv_items(torrents, "South Park", "en", 28, 3)
        self.assertEqual([item["infoHash"][0] for item in items], ["a", "c", "e"])
        self.assertFalse(names.same_show("Breaking Brad S02E02 Doom", ["Breaking Bad"]))
        self.assertTrue(names.same_show("The Office US S01E01 720p", ["The Office US"]))
        self.assertEqual(items[0]["title"], "South Park / Сезон: 28 / Серии: 3-3 из ? [WEB-DL 1080p] [AVC] Original (Eng)")
        self.assertEqual(items[1]["title"], "South Park / Сезон: 28 [WEB-DL 1080p] [HEVC] Original (Eng)")

    def test_aniliberty_release(self):
        release = {"name": {"main": "Провожающая в последний путь Фрирен 2", "english": "Sousou no Frieren 2nd Season"}, "year": 2026,
                   "episodes_total": 10, "mal": 59978}
        torrents = [{"id": 5, "hash": "b" * 40, "description": "1-10", "quality": {"value": "1080p"}, "type": {"value": "WEBRip"},
                     "codec": {"value": "x265/HEVC"}, "size": 100, "seeders": 50, "leechers": 1, "magnet": "magnet:?x", "label": "L"}]
        items = names.ani_items(release, torrents, "https://ani/r")
        self.assertEqual(
            items[0]["title"],
            "Провожающая в последний путь Фрирен 2 (ТВ-2) / Sousou no Frieren 2nd Season / Серии: 1-10 из 10 [2026, WEBRip 1080p] [HEVC] MVO (AniLiberty) + Original (Jap)",
        )


def sukebei_item(title: str, ident: int, seeds: int, size: str, info_hash: str, category: str = "1_1") -> str:
    return (
        f"<item><title>{title}</title><link>https://sukebei.nyaa.si/download/{ident}.torrent</link>"
        f'<guid isPermaLink="true">https://sukebei.nyaa.si/view/{ident}</guid>'
        f"<nyaa:seeders>{seeds}</nyaa:seeders><nyaa:leechers>1</nyaa:leechers><nyaa:infoHash>{info_hash}</nyaa:infoHash>"
        f"<nyaa:categoryId>{category}</nyaa:categoryId><nyaa:size>{size}</nyaa:size></item>"
    )


class Sukebei(unittest.TestCase):
    RSS = "<rss><channel>" + "".join([
        sukebei_item("[Abysswalker] Ijirare: Fukushuu Saimin (イジラレ~復讐催眠~) [720p][1080p][WEB-DL]", 4338622, 16, "6.8 GiB", "f" * 40),
        sukebei_item("[Eroteca] ijirare fukushuu saimin - 04 ( OVA イジラレ ～復讐催○～＃4) - [SOFTSUBS ENG] [720P]", 3519551, 3, "491.9 MiB", "2" * 40),
        sukebei_item("[Eroteca] ijirare fukushuu saimin - 02 [SOFTSUBS ENG] [720P]", 3519550, 4, "480 MiB", "3" * 40),
        sukebei_item("[Group] Ijirare Something Else - 01 [1080p]", 1, 50, "1 GiB", "4" * 40),
        sukebei_item("[Group] Ijirare: Fukushuu Saimin artbook", 2, 50, "100 MiB", "5" * 40, "1_4"),
        sukebei_item("[Preview] Ijirare Fukushuu Saimin 01 [60fps].mp4", 3, 9, "77 MiB", "6" * 40),
        sukebei_item("Ijirare: Fukushuu Saimin / Bullied ~Revenge Hypnosis~ / イジラレ 01-04 PV [1080p]", 4, 9, "200 MiB", "7" * 40),
    ]) + "</channel></rss>"

    def test_batch_and_episodes_become_tracker_titles(self):
        items = names.sukebei_items(self.RSS, ["Ijirare: Fukushuu Saimin"], 1, None)
        self.assertEqual([item["id"] for item in items], ["4338622", "3519551", "3519550"])
        batch, fourth = items[0], items[1]
        self.assertEqual(batch["title"], "Ijirare: Fukushuu Saimin [WEB-DL 1080p] [TV] Original (Jap)")
        self.assertEqual(batch["sizeBytes"], int(6.8 * 1024 ** 3))
        self.assertEqual(batch["episodeFirst"], 0)
        self.assertTrue(batch["magnet"].startswith("magnet:?xt=urn:btih:" + "f" * 40))
        self.assertEqual(fourth["title"], "Ijirare: Fukushuu Saimin / Серии: 4-4 из ? [WEB-DL 720p] Original (Jap) + Sub (Eng)")
        self.assertEqual((fourth["season"], fourth["episodeFirst"], fourth["episodeLast"]), (1, 4, 4))

    def test_other_episodes_are_skipped(self):
        items = names.sukebei_items(self.RSS, ["Ijirare: Fukushuu Saimin"], 1, 2)
        self.assertEqual([item["id"] for item in items], ["4338622", "3519550"])


if __name__ == "__main__":
    unittest.main()
