/**
 * Replacements for browser APIs that exist only in secure contexts (HTTPS or localhost). The
 * supported remote access is plain HTTP over a tailnet, where `crypto.randomUUID` and
 * `navigator.clipboard` are undefined, so the web app must not depend on them.
 */

/** A random RFC 4122 version 4 UUID, built on `crypto.getRandomValues`, which works over HTTP. */
export const randomUuid = (): string => {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  // RFC 4122 variant: the top two bits of the clock sequence are 10.
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

class CopyFailed extends Error {
  override readonly name = "CopyFailed";
}

/**
 * Copies `text` to the clipboard. Uses the Clipboard API in secure contexts and a selected,
 * off-screen text field otherwise.
 */
export const copyText = async (text: string): Promise<void> => {
  if (window.isSecureContext) {
    await navigator.clipboard.writeText(text);

    return;
  }

  const field = document.createElement("textarea");

  field.value = text;
  field.readOnly = true;
  field.setAttribute("aria-hidden", "true");
  field.style.position = "fixed";
  field.style.inset = "0";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();

  // The only copy path browsers offer outside secure contexts.
  const copied = document.execCommand("copy");

  field.remove();

  if (!copied) throw new CopyFailed("Couldn’t copy to the clipboard.");
};
