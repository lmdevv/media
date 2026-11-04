import { v } from "convex/values";
import type { Validator } from "convex/values";

/** `T | null`, the wire form of a field that may be empty. */
export const nullable = <T, FieldPaths extends string>(
  validator: Validator<T, "required", FieldPaths>,
) => v.union(validator, v.null());

/** Mirrors `Ok` in `@media/contracts/models/common`. */
export const ok = v.object({ ok: v.literal(true) });

/** Paging arguments; mirrors `PageArgs` in `@media/contracts/models/common`. */
export const pageArgs = {
  cursor: v.optional(nullable(v.string())),
  limit: v.optional(v.number()),
};

/** A page of `item`; `nextCursor` is null on the last page. */
export const page = <T, FieldPaths extends string>(item: Validator<T, "required", FieldPaths>) =>
  v.object({ items: v.array(item), nextCursor: nullable(v.string()) });

/** Mirrors `Role` in `@media/contracts`. */
export const role = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
  v.literal("service"),
);

/** Mirrors `AssignableRole` in `@media/contracts`. */
export const assignableRole = v.union(v.literal("admin"), v.literal("member"));

/** Mirrors `Scope` in `@media/contracts`. */
export const scope = v.union(
  v.literal("read"),
  v.literal("play"),
  v.literal("account"),
  v.literal("manage"),
  v.literal("admin"),
  v.literal("media-service"),
);

/** Mirrors `ApiKeyScope` in `@media/contracts`. */
export const apiKeyScope = v.union(
  v.literal("read"),
  v.literal("play"),
  v.literal("manage"),
  v.literal("admin"),
);

/** Mirrors `DeviceScope` in `@media/contracts`. */
export const deviceScope = v.union(
  v.literal("read"),
  v.literal("play"),
  v.literal("account"),
  v.literal("manage"),
  v.literal("admin"),
);

/** Mirrors `SessionKind` in `@media/contracts`. */
export const sessionKind = v.union(v.literal("password"), v.literal("apikey"), v.literal("device"));

/** Mirrors `User` in `@media/contracts`. */
export const user = v.object({
  id: v.id("users"),
  email: nullable(v.string()),
  name: v.string(),
  role,
  disabled: v.boolean(),
  createdAt: v.number(),
});

/** Mirrors `Viewer` in `@media/contracts`. */
export const viewer = v.object({
  user,
  sessionId: v.id("authSessions"),
  sessionKind,
  scopes: v.array(scope),
});

/** Mirrors `SessionInfo` in `@media/contracts`. */
export const sessionInfo = v.object({
  id: v.id("authSessions"),
  kind: sessionKind,
  label: nullable(v.string()),
  scopes: v.array(scope),
  createdAt: v.number(),
  expiresAt: v.number(),
  current: v.boolean(),
});

/** Mirrors `SetupStatus` in `@media/contracts`. */
export const setupStatus = v.object({ hasOwner: v.boolean(), hasLibraries: v.boolean() });

const inviteState = v.union(
  v.literal("open"),
  v.literal("used"),
  v.literal("expired"),
  v.literal("revoked"),
);

/** Mirrors `Invite` in `@media/contracts`. */
export const invite = v.object({
  id: v.id("invites"),
  email: nullable(v.string()),
  role: assignableRole,
  state: inviteState,
  createdBy: v.id("users"),
  createdAt: v.number(),
  expiresAt: v.number(),
});

/** Mirrors `CreatedInvite` in `@media/contracts`. */
export const createdInvite = v.object({ invite, code: v.string(), url: v.string() });

/** Mirrors `InviteLookup` in `@media/contracts`. */
export const inviteLookup = v.union(
  v.object({ state: v.literal("invalid") }),
  v.object({
    state: v.union(v.literal("open"), v.literal("used"), v.literal("expired")),
    email: nullable(v.string()),
    inviterName: v.string(),
    expiresAt: v.number(),
  }),
);

/** Mirrors `ApiKey` in `@media/contracts`. */
export const apiKey = v.object({
  id: v.id("apiKeys"),
  userId: v.id("users"),
  name: v.string(),
  prefix: v.string(),
  scopes: v.array(apiKeyScope),
  createdAt: v.number(),
  lastUsedAt: nullable(v.number()),
  expiresAt: nullable(v.number()),
  revokedAt: nullable(v.number()),
});

