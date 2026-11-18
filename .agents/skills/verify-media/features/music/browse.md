# Browse

A user looks through their music: Home's rows, the Albums, Artists, and Songs pages, an artist's
page, and Liked songs, which the like button on any song fills. Likes are the person's own, and the
CLI reads the same list.

## Sub-features

- `browse-home` greets the person and shows `Recently added` and `Recently played artists`.
- `browse-albums` lists the albums, and `browse-songs` every song with a count and total time.
- `browse-artist` lists the artists and opens one with `Latest in library` and `Top songs`.
- `like-song` likes and unlikes a song from its row.
- `liked-page` lists the liked songs, newest first, at `/liked`.
- `liked-cli` reads the likes with `media music likes list`.

## How to get to it (user POV)

- Desktop web: the Library sidebar's `Home`, `Albums`, `Artists`, `Songs`, and `Liked songs`.
- A song row's `Like <title>` button, which then reads `Unlike <title>`.
- Terminal: `media music likes list`, `media music albums list`, and
  `media music albums tracks --album-id <id>`.

## Driving it with verify-media

Preconditions:

- `$S doctor` passes, and the side holds the demo library and the seed, so Lucía likes `Wanderer`,
  `Doppelgänger`, and `Hoist`.

- **Home.** Run `$S browser --app music open /` and
  `$S browser --app music wait --role heading --name "Recently added"`. The page's first heading
  is a greeting with the person's name, such as `Good morning, lucia`.
- **Songs.** Run `$S browser --app music click --role link --name Songs --exact --in navigation=Library`.
  The heading `Songs` stands under `28 songs · 3 h 17 min of music`, with the table `Songs`.
- **Artist.** Run `$S browser --app music click --role link --name Artists --in navigation=Library`:
  the heading `Artists` and four links, `Andy G. Cohen`, `Dadive`, `Doc & Lena Selyanina`, and
  `raymundo mendoza`. Then `$S browser --app music click --role link --name "Andy G. Cohen" --in main --nth 0`
  opens the artist with the headings `Latest in library` and `Top songs`.
- **Liked songs.** Run `$S browser --app music click --role link --name "Liked songs" --in navigation=Library`.
  The heading `Liked songs` stands under `3 songs · 21 min`, with the table `Liked songs`, and
  `$S cli -- music likes list` lists `Hoist`, `Doppelgänger`, and `Wanderer`.
- **Like.** Open `Prisma` from `/albums` as in [Playback](./playback.md), hover a row with
  `$S browser --app music hover --role row --name Decapod --in main`, and run
  `$S browser --app music click --role button --name "Like Decapod" --in main`.
  `$S cli -- music likes list` then lists `Decapod` first. Take it off again with
  `$S browser --app music click --role button --name "Unlike Decapod" --in main`.
- **Proof.** `$S browser --app music screenshot --path captures/verify/<run>/after/music/browse/liked.png`
  on Liked songs, and save `$S cli -- music likes list` beside it.

## Gotchas

- `Songs` needs `--exact` in the sidebar: `Liked songs` and each playlist's `<n> songs` hold the
  same word.
- Likes are per person: Mateo likes `Drifting Cargo`, and Aiko `Neptune` and `Naughty Waltz`.
