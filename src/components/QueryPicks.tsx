import { Sparkles } from "lucide-react";
import { PosterRow } from "./Cards";
import { catalogSearch } from "../lib/catalog";
import { currentLanguage, useT } from "../lib/i18n";
import { parseQuery, type IntentChip, type QueryIntent } from "../lib/queryIntent";
import { askEngine, defaultWeights, diversify, engineAvailable, itemsFor, scoreAll, seedFromSignal } from "../lib/recommender";
import { key, tasteSignals } from "../lib/taste";
import { tmdb, type MediaItem } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";
import { useLibrary } from "../state/library";

const pickLimit = 24;
const fewestPersonal = 8;
const personalSeeds = 60;

async function picksFor(intent: QueryIntent): Promise<MediaItem[]> {
  const { tracked, progress, dismissed } = useLibrary.getState();
  const exclude = [
    ...Object.entries(tracked)
      .filter(([, entry]) => entry.status === "completed" || entry.status === "dropped")
      .map(([titleKey]) => titleKey),
    ...Object.keys(dismissed),
  ];
  const options = { filters: intent.filters, singleCluster: true, exclude, limit: 120 };
  let seeds = tasteSignals(tracked, progress, Date.now())
    .filter((signal) => signal.weight > 0)
    .slice(0, personalSeeds)
    .map((signal) => seedFromSignal(signal));
  if (intent.like) {
    const found = (await catalogSearch(intent.like).catch(() => []))[0]?.item;
    if (!found) return [];
    seeds = [{ key: key(found), weight: 1 }];
  }
  let response = await askEngine(seeds, options);
  if (!response) return [];
  if (!intent.like && response.candidates.length < fewestPersonal) {
    const general = await askEngine([], options);
    if (general) response = { ...response, candidates: [...response.candidates, ...general.candidates] };
  }
  const scored = scoreAll({
    response,
    behaviour: null,
    impressions: new Map(),
    intent: { keys: new Map(), genres: new Map() },
    uiLanguage: currentLanguage(),
    weights: defaultWeights,
    now: Date.now(),
  });
  const unique = scored.filter((entry, index) => scored.findIndex((other) => other.candidate.key === entry.candidate.key) === index);
  const chosen = diversify(unique, pickLimit + 6);
  const items = await itemsFor(chosen.map((entry) => entry.candidate.key));
  return chosen.flatMap((entry) => {
    const item = items.get(entry.candidate.key);
    return item?.poster ? [item] : [];
  }).slice(0, pickLimit);
}

function useChipLabel(): (chip: IntentChip, genres: Map<number, string>) => string {
  const { t, locale } = useT();
  const regions = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames([locale], { type: "region" }) : null;
  return (chip, genres) => {
    switch (chip.kind) {
      case "like":
        return t("query.like", { title: chip.text });
      case "genre": {
        const name = (genres.get(chip.id) ?? "").toLowerCase();
        return chip.without ? t("query.without", { genre: name }) : name;
      }
      case "type":
        return t(`query.type.${chip.value}`);
      case "length":
        return t(`query.length.${chip.value}`);
      case "era":
        return t(`query.era.${chip.value}`);
      case "decade":
        return chip.from === chip.to ? String(chip.from) : t("query.decade", { from: chip.from, to: chip.to });
      case "country":
        return chip.code === "SU" ? t("query.country.su") : (regions?.of(chip.code) ?? chip.code);
    }
  };
}

export function QueryPicks({ query }: { query: string }) {
  const { t } = useT();
  const intent = parseQuery(query);
  const label = useChipLabel();
  const picks = useAsync(
    async () => (engineAvailable() && intent.meaningful ? { query, items: await picksFor(intent) } : { query, items: [] as MediaItem[] }),
    [query],
  );
  const genres = useAsync(() => tmdb.genreNames().catch(() => new Map<number, string>()), []);
  if (!intent.meaningful || !engineAvailable()) return null;
  const items = picks.data?.query === query ? picks.data.items : null;
  if (items && items.length === 0) return null;
  const chips = intent.chips.map((chip) => label(chip, genres.data ?? new Map())).filter(Boolean);
  return (
    <section className="section section--first query-picks">
      <div className="query-picks__understood">
        <Sparkles size={15} />
        <span>{t("query.understood")}</span>
        {chips.map((chip) => (
          <span key={chip} className="chip chip--compact chip--static">
            {chip}
          </span>
        ))}
      </div>
      <PosterRow title={t("search.picks")} items={items} />
    </section>
  );
}
