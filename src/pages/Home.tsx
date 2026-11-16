import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PosterRow, type CardItem, type DismissDetail } from "../components/Cards";
import { ContinueRow } from "../components/home/ContinueRow";
import { CustomizeHome } from "../components/home/CustomizeHome";
import { DownloadedRow, HomeEnd, HomeStarter, OfflineBanner } from "../components/home/HomeBits";
import { HomePick, type PickSlide } from "../components/home/HomePick";
import { MoodRecs } from "../components/home/MoodRecs";
import { DailyPick, PlannedRow } from "../components/home/PersonalRows";
import { RowMenu } from "../components/home/RowMenu";
import { BestRow, FreshRow, PopularRow } from "../components/home/TabbedRows";
import { WeekStrip } from "../components/home/WeekStrip";
import { MonthCard } from "../components/profile/MonthCard";
import { t, useT } from "../lib/i18n";
import { key } from "../lib/taste";
import { useEpisodeCalendar } from "../state/calendar";
import { useContinueItems } from "../state/continueItems";
import { useFeed, usePersonalFeed, type FeedItem, type FeedRow } from "../state/feed";
import { forgetMoodPicks, moods, plannedItems, surprisePick, useFreshList, usePopularList, type Mood } from "../state/homeFeed";
import { useHomeLayout, type HomeBlockId } from "../state/homeLayout";
import { titleKey, useLibrary, type TitleRef } from "../state/library";
import { homeRefreshEvent, useUi } from "../state/ui";
import { warmRecentResume } from "../state/warmup";

const pickCount = 5;
const similarRows = 2;
const shortestRow = 5;
const shortestDaily = 3;
const msPerDay = 86_400_000;

function dismissNote(detail: DismissDetail): string {
  switch (detail.reason) {
    case "seen":
      return t("feed.dismissed.seen");
    case "genre":
      return t("feed.dismissed.genre");
    case "person":
      return t("feed.dismissed.person", { name: detail.personName ?? "" });
    default:
      return t("feed.dismissed.other");
  }
}

function dismissRecommendation(title: TitleRef, detail: DismissDetail): void {
  const { dismiss, restoreDismissed } = useLibrary.getState();
  dismiss(title, detail);
  useUi.getState().toast(dismissNote(detail), "info", {
    label: t("feed.dismissed.undo"),
    run: () => restoreDismissed(titleKey(title.type, title.id)),
  });
}

function choosePicks(items: FeedItem[]): PickSlide[] {
  const withArt = items.filter((item) => item.backdrop);
  const picked: PickSlide[] = [];
  const arms = new Set<string>();
  for (const item of withArt) {
    if (picked.length >= pickCount) break;
    if (item.arm && arms.has(item.arm)) continue;
    if (item.arm) arms.add(item.arm);
    picked.push(item);
  }
  for (const item of withArt) {
    if (picked.length >= pickCount) break;
    if (!picked.includes(item)) picked.push(item);
  }
  return picked;
}

function dailyRow(rows: FeedRow[], now: number): FeedRow | null {
  const candidates = rows.filter((row) => row.id === "gems" || row.id === "collections" || row.id === "themes" || row.id.startsWith("person:"));
  if (candidates.length === 0) return null;
  const thisYear = new Date(now).getFullYear();
  const continuation = candidates.find((row) => row.id === "collections" && row.items.some((item) => Number(item.year) >= thisYear - 1));
  if (continuation) return continuation;
  const localDay = Math.floor((now - new Date(now).getTimezoneOffset() * 60_000) / msPerDay);
  return candidates[localDay % candidates.length];
}

function unclaimed<T extends CardItem>(items: T[], claims: Set<string>): T[] {
  return items.filter((item) => !claims.has(key(item)));
}

function withoutNote<T extends CardItem>(items: T[], note: string): T[] {
  return items.map((item) => (item.note === note ? { ...item, note: undefined } : item));
}

function claim(items: CardItem[], claims: Set<string>): void {
  for (const item of items) claims.add(key(item));
}

interface Planned {
  forYou: FeedItem[] | null;
  fresh: FeedItem[] | null;
  similar: FeedRow[];
  daily: FeedRow | null;
  claims: Set<string>;
  beforeForYou: Set<string>;
  moodSkip: Set<string>;
}

