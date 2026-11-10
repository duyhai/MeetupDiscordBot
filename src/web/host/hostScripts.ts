import { staticRaw } from '../html.js';

/**
 * The calendar's day popovers. Each day is a <details> that already opens
 * with a click, a tap, Enter or Space; this adds, when it runs:
 *   - mouse hover opens a day (a click on a hovered day keeps it open);
 *   - one day open at a time;
 *   - Escape closes it and returns focus to its summary;
 *   - a click or tap outside closes it;
 *   - the panel is placed next to its day, fixed and inside the viewport,
 *     so the calendar's scroll box never clips it.
 * Without it, a panel opens inline inside its cell.
 */
// eslint-disable-next-line @stylistic/max-len -- one line, so the script text is exactly what runs
export const CALENDAR_SCRIPT = staticRaw`(function(){var grid=document.querySelector('table.cal-grid');if(!grid){return;}grid.classList.add('cal-js');var pops=Array.prototype.slice.call(grid.querySelectorAll('details.cal-pop'));function place(d){var s=d.querySelector('summary'),p=d.querySelector('.cal-panel');if(!s||!p){return;}var r=s.getBoundingClientRect(),vw=document.documentElement.clientWidth,vh=window.innerHeight,w=p.offsetWidth,h=p.offsetHeight;var left=Math.max(16,Math.min(r.left,vw-w-16));var top=r.bottom+4;if(top+h>vh-8&&r.top-h-4>8){top=r.top-h-4;}p.style.left=left+'px';p.style.top=Math.max(8,top)+'px';}function closeAll(except){pops.forEach(function(d){if(d!==except&&d.open){d.open=false;}});}pops.forEach(function(d){var s=d.querySelector('summary');var hovered=false,timer=null;d.addEventListener('toggle',function(){if(d.open){closeAll(d);place(d);}else{hovered=false;}});s.addEventListener('click',function(e){if(d.open&&hovered){e.preventDefault();hovered=false;}});d.addEventListener('pointerenter',function(e){if(e.pointerType!=='mouse'){return;}clearTimeout(timer);if(!d.open){hovered=true;d.open=true;}});d.addEventListener('pointerleave',function(e){if(e.pointerType!=='mouse'||!hovered){return;}clearTimeout(timer);timer=setTimeout(function(){if(hovered){d.open=false;}},250);});});document.addEventListener('keydown',function(e){if(e.key!=='Escape'){return;}pops.forEach(function(d){if(d.open){d.open=false;var s=d.querySelector('summary');if(s){s.focus();}}});});document.addEventListener('click',function(e){var inside=pops.some(function(d){return d.open&&d.contains(e.target);});if(!inside){closeAll(null);}});function replace(){pops.forEach(function(d){if(d.open){place(d);}});}window.addEventListener('resize',replace);window.addEventListener('scroll',replace,true);})();`;

/**
 * The history heat map's tooltips. Each day with events is already a link
 * to the day filter, labelled with its events; this shows the same lines
 * in a tooltip, and removes the native SVG titles so only one shows:
 *   - mouse: on hover;
 *   - keyboard: on focus (Enter follows the link);
 *   - touch: the first tap shows it, the next tap on that day follows it.
 * Escape, scrolling or leaving hides it.
 */
// eslint-disable-next-line @stylistic/max-len -- one line, so the script text is exactly what runs
export const HISTORY_SCRIPT = staticRaw`(function(){var svg=document.querySelector('svg.heat');if(!svg){return;}var links=Array.prototype.slice.call(svg.querySelectorAll('a.hm-link'));if(!links.length){return;}var tip=document.createElement('div');tip.className='hm-tip';tip.setAttribute('role','tooltip');tip.hidden=true;document.body.appendChild(tip);var shownFor=null,lastPointer='mouse';function show(a,touch){var lines=(a.getAttribute('data-tip')||'').split('\\n');if(touch){lines.push('Tap again to list them below');}tip.textContent='';lines.forEach(function(text,i){var line=document.createElement(i===0?'strong':'span');line.textContent=text;tip.appendChild(line);});tip.hidden=false;var r=a.getBoundingClientRect(),vw=document.documentElement.clientWidth,w=tip.offsetWidth,h=tip.offsetHeight;var left=Math.max(8,Math.min(r.left+r.width/2-w/2,vw-w-8));var top=r.top-h-6;if(top<8){top=r.bottom+6;}tip.style.left=left+'px';tip.style.top=top+'px';shownFor=a;}function hide(){tip.hidden=true;shownFor=null;}links.forEach(function(a){Array.prototype.slice.call(a.querySelectorAll('title')).forEach(function(t){t.parentNode.removeChild(t);});a.addEventListener('pointerdown',function(e){lastPointer=e.pointerType;});a.addEventListener('pointerenter',function(e){if(e.pointerType==='mouse'){show(a,false);}});a.addEventListener('pointerleave',function(e){if(e.pointerType==='mouse'&&shownFor===a){hide();}});a.addEventListener('focus',function(){if(lastPointer!=='touch'){show(a,false);}});a.addEventListener('blur',function(){if(shownFor===a){hide();}});a.addEventListener('click',function(e){if(lastPointer==='touch'&&shownFor!==a){e.preventDefault();show(a,true);}});});document.addEventListener('keydown',function(e){if(e.key==='Escape'){hide();}});document.addEventListener('pointerdown',function(e){if(shownFor&&!shownFor.contains(e.target)){hide();}});window.addEventListener('scroll',hide,true);})();`;
