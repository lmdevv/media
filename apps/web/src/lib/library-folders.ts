import { normalizeFolder } from "@media/contracts/library-folder";

export { normalizeFolder };

/** Why a typed folder cannot be saved, or null when it looks valid. */
export const folderProblem = (path: string): string | null => {
  const folder = normalizeFolder(path);

  if (folder === "") return "Enter the folder's path on the server.";

  if (!folder.startsWith("/")) return "Use the full path from the root, such as /mnt/nas/movies.";

  const segments = folder.split("/");

  if (segments.includes(".") || segments.includes("..")) {
    return "Write the path without . or .. parts.";
  }

  return null;
};
