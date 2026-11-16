// A second click would redeem the invite a second time.
for (const form of document.querySelectorAll('form[method="post"]')) {
  const button = form.querySelector('button[type="submit"]');
  form.addEventListener('submit', () => {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  });
  // Going back to this page restores it from the cache with the button still disabled.
  addEventListener('pageshow', () => {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  });
}