/** Mirrors `CreatedApiKey` in `@media/contracts`. */
export const createdApiKey = v.object({ apiKey, secret: v.string() });

/** Mirrors `DeviceCodeRequest` in `@media/contracts`. */
export const deviceCodeRequest = v.object({
  deviceCode: v.string(),
  userCode: v.string(),
  verificationUrl: v.string(),
  expiresAt: v.number(),
});

/** Mirrors `DeviceCodeState` in `@media/contracts`. */
export const deviceCodeState = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("denied"),
  v.literal("expired"),
  v.literal("consumed"),
);

/** Mirrors `DeviceCodeLookup` in `@media/contracts`. */
export const deviceCodeLookup = v.object({
  userCode: v.string(),
  clientName: v.string(),
  state: deviceCodeState,
  requestedAt: v.number(),
  expiresAt: v.number(),
});

/** Mirrors `Profile` in `@media/contracts`. */
export const profile = v.object({
  id: v.id("profiles"),
  name: v.string(),
  avatar: v.string(),
  kids: v.boolean(),
  maxAgeRating: nullable(v.number()),
  hasPin: v.boolean(),
  locked: v.boolean(),
  createdAt: v.number(),
});

/** Mirrors `UnlockResult` in `@media/contracts`. */
export const unlockResult = v.union(
  v.object({ status: v.literal("unlocked") }),
  v.object({ status: v.literal("wrong_pin"), attemptsLeft: v.number() }),
  v.object({ status: v.literal("locked_out"), retryAt: v.number() }),
);

/** Mirrors `LibraryKind` in `@media/contracts`. */
export const libraryKind = v.union(v.literal("movies"), v.literal("shows"), v.literal("mixed"));

/** Mirrors `LibraryAccess` in `@media/contracts`. */
export const libraryAccess = v.union(v.literal("everyone"), v.literal("restricted"));

const libraryFields = {
  id: v.id("libraries"),
  name: v.string(),
  kind: libraryKind,
  titleCount: v.number(),
  lastScanAt: nullable(v.number()),
  scanning: v.boolean(),
};

/** Mirrors `Library` in `@media/contracts`. */
export const library = v.object(libraryFields);

/** Mirrors `LibraryDetail` in `@media/contracts`. */
export const libraryDetail = v.object({
  ...libraryFields,
  roots: v.array(v.string()),
  access: libraryAccess,
  grantedUserIds: v.array(v.id("users")),
  trickplay: v.boolean(),
  createdAt: v.number(),
});

/** Mirrors `TitleKind` in `@media/contracts`. */
export const titleKind = v.union(v.literal("movie"), v.literal("show"));

/** Mirrors `MatchStatus` in `@media/contracts`. */
export const matchStatus = v.union(
  v.literal("matched"),
  v.literal("unmatched"),
  v.literal("manual"),
);

/** Mirrors `ExternalIds` in `@media/contracts`. */
export const externalIds = v.object({
  tmdb: nullable(v.string()),
  imdb: nullable(v.string()),
  tvdb: nullable(v.string()),
});

/** Mirrors `Artwork` in `@media/contracts`. */
export const artwork = v.object({
  poster: nullable(v.string()),
  backdrop: nullable(v.string()),
  logo: nullable(v.string()),
});

/** Mirrors `CommunityRating` in `@media/contracts`. */
export const communityRating = v.object({ value: v.number(), votes: nullable(v.number()) });

/** Mirrors `Ratings` in `@media/contracts`. */
export const ratings = v.object({
  tmdb: nullable(communityRating),
  imdb: nullable(communityRating),
  rottenTomatoes: nullable(v.number()),
  metacritic: nullable(v.number()),
});

/** Mirrors `Trailer` in `@media/contracts`. */
export const trailer = v.object({
  site: v.literal("youtube"),
  key: v.string(),
  name: nullable(v.string()),
});

/** Mirrors `ShowStatus` in `@media/contracts`. */
export const showStatus = v.union(
  v.literal("returning"),
  v.literal("ended"),
  v.literal("canceled"),
  v.literal("in-production"),
  v.literal("planned"),
);

/** Mirrors `CreditKind` in `@media/contracts`. */
export const creditKind = v.union(
  v.literal("actor"),
  v.literal("guest-star"),
  v.literal("director"),
  v.literal("writer"),
  v.literal("creator"),
  v.literal("producer"),
  v.literal("composer"),
);

