import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import { achievementDefs, nextGoal, tierNames, type AchievementGroup, type AchievementState } from "../../lib/achievements";
import { t, useT } from "../../lib/i18n";
import { achievementById, checkAchievements, useAchievements } from "../../state/achievements";
import { useUi } from "../../state/ui";
import { Medal, TierPips } from "./Medal";

const groups: AchievementGroup[] = ["watch", "habits", "taste", "social", "special", "secret"];
const closestShown = 3;
const celebrationMs = 8000;
const groupedAfter = 3;
const sparkCount = 14;

function tierLabel(state: Pick<AchievementState, "def">, tier: number): string {
  if (state.def.tiers.length === 1) return t("achievements.tier.single");
  return t(`achievements.tier.${tierNames[Math.max(0, Math.min(tier, tierNames.length) - 1)]}`);
}

function tagClass(state: Pick<AchievementState, "def">, tier: number): string {
  if (state.def.tiers.length === 1) return state.def.secret ? "is-secret" : "is-single";
  return `is-${tierNames[Math.max(1, Math.min(tier, tierNames.length)) - 1]}`;
}

function amount(state: AchievementState, value: number, locale: string): string {
  const shown = state.def.unit === "hours" ? Math.floor(value) : Math.round(value);
  return shown.toLocaleString(locale);
}

function progressShare(state: AchievementState): number {
  const goal = nextGoal(state);
  if (goal === null) return 1;
  const from = state.tier > 0 ? state.def.tiers[state.tier - 1] : 0;
  return Math.max(0, Math.min(1, (state.value - from) / Math.max(1, goal - from)));
}

function hiddenSecret(state: AchievementState): boolean {
  return Boolean(state.def.secret) && state.tier === 0;
}

function nameOf(state: Pick<AchievementState, "def">): string {
  return t(`achievements.${state.def.id}.name` as never);
}

function descOf(state: AchievementState, locale: string): string {
  if (hiddenSecret(state)) return t(`achievements.${state.def.id}.hint` as never);
  const goal = nextGoal(state) ?? state.def.tiers[state.def.tiers.length - 1];
  return t(`achievements.${state.def.id}.desc` as never, { goal: goal.toLocaleString(locale) });
}

function AchievementCard({ state }: { state: AchievementState }) {
  const { t, locale } = useT();
  const goal = nextGoal(state);
  const secret = hiddenSecret(state);
  const last = state.unlocked[state.tier - 1];
  const date = last ? new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).format(new Date(last)) : null;
  return (
    <article className={`achievement-card ${state.tier > 0 ? "is-earned" : ""} ${goal === null ? "is-maxed" : ""}`}>
      <Medal def={state.def} tier={state.tier} size={68} progress={secret ? undefined : progressShare(state)} hidden={secret} />
      <div className="achievement-card__text">
        <div className="achievement-card__head">
          <b>{secret ? t("achievements.secret") : nameOf(state)}</b>
          {state.tier > 0 && <span className={`achievement-card__tier ${tagClass(state, state.tier)}`}>{tierLabel(state, state.tier)}</span>}
        </div>
        <p>{descOf(state, locale)}</p>
        {!secret && goal !== null && state.def.tiers.length > 1 && (
          <div className="achievement-card__progress">
            <span className="achievement-card__bar">
              <i style={{ width: `${progressShare(state) * 100}%` }} />
            </span>
            <small>
              {t("achievements.next", {
                tier: tierLabel(state, state.tier + 1),
                value: amount(state, state.value, locale),
                goal: goal.toLocaleString(locale),
              })}
            </small>
          </div>
        )}
        {!secret && goal !== null && state.def.tiers.length === 1 && state.def.tiers[0] > 1 && (
          <div className="achievement-card__progress">
            <span className="achievement-card__bar">
              <i style={{ width: `${progressShare(state) * 100}%` }} />
            </span>
            <small>
              {amount(state, state.value, locale)} / {goal.toLocaleString(locale)}
            </small>
          </div>
        )}
        <div className="achievement-card__foot">
          <TierPips def={state.def} tier={state.tier} />
          {goal === null && state.def.tiers.length > 1 && <small className="is-done">{t("achievements.done")}</small>}
          {date && <small>{t("achievements.earnedOn", { date })}</small>}
        </div>
      </div>
    </article>
  );
}

