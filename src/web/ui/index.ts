/**
 * The in-repo UI kit, shared by the staff dashboard and the host site:
 * server-rendered SafeHtml helpers on the one stylesheet's tokens (pages.ts
 * STYLE, the "UI kit" block), and one fixed script (KIT_SCRIPT). No
 * framework, no external library, nothing the CSP has to admit.
 */
export { COPY_ICON, MEETUP_MARK } from './icons.js';
export type { ButtonTone, ModalTrigger } from './modal.js';
export { confirmModal, modal } from './modal.js';
export { copyBox, copyButton, copyText } from './copy.js';
export { collapsible } from './collapsible.js';
export { linkButton } from './linkButton.js';
export type { NavEntry, NavGroup, NavLink } from './nav.js';
export { accordionNav } from './nav.js';
export { KIT_SCRIPT } from './script.js';
