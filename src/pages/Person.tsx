// Person page: who they are and the films and series they directed or acted in.

import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { UserRound } from "lucide-react";
import { CatalogError, EmptyState, PosterGrid } from "../components/Cards";
import { formatDate } from "../lib/format";
import { useT, type MessageKey } from "../lib/i18n";
import { imageUrl, tmdb, type MediaItem } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";

/** Titles of a role shown before "show all": about two rows of the grid. */
const collapsedCreditCount = 12;
const actingDepartment = "Acting";

/** TMDB names departments in English only. */
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

/** A few lines of the biography, with the rest behind "show more" when there is a rest. */
function Biography({ text }: { text: string }) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);

  // Whether the text is cut depends on the window width, so it is measured again on every resize.
  // An expanded text cannot be measured: it keeps the answer it had while collapsed.
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

function Credits({ title, items }: { title: string; items: MediaItem[] }) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const visible = expanded ? items : items.slice(0, collapsedCreditCount);
  return (
    <section className="section">
      <div className="section__head">
        <h2>{title}</h2>
        <span className="section__note">{items.length}</span>
      </div>
      <PosterGrid items={visible} />
      {visible.length < items.length && (
        <div className="browse-more">
          <button className="button button--large" onClick={() => setExpanded(true)}>
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

      {/* The work a person is known for comes first. */}
      {data.department === actingDepartment ? [acted, directed] : [directed, acted]}

      {data.directed.length === 0 && data.acted.length === 0 && (
        <EmptyState icon={<UserRound size={40} />} title={t("person.empty.title")} text={t("person.empty.text")} />
      )}
    </div>
  );
}
