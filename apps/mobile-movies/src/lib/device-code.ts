/**
 * The code's characters in groups, one box each. Codes such as `BCDF-GHJK` split at their
 * dashes; a code without one stays a single group.
 */
export const codeGroups = (userCode: string): ReadonlyArray<ReadonlyArray<string>> =>
  userCode
    .trim()
    .toUpperCase()
    .split("-")
    .filter((group) => group !== "")
    .map((group) => group.split(""));

/** What VoiceOver reads for a code: its characters one by one, such as `B C D F, G H J K`. */
export const spokenCode = (userCode: string): string =>
  codeGroups(userCode)
    .map((group) => group.join(" "))
    .join(", ");

const SECOND_MS = 1000;

/** `Expires in 4:52`, counting down to `Expires in 0:00`. */
export const expiresInLine = (expiresAt: number, now: number): string => {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / SECOND_MS));
  const minutes = Math.floor(seconds / 60);

  return `Expires in ${minutes}:${String(seconds % 60).padStart(2, "0")}`;
};

/** The approval page as people read it, such as `cinema.home/device`: no scheme, no query. */
export const approvalAddress = (verificationUrl: string): string =>
  verificationUrl.replace(/^https?:\/\//u, "").replace(/[?#].*$/u, "");

/** Characters in a device user code, such as `HD5R5GTL` without its dash. */
export const USER_CODE_LENGTH = 8;

/**
 * Device approval on the phone (H07 Approve a Device): the code's characters as typed, upper-cased
 * without spaces or the dash, and at most `USER_CODE_LENGTH` of them.
 */
export const codeLetters = (typed: string): string =>
  typed
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]/gu, "")
    .slice(0, USER_CODE_LENGTH);

/**
 * The code as the server shows it, `HD5R-5GTL`, when `text` holds exactly eight code characters
 * (spaces and the dash aside); null for fewer or more, so a longer code is never cut to another.
 */
export const formatUserCode = (text: string): string | null => {
  const clean = text.toUpperCase().replaceAll(/[^A-Z0-9]/gu, "");

  return clean.length === USER_CODE_LENGTH ? `${clean.slice(0, 4)}-${clean.slice(4)}` : null;
};

/**
 * The user code in a scanned QR code (H24 Scan Device Code): the `code` of a device approval link
 * such as `https://cinema.home/device?code=HD5R-5GTL`, or a bare code. Null for anything else.
 */
export const scannedUserCode = (data: string): string | null => {
  const text = data.trim();

  const link = /^[a-z][a-z\d+.-]*:\/\/[^?#]*\/device\/?\?(?:[^#]*&)?code=(?<code>[^&#]*)/iu.exec(
    text,
  );

  if (link !== null) {
    try {
      return formatUserCode(decodeURIComponent(link.groups?.code ?? ""));
    } catch {
      return null;
    }
  }

  return /^[a-z\d]{4}-?[a-z\d]{4}$/iu.test(text) ? formatUserCode(text) : null;
};
