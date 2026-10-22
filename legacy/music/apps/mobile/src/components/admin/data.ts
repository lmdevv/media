/**
 * One person, invite, or library looked up in its live list. Each is undefined while the list
 * loads and null once it has loaded without it (removed, used, or never there).
 */
import type { InviteId, LibraryId, UserId } from "@music/commands/ids";
import type { Invite, Library, Person } from "@music/commands/models";
import { useRead } from "@music/sdk/react";

/** Someone on the server, from `people.list`. */
export const usePerson = (id: UserId | null): Person | null | undefined => {
  const people = useRead("people.list", {});

  return people === undefined ? undefined : (people.find((person) => person.id === id) ?? null);
};

/** An unused invite, from `invites.list`. */
export const useInvite = (id: InviteId | null): Invite | null | undefined => {
  const invites = useRead("invites.list", {});

  return invites === undefined ? undefined : (invites.find((invite) => invite.id === id) ?? null);
};

/** A library folder the caller can see, from `libraries.list`. */
export const useLibrary = (id: LibraryId | null): Library | null | undefined => {
  const libraries = useRead("libraries.list", {});

  return libraries === undefined
    ? undefined
    : (libraries.find((library) => library.id === id) ?? null);
};
