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
- `play-ios` plays an album in the iOS app. verify-media does not drive it.

## How to get to it (user POV)

- Desktop web: `Albums` in the Library sidebar, an album, then its `Play` button.
- Phone web: the `Library` tab, an album, then `Play`. The mini player opens Now Playing.
- The player bar's `Play`/`Pause`, `Next`, and `Open Now Playing` buttons.
- Terminal: `music play <query>`, `music pause`, `music resume`, `music next`.
- iOS app: the Library tab, an album, then `Play`.

## Driving it with verify-media

Preconditions:

- `$S doctor` passes, and the side holds the demo library.

- **Open the album.** Run `$S browser --app music open /albums`, then
  `$S browser --app music click --role link --name "Vienna Blue" --in main --nth 0` and
  `$S browser --app music wait --role heading --name "Vienna Blue"`.
- **Play.** Run `$S browser --app music click --role button --name Play --exact --in main --nth 0`. Then
  `$S browser --app music wait-audio --past 2` prints `"playing":true` with seconds above 2. The player bar
  shows `Wanderer`.
- **Pause.** Run `$S browser --app music click --role button --name Pause --exact --in region=Player`. Then
  `$S browser --app music audio` prints `"playing":false`, and the bar's button reads `Play`.
- **Next.** Resume with `$S browser --app music click --role button --name Play --exact --in region=Player`,
  then run `$S browser --app music click --role button --name Next --exact --in region=Player` and
  `$S browser --app music wait-audio --advance 1`. The player bar shows `Doppelgänger`.
- **CLI control.** With audio playing, run `$S cli --app music -- pause`. `$S browser --app music audio` prints
  `"playing":false`. Run `$S cli --app music -- resume`, then `$S browser --app music wait-audio --advance 1`.
  `$S cli --app music -- now --json` shows `"playing": true`, the song as `queue[index].title`, and the
  browser (kind `web`) as `activeDevice`.
- **Phone and Now Playing.** Run `$S browser --app music sign-in --page music-phone --device "iPhone 15" --dark`,
  then the same album steps with `--page music-phone`. Then
  `$S browser --app music click --page music-phone --role button --name "Open Now Playing"` and
  `$S browser --app music wait --page music-phone --role dialog --name "Now Playing"`.
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
- Playback state is per account, not per page. A second page sees the song that
  `music` left playing or paused. Pause it first when a recipe needs a quiet start.
- The before side holds its own playback. Run the same steps on both sides before you compare.
- `audio` reads only the page's own media elements. A page that is only a remote for another
  device reports `"elements":0`.
