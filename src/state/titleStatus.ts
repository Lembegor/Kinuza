import { t, tn } from "../lib/i18n";
import { tmdb } from "../lib/tmdb";
import { watchedEpisodeCount } from "./library";
import { localDay } from "./calendar";
import { isWatched, titleKey, unitKey, useLibrary, type Progress, type TitleRef, type WatchStatus } from "./library";
import { useUi } from "./ui";

const specialsSeason = 0;

async function markAiredEpisodes(title: TitleRef, expected: WatchStatus = "completed"): Promise<void> {
  const details = await tmdb.details("tv", title.id);
  const today = localDay(new Date());
  const seasons = details.seasons.filter((season) => season.seasonNumber !== specialsSeason);
  const lists = await Promise.all(seasons.map((season) => tmdb.season(title.id, season.seasonNumber).catch(() => [])));
  const state = useLibrary.getState();
  if (state.tracked[titleKey(title.type, title.id)]?.status !== expected) return;
  const previous: Record<string, Progress | undefined> = {};
  const entries = lists
    .flat()
    .filter((episode) => episode.airDate !== "" && episode.airDate <= today)
    .map((episode) => ({
      unitKey: unitKey("tv", title.id, episode.season, episode.episode),
      context: { title, season: episode.season, episode: episode.episode, episodeName: episode.name },
    }))
    .filter((entry) => !isWatched(state.progress[entry.unitKey]));
  if (entries.length === 0) return;
  for (const entry of entries) previous[entry.unitKey] = state.progress[entry.unitKey];
  state.setManyWatched(entries, true);
  useUi.getState().toast(t("title.completed.marked", { episodes: tn("common.episodes", entries.length) }), "info", {
    label: t("feed.dismissed.undo"),
    run: () => {
      const library = useLibrary.getState();
      const fresh = entries.filter((entry) => !previous[entry.unitKey]);
      library.setManyWatched(fresh, false);
      for (const entry of entries) {
        const before = previous[entry.unitKey];
        if (before) library.restoreProgress(entry.unitKey, before);
      }
    },
  });
}

export function applyStatus(title: TitleRef, status: WatchStatus | null): void {
  const state = useLibrary.getState();
  const previous = state.tracked[titleKey(title.type, title.id)];
  const leavingCompleted = previous?.status === "completed" && status !== "completed";
  state.setStatus(title, status);
  if (title.type === "movie") {
    const movieKey = unitKey("movie", title.id);
    if (status === "completed") state.setWatched(movieKey, true, { title });
    else if (leavingCompleted && state.progress[movieKey]) state.setWatched(movieKey, false, { title });
    return;
  }
  if (status === "completed" && previous?.status !== "completed") void markAiredEpisodes(title).catch(() => undefined);
}

const startedSeconds = 60;

function startedSeries(progress: Record<string, Progress>, id: number): boolean {
  const prefix = `tv:${id}:`;
  return watchedEpisodeCount(progress, id) > 0 || Object.entries(progress).some(([key, item]) => key.startsWith(prefix) && item.position >= startedSeconds);
}

async function offerAiredEpisodes(title: TitleRef, before: WatchStatus | null): Promise<void> {
  const details = await tmdb.details("tv", title.id).catch(() => null);
  const state = useLibrary.getState();
  const key = titleKey(title.type, title.id);
  if (!state.tracked[key]?.rating || (state.tracked[key]?.status ?? null) !== before) return;
  const name = title.title;
  const ui = useUi.getState();
  const watching = {
    label: t("title.rated.watching"),
    run: () => applyStatus(title, "watching"),
  };
  if (details?.ended) {
    ui.toast(t("title.rated.seriesEnded", { title: name }), "info", { label: t("title.rated.markAll"), run: () => applyStatus(title, "completed") }, watching);
    return;
  }
  ui.toast(
    t("title.rated.seriesOngoing", { title: name }),
    "info",
    {
      label: t("title.rated.markAired"),
      run: () => {
        useLibrary.getState().setStatus(title, "watching");
        void markAiredEpisodes(title, "watching").catch(() => undefined);
      },
    },
    watching,
  );
}

export function applyRating(title: TitleRef, rating: number | null): void {
  const state = useLibrary.getState();
  const key = titleKey(title.type, title.id);
  const before = state.tracked[key]?.status ?? null;
  state.setRating(title, rating);
  if (rating === null || before === "completed" || before === "dropped") return;

  if (title.type === "movie") {
    const movieKey = unitKey("movie", title.id);
    const progressBefore = state.progress[movieKey];
    applyStatus(title, "completed");
    useUi.getState().toast(t("title.rated.movieDone"), "info", {
      label: t("feed.dismissed.undo"),
      run: () => {
        const library = useLibrary.getState();
        library.setStatus(title, before);
        if (progressBefore) library.restoreProgress(movieKey, progressBefore);
        else library.setWatched(movieKey, false, { title });
      },
    });
    return;
  }

  if (before === "onHold") return;
  if (startedSeries(state.progress, title.id)) {
    if (before !== "watching") state.setStatus(title, "watching");
    return;
  }
  void offerAiredEpisodes(title, before).catch(() => undefined);
}
