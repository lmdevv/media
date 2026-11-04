import type { Profile } from "@media/contracts/models/profiles";
import { useCommand } from "@media/sdk/react";
import { router } from "expo-router";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { changesFrom, createArgs, draftFrom, newDraft, pinToSave } from "@/lib/profile-draft";
import type { ProfileDraft } from "@/lib/profile-draft";

/** The editor's state and actions. */
export interface ProfileEditor {
  /** The profile being edited, or null while creating one. */
  readonly profile: Profile | null;
  readonly draft: ProfileDraft;
  readonly change: (update: (draft: ProfileDraft) => ProfileDraft) => void;
  /** A PIN typed on Set Profile PIN, waiting for Confirm PIN. */
  readonly candidatePin: string | null;
  readonly setCandidatePin: (pin: string | null) => void;
  /** Creates or updates the profile, then sets or clears its PIN. Rejects with the failure. */
  readonly save: () => Promise<void>;
  /** Pushes one of the editor's screens. */
  readonly open: (screen: EditorScreen) => void;
}

type EditorScreen = "avatar" | "rating" | "pin" | "confirm-pin";

const ProfileEditorContext = createContext<ProfileEditor | null>(null);

/** Holds one editing session's draft for `profile`, or a new profile's when null. */
export function ProfileEditorProvider({
  profile,
  takenAvatars,
  children,
}: {
  readonly profile: Profile | null;
  /** Avatars the account's other profiles use; a new profile starts on a free one. */
  readonly takenAvatars: ReadonlyArray<string>;
  readonly children: ReactNode;
}) {
  const createProfile = useCommand("profiles.create");
  const updateProfile = useCommand("profiles.update");
  const setPin = useCommand("profiles.setPin");

  const [draft, setDraft] = useState(() =>
    profile === null ? newDraft(takenAvatars) : draftFrom(profile),
  );

  const [candidatePin, setCandidatePin] = useState<string | null>(null);

  const change = useCallback((update: (current: ProfileDraft) => ProfileDraft) => {
    setDraft(update);
  }, []);

  const save = useCallback(async () => {
    const saveProfile = async (): Promise<Profile> => {
      if (profile === null) return createProfile(createArgs(draft));
      const changes = changesFrom(profile, draft);

      return Object.keys(changes).length === 0
        ? profile
        : updateProfile({ profileId: profile.id, ...changes });
    };

    const saved = await saveProfile();
    const pin = pinToSave(saved.hasPin, draft.pin);

    if (pin !== undefined) await setPin({ profileId: saved.id, pin });
  }, [createProfile, draft, profile, setPin, updateProfile]);

  const routeId = profile?.id ?? "new";

  const open = useCallback(
    (screen: EditorScreen) => {
      router.push({ pathname: `/profile/[profileId]/${screen}`, params: { profileId: routeId } });
    },
    [routeId],
  );

  const value = useMemo(
    () => ({ profile, draft, change, candidatePin, setCandidatePin, save, open }),
    [profile, draft, change, candidatePin, save, open],
  );

  return <ProfileEditorContext.Provider value={value}>{children}</ProfileEditorContext.Provider>;
}

/**
 * The editor's state.
 *
 * @throws When used outside `ProfileEditorProvider`, a programming error.
 */
export const useProfileEditor = (): ProfileEditor => {
  const editor = useContext(ProfileEditorContext);

  if (editor === null) throw new Error("useProfileEditor must be used inside the profile editor");

  return editor;
};
