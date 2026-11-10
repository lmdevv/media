import { MediaVersion } from "@media/contracts/models/catalog";
import { Versions } from "@media/sdk/effect";
import { Option, Schema } from "effect";
import { useMemo, useState } from "react";

import { browserMediaSupport } from "./browser-support";
import { detectCapabilities } from "./capabilities";

/** A version as the platform lists it, by the id that starts it. */
interface Listed<Id extends string> {
  readonly id: Id;
}

/** One listed version beside its facts as the SDK's `Versions` reads them. */
export interface VersionFacts<Version> {
  readonly version: Version;
  readonly facts: MediaVersion;
}

const decodeVersions = Schema.decodeUnknownOption(Schema.Array(MediaVersion));

const NO_FACTS: ReadonlyArray<never> = [];

/**
 * Each of `versions` (as `movies.titles.versions` or `movies.titles.get` list them) beside its
 * facts, in order; none when the list is not one of versions the media contracts describe.
 */
export const withFacts = <Version>(
  versions: ReadonlyArray<Version>,
): ReadonlyArray<VersionFacts<Version>> =>
  Option.match(decodeVersions(versions), {
    onNone: () => NO_FACTS,
    onSome: (decoded) =>
      decoded.flatMap((facts, index) => {
        const version = versions[index];

        return version === undefined ? [] : [{ version, facts }];
      }),
  });

const usePreferredVersion = <Version>(versions: ReadonlyArray<Version>): Version | null => {
  const capabilities = useMemo(() => detectCapabilities(browserMediaSupport()), []);

  return useMemo(() => {
    const listed = withFacts(versions);

    const preferred = Versions.preferredVersion(
      listed.map((each) => each.facts),
      capabilities,
    );

    return Option.match(preferred, {
      onNone: () => null,
      onSome: (facts) => listed.find((each) => each.facts === facts)?.version ?? null,
    });
  }, [versions, capabilities]);
};

/** The version chosen among several, and the way to choose another. */
export interface VersionChoice<Version extends Listed<string>> {
  /** The version Play plays; null without versions. */
  readonly chosen: Version | null;
  readonly choose: (id: Version["id"]) => void;
}

/**
 * The viewer's choice among `versions`, starting at the preferred one. A pick holds while its
 * version is listed; the list updating (another version played elsewhere) moves only the default.
 */
export const useVersionChoice = <Version extends Listed<string>>(
  versions: ReadonlyArray<Version>,
): VersionChoice<Version> => {
  const preferred = usePreferredVersion(versions);
  const [picked, setPicked] = useState<Version["id"] | null>(null);
  const chosen = versions.find((version) => version.id === picked) ?? preferred;

  return { chosen, choose: setPicked };
};
