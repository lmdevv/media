/**
 * Paper's list row (pages 12 · 04 and 13): at least 56pt tall (64pt with 48pt art), a fixed leading
 * lane (48pt art or a 32pt icon slot), title over subtitle, and a fixed 32pt trailing lane, with a
 * full-width hairline under every row. The lanes keep their width when empty, so columns line up across rows.
 * The whole row is one touch target, except a `trailingAction`, which keeps its own press.
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

type RowTrailing =
  | {
      /** Decorative trailing content, such as `RowChevron` or `RowCheck`; a tap on it presses the row. */
      readonly trailing?: ReactNode;
      readonly trailingAction?: never;
    }
  | {
      readonly trailing?: never;
      /** An action with its own press, such as `RowMore` or a drag grip; VoiceOver reads it apart from the row. */
      readonly trailingAction?: ReactNode;
    };

/** Props for `Row`. */
export type RowProps = RowTrailing & {
  readonly title: string;
  readonly subtitle?: string;
  /** Muted by default; a failed download's subtitle is danger. */
  readonly subtitleTone?: TextTone;
  /** A 12pt glyph before the subtitle, such as a song's download state. */
  readonly subtitleGlyph?: ReactNode;
  readonly leading?: RowLeading;
  /**
   * A muted figure before the trailing lane: a count at 14/20 (`callout`, D09) or a size in mono
   * (D10). With a detail and no trailing content, the row drops the empty lane and the figure meets
   * the edge. The row's default label reads it after the subtitle.
   */
  readonly detail?: { readonly text: string; readonly variant: "callout" | "mono" } | undefined;
  /** The playing row: accent title at semibold. */
  readonly active?: boolean;
  /** A row that can't be used now, such as a song not downloaded while offline (D11, D13). */
  readonly dimmed?: boolean;
  readonly onPress?: (() => void) | undefined;
  readonly onLongPress?: (() => void) | undefined;
  /** Read instead of the title, subtitle, and detail, when they don't say enough. */
  readonly accessibilityLabel?: string | undefined;
};

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
  trailingAction,
  detail,
  active = false,
  dimmed = false,
  onPress,
  onLongPress,
  accessibilityLabel,
}: RowProps) {
  const action = trailingAction ?? undefined;

  const content = (
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
      {detail === undefined ? null : (
        <Text variant={detail.variant} tone="muted" className="shrink-0">
          {detail.text}
        </Text>
      )}
      {action !== undefined || (detail !== undefined && trailing === undefined) ? null : (
        <View className="w-8 shrink-0 items-center">{trailing}</View>
      )}
    </>
  );

  const label =
    accessibilityLabel ??
    [title, subtitle, detail?.text].filter((part) => part !== undefined && part !== "").join(", ");

  const pressable = onPress !== undefined || onLongPress !== undefined;

  const target = `min-w-0 flex-1 flex-row items-center gap-3 py-2 ${action === undefined ? "" : "pr-3"}`;

  return (
    <View
      className={`min-h-row-touch flex-row border-b border-border ${dimmed ? "opacity-disabled" : ""}`}
    >
      {/* One element whether or not the row presses, so gaining or losing a handler doesn't remount
          it and drop VoiceOver focus; an inert row lets touches through to its parent. */}
      <Pressable
        accessibilityRole={pressable ? "button" : "none"}
        accessibilityLabel={label}
        pointerEvents={pressable ? "auto" : "box-none"}
        onPress={onPress}
        onLongPress={onLongPress}
        className={pressable ? `${target} active:opacity-60` : target}
      >
        {content}
      </Pressable>
      {action === undefined ? null : (
        <View className="w-8 shrink-0 items-center justify-center py-2">{action}</View>
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

/** The `trailingAction` ellipsis that opens a row's actions, with a 44pt target over the 32pt lane. */
export function RowMore({
  label,
  onPress,
}: {
  readonly label: string;
  readonly onPress: () => void;
}) {
  return <IconButton icon={Ellipsis} label={label} tone="muted" size="inline" onPress={onPress} />;
}
