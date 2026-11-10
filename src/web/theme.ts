import { SafeHtml, html, staticRaw } from './html.js';

/** The palettes the stylesheet defines; the first is the default (no attribute). */
export const PALETTES = [
  { id: 'night', label: 'Night market' },
  { id: 'paper', label: 'Paper & gold' },
  { id: 'potluck', label: 'Potluck' },
  { id: 'quiet', label: 'Quiet' },
] as const;

/**
 * The colour theme and palette for both sites (host and staff), run in
 * <head> so the first paint is already right. Theme: Auto (no choice saved)
 * leaves the page to the device's own light or dark setting
 * (prefers-color-scheme); Light and Dark set data-theme on <html>. Palette:
 * the Style picker sets data-palette on <html> (the default, Night market,
 * sets none). Both are kept in this browser (one choice for both sites);
 * other open tabs follow a change (a cleared storage counts as the
 * defaults). A choice made in this tab wins here even when it cannot be
 * saved. Without the script the controls stay hidden and the device decides.
 */
// eslint-disable-next-line @stylistic/max-len -- one line, so the script text is exactly what runs
export const THEME_SCRIPT = staticRaw`(function(){var KEY='dashboard-theme',PKEY='dashboard-palette',PALETTES=['night','paper','potluck','quiet'],mem=null,pmem=null,root=document.documentElement;function stored(){if(mem==='auto'){return null;}if(mem){return mem;}try{var v=localStorage.getItem(KEY);return v==='light'||v==='dark'?v:null;}catch(e){return null;}}function palette(){if(pmem){return pmem;}try{var v=localStorage.getItem(PKEY);return PALETTES.indexOf(v)>0?v:'night';}catch(e){return 'night';}}function save(c){mem=c;try{if(c==='auto'){localStorage.removeItem(KEY);}else{localStorage.setItem(KEY,c);}}catch(e){}}function savePalette(p){pmem=p;try{if(p==='night'){localStorage.removeItem(PKEY);}else{localStorage.setItem(PKEY,p);}}catch(e){}}function apply(){var c=stored();if(c){root.setAttribute('data-theme',c);}else{root.removeAttribute('data-theme');}var p=palette();if(p!=='night'){root.setAttribute('data-palette',p);}else{root.removeAttribute('data-palette');}}apply();function wire(){var g=document.querySelector('[data-theme-toggle]');var pick=document.querySelector('[data-palette-pick]');var buttons=g?Array.prototype.slice.call(g.querySelectorAll('button[data-choice]')):[];var sel=pick?pick.querySelector('select'):null;function sync(){var c=stored()||'auto';buttons.forEach(function(b){b.setAttribute('aria-pressed',String(b.getAttribute('data-choice')===c));});if(sel){sel.value=palette();}}if(g){g.hidden=false;}if(pick){pick.hidden=false;}sync();buttons.forEach(function(b){b.addEventListener('click',function(){save(b.getAttribute('data-choice'));apply();sync();});});if(sel){sel.addEventListener('change',function(){var v=sel.value;savePalette(PALETTES.indexOf(v)>=0?v:'night');apply();sync();});}window.addEventListener('storage',function(e){if(e.key===KEY||e.key===null){mem=null;}if(e.key===PKEY||e.key===null){pmem=null;}if(e.key===KEY||e.key===PKEY||e.key===null){apply();sync();}});}if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',wire);}else{wire();}})();`;

/**
 * The header's Auto / Light / Dark buttons and the Style picker: both
 * hidden until THEME_SCRIPT runs. The picker's options come from PALETTES;
 * the script's own copy of the ids is a literal (staticRaw takes none), so
 * theme.test.ts checks the two agree.
 */
export function themeToggle(): SafeHtml {
  const options = PALETTES.map(
    (p) => html`<option value="${p.id}">${p.label}</option>`,
  );
  return html`<div
      class="theme-toggle"
      role="group"
      aria-label="Colour theme"
      data-theme-toggle
      hidden
    >
      <button
        type="button"
        data-choice="auto"
        aria-pressed="false"
        title="Follow this device's light or dark setting"
      >
        Auto
      </button>
      <button type="button" data-choice="light" aria-pressed="false">
        Light
      </button>
      <button type="button" data-choice="dark" aria-pressed="false">
        Dark
      </button>
    </div>
    <label class="palette-pick" data-palette-pick hidden>
      <span>Style</span>
      <select autocomplete="off">
        ${options}
      </select>
    </label>`;
}
