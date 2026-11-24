/**
 * How a song's and an album's tags name their artists, shared by the core, which links each song
 * and album to every artist it credits (ADR 0024, "Artist credits"), the server, which joins
 * separate artist values into the string a client shows, and the clients, which link each credited
 * name in that string. Plain TypeScript, so the core's Convex functions import it too.
 *
 * Most tags name several artists in one string, Apple and Spotify style: "Mora & JHAYCO", "Mora,
 * Bad Bunny & Sech", "TOA (feat. Young Miko)". Band names use the same characters ("Mumford &
 * Sons", "Earth, Wind & Fire"), so a string is split only on evidence: one of its parts is a
 * whole credit by itself somewhere in the same library, or a manager said so.
 */

/**
 * What separates the artists of one credit string: ", ", " & ", and " feat. ", " ft. ", or
 * " featuring " in any case. " y ", " x ", " and ", and "/" never do: "Alexis y Fido" and
 * "Jon Z X Ele A" are one act each.
 */
const SEPARATOR = / & |, | (?:feat|ft)\. | featuring /giu;

/**
 * A featured-artist list in a title: "(feat. …)", "[feat. …]", "(ft. …)", "(featuring …)", or
 * "(with …)", in any case, without brackets inside it.
 */
const FEATURED = /[([](?:feat\.|ft\.|featuring|with)\s+([^()[\]]+?)\s*[)\]]/giu;

/**
 * The most parts a credit string is split into. A string with more stays one artist whatever the
 * evidence: no real credit lists that many artists, and resolving one reads each part.
 */
export const MAX_CREDIT_PARTS = 10;

/** The most featured-artist lists read from one title. */
export const MAX_FEATURED_LISTS = 2;

/** One artist a credit string names, between its separators. */
export interface CreditPart {
  /** The part as the string spells it, trimmed. */
  readonly name: string;
  /** Where the trimmed part starts in the string. */
  readonly start: number;
  /** Where the trimmed part ends in the string, exclusive. */
  readonly end: number;
}

/** The key two spellings of one artist share: trimmed and lowercased. */
export const creditKey = (name: string): string => name.trim().toLowerCase();

const partAt = (text: string, from: number, to: number): ReadonlyArray<CreditPart> => {
  const raw = text.slice(from, to);
  const name = raw.trim();

  if (name.length === 0) return [];

  const start = from + raw.indexOf(name);

  return [{ name, start, end: start + name.length }];
};

/**
 * The parts of a credit string between its separators, in order, without empty ones: one part for
 * a string without separators.
 */
export const creditParts = (text: string): ReadonlyArray<CreditPart> => {
  const parts: Array<CreditPart> = [];
  let from = 0;

  for (const match of text.matchAll(SEPARATOR)) {
    parts.push(...partAt(text, from, match.index));
    from = match.index + match[0].length;
  }

  parts.push(...partAt(text, from, text.length));

  return parts;
};

/**
 * Whether a credit string names more than one artist when split: two to `MAX_CREDIT_PARTS`
 * parts. Only such a string is ever split.
 */
export const isCombined = (text: string): boolean => {
  const count = creditParts(text).length;

  return count >= 2 && count <= MAX_CREDIT_PARTS;
};

/**
 * The featured-artist lists in a title, in order, at most `MAX_FEATURED_LISTS`: "Pura Falsedad
 * (feat. Farruko & DJ Luian)" has one, "Farruko & DJ Luian". The title itself stays as tagged.
 */
export const featuredCredits = (title: string): ReadonlyArray<string> =>
  Array.from(title.matchAll(FEATURED), (match) => match[1]?.trim() ?? "")
    .filter((list) => list.length > 0)
    .slice(0, MAX_FEATURED_LISTS);

/** `names` without a later spelling of a name already listed, keeping the first. */
export const distinctNames = (names: Iterable<string>): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const kept: Array<string> = [];

  for (const name of names) {
    const key = creditKey(name);

    if (key.length > 0 && !seen.has(key)) {
      seen.add(key);
      kept.push(name.trim());
    }
  }

  return kept;
};

/** A manager's correction of how a credit string resolves. */
export type CreditOverride = "together" | "split";

/**
 * The most corrections one library keeps: the core refuses another, and a call that resolves a
 * credit reads them all at once.
 */
