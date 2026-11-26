import { Order, Schema } from "effect";

/**
 * A Lar release: a semantic version without build metadata, such as `0.9.0` or `0.10.0-rc.1`.
 * Every workspace package and both iOS apps carry it, and `scripts/check-version.sh` keeps them
 * equal and refuses any version this does not read.
 */
export const Release = Schema.String.check(
  Schema.isPattern(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*)?$/u,
  ),
).pipe(Schema.brand("Release"));

/** A Lar release, such as `0.9.0` or `0.10.0-rc.1`. */
export type Release = typeof Release.Type;

/** A release split into its three numbers and its pre-release identifiers, none for a release. */
interface Parts {
  readonly numbers: ReadonlyArray<string>;
  readonly prerelease: ReadonlyArray<string>;
}

const partsOf = (release: Release): Parts => {
  const dash = release.indexOf("-");

  return dash === -1
    ? { numbers: release.split("."), prerelease: [] }
    : {
        numbers: release.slice(0, dash).split("."),
        prerelease: release.slice(dash + 1).split("."),
      };
};

const isNumeral = (identifier: string): boolean => /^\d+$/u.test(identifier);

/** Numerals without leading zeros, of any length: the longer one is the greater. */
const NumeralOrder: Order.Order<string> = Order.combine(
  Order.mapInput(Order.Number, (numeral: string) => numeral.length),
  Order.String,
);

/** Semver's order of pre-release identifiers: numerals by value, below any text, text by ASCII. */
const IdentifierOrder: Order.Order<string> = Order.make((self, that) => {
  if (isNumeral(self) && isNumeral(that)) return NumeralOrder(self, that);

  if (isNumeral(self) || isNumeral(that)) return isNumeral(self) ? -1 : 1;

  return Order.String(self, that);
});

/**
 * Orders releases the way semver orders versions: by major, minor, and patch as numbers
 * (`0.10.0` follows `0.9.0`), then a pre-release before its release (`0.10.0-rc.1` before
 * `0.10.0`), then pre-releases identifier by identifier (`rc.2` before `rc.10`, `rc` before `rc.1`).
 */
export const ReleaseOrder: Order.Order<Release> = Order.mapInput(
  Order.combineAll([
    Order.mapInput(Order.Array(NumeralOrder), ({ numbers }: Parts) => numbers),
    Order.mapInput(Order.Boolean, ({ prerelease }: Parts) => prerelease.length === 0),
    Order.mapInput(Order.Array(IdentifierOrder), ({ prerelease }: Parts) => prerelease),
  ]),
  partsOf,
);
