const box = document.getElementById('handoff');
const status = box.querySelector('.status');
const save = box.querySelector('button');
const key = location.hash.slice(1);
history.replaceState(null, '', location.pathname);

function fromBase64Url(s) {
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

/** Yields the length-prefixed frames of the response body. */
async function* frames(body) {
  const reader = body.getReader();
  const pieces = [];
  let size = 0;
  const take = n => {
    const out = new Uint8Array(n);
    for (let offset = 0; offset < n;) {
      const piece = pieces[0];
      const k = Math.min(piece.length, n - offset);
      out.set(piece.subarray(0, k), offset);
      offset += k;
      if (k === piece.length) pieces.shift();
      else pieces[0] = piece.subarray(k);
    }
    size -= n;
    return out;
  };
  let length;
  for (;;) {
    for (;;) {
      if (length === undefined && size >= 4) length = new DataView(take(4).buffer).getUint32(0);
      else if (length !== undefined && size >= length) {
        yield take(length);
        length = undefined;
      } else break;
    }
    const { done, value } = await reader.read();
    if (done) break;
    pieces.push(value);
    size += value.length;
  }
  if (size || length !== undefined) throw new Error('truncated');
}

// The chunk index in the IV and the flag on the last chunk stop reordering and truncation.
function chunkParams(index, last) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(8, index);
  return { name: 'AES-GCM', iv, additionalData: new Uint8Array([last ? 1 : 0]) };
}

// Fetching only on a tap keeps link previews, which may run this script, from using up the one fetch.
save.addEventListener('click', async () => {
  save.disabled = true;
  status.hidden = false;
  try {
    const res = await fetch(box.dataset.src, { method: 'POST', cache: 'no-store' });
    if (!res.ok) throw new Error('gone');
    const total = Number(res.headers.get('Content-Length')) || 0;
    const cryptoKey = await crypto.subtle.importKey('raw', fromBase64Url(key), 'AES-GCM', false, ['decrypt']);
    const parts = [];
    let pending;
    let index = 0;
    let received = 0;
    for await (const frame of frames(res.body)) {
      // A frame is the last one only when the stream ends after it, so it is decrypted one step late.
      if (pending) parts.push(new Blob([await crypto.subtle.decrypt(chunkParams(index++, false), cryptoKey, pending)]));
      pending = frame;
      received += frame.length + 4;
      if (total) status.textContent = `${box.dataset.loading} ${Math.round((received / total) * 100)} %`;
    }
    if (!pending) throw new Error('truncated');
    parts.push(new Blob([await crypto.subtle.decrypt(chunkParams(index, true), cryptoKey, pending)]));
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob(parts, { type: 'application/x-tar' }));
    link.download = box.dataset.filename;
    link.click();
    status.hidden = true;
  } catch (e) {
    status.textContent = e.message === 'gone' ? box.dataset.gone : box.dataset.failed;
    status.classList.add('error');
  }
});
