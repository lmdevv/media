import type { PlatformSdk } from "@media/sdk/promise";
import { expect } from "@playwright/test";

type LibraryId = Awaited<ReturnType<PlatformSdk["core"]["libraries"]["create"]>>["libraryId"];

type TitleId = Awaited<ReturnType<PlatformSdk["movies"]["titles"]["search"]>>[number]["id"];

export type { LibraryId, TitleId };

const SCAN_TIMEOUT_MS = 60_000;

/** The status of a library's latest scan, or null before its first. */
export const scanStatus = async (platform: PlatformSdk, libraryId: LibraryId) =>
  (await platform.core.libraries.get({ libraryId })).scan?.status ?? null;

/** Waits until a library's latest scan succeeded. */
export const waitForScan = async (
  platform: PlatformSdk,
  libraryId: LibraryId,
  timeout = SCAN_TIMEOUT_MS,
): Promise<void> => {
  await expect.poll(() => scanStatus(platform, libraryId), { timeout }).toBe("succeeded");
};

/**
 * Creates a movies library over `folders` as an admin does in the account client, and waits until
 * its first scan succeeded, unless `wait` is false.
 */
export const createLibrary = async (
  platform: PlatformSdk,
  library: { readonly name: string; readonly folders: ReadonlyArray<string> },
  wait = true,
): Promise<LibraryId> => {
  const created = await platform.core.libraries.create({
    name: library.name,
    kind: "movies",
    folders: [...library.folders],
  });

  if (wait) await waitForScan(platform, created.libraryId);

  return created.libraryId;
};

/** Deletes a library a suite made; its files on disk stay. Never fails the suite. */
export const removeLibrary = async (
  platform: PlatformSdk,
  libraryId: LibraryId | undefined,
): Promise<void> => {
  if (libraryId === undefined) return;

  await platform.core.libraries.remove({ libraryId }).catch(() => undefined);
};

/** The ids of a library's titles by name. */
export const titlesByName = async (
  platform: PlatformSdk,
  libraryId: LibraryId,
): Promise<ReadonlyMap<string, TitleId>> => {
  const page = await platform.movies.titles.list({
    paginationOpts: { numItems: 100, cursor: null },
    libraryId,
  });

  return new Map(page.page.map((title) => [title.name, title.id]));
};

/**
 * Deletes every library `platform` manages whose folders lie under `folder`, as a suite cleans up
 * what it or an import made there.
 */
export const removeLibrariesUnder = async (
  platform: PlatformSdk,
  folder: string,
): Promise<void> => {
  const libraries = await platform.core.libraries
    .list({ paginationOpts: { numItems: 100, cursor: null } })
    .catch(() => ({ page: [] }));

  const details = await Promise.all(
    libraries.page.map((library) =>
      platform.core.libraries.get({ libraryId: library.libraryId }).catch(() => null),
    ),
  );

  await Promise.all(
    details.flatMap((library) =>
      library?.folders?.some((root) => root.startsWith(folder)) === true
        ? [removeLibrary(platform, library.libraryId)]
        : [],
    ),
  );
};
