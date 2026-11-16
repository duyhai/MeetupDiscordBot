import { staticRaw } from '../html.js';

/**
 * The UI kit's one script: fixed text, no ids, no data. dashboardPage emits
 * it once per page, with the page nonce. Two parts:
 *
 * Copy (copyButton): a button[data-copy] copies a textarea. With a value,
 * the textarea of that literal id (the Hall of Fame posts); empty, the
 * textarea inside its [data-copy-box], found by position, so no id is ever
 * interpolated. With data-then-submit it submits its form only after the
 * copy succeeded (Copy warning, then status warning_copied), disabling the
 * button first; such a click never submits natively, and clicks while a
 * write is pending are ignored, so a double click sends once. With no
 * clipboard, or a refused write, it says to copy by hand and submits
 * nothing.
 *
 * Modal (modal, confirmModal): each details[data-modal] is the no-JavaScript
 * form (the summary opens the panel in place). With <dialog> support, the
 * summary becomes a real button (same class and text, aria-haspopup) and the
 * dialog moves out to sit beside it; the details is removed. The button
 * opens the dialog with showModal (top layer: the page never reflows); Esc,
 * a [data-modal-close] button or a click on the backdrop closes it, and
 * closing puts focus back on the button. The dialog is labelled by its
 * [data-modal-title] heading through a numbered id this script assigns
 * (ui-modal-N-title), as ids are never taken from data.
 */
// eslint-disable-next-line @stylistic/max-len -- one line, so the script text is exactly what runs
export const KIT_SCRIPT = staticRaw`(function(){document.querySelectorAll('button[data-copy]').forEach(function(b){var busy=false;b.addEventListener('click',function(e){var submit=b.hasAttribute('data-then-submit')?b.form:null;if(submit){e.preventDefault();}var id=b.getAttribute('data-copy');var box=id?null:b.closest('[data-copy-box]');var t=id?document.getElementById(id):box?box.querySelector('textarea'):null;if(busy||!t){return;}t.select();if(!navigator.clipboard){b.textContent='Select the text and copy it';return;}busy=true;navigator.clipboard.writeText(t.value).then(function(){if(submit){b.disabled=true;submit.submit();}else{busy=false;b.textContent='Copied';}},function(){busy=false;b.textContent='Select the text and copy it';});});});var n=0;document.querySelectorAll('details[data-modal]').forEach(function(d){var s=d.querySelector('summary'),g=d.querySelector('dialog'),h=g?g.querySelector('[data-modal-title]'):null,p=d.parentNode;if(!s||!g||!h||!p||typeof g.showModal!=='function'){return;}n+=1;h.id='ui-modal-'+n+'-title';g.setAttribute('aria-labelledby',h.id);var b=document.createElement('button');b.type='button';b.className=s.className;b.textContent=s.textContent.trim();b.setAttribute('aria-haspopup','dialog');p.insertBefore(b,d);p.insertBefore(g,d);p.removeChild(d);b.addEventListener('click',function(){if(!g.open){g.showModal();}});g.addEventListener('close',function(){b.focus();});g.querySelectorAll('[data-modal-close]').forEach(function(c){c.addEventListener('click',function(){g.close();});});g.addEventListener('click',function(e){if(e.target===g){g.close();}});});})();`;
