import type { CSSProperties } from "react";
import { logoBox, needsCaption, type ShownLogo } from "../lib/titleLogo";

export interface LogoFit {
  area: number;
  maxWidth: number;
  maxHeight: number;
}

export function TitleLogoImage({ logo, title, originalTitle, fit }: { logo: ShownLogo; title: string; originalTitle: string; fit: LogoFit }) {
  const box = logoBox(logo.aspect, fit.area, fit.maxWidth, fit.maxHeight);
  const caption = needsCaption(logo, title, originalTitle);
  return (
    <span className={`title-logo is-${logo.tone}`}>
      <img
        src={logo.url}
        alt={caption ? "" : title}
        width={box.width}
        height={box.height}
        style={{ "--logo-width": `${box.width}px` } as CSSProperties}
        draggable={false}
      />
      {caption && <span className="title-logo__caption">{title}</span>}
    </span>
  );
}
