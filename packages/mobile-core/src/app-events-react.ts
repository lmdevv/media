/**
 * The React side of `app-events.ts`: the sender that attaches as whoever is signed in, the frame
 * marks that time a launch and a screen open, and the boundary that reports render errors.
 *
 * A frame mark is the app's `LaunchClock` view (`modules/launch-clock`): an empty view, laid over
 * the content a person waits for, that reports once, on the monotonic clock, the display refresh
 * that first shows that content as it will rest: in its place, so a screen sliding in has arrived,
 * with the part inside the window on screen, faded in, and under no view such as the splash
 * screen; and whether that refresh came after one the app missed. It also writes the mark, by its name, to
 * the device's log (subsystem `dev.lmdevv.launch-clock`), where a probe reads the app's own clock.
 */
import type { ContentSource, OpenCache, TimedScreen } from "@media/contracts/diagnostics";
import { createMediaServer } from "@media/sdk/promise";
import { usePlatform, usePlatformQuery, usePlatformStatus } from "@media/sdk/react";
import { Option } from "effect";
import {
  Component,
  Fragment,
  createElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ComponentType, ReactNode } from "react";

import type { AppEvents, FrameEnd, Landing, OpenClaim } from "./app-events";

/** What a frame mark marks, the name it writes to the device's log. */
export type FrameMarkName = "home-screen" | "home-content" | "open";

/** The props of the app's frame mark view. */
export interface FrameMarkProps {
  readonly name: FrameMarkName;
  /**
   * The refresh that first showed the mark, on the monotonic clock, in milliseconds, and whether it
   * came after one or more the app missed.
   */
  readonly onDrawn: (event: { readonly nativeEvent: FrameEnd }) => void;
  readonly style: typeof OVER_SCREEN;
  readonly pointerEvents: "none";
}

/** The app's frame mark view. */
export type FrameMark = ComponentType<FrameMarkProps>;

/**
 * A mark covers the view it is the last child of, so it stands where that view stands: it is shown
 * once the view has come to rest on screen.
 */
const OVER_SCREEN = { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 } as const;

/**
 * Sends `events` to the media server at `mediaUrl` as the person the core says is signed in, the
 * events' owner, and drops every waiting event when nobody is. Must sit below the SDK's
 * `PlatformProvider`.
 */
export function AppEventsSender({
  events,
  mediaUrl,
}: {
  readonly events: AppEvents;
  readonly mediaUrl: string;
}) {
  const platform = usePlatform();
  const status = usePlatformStatus();

  const me = usePlatformQuery(
    platform.core.auth.sessions.current,
    ...(status === "signedIn" ? [] : (["skip"] as const)),
  );

  const account = status === "signedIn" && me.status === "success" ? me.data.userId : null;

  useEffect(() => {
    if (status === "signedOut") events.signedOut();
  }, [events, status]);

  useEffect(() => {
    if (account === null) return undefined;
    const server = createMediaServer({ url: mediaUrl, session: platform.session });

    return events.attach({ server: mediaUrl, account }, server.reportAppEvents);
  }, [events, mediaUrl, platform, account]);

  return null;
}

/** Tells `events` where the launch's first screen landed; only the first one counts. */
export const useLanding = (events: AppEvents, landing: Landing): void => {
  useEffect(() => {
    events.landed(landing);
  }, [events, landing]);
};

/**
 * Home's launch marks, as the last child of Home's screen while a cold launch waits for them:
 * one for its screen, drawn from its first frame, and one for its real content from `content`,
 * drawn once it is not null.
 */
export function LaunchMarks({
  events,
  mark,
  content,
}: {
  readonly events: AppEvents;
  readonly mark: FrameMark;
  readonly content: ContentSource | null;
}) {
  const [waiting] = useState(events.launchPending);

  if (!waiting) return null;

  return createElement(
    Fragment,
    null,
    createElement(mark, {
      key: "screen",
      name: "home-screen",
      style: OVER_SCREEN,
      pointerEvents: "none",
      onDrawn: (event) => events.firstScreenVisible(event.nativeEvent),
    }),
    content === null
      ? null
      : createElement(mark, {
          key: "content",
          name: "home-content",
          style: OVER_SCREEN,
          pointerEvents: "none",
          onDrawn: (event) => events.homeContentVisible(event.nativeEvent, content),
        }),
  );
}

/** Where a timed screen sits in navigation, from the router's `useRoute` and `useIsFocused`. */
export interface ScreenPlace {
  /** The navigation route instance's key. */
  readonly key: string;
  readonly focused: boolean;
}

/**
 * Times the opening of the screen of record `id`: answers the frame mark to render as the
 * screen's last child, or null. The mark renders with the content, in the same commit, so it is
 * drawn in the content's first frame. Identity rule: the screen claims the press that opened it
 * when it mounts focused, as route instance `place.key`, and only that claim closes that press's
 * timer, when the mark is drawn. A later press, a blur, or an unmount ends the claim, so an
 * earlier screen's late content never closes a later press's timer.
 */
export const useOpenMark = (
  events: AppEvents,
  mark: FrameMark,
  screen: TimedScreen,
  id: string,
  place: ScreenPlace,
  contentReady: boolean,
): ReactNode => {
  const [cache] = useState<OpenCache>(contentReady ? "kept" : "fetched");
  const [drawn, setDrawn] = useState(false);
  const claim = useRef(Option.none<OpenClaim>());
  const { key, focused } = place;

  useLayoutEffect(() => {
    if (!focused) return undefined;
    const held = events.claimOpen(screen, id, key, cache);

    claim.current = held;

    return () => {
      Option.map(held, events.releaseOpen);
      claim.current = Option.none();
    };
  }, [events, screen, id, key, focused, cache]);

  if (!contentReady || drawn) return null;

  return createElement(mark, {
    name: "open",
    style: OVER_SCREEN,
    pointerEvents: "none",
    onDrawn: (event) => {
      Option.map(claim.current, (held) => events.openContentVisible(held, event.nativeEvent));
      setDrawn(true);
    },
  });
};

/**
 * Names `route`, a route pattern such as `/(tabs)/(home)`, in the error reports made on it; one not
 * in the app's route list is named `unknown`.
 */
export const useErrorRoute = (events: AppEvents, route: string): void => {
  useEffect(() => {
    events.routeChanged(route);
  }, [events, route]);
};

/** What a failed render shows instead, such as expo-router's error screen. */
export type RenderErrorFallback = ComponentType<{
  readonly error: Error;
  readonly retry: () => Promise<void>;
}>;

interface BoundaryProps {
  readonly events: AppEvents;
  readonly fallback: RenderErrorFallback;
  readonly children: ReactNode;
}

interface BoundaryState {
  readonly error: Error | null;
}

/**
 * Shows `fallback` when `children` fails to render, and reports the failure to `events`. Place it
 * below `AppEventsSender`, so the sender stays mounted and the report goes out with the next batch.
 */
export class ReportRenderErrors extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(cause: unknown): BoundaryState {
    return { error: cause instanceof Error ? cause : new Error(String(cause), { cause }) };
  }

  override componentDidCatch(cause: unknown): void {
    this.props.events.caught(cause, "render", false);
  }

  retry = (): Promise<void> =>
    new Promise((resolve) => {
      this.setState({ error: null }, resolve);
    });

  override render(): ReactNode {
    const { error } = this.state;

    return error === null
      ? this.props.children
      : createElement(this.props.fallback, { error, retry: this.retry });
  }
}
