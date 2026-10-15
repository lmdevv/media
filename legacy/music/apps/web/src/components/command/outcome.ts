import { JobId, PlaylistId } from "@music/commands/ids";
import type { Job } from "@music/commands/models";
import { Invite, PasswordReset } from "@music/commands/models";
import type { CommandResult, MutationName } from "@music/commands/registry";
import { Option, Schema } from "effect";

const decodeJob = Schema.decodeUnknownOption(Schema.Struct({ jobId: JobId }));

const decodeKey = Schema.decodeUnknownOption(Schema.Struct({ key: Schema.String }));

const decodeInvite = Schema.decodeUnknownOption(Invite);

const decodeReset = Schema.decodeUnknownOption(PasswordReset);

const decodePlaylist = Schema.decodeUnknownOption(Schema.Struct({ playlistId: PlaylistId }));

/**
 * What a command's result means for the menu: a job to follow, a key, invite code, or reset link
 * to show once,
 * a playlist to open, or nothing worth showing.
 */
type CommandOutcome =
  | { readonly kind: "job"; readonly jobId: JobId }
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "invite"; readonly code: string }
  | { readonly kind: "reset"; readonly token: string }
  | { readonly kind: "playlist"; readonly playlistId: PlaylistId }
  | { readonly kind: "none" };

/**
 * Reads a command's result by shape, since the menu runs any mutation and only some return
 * something to show. The first shape that matches wins, in the order job, key, invite, reset
 * link, playlist.
 */
export const outcomeOf = (result: CommandResult<MutationName>): CommandOutcome => {
  const job = decodeJob(result);

  if (Option.isSome(job)) return { kind: "job", jobId: job.value.jobId };

  const key = decodeKey(result);

  if (Option.isSome(key)) return { kind: "key", key: key.value.key };

  const invite = decodeInvite(result);

  if (Option.isSome(invite)) return { kind: "invite", code: invite.value.code };

  const reset = decodeReset(result);

  if (Option.isSome(reset)) return { kind: "reset", token: reset.value.token };

  const playlist = decodePlaylist(result);

  if (Option.isSome(playlist)) return { kind: "playlist", playlistId: playlist.value.playlistId };

  return { kind: "none" };
};

/** The line under a job's title: the result once it ends, or a note that it runs on its own. */
export const jobMeta = (job: Job | undefined): string => {
  // The scanner's summary, such as "28 files, 0 updated, 0 missing".
  if (job?.status === "done") return job.message ?? "Finished.";

  if (job?.status === "failed") return job.error ?? "The job failed.";

  return "Runs in the background. Close this any time.";
};
