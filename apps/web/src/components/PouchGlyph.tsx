import { useId } from "react";
import styles from "./PouchGlyph.module.css";

const TONES = [
  "#9945ff", // purple
  "#14c8a4", // teal
  "#f2a33a", // marigold
  "#4f8cff", // blue
  "#ee6a8c", // rose
];

const SIZES = { sm: 64, md: 112, lg: 168 } as const;

function hashName(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  // Mix the bits so similar names land on different tones.
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function usd(n: number) {
  return `$${n.toFixed(2)}`;
}

const BODY =
  "M46 34 C22 54 10 82 14 112 Q16 130 36 130 H84 Q104 130 106 112 C110 82 98 54 74 34 Z";
const TOP = 34;
const BOTTOM = 130;

export function PouchGlyph({
  name,
  remaining,
  limit,
  tone,
  size = "md",
  frozen = false,
}: {
  name: string;
  remaining: number;
  limit: number;
  tone?: number;
  size?: "sm" | "md" | "lg";
  frozen?: boolean;
}) {
  const uid = useId().replace(/:/g, "");
  const ratio =
    limit > 0 ? Math.min(1, Math.max(0, remaining / limit)) : 0;
  const index =
    ((tone ?? hashName(name)) % TONES.length + TONES.length) % TONES.length;
  const fill = frozen ? "#6b6a73" : TONES[index];
  const fillTop = BOTTOM - (BOTTOM - TOP) * ratio;
  const px = SIZES[size];
  const label = `${name}: ${usd(remaining)} of ${usd(limit)} left today${
    frozen ? ", frozen" : ""
  }`;

  return (
    <svg
      className={styles.pouch}
      width={px}
      height={(px * 150) / 120}
      viewBox="0 0 120 150"
      role="img"
      aria-label={label}
    >
      <defs>
        <clipPath id={`${uid}-clip`}>
          <path d={BODY} />
        </clipPath>
      </defs>
      <path d={BODY} className={styles.body} />
      <g clipPath={`url(#${uid}-clip)`}>
        <rect
          x="0"
          y={fillTop}
          width="120"
          height={BOTTOM - fillTop + 2}
          fill={fill}
          className={styles.fill}
        />
        {ratio > 0 && ratio < 1 ? (
          <line
            x1="0"
            x2="120"
            y1={fillTop}
            y2={fillTop}
            className={styles.level}
          />
        ) : null}
      </g>
      <path d={BODY} className={styles.outline} />
      {/* cinched neck and drawstring */}
      <rect x="40" y="26" width="40" height="10" rx="5" className={styles.neck} />
      <path
        d="M52 28 C44 14 34 12 28 18 M68 28 C76 14 86 12 92 18"
        className={styles.string}
      />
      {frozen ? (
        <g className={styles.lock}>
          <rect x="49" y="84" width="22" height="18" rx="3" />
          <path d="M53 84 v-6 a7 7 0 0 1 14 0 v6" />
        </g>
      ) : null}
    </svg>
  );
}
