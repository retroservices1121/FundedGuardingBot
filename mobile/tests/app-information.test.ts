import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { APP_PAGE_URLS } from '../src/lib/app-information';

const docs = new URL('../../docs/', import.meta.url);

it.each([
  [APP_PAGE_URLS.privacy, 'privacy.html', 'Privacy Policy'],
  [APP_PAGE_URLS.terms, 'terms.html', 'Terms of Use'],
  [APP_PAGE_URLS.support, 'support.html', 'Support'],
])('links %s to the documented page', (url, filename, title) => {
  const readme = readFileSync(new URL('README.md', docs), 'utf8');
  const page = readFileSync(new URL(filename, docs), 'utf8');

  expect(readme.split(/\r?\n/).some(line => line.endsWith(`: ${url}`))).toBe(true);
  expect(new URL(url).pathname.split('/').pop()).toBe(filename);
  expect(page).toContain(`<h1>${title}</h1>`);
});
