import { useEffect, useRef, type MutableRefObject } from "react";
import { backend } from "../../lib/backend";
import { t } from "../../lib/i18n";
import { aheadOf, correction, roomPosition, sameMedia, type PartyStatus, type PartyTrack } from "../../lib/party";
import type { Source } from "../../state/library";
import { canControl, clock, mediaFor, partyHooks, partyStatus, sendControl, sendReady, sendStall, shareMedia, useParty } from "../../state/party";
import { useUi, type PlayerSession } from "../../state/ui";

export interface PartyControls {
  active: boolean;
  blocksNext: boolean;
  toggle: () => void;
  seeked: (target: number) => void;
  setRate: (rate: number) => boolean;
  localPaused: (paused: boolean) => void;
}

interface Playable {
  paused: boolean;
  playbackRate: number;
  play: () => Promise<void> | void;
  pause: () => void;
}

export interface PartyPlaybackOptions {
  session: PlayerSession;
  source: Source | undefined;
  video: () => Playable | null;
  preciseTime: () => number;
  filmLength: () => number;
  seekTo: (time: number) => void;
  metadataReady: boolean;
  buffering: boolean;
  buffered: { start: number; end: number }[];
  rate: number;
  setRate: (rate: number) => void;
  finished: boolean;
  downloadSpeed: number;
  tracks: { audio?: PartyTrack; sub?: PartyTrack };
  subtitle: () => { name: string; text: string } | null;
  applySubtitle: (name: string, text: string) => void;
  applyTracks: (audio: PartyTrack | undefined, sub: PartyTrack | undefined, from: number) => void;
}

const tickMs = 200;
const seekSettleMs = 1200;
const gateSeekGapMs = 700;
const positionSlack = 0.3;
const readyAhead = 4;
const relaxAfter = 10;
const relaxedAhead = 1;
const relaxedSlack = 2;
const endSlack = 6;
const stallAfterMs = 700;
const startLeadBaseMs = 40;
const startLeadMaxMs = 400;
const startCheckMs = 600;
const seekRetryStep = 0.05;
const seekLead = 0.25;
const ownCommandMs = 3000;
const startupMs = 2500;
const seekSendDelayMs = 200;
let startLeadMs = startLeadBaseMs;

