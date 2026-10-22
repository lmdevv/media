/**
 * D08 · someone's Jam from a member's phone: who hosts, what plays, listening along here or using
 * the phone as a remote, the member's own songs coming up, and Leave. Only what the host allows
 * shows: pause when members control playback, Add songs when they may add, and removing a song
 * when they may edit it.
 */
import type { QueueItemId } from "@music/commands/ids";
import type { Jam, QueueEntry } from "@music/commands/models";
import { errorMessage } from "@music/sdk/errors";
import { useRead, useRun } from "@music/sdk/react";
import { router } from "expo-router";
import { ListOrdered, Pause, Play, Users, X } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { useSave } from "@/components/states/save-failure";
import { MenuButton } from "@/components/playback/menu-button";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row, RowChevron } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";
import { contributionsOf, listenerCount, quotaNotice } from "@/lib/jam";
import { resolveMediaUrl } from "@/lib/media-url";
import { useDevices, usePlayer, usePlayerActions } from "@/player";
import { useConnection } from "@/session/connection";

import { ToggleRow } from "./toggle-row";
import { useJamLink } from "./use-jam-link";

/** What plays, with pause or play when the host lets members control playback. */
function NowPlayingRow({ canControl }: { readonly canControl: boolean }) {
  const { nowPlaying, status } = usePlayer();
  const { toggle } = usePlayerActions();

  if (nowPlaying === null) {
    return <Row title="Nothing playing yet" subtitle="Songs the host plays show up here" />;
  }

  const playing = status === "playing" || status === "buffering" || status === "loading";

  return (
    <Row
      title={nowPlaying.title}
      subtitle={nowPlaying.artist}
      active
      leading={{ kind: "art", url: nowPlaying.artUrl }}
      trailing={
        canControl ? (
          <IconButton
            icon={playing ? Pause : Play}
            label={playing ? "Pause" : "Play"}
            tone="muted"
            size="inline"
            filled
            onPress={() => void toggle()}
          />
        ) : undefined
      }
      onPress={() => {
        router.push("/player");
      }}
    />
  );
}

/** Listening along on this iPhone, or using it as a remote. */
function ListenToggle({ jam }: { readonly jam: Jam }) {
  const listen = useRun("jam.listen");
  const { thisDevice } = useDevices();
  const [pending, setPending] = useState<boolean | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  if (!jam.settings.listenAlong) {
    return (
      <Notice
        icon={Users}
        title="Playing on the host’s device"
        body={`${jam.host.name} turned off listening along. You can still use this phone as a remote.`}
        className="mt-2"
      />
    );
  }

  const change = async (on: boolean) => {
    setPending(on);
    setFailure(null);

    try {
      await (on ? listen({ on: true, deviceId: thisDevice.id }) : listen({ on: false }));
    } catch (cause) {
      setFailure(cause instanceof Error ? errorMessage(cause) : "Couldn’t change that. Try again.");
    } finally {
      setPending(null);
    }
  };

  return (
    <View>
      <ToggleRow
        title="Listen on this iPhone"
        subtitle="Off uses this phone as a remote."
        value={pending ?? jam.listening}
        disabled={pending !== null}
        onValueChange={(on) => void change(on)}
      />
      {failure === null ? null : (
        <Text variant="calloutMedium" tone="danger" className="pt-2">
          {failure}
        </Text>
      )}
    </View>
  );
}

/** One of the member's songs coming up; removable when the host lets members edit their own. */
function ContributionRow({
  entry,
  origin,
  canRemove,
  onRemove,
}: {
  readonly entry: QueueEntry;
  readonly origin: ReturnType<typeof useConnection>["origin"];
  readonly canRemove: boolean;
  readonly onRemove: (itemId: QueueItemId) => void;
}) {
  return (
    <Row
      title={entry.title}
      subtitle={entry.artist}
      leading={{
        kind: "art",
        url: resolveMediaUrl(origin, entry.artUrl),
        recyclingKey: entry.itemId,
      }}
      trailing={
        canRemove ? (
          <IconButton
            icon={X}
            label={`Remove ${entry.title}`}
            tone="muted"
            size="inline"
            onPress={() => {
              onRemove(entry.itemId);
            }}
          />
        ) : undefined
      }
    />
  );
}

/** The member's songs coming up, and how many more they may add. */
function Contributions({ jam }: { readonly jam: Jam }) {
  const { origin } = useConnection();
  const me = useRead("account.me", {});
  const queue = useRead("queue.list", {});
  const removeFromQueue = useRun("queue.remove");
  const save = useSave();
  const { membersCanAdd, membersCanEdit } = jam.settings;

  const mine =
    me === undefined || queue === undefined ? [] : contributionsOf(queue.queue, queue.index, me.id);

  const quota = quotaNotice(mine.length, jam);

  return (
    <View>
      <SectionHeader
        title="Your contributions"
        action={
          membersCanAdd
            ? {
                kind: "link",
                label: "Add songs",
                onPress: () => {
                  router.navigate("/(app)/(tabs)/(search)");
                },
              }
            : undefined
        }
      />
      {mine.map((entry) => (
        <ContributionRow
          key={entry.itemId}
          entry={entry}
          origin={origin}
          canRemove={membersCanEdit !== "none"}
          onRemove={(itemId) =>
            void save(async () => {
              await removeFromQueue({ itemId });
            }, "Your song is still in the Jam’s queue.")
          }
        />
      ))}
      {membersCanAdd ? (
        <Notice icon={ListOrdered} title={quota.title} body={quota.subtitle} className="mt-4" />
      ) : (
        <Notice
          icon={ListOrdered}
          title="The host isn’t taking songs right now"
          body={`${jam.host.name} controls the queue.`}
          className="mt-4"
        />
      )}
    </View>
  );
}

/** Props for `MemberJam`. */
export interface MemberJamProps {
  readonly jam: Jam;
  /** Leaves the Jam, then goes back to the person's own music. */
  readonly onLeave: () => Promise<void>;
}

/** The member's Jam home. */
export function MemberJam({ jam, onLeave }: MemberJamProps) {
  const { share } = useJamLink(jam.code);
  const [leaving, setLeaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const leave = async () => {
    setLeaving(true);
    setFailure(null);

    try {
      await onLeave();
    } catch (cause) {
      setFailure(cause instanceof Error ? errorMessage(cause) : "Couldn’t leave. Try again.");
      setLeaving(false);
    }
  };

  return (
    <Page
      title={`${jam.host.name}’s Jam`}
      bottom="plain"
      trailing={
        <MenuButton
          label="Jam actions"
          items={[
            { title: "Share invite link", icon: "square.and.arrow.up", onPress: share },
            {
              title: "Leave Jam",
              icon: "rectangle.portrait.and.arrow.right",
              destructive: true,
              onPress: () => void leave(),
            },
          ]}
        />
      }
    >
      <Row
        title={`${jam.host.name} is hosting`}
        subtitle={listenerCount(jam)}
        active
        leading={{ kind: "icon", icon: Users, tone: "accent" }}
        trailing={<RowChevron />}
        onPress={() => {
          router.push("/jam/people");
        }}
      />
      <NowPlayingRow canControl={jam.settings.membersCanControl} />
      <ListenToggle jam={jam} />
      <Contributions jam={jam} />
      <View className="pt-5">
        <Button
          label="Leave Jam"
          pendingLabel="Leaving…"
          pending={leaving}
          variant="secondary"
          onPress={() => void leave()}
        />
      </View>
      {failure === null ? null : (
        <Text variant="calloutMedium" tone="danger" className="pt-2">
          {failure}
        </Text>
      )}
    </Page>
  );
}
