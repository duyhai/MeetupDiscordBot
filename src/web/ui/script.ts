import { staticRaw } from '../html.js';

/**
 * The UI kit's one script: fixed text, no ids, no data. dashboardPage emits
 * it once per page, with the page nonce; a second copy does nothing
 * (window.__uiKit). Four parts:
 *
 * Copy (copyButton): a button[data-copy] copies a textarea. With a value,
 * the textarea of that literal id (the Hall of Fame posts); empty, the
 * textarea inside its [data-copy-box], found by position, so no id is ever
 * interpolated. With data-then-submit it submits its form only after the
 * copy succeeded (Copy warning, then status warning_copied), disabling the
 * button first; such a click never submits natively, and clicks while a
 * write is pending are ignored, so a double click sends once. With no
 * clipboard, or a refused write, it says to copy by hand and submits
 * nothing. Each button keeps its first label: closing its dialog puts it
 * back (and re-enables it) and voids a write still pending, so a dialog
 * closed (Esc) while the clipboard answers never submits afterwards: the
 * reset bumps the button's token and the continuation checks it.
 *
 * Modal (modal, confirmModal): each details[data-modal] is the no-JavaScript
 * form (the summary opens the panel in place). With <dialog> support, the
 * summary becomes a real button (same class, text and hover title,
 * aria-haspopup) and the dialog moves out to sit beside it; the details is
 * removed. The button opens the dialog with showModal (top layer: the page
 * never reflows). Esc or a [data-modal-close] button closes it; so does a
 * click on the backdrop, but only when the press began there and was
 * released there too (a text selection dragged out of the dialog, or a press
 * on the backdrop let go inside the box, does not count) and never for a
 * dialog holding a textarea (typed text is never lost to a stray click).
 * Closing puts focus back on the button. The dialog is labelled by its
 * [data-modal-title] heading through a numbered id this script assigns
 * (ui-modal-N-title), as ids are never taken from data.
 *
 * Nav accordion (accordionNav): in each [data-accordion], opening one
 * details[data-nav-group] closes the others, and Esc inside an open group
 * closes it and focuses its summary. Without JavaScript each group still
 * opens and closes on its own.
 *
 * Back/forward cache: a page restored after a copy-then-submit (pageshow
 * with persisted) closes its open dialogs and re-enables every copy button.
 */
// eslint-disable-next-line @stylistic/max-len -- one line, so the script text is exactly what runs
export const KIT_SCRIPT = staticRaw`(function(){if(window.__uiKit){return;}window.__uiKit=1;var resets=[];document.querySelectorAll('button[data-copy]').forEach(function(b){var busy=false,token=0,label=b.textContent;b._kitReset=function(){token+=1;busy=false;b.disabled=false;b.textContent=label;};resets.push(b._kitReset);b.addEventListener('click',function(e){var submit=b.hasAttribute('data-then-submit')?b.form:null;if(submit){e.preventDefault();}var id=b.getAttribute('data-copy');var box=id?null:b.closest('[data-copy-box]');var t=id?document.getElementById(id):box?box.querySelector('textarea'):null;if(busy||!t){return;}t.select();if(!navigator.clipboard){b.textContent='Select the text and copy it';return;}busy=true;var mine=token;navigator.clipboard.writeText(t.value).then(function(){if(mine!==token){return;}if(submit){b.disabled=true;submit.submit();}else{busy=false;b.textContent='Copied';}},function(){if(mine!==token){return;}busy=false;b.textContent='Select the text and copy it';});});});var n=0;document.querySelectorAll('details[data-modal]').forEach(function(d){var s=d.querySelector('summary'),g=d.querySelector('dialog'),h=g?g.querySelector('[data-modal-title]'):null,p=d.parentNode;if(!s||!g||!h||!p||typeof g.showModal!=='function'){return;}n+=1;h.id='ui-modal-'+n+'-title';g.setAttribute('aria-labelledby',h.id);var b=document.createElement('button');b.type='button';b.className=s.className;b.textContent=s.textContent.trim();b.setAttribute('aria-haspopup','dialog');if(s.title){b.title=s.title;}p.insertBefore(b,d);p.insertBefore(g,d);p.removeChild(d);var typed=!!g.querySelector('textarea'),downOnBackdrop=false,upOnBackdrop=false;b.addEventListener('click',function(){if(!g.open){g.showModal();}});g.addEventListener('close',function(){g.querySelectorAll('button[data-copy]').forEach(function(c){if(c._kitReset){c._kitReset();}});b.focus();});g.querySelectorAll('[data-modal-close]').forEach(function(c){c.addEventListener('click',function(){g.close();});});g.addEventListener('pointerdown',function(e){downOnBackdrop=e.target===g;upOnBackdrop=false;});g.addEventListener('pointerup',function(e){upOnBackdrop=e.target===g;});g.addEventListener('click',function(e){var close=!typed&&downOnBackdrop&&upOnBackdrop&&e.target===g;downOnBackdrop=false;upOnBackdrop=false;if(close){g.close();}});});document.querySelectorAll('[data-accordion]').forEach(function(a){var gs=a.querySelectorAll('details[data-nav-group]');gs.forEach(function(d){d.addEventListener('toggle',function(){if(!d.open){return;}gs.forEach(function(o){if(o!==d&&o.open){o.open=false;}});});d.addEventListener('keydown',function(e){if(e.key!=='Escape'||!d.open){return;}d.open=false;var s=d.querySelector('summary');if(s){s.focus();}});});});window.addEventListener('pageshow',function(e){if(!e.persisted){return;}document.querySelectorAll('dialog[open]').forEach(function(g){g.close();});resets.forEach(function(r){r();});});})();`;
