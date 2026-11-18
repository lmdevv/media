# Browse and search

A user finds something to watch: Home's rows, the Movies and Shows grids, a title's page with its
details, cast, versions, and episodes, and search from the command menu, the search page, or the
CLI. Everything shown is limited to the libraries and ratings the person may see.

## Sub-features

- `browse-home` shows the featured title and the `Recently added`, `Shows`, and `Collections` rows.
- `browse-grid` lists the `Movies` and `Shows` pages with their genre, year, score, and sort filters.
- `browse-title` opens a title's page: rating, runtime, codecs, `Play`, `Add to My List`, and cast.
- `browse-episodes` lists a show's seasons and episodes on its page.
- `browse-genre` lists a genre's movies and shows at `/genre/<name>`, and filters a grid by a genre
  chip.
- `browse-collection` lists a collection's titles at `/collection/<id>`.
- `browse-person` lists a director's or actor's titles in the library at `/person/<id>`.
- `search-menu` finds a title from the command menu (`Search`).
- `search-page` finds titles on `/search`, with `All`, `Movies`, and `Shows` counts.
- `search-cli` finds titles with `media movies titles search`.

## How to get to it (user POV)

- Desktop and phone web: the `Sections` navigation (`Home`, `Movies`, `Shows`, `My List`) and the
  `Search` button in the banner.
- Any poster opens `/title/<id>`. Its `Genres` links open `/genre/<name>`, and its `Directed by`,
  `Written by`, and `Starring` links open `/person/<id>`.
- Home's `Collections` row, or `See all` beside it for `/collections`.
- `/search?q=<words>` directly.
- Terminal: `media movies titles search --query <words>`, `media movies titles list`,
  `media movies titles get --title-id <id>`.

## Driving it with verify-media

Preconditions:

- `$S doctor` passes, and the side holds the demo library and the seed.

- **Home.** Run `$S browser open /` and `$S browser snapshot --in main`. It holds the regions
  `Recently added` (links such as `New Big Buck Bunny`), `Shows`, and `Collections`
  (`Blender Open Movies 5 titles`).
- **Grid.** Run `$S browser click --role link --name Movies --exact --in navigation=Sections`.
  The heading `Movies` reads `6 titles`, and each poster is a link such as `New Sintel 2010 · 15m`.
- **Title.** Run `$S browser click --role link --name "Sintel 2010" --in main` and
  `$S browser wait --role heading --name Sintel`. The page reads `2010 PG-13 15m 1080p H.264
  AC3 5.1 CC` and has the link `Play` and the button `Add to My List`.
- **Episodes.** Run `$S browser open /shows`, then `$S browser click --role link --name Caminandes --in main`.
  The region `Episodes` has `Season 1 3 episodes`, `0 of 3 watched`, and one link per episode,
  starting `1 Llama Drama`. The page's `Play S1:E1` link starts the first.
- **Genre.** On `/movies`, `$S browser click --role button --name Animation --in main` leaves the
  heading `Movies` with `5 titles` and the chip pressed. On Sintel's page,
  `$S browser click --role link --name Animation --in main` opens `/genre/Animation`: the heading
  `Animation` reads `6 titles`, movies and shows together.
- **Collection.** On Home, `$S browser click --role link --name "Blender Open Movies" --in region=Collections`
  opens `/collection/<id>`: the heading `Blender Open Movies` reads `5 titles`, oldest first.
- **Person.** On Sintel's page, `$S browser click --role link --name "Colin Levy" --exact --in main`
  opens `/person/<id>`: the heading `Colin Levy`, and under `In your library` the links
  `[movies] Feature Test 2010 · Director` and `Sintel 2010 · Director`.
- **Command menu.** Run `$S browser click --role button --name Search --exact` and
  `$S browser type --value sint`. The dialog `Command menu` lists the option
  `Sintel Movie · 2010` under `Titles`, selected. `$S browser press --key Enter` opens its page
  at `/title/<id>`; `$S browser press --key Escape` closes the menu instead.
- **Search page.** Run `$S browser open "/search?q=steel"`. The searchbox reads `1 result`, the
  filters read `All 1`, `Movies 1`, `Shows 0`, and the region `Results` has
  `Tears of Steel Movie · 2012 · 12m`.
- **CLI.** Run `$S cli -- movies titles search --query cosmos`: one result, `Cosmos Laundromat: First Cycle`, with `"certification": "PG"`.
  `$S cli --as sam -- movies titles search --query sintel` prints `[]`.
- **Proof.** Run `$S browser screenshot --path captures/verify/<run>/after/browse/title.png` on
  the title page and `$S browser snapshot --in main --path captures/verify/<run>/after/browse/title.aria.txt`.

## Gotchas

- A grid poster's name carries its year and runtime (`Sintel 2010 · 15m`), and a Home row's
  carries `New` while the title is new. `--name Sintel --exact` matches neither; use a substring.
- A title's heading is its logo's text, which may be all capitals (`SINTEL`, `CAMINANDES`).
  Substring names match without regard to case; `--exact` doesn't.
- Search matches titles, not plots: `llama` finds nothing, `caminandes` finds the show.
- The command menu also lists actions and pages, so typed words can select an action. Read the
  option under `Titles` before you press `Enter`.
- A grid's default order, `Recently added`, follows the order the side scanned its files. Pick
  `$S browser click --role button --name Sort`, then `--role menuitemradio --name Name`, for an
  order that is the same on every side.
- A person's name is two links on a title's page, the credit line's and the cast row's
  (`Colin Levy Director`). `--exact` picks the credit line's.
- What a page lists depends on who is signed in: the kid and Sam
  see fewer titles, and a title they may not see reads `This title isn't here`.
