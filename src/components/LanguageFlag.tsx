import type { ReactNode } from "react";

const width = 30;
const height = 20;

function rows(colors: string[]): ReactNode {
  const step = height / colors.length;
  return colors.map((color, index) => <rect key={index} x={0} y={index * step} width={width} height={step + 0.2} fill={color} />);
}

function columns(colors: string[]): ReactNode {
  const step = width / colors.length;
  return colors.map((color, index) => <rect key={index} x={index * step} y={0} width={step + 0.2} height={height} fill={color} />);
}

function field(color: string): ReactNode {
  return <rect width={width} height={height} fill={color} />;
}

function cross(color: string, x: number, y: number, thickness: number): ReactNode {
  return (
    <>
      <rect x={x} y={0} width={thickness} height={height} fill={color} />
      <rect x={0} y={y} width={width} height={thickness} fill={color} />
    </>
  );
}

function star(cx: number, cy: number, radius: number, color: string): ReactNode {
  const points: string[] = [];
  for (let index = 0; index < 10; index++) {
    const reach = index % 2 === 0 ? radius : radius * 0.39;
    const angle = (Math.PI / 5) * index - Math.PI / 2;
    points.push(`${(cx + reach * Math.cos(angle)).toFixed(2)},${(cy + reach * Math.sin(angle)).toFixed(2)}`);
  }
  return <polygon points={points.join(" ")} fill={color} />;
}

const flags: Record<string, () => ReactNode> = {
  ru: () => rows(["#ffffff", "#0039a6", "#d52b1e"]),
  uk: () => rows(["#0057b7", "#ffd700"]),
  de: () => rows(["#000000", "#dd0000", "#ffce00"]),
  pl: () => rows(["#ffffff", "#dc143c"]),
  nl: () => rows(["#ae1c28", "#ffffff", "#21468b"]),
  hu: () => rows(["#ce2939", "#ffffff", "#477050"]),
  bg: () => rows(["#ffffff", "#00966e", "#d62612"]),
  lt: () => rows(["#fdb913", "#006a44", "#c1272d"]),
  lv: () => rows(["#9e3039", "#9e3039", "#ffffff", "#9e3039", "#9e3039"]),
  et: () => rows(["#0072ce", "#000000", "#ffffff"]),
  hy: () => rows(["#d90012", "#0033a0", "#f2a800"]),
  id: () => rows(["#ce1126", "#ffffff"]),
  be: () => rows(["#cf101a", "#cf101a", "#007c30"]),
  sr: () => rows(["#c6363c", "#0c4076", "#ffffff"]),
  hr: () => rows(["#ff0000", "#ffffff", "#171796"]),
  es: () => rows(["#aa151b", "#f1bf00", "#f1bf00", "#aa151b"]),
  th: () => rows(["#a51931", "#f4f5f8", "#2d2a4a", "#2d2a4a", "#f4f5f8", "#a51931"]),
  az: () => rows(["#00b5e2", "#ef3340", "#509e2f"]),
  fr: () => columns(["#0055a4", "#ffffff", "#ef4135"]),
  it: () => columns(["#009246", "#ffffff", "#ce2b37"]),
  ro: () => columns(["#002b7f", "#fcd116", "#ce1126"]),
  ja: () => (
    <>
      {field("#ffffff")}
      <circle cx={15} cy={10} r={6} fill="#bc002d" />
    </>
  ),
  ko: () => (
    <>
      {field("#ffffff")}
      <path d="M9.5 10a5.5 5.5 0 0 1 11 0z" fill="#cd2e3a" />
      <path d="M9.5 10a5.5 5.5 0 0 0 11 0z" fill="#0047a0" />
    </>
  ),
  zh: () => (
    <>
      {field("#de2910")}
      {star(7, 7, 4, "#ffde00")}
    </>
  ),
  vi: () => (
    <>
      {field("#da251d")}
      {star(15, 10, 5.5, "#ffff00")}
    </>
  ),
  tr: () => (
    <>
      {field("#e30a17")}
      <circle cx={11} cy={10} r={5} fill="#ffffff" />
      <circle cx={12.4} cy={10} r={4} fill="#e30a17" />
      {star(17.6, 10, 2.4, "#ffffff")}
    </>
  ),
  pt: () => (
    <>
      {field("#ff0000")}
      <rect width={12} height={height} fill="#006600" />
      <circle cx={12} cy={10} r={3.8} fill="#ffcc00" />
    </>
  ),
  sv: () => (
    <>
      {field("#006aa7")}
      {cross("#fecc00", 9, 8, 4)}
    </>
  ),
  fi: () => (
    <>
      {field("#ffffff")}
      {cross("#003580", 9, 8, 4)}
    </>
  ),
  da: () => (
    <>
      {field("#c8102e")}
      {cross("#ffffff", 9, 8.5, 3)}
    </>
  ),
  no: () => (
    <>
      {field("#ba0c2f")}
      {cross("#ffffff", 8, 7, 6)}
      {cross("#00205b", 9.5, 8.5, 3)}
    </>
  ),
  ka: () => (
    <>
      {field("#ffffff")}
      {cross("#ff0000", 13, 8, 4)}
    </>
  ),
  cs: () => (
    <>
      {rows(["#ffffff", "#d7141a"])}
      <polygon points="0,0 15,10 0,20" fill="#11457e" />
    </>
  ),
  kk: () => (
    <>
      {field("#00afca")}
      <circle cx={15} cy={10} r={4} fill="#fec50c" />
    </>
  ),
  hi: () => (
    <>
      {rows(["#ff9933", "#ffffff", "#138808"])}
      <circle cx={15} cy={10} r={2.6} fill="none" stroke="#000080" strokeWidth={0.8} />
    </>
  ),
  he: () => (
    <>
      {field("#ffffff")}
      <rect x={0} y={2.5} width={width} height={2.5} fill="#0038b8" />
      <rect x={0} y={15} width={width} height={2.5} fill="#0038b8" />
      <polygon points="15,6.4 18.1,11.8 11.9,11.8" fill="none" stroke="#0038b8" strokeWidth={0.8} />
      <polygon points="15,13.6 18.1,8.2 11.9,8.2" fill="none" stroke="#0038b8" strokeWidth={0.8} />
    </>
  ),
  en: () => (
    <>
      {field("#012169")}
      <path d="M0 0L30 20M30 0L0 20" stroke="#ffffff" strokeWidth={4} />
      <path d="M0 0L30 20M30 0L0 20" stroke="#c8102e" strokeWidth={1.6} />
      <path d="M15 0V20M0 10H30" stroke="#ffffff" strokeWidth={6.6} />
      <path d="M15 0V20M0 10H30" stroke="#c8102e" strokeWidth={4} />
    </>
  ),
};

export function LanguageFlag({ code }: { code: string }) {
  const draw = flags[code];
  if (!draw) return <span className="flag flag--code">{code ? code.toUpperCase() : "?"}</span>;
  return (
    <svg className="flag" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {draw()}
    </svg>
  );
}
