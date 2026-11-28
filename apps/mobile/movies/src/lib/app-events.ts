import { createAppEvents, reportUncaught, touchTime } from "@media/mobile-core/app-events";
import type { Landing } from "@media/mobile-core/app-events";
import { LaunchMarks, useLanding, useOpenMark } from "@media/mobile-core/app-events-react";
import type { FrameMark as FrameMarkView } from "@media/mobile-core/app-events-react";
import type { ContentSource, TimedScreen } from "@media/contracts/diagnostics";
import { Option } from "effect";
import { requireNativeModule, requireNativeView } from "expo";
import Constants from "expo-constants";
import { File, Paths } from "expo-file-system";
import { useIsFocused, useRoute } from "expo-router";
import { createElement } from "react";
import type { ReactNode } from "react";
import { AppState, TurboModuleRegistry } from "react-native";
import type { TurboModule } from "react-native";

/** The app's `LaunchClock` module (`modules/launch-clock`). */
interface LaunchClock {
  readonly processStartedAt: () => number | null;
  readonly now: () => number;
}

/** React Native's `SourceCode` module: the address the app's JavaScript was loaded from. */
interface SourceCode extends TurboModule {
  readonly getConstants: () => { readonly scriptURL: string };
}

const clock = requireNativeModule<LaunchClock>("LaunchClock");

const FrameMark: FrameMarkView = requireNativeView("LaunchClock");

const crashFile = new File(Paths.document, "app-events-crashes.json");

/**
 * This app's reporter of launches, screen opens, and errors (`@media/mobile-core/app-events`).
 * It reports every uncaught error and unhandled rejection from the moment this module loads, and
 * follows the app in and out of the background. It reads nothing from disk until a launch has
 * drawn its first frame.
 */
export const appEvents = createAppEvents({
  app: "movies",
  release: Constants.expoConfig?.version ?? "unknown",
  development: __DEV__,
  scriptUrl: TurboModuleRegistry.get<SourceCode>("SourceCode")?.getConstants().scriptURL ?? null,
  processStartedAt: clock.processStartedAt(),
  startedInBackground: AppState.currentState === "background",
  crashes: {
    read: () => {
      try {
        return crashFile.exists ? crashFile.textSync() : null;
      } catch {
        return null;
      }
    },
    write: (contents) => {
      // A report that can't be written is lost; the app may be ending, so nothing else can run.
      try {
        crashFile.writeSync(contents);
      } catch {}
    },
  },
  monotonicNow: () => clock.now(),
  wallNow: Date.now,
  schedule: (ms, run) => {
    const timer = setTimeout(run, ms);

    return () => clearTimeout(timer);
  },
});

reportUncaught(appEvents, {
  errorUtils: ErrorUtils,
  hermes: typeof HermesInternal === "undefined" ? null : HermesInternal,
  development: __DEV__,
});

AppState.addEventListener("change", appEvents.appStateChanged);

/** A press is opening the screen of record `id`: times the open from the press's touch. */
export const pressedOpen = (
  screen: TimedScreen,
  id: string,
  press: { readonly nativeEvent: unknown },
): void => {
  Option.map(touchTime(press), (at) => appEvents.pressed(screen, id, at));
};

/** Tells the reporter where the launch's first screen landed. */
export const useLaunchLanding = (landing: Landing): void => {
  useLanding(appEvents, landing);
};

/** Home's launch marks, rendered as the last child of Home's screen. */
export const HomeLaunchMarks = ({ content }: { readonly content: ContentSource | null }) =>
  createElement(LaunchMarks, { events: appEvents, mark: FrameMark, content });

/**
 * Times the opening of this screen, of record `id`, from the press that opened it to the first
 * frame its content is in view; render the answer as the screen's last child. `heldAtMount` says whether
 * the screen held its content as it mounted, when it draws that content a frame later.
 */
export const useScreenOpenMark = (
  screen: TimedScreen,
  id: string,
  contentReady: boolean,
  heldAtMount: boolean = contentReady,
): ReactNode => {
  const { key } = useRoute();
  const focused = useIsFocused();

  return useOpenMark(appEvents, FrameMark, screen, id, { key, focused }, contentReady, heldAtMount);
};
