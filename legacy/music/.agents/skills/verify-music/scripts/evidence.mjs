#!/usr/bin/env node
// Collects before/after screenshots and videos for a run and publishes them to a pull request's
// description through `gh pr edit --attach`. verify-music.sh passes --root, --run, and --evidence.
//
//   evidence.mjs add --label <text> [--before <file>] [--after <file>]
//   evidence.mjs list
//   evidence.mjs clear
//   evidence.mjs publish --pr <number> [--dry-run]
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  strict: true,
  options: {
    root: { type: "string" },
    run: { type: "string" },
    evidence: { type: "string" },
    label: { type: "string" },
    before: { type: "string" },
    after: { type: "string" },
    pr: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

const START = "<!-- verify-music:start -->";
const END = "<!-- verify-music:end -->";
// GitHub's limits for an attachment: 10 MB for an image, and 10 MB for a video on a free plan.
const LIMIT = 10 * 1024 * 1024;
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif"]);
const VIDEO = new Set([".mp4", ".mov", ".webm", ".m4v"]);

const root = flags.root;
const manifest = join(flags.evidence, "manifest.tsv");

const fail = (message) => {
  console.error(`evidence: ${message}`);
  process.exit(1);
};

const kind = (file) => {
  const extension = extname(file).toLowerCase();
  if (IMAGE.has(extension)) return "image";
  if (VIDEO.has(extension)) return "video";
  return fail(`${file} is neither an image (png, jpg, gif) nor a video (mp4, mov, webm)`);
};

// Paths are stored relative to the repo root, as `gh --attach` and the PR body reference them.
const fromRoot = (file) => {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) fail(`${file} does not exist`);
  return relative(root, path);
};

const rows = () =>
  existsSync(manifest)
    ? readFileSync(manifest, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [label, before, after] = line.split("\t");
          return { label, before: before || null, after: after || null };
        })
    : [];

const add = () => {
  if (!flags.label) fail("add needs --label");
  if (!flags.before && !flags.after) fail("add needs --before, --after, or both");
  const before = flags.before ? fromRoot(flags.before) : "";
  const after = flags.after ? fromRoot(flags.after) : "";
  if (before && after && kind(before) !== kind(after)) {
    fail("a pair's before and after must both be images or both be videos");
  }
  mkdirSync(flags.evidence, { recursive: true });
  appendFileSync(manifest, `${flags.label.replaceAll("\t", " ")}\t${before}\t${after}\n`);
  console.log(`added "${flags.label}" (${rows().length} in ${relative(root, manifest)})`);
};

const list = () => {
  for (const row of rows()) console.log(`${row.label}\tbefore: ${row.before ?? "none"}\tafter: ${row.after ?? "none"}`);
};

const ffmpeg = (input, output, filter, crf) =>
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-i", input, "-an", "-vf", filter,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf),
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", output,
  ]);

// H.264 MP4 plays in every browser GitHub supports; WebM from Playwright does not play in Safari.
const toMp4 = (file, index, side) => {
  const out = join(flags.evidence, "pr", `${String(index).padStart(2, "0")}-${side}.mp4`);
  mkdirSync(join(flags.evidence, "pr"), { recursive: true });
  const even = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  ffmpeg(join(root, file), out, even, 28);
  if (statSync(out).size > LIMIT) ffmpeg(join(root, file), out, "scale=720:-2", 34);
  if (statSync(out).size > LIMIT) fail(`${file} is over 10 MB even at 720p; record a shorter clip`);
  return relative(root, out);
};

const checkImage = (file) => {
  if (statSync(join(root, file)).size > LIMIT) fail(`${file} is over GitHub's 10 MB image limit`);
  return file;
};

