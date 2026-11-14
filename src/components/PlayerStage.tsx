import { pictureBadge, sourceName } from "../lib/releaseNames";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, LoaderCircle, Play, Search } from "lucide-react";
import { arcsOfSeason, inLayout, type EpisodeLayout } from "../lib/episodeLayout";
import { formatRuntime } from "../lib/format";
import { useT } from "../lib/i18n";
import { imageUrl, tmdb, type Details } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";
import { localDay } from "../state/calendar";
import { isWatched, titleKey, unitKey, useLibrary, type TitleRef } from "../state/library";
import { usePlayerPlacement } from "../state/playerPlacement";
import { useUi } from "../state/ui";
import { useHoverWarm } from "../state/warmup";
import { autoPlay, pickKey, preparePick, requestPick, useAutoPick, type PickCandidate, type PickEntry, type PickTarget } from "../state/autoPick";

const specialsSeason = 0;

export function playOnStage(session: Parameters<ReturnType<typeof useUi.getState>["play"]>[0]): void {
  useUi.getState().play(session);
  usePlayerPlacement.getState().requestFocus();
}

export function useStageSession(title: TitleRef | null) {
  const session = useUi((state) => state.player);
  return session && title && session.title.type === title.type && session.title.id === title.id ? session : null;
}

export function PlayerStage({
  title,
  backdrop,
  playUnit,
  playLabel,
  note,
  busy,
  onIntent,
  onPlay,
  side,
  under,
}: {
  title: TitleRef;
  backdrop: string | null;
  playUnit: string | null;
  playLabel: string;
  note?: ReactNode;
  busy?: boolean;
  onIntent?: () => void;
  onPlay: () => void;
  side?: ReactNode;
  under?: ReactNode;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const session = useStageSession(title);
  const active = session !== null;
  const key = titleKey(title.type, title.id);
  const hoverWarm = useHoverWarm(playUnit);
  const image = imageUrl(backdrop, "w1280");

  useLayoutEffect(() => {
    const slot = slotRef.current;
    usePlayerPlacement.getState().setSlot(slot, key);
    return () => {
      if (usePlayerPlacement.getState().slot === slot) usePlayerPlacement.getState().setSlot(null, null);
    };
  }, [key]);

  const focusRequest = usePlayerPlacement((state) => state.focusRequest);
  useLayoutEffect(() => {
    if (!active) return;
    const show = () => {
      const slot = slotRef.current;
      const scroller = slot?.closest(".page-scroller");
      if (slot && scroller) {
        const area = scroller.getBoundingClientRect();
        const rect = slot.getBoundingClientRect();
        const below = rect.bottom - (area.bottom - revealGap);
        const above = rect.top - (area.top + revealGap);
        const shift = below > 0 ? Math.min(below, above) : above < 0 ? above : 0;
        if (Math.abs(shift) > 1) scroller.scrollBy({ top: shift, behavior: "smooth" });
      }
      usePlayerPlacement.getState().setAway(false);
    };
    show();
    const timers = [setTimeout(show, 80), setTimeout(show, 350)];
    return () => timers.forEach(clearTimeout);
  }, [active, focusRequest]);

  return (
    <section className={`stage ${side ? "has-side" : ""} ${active ? "is-playing" : ""}`}>
      <div className="stage__main">
        <div className="stage__slot" ref={slotRef}>
          {!active && (
            <button
              className="stage__poster"
              onClick={onPlay}
              {...hoverWarm}
              onPointerEnter={() => {
                hoverWarm.onPointerEnter();
                onIntent?.();
              }}
            >
              {image && <img src={image} alt="" draggable={false} />}
              <span className="stage__shade" />
              <span className="stage__play">{busy ? <LoaderCircle size={30} className="spin" /> : <Play size={30} fill="currentColor" />}</span>
              <span className="stage__label">{playLabel}</span>
              {note && <span className="stage__note">{note}</span>}
            </button>
          )}
        </div>
        {under}
      </div>
      {side && <aside className="stage__side">{side}</aside>}
    </section>
  );
}

export function StageEpisodes({
  details,
  title,
  season,
  layout,
  pickBase,
  onSeasonChange,
  onFind,
}: {
  details: Details;
  title: TitleRef;
  season: number;
  layout: EpisodeLayout | null;
  pickBase?: Omit<PickTarget, "season" | "episode"> | null;
  onSeasonChange: (season: number) => void;
  onFind: (season: number, episode: number) => void;
}) {
  const [picking, setPicking] = useState<string | null>(null);
  const { t } = useT();
  const session = useStageSession(title);
  const sources = useLibrary((state) => state.sources);
  const progress = useLibrary((state) => state.progress);
  const episodes = useAsync(() => tmdb.season(details.id, season), [details.id, season]);
  const listRef = useRef<HTMLDivElement>(null);
  const today = localDay(new Date());

  const seasons = useMemo(
    () =>
      details.seasons.map((item) => {
        const arcs = layout && inLayout(layout, item.seasonNumber) ? arcsOfSeason(layout, item.seasonNumber) : [];
        const range = arcs.length > 0 ? ` · ${arcs[0].first}-${arcs[arcs.length - 1].last}` : "";
        const name =
          item.seasonNumber === specialsSeason
            ? t("common.specials")
            : arcs.length > 0 && item.name
              ? item.name
              : t("common.season", { season: item.seasonNumber });
        return { number: item.seasonNumber, label: `${name}${range}` };
      }),
    [details.seasons, layout, t],
  );

  const currentKey = session?.unitKey ?? null;
  useEffect(() => {
    if (session?.season !== undefined && session.season !== season) onSeasonChange(session.season);
  }, [session?.unitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(".stage-episode.is-current, .stage-episode.is-next");
    if (list && row) list.scrollTo({ top: row.offsetTop - list.clientHeight / 2 + row.clientHeight / 2 });
  }, [episodes.data, currentKey]);

  const nextKey = useMemo(() => {
    if (currentKey) return null;
    const pending = (episodes.data ?? []).find((episode) => !isWatched(progress[unitKey("tv", details.id, episode.season, episode.episode)]));
    return pending ? unitKey("tv", details.id, pending.season, pending.episode) : null;
  }, [episodes.data, progress, currentKey, details.id]);

  return (
    <div className="stage-episodes">
      <div className="stage-episodes__head">
        {seasons.length > 1 ? (
          <select className="select stage-episodes__season" value={season} aria-label={t("title.seasonPick")} onChange={(event) => onSeasonChange(Number(event.target.value))}>
            {seasons.map((item) => (
              <option key={item.number} value={item.number}>
                {item.label}
              </option>
            ))}
          </select>
        ) : (
          <strong>{t("title.episodes")}</strong>
        )}
        {episodes.data && <span className="stage-episodes__count">{episodes.data.length}</span>}
      </div>
      <div className="stage-episodes__list" ref={listRef}>
        {(episodes.data ?? []).map((episode) => {
          const key = unitKey("tv", details.id, episode.season, episode.episode);
          const playable = (sources[key]?.length ?? 0) > 0;
          const saved = progress[key];
          const watched = isWatched(saved);
          const share = saved && saved.duration > 1 && !watched ? Math.min(1, saved.position / saved.duration) : 0;
          const aired = episode.airDate !== "" && episode.airDate <= today;
          const current = key === currentKey;
          return (
            <button
              key={key}
              className={`stage-episode ${current ? "is-current" : ""} ${key === nextKey ? "is-next" : ""} ${watched ? "is-watched" : ""} ${!aired ? "is-upcoming" : ""}`}
              disabled={!aired && !playable}
              onClick={() => {
                if (current || picking) return;
                const start = () => playOnStage({ title, unitKey: key, season: episode.season, episode: episode.episode, episodeName: episode.name });
                if (playable) {
                  start();
                  return;
                }
                if (!pickBase) {
                  onFind(episode.season, episode.episode);
                  return;
                }
                setPicking(key);
                autoPlay({ ...pickBase, season: episode.season, episode: episode.episode })
                  .then((found) => (found ? start() : onFind(episode.season, episode.episode)))
                  .catch(() => onFind(episode.season, episode.episode))
                  .finally(() => setPicking(null));
              }}
            >
              <span className="stage-episode__number">{episode.episode}</span>
              <span className="stage-episode__text">
                <span className="stage-episode__name">{episode.name}</span>
                <span className="stage-episode__meta">
                  {current
                    ? t("stage.episode.now")
                    : !aired
                      ? t("stage.episode.upcoming")
                      : picking === key
                        ? t("stage.pick.searching")
                        : [formatRuntime(episode.runtimeMinutes), playable ? "" : t(pickBase ? "stage.episode.auto" : "stage.episode.noSource")].filter(Boolean).join(" · ")}
                </span>
                {share > 0 && (
                  <span className="bar bar--thin stage-episode__bar">
                    <i style={{ width: `${share * 100}%` }} />
                  </span>
                )}
              </span>
              <span className="stage-episode__state">
                {picking === key ? (
                  <LoaderCircle size={14} className="spin" />
                ) : current ? (
                  <Play size={13} fill="currentColor" />
                ) : watched ? (
                  <Check size={14} />
                ) : !playable && aired ? (
                  <Search size={13} />
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const prepareAfterMs = 2500;

export function useStagePick(target: PickTarget | null): { key: string | null; entry: PickEntry | undefined; chosen: PickCandidate | null } {
  const key = target ? pickKey(target) : null;
  const entry = useAutoPick((state) => (key ? state.entries[key] : undefined));

  useEffect(() => {
    if (target) void requestPick(target);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!key || entry?.status !== "ready" || !entry.chosenId) return;
    const timer = setTimeout(() => void preparePick(key, false).catch(() => undefined), prepareAfterMs);
    return () => clearTimeout(timer);
  }, [key, entry?.status, entry?.chosenId]);

  const chosen = entry?.candidates.find((candidate) => candidate.id === entry.chosenId) ?? null;
  return { key, entry, chosen };
}

const revealGap = 16;

export function PickNote({ entry, chosen }: { entry: PickEntry | undefined; chosen: PickCandidate | null }) {
  const { t, tn } = useT();
  if (!entry || entry.status === "searching") {
    return (
      <>
        <LoaderCircle size={13} className="spin" />
        {t("stage.pick.searching")}
      </>
    );
  }
  if (entry.status === "ready" && chosen) {
    return (
      <>
        <i className={`health health--${chosen.health}`} />
        {[pictureBadge(chosen.resolution, chosen.quality).label, sourceName(chosen.quality).name, chosen.voiceText || chosen.voices].filter(Boolean).join(" · ")} ·{" "}
        {tn("stage.pick.seeds", chosen.seeds)}
        {chosen.health !== "good" && <em>{t(chosen.health === "weak" ? "stage.pick.weak" : "stage.pick.poor")}</em>}
      </>
    );
  }
  if (entry.status === "none") return <>{t("stage.pick.none")}</>;
  return <>{t(entry.problem === "login" || entry.problem === "down" || entry.problem === "auth" ? "stage.pick.serverDown" : "stage.pick.failed")}</>;
}
