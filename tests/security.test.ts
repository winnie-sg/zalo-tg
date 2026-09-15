import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';

const root = await mkdtemp(path.join(os.tmpdir(), 'zalo-tg-security-log-'));
process.env.LOG_DIR = root;
process.env.LOG_LEVEL = 'debug';

const { logger } = await import('../src/utils/logger.js');

test('logger separates levels into a dd-MM-yyyy daily folder', async () => {
  logger.debug('debug event');
  logger.info('info event');
  logger.warn('warn event');
  logger.error('error event');
  await logger.flush();

  const date = new Date();
  const folder = `${String(date.getDate()).padStart(2, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${date.getFullYear()}`;
  assert.deepEqual((await readdir(path.join(root, folder))).sort(), ['debug.log', 'error.log', 'info.log', 'warn.log']);
});

test('logger redacts sensitive data and records file metadata rather than contents', async () => {
  const localPath = path.join(root, 'media', 'photo.jpg');
  logger.info({ filePath: localPath, content: 'private file bytes', token: 'secret-token' });
  await logger.flush();

  const date = new Date();
  const folder = `${String(date.getDate()).padStart(2, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${date.getFullYear()}`;
  const output = await readFile(path.join(root, folder, 'info.log'), 'utf8');
  assert.match(output, /"filePath":/);
  assert.match(output, /photo\.jpg/);
  assert.doesNotMatch(output, /private file bytes|secret-token/);
  assert.match(output, /\[REDACTED\]/);
});

test('logger honors the configured minimum level', async () => {
  process.env.LOG_LEVEL = 'warn';
  logger.debug('do not write');
  logger.info('do not write');
  logger.warn('write this');
  await logger.flush();

  const date = new Date();
  const folder = `${String(date.getDate()).padStart(2, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${date.getFullYear()}`;
  const info = await readFile(path.join(root, folder, 'info.log'), 'utf8');
  const warn = await readFile(path.join(root, folder, 'warn.log'), 'utf8');
  assert.doesNotMatch(info, /do not write/);
  assert.match(warn, /write this/);
});
