import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ImageDown } from "lucide-react";
import { backend, describeError, isDesktop } from "../../lib/backend";
import { t, useT } from "../../lib/i18n";
import { dayKey, overview, type Ledger, type Overview } from "../../lib/profileStats";
import { formatHoursShort, formatNumber, formatSeconds, monthNameStandalone } from "../../lib/profileFormat";
import { imageUrl } from "../../lib/tmdb";
import { useLibrary, type TrackEntry } from "../../state/library";
import { useProfile } from "../../state/profile";
import { useUi } from "../../state/ui";

const leastYearSeconds = 3600;
const decemberIndex = 11;

export function recapYears(ledger: Ledger, now: number): number[] {
  const current = new Date(now);
  const totals = new Map<number, number>();
  for (const entry of ledger.entries) {
    if (entry.at === null) continue;
    const year = new Date(entry.at).getFullYear();
    totals.set(year, (totals.get(year) ?? 0) + entry.seconds);
  }
  return [...totals.entries()]
    .filter(([year, seconds]) => seconds >= leastYearSeconds && (year < current.getFullYear() || (year === current.getFullYear() && current.getMonth() === decemberIndex)))
    .map(([year]) => year)
    .sort((a, b) => b - a);
}

function yearStreak(data: Overview, year: number): number {
  const days = [...data.days.keys()].filter((day) => day.startsWith(`${year}-`)).sort();
  let longest = 0;
  let run = 0;
  let previous: number | null = null;
  for (const day of days) {
    const [y, m, d] = day.split("-").map(Number);
    const value = Math.round(new Date(y, m - 1, d).getTime() / 86_400_000);
    run = previous !== null && value - previous === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = value;
  }
  return longest;
}

function bestRated(ledger: Ledger, tracked: Record<string, TrackEntry>, from: number, to: number): TrackEntry[] {
  const keys = new Set(ledger.entries.filter((entry) => entry.finish && entry.at !== null && entry.at >= from && entry.at < to).map((entry) => entry.key));
  return [...keys]
    .map((key) => tracked[key])
    .filter((entry): entry is TrackEntry => Boolean(entry && entry.rating && entry.rating >= 8))
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, 5);
}

