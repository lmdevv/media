import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { EyeOff, X } from "lucide-react-native";
import { Pressable, ScrollView, View } from "react-native";

import { SidePanel } from "@/components/player/side-panel";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { moviesItem } from "@/lib/together/session";
import type {
  JoinedSession,
  MoviesItem,
  QueueEntry,
  SessionSettings,
  WaitingPerson,
} from "@/lib/together/session";

const JOIN_OPTIONS: ReadonlyArray<{
  readonly value: SessionSettings["join"];
  readonly label: string;
}> = [
  { value: "open", label: "Anyone with the Link" },
  { value: "approval", label: "Ask Me First" },
  { value: "locked", label: "No One New" },
];

/** A member's line under their name: `You · Host`, `Host`, `Away`, or nothing. */
const memberDetail = (
  member: JoinedSession["members"][number],
  self: string | null,
): string | null => {
  const parts = [
    member.userId === self ? "You" : null,
    member.role === "host" ? "Host" : null,
    member.present ? null : "Away",
  ].filter((part) => part !== null);

  return parts.length === 0 ? null : parts.join(" · ");
};

function Heading({ children }: { readonly children: string }) {
  return (
    <Text variant="metaSemibold" tone="darkMuted" accessibilityRole="header">
      {children}
    </Text>
  );
}

function EntryName({ item }: { readonly item: MoviesItem }) {
  const platform = usePlatform();
  const titleId = item.ref.type === "title" ? item.ref.id : null;
  const episodeId = item.ref.type === "episode" ? item.ref.id : null;

  const title = usePlatformQuery(
    platform.movies.titles.get,
    ...(titleId === null ? (["skip"] as const) : ([{ titleId }] as const)),
  );

  const episode = usePlatformQuery(
    platform.movies.titles.episode,
    ...(episodeId === null ? (["skip"] as const) : ([{ episodeId }] as const)),
  );

  const name =
    title.status === "success"
      ? title.data.name
      : episode.status === "success"
        ? `S${String(episode.data.seasonNumber)}, E${String(episode.data.episodeNumber)} · ${episode.data.name}`
        : "…";

  return (
    <Text variant="labelStrong" tone="onMedia" numberOfLines={1}>
      {name}
    </Text>
  );
}

function QueueRow({
  entry,
  onRemove,
}: {
  readonly entry: QueueEntry;
  readonly onRemove: (entryId: QueueEntry["entryId"]) => void;
}) {
  const item = moviesItem(entry.item);

  return (
    <View className="flex-row items-center gap-3">
      <View className="flex-1 gap-0.5">
        {item === null ? (
          <View className="flex-row items-center gap-2">
            <Icon icon={EyeOff} tone="darkMuted" size="inline" />
            <Text variant="labelStrong" tone="darkMuted">
              Hidden
            </Text>
          </View>
        ) : (
          <EntryName item={item} />
        )}
        {entry.addedBy === null ? null : (
          <Text variant="meta" tone="darkMuted" numberOfLines={1}>
            {`Added by ${entry.addedBy}`}
          </Text>
        )}
      </View>
      {entry.removable ? (
        <Pressable
          onPress={() => onRemove(entry.entryId)}
          accessibilityRole="button"
          accessibilityLabel="Take Out of Up Next"
          hitSlop={6}
          className="size-8 items-center justify-center active:opacity-60"
        >
          <Icon icon={X} tone="darkMuted" size="inline" />
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The group session beside the player: who is watching and who is away, who waits to join, what
 * plays next, and for the host who may join and what guests may do. Everyone can share the link;
 * the host ends the session and guests leave it.
 */
export function SessionPanel({
  session,
  self,
  queue,
  actions,
  onClose,
}: {
  readonly session: JoinedSession;
  /** The viewer, whose row says You. */
  readonly self: string | null;
  readonly queue: ReadonlyArray<QueueEntry>;
  readonly actions: {
    readonly shareLink: () => void;
    readonly leave: () => void;
    readonly configure: (settings: SessionSettings) => void;
    readonly admit: (userId: WaitingPerson["userId"]) => void;
    readonly turnAway: (userId: WaitingPerson["userId"]) => void;
    readonly removeEntry: (entryId: QueueEntry["entryId"]) => void;
  };
  readonly onClose: () => void;
}) {
  const hosting = session.role === "host";
  const waiting = session.pending ?? [];
  const { settings } = session;

  return (
    <SidePanel title="Watching Together" widthClassName="w-100" onClose={onClose}>
      <ScrollView contentContainerClassName="gap-6 pb-6">
        <View className="gap-3" accessibilityLabel="Members">
          {session.members.map((member) => {
            const detail = memberDetail(member, self);

            return (
              <View key={member.userId} className={member.present ? "" : "opacity-50"}>
                <Text variant="labelStrong" tone="onMedia" numberOfLines={1}>
                  {member.username}
                </Text>
                {detail === null ? null : (
                  <Text variant="meta" tone="darkMuted">
                    {detail}
                  </Text>
                )}
              </View>
            );
          })}
        </View>

        {hosting && waiting.length > 0 ? (
          <View className="gap-3">
            <Heading>Waiting to Join</Heading>
            {waiting.map((person) => (
              <View key={person.userId} className="flex-row items-center gap-2">
                <Text variant="labelStrong" tone="onMedia" className="flex-1" numberOfLines={1}>
                  {person.username}
                </Text>
                <Button
                  label="Turn Away"
                  variant="plain"
                  onPress={() => actions.turnAway(person.userId)}
                />
                <Button
                  label="Let In"
                  variant="onDark"
                  onPress={() => actions.admit(person.userId)}
                />
              </View>
            ))}
          </View>
        ) : null}

        {queue.length === 0 ? null : (
          <View className="gap-3">
            <Heading>Up Next</Heading>
            {queue.map((entry) => (
              <QueueRow key={entry.entryId} entry={entry} onRemove={actions.removeEntry} />
            ))}
          </View>
        )}

        {hosting ? (
          <View className="gap-3">
            <Heading>Who Can Join</Heading>
            {JOIN_OPTIONS.map((option) => (
              <Pressable
                key={option.value}
                onPress={() => actions.configure({ ...settings, join: option.value })}
                accessibilityRole="radio"
                accessibilityState={{ selected: settings.join === option.value }}
                className="flex-row items-center justify-between active:opacity-60"
              >
                <Text variant="label" tone="onMedia">
                  {option.label}
                </Text>
                {settings.join === option.value ? (
                  <Text variant="labelStrong" tone="accent">
                    ✓
                  </Text>
                ) : null}
              </Pressable>
            ))}
            <Heading>Guests Can</Heading>
            <View className="flex-row items-center justify-between">
              <Text variant="label" tone="onMedia">
                Pause and Seek
              </Text>
              <Toggle
                label="Pause and Seek"
                value={settings.control}
                onValueChange={(control) => actions.configure({ ...settings, control })}
              />
            </View>
            <View className="flex-row items-center justify-between">
              <Text variant="label" tone="onMedia">
                Add to Up Next
              </Text>
              <Toggle
                label="Add to Up Next"
                value={settings.add}
                onValueChange={(add) => actions.configure({ ...settings, add })}
              />
            </View>
          </View>
        ) : null}

        <View className="gap-2">
          <Button label="Share Link" variant="onDark" onPress={actions.shareLink} />
          <Button
            label={hosting ? "End Session" : "Leave Session"}
            variant="plainDestructive"
            onPress={actions.leave}
          />
        </View>
      </ScrollView>
    </SidePanel>
  );
}
