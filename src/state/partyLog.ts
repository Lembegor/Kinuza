import { beforeAppClose } from "../lib/lifecycle";
import { flushActivity, recordActivity } from "./activity";
import { useParty } from "./party";
import { useUi } from "./ui";

const tickMs = 10_000;
const countedSeconds = 300;

interface Session {
  code: string;
  seconds: number;
  size: number;
  title: string | null;
}

let session: Session | null = null;
let started = false;

function finish(): void {
  const done = session;
  session = null;
  if (!done || done.seconds < countedSeconds) return;
  recordActivity("party", { size: done.size, seconds: done.seconds, title: done.title });
}

function tick(): void {
  const party = useParty.getState();
  const player = useUi.getState().player;
  if (party.phase !== "live" || !party.code) return;
  if (!session || session.code !== party.code) {
    finish();
    session = { code: party.code, seconds: 0, size: 0, title: null };
  }
  const size = party.members.length;
  if (size < 2 || !player) return;
  session.seconds += tickMs / 1000;
  session.size = Math.max(session.size, size);
  session.title = player.title.title;
}

export function startPartyLog(): void {
  if (started) return;
  started = true;
  setInterval(tick, tickMs);
  useParty.subscribe((state, previous) => {
    if (previous.code && state.code !== previous.code) finish();
  });
  beforeAppClose(async () => {
    finish();
    await flushActivity();
  });
}
