import { useEffect, useRef } from "react";
import { backend, isDesktop } from "../../lib/backend";

const positionEveryMs = 5000;

export interface MediaSessionControls {
  play: () => void;
  pause: () => void;
  toggle: () => void;
  next: (() => void) | null;
  seekBy: (seconds: number) => void;
  seekTo: (seconds: number) => void;
  stop: () => void;
}

interface MediaKeyEvent {
  action: "play" | "pause" | "toggle" | "next" | "previous" | "stop" | "seekBy" | "seekTo";
  seconds: number | null;
}

export function useMediaSession({
  native,
  title,
  subtitle,
  cover,
  duration,
  playing,
  position,
  controls,
}: {
  native: boolean;
  title: string;
  subtitle: string;
  cover: string | null;
  duration: number;
  playing: boolean;
  position: () => number;
  controls: MediaSessionControls;
}): void {
  const latest = useRef(controls);
  latest.current = controls;
  const where = useRef(position);
  where.current = position;

  useEffect(() => {
    if (!native || !isDesktop) return;
    void backend.mediaSessionStart({ title, subtitle, coverUrl: cover, duration }).catch(() => undefined);
  }, [native, title, subtitle, cover, duration]);

  useEffect(() => {
    if (!native || !isDesktop) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<MediaKeyEvent>("media-key", ({ payload }) => {
        const handlers = latest.current;
        if (payload.action === "play") handlers.play();
        else if (payload.action === "pause") handlers.pause();
        else if (payload.action === "toggle") handlers.toggle();
        else if (payload.action === "next") handlers.next?.();
        else if (payload.action === "stop") handlers.stop();
        else if (payload.action === "seekBy" && payload.seconds !== null) handlers.seekBy(payload.seconds);
        else if (payload.action === "seekTo" && payload.seconds !== null) handlers.seekTo(payload.seconds);
      }).then((unlisten) => {
        if (cancelled) unlisten();
        else stop = unlisten;
      }),
    );
    return () => {
      cancelled = true;
      stop?.();
      void backend.mediaSessionStop().catch(() => undefined);
    };
  }, [native]);

  useEffect(() => {
    if (!native || !isDesktop) return;
    const report = () => void backend.mediaSessionState(playing, where.current()).catch(() => undefined);
    report();
    if (!playing) return;
    const timer = setInterval(report, positionEveryMs);
    return () => clearInterval(timer);
  }, [native, playing]);

  useEffect(() => {
    if (native || typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    try {
      session.metadata = new MediaMetadata({ title, artist: subtitle, album: "Kinuza", artwork: cover ? [{ src: cover, sizes: "500x750", type: "image/jpeg" }] : [] });
    } catch {
      return;
    }
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        session.setActionHandler(action, handler);
      } catch {
        return;
      }
    };
    set("play", () => latest.current.play());
    set("pause", () => latest.current.pause());
    set("stop", () => latest.current.stop());
    set("seekbackward", (details) => latest.current.seekBy(-(details.seekOffset ?? 10)));
    set("seekforward", (details) => latest.current.seekBy(details.seekOffset ?? 10));
    set("seekto", (details) => {
      if (details.seekTime !== undefined) latest.current.seekTo(details.seekTime);
    });
    set("nexttrack", latest.current.next ? () => latest.current.next?.() : null);
    return () => {
      for (const action of ["play", "pause", "stop", "seekbackward", "seekforward", "seekto", "nexttrack"] as MediaSessionAction[]) set(action, null);
      session.metadata = null;
    };
  }, [native, title, subtitle, cover, Boolean(controls.next)]); // eslint-disable-line react-hooks/exhaustive-deps
}
