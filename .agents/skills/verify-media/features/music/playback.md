# Playback

A user plays an album, pauses, resumes, and skips, and the music really plays: audio advances in
the browser or on the phone, and the player bar and Now Playing follow. The queue is the
person's, so the CLI reads the queue the browser started, and each finished play lands in their
history.

## Sub-features

- `play-album` starts an album from its page.
- `play-pause` pauses and resumes from the player bar.
- `play-next` skips to the next song.
- `play-now-playing` opens Now Playing from the player bar.
- `play-cli` reads the queue and the history from the terminal.
- `play-ios` plays an album in the music iOS app.

## How to get to it (user POV)

- Desktop web: `Albums` in the Library sidebar, an album, then its `Play` button.
- Phone web: the `Library` tab, an album, then `Play`. The mini player opens Now Playing.
- The player bar's `Play`/`Pause`, `Next`, and `Open Now Playing` buttons.
- Terminal: `media music queue get`, `media music queue list`, and `media music history list`.
- iOS app: the Library tab, an album, then `Play`.

## Driving it with verify-media

Preconditions:

- `$S doctor` passes, and the side holds the demo library.

- **Open the album.** Run `$S browser --app music open /albums`, then
  `$S browser --app music click --role link --name "Vienna Blue" --in main --nth 0` and
  `$S browser --app music wait --role heading --name "Vienna Blue"`.
- **Play.** Run `$S browser --app music click --role button --name Play --exact --in main --nth 0`.
  Then `$S browser --app music wait-audio --past 2` prints `"playing":true` with seconds above 2.
  The player bar shows `Wanderer`.
- **Pause.** Run `$S browser --app music click --role button --name Pause --exact --in region=Player`.
  Then `$S browser --app music audio` prints `"playing":false`, and the bar's button reads `Play`.
- **Next.** Resume with `$S browser --app music click --role button --name Play --exact --in region=Player`,
  then run `$S browser --app music click --role button --name Next --exact --in region=Player` and
  `$S browser --app music wait-audio --advance 1`. The player bar shows `Doppelgänger`.
- **CLI.** `$S cli -- music queue get` shows `"count": 7` and the entry playing as `current`,
  and `$S cli -- music queue list` lists the album's songs, the one whose `itemId` is `current`
  being `Doppelgänger`. `$S cli -- music history list` lists `Doppelgänger` first, then
  `Wanderer`.
- **Phone and Now Playing.** Run `$S browser --app music sign-in --page music-phone --device "iPhone 15" --dark`
  and `$S browser --app music open /albums --page music-phone`, then the album and play steps
  with `--page music-phone`. The mini player is the button `Open Now Playing: <song>`. Then
  `$S browser --app music click --page music-phone --role button --name "Open Now Playing"` and
  `$S browser --app music wait --page music-phone --role dialog --name "Now Playing"`.
- **iOS.** Run `$S ios up --app music`, which signs in as Lucía, or, in a T3 thread,
  `$S ios up --app music --udid <id> --no-sign-in` on the simulator T3's device tools opened, then
  open the printed link and sign in there (`Connect to your server`, the side's address, then
  `Username`, `Password`, and `Sign in`; answer `Not Now` to `Save Password?`). Tap the `Library`
  tab, `Albums`, `Vienna Blue`, then `Play`. The mini player reads
  `Now playing: Wanderer, Doc & Lena Selyanina` with a `Pause` button, and in Now Playing the
  `Position` time advances.
- **Proof.** Record the journey with `$S browser --app music record-start --page music-phone --show-actions --path
  captures/verify/<run>/after/music/playback/phone.mp4` before the first step, and
  `$S browser --app music close-page --page music-phone` at the end. Take stills with
  `$S browser --app music screenshot --path captures/verify/<run>/after/music/playback/album.png` and
  `$S browser --app music snapshot --in region=Player --path captures/verify/<run>/after/music/playback/player.aria.txt`.

## Gotchas

- `--exact` matters on `Play`: without it the locator also matches buttons such as `Play Dawn`
  and fails as ambiguous.
- The album page has a `Play` button in the header and one per row on hover. Scope it with
  `--in main --nth 0` for the album's own button.
- The queue is the person's, but whether a page plays and where in the song is the page's own.
- The before side holds its own playback. Run the same steps on both sides before you compare.
- `audio` reads only the page's own media elements.
- An iOS app that kept a session to an earlier stack's server, with downloads from it, opens on
  Home offline and never offers another server. Uninstall it before `ios up` installs it again:
  it then opens on `Your server is out of reach.`, whose `Server address` goes back to Welcome.
- The CLI has no pause, resume, or next of its own; it controls a device through Connect
  (`media auth targets control`, [Connect](./connect.md)).
