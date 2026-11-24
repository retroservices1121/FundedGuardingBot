import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { APP_PAGE_URLS } from '../src/lib/app-information';

const docs = new URL('../../docs/', import.meta.url);
const legal = new URL('../../public/legal/', import.meta.url);

it.each([
  [APP_PAGE_URLS.privacy, 'privacy', 'Privacy Policy'],
  [APP_PAGE_URLS.terms, 'terms', 'Terms of Use'],
  [APP_PAGE_URLS.support, 'support', 'Support'],
])('links %s to the documented page', (url, slug, title) => {
  const readme = readFileSync(new URL('README.md', docs), 'utf8');
  const page = readFileSync(new URL(`${slug}.html`, legal), 'utf8');

  expect(readme.split(/\r?\n/).some(line => line.endsWith(`: ${url}`))).toBe(true);
  expect(url).toBe(`https://fundedguardian.xyz/${slug}`);
  expect(page).toContain(`<h1>${title}</h1>`);
});
