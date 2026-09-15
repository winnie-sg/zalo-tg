import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

process.env.TG_TOKEN ||= 'test-token';
process.env.TG_GROUP_ID ||= '-1001';
process.env.DATA_DIR = path.join(os.tmpdir(), `zalo-tg-store-test-${process.pid}-${Date.now()}`);

const { config } = await import('../src/config.js');
const {
  aliasCache,
  friendsCache,
  groupsCache,
  msgStore,
  pollStore,
  reactionEchoStore,
  reactionEventDedupeStore,
  reactionSummaryStore,
  recallNotifiedStore,
  sentMsgStore,
  store,
  userCache,
} = await import('../src/store.js');

type Quote = Parameters<typeof msgStore.save>[2];
function quote(id: string, zaloId = 'thread-a', threadType: 0 | 1 = 0): Quote {
  return {
    msgId: id,
    cliMsgId: `${id}-cli`,
    uidFrom: 'user-a',
    ts: '1',
    msgType: 'webchat',
    content: 'hello',
    ttl: 0,
    zaloId,
    threadType,
  };
}

test('topic store keeps topic and Zalo indexes one-to-one', () => {
  store.set({ topicId: 9101, zaloId: 'za', type: 0, name: 'A' });
  store.set({ topicId: 9101, zaloId: 'zb', type: 0, name: 'B' });
  assert.equal(store.getTopicByZalo('za', 0), undefined);
  assert.equal(store.getTopicByZalo('zb', 0), 9101);

  store.set({ topicId: 9102, zaloId: 'zb', type: 0, name: 'B2' });
  assert.equal(store.getEntryByTopic(9101), undefined);
  assert.equal(store.getEntryByTopic(9102)?.name, 'B2');
});

test('topic store updates names and removes both directions', () => {
  store.set({ topicId: 9103, zaloId: 'group-x', type: 1, name: 'Old' });
  store.updateName(9103, 'New');
  assert.equal(store.getEntryByTopic(9103)?.name, 'New');
  assert.equal(store.remove(9103)?.zaloId, 'group-x');
  assert.equal(store.getEntryByTopic(9103), undefined);
  assert.equal(store.getTopicByZalo('group-x', 1), undefined);
});

test('topic store reload recovers from malformed JSON without throwing', async () => {
  const topicsPath = path.join(config.dataDir, 'topics.json');
  await mkdir(path.dirname(topicsPath), { recursive: true });
  await writeFile(topicsPath, '{broken', 'utf8');
  store.reload();
  assert.deepEqual(store.all(), []);
});

test('msgStore ignores sentinel IDs and deduplicates input IDs', () => {
  const before = msgStore.stats();
  msgStore.save(9201, ['0', '', 'm-9201', 'm-9201'], quote('m-9201'));
  const after = msgStore.stats();
  assert.equal(msgStore.getTgMsgId('0'), undefined);
  assert.equal(msgStore.getTgMsgId('m-9201'), 9201);
  assert.equal(after.cacheSize, before.cacheSize + 1);
  assert.equal(after.keyOrderLen, before.keyOrderLen + 1);
});

test('msgStore remapping moves reference ownership and removes orphan quote', () => {
  msgStore.save(9202, ['shared-remap'], quote('old'));
  msgStore.save(9203, ['shared-remap'], quote('new'));
  assert.equal(msgStore.getTgMsgId('shared-remap'), 9203);
  assert.equal(msgStore.getQuote(9202), undefined);
  assert.equal(msgStore.getQuote(9203)?.msgId, 'new');
});

test('msgStore patches echo metadata without losing thread identity', () => {
  msgStore.save(9204, ['echo-id'], quote('placeholder', 'group-echo', 1));
  msgStore.updateQuoteFromEcho(9204, {
    msgId: 'real-id',
    cliMsgId: 'real-cli',
    msgType: 'chat.photo',
    content: { href: 'https://x' },
  });
  assert.deepEqual(msgStore.getQuote(9204), {
    ...quote('placeholder', 'group-echo', 1),
    msgId: 'real-id',
    cliMsgId: 'real-cli',
    msgType: 'chat.photo',
    content: { href: 'https://x' },
  });
});

test('userCache resolves names case- and diacritic-insensitively', () => {
  userCache.save('u-store-1', 'Đặng Mỹ Linh');
  assert.equal(userCache.resolveByName('dang my linh'), 'u-store-1');
  assert.equal(userCache.resolveByName('ĐẶNG   MỸ LINH'), 'u-store-1');
});

test('userCache removes stale global reverse lookup after rename', () => {
  userCache.save('u-store-2', 'Tên Cũ');
  userCache.save('u-store-2', 'Tên Mới');
  assert.equal(userCache.resolveByName('Tên Cũ'), undefined);
  assert.equal(userCache.resolveByName('Tên Mới'), 'u-store-2');
});