/** Mirrors `Credit` in `@media/contracts`. */
export const credit = v.object({
  personId: v.id("people"),
  name: v.string(),
  kind: creditKind,
  role: nullable(v.string()),
  profile: nullable(v.string()),
  order: v.number(),
});

/** Mirrors `PersonCard` in `@media/contracts`. */
export const personCard = v.object({
  id: v.id("people"),
  name: v.string(),
  profile: nullable(v.string()),
  knownFor: nullable(v.string()),
});

const collectionRef = v.object({ id: v.id("collections"), name: v.string() });

/** Mirrors `GenreCount` in `@media/contracts`. */
export const genreCount = v.object({ name: v.string(), count: v.number() });

const titleCardFields = {
  id: v.id("titles"),
  kind: titleKind,
  name: v.string(),
  year: nullable(v.number()),
  certification: nullable(v.string()),
  ageRating: nullable(v.number()),
  runtimeMs: nullable(v.number()),
  genres: v.array(v.string()),
  artwork,
  available: v.boolean(),
  addedAt: v.number(),
};

/** Mirrors `TitleCard` in `@media/contracts`. */
export const titleCard = v.object(titleCardFields);

const hdrFormat = v.union(
  v.literal("none"),
  v.literal("hdr10"),
  v.literal("hdr10plus"),
  v.literal("hlg"),
  v.literal("dolby_vision"),
);

const videoStream = v.object({
  index: v.number(),
  codec: v.string(),
  profile: nullable(v.string()),
  level: v.optional(v.number()),
  width: v.number(),
  height: v.number(),
  frameRate: nullable(v.number()),
  bitDepth: nullable(v.number()),
  pixelFormat: nullable(v.string()),
  hdr: hdrFormat,
  bitRate: nullable(v.number()),
});

/** Mirrors `LibraryFileFilter` in `@media/contracts`. */
export const libraryFileFilter = v.union(
  v.literal("all"),
  v.literal("missing"),
  v.literal("unmatched"),
);

/** Mirrors `LibraryFile` in `@media/contracts`. */
export const libraryFile = v.object({
  id: v.id("mediaFiles"),
  path: v.string(),
  sizeBytes: v.number(),
  durationMs: v.number(),
  video: nullable(
    v.object({ codec: v.string(), width: v.number(), height: v.number(), hdr: hdrFormat }),
  ),
  missing: v.boolean(),
  missingSince: nullable(v.number()),
  title: v.object({
    id: v.id("titles"),
    kind: titleKind,
    name: v.string(),
    year: nullable(v.number()),
    matchStatus,
    externalIds,
    poster: nullable(v.string()),
  }),
  episode: nullable(v.object({ seasonNumber: v.number(), episodeNumber: v.number() })),
});

/** Mirrors `LibraryFileSummary` in `@media/contracts`. */
export const libraryFileSummary = v.object({
  missingFiles: v.number(),
  missingSince: nullable(v.number()),
  unmatchedTitles: v.number(),
});

const audioStream = v.object({
  index: v.number(),
  codec: v.string(),
  profile: nullable(v.string()),
  channels: v.number(),
  channelLayout: nullable(v.string()),
  sampleRate: v.optional(v.number()),
  language: nullable(v.string()),
  title: nullable(v.string()),
  default: v.boolean(),
  bitRate: nullable(v.number()),
  endMs: v.optional(v.number()),
});

const subtitleStream = v.object({
  index: v.number(),
  codec: v.string(),
  kind: v.union(v.literal("text"), v.literal("image")),
  language: nullable(v.string()),
  title: nullable(v.string()),
  default: v.boolean(),
  forced: v.boolean(),
  hearingImpaired: v.optional(v.boolean()),
});

/** Mirrors `Chapter` in `@media/contracts`. */
export const chapter = v.object({
  startMs: v.number(),
  endMs: v.number(),
  title: nullable(v.string()),
});

/** Mirrors `Probe` in `@media/contracts`. */
export const probe = v.object({
  container: v.string(),
  formatName: v.optional(v.string()),
  durationMs: v.number(),
  startMs: v.optional(v.number()),
  bitRate: nullable(v.number()),
  video: v.array(videoStream),
  audio: v.array(audioStream),
  subtitles: v.array(subtitleStream),
  chapters: v.optional(v.array(chapter)),
});

