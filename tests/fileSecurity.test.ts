import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import { inspectFileSecurity, calculateSha256, pendingSecurityStore } from '../src/utils/fileSecurity.js';

function createTempFile(name: string, content: Buffer | string): { filePath: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'sec-test-'));
  const filePath = path.join(dir, name);
  writeFileSync(filePath, content);
  return {
    filePath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('inspectFileSecurity identifies genuine JSON files as safe', async () => {
  const jsonContent = JSON.stringify({ name: 'test', count: 42, active: true }, null, 2);
  const { filePath, cleanup } = createTempFile('data.json', jsonContent);
  try {
    const result = await inspectFileSecurity(filePath, 'data.json');
    assert.equal(result.safe, true);
    assert.equal(result.status, 'safe');
    assert.equal(result.requiresApproval, false);
    assert.equal(result.detectedType, 'json');
    assert.ok(result.sha256);
  } finally {
    cleanup();
  }
});

test('inspectFileSecurity detects shell script disguised as a PNG image', async () => {
  const shellScript = '#!/bin/bash\necho "Disguised payload executing"\nrm -rf /tmp/malicious\nexit 0\n';
  const { filePath, cleanup } = createTempFile('innocent_photo.png', shellScript);
  try {
    const result = await inspectFileSecurity(filePath, 'innocent_photo.png', 'image/png');
    assert.equal(result.safe, false);
    assert.equal(result.requiresApproval, true);
    assert.equal(result.forceDocFallback, true);
    assert.match(result.reason ?? '', /ngụy trang|kịch bản/i);
    assert.ok(result.sha256);
  } finally {
    cleanup();
  }
});

test('inspectFileSecurity detects real zip archive disguised as a JPEG image', async () => {
  const zip = new AdmZip();
  zip.addFile('malicious.exe', Buffer.from('MZ fake binary payload'));
  zip.addFile('config.txt', Buffer.from('secret credentials'));
  const zipBuffer = zip.toBuffer();

  const { filePath, cleanup } = createTempFile('avatar.jpg', zipBuffer);
  try {
    const result = await inspectFileSecurity(filePath, 'avatar.jpg', 'image/jpeg');
    assert.equal(result.safe, false);
    assert.equal(result.requiresApproval, true);
    assert.equal(result.forceDocFallback, true);
    assert.match(result.reason ?? '', /ngụy trang|archive/i);
  } finally {
    cleanup();
  }
});

test('inspectFileSecurity flags javascript code renamed to png for interactive approval', async () => {
  const jsCode = 'const fs = require("fs"); function run() { console.log("running code"); } run();\n';
  const { filePath, cleanup } = createTempFile('bài 5 - Copy.png', jsCode);
  try {
    const result = await inspectFileSecurity(filePath, 'bài 5 - Copy.png', 'image/png');
    assert.equal(result.safe, false);
    assert.equal(result.requiresApproval, true);
    assert.equal(result.forceDocFallback, true);
  } finally {
    cleanup();
  }
});

test('pendingSecurityStore adds, retrieves and removes pending actions', async () => {
  let approved = false;
  let denied = false;
  const action = pendingSecurityStore.add({
    direction: 'tg_to_zalo',
    filename: 'test.png',
    localPath: '/tmp/test.png',
    topicId: 100,
    secCheck: { safe: false, status: 'suspicious', requiresApproval: true, forceDocFallback: true },
    executeApprove: async () => { approved = true; },
    executeDeny: async () => { denied = true; },
  });

  assert.ok(action.id);
  assert.equal(action.filename, 'test.png');
  const fetched = pendingSecurityStore.get(action.id);
  assert.equal(fetched?.id, action.id);

  await fetched?.executeApprove();
  assert.equal(approved, true);

  const removed = pendingSecurityStore.remove(action.id);
  assert.equal(removed, true);
  assert.equal(pendingSecurityStore.get(action.id), undefined);
});

test('calculateSha256 produces exact hex digest', () => {
  const buf = Buffer.from('hello world', 'utf8');
  assert.equal(calculateSha256(buf), 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
});
