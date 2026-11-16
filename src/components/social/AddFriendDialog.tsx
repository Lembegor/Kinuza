import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, LoaderCircle, UserPlus, X } from "lucide-react";
import { create } from "zustand";
import { accountApi, cleanFriendCode, formatFriendCode, friendCodeLength, inviteLink } from "../../lib/accountApi";
import { describeError } from "../../lib/backend";
import { useT } from "../../lib/i18n";
import { isTopDialog, useDialogFocus } from "../../lib/useDialogFocus";
import { useAccount } from "../../state/account";
import { useUi } from "../../state/ui";
import { GoogleMark, PersonAvatar } from "./SocialBits";

interface AddFriendState {
  open: boolean;
  code: string;
  show: (code?: string) => void;
  close: () => void;
}

export const useAddFriend = create<AddFriendState>((set) => ({
  open: false,
  code: "",
  show: (code = "") => set({ open: true, code: cleanFriendCode(code) }),
  close: () => set({ open: false, code: "" }),
}));

const copiedMs = 2000;

export function CopyInvite({ code }: { code: string }) {
  const { t } = useT();
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), copiedMs);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async (what: "code" | "link") => {
    try {
      await navigator.clipboard.writeText(what === "code" ? formatFriendCode(code) : inviteLink(code));
      setCopied(what);
    } catch {
      useUi.getState().toast(t("share.failed"), "error");
    }
  };
  return (
    <div className="my-code">
      <span className="my-code__label">{t("friends.myCode")}</span>
      <button className="my-code__value" onClick={() => void copy("code")} title={t("friends.copyCode")}>
        {formatFriendCode(code)}
        {copied === "code" ? <Check size={15} /> : <Copy size={15} />}
      </button>
      <button className={`button button--small ${copied === "link" ? "is-done" : ""}`} onClick={() => void copy("link")}>
        {copied === "link" ? <Check size={14} /> : <Copy size={14} />}
        {copied === "link" ? t("share.done") : t("friends.copyLink")}
      </button>
    </div>
  );
}

export function AddFriendDialog() {
  const { t } = useT();
  const { open, code: preset, close } = useAddFriend();
  const phase = useAccount((state) => state.phase);
  const account = useAccount((state) => state.account);
  const signIn = useAccount((state) => state.signIn);
  const applySocial = useAccount((state) => state.applySocial);
  const [code, setCode] = useState("");
  const [found, setFound] = useState<{ id: number; name: string; avatar: string | null; self: boolean } | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open && phase !== "signingIn");

  useEffect(() => {
    if (!open) return;
    setCode(preset);
    setFound(null);
    setProblem("");
  }, [open, preset]);

  useEffect(() => {
    if (!open || phase !== "signedIn" || code.length !== friendCodeLength) {
      setFound(null);
      return;
    }
    let cancelled = false;
    setProblem("");
    void accountApi
      .lookup(code)
      .then((person) => {
        if (!cancelled) setFound(person);
      })
      .catch((error) => {
        if (!cancelled) setProblem(describeError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [open, phase, code]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isTopDialog(dialogRef)) {
        event.stopImmediatePropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  if (!open || phase === "signingIn") return null;

  const send = async () => {
    if (!found || found.self || busy) return;
    setBusy(true);
    try {
      const answer = await accountApi.addFriend(code);
      applySocial(answer);
      useUi.getState().toast(t(answer.result === "friends" ? "friends.toast.nowFriends" : "friends.toast.sent", { name: found.name || t("friends.someone") }), "success");
      close();
    } catch (error) {
      setProblem(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="backdrop backdrop--top" onMouseDown={close}>
      <div
        ref={dialogRef}
        className="dialog dialog--small add-friend"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-friend-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog__head">
          <h2 id="add-friend-title">{t("friends.add.title")}</h2>
          <button className="icon-button" aria-label={t("common.close")} onClick={close}>
            <X size={18} />
          </button>
        </div>
        {phase !== "signedIn" ? (
          <div className="add-friend__signin">
            <p className="dialog__text">{t("friends.add.signInFirst")}</p>
            <button className="button button--primary button--block google-button" onClick={() => void signIn()}>
              <GoogleMark />
              {t("account.signIn")}
            </button>
          </div>
        ) : (
          <>
            <p className="dialog__text">{t("friends.add.text")}</p>
            <input
              className="input add-friend__input"
              data-autofocus
              value={formatFriendCode(code)}
              placeholder="XXXX-XXXX"
              maxLength={friendCodeLength + 1}
              spellCheck={false}
              onChange={(event) => setCode(cleanFriendCode(event.target.value))}
              onPaste={(event) => {
                event.preventDefault();
                setCode(cleanFriendCode(event.clipboardData.getData("text")));
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void send();
              }}
            />
            {found && (
              <div className="add-friend__found">
                <PersonAvatar name={found.name} avatar={found.avatar} size={40} />
                <b>{found.name || t("friends.someone")}</b>
                {found.self && <small>{t("friends.add.yourself")}</small>}
              </div>
            )}
            {problem && <p className="add-friend__problem">{problem}</p>}
            <div className="dialog__actions">
              <button className="button button--primary" disabled={!found || found.self || busy} onClick={() => void send()}>
                {busy ? <LoaderCircle size={16} className="spin" /> : <UserPlus size={16} />}
                {t("friends.add.send")}
              </button>
            </div>
            {account?.code && <CopyInvite code={account.code} />}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
