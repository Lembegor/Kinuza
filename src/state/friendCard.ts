import { accountApi } from "../lib/accountApi";
import { backend } from "../lib/backend";
import { buildFriendCard, cardSignature } from "../lib/friendCard";
import { showcase } from "../lib/achievements";
import { useAchievements } from "./achievements";

const showcaseSize = 6;
import { useAccount } from "./account";
import { useLibrary } from "./library";
import { useProfile } from "./profile";
import { buildLedgerNow } from "./stats";

let lastSignature = "";
let running = false;

export function forgetPublishedCard(): void {
  lastSignature = "";
}

export async function publishCard(): Promise<void> {
  const { phase, account } = useAccount.getState();
  if (running || phase !== "signedIn" || !account?.showActivity) return;
  running = true;
  try {
    const ledger = await buildLedgerNow();
    if (!ledger) return;
    const library = useLibrary.getState();
    const card = buildFriendCard({
      ledger,
      tracked: library.tracked,
      progress: library.progress,
      onboardedAt: library.onboardedAt,
      cover: useProfile.getState().cover,
      now: Date.now(),
      achievements: showcase(useAchievements.getState().shown ?? [], showcaseSize).map((state) => ({ id: state.def.id, tier: state.tier })),
    });
    const signature = cardSignature(card);
    if (signature === lastSignature) return;
    await accountApi.putCard(card);
    lastSignature = signature;
  } catch (error) {
    void backend.appLog(`account: could not share the profile card: ${String(error)}`);
  } finally {
    running = false;
  }
}
