/**
 * The server is out of reach (D11 to D14; G04 on a phone with nothing downloaded). A tab root shows
 * the card under its title, a pushed page the one-line bar over its content; neither blocks, since
 * what is on screen and what was downloaded keep working. Convex reconnects on its own, and the
 * notice goes once it does. Playlists and Search, which hold nothing offline, show `OfflineState`.
 */
import { router } from "expo-router";
import { WifiOff } from "lucide-react-native";
import { useEffect } from "react";
import { Pressable, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { useHasDownloads } from "@/downloads";
import { offlineNotice } from "@/lib/offline-notice";
import type { OfflineNotice as Notice } from "@/lib/offline-notice";
import { displayHost } from "@/lib/server";
import { useThemeColor } from "@/lib/theme-color";
import { useNowPlaying } from "@/player";
import { useConnection } from "@/session/connection";
import { useNoticeReach } from "@/session/server-reach";

/** Player states in which music is coming out of this phone, or about to. */
const SOUNDING = new Set(["loading", "playing", "buffering"]);

/** Paper's spinner arc: radius 8.5 on the 24-unit grid, a quarter turn long. */
const ARC_RADIUS = 8.5;

const ARC_LENGTH = 2 * Math.PI * ARC_RADIUS;

/** The notice for now, and the way to try the server again. */
interface OfflineNoticeView {
  readonly notice: Notice | null;
  readonly retry: () => void;
}

/** Where the app stands with its server, as the notice words it. */
const useOfflineNotice = (): OfflineNoticeView => {
  const reach = useNoticeReach();
  const hasDownloads = useHasDownloads();
  const { origin, reconnect } = useConnection();
  const { role, status } = useNowPlaying();

  return {
    notice: offlineNotice({
      reach,
      hasDownloads,
      host: displayHost(origin),
      playingHere: role.kind === "local" && SOUNDING.has(status),
    }),
    retry: () => reconnect("offline"),
  };
};

/** D14's turning arc while Convex calls the server again; still under Reduce Motion. */
function Spinner({ size }: { readonly size: number }) {
  const track = useThemeColor("--color-border");
  const muted = useThemeColor("--color-text-muted");
  const reduceMotion = useReducedMotion();
  const turn = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) return undefined;

    turn.set(withRepeat(withTiming(360, { duration: 1000, easing: Easing.linear }), -1));

    return () => cancelAnimation(turn);
  }, [reduceMotion, turn]);

  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${String(turn.get())}deg` }] }));

  return (
    <Animated.View style={spin} accessibilityElementsHidden importantForAccessibility="no">
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Circle cx={12} cy={12} r={ARC_RADIUS} stroke={track} strokeWidth={2} />
        <Circle
          cx={12}
          cy={12}
          r={ARC_RADIUS}
          stroke={muted}
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={`${String(ARC_LENGTH / 4)} ${String(ARC_LENGTH)}`}
          transform="rotate(-90 12 12)"
        />
      </Svg>
    </Animated.View>
  );
}

/** Try again, in accent. */
function RetryLink({ onPress }: { readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Try again"
      onPress={onPress}
      hitSlop={12}
      className="active:opacity-60"
    >
      <Text variant="secondaryStrong" tone="accent">
        Try again
      </Text>
    </Pressable>
  );
}

/** Props for `OfflineNotice`. */
export interface OfflineNoticeProps {
  /** The card under a tab root's title (D11, D14), or the bar atop a pushed page (D12, D13). */
  readonly variant: "card" | "bar";
  /** Spacing around it, where the page places it. */
  readonly className?: string;
}

/** The notice while the server is out of reach; nothing while it answers. */
export function OfflineNotice({ variant, className }: OfflineNoticeProps) {
  const { notice, retry } = useOfflineNotice();

  if (notice === null) return null;

  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(180)}
      className={className ?? ""}
    >
      {variant === "card" ? (
        <View className="flex-row items-start gap-3 rounded-lg bg-surface p-4">
          {notice.kind === "offline" ? (
            <Icon icon={WifiOff} tone="muted" size="inline" />
          ) : (
            <Spinner size={20} />
          )}
          <View className="flex-1 gap-1">
            <View
              accessible
              accessibilityLabel={`${notice.title}. ${notice.body}`}
              className="gap-1"
            >
              <Text variant="label">{notice.title}</Text>
              <Text variant="secondary" tone="muted">
                {notice.body}
              </Text>
            </View>
            {notice.retry ? (
              <View className="flex-row pt-1">
                <RetryLink onPress={retry} />
              </View>
            ) : null}
          </View>
        </View>
      ) : (
        <View className="flex-row items-center gap-2 rounded-lg bg-surface px-4 py-3">
          {notice.kind === "offline" ? <Icon icon={WifiOff} size="meta" /> : <Spinner size={16} />}
          <Text
            variant="secondaryStrong"
            className="flex-1"
            accessibilityLabel={`${notice.label}. ${notice.body}`}
          >
            {notice.label}
          </Text>
          {notice.retry ? <RetryLink onPress={retry} /> : null}
        </View>
      )}
    </Animated.View>
  );
}

/**
 * A tab that shows nothing without the server, on a launch that never reached it: where to find
 * the downloads instead, and Try again under the same rule as the notice. Nothing otherwise.
 * Paper draws no artboard for it; it follows page 19's empty state.
 */
export function OfflineState({ body }: { readonly body: string }) {
  const { notice, retry } = useOfflineNotice();

  if (notice?.kind !== "offline") return null;

  return (
    <EmptyState
      icon={WifiOff}
      title={notice.title}
      body={body}
      primary={<Button label="Downloaded" onPress={() => router.push("/downloaded")} />}
      secondary={
        notice.retry ? <Button label="Try again" variant="secondary" onPress={retry} /> : undefined
      }
    />
  );
}
