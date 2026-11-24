import { useEffect, useState } from "react";
import { accountApi } from "../lib/accountApi";
import { useAccount } from "./account";

const refreshMs = 2 * 60_000;
const firstDelayMs = 4000;

export function useOnlineCount(): number | null {
  const phase = useAccount((state) => state.phase);
  const fromPresence = useAccount((state) => state.social?.online ?? null);
  const [polled, setPolled] = useState<number | null>(null);

  useEffect(() => {
    if (phase === "signedIn" || phase === "unknown") return;
    let alive = true;
    const poll = () =>
      void accountApi
        .online()
        .then((count) => {
          if (alive) setPolled(typeof count === "number" ? count : null);
        })
        .catch(() => undefined);
    const first = setTimeout(poll, firstDelayMs);
    const timer = setInterval(poll, refreshMs);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [phase]);

  return phase === "signedIn" ? fromPresence : polled;
}