/** Mirrors `TrickplayManifest` in `@media/contracts/trickplay`. */
export const trickplayManifest = v.object({
  version: v.string(),
  intervalMs: v.number(),
  tileWidth: v.number(),
  tileHeight: v.number(),
  columns: v.number(),
  rows: v.number(),
  thumbnailCount: v.number(),
  sheetCount: v.number(),
});

/**
 * A file's scrub thumbnails as stored: queued or running (`pending`), made (`ready`), or given up
 * on (`failed`, until an admin asks again), each for the file at `sizeBytes` and `mtimeMs`. Absent
 * means none were asked for.
 */
export const trickplayState = v.union(
  v.object({
    status: v.literal("pending"),
    jobId: v.id("jobs"),
    sizeBytes: v.number(),
    mtimeMs: v.number(),
  }),
  v.object({
    status: v.literal("ready"),
    sizeBytes: v.number(),
    mtimeMs: v.number(),
    manifest: trickplayManifest,
  }),
  v.object({ status: v.literal("failed"), sizeBytes: v.number(), mtimeMs: v.number() }),
);

/** Mirrors `ExternalSubtitle` in `@media/contracts`. */
export const externalSubtitle = v.object({
  fileName: v.string(),
  codec: v.string(),
  language: nullable(v.string()),
  title: v.optional(v.string()),
  forced: v.boolean(),
  hearingImpaired: v.optional(v.boolean()),
  default: v.optional(v.boolean()),
});

/** Mirrors `MediaFile` in `@media/contracts`. */
export const mediaFile = v.object({
  id: v.id("mediaFiles"),
  titleId: v.id("titles"),
  episodeId: nullable(v.id("episodes")),
  versionName: nullable(v.string()),
  sizeBytes: v.number(),
  probe,
  externalSubtitles: v.array(externalSubtitle),
  hdr: v.boolean(),
  missing: v.boolean(),
  trickplay: nullable(trickplayManifest),
});

const dynamicRange = v.union(
  v.literal("sdr"),
  v.literal("hdr10"),
  v.literal("hlg"),
  v.literal("dolby-vision"),
);

/** Mirrors `ClientCapabilities` in `@media/contracts/media-playback`. */
export const clientCapabilities = v.object({
  containers: v.array(
    v.union(
      v.literal("mp4"),
      v.literal("mov"),
      v.literal("mkv"),
      v.literal("webm"),
      v.literal("avi"),
      v.literal("ts"),
      v.literal("other"),
    ),
  ),
  videoCodecs: v.array(
    v.object({
      codec: v.string(),
      profiles: v.optional(v.array(v.string())),
      maxLevel: v.optional(v.number()),
      maxBitDepth: v.optional(v.number()),
      dynamicRanges: v.optional(v.array(dynamicRange)),
    }),
  ),
  audioCodecs: v.array(v.object({ codec: v.string(), maxChannels: v.optional(v.number()) })),
  maxWidth: v.number(),
  maxHeight: v.number(),
  hls: v.boolean(),
  mse: v.boolean(),
});

/** Mirrors `MediaVersion` in `@media/contracts`. */
export const mediaVersion = v.object({
  id: v.id("mediaFiles"),
  versionName: nullable(v.string()),
  width: nullable(v.number()),
  height: nullable(v.number()),
  hdr: hdrFormat,
  videoCodec: nullable(v.string()),
  videoProfile: nullable(v.string()),
  videoLevel: nullable(v.number()),
  videoBitDepth: nullable(v.number()),
  audioCodec: nullable(v.string()),
  audioChannels: nullable(v.number()),
  audioTracks: v.number(),
  container: v.string(),
  sizeBytes: v.number(),
  durationMs: v.number(),
  lastPlayed: v.boolean(),
});

/** Mirrors `Progress` in `@media/contracts`. */
export const progress = v.object({
  positionMs: v.number(),
  durationMs: v.number(),
  watched: v.boolean(),
  updatedAt: v.number(),
});

/** Mirrors `Episode` in `@media/contracts`. */
export const episode = v.object({
  id: v.id("episodes"),
  titleId: v.id("titles"),
  seasonId: v.id("seasons"),
  seasonNumber: v.number(),
  episodeNumber: v.number(),
  name: v.string(),
  overview: nullable(v.string()),
  airDate: nullable(v.string()),
  runtimeMs: nullable(v.number()),
  still: nullable(v.string()),
  rating: nullable(v.number()),
  externalIds,
  available: v.boolean(),
  progress: nullable(progress),
});

