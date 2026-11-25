import { Order, Schema } from "effect";

/**
 * A Lar release, such as `0.9.0`. Every workspace package and both iOS apps carry it, and
 * `scripts/check-version.sh` keeps them equal.
 */
export const Release = Schema.String.check(
  Schema.isPattern(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
).pipe(Schema.brand("Release"));

/** A Lar release, such as `0.9.0`. */
export type Release = typeof Release.Type;

const partsOf = (release: Release): readonly [number, number, number] => {
  const [major = 0, minor = 0, patch = 0] = release.split(".").map(Number);

  return [major, minor, patch];
};

/** Orders releases by major, then minor, then patch, each as a number: `0.10.0` follows `0.9.0`. */
export const ReleaseOrder: Order.Order<Release> = Order.mapInput(
  Order.Tuple([Order.Number, Order.Number, Order.Number]),
  partsOf,
);
