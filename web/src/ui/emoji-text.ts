const SMILEYS: Record<string, string> = {
  ':)': '🙂', ':-)': '🙂', ':(': '🙁', ':-(': '🙁', ';)': '😉', ';-)': '😉',
  ':D': '😃', ':-D': '😃', 'xD': '😆', 'XD': '😆', ':P': '😛', ':-P': '😛', ':p': '😛', ':-p': '😛',
  ';P': '😜', ';p': '😜', ':O': '😮', ':-O': '😮', ':o': '😮', ':-o': '😮', ":'(": '😢',
  ':*': '😘', ':-*': '😘', ':|': '😐', ':-|': '😐', ':/': '😕', ':-/': '😕', '<3': '❤️', '</3': '💔',
};

const SMILEY = new RegExp(`(?:^|\\s)(${Object.keys(SMILEYS).sort((a, b) => b.length - a.length)
  .map(s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})$`);

/** The smiley that `text` ends with, as a word of its own, and where it starts. */
export function trailingSmiley(text: string): { from: number; emoji: string } | undefined {
  const m = SMILEY.exec(text);
  return m ? { from: text.length - m[1].length, emoji: SMILEYS[m[1]] } : undefined;
}

// After whitespace or an emoji, so that times (10:30) and URLs do not start a completion.
const COMPLETION = /(?:^|[\s\p{Extended_Pictographic}\u{FE0F}\u{20E3}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]):([\p{L}\p{N}_+-]{2,})$/u;

/** The `:query` that `text` ends with, for emoji suggestions. */
export function completionQuery(text: string): string | undefined {
  return COMPLETION.exec(text)?.[1];
}