/** Mirrors `SeasonEpisode` in `@media/contracts`. */
export const seasonEpisode = v.object({ ...episode.fields, credits: v.array(credit) });

/** Mirrors `Season` in `@media/contracts`. */
export const season = v.object({
  id: v.id("seasons"),
  seasonNumber: v.number(),
  name: v.string(),
  poster: nullable(v.string()),
  episodeCount: v.number(),
  externalIds,
});

/** Mirrors `TitleDetail` in `@media/contracts`. */
export const titleDetail = v.object({
  ...titleCardFields,
  libraryId: v.id("libraries"),
  sortName: v.string(),
  overview: nullable(v.string()),
  tagline: nullable(v.string()),
  externalIds,
  matchStatus,
  originalName: nullable(v.string()),
  releaseDate: nullable(v.string()),
  status: nullable(showStatus),
  originalLanguage: nullable(v.string()),
  studios: v.array(v.string()),
  countries: v.array(v.string()),
  tags: v.array(v.string()),
  ratings,
  trailer: nullable(trailer),
  collection: nullable(collectionRef),
  cast: v.array(credit),
  crew: v.array(credit),
  seasons: v.array(season),
  files: v.array(mediaFile),
  versions: v.array(mediaVersion),
  progress: nullable(progress),
  nextEpisode: nullable(episode),
  inMyList: v.boolean(),
});

/** Mirrors `ContinueWatchingItem` in `@media/contracts`. */
export const continueWatchingItem = v.object({
  reason: v.union(v.literal("resume"), v.literal("next")),
  title: titleCard,
  episode: nullable(episode),
  progress: nullable(progress),
});

/** Mirrors `Home` in `@media/contracts`. */
export const home = v.object({
  featured: nullable(titleCard),
  continueWatching: v.array(continueWatchingItem),
  myList: v.array(titleCard),
  recentlyAddedMovies: v.array(titleCard),
  recentlyAddedShows: v.array(titleCard),
});

/** Mirrors `HistoryEntry` in `@media/contracts`. */
export const historyEntry = v.object({
  title: titleCard,
  episode: nullable(episode),
  progress,
  lastPlayedAt: v.number(),
});

/** Mirrors `TitleSort` in `@media/contracts`. */
export const titleSort = v.union(v.literal("name"), v.literal("added"), v.literal("year"));

/** Mirrors `MetadataOverrides` in `@media/contracts`. */
export const metadataOverrides = v.object({
  name: v.optional(v.string()),
  sortName: v.optional(v.string()),
  year: v.optional(v.number()),
  overview: v.optional(v.string()),
  certification: v.optional(v.string()),
  ageRating: v.optional(v.number()),
});

/** Mirrors `MetadataField` in `@media/contracts`. */
export const metadataField = v.union(
  v.literal("name"),
  v.literal("sortName"),
  v.literal("year"),
  v.literal("overview"),
  v.literal("certification"),
  v.literal("ageRating"),
);

/** Mirrors `PlaybackMode` in `@media/contracts`. */
export const playbackMode = v.union(
  v.literal("direct"),
  v.literal("remux"),
  v.literal("audio-transcode"),
  v.literal("transcode-qsv"),
  v.literal("transcode-vaapi"),
  v.literal("transcode-software"),
);

/** Whether a device is playing or paused; `state` of `PlaybackSession` in `@media/contracts`. */
export const playbackState = v.union(v.literal("playing"), v.literal("paused"));

/** Whether playback continues; `status` of `SessionStatus` in `@media/contracts`. */
export const playbackSessionStatus = v.union(v.literal("active"), v.literal("ended"));

/** Mirrors `PlaybackSession` in `@media/contracts`. */
export const playbackSession = v.object({
  id: v.id("playbackSessions"),
  profileId: v.id("profiles"),
  deviceId: v.string(),
  deviceName: nullable(v.string()),
  titleId: v.id("titles"),
  episodeId: nullable(v.id("episodes")),
  fileId: v.id("mediaFiles"),
  mode: nullable(playbackMode),
  positionMs: v.number(),
  state: playbackState,
  startedAt: v.number(),
  lastReportAt: v.number(),
});

