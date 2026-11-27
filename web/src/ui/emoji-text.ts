// After whitespace or an emoji, so that times (10:30) and URLs do not start a completion.
const COMPLETION = /(?:^|[\s\p{Extended_Pictographic}\u{FE0F}\u{20E3}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]):([\p{L}\p{N}_+-]{2,})$/u;

/** The `:query` that `text` ends with, for emoji suggestions. */
export function completionQuery(text: string): string | undefined {
  return COMPLETION.exec(text)?.[1];
}
