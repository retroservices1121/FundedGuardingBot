import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { APP_PAGE_URLS, SUPPORT_CONTACT_LABEL } from '../src/lib/app-information';

const docs = new URL('../../docs/', import.meta.url);
const legal = new URL('../../public/legal/', import.meta.url);

it.each([
  [APP_PAGE_URLS.privacy, 'privacy', 'Privacy Policy'],
  [APP_PAGE_URLS.terms, 'terms', 'Terms of Use'],
])('links %s to the documented page', (url, slug, title) => {
  const readme = readFileSync(new URL('README.md', docs), 'utf8');
  const page = readFileSync(new URL(`${slug}.html`, legal), 'utf8');

  expect(readme.split(/\r?\n/).some(line => line.endsWith(`: ${url}`))).toBe(true);
  expect(url).toBe(`https://fundedguardian.xyz/${slug}`);
  expect(page).toContain(`<h1>${title}</h1>`);
});

it('uses the same X contact as the documentation', () => {
  expect(APP_PAGE_URLS.support).toBe('https://x.com/FundedGuardian');
  expect(SUPPORT_CONTACT_LABEL).toBe('DM us on X @FundedGuardian');
  const readme = readFileSync(new URL('README.md', docs), 'utf8');
  const supportPage = readFileSync(new URL('support.html', docs), 'utf8');

  expect(readme).toContain(`[${SUPPORT_CONTACT_LABEL}](${APP_PAGE_URLS.support})`);
  expect(supportPage).toContain(`<a href="${APP_PAGE_URLS.support}">${SUPPORT_CONTACT_LABEL}</a>`);
});
