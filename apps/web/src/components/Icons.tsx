import type { CSSProperties } from "react";
export type IconName =
  | "grid"
  | "pouch"
  | "arrow"
  | "plus"
  | "shield"
  | "spark"
  | "receipt"
  | "cart"
  | "pause"
  | "leaf"
  | "bolt";
export function Icon({
  name,
  size = 20,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  const paths: Record<IconName, React.ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    pouch: (
      <>
        <path d="m8 3 1 5h6l1-5-4 1-4-1Z" />
        <path d="M9 8C6 11 3 14 4 18s15 4 16 0-2-7-5-10M8 9h8" />
        <path d="M10 14h4m-2-2v6" />
      </>
    ),
    arrow: (
      <>
        <path d="M5 12h14m-5-5 5 5-5 5" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    spark: (
      <>
        <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" />
      </>
    ),
    receipt: (
      <>
        <path d="M5 3h14v18l-3-2-4 2-4-2-3 2V3Z" />
        <path d="M9 8h6M9 12h6" />
      </>
    ),
    cart: (
      <>
        <path d="M3 4h2l3 12h10l3-9H6" />
        <circle cx="9" cy="20" r="1" />
        <circle cx="18" cy="20" r="1" />
      </>
    ),
    pause: (
      <>
        <path d="M8 5v14M16 5v14" />
      </>
    ),
    leaf: (
      <>
        <path d="M19 4C6 1 1 13 7 17c6 4 14-1 12-13Z" />
        <path d="M4 21 15 9" />
      </>
    ),
    bolt: <path d="m14 2-9 12h6l-1 8 9-12h-6l1-8Z" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      {paths[name]}
    </svg>
  );
}
