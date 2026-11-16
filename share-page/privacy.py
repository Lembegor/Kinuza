import html

UPDATED = "2026-11-16"
CONTACT = "https://github.com/Lembegor/Kinuza/issues"

SECTIONS = {
    "ru": (
        "Политика конфиденциальности Kinuza",
        f"Обновлено {UPDATED}",
        [
            ("Коротко", "Аккаунт в Kinuza нужен только для облачной копии и друзей. Пользоваться приложением можно и без него. Мы не продаём данные, не показываем рекламу и не передаём данные третьим лицам."),
            ("Что мы получаем при входе через Google", "Идентификатор аккаунта Google, адрес почты и имя. Пароль от Google в Kinuza не попадает: вход подтверждается на странице Google, а приложение получает только одноразовый код."),
            ("Что хранится на сервере", "Имя и аватар, которые вы задали в Kinuza; облачная копия - библиотека, оценки, прогресс и история просмотров, настройки приложения без путей к папкам; список друзей и заявок; время последнего входа. Для восстановления хранятся ещё три предыдущие версии копии."),
            ("Статус и «что смотрю»", "Пока Kinuza открыта, раз в минуту она сообщает серверу, что вы в сети и какой фильм или серию смотрите. Это видят только ваши друзья. Статус хранится лишь в памяти сервера и никуда не записывается. Фильмы для взрослых не передаются никогда. Показ того, что вы смотрите, можно выключить, а в режиме «Невидимка» друзья всегда видят вас не в сети."),
            ("Где и сколько хранится", "Данные хранятся на сервере Kinuza и передаются только по защищённому соединению HTTPS. Они хранятся, пока существует аккаунт."),
            ("Как управлять данными", "В профиле Kinuza, во вкладке «Друзья и аккаунт», можно выйти на этом или на всех устройствах и удалить аккаунт. При удалении аккаунт, облачная копия, друзья и заявки удаляются с сервера сразу. Данные на вашем компьютере при этом остаются."),
            ("Связь", f'Вопросы и просьбы можно оставить здесь: <a href="{CONTACT}">{CONTACT}</a>'),
        ],
    ),
    "uk": (
        "Політика конфіденційності Kinuza",
        f"Оновлено {UPDATED}",
        [
            ("Коротко", "Акаунт у Kinuza потрібен лише для хмарної копії та друзів. Користуватися застосунком можна й без нього. Ми не продаємо дані, не показуємо рекламу й не передаємо дані третім особам."),
            ("Що ми отримуємо під час входу через Google", "Ідентифікатор акаунта Google, адресу пошти та ім'я. Пароль від Google у Kinuza не потрапляє: вхід підтверджується на сторінці Google, а застосунок отримує лише одноразовий код."),
            ("Що зберігається на сервері", "Ім'я та аватар, які ви задали в Kinuza; хмарна копія - бібліотека, оцінки, прогрес та історія переглядів, налаштування застосунку без шляхів до тек; список друзів і заявок; час останнього входу. Для відновлення зберігаються ще три попередні версії копії."),
            ("Статус і «що дивлюся»", "Поки Kinuza відкрита, раз на хвилину вона повідомляє серверу, що ви в мережі й який фільм чи серію дивитеся. Це бачать лише ваші друзі. Статус зберігається тільки в пам'яті сервера й нікуди не записується. Фільми для дорослих не передаються ніколи. Показ того, що ви дивитеся, можна вимкнути, а в режимі «Невидимка» друзі завжди бачать вас не в мережі."),
            ("Де й скільки зберігається", "Дані зберігаються на сервері Kinuza й передаються лише захищеним з'єднанням HTTPS. Вони зберігаються, поки існує акаунт."),
            ("Як керувати даними", "У профілі Kinuza, на вкладці «Друзі та акаунт», можна вийти на цьому чи на всіх пристроях і видалити акаунт. Під час видалення акаунт, хмарну копію, друзів і заявки одразу видаляють із сервера. Дані на вашому комп'ютері при цьому залишаються."),
            ("Зв'язок", f'Питання й прохання можна залишити тут: <a href="{CONTACT}">{CONTACT}</a>'),
        ],
    ),
    "en": (
        "Kinuza privacy policy",
        f"Updated {UPDATED}",
        [
            ("In short", "A Kinuza account is only needed for the cloud copy and friends. The app works without it. We do not sell data, show ads or share data with third parties."),
            ("What we get when you sign in with Google", "Your Google account ID, email address and name. Your Google password never reaches Kinuza: you confirm the sign-in on Google's page and the app only receives a one-time code."),
            ("What is stored on the server", "The name and avatar you set in Kinuza; the cloud copy - your library, ratings, progress and watch history, and app settings without folder paths; your friends and requests; the time you were last online. Three earlier versions of the copy are kept for recovery."),
            ("Status and what you watch", "While Kinuza is open it tells the server once a minute that you are online and which film or episode you watch. Only your friends see it. The status lives only in the server's memory and is never written down. Adult titles are never sent. You can turn off showing what you watch, and in Invisible mode friends always see you offline."),
            ("Where and how long", "The data is kept on the Kinuza server and only travels over a secure HTTPS connection. It is kept while the account exists."),
            ("Controlling your data", "In the Kinuza profile, on the Friends and account tab, you can sign out on this or on every device and delete the account. Deleting removes the account, the cloud copy, friends and requests from the server at once. The data on your computer stays."),
            ("Contact", f'Questions and requests: <a href="{CONTACT}">{CONTACT}</a>'),
        ],
    ),
}


def render_privacy(language: str) -> str:
    title, updated, sections = SECTIONS.get(language, SECTIONS["ru"])
    escape = html.escape
    body = "".join(f"<h2>{escape(heading)}</h2><p>{text if '<a ' in text else escape(text)}</p>" for heading, text in sections)
    return f"""<!doctype html>
<html lang="{language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{escape(title)}</title>
<style>
:root {{ color-scheme: dark; }}
body {{ margin: 0; background: #0e0e13; color: #f2f2f5; font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; line-height: 1.6; }}
main {{ max-width: 760px; margin: 0 auto; padding: 48px 24px 64px; }}
h1 {{ margin: 0 0 6px; font-size: 30px; }}
.updated {{ color: #8b8b99; margin: 0 0 28px; }}
h2 {{ margin: 28px 0 8px; font-size: 18px; }}
p {{ color: #d4d4dc; margin: 0; }}
a {{ color: #ff8a8d; }}
.mark {{ display: inline-grid; place-items: center; width: 44px; height: 44px; border-radius: 12px; background: #e5484d; font-weight: 800; font-size: 22px; margin-bottom: 18px; }}
</style>
</head>
<body>
<main>
<div class="mark">K</div>
<h1>{escape(title)}</h1>
<p class="updated">{escape(updated)}</p>
{body}
</main>
</body>
</html>
"""
