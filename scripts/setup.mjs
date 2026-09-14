import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const content = [
  `ADMIN_PASSWORD=${randomBytes(15).toString('base64url')}`,
  `SESSION_SECRET=${randomBytes(48).toString('base64url')}`,
  'PORT=3000',
  'HOST=127.0.0.1',
  'DATA_DIR=./data',
  'NODE_ENV=development',
  ''
].join('\n');

try {
  await writeFile(new URL('../.env', import.meta.url), content, { flag: 'wx', mode: 0o600 });
  console.log('Created .env. Your organizer password is the ADMIN_PASSWORD value in that file.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.env already exists; kept your current settings.');
}
