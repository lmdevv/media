# Hardware transcoding

When a device can't play a file as it is, the media service converts the video for it: it decodes
the source, deinterlaces, scales, maps HDR to SDR, burns in an image or a text subtitle, and
encodes H.264, HEVC, or AV1, on the CPU or on an Intel GPU through Quick Sync (`qsv`) or VA-API
(`vaapi`). The hardware matrix plays one fixture per stage on each path through the service's own
playback negotiation, reads the bytes it serves, and records which stage works on which path, with
the evidence of where it ran.

## Sub-features

- `hw-decode` decodes a source the device can't play: generated HEVC 8-bit SDR for an H.264-only
  browser.
- `hw-deinterlace` makes the interlaced MPEG-2 version progressive.
- `hw-scale` scales the 818-line H.264 version down to a 480-line quality cap, and
  `scale-variable-rate` a generated phone-style MP4 (4 s at 60 fps, then 12 s at 15 fps) down to
  240 lines, through to its last segment.
- `hw-hdr-to-sdr` maps the HDR10 HEVC version to BT.709 SDR for an SDR browser.
- `hw-burn-in` draws the DVD (image) subtitle track into the picture: on a GPU path with the GPU's
  overlay (`overlay_qsv`, `overlay_vaapi`), the subtitle's frames decoded on the CPU and uploaded,
  the picture never leaving the device. `subtitle-burn-in-pgs` does the same with a generated PGS
  track (`pgs.mjs`) whose 1920x1080 canvas is fitted into a 1920x800 picture at its own aspect.
  `subtitle-burn-in-text` draws a generated styled ASS track
  (positioned, coloured, in the block font the file attaches) with libass, on the CPU on every path,
  a GPU path downloading the picture for it and uploading it again.
- `hw-encode-h264`, `hw-encode-hevc`, and `hw-encode-av1` encode for a device that plays only that
  codec (H.264 under a 4 Mb/s cap, since an H.264 browser plays the source as it is).
- `hw-hybrid` runs one stage of a GPU path on the CPU where the device can't do it, as the service
  plans from what it proved: `hybrid-cpu-decode` decodes generated 10-bit H.264, which Intel media
  engines don't decode, on the CPU and scales and encodes on the GPU; `hybrid-cpu-tone-map` maps
  generated HLG HEVC on the CPU between VA-API's decode and encode, since VA-API's tone map needs
  mastering display metadata HLG lacks.
- `hw-path` shows where each stage ran: the ffmpeg arguments inside the container, that ffmpeg's
  GPU engine time, the encoder's fingerprint in the bytes, the negotiated mode, and the service's
  `Stream.mode_changed` records.

## How to get to it (user POV)

- The web and iOS players: play a title the device can't play as it is. The web player's `Stream
  info` names the mode (`Transcode`) and where each stage ran (`Stages`).
- Terminal: `media movies stream <title> [--version N] [--max-height N] [--burn-subtitle e3]` prints
  the negotiated mode, the stages (`stages: Decode · QSV, Subtitle · CPU → QSV, Encode · QSV`), the
  subtitle tracks with the one burned in marked, and any change of the chain.
  `media admin server status` prints the ffmpeg build, the devices, and every capability with its
  status, evidence, and quarantine.
- The owner: `HARDWARE_ACCELERATION` (`auto`, `none`, `qsv`, `vaapi`) with
  `deploy/compose/compose.qsv.yaml` or `compose.vaapi.yaml`, which pass `/dev/dri` through, or the
  NixOS module's setting. `/api/health` reports the encoder in use as `hardwareAcceleration`; the
  admin Server page shows the GPU and how many capabilities are verified, unsupported, and
  quarantined.

## Driving it with verify-media

Preconditions:

- A side up with setup on the demo library: `$S up --no-seed` is enough, since the matrix plays as
  Lucía. Each path but `cpu` needs a render node on the host (`/dev/dri/renderD*`).
- No other heavy job on the host: the grid restarts the side's container for each path and
  transcodes for half a minute on each, about two minutes in all on a 16-core host with an Arc A380,
  plus a minute the first time for the generated fixture's scan.

