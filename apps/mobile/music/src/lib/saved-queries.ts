/**
 * The queries a launch saves for the next one to show at once: the server's setup and who is
 * signed in, which decide the phase, and what Home draws first (its rails and Recently played,
 * with the arguments `HeldHome` opens them with). The libraries' scan notice waits for the server.
 */
export const SAVED_QUERIES = [
  "core.server.info",
  "core.auth.sessions.current",
  "music.library.home",
  "music.history.list",
] as const;
