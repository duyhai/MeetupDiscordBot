/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unnecessary-type-assertion */
// Checked by `yarn tsc --noEmit -p .`: each @ts-expect-error fails the type
// check (as an unused directive) if the brands ever become forgeable.
import { SafeHtml, SafeUrl } from '../../src/web/html.js';

type HtmlModule = typeof import('../../src/web/html.js');
// @ts-expect-error the SafeHtml brand symbol stays module-private
type HtmlBrandKey = HtmlModule['htmlBrand'];
// @ts-expect-error the SafeUrl brand symbol stays module-private
type UrlBrandKey = HtmlModule['urlBrand'];

// @ts-expect-error a SafeHtml cannot be built from an object literal: the brand key is unexported
const forgedHtml: SafeHtml = { value: '<b>', toString: () => '<b>' };
// @ts-expect-error same for SafeUrl
const forgedUrl: SafeUrl = { href: 'javascript:1', toString: () => '' };
// @ts-expect-error SafeHtml is a type only: there is no constructor
const constructed = new SafeHtml('<b>');
// @ts-expect-error a SafeHtml is not a SafeUrl
const crossed: SafeUrl = null as unknown as SafeHtml;