- **Pick the path at up.** `$S up --hardware qsv` starts the side with `HARDWARE_ACCELERATION=qsv`
  and the host's `/dev/dri` passed through by `compose.qsv.yaml`; `vaapi` uses
  `compose.vaapi.yaml`, and `none` runs on the CPU with no device. Without `--hardware` the side
  runs the service's default, `auto`, with no device, so software.
- **Switch a running side.** `$S hardware [--side S] none|qsv|vaapi` has Compose recreate the
  side's container with the other setting, with the same data and port, waits for health, and
  prints `after: HARDWARE_ACCELERATION=qsv; the media service reports qsv`. `$S doctor` and
  `$S status` show the setting.
- **Run the grid.** `$S hardware-matrix [--side S]` measures every row on `cpu`, `qsv`, and `vaapi`
  in turn, switching the side to each path first, prints `grid.md`, and leaves the side on the last
  path. `--paths qsv,vaapi` or `--rows encode-hevc,scale` measure part of it; the cells it skips
  keep their last result. `--grid-only` rewrites the grid files from the cells on disk, with or
  without a side.
- **Before and after for a PR.** Rebase onto main first: the before side is
  `ghcr.io/lmdevv/media:main`. Run one side at a time to spare the host: `$S up --no-seed`,
  `$S hardware-matrix`, `$S down --side after`, then `$S up --side before --no-seed`,
  `$S hardware-matrix --side before`, `$S down`. `grid.md` then shows both sides and a
  `What changed on the after side` table. A PR that turns a cell green shows that cell going from
  `NOT-BUILT` or `FAIL` to `PASS`, and no other cell changing.
