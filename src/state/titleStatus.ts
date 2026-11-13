import { t, tn } from "../lib/i18n";
import { tmdb } from "../lib/tmdb";
import { localDay } from "./calendar";
import { isWatched, titleKey, unitKey, useLibrary, type Progress, type TitleRef, type WatchStatus } from "./library";
import { useUi } from "./ui";

const specialsSeason = 0;

async function markAiredEpisodes(title: TitleRef): Promise<void> {
  const details = await tmdb.details("tv", title.id);
  const today = localDay(new Date());
  const seasons = details.seasons.filter((season) => season.seasonNumber !== specialsSeason);
  const lists = await Promise.all(seasons.map((season) => tmdb.season(title.id, season.seasonNumber).catch(() => [])));
  const state = useLibrary.getState();
  if (state.tracked[titleKey(title.type, title.id)]?.status !== "completed") return;
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
