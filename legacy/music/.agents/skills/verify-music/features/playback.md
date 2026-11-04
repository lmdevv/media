# Playback

A user plays an album, pauses, resumes, and skips, and the music really plays: audio advances in
the browser or on the phone, the player bar and Now Playing follow, and the CLI controls the same
playback.

## Sub-features

- `play-album` starts an album from its page.
- `play-pause` pauses and resumes from the player bar.
- `play-next` skips to the next song.
- `play-now-playing` opens Now Playing from the player bar.
- `play-cli` pauses and resumes the browser's playback from the CLI.
- `play-ios` plays an album in the iOS app.

## How to get to it (user POV)

- Desktop web: `Albums` in the Library sidebar, an album, then its `Play` button.
- Phone web: the `Library` tab, an album, then `Play`. The mini player opens Now Playing.
- The player bar's `Play`/`Pause`, `Next`, and `Open Now Playing` buttons.
- Terminal: `music play <query>`, `music pause`, `music resume`, `music next`.
- iOS app: the Library tab, an album, then `Play`.

## Driving it with verify-music

Preconditions:

- `$S doctor` passes, and the side holds the demo library.

- **Open the album.** Run `$S browser open /albums`, then
  `$S browser click --role link --name "Vienna Blue" --in main --nth 0` and
  `$S browser wait --role heading --name "Vienna Blue"`.
- **Play.** Run `$S browser click --role button --name Play --exact --in main --nth 0`. Then
  `$S browser wait-audio --past 2` prints `"playing":true` with seconds above 2. The player bar
  shows `Wanderer`.
- **Pause.** Run `$S browser click --role button --name Pause --exact --in region=Player`. Then
  `$S browser audio` prints `"playing":false`, and the bar's button reads `Play`.
- **Next.** Resume with `$S browser click --role button --name Play --exact --in region=Player`,
  then run `$S browser click --role button --name Next --exact --in region=Player` and
  `$S browser wait-audio --advance 1`. The player bar shows `Doppelgänger`.
- **CLI control.** With audio playing, run `$S cli -- pause`. `$S browser audio` prints
  `"playing":false`. Run `$S cli -- resume`, then `$S browser wait-audio --advance 1`.
  `$S cli -- now --json` shows `"playing": true`, the song as `queue[index].title`, and the
  browser (kind `web`) as `activeDevice`.
- **Phone and Now Playing.** Run `$S browser sign-in --page phone --device "iPhone 15" --dark`,
  then the same album steps with `--page phone`. Then
  `$S browser click --page phone --role button --name "Open Now Playing"` and
  `$S browser wait --page phone --role dialog --name "Now Playing"`.
- **iOS.** After `$S ios up`, Home shows the album under `Back in rotation` and `Recently added`.
  Run `$S ios tap --label "Vienna Blue, Doc & Lena Selyanina"` and `$S ios wait Shuffle 20`. Then
  `$S ios tap --label Play` and `$S ios wait "Now playing: Wanderer, Doc & Lena Selyanina" 20`.
  `$S ios describe` shows a `Pause` button in the mini player, and `$S cli -- now --json` shows
  `"playing": true` with the simulator (`music-verify-<run>-<side>`, kind `phone`) as
  `activeDevice` and `positionMs` growing between reads. Record it with
  `$S ios record start captures/verify/<run>/after/ios/play.mp4` first and `$S ios record stop`
  after.
- **Proof.** Record the journey with `$S browser record-start --page phone --show-actions --path
  captures/verify/<run>/after/playback/phone.mp4` before the first step, and
  `$S browser close-page --page phone` at the end. Take stills with
  `$S browser screenshot --path captures/verify/<run>/after/playback/album.png` and
  `$S browser snapshot --in region=Player --path captures/verify/<run>/after/playback/player.aria.txt`.

## Gotchas

- `--exact` matters on `Play`: without it the locator also matches buttons such as `Play Dawn`
  and fails as ambiguous.
- The album page has a `Play` button in the header and one per row on hover. Scope it with
  `--in main --nth 0` for the album's own button.
- Playback state is per account, not per page. A second page or the iOS app sees the song that
  `main` left playing or paused. Pause it first when a recipe needs a quiet start.
- The before side holds its own playback. Run the same steps on both sides before you compare.
- `audio` reads only the page's own media elements. A page that is only a remote for another
  device reports `"elements":0`.
