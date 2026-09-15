import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cwd = path.resolve(import.meta.dirname, '..');

const CONFIG_KEYS = [
  'TG_TOKEN', 'TG_GROUP_ID', 'LOCAL_BOT_API', 'TG_LOCAL_SERVER',
  'DATA_DIR', 'ZALO_CREDENTIALS_PATH', 'ZALO_SKIP_MUTED_GROUPS', 'ZALO_MUTE_SILENT', 'ACCOUNTS',
  'ZALO_DM_NATIVE_REACTION', 'ZALO_EXCLUDE_THREADS',
] as const;

function runConfig(overrides: Record<string, string | undefined>) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of CONFIG_KEYS) delete env[key];
  // Set unprovided keys to empty string so dotenv doesn't fill them from .env
  for (const key of CONFIG_KEYS) {
    if (!(key in overrides)) env[key] = '';
  }
  Object.assign(env, overrides);
  const script = `
    import('./src/config.ts')
      .then(({ config }) => console.log(JSON.stringify(config)))
      .catch(err => { console.error(err?.message ?? String(err)); process.exitCode = 1; });
  `;
  return spawnSync(process.execPath, ['--import', 'tsx', '--eval', script], {
    cwd,
    env,
    encoding: 'utf8',
  });
}

const valid = { TG_TOKEN: 'token', TG_GROUP_ID: '-1001234567890' };

test('config rejects missing required Telegram variables', () => {
  const noToken = runConfig({ TG_GROUP_ID: valid.TG_GROUP_ID });
  assert.notEqual(noToken.status, 0);
  assert.match(noToken.stderr, /Missing required environment variable: TG_TOKEN/);

  const noGroup = runConfig({ TG_TOKEN: valid.TG_TOKEN });
  assert.notEqual(noGroup.status, 0);
  assert.match(noGroup.stderr, /Missing required environment variable: TG_GROUP_ID/);
});

test('config rejects malformed or non-supergroup Telegram IDs', () => {
  for (const groupId of ['abc', '0', '123', '1.5', String(Number.MAX_SAFE_INTEGER + 1)]) {
    const result = runConfig({ ...valid, TG_GROUP_ID: groupId });
    assert.notEqual(result.status, 0, groupId);
    assert.match(result.stderr, /negative safe integer/, groupId);
  }
});

test('config resolves relative paths from project root and preserves absolute paths', () => {
  const relative = runConfig({ ...valid, DATA_DIR: 'state', ZALO_CREDENTIALS_PATH: 'secrets/zalo.json' });
  assert.equal(relative.status, 0, relative.stderr);
  const relConfig = JSON.parse(relative.stdout);
  assert.equal(relConfig.dataDir, path.join(cwd, 'state'));
  assert.equal(relConfig.zalo.credentialsPath, path.join(cwd, 'secrets/zalo.json'));

  const absolutePath = path.join(path.parse(cwd).root, 'tmp', 'zalo-test-data');
  const absolute = runConfig({ ...valid, DATA_DIR: absolutePath });
  assert.equal(absolute.status, 0, absolute.stderr);
  assert.equal(JSON.parse(absolute.stdout).dataDir, absolutePath);
});

test('config parses boolean flags case-insensitively and keeps mute mirroring enabled by default', () => {
  const result = runConfig({
    ...valid,
    ZALO_SKIP_MUTED_GROUPS: 'YeS',
    ZALO_MUTE_SILENT: 'off',
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.zalo.skipMutedGroups, true);
  assert.equal(parsed.zalo.muteSilentMirror, false);

  const defaults = runConfig(valid);
  assert.equal(JSON.parse(defaults.stdout).zalo.muteSilentMirror, true);
});

test('config parses ZALO_EXCLUDE_THREADS into type:id keys and defaults bare ids to groups', () => {
  const result = runConfig({
    ...valid,
    ZALO_EXCLUDE_THREADS: '0:123456789, 987654321, 1:555000111',
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout).zalo.excludeThreads;
  assert.equal(parsed['0:123456789'], true);
  assert.equal(parsed['1:987654321'], true);
  assert.equal(parsed['1:555000111'], true);
  assert.equal(parsed['0:987654321'], undefined);

  const empty = runConfig(valid);
  assert.deepEqual(JSON.parse(empty.stdout).zalo.excludeThreads, {});
});

test('local Bot API mode requires a valid HTTP URL and trims trailing slashes', () => {
  const missing = runConfig({ ...valid, LOCAL_BOT_API: '1' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /TG_LOCAL_SERVER/);

  const invalid = runConfig({ ...valid, LOCAL_BOT_API: '1', TG_LOCAL_SERVER: 'file:///tmp/bot' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /http or https/);

  const enabled = runConfig({
    ...valid,
    LOCAL_BOT_API: 'true',
    TG_LOCAL_SERVER: 'http://localhost:8081///',
  });
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(JSON.parse(enabled.stdout).telegram.localServer, 'http://localhost:8081');

  const disabled = runConfig({ ...valid, LOCAL_BOT_API: '0', TG_LOCAL_SERVER: 'not a URL' });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(JSON.parse(disabled.stdout).telegram.localServer, null);
});
