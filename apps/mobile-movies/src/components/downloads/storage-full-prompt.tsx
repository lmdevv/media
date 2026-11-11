import { router } from "expo-router";
import { useEffect, useRef } from "react";

import { downloadHref } from "@/lib/routes";
import { useDownloads } from "@/session/downloads";

/** Watches the downloads and opens H21 for one that just ran out of space. */
export function StorageFullPrompt() {
  const { snapshot } = useDownloads();
  const seen = useRef<ReadonlySet<string> | null>(null);

  useEffect(() => {
    const full = new Set(
      (snapshot?.store.downloads ?? [])
        .filter((download) => download.phase === "noSpace")
        .map((download) => download.id),
    );

    const before = seen.current;

    seen.current = snapshot === null ? null : full;

    if (before === null) return;
    const fresh = [...full].find((id) => !before.has(id));

    if (fresh !== undefined) router.push(`${downloadHref(fresh)}/storage-full`);
  }, [snapshot]);

  return null;
}