/** Mirrors `StartedPlayback` in `@media/contracts`. */
export const startedPlayback = v.object({
  sessionId: v.id("playbackSessions"),
  titleId: v.id("titles"),
  episodeId: nullable(v.id("episodes")),
  episode: nullable(episode),
  file: mediaFile,
  token: v.string(),
  tokenExpiresAt: v.number(),
  mediaBaseUrl: v.string(),
  resumePositionMs: v.number(),
});

/** Mirrors `RenewedToken` in `@media/contracts`. */
export const renewedToken = v.object({ token: v.string(), tokenExpiresAt: v.number() });

/** Mirrors `ProgressEvent` in `@media/contracts`. */
export const progressEvent = v.union(
  v.literal("tick"),
  v.literal("pause"),
  v.literal("resume"),
  v.literal("seek"),
  v.literal("ended"),
);

/** Mirrors `ProgressReceipt` in `@media/contracts`. */
export const progressReceipt = v.object({ applied: v.boolean(), watched: v.boolean() });

/** Mirrors `RoomStatus` in `@media/contracts`. */
export const roomStatus = v.union(
  v.literal("playing"),
  v.literal("paused"),
  v.literal("buffering"),
  v.literal("ended"),
);

/** Mirrors `RoomClock` in `@media/contracts`. */
export const roomClock = v.object({
  status: roomStatus,
  positionAtAnchorMs: v.number(),
  anchorServerTime: v.number(),
  playbackRate: v.number(),
  revision: v.number(),
});

/** Who a room member is: the host, who controls playback, or a guest; `role` of `RoomMember`. */
export const roomRole = v.union(v.literal("host"), v.literal("guest"));

/**
 * Whether a member's device is playing the room (`watching`) or browsing elsewhere in the app
 * while it keeps its place (`away`); `RoomPresence` in contracts.
 */
export const roomPresence = v.union(v.literal("watching"), v.literal("away"));

const roomMember = v.object({
  userId: v.id("users"),
  profileId: v.id("profiles"),
  profileName: v.string(),
  avatar: v.string(),
  deviceId: v.string(),
  role: roomRole,
  joinedAt: v.number(),
  lastSeenAt: v.number(),
  presence: roomPresence,
  driftMs: nullable(v.number()),
});

const roomNext = v.union(
  v.object({ status: v.literal("pending"), episode, nextAt: v.number() }),
  v.object({ status: v.literal("cancelled") }),
);

/**
 * A room's stored next-episode countdown (`rooms.next`): the episode it moves on to rather than
 * the presented one.
 */
export const storedRoomNext = v.union(
  v.object({ status: v.literal("pending"), episodeId: v.id("episodes"), nextAt: v.number() }),
  v.object({ status: v.literal("cancelled") }),
);

/** Mirrors `Room` in `@media/contracts`. */
export const room = v.object({
  id: v.id("rooms"),
  title: titleCard,
  episode: nullable(episode),
  fileId: v.id("mediaFiles"),
  hostUserId: v.id("users"),
  hostProfileId: v.id("profiles"),
  hostDeviceId: v.string(),
  hostProfileName: v.string(),
  hostAway: v.boolean(),
  clock: roomClock,
  next: nullable(roomNext),
  members: v.array(roomMember),
  createdAt: v.number(),
});

/** Arguments of every host room control; mirrors `HostControlArgs` in contracts. */
export const hostControlArgs = {
  roomId: v.id("rooms"),
  deviceId: v.string(),
  revision: v.number(),
  positionMs: v.number(),
  fileId: v.optional(v.id("mediaFiles")),
};

/** Mirrors `JobKind` in `@media/contracts`. */
export const jobKind = v.union(
  v.literal("scan"),
  v.literal("metadata"),
  v.literal("person"),
  v.literal("backup"),
  v.literal("migration"),
  v.literal("trickplay"),
);

/** Mirrors `JobStatus` in `@media/contracts`. */
export const jobStatus = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("cancelled"),
);

/** Mirrors `ScanMode` in `@media/contracts`. */
export const scanMode = v.union(v.literal("full"), v.literal("quick"));

/** Mirrors `MigrationSource` in `@media/contracts`. */
export const migrationSource = v.union(v.literal("jellyfin"), v.literal("plex"));