export function AchievementsTab() {
  const { t, locale } = useT();
  const shown = useAchievements((state) => state.shown);

  useEffect(() => {
    void checkAchievements();
  }, []);

  const summary = useMemo(() => {
    if (!shown) return null;
    const total = achievementDefs.reduce((sum, def) => sum + def.tiers.length, 0);
    const count = shown.reduce((sum, state) => sum + state.tier, 0);
    const byTier = [0, 0, 0, 0];
    for (const state of shown) for (let index = 0; index < state.tier && state.def.tiers.length > 1; index++) byTier[index] += 1;
    const latest = shown
      .filter((state) => state.tier > 0)
      .map((state) => ({ state, at: state.unlocked[state.tier - 1] ?? 0 }))
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
    const closest = shown
      .filter((state) => !hiddenSecret(state) && nextGoal(state) !== null && state.value > 0)
      .sort((a, b) => progressShare(b) - progressShare(a))
      .slice(0, closestShown);
    return { total, count, byTier, latest, closest };
  }, [shown]);

  if (!shown || !summary) {
    return (
      <div className="profile-skeleton">
        <div className="profile-card" />
        <div className="profile-card" />
      </div>
    );
  }

  return (
    <div className="achievements">
      <section className="profile-card achievements__summary">
        <div className="achievements__count">
          <strong>{t("achievements.summary", { count: summary.count.toLocaleString(locale), total: summary.total })}</strong>
          <span className="achievement-card__bar is-large">
            <i style={{ width: `${(summary.count / summary.total) * 100}%` }} />
          </span>
          <p>{t("achievements.summary.text")}</p>
          {summary.latest && <small>{t("achievements.last", { name: nameOf(summary.latest.state) })}</small>}
        </div>
        <div className="achievements__tiers">
          {summary.byTier.map((count, index) => (
            <div key={tierNames[index]} className="achievements__tier">
              <Medal def={achievementById("perfect") ?? achievementDefs[0]} tier={index + 1} size={44} />
              <b>{count}</b>
              <small>{t(`achievements.tier.${tierNames[index]}`)}</small>
            </div>
          ))}
        </div>
      </section>

      {summary.closest.length > 0 && (
        <section className="achievements__group">
          <h2>{t("achievements.closest")}</h2>
          <div className="achievements__grid">
            {summary.closest.map((state) => (
              <AchievementCard key={state.def.id} state={state} />
            ))}
          </div>
        </section>
      )}

      {groups.map((group) => (
        <section key={group} className="achievements__group">
          <h2>{t(`achievements.group.${group}`)}</h2>
          <div className="achievements__grid">
            {shown
              .filter((state) => state.def.group === group)
              .map((state) => (
                <AchievementCard key={state.def.id} state={state} />
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Burst() {
  return (
    <span className="celebration__burst" aria-hidden="true">
      {Array.from({ length: sparkCount }, (_, index) => (
        <i key={index} style={{ "--a": `${(360 / sparkCount) * index}deg`, "--d": `${(index % 3) * 60}ms` } as CSSProperties} />
      ))}
    </span>
  );
}

export function AchievementCelebrations() {
  const { t, locale } = useT();
  const navigate = useNavigate();
  const player = useUi((state) => state.player);
  const queue = useAchievements((state) => state.queue);
  const welcome = useAchievements((state) => state.welcome);
  const shown = useAchievements((state) => state.shown);
  const [hover, setHover] = useState(false);
  const left = useRef(celebrationMs);
  const grouped = queue.length > groupedAfter;
  const current = !player && !welcome && queue.length > 0 ? queue[0] : null;
  const key = welcome ? "welcome" : grouped ? `group-${queue.length}` : current ? `${current.id}-${current.tier}` : "";

  const close = () => {
    if (welcome) useAchievements.getState().dropWelcome();
    else if (grouped) useAchievements.setState({ queue: [] });
    else useAchievements.getState().dropCelebration();
  };

  useEffect(() => {
    left.current = celebrationMs;
  }, [key]);

  useEffect(() => {
    if (!key || player || hover || welcome) return;
    const started = Date.now();
    const timer = setTimeout(close, left.current);
    return () => {
      clearTimeout(timer);
      left.current = Math.max(1500, left.current - (Date.now() - started));
    };
  }, [key, player, hover, welcome]); // eslint-disable-line react-hooks/exhaustive-deps

  if (player || !key) return null;

  const openAll = () => {
    close();
    navigate("/profile/achievements");
  };

  if (welcome) {
    return (
      <div className="celebration is-welcome" role="status" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        <button className="celebration__close" aria-label={t("achievements.close")} onClick={close}>
          <X size={15} />
        </button>
        <div className="celebration__row">
          {welcome.ids.map((id, index) => {
            const state = shown?.find((item) => item.def.id === id);
            const def = achievementById(id);
            return def ? <Medal key={id} def={def} tier={state?.tier ?? 1} size={54} className="celebration__mini" /> : <span key={index} />;
          })}
        </div>
        <strong>{t("achievements.welcome.title", { count: welcome.count.toLocaleString(locale) })}</strong>
        <p>{t("achievements.welcome.text")}</p>
        <button className="button button--primary button--small" onClick={openAll}>
          {t("achievements.open")}
        </button>
      </div>
    );
  }

  if (grouped) {
    return (
      <div className="celebration is-group" role="status" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        <button className="celebration__close" aria-label={t("achievements.close")} onClick={close}>
          <X size={15} />
        </button>
        <span className="celebration__kicker">{t("achievements.new")}</span>
        <div className="celebration__row">
          {queue.slice(0, groupedAfter).map((item) => {
            const def = achievementById(item.id);
            return def ? <Medal key={`${item.id}-${item.tier}`} def={def} tier={item.tier} size={58} className="celebration__mini" /> : null;
          })}
        </div>
        <strong>{queue.slice(0, groupedAfter).map((item) => nameOf({ def: achievementById(item.id)! })).join(", ")}</strong>
        <p>{t("achievements.more", { count: queue.length - groupedAfter })}</p>
        <button className="button button--primary button--small" onClick={openAll}>
          {t("achievements.open")}
        </button>
      </div>
    );
  }

  const def = current ? achievementById(current.id) : null;
  if (!current || !def) return null;
  const state: AchievementState = shown?.find((item) => item.def.id === current.id) ?? { def, value: 0, tier: current.tier, unlocked: [] };
  const goal = def.tiers[current.tier - 1];
  return (
    <div className={`celebration is-single`} role="status" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button className="celebration__close" aria-label={t("achievements.close")} onClick={close}>
        <X size={15} />
      </button>
      <div className="celebration__stage">
        <span className="celebration__rays" aria-hidden="true" />
        <Burst />
        <Medal def={def} tier={current.tier} size={92} className="celebration__medal" />
      </div>
      <div className="celebration__text">
        <span className="celebration__kicker">{current.tier > 1 ? t("achievements.levelUp") : t("achievements.new")}</span>
        <strong>{nameOf(state)}</strong>
        <span className={`celebration__tier ${tagClass(state, current.tier)}`}>{tierLabel(state, current.tier)}</span>
        <p>{t(`achievements.${def.id}.desc` as never, { goal: goal.toLocaleString(locale) })}</p>
        <button className="celebration__link" onClick={openAll}>
          {t("achievements.open")}
        </button>
      </div>
    </div>
  );
}
