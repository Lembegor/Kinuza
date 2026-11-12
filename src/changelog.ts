import type { AppLanguage } from "./lib/languages";

export type Changelog = Record<AppLanguage, string[]>;

export const changelog: Record<string, Changelog> = {
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
