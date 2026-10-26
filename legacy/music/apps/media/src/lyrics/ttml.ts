/**
 * TTML lyrics as Apple Music and the tools that export it write them: one `<p>` per line, timed
 * `<span>`s for words or syllables, `ttm:agent` for the singer, and translations and
 * transliterations keyed to lines by `itunes:key`. Times resolve as TTML defines them, against
 * the parent's start, or in a `seq` container the previous sibling's end. Apple's files, which
 * declare the iTunes namespace, are the exception: they give every element its own song time.
 */
import {
  type Lang,
  type LyricBody,
  type LyricLine,
  type LyricWord,
  parseLang,
} from "@music/commands/lyrics";
import { DOMParser, Element, type Node, ParseError } from "@xmldom/xmldom";
import { Array as Arr, Result } from "effect";

import { LyricsParseError, type ParsedLyricSet, plainBody, timedBody } from "./lyric-body.ts";

const XML_NS = "http://www.w3.org/XML/1998/namespace";

const TTM_NS = "http://www.w3.org/ns/ttml#metadata";

const TTP_NS = "http://www.w3.org/ns/ttml#parameter";

const ITUNES_NS = "http://music.apple.com/lyric-ttml-internal";

const TEXT_NODE = 3;

const CDATA_NODE = 4;

/** A DTD can declare entities, which is how XML external entity attacks start. TTML needs none. */
const DTD = /<!(?:DOCTYPE|ENTITY)/iu;

const OFFSET_TIME = /^(\d+(?:\.\d+)?)(h|ms|m|s|f|t)$/u;

const CLOCK_PART = /^\d+(?:\.\d+)?$/u;

/** How a document's times read: its frame and tick rates, and whether they are song times. */
interface TimeBase {
  readonly frameRate: number;
  readonly tickRate: number;
  /** Apple's dialect: every `begin` and `end` is a position in the song. */
  readonly absolute: boolean;
}

const OFFSET_UNIT_MS: ReadonlyMap<string, (base: TimeBase) => number> = new Map([
  ["h", () => 3_600_000],
  ["m", () => 60_000],
  ["s", () => 1000],
  ["ms", () => 1],
  ["f", (base: TimeBase) => 1000 / base.frameRate],
  ["t", (base: TimeBase) => 1000 / base.tickRate],
]);

/**
 * A TTML time expression in ms: offset time (`12.3s`, `450ms`, `30f`) or clock time
 * (`hh:mm:ss.fff`, `hh:mm:ss:frames`), plus the shorter `mm:ss.fff` and bare seconds Apple writes.
 */
const parseTime = (value: string | null, base: TimeBase): number | null => {
  if (value === null) return null;
  const trimmed = value.trim();
  const offset = OFFSET_TIME.exec(trimmed);

  if (offset !== null) {
    const unit = OFFSET_UNIT_MS.get(offset[2] ?? "");

    return unit === undefined ? null : Math.round(Number(offset[1]) * unit(base));
  }

  const parts = trimmed.split(":");

  if (parts.length > 4 || !parts.every((part) => CLOCK_PART.test(part))) return null;
  const numbers = parts.map(Number);
  const frames = parts.length === 4 ? (numbers[3] ?? 0) : 0;
  const seconds = numbers.slice(0, 3).reduce((total, part) => total * 60 + part, 0);

  return Math.round(seconds * 1000 + (frames * 1000) / base.frameRate);
};

const attribute = (
  element: Element,
  namespace: string,
  name: string,
  prefix: string,
): string | null =>
  element.getAttributeNS(namespace, name) ?? element.getAttribute(`${prefix}:${name}`);

const elementsNamed = (root: Element, name: string): ReadonlyArray<Element> =>
  Array.from(root.getElementsByTagNameNS("*", name));

const children = (node: Node): ReadonlyArray<Node> => Array.from(node.childNodes);

/**
 * An element's interval in song time. `begin` is null when nothing times the element: it names
 * no `begin` of its own and is not in a `seq` container. `start` is the time its children
 * resolve against, which an untimed element inherits from its parent.
 */
interface Interval {
  readonly begin: number | null;
  readonly start: number | null;
  readonly end: number | null;
}

const DOCUMENT_START: Interval = { begin: null, start: 0, end: null };

/**
 * Resolves `begin`, `end`, and `dur` against `reference`, the time the element's container
 * starts it from. With both `end` and `dur`, the earlier end wins.
 */
const intervalOf = (
  element: Element,
  reference: number | null,
  sequential: boolean,
  base: TimeBase,
): Interval => {
  const syncbase = base.absolute ? 0 : reference;

  const at = (name: string): number | null => {
    const offset = parseTime(element.getAttribute(name), base);

    return offset === null || syncbase === null ? null : syncbase + offset;
  };

  const begin = at("begin") ?? (sequential ? reference : null);
  const start = begin ?? reference;
  const duration = parseTime(element.getAttribute("dur"), base);
  const durationEnd = duration === null || start === null ? null : start + duration;
  const end = at("end");

  return {
    begin,
    start,
    end: end === null || durationEnd === null ? (end ?? durationEnd) : Math.min(end, durationEnd),
  };
};