export const MAX_CREDIT_OVERRIDES = 256;

/**
 * The longest run of parts, in parts, that a whole credit elsewhere in the library keeps together
 * inside a longer one: "Zion & Lennox" in "Bad Bunny & Zion & Lennox". A manager's `together`
 * keeps a run of any length together.
 */
export const MAX_KEPT_PARTS = 4;

/** What a library knows about the names a credit string's parts and runs of parts spell. */
export interface CreditEvidence {
  /**
   * Whether the part `name` is a whole credit by itself somewhere in the library: a song's or an
   * album's artist tag that is exactly that name, a separate artist value, or a lone featured
   * artist.
   */
  readonly known: (name: string) => boolean;
  /**
   * Whether the run of parts `name` stays one artist inside a longer credit: a manager keeps it
   * together, or it is a whole credit by itself somewhere in the library that stays one artist.
   */
  readonly kept: (name: string) => boolean;
  /** How a manager of the library corrected the credit string `name`, or null. */
  readonly override: (name: string) => CreditOverride | null;
}

interface Segment {
  readonly name: string;
  readonly known: boolean;
}

/** The text of the parts `from` to `to` of `text`, with the separators between them. */
const runText = (text: string, from: CreditPart, to: CreditPart): string =>
  text.slice(from.start, to.end);

/**
 * The runs of two to `maxParts` parts of `text`, but the whole string, that `resolveCredit` may
 * keep together: what a library looks up before it resolves the string.
 */
export const creditRuns = (text: string, maxParts: number): ReadonlyArray<string> => {
  const parts = creditParts(text);

  return parts.flatMap((from, start) =>
    parts.flatMap((to, end) => {
      const length = end - start + 1;
      const whole = start === 0 && end === parts.length - 1;

      return length >= 2 && length <= maxParts && !whole ? [runText(text, from, to)] : [];
    }),
  );
};

/**
 * The parts of `text` with each run of parts the evidence keeps together, but the whole string,
 * joined into one, longest run first from the left.
 */
const segmentsOf = (
  text: string,
  parts: ReadonlyArray<CreditPart>,
  evidence: CreditEvidence,
): ReadonlyArray<Segment> => {
  const segments: Array<Segment> = [];
  let index = 0;

  while (index < parts.length) {
    const from = parts[index];

    if (from === undefined) break;

    const runEnd = parts.findLastIndex((to, end) => {
      if (end <= index || (index === 0 && end === parts.length - 1)) return false;

      return evidence.kept(runText(text, from, to));
    });

    const to = runEnd < 0 ? undefined : parts[runEnd];

    if (to === undefined) {
      segments.push({ name: from.name, known: evidence.known(from.name) });
      index += 1;
    } else {
      segments.push({ name: runText(text, from, to), known: true });
      index = runEnd + 1;
    }
  }

  return segments;
};

/**
 * The artists one credit string names, in order (ADR 0024, "Artist credits"). A string of two to
 * `MAX_CREDIT_PARTS` parts splits when a manager split it, or, unless a manager keeps it
 * together, when at least one of its parts is known on its own in the library: the string's own
 * appearance never counts for itself. A run of parts the evidence keeps together stays one artist
 * and counts as known. Without a split it is one artist. A later spelling of a name already named
 * is dropped.
 */
export const resolveCredit = (text: string, evidence: CreditEvidence): ReadonlyArray<string> => {
  const whole = distinctNames([text]);
  const parts = creditParts(text);

  if (parts.length < 2 || parts.length > MAX_CREDIT_PARTS) return whole;

  const override = evidence.override(text);

  if (override === "together") return whole;

  const segments = segmentsOf(text, parts, evidence);
  const split = override === "split" || segments.some((segment) => segment.known);

  return split ? distinctNames(segments.map((segment) => segment.name)) : whole;
};

/** Whether `artists`, a credit string's resolution, names the string itself alone. */
export const staysWhole = (text: string, artists: ReadonlyArray<string>): boolean =>
  artists.length === 1 && creditKey(artists[0] ?? "") === creditKey(text);

/**
 * Separate artist values joined the way a combined credit string writes them: "A", "A & B",
 * "A, B & C", which a client shows in place of the first value alone.
 */
