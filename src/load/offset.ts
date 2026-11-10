/**
 * The input byte offset of a character index: the UTF-8 length of `text` before `index`, plus
 * `byteBase`, the number of bytes before `text` in the input (a byte order mark).
 */
export const byteOffset = (text: string, index: number, byteBase: number): number =>
  byteBase + new TextEncoder().encode(text.slice(0, index)).length;
