# Playlists

A user creates a playlist, adds songs from a song's menu, removes them, renames the playlist, and
deletes it. The sidebar and the CLI follow each change.

## Sub-features

- `playlist-create` creates a playlist with the `n` key or the sidebar's `New playlist` button.
- `playlist-add` adds a song from its `More actions` menu.
- `playlist-remove` removes a song from the playlist.
- `playlist-rename` renames the playlist from `Edit details…`.
- `playlist-delete` deletes the playlist.
- `playlist-cli` lists and edits playlists from the terminal.

## How to get to it (user POV)

- Desktop web: `New playlist` in the sidebar, or `n` with focus outside a field.
- A song row's `More actions for <title>` menu, then `Add to playlist`.
- A playlist's `More actions for <name>` menu: `Edit details…` and `Delete playlist…`.
- Terminal: `music playlists list`, `create`, `add`, `remove`, `rename`, `delete`.

## Driving it with verify-media

Preconditions:

- `$S doctor` passes, and `$S cli --app music -- playlists list --json` has no playlist named `Road trip`.

- **Create.** Open an album so focus is outside fields: `$S browser --app music open /albums`,
  `$S browser --app music click --role link --name "Vienna Blue" --in main --nth 0`, and
  `$S browser --app music wait --role heading --name "Vienna Blue"`. Then run `$S browser --app music press --key n`,
  `$S browser --app music wait --role dialog --name "New playlist"`, `$S browser --app music type --value "Road trip"`,
  and `$S browser --app music press --key Enter`. The heading `Road trip` appears, and
  `$S cli --app music -- playlists list --json` lists it with `"trackCount": 0`.
- **Add.** Go back to the album with `$S browser --app music open /albums` and the album click above. Hover the
  row with `$S browser --app music hover --role row --name Doppelgänger --in main`, then run
  `$S browser --app music click --role button --name "More actions for Doppelgänger" --in main`,
  `$S browser --app music click --role menuitem --name "Add to playlist"`, and
  `$S browser --app music click --role menuitem --name "Road trip"`. The text `Added to Road trip` appears.
- **Remove.** Open the playlist with
  `$S browser --app music click --role link --name "Road trip" --in navigation=Library`, hover the row, open
  its `More actions for Doppelgänger` menu, and click the menu item `Remove from this playlist`.
  The text `Let's find something for this playlist` appears.
- **Rename.** Run `$S browser --app music click --role button --name "More actions for Road trip"`,
  `$S browser --app music click --role menuitem --name "Edit details…"`,
  `$S browser --app music fill --label Name --exact --value "Night drive"`, and
  `$S browser --app music press --key Enter`. The heading `Night drive` appears.
- **Delete.** Run `$S browser --app music click --role button --name "More actions for Night drive"`,
  `$S browser --app music click --role menuitem --name "Delete playlist…"`, and
  `$S browser --app music click --role button --name "Delete playlist"`. The URL ends in `/playlists`, the
  text `Deleted Night drive` appears, and `$S cli --app music -- playlists list --json` no longer lists it.
- **Proof.** Screenshot each state with `$S browser --app music screenshot --path
  captures/verify/<run>/after/music/playlists/<step>.png`.

## Gotchas

- `n` typed while a field has focus goes into the field. On `/search` the field has focus, so
  open an album first.
- Row actions appear on hover. Hover the row before you click its `More actions` button.
- `Edit details…` and `Delete playlist…` end in an ellipsis character, not three dots.
