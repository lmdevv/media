import { encode } from "uqr";

/** The code's side in modules, quiet border included, and the path of its dark modules. */
export interface QrPath {
  readonly size: number;
  readonly path: string;
}

/** Encodes `value` with a two-module quiet border. */
export const qrPath = (value: string): QrPath => {
  const qr = encode(value, { ecc: "M", border: 2 });

  const path = qr.data
    .flatMap((row, y) => row.flatMap((on, x) => (on ? [`M${String(x)} ${String(y)}h1v1h-1z`] : [])))
    .join("");

  return { size: qr.size, path };
};
