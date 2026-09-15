import test from 'node:test';
import assert from 'node:assert/strict';
import { tgQueue } from '../src/utils/tgQueue.js';

test('tgQueue respects high priority items ahead of normal priority items', async () => {
  const executionOrder: string[] = [];
  
  // Fill capacity with long-running tasks
  const slowTask1 = tgQueue(() => new Promise((resolve) => setTimeout(() => { executionOrder.push('slow1'); resolve('slow1'); }, 40)));
  const slowTask2 = tgQueue(() => new Promise((resolve) => setTimeout(() => { executionOrder.push('slow2'); resolve('slow2'); }, 40)));
  const slowTask3 = tgQueue(() => new Promise((resolve) => setTimeout(() => { executionOrder.push('slow3'); resolve('slow3'); }, 40)));
  const slowTask4 = tgQueue(() => new Promise((resolve) => setTimeout(() => { executionOrder.push('slow4'); resolve('slow4'); }, 40)));
  const slowTask5 = tgQueue(() => new Promise((resolve) => setTimeout(() => { executionOrder.push('slow5'); resolve('slow5'); }, 40)));

  // Queue normal task
  const normalTask = tgQueue(async () => {
    executionOrder.push('normal');
    return 'normal';
  }, 'normal');

  // Queue high priority task
  const highTask = tgQueue(async () => {
    executionOrder.push('high');
    return 'high';
  }, 'high');

  await Promise.all([slowTask1, slowTask2, slowTask3, slowTask4, slowTask5, normalTask, highTask]);

  // High priority task must execute before normal task
  const highIdx = executionOrder.indexOf('high');
  const normalIdx = executionOrder.indexOf('normal');
  assert.ok(highIdx !== -1 && normalIdx !== -1, 'Both tasks must execute');
  assert.ok(highIdx < normalIdx, `High priority task (${highIdx}) should execute before normal (${normalIdx})`);
});
