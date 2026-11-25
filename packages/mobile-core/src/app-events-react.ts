/**
 * The React side of `app-events.ts`: the hooks the screens call to time a launch and a screen
 * open, the boundary that reports render errors, and the sender that attaches while someone is
 * signed in.
 */
import type { ContentSource, TimedScreen } from "@media/contracts/diagnostics";
import { createMediaServer } from "@media/sdk/promise";
import { usePlatform, usePlatformStatus } from "@media/sdk/react";
import { Option } from "effect";
import { Component, createElement, useEffect, useRef } from "react";
import type { ComponentType, ReactNode } from "react";

import type { AppEvents, Landing, OpenClaim } from "./app-events";

/**
 * Sends `events` to the media server at `mediaUrl` as the signed-in person, and holds them while
 * nobody is signed in. Must sit below the SDK's `PlatformProvider`.
 */
export function AppEventsSender({
  events,
  mediaUrl,
}: {
  readonly events: AppEvents;
  readonly mediaUrl: string;
}) {
  const platform = usePlatform();
  const signedIn = usePlatformStatus() === "signedIn";

  useEffect(() => {
    if (!signedIn) return undefined;
    const server = createMediaServer({ url: mediaUrl, session: platform.session });

    return events.attach(server.reportAppEvents);
  }, [events, mediaUrl, platform, signedIn]);

  return null;
}

/** The screen that hides the splash screen: its next frame is the launch's first. */
export const useFirstScreen = (events: AppEvents, landing: Landing): void => {
  useEffect(() => {
    events.firstScreen(landing);
  }, [events, landing]);
};

/** Home shows real content from `source`, or none yet while it is null. */
export const useHomeContent = (events: AppEvents, source: ContentSource | null): void => {
  useEffect(() => {
    if (source !== null) events.homeContent(source);
  }, [events, source]);
};

/**
 * Times the opening of the screen of record `id`: the screen claims the press that opened it when
 * it mounts, and closes that press's timer at the first frame `drawn` is true. A screen that
 * mounted for an earlier press holds no claim on a later one, so its late answer never closes a
 * later press's timer.
 */
export const useScreenOpen = (
  events: AppEvents,
  screen: TimedScreen,
  id: string,
  drawn: boolean,
): void => {
  const claim = useRef(Option.none<OpenClaim>());

  useEffect(() => {
    claim.current = events.claimOpen(screen, id);
  }, [events, screen, id]);

  useEffect(() => {
    if (!drawn || Option.isNone(claim.current)) return;
    events.openContent(claim.current.value);
    claim.current = Option.none();
  }, [events, screen, id, drawn]);
};

/** Names `route`, a route pattern such as `/album/[id]`, in the error reports made on it. */
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

/** Shows `fallback` when `children` fails to render, and reports the failure to `events`. */
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
