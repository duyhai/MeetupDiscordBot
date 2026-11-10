import { SafeHtml, html, staticRaw } from './html.js';

/**
 * The colour theme for both sites (host and staff), run in <head> so the
 * first paint is already right. Auto (no choice saved) leaves the page to
 * the device's own light or dark setting (prefers-color-scheme). Light and
 * Dark set data-theme on <html>, which the stylesheet's tokens follow, and
 * are kept in this browser (one choice for both sites); other open tabs
 * follow a change (a cleared storage counts as Auto). A choice made in this
 * tab wins here even when it cannot be saved, Auto included. Without the script the toggle stays hidden and the device decides.
 */
// eslint-disable-next-line @stylistic/max-len -- one line, so the script text is exactly what runs
export const THEME_SCRIPT = staticRaw`(function(){var KEY='dashboard-theme',mem=null,root=document.documentElement;function stored(){if(mem==='auto'){return null;}if(mem){return mem;}try{var v=localStorage.getItem(KEY);return v==='light'||v==='dark'?v:null;}catch(e){return null;}}function save(c){mem=c;try{if(c==='auto'){localStorage.removeItem(KEY);}else{localStorage.setItem(KEY,c);}}catch(e){}}function apply(){var c=stored();if(c){root.setAttribute('data-theme',c);}else{root.removeAttribute('data-theme');}}apply();function wire(){var g=document.querySelector('[data-theme-toggle]');if(!g){return;}g.hidden=false;var buttons=Array.prototype.slice.call(g.querySelectorAll('button[data-choice]'));function sync(){var c=stored()||'auto';buttons.forEach(function(b){b.setAttribute('aria-pressed',String(b.getAttribute('data-choice')===c));});}sync();buttons.forEach(function(b){b.addEventListener('click',function(){save(b.getAttribute('data-choice'));apply();sync();});});window.addEventListener('storage',function(e){if(e.key===KEY||e.key===null){mem=null;apply();sync();}});}if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',wire);}else{wire();}})();`;

/** The header's Auto / Light / Dark buttons: hidden until THEME_SCRIPT runs. */
export function themeToggle(): SafeHtml {
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
    <button type="button" data-choice="dark" aria-pressed="false">Dark</button>
  </div>`;
}
