import { Release } from "@media/contracts/release";

import packageJson from "../package.json" with { type: "json" };

/** The Lar release this server runs, read from its package's version. */
export const RELEASE: Release = Release.make(packageJson.version);
