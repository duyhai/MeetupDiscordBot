import { staticRaw } from '../html.js';

/**
 * The calendar's day popovers. Each day is a <details> that already opens
 * with a click, a tap, Enter or Space; this adds, when it runs:
 *   - mouse hover opens a day, and leaving it closes it again; a click
 *     toggles it as usual (so one click closes a day opened by hover);
 *   - one day open at a time;
 *   - Escape closes it (focus goes back to its summary if it was inside);
 *   - a press outside it, or focus moving out of it, closes it;
 *   - the panel is placed next to its day, fixed and inside the viewport,
 *     so the calendar's scroll box never clips it; it closes once its day
 *     scrolls out of view, rather than floating over other content.
 * Without it, a panel opens inline inside its cell.
 */
// eslint-disable-next-line @stylistic/max-len -- one line, so the script text is exactly what runs
export const CALENDAR_SCRIPT = staticRaw`(function(){var grid=document.querySelector('table.cal-grid');if(!grid){return;}grid.classList.add('cal-js');var box=grid.closest('.table-scroll')||grid;var pops=Array.prototype.slice.call(grid.querySelectorAll('details.cal-pop'));function place(d){var s=d.querySelector('summary'),p=d.querySelector('.cal-panel');if(!s||!p){return;}var r=s.getBoundingClientRect(),b=box.getBoundingClientRect(),vw=document.documentElement.clientWidth,vh=window.innerHeight;if(r.bottom<Math.max(0,b.top)||r.top>Math.min(vh,b.bottom)||r.right<Math.max(0,b.left)||r.left>Math.min(vw,b.right)){d.open=false;return;}var w=p.offsetWidth,h=p.offsetHeight;var left=Math.max(16,Math.min(r.left,vw-w-16));var top=r.bottom+4;if(top+h>vh-8&&r.top-h-4>8){top=r.top-h-4;}p.style.left=left+'px';p.style.top=Math.max(8,top)+'px';}function closeAll(except){pops.forEach(function(d){if(d!==except&&d.open){d.open=false;}});}pops.forEach(function(d){var s=d.querySelector('summary');var hovered=false,timer=null;d.addEventListener('toggle',function(){if(d.open){closeAll(d);place(d);}else{hovered=false;}});d.addEventListener('pointerenter',function(e){if(e.pointerType!=='mouse'){return;}clearTimeout(timer);if(!d.open){hovered=true;closeAll(d);d.open=true;place(d);}});d.addEventListener('pointerleave',function(e){if(e.pointerType!=='mouse'||!hovered){return;}clearTimeout(timer);timer=setTimeout(function(){if(hovered){d.open=false;}},250);});d.addEventListener('focusout',function(e){if(d.open&&e.relatedTarget&&!d.contains(e.relatedTarget)){d.open=false;}});});document.addEventListener('keydown',function(e){if(e.key!=='Escape'){return;}pops.forEach(function(d){if(d.open){var inside=d.contains(document.activeElement);d.open=false;var s=d.querySelector('summary');if(inside&&s){s.focus();}}});});document.addEventListener('pointerdown',function(e){var inside=pops.some(function(d){return d.open&&d.contains(e.target);});if(!inside){closeAll(null);}});var frame=0;function replace(){if(frame){return;}frame=requestAnimationFrame(function(){frame=0;pops.forEach(function(d){if(d.open){place(d);}});});}window.addEventListener('resize',replace);window.addEventListener('scroll',replace,true);})();`;

/**
 * The history heat map's tooltips. Each day with events is already a link
 * to the day filter, labelled with its events; this shows the same lines
 * in a tooltip, and removes the native SVG titles so only one shows:
 *   - mouse: on hover;
 *   - keyboard: on focus (Enter follows the link);
 *   - touch: the first tap shows it, the next tap on that day follows it.
 * Escape, leaving or a tap elsewhere hides it; scrolling moves it along.
 */
