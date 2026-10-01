/* Packaging recovery: browser navigation for the existing slide articles. */
(() => {
  'use strict';
  const slides = [...document.querySelectorAll('.deck-slide')];
  if (!slides.length) return;
  const byId = id => document.getElementById(id);
  const status = byId('deck-status');
  let index = Math.max(0, slides.findIndex(slide => '#' + slide.id === location.hash));
  let all = false, notes = false;
  document.body.classList.add('deck-enhanced');
  function render(changeHash = true) {
    slides.forEach((slide, i) => { slide.hidden = !all && i !== index; });
    document.body.classList.toggle('show-slide-notes', notes);
    byId('prev-slide').disabled = index === 0;
    byId('next-slide').disabled = index === slides.length - 1;
    byId('all-slides').setAttribute('aria-pressed', String(all));
    byId('all-slides').textContent = all ? 'Show one slide' : 'Show all slides';
    byId('toggle-notes').setAttribute('aria-pressed', String(notes));
    byId('toggle-notes').textContent = notes ? 'Hide speaker notes' : 'Show speaker notes';
    status.textContent = all ? `All ${slides.length} slides shown.` : `Slide ${index + 1} of ${slides.length}: ${slides[index].querySelector('.slide-title').textContent.replace(/\s+/g, ' ').trim()}`;
    if (changeHash) { try { history.replaceState(null, '', '#' + slides[index].id); } catch (_) { /* file:// may restrict history */ } }
  }
  function go(delta) { index = Math.max(0, Math.min(slides.length - 1, index + delta)); render(); if (all) slides[index].scrollIntoView({block:'start'}); }
  byId('prev-slide').addEventListener('click', () => go(-1));
  byId('next-slide').addEventListener('click', () => go(1));
  byId('all-slides').addEventListener('click', () => { all = !all; render(); });
  byId('toggle-notes').addEventListener('click', () => { notes = !notes; render(); });
  byId('print-deck').addEventListener('click', () => window.print());
  byId('full-deck').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      else status.textContent = 'Full-screen mode is unavailable in this browser.';
    } catch (_) { status.textContent = 'Full-screen mode was not permitted. The presentation remains available in this window.'; }
  });
  document.addEventListener('keydown', event => {
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(event.target.tagName) || event.target.isContentEditable || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); go(1); }
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); go(-1); }
    if (event.key === 'Home') { event.preventDefault(); index = 0; render(); }
    if (event.key === 'End') { event.preventDefault(); index = slides.length - 1; render(); }
  });
  window.addEventListener('hashchange', () => { const next = slides.findIndex(s => '#' + s.id === location.hash); if (next >= 0) { index = next; render(false); } });
  render(false);
})();
