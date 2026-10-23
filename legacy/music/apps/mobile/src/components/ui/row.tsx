/**
 * Paper's list row (pages 12 · 04 and 13): at least 56pt tall (64pt with 48pt art), a fixed leading
 * lane (48pt art or a 32pt icon slot), title over subtitle, and a fixed 32pt trailing lane, with a
 * full-width hairline under every row. The lanes keep their width when empty, so columns line up across rows.
 */
import { Check, ChevronRight, Ellipsis } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { Artwork } from "./artwork";
import { Icon } from "./icon";
import { IconButton } from "./icon-button";
import { Text } from "./text";
import type { TextTone } from "./text";

/** What sits in a row's leading lane. */
type RowLeading =
  | { readonly kind: "art"; readonly url: string | null; readonly recyclingKey?: string }
  | {
      readonly kind: "icon";
      readonly icon: LucideIcon;
      readonly tone?: TextTone;
      /** Transport glyphs and a liked heart are drawn filled. */
      readonly filled?: boolean;
    };

/** Props for `Row`. */
export interface RowProps {
  readonly title: string;
  readonly subtitle?: string;
  /** Muted by default; a failed download's subtitle is danger. */
  readonly subtitleTone?: TextTone;
  /** A 12pt glyph before the subtitle, such as a song's download state. */
  readonly subtitleGlyph?: ReactNode;
  readonly leading?: RowLeading;
  /** The trailing lane: `RowChevron`, `RowCheck`, `RowMore`, or nothing. */
  readonly trailing?: ReactNode;
  /**
   * A muted figure before the trailing lane: a count at 14/20 (`callout`, D09) or a size in mono
   * (D10). With a detail and no `trailing`, the row drops the empty lane and the figure meets the
   * edge. VoiceOver skips it, so put it in `accessibilityLabel`.
   */
  readonly detail?: { readonly text: string; readonly variant: "callout" | "mono" } | undefined;
  /** The playing row: accent title at semibold. */
  readonly active?: boolean;
  readonly onPress?: (() => void) | undefined;
  readonly onLongPress?: (() => void) | undefined;
  /** Read instead of the title and subtitle, when they don't say enough. */
  readonly accessibilityLabel?: string | undefined;
}

function Leading({ leading }: { readonly leading: RowLeading }) {
  if (leading.kind === "art") {
    return (
      <Artwork
        url={leading.url}
        className="size-12 shrink-0 rounded-md"
        recyclingKey={leading.recyclingKey}
      />
    );
  }

  return (
    <View className="w-8 shrink-0 items-center">
      <Icon icon={leading.icon} tone={leading.tone ?? "default"} filled={leading.filled ?? false} />
    </View>
  );
}

/** A list row; pressable when it has `onPress`. */
export function Row({
  title,
  subtitle,
  subtitleTone = "muted",
  subtitleGlyph,
  leading,
  trailing,
  detail,
  active = false,
  onPress,
  onLongPress,
  accessibilityLabel,
}: RowProps) {
  const main = (
    <>
      {leading === undefined ? null : <Leading leading={leading} />}
      <View className="min-w-0 flex-1">
        <Text
          variant={active ? "bodyStrong" : "bodyMedium"}
          tone={active ? "accent" : "default"}
          numberOfLines={1}
        >
          {title}
        </Text>
        {subtitle === undefined ? null : subtitleGlyph === undefined ? (
          <Text variant="secondary" tone={subtitleTone} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : (
          <View className="flex-row items-center gap-1">
            {subtitleGlyph}
            <Text variant="secondary" tone={subtitleTone} numberOfLines={1} className="shrink">
              {subtitle}
            </Text>
          </View>
        )}
      </View>
    </>
  );

  const label = accessibilityLabel ?? (subtitle === undefined ? title : `${title}, ${subtitle}`);
  const lane = "min-w-0 flex-1 flex-row items-center gap-3";

  // The trailing lane sits beside the row's own target, not inside it, so VoiceOver reaches its
  // action (an ellipsis menu) as a separate button.
  return (
    <View className="min-h-row-touch flex-row items-center gap-3 border-b border-border py-2">
      {onPress === undefined && onLongPress === undefined ? (
        <View className={lane} accessible accessibilityLabel={label}>
          {main}
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={onPress}
          onLongPress={onLongPress}
          className={`${lane} active:opacity-60`}
        >
          {main}
        </Pressable>
      )}
      {detail === undefined ? null : (
        // The row's label carries the figure, so VoiceOver doesn't stop on it twice.
        <Text
          variant={detail.variant}
          tone="muted"
          className="shrink-0"
          accessibilityElementsHidden
          importantForAccessibility="no"
        >
          {detail.text}
        </Text>
      )}
      {detail !== undefined && trailing === undefined ? null : (
        <View className="w-8 shrink-0 items-center">{trailing}</View>
      )}
    </View>
  );
}

/** The trailing chevron of a row that opens a page. */
export function RowChevron() {
  return <Icon icon={ChevronRight} size="inline" />;
}

/** The trailing accent check of the selected row. */
export function RowCheck() {
  return <Icon icon={Check} tone="accent" size="inline" />;
}

/** The trailing ellipsis that opens a row's actions, with a 44pt target over the 32pt lane. */
export function RowMore({
  label,
  onPress,
}: {
  readonly label: string;
  readonly onPress: () => void;
}) {
  return <IconButton icon={Ellipsis} label={label} tone="muted" size="inline" onPress={onPress} />;
}