export const joinCreditNames = (names: ReadonlyArray<string>): string => {
  const last = names.at(-1);

  if (last === undefined) return "";

  return names.length < 2 ? last : `${names.slice(0, -1).join(", ")} & ${last}`;
};

/** One artist a song or an album credits, as the music commands answer it. */
export interface ShownCredit<ArtistId> {
  readonly artistId: ArtistId;
  /** The name as the song's or album's tags spell it. */
  readonly name: string;
}

/** A song or an album as a client shows its artists. */
export interface CreditedItem<ArtistId> {
  /** The artist as the tags write it, which a client shows. */
  readonly artist: string;
  /** The first artist it credits. */
  readonly artistId: ArtistId;
  /**
   * Every artist it credits, in order. Absent from a song or album the core has not read again
   * since it kept credits, which credits its one artist under the name it shows.
   */
  readonly credits?: ReadonlyArray<ShownCredit<ArtistId>>;
}

/** The artists `item` credits, in order: its credits, or its one artist under the name it shows. */
export const creditsOf = <ArtistId>(
  item: CreditedItem<ArtistId>,
): ReadonlyArray<ShownCredit<ArtistId>> =>
  item.credits !== undefined && item.credits.length > 0
    ? item.credits
    : [{ artistId: item.artistId, name: item.artist }];

/** A piece of the artist line a client shows: text that joins names, or one credited artist. */
export type CreditPiece<ArtistId> =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "artist"; readonly artistId: ArtistId; readonly name: string };

/**
 * Where `name` next appears in `text` from `from` on, ignoring case, or -1: first as a run of the
 * text's parts, so "eat" in "A feat. Eat" is the last part, not inside " feat. ", else anywhere.
 */
const nameAt = (
  text: string,
  parts: ReadonlyArray<CreditPart>,
  name: string,
  from: number,
): number => {
  const key = name.toLowerCase();

  const matches = (start: number): boolean =>
    text.slice(start, start + name.length).toLowerCase() === key;

  const run = parts.find(
    (part) =>
      part.start >= from &&
      matches(part.start) &&
      parts.some((end) => end.end === part.start + name.length),
  );

  if (run !== undefined) return run.start;

  for (let index = from; index + name.length <= text.length; index += 1) {
    if (matches(index)) return index;
  }

  return -1;
};

/**
 * The artist line of `item` cut into its credited artists and the text that joins them, so a
 * client links each name and keeps the joins as the tags write them: "Mora & JHAYCO" is Mora,
 * " & ", and JHAYCO. Each credit's name is found in the line in credit order, ignoring case, as a
 * run of the line's parts where it can be. A
 * credit the line does not name, such as a featured artist the title names, follows the line
 * joined the way a combined credit string writes it: "Mora" crediting Sech too reads "Mora & Sech",
 * and "Mora & JHAYCO" crediting Sech reads "Mora & JHAYCO, Sech".
 * Every credit is one piece, in order of where it shows.
 */
export const creditLine = <ArtistId>(
  item: CreditedItem<ArtistId>,
): ReadonlyArray<CreditPiece<ArtistId>> => {
  const shown = item.artist;
  const parts = creditParts(shown);
  const pieces: Array<CreditPiece<ArtistId>> = [];
  const unnamed: Array<ShownCredit<ArtistId>> = [];
  let cursor = 0;

  for (const credit of creditsOf(item)) {
    const name = credit.name.trim();
    const at = name.length === 0 ? -1 : nameAt(shown, parts, name, cursor);

    if (at < 0) {
      unnamed.push(credit);
    } else {
      if (at > cursor) pieces.push({ kind: "text", text: shown.slice(cursor, at) });

      pieces.push({
        kind: "artist",
        artistId: credit.artistId,
        name: shown.slice(at, at + name.length),
      });
      cursor = at + name.length;
    }
  }

  if (cursor < shown.length) pieces.push({ kind: "text", text: shown.slice(cursor) });

  // After a line that already joins several names, each name follows a comma.
  const listed = pieces.filter((piece) => piece.kind === "artist").length >= 2;

  unnamed.forEach((credit, index) => {
    const last = index === unnamed.length - 1 && !listed;

    if (index > 0 || shown.trim().length > 0) {
      pieces.push({ kind: "text", text: last ? " & " : ", " });
    }

    pieces.push({ kind: "artist", artistId: credit.artistId, name: credit.name });
  });

  return pieces;
};
