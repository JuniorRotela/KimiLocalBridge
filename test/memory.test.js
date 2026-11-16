'use strict';

const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { MemoryStore, memoryContextHook } = require('../src/memory.js');

test('stores, retrieves, and links Obsidian-compatible project memory', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kimi-memory-'));
  try {
    const store = new MemoryStore(directory);
    await store.init();
    await store.recordUserMessage('session-test', [{ type: 'text', text: 'Use the blue deployment target.' }]);
    await store.recordTool('session-test', 'write', { filePath: '/tmp/example.txt' }, { title: 'Wrote file successfully.' });
    await store.remember({
      title: 'Deployment target',
      content: 'The preferred deployment target is blue.',
      tags: ['deployment'],
      links: ['Project'],
      type: 'decision',
      sessionID: 'session-test',
    });
    await store.updateIndex();
    const context = await store.context('Which deployment target?');
    assert.match(context, /preferred deployment target is blue/);
    assert.match(context, /\[\[notes\/deployment-target\|Deployment target\]\]/);
    const search = await store.search('example');
    assert.match(search, /example.txt/);
    const history = await fs.readFile(store.sessionPath('session-test'), 'utf8');
    assert.match(history, /blue deployment target/);
    assert.match(history, /Tool: write/);
    assert.ok(await fs.stat(path.join(directory, 'memory', 'Home.md')));
    const output = { message: { id: 'msg_new' }, parts: [{ type: 'text', text: 'What is the deployment target?' }] };
    await memoryContextHook(store, { sessionID: 'session-new', messageID: 'msg_new', model: { providerID: 'local-bridge' } }, output);
    assert.equal(output.parts.length, 2);
    assert.match(output.parts[1].id, /^prt/);
    assert.equal(output.parts[1].sessionID, 'session-new');
    assert.equal(output.parts[1].messageID, 'msg_new');
    assert.match(output.parts[1].text, /preferred deployment target is blue/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
