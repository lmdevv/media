import { createAppEvents, reportUncaught } from "@media/mobile-core/app-events";
import { requireOptionalNativeModule } from "expo";
import Constants from "expo-constants";
import { File, Paths } from "expo-file-system";
import { AppState } from "react-native";

/** The app's `LaunchClock` module (`modules/launch-clock`). */
interface LaunchClock {
  readonly processStartedAt: () => number | null;
}

const crashFile = new File(Paths.document, "app-events-crashes.json");

/**
 * This app's reporter of launches, screen opens, and errors (`@media/mobile-core/app-events`).
 * It reports every uncaught error and unhandled rejection from the moment this module loads, and
 * follows the app in and out of the background.
 */
export const appEvents = createAppEvents({
  app: "movies",
  release: Constants.expoConfig?.version ?? "unknown",
  development: __DEV__,
  processStartedAt:
    requireOptionalNativeModule<LaunchClock>("LaunchClock")?.processStartedAt() ?? null,
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
  now: Date.now,
  schedule: (ms, run) => {
    const timer = setTimeout(run, ms);

    return () => clearTimeout(timer);
  },
  nextFrame: (run) => {
    requestAnimationFrame(run);
  },
});

reportUncaught(appEvents, {
  errorUtils: ErrorUtils,
  hermes: typeof HermesInternal === "undefined" ? null : HermesInternal,
  development: __DEV__,
});

AppState.addEventListener("change", appEvents.appStateChanged);
