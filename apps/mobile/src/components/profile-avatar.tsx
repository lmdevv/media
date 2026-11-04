import type { Profile } from "@media/contracts/models/profiles";
import { Match } from "effect";
import { LinearGradient } from "expo-linear-gradient";
import { Tv } from "lucide-react-native";
import { StyleSheet, Text, View } from "react-native";

import { avatarArt, monogram } from "@/lib/avatars";
import type { AvatarArt } from "@/lib/avatars";
import { useThemeColors } from "@/lib/theme-color";

import { Icon } from "./ui/icon";

const SIZES = {
  tile: {
    box: "size-28 regular:size-36",
    radius: "rounded-card",
    text: "text-display leading-ios-62",
    glyph: "tile",
  },
  picker: {
    box: "size-26",
    radius: "rounded-card",
    text: "text-ios-40 leading-ios-46",
    glyph: "tile",
  },
  editor: {
    box: "size-24",
    radius: "rounded-card",
    text: "text-ios-48 leading-ios-54",
    glyph: "tile",
  },
  sheet: {
    box: "size-20",
    radius: "rounded-card",
    text: "text-ios-40 leading-ios-46",
    glyph: "state",
  },
  row: {
    box: "size-18",
    radius: "rounded-card",
    text: "text-ios-36 leading-ios-42",
    glyph: "state",
  },
  member: {
    box: "size-11",
    radius: "rounded-card",
    text: "text-ios-22 leading-ios-28",
    glyph: "inline",
  },
  small: {
    box: "size-9",
    radius: "rounded-control",
    text: "text-body leading-ios-21",
    glyph: "inline",
  },
} as const;

type ProfileAvatarSize = keyof typeof SIZES;

/** Props for `ProfileAvatar`. */
export interface ProfileAvatarProps {
  readonly profile: Pick<Profile, "name" | "kids" | "avatar">;
  readonly size?: ProfileAvatarSize;
  /** Rings the tile in the accent, for the chosen avatar in Choose Avatar. */
  readonly selected?: boolean;
}

const LETTERING = {
  tile: "text-ios-28 leading-ios-34",
  picker: "text-ios-28 leading-ios-34",
  editor: "text-ios-22 leading-ios-28",
  sheet: "text-ios-22 leading-ios-28",
  row: "text-ios-17 leading-ios-23",
  member: "text-ios-11 leading-caption",
  small: "text-ios-11 leading-caption",
} as const satisfies Record<ProfileAvatarSize, string>;

function Gradient({ stops }: { readonly stops: ReadonlyArray<`--color-${string}`> }) {
  const colors = useThemeColors(stops);
  const [first = "transparent", second = first, ...rest] = colors;

  return (
    <LinearGradient
      colors={[first, second, ...rest]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={StyleSheet.absoluteFill}
    />
  );
}

function Mark({
  art,
  name,
  size,
}: {
  readonly art: AvatarArt;
  readonly name: string;
  readonly size: ProfileAvatarSize;
}) {
  const plain = art.gradient === null;

  return Match.value(art.mark).pipe(
    Match.when("kidsGlyph", () => (
      <Icon icon={Tv} size={SIZES[size].glyph} tone={plain ? "default" : "onMedia"} />
    )),
    Match.when("lettering", () => (
      <Text
        className={`font-sans-heavy tracking-display text-dark-text ${LETTERING[size]}`}
        maxFontSizeMultiplier={1}
      >
        kids
      </Text>
    )),
    Match.when("monogram", () => (
      <Text
        className={`font-sans-bold ${plain ? "text-text" : "text-dark-text"} ${SIZES[size].text}`}
        maxFontSizeMultiplier={1}
      >
        {monogram(name)}
      </Text>
    )),
    Match.exhaustive,
  );
}

/** A profile's avatar tile. VoiceOver reads the name beside it, so the tile itself is hidden. */
export function ProfileAvatar({ profile, size = "tile", selected = false }: ProfileAvatarProps) {
  const art = avatarArt(profile);
  const { box, radius } = SIZES[size];

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className={`items-center justify-center overflow-hidden ${box} ${radius} ${
        art.gradient === null ? "bg-surface-raised" : ""
      }`}
    >
      {art.gradient === null ? null : <Gradient stops={art.gradient} />}
      <Mark art={art} name={profile.name} size={size} />
      {selected ? <View className={`absolute inset-0 border-3 border-accent ${radius}`} /> : null}
    </View>
  );
}
