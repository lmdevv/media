/**
 * E06, E07, G09 · The first scan (setup 3 of 3). It shows live progress while the folders are
 * read, celebrates when they all are, and offers a way on when a scan stops. The session keeps
 * this screen up after the scan ends, until the owner opens the library; Open my library leaves
 * before it ends, and Home then shows the scan still running (G02).
 */
import type { LibraryId } from "@music/commands/ids";
import type { AlbumCard, Home } from "@music/commands/models";
import { useRead, useRun } from "@music/sdk/react";
import { Check, Folder, Info, Music, Play, RotateCw } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Artwork } from "@/components/ui/artwork";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Text } from "@/components/ui/text";
import { accountFailureLine } from "@/lib/account-form";
import { firstScan } from "@/lib/first-scan";
import type { FirstScan } from "@/lib/first-scan";
import { countOf, formatCount } from "@/lib/format";
import { useSetupProgress } from "@/session/session-phase";

/** How often the time left is estimated again between progress updates. */
const TICK_MS = 5000;

/** The time now, a few seconds fresh. */
const useNow = (): number => {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);

    return () => clearInterval(timer);
  }, []);

  return now;
};

const NO_STATS: Home["stats"] = { tracks: 0, albums: 0, artists: 0, durationMs: 0 };

const RUNNING: FirstScan = { kind: "running", percent: null, left: null };

export default function Scan() {
  const libraries = useRead("libraries.list", {});
  const jobs = useRead("jobs.list", {});
  const home = useRead("library.home", {});
  const { setProgress } = useSetupProgress();
  const now = useNow();

  const scan =
    libraries === undefined || jobs === undefined ? RUNNING : firstScan(libraries, jobs, now);

  const stats = home?.stats ?? NO_STATS;
  const leave = () => setProgress("leftScan");

  if (scan.kind === "running") return <Reading scan={scan} stats={stats} onOpen={leave} />;

  if (scan.kind === "done") {
    return <Ready stats={stats} albums={home?.recentlyAdded ?? []} onListen={leave} />;
  }

  return <Stopped scan={scan} onUse={leave} />;
}

/** One of E06's three totals. */
function Stat({
  value,
  noun,
  align,
}: {
  readonly value: number;
  readonly noun: string;
  readonly align: "items-start" | "items-end";
}) {
  return (
    <View className={align} accessible accessibilityLabel={countOf(value, noun)}>
      <Text variant="title">{formatCount(value)}</Text>
      <Text variant="secondary" tone="muted">
        {`${noun}s`}
      </Text>
    </View>
  );
}

/** E06 · The scan in progress. */
function Reading({
  scan,
  stats,
  onOpen,
}: {
  readonly scan: Extract<FirstScan, { readonly kind: "running" }>;
  readonly stats: Home["stats"];
  readonly onOpen: () => void;
}) {
  const percent = scan.percent ?? 0;

  return (
    <Page
      title="Reading your library"
      bottom="plain"
      onBack={null}
      trailing={
        <View className="size-hit-target items-center justify-center">
          <Icon icon={Folder} />
        </View>
      }
    >
      <Text variant="mono" tone="muted">
        SETUP · 3 OF 3
      </Text>
      <Text variant="hero" accessibilityRole="header" className="pt-8 pb-6">
        {"A whole world.\nAlready yours."}
      </Text>
      <View className="flex-row items-baseline justify-between gap-4">
        <Text variant="figure">{`${String(percent)}%`}</Text>
        {scan.left === null ? null : (
          <Text variant="mono" tone="muted" className="flex-1 text-right">
            {scan.left}
          </Text>
        )}
      </View>
      <View
        className="mt-3 mb-6 h-2 overflow-hidden rounded-full bg-border"
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel="Scan progress"
        accessibilityValue={{ min: 0, max: 100, now: percent }}
      >
        <View className="h-2 rounded-full bg-accent" style={{ width: `${String(percent)}%` }} />
      </View>
      <View className="flex-row justify-between">
        <Stat value={stats.tracks} noun="song" align="items-start" />
        <Stat value={stats.albums} noun="album" align="items-start" />
        <Stat value={stats.artists} noun="artist" align="items-end" />
      </View>
      <Notice
        icon={Music}
        title="You can start listening now"
        body="Albums appear as they’re found. The scan continues in the background."
        className="mt-6"
      />
      <View className="pt-6">
        <Button label="Open my library" onPress={onOpen} />
      </View>
    </Page>
  );
}

