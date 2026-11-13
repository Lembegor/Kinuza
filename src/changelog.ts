import type { AppLanguage } from "./lib/languages";

export type ChangelogLine = string | { heading: string };

export type Changelog = Record<AppLanguage, ChangelogLine[]>;

export const changelog: Record<string, Changelog> = {
  "0.5.1": {
    ru: [
      "Русские названия аниме теперь видны прямо на карточках.",
      "Поиск находит тайтлы по любому названию, в том числе по оригинальному, и работает быстрее.",
      "Каталог всех фильмов и сериалов скачивается на компьютер и обновляется сам.",
      "Раздачи на RuTracker теперь можно искать без своего аккаунта - через сервер Kinuza. Войти в свой аккаунт можно в любой момент.",
    ],
    en: [
      "Search finds titles by any of their names, including the original one, and works faster.",
      "The catalog of every movie and show is downloaded to your computer and updates on its own.",
      "You can now search RuTracker releases without your own account - through the Kinuza server. You can sign in to your own account at any time.",
    ],
    uk: [
      "Пошук знаходить тайтли за будь-якою назвою, зокрема за оригінальною, і працює швидше.",
      "Каталог усіх фільмів і серіалів завантажується на комп'ютер і оновлюється сам.",
      "Роздачі на RuTracker тепер можна шукати без свого акаунта - через сервер Kinuza. Увійти у свій акаунт можна будь-коли.",
    ],
  },
  "0.5.0": {
    ru: [
      "Улучшен поиск по жанрам в аниме.",
      "Поиск стал точнее.",
      "Поиск раздач ищет по всем названиям тайтла и показывает всё одним списком.",
      "У сезонов теперь свои постеры.",
      "В настройках появился раздел «Аккаунты».",
      "Много разных мелких исправлений и добавлений.",
    ],
    en: [
      "Better genre search for anime.",
      "Search is more accurate.",
      "Release search looks up every name of a title and shows everything in one list.",
      "Seasons now have their own posters.",
      "New Accounts section in Settings.",
      "Lots of small fixes and additions.",
    ],
    uk: [
      "Покращено пошук за жанрами в аніме.",
      "Пошук став точнішим.",
      "Пошук роздач шукає за всіма назвами тайтлу і показує все одним списком.",
      "У сезонів тепер свої постери.",
      "У налаштуваннях з'явився розділ «Акаунти».",
      "Багато різних дрібних виправлень і доповнень.",
    ],
  },
  "0.4.4": {
    ru: [
      "Добавлена страница «Место на диске»: видно, сколько занимают скачанные фильмы, кэш онлайн-просмотра и само приложение, и всё можно удобно почистить.",
      "Скачанное можно удалить с диска, не убирая из библиотеки - смотреть онлайн можно будет и дальше.",
      "Серии и фильмы больше не пропадают из онлайн-просмотра после очистки кэша.",
      "Добавлена возможность выключить раздачу: для всех загрузок в настройках или отдельно для каждой в «Загрузках».",
    ],
    en: [
      "New Disk space page: see how much your downloads, the online viewing cache and the app take up, and clean any of it up easily.",
      "Downloads can be removed from the disk without leaving your library - you can keep watching them online.",
      "Episodes and movies no longer drop out of online viewing after the cache is cleared.",
      "You can now turn off sharing: for all downloads in the settings or for each one separately in Downloads.",
    ],
    uk: [
      "Додано сторінку «Місце на диску»: видно, скільки займають завантажені фільми, кеш онлайн-перегляду та сам застосунок, і все можна зручно почистити.",
      "Завантажене можна видалити з диска, не прибираючи з бібліотеки - дивитися онлайн можна буде й далі.",
      "Серії та фільми більше не зникають з онлайн-перегляду після очищення кешу.",
      "Додано можливість вимкнути роздачу: для всіх завантажень у налаштуваннях або окремо для кожного в «Завантаженнях».",
    ],
  },
  "0.4.3": {
    ru: [
      { heading: "Улучшение поиска сериалов:" },
      "Поиск раздач теперь понимает сезоны: выберите сезон и увидите раздачи именно для него, даже если на трекере он называется по-другому.",
      "Находится больше раздач: поиск теперь смотрит несколько страниц и другие названия сериала.",
      "При онлайн-просмотре сразу доступны все серии раздачи. Галочки теперь отмечают только то, что скачать.",
      "Серии из уже добавленных раздач, которые вы раньше не отметили, подтянутся сами.",
      "Серии раздачи раскладываются по сезонам точнее, а исправить раскладку стало проще.",
      "В плеере появились кнопки предыдущей и следующей серии и список всех серий.",
      "Добавлено удобное окно выбора нужной серии в плеере.",
      'Добавил кнопку "Следующая серия" в конце эпизода.',
      "Следующая серия включается надёжнее, в том числе из следующего сезона.",
      "Убрано мигание прозрачного фона при запуске серии.",
      "Добавлена история изменений в настройках.",
    ],
    en: [
      { heading: "Better search for TV shows:" },
      "Release search now understands seasons: pick a season and see releases for it, even when the tracker names it differently.",
      "More releases are found: the search now looks through several pages and other names of the show.",
      "When you watch online, every episode of the release is available right away. Checkmarks now only mark what to download.",
      "Episodes from releases you added before but didn't check will be picked up on their own.",
      "Episodes of a release are sorted into seasons more accurately, and fixing the layout is easier.",
      "The player now has previous and next episode buttons and a list of all episodes.",
      "Added a handy window for picking an episode in the player.",
      'Added a "Next episode" button at the end of an episode.',
      "The next episode starts more reliably, including from the next season.",
      "Fixed a flash of transparent background when an episode starts.",
      "Added version history in the settings.",
    ],
    uk: [
      { heading: "Покращення пошуку серіалів:" },
      "Пошук роздач тепер розуміє сезони: виберіть сезон і побачите роздачі саме для нього, навіть якщо на трекері він називається інакше.",
      "Знаходиться більше роздач: пошук тепер переглядає кілька сторінок та інші назви серіалу.",
      "Під час онлайн-перегляду одразу доступні всі серії роздачі. Галочки тепер позначають лише те, що завантажити.",
      "Серії з уже доданих роздач, які ви раніше не позначили, підтягнуться самі.",
      "Серії роздачі розкладаються за сезонами точніше, а виправити розкладку стало простіше.",
      "У плеєрі з'явилися кнопки попередньої та наступної серії і список усіх серій.",
      "Додано зручне вікно вибору потрібної серії в плеєрі.",
      'Додав кнопку "Наступна серія" наприкінці епізоду.',
      "Наступна серія вмикається надійніше, зокрема з наступного сезону.",
      "Прибрано блимання прозорого фону під час запуску серії.",
      "Додано історію змін у налаштуваннях.",
    ],
  },
  "0.4.2": {
    ru: [
      "Добавлена возможность пропустить заставку и титры в сериалах.",
      "Сцены после титров не пропускаются.",
      "Улучшено соединение с другими раздающими, из-за чего скорость скачивания может быть выше.",
      "Добавлена кнопка «Сообщить о проблеме», где вы можете описать баг, с которым столкнулись, и отправить логи мне.",
      "Добавлено вот это окошко, которое вы сейчас читаете после обновления.",
    ],
    en: [
      "You can now skip the intro and credits in TV shows.",
      "Scenes after the credits are not skipped.",
      "Better connections to other peers, so downloads can be faster.",
      "New “Report a problem” button: describe the bug you ran into and send me the logs.",
      "Added this window you are reading right now after the update.",
    ],
    uk: [
      "Додано можливість пропустити заставку й титри в серіалах.",
      "Сцени після титрів не пропускаються.",
      "Покращено з'єднання з іншими роздавачами, через що швидкість завантаження може бути вищою.",
      "Додано кнопку «Повідомити про проблему», де ви можете описати баг, з яким зіткнулися, і надіслати логи мені.",
      "Додано ось це віконце, яке ви зараз читаєте після оновлення.",
    ],
  },
};