interface TimedNode {
  readonly node: Node;
  /** The node's interval when it is an element; otherwise its parent's. */
  readonly interval: Interval;
}

/** A node's children with their intervals, each element resolved against its container. */
const timedChildren = (
  parent: Node,
  interval: Interval,
  base: TimeBase,
): ReadonlyArray<TimedNode> => {
  const sequential = parent instanceof Element && parent.getAttribute("timeContainer") === "seq";
  let reference = interval.start;
  const timed: Array<TimedNode> = [];

  for (const node of children(parent)) {
    if (node instanceof Element) {
      const own = intervalOf(node, reference, sequential, base);

      if (sequential) reference = own.end;
      timed.push({ node, interval: own });
    } else {
      timed.push({ node, interval });
    }
  }

  return timed;
};

/** A run of a line's text, timed when it is a span with its own `begin`. */
interface Piece {
  readonly text: string;
  readonly startMs: number | null;
  readonly endMs: number | null;
}

/** Background vocals, which Apple marks on a span inside the line they echo. */
const isBackground = (element: Element): boolean =>
  attribute(element, TTM_NS, "role", "ttm") === "x-bg";

const piecesOf = (node: Node, interval: Interval, base: TimeBase): ReadonlyArray<Piece> =>
  timedChildren(node, interval, base).flatMap(
    ({ node: child, interval: own }): ReadonlyArray<Piece> => {
      if (child.nodeType === TEXT_NODE || child.nodeType === CDATA_NODE) {
        // XML's default white space handling: a run of spaces and line breaks is one space.
        return [
          { text: (child.nodeValue ?? "").replaceAll(/\s+/gu, " "), startMs: null, endMs: null },
        ];
      }

      if (!(child instanceof Element) || isBackground(child)) return [];

      if (child.localName === "br") return [{ text: "\n", startMs: null, endMs: null }];
      const inner = piecesOf(child, own, base);

      if (
        child.localName !== "span" ||
        own.begin === null ||
        inner.some((piece) => piece.startMs !== null)
      ) {
        return inner;
      }

      return [
        { text: inner.map((piece) => piece.text).join(""), startMs: own.begin, endMs: own.end },
      ];
    },
  );

interface LineText {
  readonly text: string;
  readonly words: Arr.NonEmptyReadonlyArray<LyricWord> | null;
}

/**
 * A line's text and its timed words. Untimed text between spans (usually the spaces) joins the
 * word before it, so the words still spell the line; `<br/>` breaks the line.
 */
const lineText = (node: Element, interval: Interval, base: TimeBase): LineText => {
  const pieces = piecesOf(node, interval, base);
  const words: Array<LyricWord> = [];
  let lead = "";

  for (const piece of pieces) {
    const last = words.at(-1);

    if (piece.startMs !== null) {
      words.push({ text: lead + piece.text, startMs: piece.startMs, endMs: piece.endMs });
      lead = "";
    } else if (last === undefined) {
      lead += piece.text;
    } else {
      words[words.length - 1] = {
        text: last.text + piece.text,
        startMs: last.startMs,
        endMs: last.endMs,
      };
    }
  }

  const text = pieces
    .map((piece) => piece.text)
    .join("")
    .replaceAll(/ *\n */gu, "\n")
    .trim();

  return { text, words: Arr.isReadonlyArrayNonEmpty(words) ? words : null };
};

interface KeyedLine {
  readonly key: string | null;
  readonly line: LyricLine | null;
  readonly text: string;
}

const bodyOf = (lines: ReadonlyArray<KeyedLine>): Result.Result<LyricBody, LyricsParseError> => {
  const timed = lines.flatMap((entry) => (entry.line === null ? [] : [entry.line]));

  return timed.length > 0
    ? timedBody(timed)
    : plainBody(lines.map((entry) => entry.text).join("\n"));
};

/**
 * Translations (`<translation>`) and transliterations (`<transliteration>`) from Apple's
 * metadata, one set per language, each line taking the timing of the main line it translates.
 */