- **Read the grid.** `captures/verify/<run>/hardware-matrix/grid.md` has, per side, a stage-by-path
  table of verdicts, the passes per path, and one line of evidence per cell. `grid.tsv` has one line
  per cell (`side stage row path verdict evidence measured cell`), and `grid.json` the same as JSON.
  - `PASS`: the output is right and the stage ran on that path.
  - `FAIL`: the stream broke, the output is wrong (size, rate, timeline, tags, picture), or the
    stage ran somewhere else, such as in software on a GPU path. The evidence names which. Every
    transcode cell also checks that each frame of the start and the seek shows the source's picture
    for its time (`picture-time`) and that the sound starts where the source's does there
    (`audio-start`). A check that could not measure (thumbnails or ffprobe that came back empty or
    failed, a frame length it can't know) fails with `could not measure` and the reason.
  - `NOT-BUILT`: the service answered correctly but did not do the stage: it refused with a reason
    the row lists (`no-transcode-target`), or the output lacks the stage (combing left in, H.264
    where only HEVC plays).
  - `SKIPPED`: the fixture or the device is absent. Neither `NOT-BUILT` nor `SKIPPED` counts as a
    pass.
- **Check Apple playback.** A `PASS` checks the served bytes with ffmpeg alone, and an init segment
  AVFoundation refuses still probes and decodes in ffmpeg, so it is no proof that Apple's players
  open the stream. `$S apple-check [--side S] [--paths cpu,qsv,vaapi] [--rows encode-hevc,...]`
  sends each cell's `start.mp4` and `seek.mp4` to the Mac (`MAC_HOST`, as `ios up` uses), compiles
  `scripts/apple-check.swift` there, and prints a line per file: `cpu-encode-hevc-start.mp4
  video=true frames=96` when AVFoundation exposes a video track and decodes that many frames,
  `video=false frames=0` when it refuses the track (AVPlayer then says "Cannot Open"). It fails
  unless every file shows video and decodes a frame. When the Mac can't run it, every file reads
  `not checked`, never passed. `$S apple-check FILE...` checks any MP4s, such as an init segment
  with fragments appended. AV1 needs a Mac that decodes it (M3 or later, A17 Pro or later on
  iPhone); the M4 here does. Put its lines beside the grid's in the PR.
- **Read a cell.** `<side>/<path>/<row>/cell.json` holds the verdict, each check with its class
  (`stage`, `output`, `path`) and evidence, and what was observed: the negotiation, each fetch's
  segments and ffprobe facts, each ffmpeg run's arguments and engine time, and the service's log
  records for the session. Beside it are the bytes served (`start.mp4`, `seek.mp4`), ffprobe's
  JSON, `negotiate.json`, `ffmpeg-watch.txt`, `service-log.jsonl`, and the stage's own analysis:
  `idet.txt`; `picture.txt` with `output-240.png`; or `output-108.png`, `source-108.png`, and
  `changed-108.png` (the pixels the subtitle changed). `timing.txt` has each fetch's frame counts
  against the source and the first frames that failed, with how far their best match lies.
- **Add a row.** A stage, a path, or a hybrid row (a CPU decode feeding a GPU encode, say) is an
  entry in `scripts/hardware-matrix.mjs`. A hybrid row's id starts with `hybrid-`, and its `work`
  pins the operation that runs elsewhere (`decode: "cpu"`); that operation is judged by the run's
  arguments alone, since the run's other stages hold the GPU. A row needs a fixture in `FIXTURES` (a demo library version, or one
  generated with the side's ffmpeg), a client in `PROFILES`, a row in `ROWS` with its request, its
  checks, and `work` (where each operation must run), and for a new operation its rule in `WORK`.
  `node --test .agents/skills/verify-media/scripts/hardware-matrix.test.mjs` checks the table.
- **Proof.** Put `grid.md`'s tables in the PR's Verification section, and the evidence lines or the
  whole `grid.md` in a PR comment. Keep `start.mp4` and `seek.mp4` out of the PR; they are the demo
  films' frames, at a few MB each.

## Gotchas

- `picture-time` judges every frame of a fetch alone, against the source frame shown at its time
  (96x28 gray thumbnails of the top 70 % of the picture, through the reference tone map for an
  HDR row). That source frame is flat (gray levels spreading under 1), pictured (10 or more), or
  too faint to place (between: a fade, where the GPU tone maps render the Feature Test's opening
  near black while the CPU does not). Over a pictured frame the output must correlate 0.7 or more
  with it within a frame of the source's rate, and within 0.01 of its best match within 3 s; over a
  flat frame it must not show a picture; a too-faint frame is not judged. One failing frame per
  fetch is tolerated, wherever it falls. Only pictured frames carry timing, so a fetch whose source
  is pictured in under 60 % of its frames is `could not measure`: black from end to end is no
  evidence. The evidence says how many were pictured, flat, too faint, and failed.
  - The margin of 10 is measured: on 8,160 served frames of every path, the highest source spread
    at which an output showed no correlatable picture was 6.78 (both GPU tone maps in that fade;
    the CPU 2.25, the plain scales 0.52 at most).
  - The share of 60 % is measured too: every row's start and seek fetches are pictured in 90 % of
    their frames or more (the least, the burn-in seek at 104 s, 90 to 93 %, with a dim stretch; the
    rest 100 %).
  - The Feature Test rows start at 36 s: its first 4 s are a black opening and a fade with no
    pictured frame, while from 36 to 42 s every frame of every version is pictured, the dimmest at
    a spread of 42.9 (the HDR10 version through the reference tone map; 59.9 in the others). It is
    a plain start at that position, on the 4 s segment grid, and no row's seek. Position 0 stays
    covered by the rows whose generated fixtures are pictured from their first frame (spreads 49 to
    63): `decode`, `hybrid-cpu-decode`, `hybrid-cpu-tone-map`, and `scale-variable-rate`.
  - Left alone, ffmpeg 7.1's Quick Sync filters hold a first picture for 41 frames (Matroska,
    1.7 s) to 666 (the Feature Test's MP4, 27.7 s) with every timestamp right, which the other
    checks pass.
- `audio-start` measures the served sound against the source's own track at the fetch's position
  (the stream negotiation chose): it must start by the time the source sounds at the first picture,
  and no earlier than the source sounds at the first decoded video packet (the muxer cuts there when
  the encoder reorders, at most four frames before the picture), within one audio frame of its
  codec and sample rate (1024 samples for AAC). A source whose track starts late passes when the
  output keeps that delay.
- What the two checks do not judge, each shown by a made-up case fed to them:
  - `picture-time` places a picture by how well it matches, so a picture that barely changes (a
    still, or a small marker moving on a still background) matches at every offset and hides one.
    The rows' stretches move enough: with the frame-rate restatement stripped from the Quick Sync
    chain, all four affected cells fail on the 40-frame hold.
  - It does not judge tone. An output crushed to nearly one gray level still matches its source
    and passes, and a shape fainter than a spread of 10 over a black source passes.
  - A variable-rate source whose last picture lasts past the end of the fetch reads `could not
    measure` for the frames under it.
  - `audio-start` reads a gap inside the source's audio from its packets' durations, which an MP4
    can state across the gap, and takes an Opus frame for 20 ms. The rows negotiate AAC from
    sources whose audio has no gap.

- ffmpeg 7.1, the image's, writes an empty sample dependency box (`sdtp`) into a fragmented
  stream's init segment for an encoder that marks pictures disposable (libx265's non-reference
  B-frames, libsvtav1's non-reference pictures), and AVFoundation then hides the video track. The
  media service drops that box from `init.mp4` as it serves it; a grid run's cells hold the bytes
  as served, so `apple-check` sees what a device gets. NixOS's ffmpeg 9 writes no such box.

- Switching paths restarts the side's container, Convex inside it included: the browser host and
  CLI sessions carry on, but a page open in the browser reconnects.
- The decode row plays a generated fixture, made once per side with the side's image's ffmpeg into
  the side's state and mounted at `/media/verify-fixtures`; the matrix scans it into a `Verify
  fixtures` library. A side that `up` started without that mount marks the row `SKIPPED`: run
  `down` and `up` again.
- GPU engine time comes from each ffmpeg's DRM fdinfo, read inside the container as the media
  service's user: `drm-engine-*` nanoseconds on i915, `drm-cycles-*` on xe. Decode and encode share
  the video engine, so a GPU decode also needs `-hwaccel <path> -hwaccel_output_format <path>`,
  which fails the run, not silently, when the GPU can't decode the source.
- The service probes `qsv` and `vaapi` set explicitly as it does `auto`, stage by stage.
  `/api/health` reports the first of them with a verified encoder, so it reads `none` until the
  probes finish and when the device can't encode. The cells, not the health line, say whether the
  GPU did the work.
- The hdr-to-sdr bounds compare the picture with a software Hable tone map of the same frames: a
  different tone curve passes, and a black, washed-out, blown-out, or tinted picture fails.
- The `progressive` check reads `idet=intl_thres=1.5`. At `idet`'s default threshold, Quick
  Sync's motion-adaptive output, with no combing left, reads 49-62 % interlaced on long spans of
  the Feature Test; at 1.5 it reads 0 % and the source still 52 %.
- VA-API deinterlaces with `deinterlace_vaapi=mode=bob`. Its default, motion-adaptive, gives no
  frame for a run's first on iHD (Arc A380, iHD 25.2 and 26.3) and stamps the rest a frame late,
  so a seek's sound starts before its picture; Quick Sync's `vpp_qsv` deinterlacer has neither.
- The burn-in compare counts pixels that differ from the source frame by more than 40 levels: 1 %
  of the bottom 30 % must change while the subtitle shows (108 s), and almost none above it or
  before it shows (105 s).
- The text compare (`burned-text`) renders a reference a second into each fetch: the side's own
  libass drawing the fixture's track and attached font on the source frame at the output size, as
  the service's CPU row does. In the block's region, the subtitle is where the reference differs
  from the source by more than 40 levels, and what was served is where the output does. The served
  box must lie within 2 pixels of the reference's on every edge, its mean colour within 12 levels
  per channel, the drawn pixels must fill 90 % of their box (the attached block font, where a
  fallback font's letters fill far less), and a ring 3 pixels wide around it must differ by 16
  levels at most, where a doubled or haloed edge shows. A frame with nothing drawn fails as a
  missing stage; one it cannot measure fails with `could not measure`. `text.json` and the
  `output-`, `source-`, and `reference-` PNGs of each fetch's frame are beside the cell.
- It does not judge the glyphs of a real font, or effects that move: the block font's rectangles
  are what make the place and colour measurable. The caption and the rotated word in the fixture
  are there for the eye, in the cell's PNGs.
- The cells start playback sessions as Lucía, which leaves her progress on the Feature Test.
