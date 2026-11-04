import type { ServerSettings } from "@music/commands/models";

/** The settings `server.update` changes; one it leaves out keeps its saved value. */
type ServerSettingsUpdate = { -readonly [Key in keyof ServerSettings]?: ServerSettings[Key] };

/**
 * The update for the switches the person set (`chosen`) against what the server has (`saved`),
 * or null when nothing differs.
 */
export const settingsUpdate = (
  chosen: Partial<ServerSettings>,
  saved: ServerSettings,
): ServerSettingsUpdate | null => {
  const update: ServerSettingsUpdate = {};

  if (chosen.jamGuestAccounts !== undefined && chosen.jamGuestAccounts !== saved.jamGuestAccounts) {
    update.jamGuestAccounts = chosen.jamGuestAccounts;
  }

  if (chosen.remoteLyrics !== undefined && chosen.remoteLyrics !== saved.remoteLyrics) {
    update.remoteLyrics = chosen.remoteLyrics;
  }

  return Object.keys(update).length === 0 ? null : update;
};
