import { TitleId as MediaTitleId } from "@media/contracts/ids";
import type { MetadataCandidate } from "@media/contracts/models/catalog";
import { describeFailure, isFailure } from "@media/mobile-core/failure";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Predicate, Schema } from "effect";
import { router, useLocalSearchParams } from "expo-router";
import { Check, Search } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { Loading, OwnerScreen, QueryView } from "@/components/owner/parts";
import { useTask } from "@/components/owner/use-task";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Image } from "@/components/ui/image";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { asTitleId } from "@/lib/catalog";
import type { TitleDetail } from "@/lib/catalog";
import { facts } from "@/lib/format";
import { useMediaServer } from "@/session/media-server";

const decodeMediaTitleId = Schema.decodeUnknownSync(MediaTitleId);

type Results =
  | { readonly status: "idle" }
  | { readonly status: "searching" }
  | { readonly status: "done"; readonly candidates: ReadonlyArray<MetadataCandidate> }
  | { readonly status: "failed"; readonly message: string };

const parseYear = (text: string): number | null => {
  const year = Number(text.trim());

  return text.trim() !== "" && Number.isInteger(year) && year >= 1870 && year <= 2200 ? year : null;
};

const searchFailure = (cause: unknown): string => {
  if (isFailure(cause, "RateLimited")) return "TMDB is busy. Try again in a moment.";

  if (isFailure(cause, "Internal") || Predicate.isTagged(cause, "TransportError")) {
    return "Search isn’t available on this server.";
  }

  return describeFailure(cause);
};

function Candidate({
  candidate,
  selected,
  onPress,
}: {
  readonly candidate: MetadataCandidate;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  const kind = candidate.kind === "show" ? "Show" : "Movie";

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={facts(candidate.name, candidate.year, kind)}
      onPress={onPress}
      className="flex-row items-center gap-4 active:opacity-70"
    >
      <View className="h-30 w-20 overflow-hidden rounded-control bg-surface">
        {candidate.posterUrl === null ? null : (
          <Image source={{ uri: candidate.posterUrl }} contentFit="cover" className="size-full" />
        )}
      </View>
      <View className="flex-1 gap-1">
        <Text variant="subheading" numberOfLines={2}>
          {candidate.name}
        </Text>
        <Text variant="secondary" tone="muted" numberOfLines={1}>
          {facts(candidate.year, kind)}
        </Text>
      </View>
      <View className="w-6 items-center">
        {selected ? <Icon icon={Check} size="inline" /> : null}
      </View>
    </Pressable>
  );
}

function MatchEditor({
  title,
  file,
}: {
  readonly title: TitleDetail;
  readonly file: string | undefined;
}) {
  const platform = usePlatform();
  const media = useMediaServer();
  const [query, setQuery] = useState(title.name);
  const [year, setYear] = useState(title.year === null ? "" : String(title.year));
  const [results, setResults] = useState<Results>({ status: "idle" });
  const [chosen, setChosen] = useState<string | null>(title.externalIds.tmdb);
  const latest = useRef(0);

  const find = async () => {
    const text = query.trim();

    if (text === "") return;
    latest.current += 1;
    const attempt = latest.current;
    const filter = parseYear(year);

    setResults({ status: "searching" });

    try {
      const titleId = decodeMediaTitleId(title.id);

      const candidates = await media.run(
        "metadata.searchCandidates",
        filter === null ? { titleId, query: text } : { titleId, query: text, year: filter },
      );

      if (attempt !== latest.current) return;
      setResults({ status: "done", candidates });
      setChosen((current) =>
        candidates.some((candidate) => candidate.providerId === current)
          ? current
          : (candidates[0]?.providerId ?? null),
      );
    } catch (cause) {
      if (attempt === latest.current)
        setResults({ status: "failed", message: searchFailure(cause) });
    }
  };

  const searched = useRef(false);

  useEffect(() => {
    if (searched.current) return;
    searched.current = true;
    void find();
  });

  const apply = useTask(async (providerId: string) => {
    await platform.movies.metadata.match({ titleId: title.id, provider: "tmdb", providerId });
    router.back();
  });

  const candidates = results.status === "done" ? results.candidates : [];
  const picked = candidates.find((candidate) => candidate.providerId === chosen);

  return (
    <>
      {file === undefined ? null : (
        <Text variant="bodyMedium" tone="muted" selectable>
          {file}
        </Text>
      )}
      <TextField
        label="Title"
        value={query}
        onChangeText={setQuery}
        returnKeyType="search"
        onSubmitEditing={() => void find()}
      />
      <TextField
        label="Year"
        value={year}
        onChangeText={setYear}
        keyboardType="number-pad"
        maxLength={4}
      />
      <Button
        label="Search"
        variant="secondary"
        icon={Search}
        disabled={query.trim() === "" || results.status === "searching"}
        onPress={() => void find()}
      />
      {results.status === "searching" ? <Loading /> : null}
      {results.status === "failed" ? <Text tone="muted">{results.message}</Text> : null}
      {results.status === "done" && candidates.length === 0 ? (
        <Text tone="muted">No matches on TMDB.</Text>
      ) : null}
      {candidates.map((candidate) => (
        <Candidate
          key={candidate.providerId}
          candidate={candidate}
          selected={candidate.providerId === chosen}
          onPress={() => setChosen(candidate.providerId)}
        />
      ))}
      {apply.error === null ? null : (
        <Text variant="meta" tone="danger">
          {apply.error}
        </Text>
      )}
      {picked === undefined ? null : (
        <Button
          label="Use This Match"
          busy={apply.busy}
          onPress={() => void apply.run(picked.providerId)}
        />
      )}
    </>
  );
}

export default function FixMatch() {
  const platform = usePlatform();
  const params = useLocalSearchParams<{ libraryId: string; titleId: string; file?: string }>();

  const title = usePlatformQuery(platform.movies.titles.get, {
    titleId: asTitleId(params.titleId),
  });

  return (
    <OwnerScreen title="Fix Match">
      <QueryView query={title}>
        {(detail) => <MatchEditor key={detail.id} title={detail} file={params.file} />}
      </QueryView>
    </OwnerScreen>
  );
}
