import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { resolveTelegramFileLink } = await import('../src/telegram/fileLink.js');

test('resolveTelegramFileLink keeps official Bot API mode on HTTPS getFileLink', async () => {
  let getFileCalled = false;
  const expected = new URL('https://api.telegram.org/file/botTOKEN/photos/file_1.jpg');
  const telegram = {
    async getFile(_fileId: string) {
      getFileCalled = true;
      return { file_path: '/tmp/should-not-be-used.jpg' };
    },
    async getFileLink(_fileId: string) {
      return expected;
    },
  };

  const result = await resolveTelegramFileLink(telegram, 'abc', null);
  assert.equal(result.toString(), expected.toString());
  assert.equal(getFileCalled, false);
});

test('resolveTelegramFileLink converts Local Bot API absolute file_path to a hostless file URL', async () => {
  let getFileLinkCalled = false;
  const localPath = path.join(path.sep, 'tmp', 'telegram-bot-api', '123456', 'photos', 'file_1.jpg');
  const telegram = {
    async getFile(_fileId: string) {
      return { file_path: localPath };
    },
    async getFileLink(_fileId: string) {
      getFileLinkCalled = true;
      return new URL('https://example.invalid/should-not-be-used');
    },
  };

  const result = await resolveTelegramFileLink(telegram, 'abc', 'http://telegram-bot-api:8081');
  assert.equal(result.protocol, 'file:');
  assert.equal(result.hostname, '');
  assert.equal(fileURLToPath(result), localPath);
  assert.equal(getFileLinkCalled, false);
});

test('resolveTelegramFileLink rejects missing or relative local file_path values', async () => {
  const noPath = {
    async getFile(_fileId: string) { return {}; },
    async getFileLink(_fileId: string) { return new URL('https://example.invalid/file'); },
  };
  await assert.rejects(
    () => resolveTelegramFileLink(noPath, 'abc', 'http://telegram-bot-api:8081'),
    /returned no file_path/,
  );

  const relativePath = {
    async getFile(_fileId: string) { return { file_path: 'photos/file_1.jpg' }; },
    async getFileLink(_fileId: string) { return new URL('https://example.invalid/file'); },
  };
  await assert.rejects(
    () => resolveTelegramFileLink(relativePath, 'abc', 'http://telegram-bot-api:8081'),
    /non-absolute file_path/,
  );
});
