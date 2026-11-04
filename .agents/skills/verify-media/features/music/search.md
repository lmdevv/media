# Search

Search finds songs, albums, and artists in the user's libraries as they type, ignores accents,
and shows a top result with the title as tagged. The CLI returns the same matches.

## Sub-features

- `search-open` opens search from the sidebar, the `/` key, or the phone's search button.
- `search-match` lists matches for a query, with a top result.
- `search-accents` matches `doppelganger` to `Doppelgänger` and shows the original title.
- `search-cli` returns matches from the terminal.

## How to get to it (user POV)

- Desktop web: `Search` in the Library sidebar, or `/` with focus outside a field.
- Phone web: the search button beside the tab bar.
- Terminal: `music search <query>`.
- iOS app: the search button beside the tab bar.

## Driving it with verify-media

Preconditions:

- `$S doctor` passes, and the side holds the demo library.

- **Shortcut.** From the home page, run `$S browser --app music open /`, `$S browser --app music press --key /`, and
  `$S browser --app music wait --url /search`. The search field has focus.
- **Accents.** Run `$S browser --app music fill --css "#search-input" --value doppelganger`, then
  `$S browser --app music wait --role heading --name "Top result"`. Then
  `$S browser --app music text --css "main section" --nth 0` prints `Top result`, `Doppelgänger`, and
  `Song · Doc & Lena Selyanina`.
- **CLI.** Run `$S cli --app music -- search doppelganger --json`. Exit code `0`, and `tracks[0].title` is
  `Doppelgänger` on the album `Vienna Blue`.
- **Proof.** Run `$S browser --app music screenshot --path captures/verify/<run>/after/music/search/accents.png` and
  `$S browser --app music snapshot --in main --path captures/verify/<run>/after/music/search/accents.aria.txt`.

## Gotchas

- The search field has no accessible name. Use `--css "#search-input"`.
- Results update as you type. Wait for `Top result`, never sleep.
- `/` types a slash when a field has focus. Press it from a page with focus outside fields.
