import { cn } from "@music/ui/lib/utils";
import { useMemo } from "react";
import { encode } from "uqr";

/**
 * A QR code for `value`, drawn as SVG in the text color so it follows the theme. Encoded with
 * `uqr` (MIT), with medium error correction so a phone camera reads it off a screen.
 */
export function QrCode({
  value,
  label,
  className,
}: {
  readonly value: string;
  readonly label: string;
  readonly className?: string;
}) {
  const { size, cells } = useMemo(() => {
    const qr = encode(value, { ecc: "M", border: 2 });

    const dark = qr.data.flatMap((row, y) =>
      row.flatMap((on, x) => (on ? [`M${x} ${y}h1v1h-1z`] : [])),
    );

    return { size: qr.size, cells: dark.join("") };
  }, [value]);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      className={cn("rounded-md bg-bg text-text [shape-rendering:crispEdges]", className)}
    >
      <path d={cells} fill="currentColor" />
    </svg>
  );
}
