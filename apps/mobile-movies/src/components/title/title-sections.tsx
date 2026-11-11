import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { router } from "expo-router";
import { ChevronRight, Clapperboard, Info, UserRound } from "lucide-react-native";
import { FlatList, Pressable, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { Image } from "@/components/ui/image";
import { ListRow } from "@/components/ui/list-row";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import type { TitleCard, TitleDetail, TitleId } from "@/lib/catalog";
import { useServer } from "@/session/connection";

import { GUTTER } from "@/components/ui/page-layout";
import { castAndCrew, defaultVersion, versionLabel } from "./title-model";
import type { PersonLine } from "./title-model";

const SIMILAR_LIMIT = 12;

function SectionHeading({ children }: { readonly children: string }) {
  return (
    <Text variant="heading" accessibilityRole="header">
      {children}
    </Text>
  );
}

/** The row that opens About This Movie or About This Show (D09). */
export function AboutRow({ title }: { readonly title: TitleDetail }) {
  return (
    <ListRow
      icon={Info}
      title={title.kind === "movie" ? "About This Movie" : "About This Show"}
      onPress={() => router.push(`/title/${title.id}/about`)}
    />
  );
}

function PersonRow({ person }: { readonly person: PersonLine }) {
  const { mediaUrl } = useServer();
  const photo = artworkUrl(mediaUrl, person.photo, "thumb");
  const open = () => router.push(`/person/${person.personId}`);

  if (photo === undefined) {
    return (
      <ListRow
        icon={UserRound}
        title={person.name}
        {...(person.role === null ? {} : { detail: person.role })}
        onPress={open}
      />
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={person.role === null ? person.name : `${person.name}, ${person.role}`}
      onPress={open}
      className="min-h-14 flex-row items-center gap-4 active:opacity-60"
    >
      <Image
        source={{ uri: photo }}
        contentFit="cover"
        transition={150}
        className="size-14 rounded-pill bg-surface-raised"
      />
      <View className="flex-1">
        <Text variant="bodyStrong" numberOfLines={1}>
          {person.name}
        </Text>
        {person.role === null ? null : (
          <Text variant="secondary" tone="muted" numberOfLines={1}>
            {person.role}
          </Text>
        )}
      </View>
      <View className="w-5 items-center">
        <Icon icon={ChevronRight} tone="muted" size="chevron" />
      </View>
    </Pressable>
  );
}

/** Cast & Crew: the billed cast, then the creators and directors. */
export function CastAndCrew({ title }: { readonly title: TitleDetail }) {
  const people = castAndCrew(title);

  if (people.length === 0) return null;

  return (
    <View className="gap-4 regular:gap-2">
      <SectionHeading>Cast & Crew</SectionHeading>
      <View className="gap-4 regular:gap-0">
        {people.map((person) => (
          <PersonRow key={person.personId} person={person} />
        ))}
      </View>
    </View>
  );
}

/** A movie's versions when it has several; each opens Choose Version on it (D06). */
export function AvailableVersions({ title }: { readonly title: TitleDetail }) {
  if (title.versions.length < 2) return null;

  const preferred = defaultVersion(title.versions);

  return (
    <View className="gap-4">
      <SectionHeading>Available Versions</SectionHeading>
      {title.versions.map((version) => (
        <ListRow
          key={version.id}
          icon={Clapperboard}
          title={versionLabel(version)}
          {...(version.id === preferred?.id ? { detail: "Default" } : {})}
          onPress={() => router.push(`/title/${title.id}/versions?fileId=${version.id}`)}
        />
      ))}
    </View>
  );
}

function SimilarTitle({ title }: { readonly title: TitleCard }) {
  const { mediaUrl } = useServer();
  const poster = artworkUrl(mediaUrl, title.artwork.poster, "poster");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title.name}
      onPress={() => router.push(`/title/${title.id}`)}
      className="w-28 gap-1.5 active:opacity-80 regular:w-36 wide:w-42"
    >
      <View className="h-42 w-28 overflow-hidden rounded-control bg-surface-raised regular:h-54 regular:w-36 wide:h-63 wide:w-42">
        {poster === undefined ? null : (
          <Image
            source={{ uri: poster }}
            contentFit="cover"
            transition={150}
            className="size-full"
          />
        )}
      </View>
      <Text variant="label" numberOfLines={2}>
        {title.name}
      </Text>
    </Pressable>
  );
}

/** More Like This, when the server knows similar titles you may see. */
export function MoreLikeThis({ titleId }: { readonly titleId: TitleId }) {
  const platform = usePlatform();

  const similar = usePlatformQuery(platform.movies.titles.similar, {
    titleId,
    limit: SIMILAR_LIMIT,
  });

  if (similar.status !== "success" || similar.data.length === 0) return null;

  return (
    <View className="gap-4 regular:gap-3">
      <View className={GUTTER}>
        <SectionHeading>More Like This</SectionHeading>
      </View>
      <FlatList
        horizontal
        data={similar.data}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <SimilarTitle title={item} />}
        showsHorizontalScrollIndicator={false}
        contentContainerClassName={`gap-3 regular:gap-4 ${GUTTER}`}
      />
    </View>
  );
}
