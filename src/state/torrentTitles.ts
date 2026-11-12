import { useMemo } from "react";
import { useT } from "../lib/i18n";
import { useLibrary, type Progress, type Source } from "./library";

export interface TorrentTitle {
  path: string;
  label: string;
  series: string | null;
  seasons: number[];
  units: string[];
}

export function useTorrentTitles(): Record<string, TorrentTitle> {
  const sources = useLibrary((state) => state.sources);
  const tracked = useLibrary((state) => state.tracked);
  const progress = useLibrary((state) => state.progress);
  const { t } = useT();

  return useMemo(() => {
    const names = new Map<string, string>();
    for (const [key, title] of Object.entries(tracked)) names.set(key, title.title);
    for (const item of Object.values<Progress>(progress)) names.set(`${item.title.type}:${item.title.id}`, item.title.title);

    const result: Record<string, TorrentTitle> = {};
    for (const [unit, list] of Object.entries<Source[]>(sources)) {
      const [type, id, season] = unit.split(":");
      for (const source of list) {
        const known = (result[source.infoHash] ??= {
          path: `/title/${type}/${id}`,
          label: names.get(`${type}:${id}`) ?? t("common.openPage"),
          series: type === "tv" ? `tv:${id}` : null,
          seasons: [],
          units: [],
        });
        if (!known.units.includes(unit)) known.units.push(unit);
        const number = Number(season);
        if (type === "tv" && Number.isFinite(number) && number > 0 && !known.seasons.includes(number)) known.seasons.push(number);
      }
    }
    return result;
  }, [sources, tracked, progress]);
}
