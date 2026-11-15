import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { UserRound } from "lucide-react";
import { CatalogError, EmptyState, PosterGrid } from "../components/Cards";
import { formatDate } from "../lib/format";
import { useT, type MessageKey } from "../lib/i18n";
import { imageUrl, tmdb, type MediaItem } from "../lib/tmdb";
import { imdbRatingOf } from "../lib/imdbRatings";
import { useAsync } from "../lib/useAsync";
import { useSettings, type CreditsSort } from "../state/settings";
import { useGridColumns } from "../lib/useGridColumns";

const collapsedRows = 2;
const stepRows = 4;
const actingDepartment = "Acting";

const departmentLabels: Record<string, MessageKey> = {
  Acting: "person.department.acting",
  Directing: "person.department.directing",
  Writing: "person.department.writing",
  Production: "person.department.production",
  Creator: "person.department.creator",
  Camera: "person.department.camera",
  Editing: "person.department.editing",
  Sound: "person.department.sound",
  Art: "person.department.art",
  "Costume & Make-Up": "person.department.costume",
  "Visual Effects": "person.department.effects",
  Lighting: "person.department.lighting",
  Crew: "person.department.crew",
};

function Biography({ text }: { text: string }) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const element = textRef.current;
    if (!element || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, text]);

  return (
    <div className="person__bio">
      <p ref={textRef} className={expanded ? "" : "is-collapsed"}>
        {text}
      </p>
      {overflows && (
        <button className="text-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? t("person.bio.less") : t("person.bio.more")}
        </button>
      )}
    </div>
  );
}

const creditsSorts: CreditsSort[] = ["rating", "popular", "newest", "oldest"];
const typicalRating = 6.4;
const imdbVotesWeight = 3000;
const catalogVotesWeight = 200;

function weighted(rating: number, votes: number, weight: number): number {
  return (rating * votes + typicalRating * weight) / (votes + weight);
}

function useImdbScores(items: MediaItem[], wanted: boolean): Map<string, number> {
  const [scores, setScores] = useState<Map<string, number>>(() => new Map());
  useEffect(() => {
    if (!wanted || items.length === 0) return;
    let cancelled = false;
    void Promise.all(
      items.map(async (item) => {
        const imdb = await imdbRatingOf(item.type, item.id).catch(() => null);
        const key: string = `${item.type}:${item.id}`;
        return { key, score: imdb ? weighted(imdb.rating, imdb.votes, imdbVotesWeight) : null };
      }),
    ).then((found) => {
      if (cancelled) return;
      const next = new Map<string, number>();
      for (const { key, score } of found) if (score !== null) next.set(key, score);
      setScores(next);
    });
    return () => {
      cancelled = true;
    };
  }, [items, wanted]);
  return scores;
}

function sortCredits(items: MediaItem[], sort: CreditsSort, scores: Map<string, number>): MediaItem[] {
  const year = (item: MediaItem) => Number(item.year) || 0;
  const score = (item: MediaItem) =>
    scores.get(`${item.type}:${item.id}`) ?? (item.voteCount > 0 ? weighted(item.rating, item.voteCount, catalogVotesWeight) : 0);
  const sorted = [...items];
  if (sort === "rating") sorted.sort((a, b) => score(b) - score(a) || b.voteCount - a.voteCount);
  if (sort === "newest") sorted.sort((a, b) => (year(b) || 9999) - (year(a) || 9999));
  if (sort === "oldest") sorted.sort((a, b) => (year(a) || 9999) - (year(b) || 9999));
  return sorted;
}

function CreditsSortChips() {
  const { t } = useT();
  const sort = useSettings((state) => state.creditsSort);
  return (
    <div className="chips person__sort" role="group" aria-label={t("person.sort.label")}>
      {creditsSorts.map((option) => (
        <button key={option} className={`chip chip--compact ${sort === option ? "is-active" : ""}`} aria-pressed={sort === option} onClick={() => useSettings.getState().patch({ creditsSort: option })}>
          {t(`person.sort.${option}`)}
        </button>
      ))}
    </div>
  );
}

function Credits({ title, items: given }: { title: string; items: MediaItem[] }) {
  const { t } = useT();
  const sort = useSettings((state) => state.creditsSort);
  const scores = useImdbScores(given, sort === "rating");
  const items = useMemo(() => sortCredits(given, sort, scores), [given, sort, scores]);
  const [rows, setRows] = useState(collapsedRows);
  const gridRef = useRef<HTMLDivElement>(null);
  const columns = useGridColumns(gridRef);
  if (items.length === 0) return null;
  const visible = items.slice(0, rows * columns);
  const left = items.length - visible.length;
  return (
    <section className="section">
      <div className="section__head">
        <h2>{title}</h2>
        <span className="section__note">{items.length}</span>
      </div>
      <PosterGrid items={visible} gridRef={gridRef} />
      {left > 0 && (
        <div className="browse-more">
          <button className="button button--large" onClick={() => setRows(rows + stepRows)}>
            {t("person.credits.more", { count: Math.min(left, stepRows * columns) })}
          </button>
          <button className="text-button" onClick={() => setRows(Math.ceil(items.length / columns))}>
            {t("person.credits.all", { count: items.length })}
          </button>
        </div>
      )}
    </section>
  );
}

export default function PersonPage() {
  const id = Number(useParams().id);
  const { t } = useT();
  const person = useAsync(() => tmdb.person(id), [id]);
  const data = person.data && person.data.id === id ? person.data : null;

  if (person.error) {
    return (
      <div className="page">
        <CatalogError onRetry={person.reload} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="page">
        <div className="person person--skeleton" />
      </div>
    );
  }

  const photo = imageUrl(data.photo, "w342");
  const department = departmentLabels[data.department];
  const facts = [
    { label: t("person.knownFor"), value: department ? t(department) : "" },
    { label: t("person.born"), value: formatDate(data.birthday) },
    { label: t("person.died"), value: formatDate(data.deathday) },
    { label: t("person.birthplace"), value: data.birthplace },
  ].filter((fact) => fact.value);

  const hasCredits = data.directed.length > 0 || data.acted.length > 0;
  const directed = <Credits key="directed" title={t("person.directed")} items={data.directed} />;
  const acted = <Credits key="acted" title={t("person.acted")} items={data.acted} />;

  return (
    <div className="page">
      <section className="person">
        <div className="person__photo">{photo ? <img src={photo} alt="" draggable={false} /> : <UserRound size={64} />}</div>
        <div className="person__info">
          <h1>{data.name}</h1>
          {facts.length > 0 && (
            <dl className="person__facts">
              {facts.map((fact) => (
                <div key={fact.label}>
                  <dt>{fact.label}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {data.biography && <Biography key={data.id} text={data.biography} />}
        </div>
      </section>

      {hasCredits && <CreditsSortChips />}
      {data.department === actingDepartment ? [acted, directed] : [directed, acted]}

      {data.directed.length === 0 && data.acted.length === 0 && (
        <EmptyState icon={<UserRound size={40} />} title={t("person.empty.title")} text={t("person.empty.text")} />
      )}
    </div>
  );
}