export function usePartyPlayback(options: PartyPlaybackOptions, controls: MutableRefObject<PartyControls | null>): { active: boolean; foreign: boolean } {
  const phase = useParty((state) => state.phase);
  const media = useParty((state) => state.media);
  const host = useParty((state) => state.host);
  const me = useParty((state) => state.me);
  const live = phase === "live" || phase === "reconnecting";
  const source = options.source;
  const matches = live && !!source && sameMedia(media, { infoHash: source.infoHash, fileIndex: source.fileIndex } as never);
  const amHost = live && host === me;
  const latest = useRef(options);
  latest.current = options;
  const applying = useRef(false);
  const expected = useRef<{ paused: boolean; at: number } | null>(null);
  const activeSince = useRef(0);
  const nudging = useRef(false);
  const readySent = useRef("");
  const stallSent = useRef(-1);
  const waitingSince = useRef(0);
  const lastSeekAt = useRef(0);
  const startTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const startFor = useRef(-1);
  const startedFor = useRef(-1);
  const startCheck = useRef<{ seq: number; at: number } | null>(null);
  const seekTry = useRef<{ target: number; count: number; from: number }>({ target: -1, count: 0, from: 0 });
  const seekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sharedFor = useRef("");

  useEffect(() => {
    if (!live || !amHost || !source || !options.metadataReady) return;
    const room = useParty.getState();
    const next = mediaFor(options.session, source);
    const key = `${next.infoHash}:${next.fileIndex}`;
    if (sameMedia(room.media, next) || sharedFor.current === key) return;
    sharedFor.current = key;
    const running = !!room.media && !!room.state && (room.state.playing || !!room.state.gate?.resume);
    shareMedia(next, running ? 0 : latest.current.preciseTime(), running);
  }, [live, amHost, source?.id, options.metadataReady]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!matches) return;
    partyHooks.subtitle = () => latest.current.subtitle();
    partyHooks.applySubtitle = (name, text) => latest.current.applySubtitle(name, text);
    partyHooks.applyTracks = (audio, sub, from) => latest.current.applyTracks(audio, sub, from);
    return () => {
      partyHooks.subtitle = null;
      partyHooks.applySubtitle = null;
      partyHooks.applyTracks = null;
    };
  }, [matches]);

  useEffect(() => {
    if (!live) return;
    if (!matches) {
      partyStatus({ away: true, loaded: false });
      return;
    }
    return () => {
      if (useParty.getState().phase !== "idle") partyStatus({ away: true, loaded: false });
    };
  }, [live, matches]);

  useEffect(() => {
    if (!matches) return;
    activeSince.current = performance.now();
    readySent.current = "";
    stallSent.current = -1;

    const hold = (paused: boolean) => {
      const video = latest.current.video();
      if (!video || video.paused === paused) return;
      expected.current = { paused, at: performance.now() };
      if (paused) video.pause();
      else void Promise.resolve(video.play()).catch(() => undefined);
    };

    const speed = (value: number) => {
      const video = latest.current.video();
      if (video && Math.abs(video.playbackRate - value) > 0.001) video.playbackRate = value;
    };

    const syncSeek = (time: number) => {
      lastSeekAt.current = performance.now();
      const local = latest.current.preciseTime();
      const attempt = seekTry.current;
      let target = time;
      if (Math.abs(attempt.target - time) < 0.01) {
        attempt.count = attempt.count >= 5 ? 1 : attempt.count + 1;
        target = time + seekRetryStep * attempt.count * (attempt.count % 2 === 0 ? -1 : 1);
        if (attempt.count === 1) void backend.appLog(`party: seek to ${time.toFixed(2)}s did not land (still at ${local.toFixed(2)}s), retrying nearby`);
      } else {
        seekTry.current = { target: time, count: 0, from: local };
      }
      applying.current = true;
      try {
        latest.current.seekTo(Math.max(0, target));
      } finally {
        applying.current = false;
      }
    };

    const tick = () => {
      const o = latest.current;
      const room = useParty.getState();
      const state = room.state;
      const video = o.video();
      if (!state || !video) return;
      const status: PartyStatus = { loaded: o.metadataReady, waiting: o.buffering, has: o.finished, down: Math.round(o.downloadSpeed), ...o.tracks };
      if (!o.metadataReady) {
        partyStatus(status);
        return;
      }
      const serverNow = clock.serverNow();
      const local = o.preciseTime();
      const length = o.filmLength();
      const sinceSeek = performance.now() - lastSeekAt.current;
      const gate = state.gate;
      let drift = 0;
      if (gate) {
        clearTimeout(startTimer.current);
        startFor.current = -1;
        hold(true);
        if (Math.abs(local - gate.pos) > positionSlack && sinceSeek > gateSeekGapMs) syncSeek(gate.pos);
        else if (Math.abs(local - gate.pos) <= positionSlack) seekTry.current = { target: -1, count: 0, from: 0 };
        const ahead = aheadOf(o.buffered, gate.pos);
        const relaxed = serverNow - gate.since > relaxAfter;
        const ready = ahead >= readyAhead || gate.pos >= length - endSlack || o.finished || (relaxed && !o.buffering && ahead >= relaxedAhead);
        status.pct = Math.min(100, Math.round((ahead / readyAhead) * 100));
        if (ready && gate.waiting.includes(room.me) && readySent.current !== gate.id && Math.abs(local - gate.pos) < (relaxed ? relaxedSlack : 0.6)) {
          if (ahead < readyAhead && !o.finished) void backend.appLog(`party: ready for gate at ${gate.pos.toFixed(1)}s with ${ahead.toFixed(1)}s buffered after ${(serverNow - gate.since).toFixed(0)}s`);
          readySent.current = gate.id;
          sendReady(gate.id);
        }
        waitingSince.current = 0;
      } else if (state.playing && serverNow < state.at) {
        if (startedFor.current !== state.seq) hold(true);
        if (Math.abs(local - state.pos) > positionSlack && sinceSeek > gateSeekGapMs) syncSeek(state.pos);
        if (startFor.current !== state.seq) {
          startFor.current = state.seq;
          clearTimeout(startTimer.current);
          const wait = Math.max(0, (state.at - clock.serverNow()) * 1000 - startLeadMs);
          startTimer.current = setTimeout(() => {
            startedFor.current = state.seq;
            startCheck.current = { seq: state.seq, at: performance.now() };
            speed(state.rate);
            hold(false);
          }, wait);
        }
        status.pct = 100;
      } else if (state.playing) {
        const target = roomPosition(state, serverNow) + room.lag;
        if (o.buffering && !video.paused) {
          if (!waitingSince.current) waitingSince.current = performance.now();
          const me = room.members.find((member) => member.id === room.me);
          if (performance.now() - waitingSince.current > stallAfterMs && stallSent.current !== state.seq && room.settings.wait && !me?.skipped && sinceSeek > seekSettleMs) {
            stallSent.current = state.seq;
            sendStall(local);
          }
        } else {
          waitingSince.current = 0;
        }
        if (target < length - 0.5) hold(false);
        drift = local - target;
        const check = startCheck.current;
        if (check && check.seq === state.seq && performance.now() - check.at > startCheckMs && !o.buffering) {
          startCheck.current = null;
          if (Math.abs(drift) < 0.5) {
            startLeadMs = Math.min(startLeadMaxMs, Math.max(-startLeadMaxMs / 2, startLeadMs - drift * 1000 * 0.7));
            void backend.appLog(`party: started ${(drift * 1000).toFixed(0)} ms off, next start lead ${startLeadMs.toFixed(0)} ms`);
          }
        }
        if (!o.buffering && sinceSeek > seekSettleMs && target < length - 0.5) {
          const fix = correction(drift, nudging.current);
          if (fix.kind === "seek") {
            nudging.current = false;
            speed(state.rate);
            syncSeek(target + seekLead);
          } else if (fix.kind === "rate") {
            nudging.current = true;
            speed(state.rate * fix.factor);
          } else if (nudging.current) {
            nudging.current = false;
            speed(state.rate);
          }
        }
      } else {
        clearTimeout(startTimer.current);
        startFor.current = -1;
        hold(true);
        if (Math.abs(local - state.pos) > positionSlack && sinceSeek > gateSeekGapMs) syncSeek(state.pos);
        waitingSince.current = 0;
      }
      if (Math.abs(o.rate - state.rate) > 0.001) o.setRate(state.rate);
      status.ahead = Math.round(aheadOf(o.buffered, local));
      status.drift = Math.round(drift * 100) / 100;
      status.synced = !gate && !o.buffering && Math.abs(drift) < 0.5;
      partyStatus(status);
    };

    tick();
    const timer = setInterval(tick, tickMs);
    return () => {
      clearInterval(timer);
      clearTimeout(startTimer.current);
      clearTimeout(seekTimer.current);
      const video = latest.current.video();
      const state = useParty.getState().state;
      if (video && state) video.playbackRate = state.rate;
      nudging.current = false;
    };
  }, [matches]);

  controls.current = {
    active: matches,
    blocksNext: matches && !amHost,
    toggle() {
      const o = latest.current;
      const state = useParty.getState().state;
      if (!state) return;
      if (!canControl()) {
        useUi.getState().toast(t("party.onlyHost"), "info");
        return;
      }
      const video = o.video();
      if (state.playing || state.gate?.resume) {
        expected.current = { paused: true, at: performance.now() };
        video?.pause();
        sendControl("pause", o.preciseTime());
      } else {
        sendControl("play");
      }
    },
    seeked(target) {
      if (applying.current || !matches) return;
      lastSeekAt.current = performance.now();
      if (!canControl()) {
        useUi.getState().toast(t("party.onlyHost"), "info");
        lastSeekAt.current = 0;
        return;
      }
      clearTimeout(seekTimer.current);
      seekTimer.current = setTimeout(() => sendControl("seek", target), seekSendDelayMs);
    },
    setRate(rate) {
      if (!matches) return false;
      if (!canControl()) {
        useUi.getState().toast(t("party.onlyHost"), "info");
        return true;
      }
      sendControl("rate", rate);
      return true;
    },
    localPaused(paused) {
      if (!matches) return;
      const own = expected.current;
      if (own && own.paused === paused && performance.now() - own.at < ownCommandMs) return;
      if (performance.now() - activeSince.current < startupMs || applying.current) return;
      const state = useParty.getState().state;
      if (!state || !canControl()) return;
      const roomRunning = state.playing || !!state.gate?.resume;
      if (paused && roomRunning) {
        void backend.appLog("party: local pause becomes a room pause");
        sendControl("pause", latest.current.preciseTime());
      } else if (!paused && !roomRunning) {
        void backend.appLog("party: local play becomes a room play");
        sendControl("play");
      }
    },
  };

  return { active: matches, foreign: live && !!source && !matches && !amHost };
}