/** Why a backup ran: the nightly cron or an admin. */
export const backupTrigger = v.union(v.literal("nightly"), v.literal("manual"));

/** Mirrors `JobPayload` in `@media/contracts`. */
export const jobPayload = v.union(
  v.object({ kind: v.literal("scan"), libraryId: v.id("libraries"), mode: scanMode }),
  v.object({
    kind: v.literal("metadata"),
    titleId: v.id("titles"),
    match: nullable(v.object({ provider: v.literal("tmdb"), providerId: v.string() })),
  }),
  v.object({ kind: v.literal("person"), personId: v.id("people") }),
  v.object({ kind: v.literal("backup"), trigger: backupTrigger }),
  v.object({
    kind: v.literal("migration"),
    source: migrationSource,
    serverName: v.string(),
  }),
  v.object({ kind: v.literal("trickplay"), fileId: v.id("mediaFiles") }),
);

/** Mirrors `JobProgress` in `@media/contracts`. */
export const jobProgress = v.object({
  done: v.number(),
  total: nullable(v.number()),
  message: nullable(v.string()),
});

/** Mirrors `Job` in `@media/contracts`. */
export const job = v.object({
  id: v.id("jobs"),
  kind: jobKind,
  status: jobStatus,
  payload: jobPayload,
  progress: jobProgress,
  error: nullable(v.string()),
  requestedBy: nullable(v.id("users")),
  attempts: v.number(),
  createdAt: v.number(),
  startedAt: nullable(v.number()),
  finishedAt: nullable(v.number()),
});

/** Mirrors `QueuedJob` in `@media/contracts`. */
export const queuedJob = v.object({ jobId: v.id("jobs") });

/** Mirrors `Backup` in `@media/contracts`. */
export const backup = v.object({
  id: v.id("backups"),
  fileName: v.string(),
  sizeBytes: v.number(),
  trigger: backupTrigger,
  createdAt: v.number(),
});

/** Arguments naming a job and the worker that holds its lease; mirrors `LeaseArgs` in contracts. */
export const leaseArgs = { jobId: v.id("jobs"), workerId: v.string() };

/** Mirrors `BackupArchive` in `@media/contracts`. */
export const backupArchive = v.object({
  fileName: v.string(),
  sizeBytes: v.number(),
  trigger: backupTrigger,
  takenAt: v.number(),
});

/** Mirrors `MediaLibrary` in `@media/contracts`. */
export const mediaLibrary = v.object({
  id: v.id("libraries"),
  name: v.string(),
  kind: libraryKind,
  roots: v.array(v.string()),
});

/** Mirrors `ClaimedJob` in `@media/contracts`. */
export const claimedJob = v.object({
  job,
  library: nullable(mediaLibrary),
  leaseExpiresAt: v.number(),
});

/** Mirrors `ScannedTitle` in `@media/contracts`. */
export const scannedTitle = v.object({
  kind: titleKind,
  matchKey: v.string(),
  name: v.string(),
  sortName: nullable(v.string()),
  year: nullable(v.number()),
  overview: nullable(v.string()),
  tagline: nullable(v.string()),
  genres: v.array(v.string()),
  certification: nullable(v.string()),
  ageRating: nullable(v.number()),
  runtimeMs: nullable(v.number()),
  artwork,
  externalIds,
  matchStatus: v.union(v.literal("matched"), v.literal("unmatched")),
  originalName: v.optional(nullable(v.string())),
  releaseDate: v.optional(nullable(v.string())),
  status: v.optional(nullable(showStatus)),
  originalLanguage: v.optional(nullable(v.string())),
  studios: v.optional(v.array(v.string())),
  countries: v.optional(v.array(v.string())),
  tags: v.optional(v.array(v.string())),
  ratings: v.optional(ratings),
  trailer: v.optional(nullable(trailer)),
  recommendations: v.optional(v.array(v.string())),
});

/** Mirrors `ScannedEpisode` in `@media/contracts`. */
export const scannedEpisode = v.object({
  seasonNumber: v.number(),
  episodeNumber: v.number(),
  name: nullable(v.string()),
  overview: nullable(v.string()),
  airDate: nullable(v.string()),
  runtimeMs: nullable(v.number()),
  still: nullable(v.string()),
  seasonName: nullable(v.string()),
  seasonPoster: nullable(v.string()),
  rating: v.optional(nullable(communityRating)),
  externalIds: v.optional(externalIds),
  seasonExternalIds: v.optional(externalIds),
});