/** E07 · Every folder read: the first covers, the totals, and on to Home. */
function Ready({
  stats,
  albums,
  onListen,
}: {
  readonly stats: Home["stats"];
  readonly albums: ReadonlyArray<AlbumCard>;
  readonly onListen: () => void;
}) {
  const insets = useSafeAreaInsets();
  const covers = [albums[0] ?? null, albums[1] ?? null];

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="never"
      className="flex-1 bg-canvas"
      contentContainerClassName="pb-row"
      style={{ paddingTop: insets.top }}
    >
      <View className="min-h-row-touch flex-row items-center justify-between px-mobile-edge pt-2 pb-3">
        <Text variant="largeTitle" accessibilityRole="header">
          You’re ready
        </Text>
        <IconButton icon={Check} label="Done" onPress={onListen} />
      </View>
      <View className="px-mobile-edge">
        <View
          className="flex-row items-center justify-center gap-3 py-row"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {covers.map((album, index) => (
            <Artwork
              key={album?.id ?? `placeholder-${String(index)}`}
              url={album?.artUrl ?? null}
              className="size-ios-160 rounded-mobile-card"
            />
          ))}
        </View>
        <Text variant="largeTitle">{"Meet your\ncollection again."}</Text>
        <Text tone="muted" className="pt-4 pb-8">
          {`${countOf(stats.tracks, "song")}. ${countOf(stats.albums, "album")}. All yours.`}
        </Text>
        <Button label="Let’s listen" icon={Play} iconFilled onPress={onListen} />
      </View>
    </ScrollView>
  );
}

/** G09 · A folder's scan stopped: resume it, or go on with what was read. */
function Stopped({
  scan,
  onUse,
}: {
  readonly scan: Extract<FirstScan, { readonly kind: "stopped" }>;
  readonly onUse: () => void;
}) {
  const rescan = useRun("libraries.scan");
  const remove = useRun("libraries.delete");
  const [pending, setPending] = useState<"resume" | "remove" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const folder = scan.path ?? "the folder";
  const anything = scan.added > 0;

  const run = async (action: "resume" | "remove", libraryId: LibraryId) => {
    setPending(action);
    setFailure(null);

    try {
      // A removed folder leaves no library behind, so the stack goes back to Add your music.
      if (action === "resume") await rescan({ libraryId });
      else await remove({ libraryId });
    } catch (cause) {
      setFailure(accountFailureLine(cause));
    } finally {
      setPending(null);
    }
  };

  return (
    <Page
      title="The scan stopped"
      bottom="plain"
      onBack={null}
      trailing={
        <View className="size-hit-target items-center justify-center">
          <Icon icon={Folder} />
        </View>
      }
    >
      <Text variant="hero" accessibilityRole="header" className="pt-row pb-6">
        {anything ? "Your music\nis still here." : "Nothing could\nbe read yet."}
      </Text>
      <Notice
        icon={Info}
        title={scan.added === 1 ? "1 song was added" : `${countOf(scan.added, "song")} were added`}
        body={`The server can’t read ${folder} right now. Check that the folder is mounted and readable.`}
      />
      <View className="pt-6">
        <Button
          label="Resume scan"
          pendingLabel="Resuming…"
          icon={RotateCw}
          pending={pending === "resume"}
          disabled={pending === "remove"}
          onPress={() => void run("resume", scan.libraryId)}
        />
      </View>
      <View className="pt-3">
        {anything ? (
          <Button label="Use what’s there" variant="secondary" onPress={onUse} />
        ) : (
          <Button
            label="Choose another folder"
            pendingLabel="Removing…"
            variant="secondary"
            pending={pending === "remove"}
            disabled={pending === "resume"}
            onPress={() => void run("remove", scan.libraryId)}
          />
        )}
      </View>
      {failure === null ? null : (
        <Text
          variant="calloutMedium"
          tone="danger"
          className="pt-3"
          accessibilityLiveRegion="polite"
        >
          {failure}
        </Text>
      )}
    </Page>
  );
}
