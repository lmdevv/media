# My List and Continue watching

Each profile keeps its own My List and its own watching. Home shows `Continue watching for
<profile>` with a resume card for a title stopped partway and a next-episode card for a show, and
the `My List` page and row hold the titles the profile saved.

## Sub-features

- `list-add` adds a title to My List from its page, and `list-remove` takes it off.
- `list-page` shows My List at `/my-list` with a title count.
- `continue-resume` shows a half-watched title with the time left and the share watched.
- `continue-next` shows a show's next episode after the watched ones.
- `continue-cli` reads the same rows with `media continue` and `media my-list list`.

## How to get to it (user POV)

- A title's page: `Add to My List`, which then reads `Remove from My List` (pressed).
- `My List` in the `Sections` navigation, and Home's `My List` row with `See all`.
- Home's `Continue watching for <profile>` row.
- Terminal: `media continue`, `media my-list list`, `media my-list add <title-id>`.

## Driving it with verify-movies

Preconditions:

- `$S doctor` passes, and the side holds the seed. Aiko's profile hasn't been played since `up`.

- **Continue watching.** Run `$S browser sign-in --page aiko --email aiko@movies.local --profile Aiko`
  and `$S browser snapshot --page aiko --in region="Continue watching for Aiko"`. It holds
  `Resume Pioneer One · S1:E3` (`Next · Alone in the Night`) and `Resume Elephants Dream`
  (`5m left 50% watched`).
- **CLI view.** `$S cli --as aiko -- continue` lists `next` for `Pioneer One` with episode 3
  `Alone in the Night`, and `resume` for `Elephants Dream`.
- **My List page.** Run `$S browser open --page aiko /my-list`. It reads `3 titles`, with the
  links `Caminandes 2013`, `Tears of Steel 2012 · 12m`, and `Sintel 2010 · 15m`.
- **Add.** As Lucía on `main`, open Big Buck Bunny's page (see [Browse](./browse.md)) and run
  `$S browser click --role button --name "Add to My List" --in main`. The button becomes
  `Remove from My List` `[pressed]`, and `$S cli -- my-list list` includes `Big Buck Bunny`.
- **Next episode.** As Aiko, run
  `$S browser click --page aiko --role link --name "Resume Pioneer One" --in region="Continue watching for Aiko"`
  and `$S browser wait-video --page aiko --past 3 --timeout 60000`. The player reads
  `Pioneer One S1:E3 Alone in the Night`, and the URL carries that episode's `episodeId`.
- **Proof.** Run `$S browser screenshot --page aiko --in region="Continue watching for Aiko" --path captures/verify/<run>/after/my-list/continue.png`
  and save `$S cli --as aiko -- continue` beside it.

## Gotchas

- Watching anything as Aiko changes her row: the played title moves to the front, and a finished
  episode moves the next card on. Take the row's proof before you play from it.
- My List and progress are per profile. Lucía's `Kids` profile has its own, empty, list.
- The row's cards are links named `Resume <title>`, even for a next episode that hasn't started.
- Mateo's My List holds `Cosmos Laundromat: First Cycle`, to compare with Aiko's.
