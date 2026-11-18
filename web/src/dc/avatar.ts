/** Core sends at most 60 KB; more is not an avatar. */
const MAX_AVATAR_BYTES = 256 * 1024;

const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };

/** The image type by the file's own signature, so that a sender cannot smuggle in e.g. SVG. */
export function imageMime(bytes: Uint8Array): string | undefined {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return undefined;
}

export function avatarDataUrl(b64: string): string | undefined {
  const clean = b64.replace(/\s+/g, '');
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(clean), c => c.charCodeAt(0));
  } catch {
    return undefined;
  }
  if (!bytes.length || bytes.length > MAX_AVATAR_BYTES) return undefined;
  const mime = imageMime(bytes);
  return mime && `data:${mime};base64,${clean}`;
}

export function avatarBase64(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

export function avatarExtension(dataUrl: string): string {
  return EXTENSIONS[dataUrl.slice(5, dataUrl.indexOf(';'))] ?? 'jpg';
}

/** Like core's avatar_action_from_header(): `null` removes the avatar, `undefined` is no usable header. */
export function parseAvatarHeader(value: string): string | null | undefined {
  if (value.trim() === '0') return null;
  const v = value.replace(/\s+/g, '');
  return v.startsWith('base64:') ? avatarDataUrl(v.slice('base64:'.length)) : undefined;
}

/** Like core's Chat-User-Avatar: the spaces let the header be folded. */
export function avatarHeader(dataUrl: string | undefined): string {
  if (!dataUrl) return '0';
  return `base64:${(avatarBase64(dataUrl).match(/.{1,76}/g) ?? []).join(' ')}`;
}