test('userCache removes stale group-scoped reverse lookup after rename', () => {
  userCache.save('u-store-3', 'Tên toàn cục');
  userCache.saveForGroup('u-store-3', 'Biệt danh cũ', 'g-store');
  userCache.saveForGroup('u-store-3', 'Biệt danh mới', 'g-store');
  assert.equal(userCache.resolveByNameInGroup('Biệt danh cũ', 'g-store'), undefined);
  assert.equal(userCache.resolveByNameInGroup('Biệt danh mới', 'g-store'), 'u-store-3');
  assert.equal(userCache.getNameInGroup('u-store-3', 'g-store'), 'Biệt danh mới');
});

test('group-scoped names do not overwrite an existing contact-book name', () => {
  userCache.save('u-store-4', 'Tên danh bạ');
  userCache.saveForGroup('u-store-4', 'Tên trong nhóm', 'g-store-2');
  assert.equal(userCache.getName('u-store-4'), 'Tên danh bạ');
  assert.equal(userCache.getNameInGroup('u-store-4', 'g-store-2'), 'Tên trong nhóm');
});

test('aliasCache removes stale reverse lookup when an alias changes', () => {
  aliasCache.merge([{ userId: 'alias-u', alias: 'Alias Cũ' }]);
  aliasCache.merge([{ userId: 'alias-u', alias: 'Alias Mới' }]);
  assert.equal(aliasCache.resolveByAlias('Alias Cũ'), undefined);
  assert.equal(aliasCache.resolveByAlias('alias moi'), 'alias-u');
  assert.equal(aliasCache.label('alias-u', 'Tên thật'), 'Alias Mới (Tên thật)');
});

test('friendsCache searches aliases and real names without diacritics', () => {
  friendsCache.set([
    { userId: 'f1', displayName: 'Nguyễn Văn A', alias: 'Anh Cả' },
    { userId: 'f2', displayName: 'Trần Thị B' },
  ]);
  assert.equal(friendsCache.search('anh ca')[0]?.userId, 'f1');
  assert.equal(friendsCache.search('tran thi')[0]?.userId, 'f2');
  assert.equal(friendsCache.get('f2')?.displayName, 'Trần Thị B');
  assert.equal(friendsCache.isFresh(), true);
});

test('groupsCache searches names without diacritics and respects limit', () => {
  groupsCache.set([
    { groupId: 'g1', name: 'Nhóm Một', totalMember: 2 },
    { groupId: 'g2', name: 'Nhóm Hai', totalMember: 3 },
  ]);
  assert.deepEqual(groupsCache.search('nhom', 1).map(g => g.groupId), ['g1']);
  assert.equal(groupsCache.isFresh(), true);
});

test('sentMsgStore clears stale reverse IDs when an entry is replaced', () => {
  sentMsgStore.save(9301, { msgIds: ['z-old'], zaloId: 'peer', threadType: 0 });
  sentMsgStore.save(9301, { msgIds: ['z-new'], zaloId: 'peer', threadType: 0 });
  assert.equal(sentMsgStore.getByZaloMsgId('z-old'), undefined);
  assert.equal(sentMsgStore.getByZaloMsgId('z-new'), 9301);
});

test('sentMsgStore reference-counts concurrent in-flight sends', () => {
  sentMsgStore.markSending('peer-concurrent');
  sentMsgStore.markSending('peer-concurrent');
  sentMsgStore.unmarkSending('peer-concurrent');
  assert.equal(sentMsgStore.isSendingTo('peer-concurrent'), true);
  sentMsgStore.unmarkSending('peer-concurrent');
  assert.equal(sentMsgStore.isSendingTo('peer-concurrent'), false);
});

test('reactionEchoStore consumes exactly the number of marked echoes', () => {
  reactionEchoStore.mark('g', 'm', '/-heart');
  reactionEchoStore.mark('g', 'm', '/-heart');
  assert.equal(reactionEchoStore.consume('g', 'm', '/-heart'), true);
  assert.equal(reactionEchoStore.consume('g', 'm', '/-heart'), true);
  assert.equal(reactionEchoStore.consume('g', 'm', '/-heart'), false);
});

test('reactionEventDedupeStore normalizes target order and actor names', () => {
  const first = reactionEventDedupeStore.isDuplicateZaloInbound({
    zaloId: 'g-dedupe',
    targetMsgIds: ['b', 'a', 'a'],
    icon: '/-heart',
    actorName: '  Nguyễn   A ',
  });
  const second = reactionEventDedupeStore.isDuplicateZaloInbound({
    zaloId: 'g-dedupe',
    targetMsgIds: ['a', 'b'],
    icon: '/-heart',
    actorName: 'nguyễn a',
  });
  assert.equal(first, false);
  assert.equal(second, true);
});

