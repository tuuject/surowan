/**
 * Shared rough token estimate for model-facing text. ASCII costs a token per
 * four characters (rounded up over the whole string); every other character
 * costs one token per code point — a surrogate pair is one character, and a
 * lone surrogate still counts instead of throwing. The real numbers always come
 * from provider usage; this estimate only drives GC, the context stop threshold
 * and the tool-registry cap, which must not fall a quarter short on CJK text.
 */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) < 0x80) {
      ascii += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(ascii / 4) + other;
}
