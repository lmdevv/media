/**
 * Copies text to the clipboard. Resolves whether it did: pages served over plain http (a LAN
 * address) have no clipboard at all, and a browser may refuse the write.
 */
export const copyText = async (text: string): Promise<boolean> => {
  // `navigator.clipboard` only exists in secure contexts; reading it elsewhere gives undefined.
  if (!window.isSecureContext) return false;

  try {
    await navigator.clipboard.writeText(text);

    return true;
  } catch {
    return false;
  }
};