const scannedFile = v.object({
  path: v.string(),
  sizeBytes: v.number(),
  mtimeMs: v.number(),
  probe,
  externalSubtitles: v.array(externalSubtitle),
  versionName: nullable(v.string()),
  sidecarDigest: v.optional(v.string()),
});

/** Mirrors `ScannedItem` in `@media/contracts`. */
export const scannedItem = v.object({
  file: scannedFile,
  title: scannedTitle,
  episode: nullable(scannedEpisode),
});

/** Mirrors `UpsertedFile` in `@media/contracts`. */
export const upsertedFile = v.object({
  path: v.string(),
  fileId: v.id("mediaFiles"),
  titleId: v.id("titles"),
  episodeId: nullable(v.id("episodes")),
  titleCreditsHash: nullable(v.string()),
  episodeCreditsHash: nullable(v.string()),
  collectionHash: nullable(v.string()),
});

/** Mirrors `IndexedFile` in `@media/contracts`. */
export const indexedFile = v.object({
  path: v.string(),
  sizeBytes: v.number(),
  mtimeMs: v.number(),
  missing: v.boolean(),
  sidecarDigest: nullable(v.string()),
});

/** Mirrors `ResolvedFile` in `@media/contracts`. */
export const resolvedFile = v.object({
  fileId: v.id("mediaFiles"),
  libraryId: v.id("libraries"),
  path: v.string(),
  roots: v.array(v.string()),
  probe,
  externalSubtitles: v.array(externalSubtitle),
  missing: v.boolean(),
});

/** Mirrors `SessionStatus` in `@media/contracts`. */
export const sessionStatus = v.object({
  sessionId: v.id("playbackSessions"),
  status: playbackSessionStatus,
  fileId: v.id("mediaFiles"),
  endedAt: nullable(v.number()),
  state: playbackState,
  positionMs: v.number(),
});

/** Mirrors `MetadataTarget` in `@media/contracts`. */
export const metadataTarget = v.object({
  titleId: v.id("titles"),
  libraryId: v.id("libraries"),
  kind: titleKind,
  name: v.string(),
  year: nullable(v.number()),
  externalIds,
  artwork,
  episodes: v.array(
    v.object({ episodeId: v.id("episodes"), seasonNumber: v.number(), episodeNumber: v.number() }),
  ),
});

/** Mirrors `ScannedPerson` in `@media/contracts`. */
export const scannedPerson = v.object({
  name: v.string(),
  externalIds,
  profile: nullable(v.string()),
});

/** Mirrors `ScannedCredit` in `@media/contracts`. */
export const scannedCredit = v.object({
  person: scannedPerson,
  kind: creditKind,
  role: nullable(v.string()),
  order: v.number(),
});

/** Mirrors `ScannedCollection` in `@media/contracts`. */
export const scannedCollection = v.object({
  sourceKey: v.string(),
  name: v.string(),
  overview: nullable(v.string()),
  poster: nullable(v.string()),
  backdrop: nullable(v.string()),
});

/** Mirrors `ScannedPersonDetails` in `@media/contracts`. */
export const scannedPersonDetails = v.object({
  name: v.string(),
  externalIds,
  profile: nullable(v.string()),
  biography: nullable(v.string()),
  birthDate: nullable(v.string()),
  deathDate: nullable(v.string()),
  birthPlace: nullable(v.string()),
  knownFor: nullable(v.string()),
});

/** Mirrors `PersonTarget` in `@media/contracts`. */
export const personTarget = v.object({
  personId: v.id("people"),
  name: v.string(),
  externalIds,
});

/** Mirrors `PersonDetail` in `@media/contracts`. */
export const personDetail = v.object({
  id: v.id("people"),
  name: v.string(),
  profile: nullable(v.string()),
  externalIds,
  biography: nullable(v.string()),
  birthDate: nullable(v.string()),
  deathDate: nullable(v.string()),
  birthPlace: nullable(v.string()),
  knownFor: nullable(v.string()),
  detailsPending: v.boolean(),
  credits: v.array(
    v.object({
      title: titleCard,
      kind: creditKind,
      role: nullable(v.string()),
      episodeCount: v.number(),
    }),
  ),
});
