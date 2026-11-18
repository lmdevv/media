import type { DomainItem } from "../../commands/access";
import type { Doc } from "../_generated/dataModel";

const titleItem = (title: Doc<"titles">): DomainItem => ({
  domain: "movies",
  ref: { type: "title", id: title._id },
});

const episodeItem = (episode: Doc<"episodes">): DomainItem => ({
  domain: "movies",
  ref: { type: "episode", id: episode._id },
});

const fileItem = (file: Doc<"mediaFiles">): DomainItem => ({
  domain: "movies",
  ref: { type: "file", id: file._id },
});

/** Decides a file through the same item decision for its file, episode, and title. */
export const mayPlayFile = async (
  decide: (item: DomainItem) => Promise<boolean>,
  title: Doc<"titles">,
  episode: Doc<"episodes"> | null,
  file: Doc<"mediaFiles">,
): Promise<boolean> => {
  const items = [
    fileItem(file),
    ...(episode === null ? [] : [episodeItem(episode)]),
    titleItem(title),
  ];

  const tried = async (index: number): Promise<boolean> => {
    const item = items[index];

    return item !== undefined && ((await decide(item)) || tried(index + 1));
  };

  return tried(0);
};