// eslint-disable-next-line @stylistic/max-len -- one line, so the script text is exactly what runs
export const HISTORY_SCRIPT = staticRaw`(function(){var svg=document.querySelector('svg.heat');if(!svg){return;}var links=Array.prototype.slice.call(svg.querySelectorAll('a.hm-link'));if(!links.length){return;}var tip=document.createElement('div');tip.className='hm-tip';tip.setAttribute('role','tooltip');tip.hidden=true;document.body.appendChild(tip);var shownFor=null,shownTouch=false,lastPointer='mouse';function show(a,touch){shownTouch=touch;var lines=(a.getAttribute('data-tip')||'').split('\\n');if(touch){lines.push('Tap again to list them below');}tip.textContent='';lines.forEach(function(text,i){var line=document.createElement(i===0?'strong':'span');line.textContent=text;tip.appendChild(line);});tip.hidden=false;var r=a.getBoundingClientRect(),vw=document.documentElement.clientWidth,w=tip.offsetWidth,h=tip.offsetHeight;var left=Math.max(8,Math.min(r.left+r.width/2-w/2,vw-w-8));var top=r.top-h-6;if(top<8){top=r.bottom+6;}tip.style.left=left+'px';tip.style.top=top+'px';shownFor=a;}function hide(){tip.hidden=true;shownFor=null;}links.forEach(function(a){Array.prototype.slice.call(a.querySelectorAll('title')).forEach(function(t){t.parentNode.removeChild(t);});a.addEventListener('pointerenter',function(e){if(e.pointerType==='mouse'){show(a,false);}});a.addEventListener('pointerleave',function(e){if(e.pointerType==='mouse'&&shownFor===a){hide();}});a.addEventListener('focus',function(){if(lastPointer!=='touch'){show(a,false);}});a.addEventListener('blur',function(){if(shownFor===a){hide();}});a.addEventListener('click',function(e){if(e.detail!==0&&lastPointer==='touch'&&shownFor!==a){e.preventDefault();show(a,true);}});});document.addEventListener('keydown',function(e){if(e.key==='Escape'){hide();}});document.addEventListener('pointerdown',function(e){lastPointer=e.pointerType;if(shownFor&&!shownFor.contains(e.target)){hide();}},true);document.addEventListener('keydown',function(e){if(e.key==='Tab'){lastPointer='keyboard';}},true);window.addEventListener('scroll',function(){if(shownFor){show(shownFor,shownTouch);}},true);})();`;

/**
 * The colour theme, run in <head> so the first paint is already right.
 * With no choice saved, it follows the time of day in the viewer's own
 * clock (light from 7:00 to 19:00, dark otherwise) and re-checks every five
 * minutes. The header's Auto / Light / Dark buttons (hidden until this
 * runs) save a choice in this browser, or clear it; other open tabs follow.
 * Without the script the
 * page follows the system's light or dark setting, as before.
 */
// eslint-disable-next-line @stylistic/max-len -- one line, so the script text is exactly what runs
export const THEME_SCRIPT = staticRaw`(function(){var KEY='host-theme',mem=null,root=document.documentElement;function stored(){if(mem){return mem;}try{var v=localStorage.getItem(KEY);return v==='light'||v==='dark'?v:null;}catch(e){return null;}}function save(c){mem=c==='auto'?null:c;try{if(c==='auto'){localStorage.removeItem(KEY);}else{localStorage.setItem(KEY,c);}}catch(e){}}function byTime(){var h=new Date().getHours();return h>=7&&h<19?'light':'dark';}function apply(){root.setAttribute('data-theme',stored()||byTime());}apply();setInterval(function(){if(!stored()){apply();}},300000);function wire(){var g=document.querySelector('[data-theme-toggle]');if(!g){return;}g.hidden=false;var buttons=Array.prototype.slice.call(g.querySelectorAll('button[data-choice]'));function sync(){var c=stored()||'auto';buttons.forEach(function(b){b.setAttribute('aria-pressed',String(b.getAttribute('data-choice')===c));});}sync();buttons.forEach(function(b){b.addEventListener('click',function(){save(b.getAttribute('data-choice'));apply();sync();});});window.addEventListener('storage',function(e){if(e.key===KEY){mem=null;apply();sync();}});}if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',wire);}else{wire();}})();`;
