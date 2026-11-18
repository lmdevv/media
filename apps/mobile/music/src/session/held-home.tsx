import { usePlatformStatus } from "@media/sdk/react";

import { LIBRARY_HOME, RECENT_PLAYS, useHistoryPages } from "@/lib/details";
import { useMusic, useQueryState } from "@/lib/platform";
import type { SettledPhase } from "@/lib/session-phase";
import { useScanning } from "@/lib/use-libraries";
import { useSetupProgress } from "@/session/session-phase";

/**
 * Keeps open every query Home opens with: its rails, Recently played, and the scan notice's
 * libraries, each with the arguments its screen uses. It renders nothing and applies no answer;
 * it sits above every error boundary, so it reads only through hooks that keep a failure as state.
 */
function HeldQueries() {
  useQueryState(useMusic().library.home, LIBRARY_HOME);
  useHistoryPages(RECENT_PLAYS);
  useScanning();

  return null;
}

/**
 * Opens Home's queries once the session is signed in, in the same batch as
 * `core.auth.sessions.current`, so Home finds their answers when the stack shows it. Mounted beside
 * the stack, at one place, for as long as Home may show. Off while signed out, during this
 * install's setup, and once the app opens on its downloads offline; screens still wait for the
 * session as they do without it.
 *
 * @param phase - The settled phase, or null while the app still hears from the server.
 */
export function HeldHome({ phase }: { readonly phase: SettledPhase["kind"] | null }) {
  const status = usePlatformStatus();
  const { progress } = useSetupProgress();
  const homeMayShow = phase === null || phase === "ready";

  if (status !== "signedIn" || progress !== "none" || !homeMayShow) return null;

  return <HeldQueries />;
}
