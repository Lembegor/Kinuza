import unittest

import page
import server


class Language(unittest.TestCase):
    def test_best_known_language_wins(self):
        self.assertEqual(page.pick_language("uk-UA,uk;q=0.9,ru;q=0.8,en;q=0.7"), "uk")
        self.assertEqual(page.pick_language("en-US,en;q=0.9"), "en")
        self.assertEqual(page.pick_language("de-DE,de;q=0.9"), "ru")
        self.assertEqual(page.pick_language(""), "ru")


class Page(unittest.TestCase):
    def test_links_and_escaping(self):
        info = {"title": "Голодные <игры>", "original": "The Hunger Games", "year": "2026", "poster": "/abc.jpg", "backdrop": "/def.jpg", "overview": "Описание & ещё"}
        body = page.render(info, "movie", 1300968, "ru", None, None, "n0nce")
        self.assertIn('href="kinuza://title/movie/1300968"', body)
        self.assertIn("Голодные &lt;игры&gt;", body)
        self.assertNotIn("<игры>", body)
        self.assertIn(f"{page.IMAGES}/w500/abc.jpg", body)
        self.assertIn('nonce="n0nce"', body)
        self.assertIn('property="og:title" content="Голодные &lt;игры&gt; (2026)"', body)

    def test_episode_link_and_bad_images(self):
        self.assertEqual(page.deep_link("tv", 45790, 2, 7), "kinuza://title/tv/45790?s=2&e=7")
        self.assertEqual(page.deep_link("movie", 1, 2, 7), "kinuza://title/movie/1")
        self.assertEqual(page.image("javascript:alert(1)", "w500"), "")
        self.assertEqual(page.image("/a\"b.jpg", "w500"), "")

    def test_unknown_title_still_offers_the_app(self):
        body = page.render(None, "tv", 5, "en", None, None, "x")
        self.assertIn("Open in Kinuza", body)
        self.assertNotIn("og:image", body)

    def test_short_overview(self):
        self.assertEqual(page.shorten("one two three four", 9), "one two…")


class Invite(unittest.TestCase):
    def test_invite_opens_the_friend_link(self):
        body = page.render_invite("ABCD2345", "ru", "n")
        self.assertIn('href="kinuza://friend/ABCD2345"', body)
        self.assertIn("ABCD-2345", body)
        self.assertIn("Приглашение в друзья", body)

    def test_privacy_in_every_language(self):
        import privacy
        for language in ("ru", "uk", "en"):
            body = privacy.render_privacy(language)
            self.assertIn("https://github.com/Lembegor/Kinuza/issues", body)
            self.assertNotIn("<script", body)


class Record(unittest.TestCase):
    def test_catalog_record_is_read(self):
        record = {"t": {"ru": "Невероятные приключения ДжоДжо", "en": "JoJo"}, "o": "ジョジョ", "y": "2012", "i": {"": "/x.jpg", "ru": "/r.jpg"}, "b": "/b.jpg"}
        info = server.from_record(record, "ru")
        self.assertEqual((info["title"], info["poster"], info["year"]), ("Невероятные приключения ДжоДжо", "/r.jpg", "2012"))
        self.assertEqual(server.from_record(record, "uk")["title"], "JoJo")


if __name__ == "__main__":
    unittest.main()
