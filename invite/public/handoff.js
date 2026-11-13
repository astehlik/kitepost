const box = document.getElementById('handoff');
const status = box.querySelector('.status');
const save = box.querySelector('a');
const key = location.hash.slice(1);
history.replaceState(null, '', location.pathname);

function fromBase64Url(s) {
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

try {
  const res = await fetch(box.dataset.src, { cache: 'no-store' });
  if (!res.ok) throw new Error('gone');
  const data = new Uint8Array(await res.arrayBuffer());
  const cryptoKey = await crypto.subtle.importKey('raw', fromBase64Url(key), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, cryptoKey, data.slice(12));
  save.href = URL.createObjectURL(new Blob([plain], { type: 'application/x-tar' }));
  save.download = box.dataset.filename;
  save.hidden = false;
  status.hidden = true;
} catch (e) {
  status.textContent = e.message === 'gone' ? box.dataset.gone : box.dataset.failed;
  status.classList.add('error');
}
