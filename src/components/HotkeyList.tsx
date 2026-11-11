import { useT, type MessageKey } from "../lib/i18n";

const hotkeys: { keys: string[]; label: MessageKey }[] = [
  { keys: ["hotkeys.key.space", "K"], label: "hotkeys.play" },
  { keys: ["←", "→"], label: "hotkeys.seek" },
  { keys: ["Shift + ←", "Shift + →"], label: "hotkeys.seekLong" },
  { keys: ["J", "L"], label: "hotkeys.seek" },
  { keys: ["0–9"], label: "hotkeys.jump" },
  { keys: ["Home", "End"], label: "hotkeys.edges" },
  { keys: ["↑", "↓"], label: "hotkeys.volume" },
  { keys: ["M"], label: "hotkeys.mute" },
  { keys: ["F"], label: "hotkeys.fullscreen" },
  { keys: ["I"], label: "hotkeys.mini" },
  { keys: ["N"], label: "hotkeys.next" },
  { keys: ["S"], label: "hotkeys.skip" },
  { keys: ["A"], label: "hotkeys.audio" },
  { keys: ["C"], label: "hotkeys.subtitles" },
  { keys: ["G", "H"], label: "hotkeys.subtitleDelay" },
  { keys: ["[", "]"], label: "hotkeys.speed" },
  { keys: ["?"], label: "hotkeys.help" },
  { keys: ["Esc"], label: "hotkeys.escape" },
];

export function HotkeyList() {
  const { t } = useT();
  return (
    <dl className="hotkeys">
      {hotkeys.map((item) => (
        <div key={`${item.label}:${item.keys.join()}`} className="hotkeys__row">
          <dt>
            {item.keys.map((key) => (
              <kbd key={key}>{key.startsWith("hotkeys.") ? t(key as MessageKey) : key}</kbd>
            ))}
          </dt>
          <dd>{t(item.label)}</dd>
        </div>
      ))}
    </dl>
  );
}
