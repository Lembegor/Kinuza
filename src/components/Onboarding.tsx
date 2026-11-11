import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, Link2, Play, Search, X, type LucideIcon } from "lucide-react";
import { useT, type MessageKey } from "../lib/i18n";
import { imageUrl, tmdb, type DiscoverKind, type MediaItem } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";
import { titleKey, toTitleRef, useLibrary } from "../state/library";
import { useSettings } from "../state/settings";
import { CatalogError, typeLabel } from "./Cards";
import { LanguagePicker } from "./LanguagePicker";
import { WindowButtons } from "./Shell";

type Step = "language" | "picks" | "howTo";

const steps: Step[] = ["language", "picks", "howTo"];
const recommendedPicks = 5;
const searchDebounceMs = 350;
const warmedPicks = 10;
const skeletonCardCount = 24;

const startingLists: { kind: DiscoverKind; pages: number; share: number }[] = [
  { kind: "movie", pages: 2, share: 2 },
  { kind: "tv", pages: 2, share: 2 },
  { kind: "anime", pages: 1, share: 1 },
];

async function startingTitles(): Promise<MediaItem[]> {
  const lists = await Promise.all(
    startingLists.map(async ({ kind, pages }) => {
      const loaded = await Promise.allSettled(Array.from({ length: pages }, (_, index) => tmdb.mostVoted(kind, index + 1)));
      const failure = loaded.find((page) => page.status === "rejected");
      if (failure && loaded.every((page) => page.status === "rejected")) throw failure.reason;
      return loaded.flatMap((page) => (page.status === "fulfilled" ? page.value : []));
    }),
  );

  const mixed: MediaItem[] = [];
  const seen = new Set<string>();
  const cursors = lists.map(() => 0);
  while (lists.some((list, index) => cursors[index] < list.length)) {
    lists.forEach((list, index) => {
      for (const item of list.slice(cursors[index], cursors[index] + startingLists[index].share)) {
        const key = titleKey(item.type, item.id);
        if (!seen.has(key)) mixed.push(item);
        seen.add(key);
      }
      cursors[index] += startingLists[index].share;
    });
  }
  return mixed;
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

function StepLabel({ step }: { step: Step }) {
  const { t } = useT();
  return <div className="onboarding__step">{t("onboarding.step", { step: steps.indexOf(step) + 1, total: steps.length })}</div>;
}

function PickCard({
  item,
  picked,
  tabbable,
  onToggle,
  onFocus,
}: {
  item: MediaItem;
  picked: boolean;
  tabbable: boolean;
  onToggle: () => void;
  onFocus: () => void;
}) {
  const poster = imageUrl(item.poster, "w185");
  return (
    <button className={`pick ${picked ? "is-picked" : ""}`} aria-pressed={picked} tabIndex={tabbable ? 0 : -1} onClick={onToggle} onFocus={onFocus}>
      <div className="pick__art">
        {poster && <img src={poster} alt="" loading="lazy" draggable={false} />}
        <span className="pick__check">
          <Check size={15} strokeWidth={3} />
        </span>
      </div>
      <div className="pick__title">{item.title}</div>
      <div className="pick__meta">
        {item.year && <span>{item.year}</span>}
        <span>{typeLabel(item)}</span>
      </div>
    </button>
  );
}

function PicksStep({
  picks,
  onToggle,
  onBack,
  onSkip,
  onContinue,
}: {
  picks: Map<string, MediaItem>;
  onToggle: (item: MediaItem) => void;
  onBack: () => void;
  onSkip: () => void;
  onContinue: () => void;
}) {
  const { t, language } = useT();
  const [text, setText] = useState("");
  const typed = text.trim();
  const settled = useDebounced(typed, searchDebounceMs);
  const query = typed === "" ? "" : settled;
  const starting = useAsync(startingTitles, [language]);
  const found = useAsync(() => (query ? tmdb.search(query) : Promise.resolve<MediaItem[]>([])), [query, language]);
  const searching = query !== "";
  const source = searching ? found : starting;

  const [touched, setTouched] = useState(() => new Map(picks));
  const toggle = (item: MediaItem) => {
    setTouched((current) => new Map(current).set(titleKey(item.type, item.id), item));
    onToggle(item);
  };

  const items = useMemo(() => {
    if (searching) return found.data ?? [];
    const listed = starting.data ?? [];
    const listedKeys = new Set(listed.map((item) => titleKey(item.type, item.id)));
    return [...[...touched.values()].filter((item) => !listedKeys.has(titleKey(item.type, item.id))), ...listed];
  }, [searching, found.data, starting.data, touched]);

  const [cursor, setCursor] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => setCursor(0), [query]);

  const focusCard = (index: number) => {
    const card = gridRef.current?.children[Math.max(0, Math.min(items.length - 1, index))];
    if (card instanceof HTMLElement) card.focus();
  };

  const onGridKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const grid = gridRef.current;
    if (!grid || event.altKey || event.ctrlKey || event.metaKey) return;
    const columns = getComputedStyle(grid).gridTemplateColumns.split(" ").length;
    let target: number;
    switch (event.key) {
      case "ArrowRight":
        target = cursor + 1;
        break;
      case "ArrowLeft":
        target = cursor - 1;
        break;
      case "ArrowDown":
        target = cursor + columns;
        break;
      case "ArrowUp":
        target = cursor - columns;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    if (event.key === "ArrowUp" && target < 0) searchRef.current?.focus();
    else focusCard(target);
  };

  const count = picks.size;
  const counter =
    count === 0
      ? t("onboarding.picks.count.none", { target: recommendedPicks })
      : count < recommendedPicks
        ? t("onboarding.picks.count.more", { count, more: recommendedPicks - count })
        : t("onboarding.picks.count.enough", { count });

  return (
    <section className="onboarding">
      <div className="onboarding__head">
        <div className="onboarding__intro">
          <StepLabel step="picks" />
          <h1>{t("onboarding.picks.title")}</h1>
          <p>{t("onboarding.picks.text")}</p>
        </div>
        <label className="search-box onboarding__search">
          <Search size={16} />
          <input
            ref={searchRef}
            value={text}
            autoFocus
            placeholder={t("onboarding.picks.search")}
            spellCheck={false}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setText("");
              if (event.key === "ArrowDown" && items.length > 0) {
                event.preventDefault();
                focusCard(cursor);
              }
            }}
          />
          {text && (
            <button
              aria-label={t("shell.search.clear")}
              onClick={() => {
                setText("");
                searchRef.current?.focus();
              }}
            >
              <X size={14} />
            </button>
          )}
        </label>
      </div>

      <div className="onboarding__body">
        {source.error ? (
          <CatalogError onRetry={source.reload} />
        ) : source.loading || typed !== query ? (
          <div className="pick-grid" aria-hidden>
            {Array.from({ length: skeletonCardCount }, (_, index) => (
              <div key={index} className="pick pick--skeleton" />
            ))}
          </div>
        ) : items.length > 0 ? (
          <div className="pick-grid" role="group" aria-label={t("onboarding.picks.grid")} ref={gridRef} onKeyDown={onGridKey}>
            {items.map((item, index) => {
              const key = titleKey(item.type, item.id);
              return (
                <PickCard
                  key={key}
                  item={item}
                  picked={picks.has(key)}
                  tabbable={index === Math.min(cursor, items.length - 1)}
                  onToggle={() => toggle(item)}
                  onFocus={() => setCursor(index)}
                />
              );
            })}
          </div>
        ) : (
          <p className="onboarding__empty">{t("onboarding.picks.empty")}</p>
        )}
      </div>

      <footer className="onboarding__foot">
        <p className={`onboarding__count ${count >= recommendedPicks ? "is-enough" : ""}`} aria-live="polite">
          {count >= recommendedPicks && <Check size={16} strokeWidth={3} />}
          {counter}
        </p>
        <button className="button button--large onboarding__quiet" onClick={onBack}>
          {t("common.back")}
        </button>
        <button className="button button--large onboarding__quiet" onClick={onSkip}>
          {t("onboarding.skip")}
        </button>
        <button className="button button--primary button--large" disabled={count === 0} onClick={onContinue}>
          {t("onboarding.continue")}
        </button>
      </footer>
    </section>
  );
}

