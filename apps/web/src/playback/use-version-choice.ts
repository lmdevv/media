import type { MediaFileId } from "@media/contracts/ids";
import type { MediaVersion } from "@media/contracts/models/catalog";
import { Versions } from "@media/sdk/effect";
import { Option } from "effect";
import { useMemo, useState } from "react";

import { browserMediaSupport } from "./browser-support";
import { detectCapabilities } from "./capabilities";

const usePreferredVersion = (versions: ReadonlyArray<MediaVersion>): MediaVersion | null => {
  const capabilities = useMemo(() => detectCapabilities(browserMediaSupport()), []);

  return useMemo(
    () => Option.getOrNull(Versions.preferredVersion(versions, capabilities)),
    [versions, capabilities],
  );
};

/** The version chosen among several, and the way to choose another. */
export interface VersionChoice {
  /** The version Play plays; null without versions. */
  readonly chosen: MediaVersion | null;
  readonly choose: (id: MediaFileId) => void;
}

/**
 * The viewer's choice among `versions`, starting at the preferred one. A pick holds while its
 * version is listed; the list updating (another version played elsewhere) moves only the default.
 */
export const useVersionChoice = (versions: ReadonlyArray<MediaVersion>): VersionChoice => {
  const preferred = usePreferredVersion(versions);
  const [picked, setPicked] = useState<MediaFileId | null>(null);
  const chosen = versions.find((version) => version.id === picked) ?? preferred;

  return { chosen, choose: setPicked };
};
