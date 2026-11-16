const save = document.querySelector('.save');
const input = save.querySelector('input');
const copy = save.querySelector('[data-copy]');

copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(input.value);
    copy.textContent = copy.dataset.copied;
  } catch {
    input.select();
  }
});
save.querySelector('[data-print]').addEventListener('click', () => window.print());