const howToSteps: { icon: LucideIcon; title: MessageKey; text: MessageKey }[] = [
  { icon: Search, title: "onboarding.howTo.find", text: "onboarding.howTo.find.text" },
  { icon: Link2, title: "onboarding.howTo.add", text: "onboarding.howTo.add.text" },
  { icon: Play, title: "onboarding.howTo.watch", text: "onboarding.howTo.watch.text" },
];

function HowToStep({ picks, onBack, onStart }: { picks: MediaItem[]; onBack: () => void; onStart: () => void }) {
  const { t } = useT();

  useEffect(() => {
    for (const item of picks.slice(0, warmedPicks)) void tmdb.taste(item.type, item.id).catch(() => undefined);
  }, [picks]);

  return (
    <section className="onboarding onboarding--centered">
      <div className="howto">
        <StepLabel step="howTo" />
        <h1>{t("onboarding.howTo.title")}</h1>
        <ol className="howto__steps">
          {howToSteps.map(({ icon: Icon, title, text }, index) => (
            <li key={title}>
              <span className="howto__icon">
                <Icon size={20} />
              </span>
              <span className="howto__number">{index + 1}</span>
              <strong>{t(title, { button: t("common.addTorrent") })}</strong>
              <p>{t(text)}</p>
            </li>
          ))}
        </ol>
        {picks.length > 0 && <p className="howto__ready">{t("onboarding.howTo.ready")}</p>}
        <div className="howto__actions">
          <button className="button button--large onboarding__quiet" onClick={onBack}>
            {t("common.back")}
          </button>
          <button className="button button--primary button--large howto__start" autoFocus onClick={onStart}>
            {t("onboarding.start")}
          </button>
        </div>
      </div>
    </section>
  );
}

