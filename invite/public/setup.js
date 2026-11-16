// Decrypts the login code with the key from the URL fragment, which never reaches the server.
const box = document.getElementById('setup');
const fromBase64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

try {
  const sealed = fromBase64(box.dataset.sealed);
  const key = await crypto.subtle.importKey('raw', fromBase64(location.hash.slice(1)), 'AES-GCM', false, ['decrypt']);
  const login = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(0, 12) }, key, sealed.slice(12)));
  box.querySelector('[data-web]').href = `${box.dataset.app}#login=${encodeURIComponent(login)}`;
  box.querySelector('[data-app]').href = login;
  box.querySelector('.status').hidden = true;
  box.querySelector('.ready').hidden = false;
} catch {
  box.querySelector('.status').textContent = box.dataset.failed;
}