test('reactionEventDedupeStore counts repeated actions by actionId and dedupes replays of the same action', () => {
  // Repeated identical tap → new actionId → NOT a duplicate
  assert.equal(
    reactionEventDedupeStore.isDuplicateZaloInbound({ zaloId: 'g', targetMsgIds: ['m'], icon: '/-heart', actionId: 'act-1' }),
    false,
  );
  assert.equal(
    reactionEventDedupeStore.isDuplicateZaloInbound({ zaloId: 'g', targetMsgIds: ['m'], icon: '/-heart', actionId: 'act-2' }),
    false,
  );
  // Same action re-emitted later (reconnect replay) → duplicate
  assert.equal(
    reactionEventDedupeStore.isDuplicateZaloInbound({ zaloId: 'g', targetMsgIds: ['m'], icon: '/-heart', actionId: 'act-1' }),
    true,
  );
});

test('reactionSummaryStore counts repeated same-emoji reactions per actor', () => {
  const entry = reactionSummaryStore.upsert(9402, '❤️', 'Alice');
  reactionSummaryStore.upsert(9402, '❤️', 'Alice');
  reactionSummaryStore.upsert(9402, '❤️', 'Alice');
  reactionSummaryStore.upsert(9402, '👍', 'Alice');
  assert.equal(reactionSummaryStore.buildText(entry), '❤️ ×3 Alice  👍 Alice');
});

test('recallNotifiedStore suppresses duplicate recall notifications and allows re-mark after unmark', () => {
  assert.equal(recallNotifiedStore.markIfFirst('recall-1'), true);
  assert.equal(recallNotifiedStore.markIfFirst('recall-1'), false);
  assert.equal(recallNotifiedStore.markIfFirst('recall-2'), true);
  recallNotifiedStore.unmark('recall-1');
  assert.equal(recallNotifiedStore.markIfFirst('recall-1'), true);
  assert.equal(recallNotifiedStore.markIfFirst('recall-1'), false);
});

test('reactionSummaryStore does not duplicate the same actor per emoji', () => {
  const entry = reactionSummaryStore.upsert(9401, '❤️', 'Alice');
  reactionSummaryStore.upsert(9401, '❤️', 'Alice');
  reactionSummaryStore.upsert(9401, '👍', 'Bob');
  assert.equal(reactionSummaryStore.buildText(entry), '❤️ ×2 Alice  👍 Bob');
});

test('pollStore removes stale Telegram and UUID indexes when a poll is replaced', () => {
  pollStore.save({
    pollId: 9501,
    zaloGroupId: 'g',
    tgPollMsgId: 9511,
    tgPollUUID: 'uuid-old',
    tgScoreMsgId: 9521,
    tgThreadId: 9531,
    createdAt: Date.now(),
    options: [{ option_id: 1, content: 'A' }],
  });
  pollStore.save({
    pollId: 9501,
    zaloGroupId: 'g',
    tgPollMsgId: 9512,
    tgPollUUID: 'uuid-new',
    tgScoreMsgId: 9522,
    tgThreadId: 9531,
    createdAt: Date.now(),
    options: [{ option_id: 1, content: 'A' }],
  });
  assert.equal(pollStore.getByTgMsgId(9511), undefined);
  assert.equal(pollStore.getByTgPollUUID('uuid-old'), undefined);
  assert.equal(pollStore.getByTgMsgId(9512)?.pollId, 9501);
  assert.equal(pollStore.getByTgPollUUID('uuid-new')?.pollId, 9501);
});


test('pollStore removes expired local mappings but keeps current mappings', () => {
  const now = Date.now();
  pollStore.save({
    pollId: 9551,
    zaloGroupId: 'g',
    tgPollMsgId: 9552,
    tgPollUUID: 'uuid-expired',
    tgScoreMsgId: 9553,
    tgThreadId: 9554,
    createdAt: now - 61 * 24 * 60 * 60 * 1_000,
    options: [{ option_id: 1, content: 'Old' }],
  });
  assert.equal(pollStore.pruneExpired(now), 1);
  assert.equal(pollStore.getByPollId(9551), undefined);
});
test('debounced msgStore persistence writes a gzip payload', async () => {
  msgStore.save(9601, ['persist-id'], quote('persist-id'));
  await new Promise(resolve => setTimeout(resolve, 1200));
  const data = await readFile(path.join(config.dataDir, 'msg-map.json'));
  assert.equal(data[0], 0x1f);
  assert.equal(data[1], 0x8b);
});
