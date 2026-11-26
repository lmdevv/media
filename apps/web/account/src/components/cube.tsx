import { cn } from "@media/ui/lib/utils";
import type { ReactNode } from "react";

/** The fill classes of a cube's three visible faces. */
export interface Faces {
  readonly top: string;
  readonly left: string;
  readonly right: string;
}

export const TONES = {
  lit: { top: "fill-accent", left: "fill-stone-left", right: "fill-stone-right" },
  glyph: { top: "fill-glyph-top", left: "fill-glyph-left", right: "fill-glyph-right" },
} as const satisfies Record<string, Faces>;

/**
 * An isometric cube. `children` draw on its left face, in a 24-unit box such as a Lucide icon's.
 * Decorative: the text beside it names what it stands for.
 */
export function Cube({
  faces,
  className,
  children,
}: {
  readonly faces: Faces;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden className={cn("shrink-0", className)}>
      <polygon points="6.7,25 50,0 93.3,25 50,50" className={faces.top} />
      <polygon points="6.7,25 50,50 50,100 6.7,75" className={faces.left} />
      <polygon points="50,50 93.3,25 93.3,75 50,100" className={faces.right} />
      {children === undefined ? null : (
        <g
          transform="matrix(1.335 0.771 0 1.542 12.329 34.75)"
          fill="none"
          stroke="white"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {children}
        </g>
      )}
    </svg>
  );
}

const HALF_WIDTH = 25.03;

const QUARTER_HEIGHT = 14.45;

const topFace = (x: number, y: number): string =>
  `${x},${y} ${x - HALF_WIDTH},${y - QUARTER_HEIGHT} ${x},${y - 2 * QUARTER_HEIGHT} ${x + HALF_WIDTH},${y - QUARTER_HEIGHT}`;

const rightFace = (x: number, y: number): string =>
  `${x},${y} ${x + HALF_WIDTH},${y - QUARTER_HEIGHT} ${x + HALF_WIDTH},${y + QUARTER_HEIGHT} ${x},${y + 2 * QUARTER_HEIGHT}`;

const leftFace = (x: number, y: number): string =>
  `${x},${y} ${x},${y + 2 * QUARTER_HEIGHT} ${x - HALF_WIDTH},${y + QUARTER_HEIGHT} ${x - HALF_WIDTH},${y - QUARTER_HEIGHT}`;

const TILE: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [51.96, 0],
  [25.98, 45],
  [0, 90],
  [51.96, 90],
];

const FIELDS = {
  page: {
    height: 260,
    lit: [
      [909.3, 135],
      [1091.16, 180],
      [1273.02, 135],
      [1013.22, 225],
      [1376.94, 225],
    ],
  },
  home: {
    height: 400,
    lit: [
      [961.26, 135],
      [1169.1, 225],
      [1324.98, 135],
      [857.34, 315],
      [1273.02, 315],
      [1039.2, 360],
      [1428.9, 225],
    ],
  },
} as const;

const FIELD_WIDTH = 1440;

export function CubeField({ kind }: { readonly kind: keyof typeof FIELDS }) {
  const { height, lit } = FIELDS[kind];

  return (
    <svg
      aria-hidden
      width={FIELD_WIDTH}
      height={height}
      viewBox={`0 0 ${FIELD_WIDTH} ${height}`}
      className="pointer-events-none absolute top-0 right-0 -z-10 max-w-none max-md:opacity-40"
    >
      <defs>
        <pattern id="cube-field" width="51.96" height="90" patternUnits="userSpaceOnUse">
          {TILE.map(([x, y]) => (
            <g key={`${x},${y}`}>
              <polygon points={topFace(x, y)} className="fill-field-top" />
              <polygon points={rightFace(x, y)} className="fill-field-right" />
              <polygon points={leftFace(x, y)} className="fill-field-left" />
            </g>
          ))}
        </pattern>
        <linearGradient id="cube-field-across" x1="0" x2="1">
          <stop offset="0" style={{ stopColor: "var(--color-page)", stopOpacity: 0.94 }} />
          <stop offset="0.45" style={{ stopColor: "var(--color-page)", stopOpacity: 0.6 }} />
          <stop offset="1" style={{ stopColor: "var(--color-page)", stopOpacity: 0.12 }} />
        </linearGradient>
        <linearGradient id="cube-field-down" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: "var(--color-page)", stopOpacity: 0.35 }} />
          <stop offset="0.7" style={{ stopColor: "var(--color-page)", stopOpacity: 0.55 }} />
          <stop offset="1" style={{ stopColor: "var(--color-page)", stopOpacity: 1 }} />
        </linearGradient>
      </defs>
      <rect width={FIELD_WIDTH} height={height} fill="url(#cube-field)" />
      {lit.map(([x, y]) => (
        <polygon key={`${x},${y}`} points={topFace(x, y)} className="fill-accent" />
      ))}
      <rect width={FIELD_WIDTH} height={height} fill="url(#cube-field-across)" />
      <rect width={FIELD_WIDTH} height={height} fill="url(#cube-field-down)" />
    </svg>
  );
}