const extraSets = (
  root: Element,
  main: ReadonlyArray<KeyedLine>,
  base: TimeBase,
): ReadonlyArray<ParsedLyricSet> => {
  const byKey = new Map(
    main.flatMap((entry) => (entry.key === null ? [] : [[entry.key, entry] as const])),
  );

  const kinds = [
    ["translation", "translation"],
    ["transliteration", "pronunciation"],
  ] as const;

  return kinds.flatMap(([elementName, kind]) =>
    elementsNamed(root, elementName).flatMap((element): ReadonlyArray<ParsedLyricSet> => {
      const lines = elementsNamed(element, "text").flatMap((text): ReadonlyArray<KeyedLine> => {
        const original = byKey.get(text.getAttribute("for") ?? "");

        if (original === undefined) return [];
        const { text: translated, words } = lineText(text, DOCUMENT_START, base);

        if (translated === "") return [];

        return [
          {
            key: original.key,
            text: translated,
            line:
              original.line === null
                ? null
                : {
                    text: translated,
                    startMs: original.line.startMs,
                    endMs: original.line.endMs,
                    words,
                    voice: original.line.voice,
                  },
          },
        ];
      });

      const body = bodyOf(lines);

      return Result.isSuccess(body)
        ? [
            {
              kind,
              lang: parseLang(attribute(element, XML_NS, "lang", "xml") ?? ""),
              body: body.success,
            },
          ]
        : [];
    }),
  );
};

/** Deepest element nesting read. Lyrics need a handful of levels; the bound keeps reading safe. */
const MAX_DEPTH = 32;

/** Whether any node sits deeper than `MAX_DEPTH`, found without recursion. */
const tooDeep = (root: Node): boolean => {
  const pending: Array<readonly [Node, number]> = [[root, 1]];

  for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
    const [node, depth] = entry;

    if (depth > MAX_DEPTH) return true;

    for (const child of children(node)) pending.push([child, depth + 1]);
  }

  return false;
};

const malformed = (detail: string) =>
  Result.fail(new LyricsParseError({ reason: "malformed", detail }));

const parseXml = (text: string): Result.Result<Element, LyricsParseError> => {
  if (DTD.test(text)) return malformed("TTML must not declare a DTD");
  const problems: Array<string> = [];
  let root: Element | null;

  try {
    root = new DOMParser({
      onError: (level, message) => {
        if (level !== "warning") problems.push(message);
      },
    }).parseFromString(text, "text/xml").documentElement;
  } catch (cause) {
    // xmldom throws a ParseError for XML that is not well formed, whatever `onError` does.
    return malformed(cause instanceof ParseError ? cause.message : String(cause));
  }

  const [problem] = problems;

  if (problem !== undefined) return malformed(problem);

  if (root?.localName !== "tt") return malformed("no <tt> root");

  if (tooDeep(root)) return malformed(`elements nested deeper than ${MAX_DEPTH}`);

  return Result.succeed(root);
};

/** A `<p>`: its line when something times it, and its text either way. */
const keyedLine = (p: Element, interval: Interval, base: TimeBase): KeyedLine => {
  const spoken = lineText(p, interval, base);

  return {
    key: attribute(p, ITUNES_NS, "key", "itunes"),
    text: spoken.text,
    line:
      interval.begin === null
        ? null
        : {
            text: spoken.text,
            startMs: interval.begin,
            endMs: interval.end,
            words: spoken.words,
            voice: attribute(p, TTM_NS, "agent", "ttm"),
          },
  };
};

/** Every `<p>` under `node`, in document order, timed through the containers above it. */
const linesOf = (node: Node, interval: Interval, base: TimeBase): ReadonlyArray<KeyedLine> =>
  timedChildren(node, interval, base).flatMap(({ node: child, interval: own }) => {
    if (!(child instanceof Element)) return [];

    return child.localName === "p" ? [keyedLine(child, own, base)] : linesOf(child, own, base);
  });

/**
 * Reads a TTML document into its main lyrics plus any translations and transliterations it
 * carries. `lang` (from the file name) wins over the document's `xml:lang` for the main set.
 * Lines without a `begin` read as plain lyrics when no line has one. Background vocals
 * (`ttm:role="x-bg"`) are left out of the lines they echo.
 */
export const parseTtml = (
  text: string,
  lang: Lang | null,
): Result.Result<Arr.NonEmptyReadonlyArray<ParsedLyricSet>, LyricsParseError> =>
  Result.flatMap(parseXml(text), (root) => {
    const frameRate = Number(attribute(root, TTP_NS, "frameRate", "ttp") ?? "30");
    const tickRate = Number(attribute(root, TTP_NS, "tickRate", "ttp") ?? "1");

    const base: TimeBase = {
      frameRate: frameRate > 0 ? frameRate : 30,
      tickRate: tickRate > 0 ? tickRate : 1,
      absolute:
        attribute(root, ITUNES_NS, "timing", "itunes") !== null ||
        root.lookupPrefix(ITUNES_NS) !== null,
    };

    const body = children(root).find(
      (child): child is Element => child instanceof Element && child.localName === "body",
    );

    const main = body === undefined ? [] : linesOf(body, intervalOf(body, 0, false, base), base);

    return Result.map(bodyOf(main), (mainBody): Arr.NonEmptyReadonlyArray<ParsedLyricSet> => [
      {
        kind: "main",
        lang: lang ?? parseLang(attribute(root, XML_NS, "lang", "xml") ?? ""),
        body: mainBody,
      },
      ...extraSets(root, main, base),
    ]);
  });
