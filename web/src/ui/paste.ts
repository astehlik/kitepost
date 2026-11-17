const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** Names of copied files from `text/uri-list` or a text of file paths; undefined if the text is something else. */
function copiedNames(text: string, uriList: string): string[] | undefined {
  const lines = [uriList, text].find(s => s.trim())?.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')) ?? [];
  const names: string[] = [];
  for (const line of lines) {
    let path = line;
    if (/^file:\/\//i.test(line)) {
      try {
        path = decodeURIComponent(new URL(line).pathname);
      } catch {
        return undefined;
      }
    } else if (!/^(\/|[a-z]:\\)/i.test(line)) return undefined;
    const name = path.split(/[\\/]/).pop();
    if (!name) return undefined;
    names.push(name);
  }
  return names;
}

function withExtension(name: string, mime: string): string {
  const ext = IMAGE_EXT[mime];
  const dot = name.lastIndexOf('.');
  const current = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (!ext || current === ext || (ext === 'jpg' && current === 'jpeg')) return name;
  return `${dot > 0 ? name.slice(0, dot) : name}.${ext}`;
}

/**
 * The files to attach from a paste, or undefined to paste the text. Office apps put an image of copied
 * text on the clipboard too, so text wins unless it only lists the copied files. Browsers name an image
 * from the clipboard e.g. "image.png"; a file manager lists the real name next to it.
 */
export function pastedFiles(files: File[], text: string, uriList = ''): File[] | undefined {
  if (!files.length) return undefined;
  const names = copiedNames(text, uriList);
  if (text.trim() && !names) return undefined;
  if (files.length !== 1 || names?.length !== 1 || !/^image\.\w+$/i.test(files[0].name)) return files;
  const [f] = files;
  return [new File([f], withExtension(names[0], f.type), { type: f.type, lastModified: f.lastModified })];
}