export default function Home() {
  const { t } = useT();
  const pageRef = useRef<HTMLDivElement>(null);
  const libraryLoaded = useLibrary((state) => state.loaded);
  const tracked = useLibrary((state) => state.tracked);
  const progress = useLibrary((state) => state.progress);
  const dismissed = useLibrary((state) => state.dismissed);
  useEffect(() => {
    if (libraryLoaded) warmRecentResume();
  }, [libraryLoaded]);

  const feed = usePersonalFeed();
  const continueItems = useContinueItems();
  const calendar = useEpisodeCalendar();
  const { order, hidden } = useHomeLayout();
  const popular = usePopularList("all", true);
  const plannedMovies = useMemo(() => Object.values(tracked).some((entry) => entry.status === "planned" && entry.type === "movie"), [tracked]);
  const digital = useFreshList("movies", plannedMovies);
  const [mood, setMood] = useState<Mood>(moods[0]);
  const [surprise, setSurprise] = useState<PickSlide | null>(null);
  const [rolling, setRolling] = useState(false);
  const shownRef = useRef<PickSlide[] | null>(null);
  const [customizing, setCustomizing] = useState(false);
  const [frozenPicks, setFrozenPicks] = useState<PickSlide[] | null>(null);
  const [moodGeneration, setMoodGeneration] = useState(0);
  const feedBuiltAt = useFeed((state) => state.builtAt);
  useEffect(() => {
    forgetMoodPicks();
    setMoodGeneration((value) => value + 1);
  }, [feedBuiltAt]);

  const rows = feed.rows;
  const forYouRow = rows?.find((row) => row.id === "for-you") ?? null;
  useEffect(() => {
    if (frozenPicks === null && forYouRow && forYouRow.items.length > 0) setFrozenPicks(choosePicks(forYouRow.items));
  }, [frozenPicks, forYouRow]);
  const picks = useMemo(() => (frozenPicks ?? []).filter((item) => !(key(item) in dismissed)), [frozenPicks, dismissed]);

  const isNew = libraryLoaded && !feed.available && Object.keys(tracked).length === 0 && Object.keys(progress).length === 0;
  const offline = Boolean(popular.error) && !popular.data;

  const visible = useMemo(() => order.filter((id) => !hidden.has(id)), [order, hidden]);

  const planned = useMemo<Planned>(() => {
    const claims = new Set<string>();
    if (visible.includes("pick")) claim(picks, claims);
    for (const item of continueItems) claims.add(titleKey(item.title.type, item.title.id));
    const result: Planned = { forYou: null, fresh: null, similar: [], daily: null, claims, beforeForYou: new Set(claims), moodSkip: claims };
    if (!rows) return result;
    const forYouKeys = new Set<string>();
    const now = Date.now();
    for (const id of visible) {
      if (id === "forYou") {
        result.beforeForYou = new Set(claims);
        result.forYou = forYouRow ? unclaimed(forYouRow.items, claims) : [];
        claim(result.forYou, forYouKeys);
        claim(result.forYou, claims);
      } else if (id === "fresh") {
        const row = rows.find((item) => item.id === "fresh");
        const items = row ? unclaimed(row.items, claims) : [];
        result.fresh = items.length >= shortestRow ? withoutNote(items, t("feed.reason.fresh")) : [];
        claim(result.fresh, claims);
      } else if (id === "similar") {
        for (const row of rows.filter((item) => item.id.startsWith("cluster:") || item.id.startsWith("because:"))) {
          if (result.similar.length >= similarRows) break;
          const items = unclaimed(row.items, claims);
          if (items.length < shortestRow) continue;
          result.similar.push({ ...row, items });
          claim(items, claims);
        }
      } else if (id === "daily") {
        const row = dailyRow(rows, now);
        const items = row ? unclaimed(row.items, claims) : [];
        if (row && items.length >= shortestDaily) {
          result.daily = { ...row, items: row.id === "themes" ? withoutNote(items, t("feed.reason.theme")) : items };
          claim(items, claims);
        }
      } else if (id === "planned") {
        for (const entry of Object.values(tracked)) if (entry.status === "planned") claims.add(titleKey(entry.type, entry.id));
      }
    }
    result.moodSkip = new Set([...claims].filter((item) => !forYouKeys.has(item)));
    return result;
  }, [visible, picks, continueItems, rows, forYouRow, tracked]);

  const plannedList = useMemo(() => plannedItems(tracked, calendar.episodes, digital.data, calendar.today), [tracked, calendar.episodes, digital.data, calendar.today]);
  const plannedTotal = useMemo(() => Object.values(tracked).filter((entry) => entry.status === "planned").length, [tracked]);
  const continueKeys = useMemo(() => new Set(continueItems.map((item) => titleKey(item.title.type, item.title.id))), [continueItems]);

  const scrollTop = () => pageRef.current?.closest(".page-scroller")?.scrollTo({ top: 0, behavior: "smooth" });

  useEffect(() => {
    const refresh = () => {
      popular.reload();
      forgetMoodPicks();
      setMoodGeneration((value) => value + 1);
      setSurprise(null);
      scrollTop();
    };
    window.addEventListener(homeRefreshEvent, refresh);
    return () => window.removeEventListener(homeRefreshEvent, refresh);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const rollSurprise = useCallback(async (shown?: PickSlide[] | null) => {
    if (shown !== undefined) shownRef.current = shown;
    const avoid = new Set(planned.claims);
    for (const item of shownRef.current ?? []) avoid.delete(key(item));
    if (surprise) avoid.add(key(surprise));
    setRolling(true);
    const found = await surprisePick(mood, avoid, shownRef.current).finally(() => setRolling(false));
    if (!found) {
      useUi.getState().toast(t("home.mood.noSurprise"), "info");
      return;
    }
    setSurprise(found);
    scrollTop();
  }, [planned.claims, surprise, mood, t]);

  const openCustomize = useCallback(() => setCustomizing(true), []);
  const menu = (id: HomeBlockId) => <RowMenu block={id} onCustomize={openCustomize} />;
  const popularSlides = useMemo(() => (popular.data ?? []).filter((item) => item.backdrop && item.overview).slice(0, pickCount), [popular.data]);

  const renderBlock = (id: HomeBlockId): ReactNode => {
    switch (id) {
      case "pick":
        if (surprise) return <HomePick key={`${surprise.type}:${surprise.id}`} slides={[surprise]} mode="surprise" onReroll={() => void rollSurprise()} onLeave={() => setSurprise(null)} />;
        if (isNew) return <HomeStarter posters={popular.data ?? []} />;
        if (picks.length > 0) return <HomePick slides={picks} mode="pick" onDismiss={dismissRecommendation} />;
        if (feed.available && rows === null) return <HomePick slides={[]} mode="pick" />;
        if (offline) return null;
        return <HomePick slides={popularSlides} mode="popular" />;
      case "continue":
        if (offline)
          return (
            <>
              <ContinueRow items={continueItems} offline menu={menu(id)} />
              <DownloadedRow skip={continueKeys} />
            </>
          );
        return continueItems.length > 0 ? <ContinueRow items={continueItems} offline={false} menu={menu(id)} /> : null;
      case "month":
        return <MonthCard />;
      case "forYou":
        return (
          <MoodRecs
            title={isNew ? t("home.row.moods") : undefined}
            mood={mood}
            onMood={setMood}
            baseItems={feed.available ? (rows === null ? null : planned.forYou) : undefined}
            skip={planned.beforeForYou}
            moodSkip={planned.moodSkip}
            generation={moodGeneration}
            onDismiss={dismissRecommendation}
            onSurprise={(shown) => void rollSurprise(shown as PickSlide[] | null)}
            rolling={rolling}
            menu={menu(id)}
          />
        );
      case "week":
        return <WeekStrip episodes={calendar.episodes} today={calendar.today} menu={menu(id)} />;
      case "fresh":
        return <FreshRow forYou={planned.fresh} skip={planned.claims} offline={offline} onDismiss={dismissRecommendation} menu={menu(id)} />;
      case "similar":
        return planned.similar.length > 0
          ? planned.similar.map((row) => <PosterRow key={row.id} title={row.title} items={row.items} onDismiss={dismissRecommendation} rowId={row.id} menu={menu(id)} />)
          : null;
      case "planned":
        return plannedList.length > 0 ? <PlannedRow items={plannedList} total={plannedTotal} menu={menu(id)} /> : null;
      case "daily":
        return planned.daily ? <DailyPick row={planned.daily} onDismiss={dismissRecommendation} menu={menu(id)} /> : null;
      case "popular":
        if (offline) return null;
        return isNew ? (
          <>
            <PopularRow menu={menu(id)} />
            <BestRow />
          </>
        ) : (
          <PopularRow menu={menu(id)} />
        );
    }
  };

  const blocks = visible.map((id) => ({ id, node: renderBlock(id) })).filter((block) => block.node !== null);

  return (
    <div className="page page--flush home" ref={pageRef}>
      {offline && <OfflineBanner onRetry={popular.reload} />}
      {blocks.map((block) => (
        <div key={block.id} className={block.id === "pick" ? "home__bleed" : "home__block"}>
          {block.node}
        </div>
      ))}
      {offline && !visible.includes("continue") && (
        <div className="home__block">
          <DownloadedRow skip={continueKeys} />
        </div>
      )}
      <div className="home__block">
        <HomeEnd onCustomize={openCustomize} />
      </div>
      {customizing && <CustomizeHome onClose={() => setCustomizing(false)} />}
    </div>
  );
}
