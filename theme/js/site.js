/* Packaging recovery: progressive enhancements for the existing HTML contract. */
(() => {
  'use strict';
  const es = document.documentElement.lang.startsWith('es');
  const catalog = document.querySelector('[data-catalog]');
  const search = document.querySelector('#asset-search');
  const filters = [...document.querySelectorAll('[data-filter]')];
  if (catalog) {
    const cards = [...catalog.querySelectorAll('[data-category]')];
    const status = document.querySelector('#result-count');
    const empty = document.querySelector('#empty-results');
    let active = 'all';
    const normalize = text => text.toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    function update() {
      const q = normalize(search?.value.trim() || '');
      let count = 0;
      cards.forEach(card => {
        const show = (active === 'all' || card.dataset.category === active) && normalize(card.textContent).includes(q);
        card.hidden = !show;
        if (show) count++;
      });
      filters.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === active)));
      if (status) status.textContent = `${count} / ${cards.length} ${status.dataset.noun || (es ? 'elementos visibles' : 'items shown')}`;
      if (empty) empty.hidden = count !== 0;
    }
    search?.addEventListener('input', update);
    filters.forEach(button => button.addEventListener('click', () => { active = button.dataset.filter; update(); }));
    update();
  }
  const live = document.createElement('p');
  live.className = 'sr-only'; live.setAttribute('role', 'status');
  document.body.append(live);
  async function copy(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); return; } catch (_) { /* use local fallback */ }
    }
    const previous = document.activeElement;
    const area = document.createElement('textarea');
    area.value = text; area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.append(area); area.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } finally { area.remove(); previous?.focus(); }
    if (!copied) throw new Error('Clipboard unavailable');
  }
  document.querySelectorAll('[data-copy],[data-copy-target]').forEach(button => {
    button.addEventListener('click', async () => {
      const text = button.hasAttribute('data-copy') ? button.dataset.copy : document.querySelector(button.dataset.copyTarget)?.textContent;
      if (text == null) return;
      try {
        await copy(text);
        live.textContent = es ? 'Texto copiado.' : 'Copied to clipboard.';
        const error = document.querySelector('#copy-error'); if (error) error.textContent = '';
      } catch (_) {
        const message = es ? 'No se pudo copiar. Selecciona el texto y cópialo manualmente.' : 'Clipboard unavailable. Select the visible text and copy it manually.';
        live.textContent = message;
        const error = document.querySelector('#copy-error'); if (error) error.textContent = message;
      }
    });
  });
  document.querySelectorAll('[data-local-checklist]').forEach(list => {
    const items = [...list.querySelectorAll('input[type=checkbox]')];
    const count = list.querySelector('[data-check-count]');
    const update = () => { if (count) count.textContent = `${items.filter(x => x.checked).length} / ${items.length} checked in this page. This is not an approval record; save your review separately.`; };
    items.forEach(item => item.addEventListener('change', update)); update();
  });
})();