const block = (items) => {
  const images = items.filter((item) => item.kind === "image");
  const videos = items.filter((item) => item.kind === "video");
  const ref = (file, alt) => (file ? `![${alt}](./${file})` : "none");
  const lines = [START, "## Screenshots and video", ""];
  if (images.length > 0) {
    lines.push("| | Before | After |", "| --- | --- | --- |");
    for (const item of images) {
      lines.push(
        `| ${item.label} | ${ref(item.before, `Before: ${item.label}`)} | ${ref(item.after, `After: ${item.label}`)} |`,
      );
    }
    lines.push("");
  }
  for (const item of videos) {
    lines.push(`**${item.label}**`, "");
    // `gh --attach` rewrites only a reference such as `![alt](./file)`; it appends an asset whose
    // bare path it doesn't recognize to the end of the description. So a video goes in as a
    // reference on its own line, and `publish` then turns the uploaded reference into a bare
    // asset URL, which GitHub renders as a player.
    if (item.before) lines.push("Before:", "", ref(item.before, `Before: ${item.label}`), "");
    if (item.after) lines.push("After:", "", ref(item.after, `After: ${item.label}`), "");
  }
  lines.push(END);
  return lines.join("\n");
};

const gh = (args, input) => execFileSync("gh", args, { cwd: root, encoding: "utf8", input });
// `--jq` ends its output with a newline. Writing that back would grow the description by a line on
// every publish, so bodies are read and written without trailing whitespace.
const readBody = () => gh(["pr", "view", flags.pr, "--json", "body", "--jq", ".body"]).trimEnd();

const publish = () => {
  if (!flags.pr) fail("publish needs --pr");
  const items = rows().map((row, index) => {
    const type = kind(row.before ?? row.after);
    const prepare = (file, side) => {
      if (!file) return null;
      if (!existsSync(join(root, file))) fail(`${file} from "${row.label}" no longer exists; run \`evidence clear\` and add again`);
      return type === "video" ? toMp4(file, index, side) : checkImage(file);
    };
    return { label: row.label, kind: type, before: prepare(row.before, "before"), after: prepare(row.after, "after") };
  });
  if (items.length === 0) fail(`nothing to publish; add pairs first (${relative(root, manifest)})`);
  const files = items.flatMap((item) => [item.before, item.after]).filter(Boolean);
  if (files.length > 50) fail(`gh attaches at most 50 files per edit; this run has ${files.length}`);

  const current = readBody();
  const ours = block(items);
  const start = current.indexOf(START);
  const end = current.indexOf(END);
  const body =
    start >= 0 && end > start
      ? `${current.slice(0, start)}${ours}${current.slice(end + END.length)}`
      : `${current}\n\n${ours}`;
  const bodyFile = join(flags.evidence, "pr", "body.md");
  mkdirSync(join(flags.evidence, "pr"), { recursive: true });
  writeFileSync(bodyFile, `${body.trimEnd()}\n`);
  if (flags["dry-run"]) {
    console.log(ours);
    console.log(`\ndry run: would attach ${files.length} files to PR ${flags.pr}; body in ${relative(root, bodyFile)}`);
    return;
  }

  gh(["pr", "edit", flags.pr, "--body-file", bodyFile, ...files.flatMap((file) => ["--attach", `./${file}`])]);

  // Read the body back: every local reference must now be an uploaded asset, and a video must be
  // a bare URL on its own line, which is the form GitHub plays inline.
  let published = readBody();
  const videoImages = /!\[[^\]]*\]\((https:\/\/github\.com\/user-attachments\/assets\/[^)\s]+)\)/g;
  const section = published.slice(published.indexOf(START), published.indexOf(END));
  const fixed = section.replace(videoImages, (match, url, offset) => {
    const line = section.slice(section.lastIndexOf("\n", offset) + 1, offset);
    return line.trim() === "" ? url : match;
  });
  if (fixed !== section) {
    published = published.replace(section, fixed);
    gh(["pr", "edit", flags.pr, "--body-file", "-"], `${published}\n`);
    published = readBody();
  }
  const left = published.match(/\.\/captures\/\S+/g) ?? [];
  if (left.length > 0) fail(`these references were not uploaded: ${left.join(", ")}`);
  console.log(gh(["pr", "view", flags.pr, "--json", "url", "--jq", ".url"]).trim());
};

// The manifest outlives `down`, and a run is named for its checkout, so a later PR from the same
// worktree starts from the last one's pairs until they're cleared. The captured files stay.
const clear = () => {
  rmSync(manifest, { force: true });
  console.log(`cleared ${relative(root, manifest)}`);
};

const command = positionals[0];
if (command === "add") add();
else if (command === "list") list();
else if (command === "publish") publish();
else if (command === "clear") clear();
else fail("usage: evidence <add|list|clear|publish>");
