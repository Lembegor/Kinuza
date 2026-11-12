import type { AppLanguage } from "./lib/languages";

export type ChangelogLine = string | { heading: string };

export type Changelog = Record<AppLanguage, ChangelogLine[]>;

export const changelog: Record<string, Changelog> = {
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
