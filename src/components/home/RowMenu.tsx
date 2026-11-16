import { useCallback, useRef, useState } from "react";
import { EllipsisVertical } from "lucide-react";
import { useDismissOutside } from "../Cards";
import { useT } from "../../lib/i18n";
import { setBlockHidden, type HomeBlockId } from "../../state/homeLayout";
import { useUi } from "../../state/ui";

export function RowMenu({ block, onCustomize }: { block: HomeBlockId; onCustomize: () => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissOutside(open, rootRef, close);

  const hide = () => {
    setOpen(false);
    setBlockHidden(block, true);
    useUi.getState().toast(t("home.menu.hidden"), "info", { label: t("feed.dismissed.undo"), run: () => setBlockHidden(block, false) });
  };

  return (
    <div className="row-menu" ref={rootRef}>
      <button className="row-menu__button" aria-label={t("home.menu.open")} title={t("home.menu.open")} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <EllipsisVertical size={16} />
      </button>
      {open && (
        <div className="dismiss-menu row-menu__list" role="menu">
          <button role="menuitem" onClick={hide}>
            {t("home.menu.hide")}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onCustomize();
            }}
          >
            {t("home.menu.customize")}
          </button>
        </div>
      )}
    </div>
  );
}
