/** Avatar keys in picker order. `red` is the backend's default for a new account's profile. */
export const AVATAR_KEYS = ["red", "blue", "green", "plum", "teal", "slate", "kids"] as const;

const known: ReadonlySet<string> = new Set(AVATAR_KEYS);

/** The art for an avatar key, or undefined for keys this app does not know. */
export const avatarImage = (key: string): string | undefined =>
  known.has(key) ? `${import.meta.env.BASE_URL}avatars/${key}.svg` : undefined;

/** Avatars whose art already carries a label (the `kids` lettering) skip the name's first letter. */
export const avatarHasLettering = (key: string): boolean => key === "kids";
