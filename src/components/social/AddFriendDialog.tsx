import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Check, Copy, LoaderCircle, Search, UserCheck, UserPlus, X } from "lucide-react";
import { create } from "zustand";
import { accountApi, cleanFriendCode, formatFriendCode, friendCodeLength, inviteLink, type FoundPerson } from "../../lib/accountApi";
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
const searchDelayMs = 350;
const searchMin = 2;
const codePattern = /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/;

function codeIn(text: string): string {
  const trimmed = text.trim();
  if (!codePattern.test(trimmed) && !/\/f\//.test(trimmed)) return "";
  const code = cleanFriendCode(trimmed);
  return code.length === friendCodeLength ? code : "";
}

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
  const navigate = useNavigate();
  const { open, code: preset, close } = useAddFriend();
  const phase = useAccount((state) => state.phase);
  const account = useAccount((state) => state.account);
  const signIn = useAccount((state) => state.signIn);
  const applySocial = useAccount((state) => state.applySocial);
  const [text, setText] = useState("");
  const [found, setFound] = useState<{ id: number; name: string; avatar: string | null; self: boolean } | null>(null);
  const [people, setPeople] = useState<FoundPerson[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState<number | "code" | null>(null);
  const code = codeIn(text);
  const query = text.trim();
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open && phase !== "signingIn");

  useEffect(() => {
    if (!open) return;
    setText(preset ? formatFriendCode(preset) : "");
    setFound(null);
    setPeople(null);
    setProblem("");
  }, [open, preset]);

  useEffect(() => {
    if (!open || phase !== "signedIn" || query.length < searchMin || code) {
      setPeople(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      void accountApi
        .search(query)
        .then((answer) => {
          if (!cancelled) setPeople(answer.people);
        })
        .catch((error) => {
          if (!cancelled) setProblem(describeError(error));
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, searchDelayMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, phase, query, code]);

  useEffect(() => {
    if (!open || phase !== "signedIn" || !code) {
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
    if (!found || found.self || busy !== null) return;
    setBusy("code");
    try {
      const answer = await accountApi.addFriend(code);
      applySocial(answer);
      useUi.getState().toast(t(answer.result === "friends" ? "friends.toast.nowFriends" : "friends.toast.sent", { name: found.name || t("friends.someone") }), "success");
      close();
    } catch (error) {
      setProblem(describeError(error));
    } finally {
      setBusy(null);
    }
  };

  const sendTo = async (person: FoundPerson) => {
    if (busy !== null) return;
    setBusy(person.id);
    setProblem("");
    try {
      const answer = person.relation === "incoming" ? { ...(await accountApi.accept(person.id)), result: "friends" as const } : await accountApi.addFriendById(person.id);
      applySocial(answer);
      const relation = answer.result === "friends" ? "friend" : "outgoing";
      setPeople((list) => list?.map((item) => (item.id === person.id ? { ...item, relation } : item)) ?? null);
      useUi.getState().toast(t(answer.result === "friends" ? "friends.toast.nowFriends" : "friends.toast.sent", { name: person.name || t("friends.someone") }), "success");
    } catch (error) {
      setProblem(describeError(error));
    } finally {
      setBusy(null);
    }
  };

  const openProfile = (id: number) => {
    close();
    navigate(`/friend/${id}`);
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
            <label className="add-friend__field">
              <Search size={16} />
              <input
                className="input add-friend__input"
                data-autofocus
                value={text}
                placeholder={t("friends.add.placeholder")}
                maxLength={60}
                spellCheck={false}
                onChange={(event) => setText(event.target.value)}
                onPaste={(event) => {
                  const pasted = event.clipboardData.getData("text");
                  if (!/\/f\//.test(pasted)) return;
                  event.preventDefault();
                  setText(formatFriendCode(cleanFriendCode(pasted)));
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && code) void send();
                }}
              />
              {searching && <LoaderCircle size={16} className="spin" />}
            </label>
            {code && found && (
              <div className="add-friend__found">
                <PersonAvatar name={found.name} avatar={found.avatar} size={40} />
                <b>{found.name || t("friends.someone")}</b>
                {found.self ? (
                  <small>{t("friends.add.yourself")}</small>
                ) : (
                  <button className="button button--small button--primary" disabled={busy !== null} onClick={() => void send()}>
                    {busy === "code" ? <LoaderCircle size={14} className="spin" /> : <UserPlus size={14} />}
                    {t("friends.add.send")}
                  </button>
                )}
              </div>
            )}
            {people && (
              <div className="add-friend__results">
                {people.length === 0 ? (
                  <p className="add-friend__nobody">{t("friends.add.nobody")}</p>
                ) : (
                  people.map((person) => (
                    <div key={person.id} className="add-friend__person">
                      <PersonAvatar name={person.name} avatar={person.avatar} size={36} />
                      <b>{person.name || t("friends.someone")}</b>
                      {person.relation === "friend" ? (
                        <button className="button button--small" onClick={() => openProfile(person.id)}>
                          <UserCheck size={14} />
                          {t("friends.add.isFriend")}
                        </button>
                      ) : person.relation === "outgoing" ? (
                        <small>{t("friends.requests.pending")}</small>
                      ) : (
                        <button className="button button--small button--primary" disabled={busy !== null} onClick={() => void sendTo(person)}>
                          {busy === person.id ? <LoaderCircle size={14} className="spin" /> : <UserPlus size={14} />}
                          {person.relation === "incoming" ? t("friends.requests.accept") : t("friends.add.short")}
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
            {problem && <p className="add-friend__problem">{problem}</p>}
            {account?.code && <CopyInvite code={account.code} />}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