export function Onboarding() {
  const language = useSettings((state) => state.language);
  const firstRun = useLibrary((state) => state.firstRun);
  const [step, setStep] = useState<Step>(language ? "picks" : "language");
  const [picks, setPicks] = useState<Map<string, MediaItem>>(new Map());
  const [picksSkipped, setPicksSkipped] = useState(false);
  const liked = useMemo(() => (picksSkipped ? [] : [...picks.values()]), [picks, picksSkipped]);

  const toggle = (item: MediaItem) =>
    setPicks((current) => {
      const next = new Map(current);
      const key = titleKey(item.type, item.id);
      if (!next.delete(key)) next.set(key, item);
      return next;
    });

  const finish = () => useLibrary.getState().finishOnboarding(liked.map(toTitleRef));
  const leavePicks = (skipped: boolean) => {
    setPicksSkipped(skipped);
    setStep("howTo");
  };

  return (
    <>
      <header className="titlebar" data-tauri-drag-region>
        <div className="titlebar__brand" data-tauri-drag-region>
          <span className="brand-mark" />
          KINUZA
        </div>
        <div className="titlebar__spacer" data-tauri-drag-region />
        <WindowButtons />
      </header>
      {step === "language" || !language ? (
        <LanguagePicker onChosen={() => firstRun && setStep("picks")} />
      ) : step === "picks" ? (
        <PicksStep
          picks={picks}
          onToggle={toggle}
          onBack={() => setStep("language")}
          onSkip={() => leavePicks(true)}
          onContinue={() => leavePicks(false)}
        />
      ) : (
        <HowToStep picks={liked} onBack={() => setStep("picks")} onStart={finish} />
      )}
    </>
  );
}
