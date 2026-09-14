import { chromium, expect } from '@playwright/test';
import { mkdtemp, cp, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'reymil-rsvp-browser-'));
const artifacts = path.resolve('test-results');
await mkdir(artifacts, { recursive: true });
await cp(new URL('../data/guests.json', import.meta.url), path.join(dataDir, 'guests.json'));
await writeFile(path.join(dataDir, 'responses.json'), '[]\n');
const password = 'browser-test-organizer-password';
const app = await createApp({ dataDir, adminPassword: password, sessionSecret: 'browser-test-session-secret-longer-than-32-characters' });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseURL = 'http://127.0.0.1:' + server.address().port;
let browser;
const errors = [];
const capture = async (page, name) => page.screenshot({ path: path.join(artifacts, name + '.png'), fullPage: true });
const noOverflow = async (page) => {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page must not overflow the viewport');
};
const geometry = (page) => page.locator('#rsvp-panel').evaluate((element) => ({
  top: element.getBoundingClientRect().top, height: element.getBoundingClientRect().height,
  radius: getComputedStyle(element).borderTopLeftRadius
}));
const selectGuest = async (page, name) => {
  await page.locator('#rsvp-name').fill(name);
  await page.getByRole('option').filter({ hasText: name }).click();
  await expect(page.getByText('ADDITIONAL GUESTS ALLOWED', { exact: true })).toBeVisible();
};
try {
  const channel = process.env.PLAYWRIGHT_CHANNEL || (existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'chrome' : undefined);
  browser = await chromium.launch({ channel, headless: true });
  const organizer = await browser.newContext({ baseURL, viewport: { width: 1365, height: 900 } });
  const visitors = await browser.newContext({ baseURL, viewport: { width: 1365, height: 900 } });
  for (const context of [organizer, visitors]) context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  const admin = await organizer.newPage();
  await admin.goto('/Guests.html');
  await expect(admin.locator('#login')).toBeVisible();
  await capture(admin, 'login-desktop');
  await admin.locator('#password').fill(password);
  await admin.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(admin.locator('#rows tr')).toHaveCount(35);
  await expect(admin.locator('.tabs a[aria-current="page"]')).toHaveText('Guest list');
  await capture(admin, 'guests-desktop');

  const longName = 'Alexandria Test Guest With A Long Family Name For Responsive Layout Verification';
  await admin.getByRole('button', { name: 'Add guest', exact: true }).click();
  await admin.locator('#guest-name').fill(longName);
  await admin.locator('#guest-extra').fill('5');
  await admin.getByRole('button', { name: 'Save guest', exact: true }).click();
  await expect(admin.locator('#guest-dialog')).not.toBeVisible();
  await expect(admin.locator('#rows tr')).toHaveCount(36);
  let longRow = admin.locator('#rows tr').filter({ hasText: longName });
  const guestId = await longRow.getAttribute('data-id');
  await longRow.getByRole('button', { name: 'Edit ' + longName, exact: true }).click();
  await admin.locator('#guest-extra').fill('1');
  await admin.getByRole('button', { name: 'Save guest', exact: true }).click();
  await expect(admin.locator('#guest-dialog')).not.toBeVisible();
  await expect(longRow.locator('td').nth(1)).toHaveText('1');
  assert.equal(await longRow.getAttribute('data-id'), guestId);
  await admin.getByRole('button', { name: 'Add guest', exact: true }).click();
  await admin.locator('#guest-name').fill('raymond l. mape');
  await admin.getByRole('button', { name: 'Save guest', exact: true }).click();
  await expect(admin.locator('#guest-error')).toHaveText('A guest with that name already exists.');
  await admin.locator('#guest-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();

  const rsvp = await visitors.newPage();
  await rsvp.goto('/RSVP.html');
  await expect(rsvp.locator('#rsvp-name')).toBeEnabled({ timeout: 45000 });
  await expect(rsvp.getByText('We could not load the guest list.', { exact: false })).toHaveCount(0);
  await rsvp.evaluate(() => document.fonts.ready);
  const initial = await geometry(rsvp);
  await capture(rsvp, 'rsvp-desktop');
  await rsvp.locator('#rsvp-name').fill('John');
  await expect(rsvp.getByRole('option')).toHaveCount(4);
  const suggestions = await geometry(rsvp);
  assert.deepEqual(suggestions, initial, 'Suggestions should not resize the green panel');
  await capture(rsvp, 'rsvp-suggestions-desktop');
  await rsvp.locator('#rsvp-name').fill('Missing Example');
  await expect(rsvp.getByText('We can’t find that name', { exact: false })).toBeVisible();
  const warning = await geometry(rsvp);
  assert.equal(warning.top, initial.top);
  assert.equal(warning.radius, initial.radius);
  assert.ok(warning.height >= initial.height);
  await capture(rsvp, 'rsvp-warning-desktop');
  await noOverflow(rsvp);

  const stale = await visitors.newPage();
  await stale.goto('/RSVP.html');
  await expect(stale.locator('#rsvp-name')).toBeEnabled({ timeout: 45000 });
  await selectGuest(stale, 'Reynaldo L. Mape Jr.');
  await selectGuest(rsvp, 'Reynaldo L. Mape Jr.');
  for (let i = 0; i < 5; i++) await rsvp.locator('#extra-' + i).fill('Companion ' + (i + 1));
  await rsvp.route('**/api/responses', (route) => route.abort());
  await rsvp.getByRole('button', { name: 'CONFIRM OUR ATTENDANCE', exact: true }).click();
  await expect(rsvp.getByText('We could not confirm your RSVP.', { exact: false })).toBeVisible();
  for (let i = 0; i < 5; i++) await expect(rsvp.locator('#extra-' + i)).toHaveValue('Companion ' + (i + 1));
  await rsvp.unroute('**/api/responses');
  await rsvp.getByRole('button', { name: 'CONFIRM OUR ATTENDANCE', exact: true }).click();
  await expect(rsvp.getByText('Your response is in.', { exact: false })).toBeVisible();
  await capture(rsvp, 'rsvp-confirmation-desktop');
  await stale.getByRole('button', { name: 'CONFIRM OUR ATTENDANCE', exact: true }).click();
  await expect(stale.getByText('We already have a response', { exact: false })).toBeVisible();
  await expect(stale.getByRole('button', { name: 'CONFIRM OUR ATTENDANCE', exact: true })).toBeDisabled();
  await rsvp.getByRole('button', { name: 'Send another response', exact: true }).click();
  await rsvp.locator('#rsvp-name').fill('Reynaldo L. Mape Jr.');
  const disabledGuest = rsvp.getByRole('option').filter({ hasText: 'Reynaldo L. Mape Jr.' });
  await expect(disabledGuest).toHaveAttribute('aria-disabled', 'true');
  await disabledGuest.click({ force: true });
  await rsvp.locator('#rsvp-name').press('ArrowDown');
  await rsvp.locator('#rsvp-name').press('Enter');
  await expect(rsvp.locator('#rsvp-name')).toBeVisible();
  await expect(rsvp.getByRole('button', { name: 'CONFIRM OUR ATTENDANCE', exact: true })).toHaveCount(0);
  await capture(rsvp, 'rsvp-disabled-desktop');

  await admin.goto('/Responses.html');
  await expect(admin.locator('#rows tr')).toHaveCount(1);
  await expect(admin.locator('#rows')).toContainText('Companion 5');
  await expect(admin.locator('#summary')).toContainText('Attending headcount6');
  await capture(admin, 'responses-desktop');
  await admin.locator('#attendance').selectOption('no');
  await expect(admin.locator('#rows')).toHaveText('No matching results.');
  await admin.locator('#attendance').selectOption('all');
  await admin.getByRole('button', { name: 'Delete Reynaldo L. Mape Jr.', exact: true }).click();
  await admin.locator('#delete-dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(admin.locator('#delete-dialog')).not.toBeVisible();
  await expect(admin.locator('#rows')).toHaveText('No RSVP responses yet.');
  await rsvp.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(disabledGuest).toHaveAttribute('aria-disabled', 'false');
  await disabledGuest.click();
  await rsvp.getByRole('button', { name: 'Sorry, we can’t make it', exact: true }).click();
  await expect(rsvp.getByText('Thank you for letting us know.', { exact: false })).toBeVisible();

  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.goto('/Guests.html');
  await expect(admin.locator('#rows tr')).toHaveCount(36);
  await noOverflow(admin);
  const editBounds = await admin.locator('#rows tr').first().getByRole('button', { name: /^Edit / }).boundingBox();
  assert.ok(editBounds.x >= 0 && editBounds.x + editBounds.width <= 390, 'Guest actions fit on mobile');
  await capture(admin, 'guests-mobile');
  longRow = admin.locator('#rows tr').filter({ hasText: longName });
  await longRow.getByRole('button', { name: 'Delete ' + longName, exact: true }).click();
  await admin.locator('#delete-dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(admin.locator('#delete-dialog')).not.toBeVisible();
  await expect(admin.locator('#rows tr')).toHaveCount(35);
  await admin.goto('/Responses.html');
  await expect(admin.locator('#rows')).toContainText('Not attending');
  await noOverflow(admin);
  const deleteBounds = await admin.locator('#rows').getByRole('button', { name: /^Delete / }).boundingBox();
  assert.ok(deleteBounds.x >= 0 && deleteBounds.x + deleteBounds.width <= 390, 'Response actions fit on mobile');
  await capture(admin, 'responses-mobile');

  await rsvp.setViewportSize({ width: 390, height: 844 });
  await rsvp.goto('/RSVP.html');
  await expect(rsvp.locator('#rsvp-name')).toBeEnabled({ timeout: 45000 });
  await rsvp.evaluate(() => document.fonts.ready);
  const mobile = await geometry(rsvp);
  await rsvp.locator('#rsvp-name').fill('Legaspi');
  await expect(rsvp.getByRole('option')).toHaveCount(7);
  assert.deepEqual(await geometry(rsvp), mobile);
  await capture(rsvp, 'rsvp-suggestions-mobile');
  await rsvp.locator('#rsvp-name').fill('Missing Example');
  await expect(rsvp.getByText('We can’t find that name', { exact: false })).toBeVisible();
  const mobileWarning = await geometry(rsvp);
  assert.equal(mobileWarning.radius, mobile.radius);
  assert.equal(mobileWarning.top, mobile.top);
  await capture(rsvp, 'rsvp-warning-mobile');
  await selectGuest(rsvp, 'Engr. Teofilo Florentin or Merlyn Florentin');
  await noOverflow(rsvp);
  await capture(rsvp, 'rsvp-long-name-mobile');
  const assetChecks = await rsvp.evaluate(() => [...document.images].filter((image) => image.src.includes('/assets/')).every((image) => image.complete && image.naturalWidth > 0));
  assert.ok(assetChecks, 'RSVP artwork must load');
  await admin.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(admin.locator('#login')).toBeVisible();
  await admin.reload();
  await expect(admin.locator('#login')).toBeVisible();
  assert.deepEqual(errors, [], 'No browser JavaScript errors');
  console.log('Browser checks passed: management, RSVP, duplicate lock, deletion/unlock, save failure, desktop/mobile layout.');
  console.log('Screenshots: ' + artifacts);
} catch (error) {
  if (browser) {
    for (const [i, context] of browser.contexts().entries()) {
      for (const [j, page] of context.pages().entries()) await capture(page, 'failure-' + i + '-' + j).catch(() => {});
    }
  }
  console.error('Browser errors:', errors);
  throw error;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(path.dirname(dataDir), os.tmpdir());
  assert.ok(path.basename(dataDir).startsWith('reymil-rsvp-browser-'));
  await rm(dataDir, { recursive: true, force: true });
}