async function saveImage(year: number, name: string, data: Overview, streak: number): Promise<void> {
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1350;
  const context = canvas.getContext("2d");
  if (!context) return;
  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue("--accent").trim() || "#e23a3f";
  const text = "#f3efe8";
  const muted = "#a09eab";
  context.fillStyle = "#0a0a0d";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = accent;
  context.fillRect(0, 0, canvas.width, 14);
  const font = (size: number, weight = 700) => `${weight} ${size}px "Manrope Variable", "Segoe UI", sans-serif`;
  context.fillStyle = muted;
  context.font = font(34, 600);
  context.fillText(`KINUZA · ${t("profile.year.title", { year })}`, 80, 120);
  context.fillStyle = text;
  context.font = font(52, 800);
  context.fillText(name, 80, 196);
  context.fillStyle = accent;
  context.font = font(150, 800);
  context.fillText(formatHoursShort(data.seconds), 80, 390);
  context.fillStyle = muted;
  context.font = font(36, 600);
  context.fillText(t("profile.year.watched"), 80, 445);
  const stats = [
    [formatNumber(data.movies), t("profile.year.movies")],
    [formatNumber(data.episodes), t("profile.year.episodes")],
    [formatNumber(data.activeDays), t("profile.year.days")],
    [formatNumber(streak), t("profile.year.streak")],
  ];
  stats.forEach(([value, label], index) => {
    const x = 80 + (index % 2) * 470;
    const y = 560 + Math.floor(index / 2) * 150;
    context.fillStyle = text;
    context.font = font(70, 800);
    context.fillText(value, x, y);
    context.fillStyle = muted;
    context.font = font(30, 600);
    context.fillText(label, x, y + 48);
  });
  context.fillStyle = text;
  context.font = font(38, 800);
  context.fillText(t("profile.year.top"), 80, 940);
  context.font = font(34, 600);
  data.top.slice(0, 5).forEach((item, index) => {
    const y = 1000 + index * 58;
    context.fillStyle = accent;
    context.fillText(String(index + 1), 80, y);
    context.fillStyle = text;
    const title = item.name.length > 34 ? `${item.name.slice(0, 33)}…` : item.name;
    context.fillText(title, 130, y);
    context.fillStyle = muted;
    context.textAlign = "right";
    context.fillText(formatHoursShort(item.seconds), 1000, y);
    context.textAlign = "left";
  });
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return;
  if (isDesktop) {
    const path = await backend.saveScreenshot(new Uint8Array(await blob.arrayBuffer()), `Kinuza ${year}`);
    useUi.getState().toast(t("profile.year.saved"), "success", {
      label: t("player.screenshot.show"),
      run: () => void import("@tauri-apps/plugin-opener").then(({ revealItemInDir }) => revealItemInDir(path)),
    });
    return;
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `Kinuza ${year}.png`;
  link.click();
  URL.revokeObjectURL(link.href);
}

export function YearRecap({ ledger, year, years }: { ledger: Ledger; year: number; years: number[] }) {
  const { tn } = useT();
  const navigate = useNavigate();
  const tracked = useLibrary((state) => state.tracked);
  const name = useProfile((state) => state.name);
  const from = new Date(year, 0, 1).getTime();
  const to = new Date(year + 1, 0, 1).getTime();
  const data = useMemo(() => overview(ledger, { from, to }, null, to - 1), [ledger, from, to]);
  const streak = useMemo(() => yearStreak(data, year), [data, year]);
  const best = useMemo(() => bestRated(ledger, tracked, from, to), [ledger, tracked, from, to]);
  const titleLink = (key: string) => `/title/${key.split(":")[0]}/${key.split(":")[1]}`;

  const save = () =>
    void saveImage(year, name || t("profile.defaultName"), data, streak).catch((error) => useUi.getState().toast(describeError(error), "error"));

  return (
    <div className="year-recap">
      <div className="profile-toolbar">
        {years.length > 1 && (
          <div className="chips">
            {years.map((item) => (
              <button key={item} className={`chip ${item === year ? "is-active" : ""}`} onClick={() => navigate(`/profile/year?y=${item}`)}>
                {item}
              </button>
            ))}
          </div>
        )}
        <div className="profile-toolbar__end">
          <button className="button button--small" onClick={save}>
            <ImageDown size={14} />
            {t("profile.year.save")}
          </button>
        </div>
      </div>
      <div className="profile-layout">
        <div className="profile-main">
          <section className="year-hero">
            <span>{t("profile.year.title", { year })}</span>
            <strong>{formatHoursShort(data.seconds)}</strong>
            <p>{t("profile.year.watched")}</p>
          </section>
          <section className="year-stats">
            <div>
              <strong>{formatNumber(data.movies)}</strong>
              <span>{t("profile.year.movies")}</span>
            </div>
            <div>
              <strong>{formatNumber(data.episodes)}</strong>
              <span>{t("profile.year.episodes")}</span>
            </div>
            <div>
              <strong>{formatNumber(data.activeDays)}</strong>
              <span>{t("profile.year.days")}</span>
            </div>
            <div>
              <strong>{formatNumber(streak)}</strong>
              <span>{t("profile.year.streak")}</span>
            </div>
          </section>
          {data.top.length > 0 && (
            <section className="profile-card">
              <div className="profile-card__head">
                <h2>{t("profile.year.top")}</h2>
              </div>
              <ol className="year-top">
                {data.top.slice(0, 5).map((item) => {
                  const poster = tracked[item.key]?.poster ?? null;
                  return (
                    <li key={item.key}>
                      <Link to={titleLink(item.key)}>
                        {poster ? <img src={imageUrl(poster, "w185") ?? undefined} alt="" loading="lazy" /> : <span className="year-top__blank" />}
                        <b>{item.name}</b>
                        <small>{formatSeconds(item.seconds)}</small>
                      </Link>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}
        </div>
        <aside className="profile-side">
          {best.length > 0 && (
            <section className="profile-card">
              <div className="profile-card__head">
                <h2>{t("profile.year.best")}</h2>
              </div>
              <ul className="profile-lines">
                {best.map((entry) => (
                  <li key={`${entry.type}:${entry.id}`}>
                    <Link to={`/title/${entry.type}/${entry.id}`}>{entry.title}</Link> · {entry.rating}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="profile-card">
            <div className="profile-card__head">
              <h2>{t("profile.year.moments")}</h2>
            </div>
            <ul className="profile-lines">
              {data.busiestMonth && <li>{t("profile.year.busiest", { month: monthNameStandalone(data.busiestMonth) })}</li>}
              {data.first && <li>{t("profile.year.first", { title: data.first.name, date: dayKey(data.first.at as number).slice(5).split("-").reverse().join(".") })}</li>}
              {data.last && data.last !== data.first && (
                <li>{t("profile.year.last", { title: data.last.name, date: dayKey(data.last.at as number).slice(5).split("-").reverse().join(".") })}</li>
              )}
              {data.rewatches > 0 && <li>{tn("profile.details.rewatches", data.rewatches)}</li>}
              {data.recordDay && <li>{t("profile.habits.record", { count: tn("common.episodes", data.recordDay.episodes), title: data.recordDay.name })}</li>}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
