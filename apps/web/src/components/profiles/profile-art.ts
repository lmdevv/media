import type { Profile } from "@media/contracts/models/profiles";

import { avatarHasLettering, avatarImage } from "@/lib/avatars";

/** How a profile's avatar draws. */
export interface ProfileArt {
  /** The avatar's art, or undefined for avatar keys this app does not ship. */
  readonly image: string | undefined;
  /** Whether the name's first letter goes on top; art with its own lettering skips it. */
  readonly monogram: boolean;
}

/** How `profile`'s avatar draws. */
export const profileArt = (profile: Pick<Profile, "avatar">): ProfileArt => ({
  image: avatarImage(profile.avatar),
  monogram: !avatarHasLettering(profile.avatar),
});
