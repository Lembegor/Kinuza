import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { PosterCard, PosterRow, Row, type CardItem, type DismissDetail } from "../Cards";
import { useT, type MessageKey } from "../../lib/i18n";
import { key } from "../../lib/taste";
import type { MediaItem } from "../../lib/tmdb";
import { useBestList, useFreshList, usePopularList, type BestTab, type FreshTab, type PopularTab } from "../../state/homeFeed";
import type { TitleRef } from "../../state/library";
import { useSettings } from "../../state/settings";

const topCount = 10;
const rowLimit = 18;

function Tabs<T extends string>({ tabs, active, onChoose, label }: { tabs: { id: T; labelKey: MessageKey }[]; active: T; onChoose: (id: T) => void; label: string }) {
  const { t } = useT();
  return (
    <div className="segmented home-tabs" role="radiogroup" aria-label={label}>
      {tabs.map((tab) => (
        <button key={tab.id} role="radio" aria-checked={tab.id === active} className={tab.id === active ? "is-active" : ""} onClick={() => onChoose(tab.id)}>
          {t(tab.labelKey)}
        </button>
      ))}
    </div>
  );
}

const freshTabs: { id: FreshTab; labelKey: MessageKey }[] = [
  { id: "forYou", labelKey: "home.tab.forYou" },
  { id: "movies", labelKey: "home.tab.movies" },
  { id: "series", labelKey: "home.tab.series" },
  { id: "anime", labelKey: "home.tab.anime" },
];

const freshBrowse: Record<FreshTab, string> = {
  forYou: "/browse?kind=movie&sort=newest",
  movies: "/browse?kind=movie&sort=newest",
  series: "/browse?kind=tv&sort=newest",
  anime: "/browse?kind=anime&sort=newest",
};

function unseen(items: MediaItem[] | null, skip: Set<string>): CardItem[] | null {
  return items ? items.filter((item) => item.poster && !skip.has(key(item))).slice(0, rowLimit) : null;
}

function FreshList({ tab, skip, children }: { tab: Exclude<FreshTab, "forYou">; skip: Set<string>; children: (items: CardItem[] | null, failed: boolean) => ReactNode }) {
  const list = useFreshList(tab, true);
  const items = useMemo(() => unseen(list.data, skip), [list.data, skip]);
  return <>{children(items, Boolean(list.error) && !list.data)}</>;
}

export function FreshRow({
  forYou,
  skip,
  offline,
  onDismiss,
  menu,
}: {
  forYou: CardItem[] | null;
  skip: Set<string>;
  offline: boolean;
  onDismiss: (item: TitleRef, detail: DismissDetail) => void;
  menu?: ReactNode;
}) {
  const { t } = useT();
  const navigate = useNavigate();
  const saved = useSettings((state) => state.homeFreshTab) as FreshTab;
  const tabs = freshTabs.filter((tab) => (tab.id === "forYou" ? forYou !== null && forYou.length > 0 : !offline));
  if (tabs.length === 0) return null;
  const active = tabs.find((tab) => tab.id === saved)?.id ?? tabs[0].id;
  const choose = (id: FreshTab) => useSettings.getState().patch({ homeFreshTab: id });
  const aside = tabs.length > 1 ? <Tabs tabs={tabs} active={active} onChoose={choose} label={t("home.row.fresh")} /> : undefined;
  const common = { title: t("home.row.fresh"), aside, menu, more: { label: t("home.fresh.all"), onClick: () => navigate(freshBrowse[active]) } };
  if (active === "forYou") return <PosterRow {...common} items={forYou} onDismiss={onDismiss} rowId="fresh" />;
  return (
    <FreshList key={active} tab={active} skip={skip}>
      {(items, failed) => (failed ? null : <PosterRow {...common} items={items} />)}
    </FreshList>
  );
}

const popularTabs: { id: PopularTab; labelKey: MessageKey }[] = [
  { id: "all", labelKey: "home.tab.all" },
  { id: "movies", labelKey: "home.tab.movies" },
  { id: "series", labelKey: "home.tab.series" },
  { id: "anime", labelKey: "home.tab.anime" },
];

function PopularList({ tab }: { tab: PopularTab }) {
  const { t } = useT();
  const list = usePopularList(tab, true);
  const items = (list.data ?? []).filter((item) => item.poster).slice(0, topCount);
  if (list.data === null) {
    return (
      <>
        {Array.from({ length: 7 }, (_, index) => (
          <div key={index} className="top-card">
            <span className="top-card__number">{index + 1}</span>
            <div className="poster-card poster-card--skeleton" />
          </div>
        ))}
      </>
    );
  }
  if (items.length === 0) return <p className="row__empty">{t("home.popular.empty")}</p>;
  return (
    <>
      {items.map((item, index) => (
        <div key={`${item.type}:${item.id}`} className="top-card">
          <span className="top-card__number" aria-hidden="true">
            {index + 1}
          </span>
          <PosterCard item={item} />
        </div>
      ))}
    </>
  );
}

export function PopularRow({ menu }: { menu?: ReactNode }) {
  const { t } = useT();
  const navigate = useNavigate();
  const saved = useSettings((state) => state.homePopularTab) as PopularTab;
  const active = popularTabs.find((tab) => tab.id === saved)?.id ?? "all";
  return (
    <Row
      title={t("home.row.popular")}
      className="home-top"
      aside={<Tabs tabs={popularTabs} active={active} onChoose={(id) => useSettings.getState().patch({ homePopularTab: id })} label={t("home.row.popular")} />}
      more={{ label: t("home.catalog"), onClick: () => navigate(active === "all" ? "/browse" : `/browse?kind=${active === "movies" ? "movie" : active === "series" ? "tv" : "anime"}`) }}
      menu={menu}
    >
      <PopularList key={active} tab={active} />
    </Row>
  );
}

const bestTabs: { id: BestTab; labelKey: MessageKey }[] = [
  { id: "movies", labelKey: "home.tab.movies" },
  { id: "series", labelKey: "home.tab.series" },
];

function BestList({ tab, title, aside, more }: { tab: BestTab; title: string; aside: ReactNode; more: { label: string; onClick: () => void } }) {
  const list = useBestList(tab);
  const items = useMemo(() => (list.data ?? null)?.filter((item) => item.poster).slice(0, rowLimit) ?? null, [list.data]);
  if (list.error && !list.data) return null;
  return <PosterRow title={title} aside={aside} more={more} items={items} />;
}

export function BestRow() {
  const { t } = useT();
  const navigate = useNavigate();
  const [tab, setTab] = useState<BestTab>("movies");
  return (
    <BestList
      key={tab}
      tab={tab}
      title={t("home.row.best")}
      aside={<Tabs tabs={bestTabs} active={tab} onChoose={setTab} label={t("home.row.best")} />}
      more={{ label: t("home.catalog"), onClick: () => navigate(`/browse?kind=${tab === "movies" ? "movie" : "tv"}&sort=rating`) }}
    />
  );
}
