'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mergeCollection, mergeArchives } = require('../js/merge.js');

describe('mergeCollection', () => {
  it('adds remote-only items', () => {
    const r = mergeCollection(
      [{ id: 'a', updatedAt: 1 }],
      [{ id: 'b', updatedAt: 2 }],
      new Map(),
      'note',
    );
    assert.equal(r.arr.length, 2);
    assert.ok(r.changed >= 1);
    assert.ok(r.arr.some(x => x.id === 'b'));
  });

  it('newer updatedAt wins', () => {
    const r = mergeCollection(
      [{ id: 'a', updatedAt: 10, title: 'local' }],
      [{ id: 'a', updatedAt: 20, title: 'remote' }],
      new Map(),
      'note',
    );
    assert.equal(r.arr.length, 1);
    assert.equal(r.arr[0].title, 'remote');
    assert.ok(r.changed >= 1);
  });

  it('older remote does not overwrite', () => {
    const r = mergeCollection(
      [{ id: 'a', updatedAt: 20, title: 'local' }],
      [{ id: 'a', updatedAt: 10, title: 'remote' }],
      new Map(),
      'note',
    );
    assert.equal(r.arr[0].title, 'local');
    assert.equal(r.changed, 0);
  });

  it('tombstone wins when deletedAt >= updatedAt', () => {
    const tombs = new Map([['a', { id: 'a', kind: 'note', deletedAt: 50 }]]);
    const r = mergeCollection(
      [{ id: 'a', updatedAt: 40, title: 'gone' }],
      [{ id: 'a', updatedAt: 30, title: 'cloud-old' }],
      tombs,
      'note',
    );
    assert.equal(r.arr.length, 0);
    assert.ok(r.changed >= 1);
  });

  it('tombstone does not delete if item was edited after delete', () => {
    const tombs = new Map([['a', { id: 'a', kind: 'note', deletedAt: 50 }]]);
    const r = mergeCollection(
      [{ id: 'a', updatedAt: 60, title: 'revived' }],
      [],
      tombs,
      'note',
    );
    assert.equal(r.arr.length, 1);
    assert.equal(r.arr[0].title, 'revived');
  });

  it('ignores tombstones of other kinds', () => {
    const tombs = new Map([['a', { id: 'a', kind: 'task', deletedAt: 99 }]]);
    const r = mergeCollection(
      [{ id: 'a', updatedAt: 1 }],
      [],
      tombs,
      'note',
    );
    assert.equal(r.arr.length, 1);
  });
});

describe('mergeArchives', () => {
  it('merges notes/tasks/lists and unions tombstones', () => {
    const local = {
      notes: [{ id: 'n1', updatedAt: 1, title: 'L' }],
      tasks: [{ id: 't1', updatedAt: 5, title: 'TL' }],
      lists: [{ id: 'l1', updatedAt: 1, name: 'inbox' }],
      deleted: [{ id: 'n2', kind: 'note', deletedAt: 10 }],
      settings: { theme: 'light' },
      savedAt: 100,
    };
    const remote = {
      notes: [
        { id: 'n1', updatedAt: 2, title: 'R' },
        { id: 'n2', updatedAt: 5, title: 'should-die' },
      ],
      tasks: [{ id: 't1', updatedAt: 3, title: 'TR' }],
      lists: [{ id: 'l2', updatedAt: 2, name: 'work' }],
      deleted: [],
      settings: { theme: 'dark', sort: 'updated' },
      savedAt: 50,
    };
    const m = mergeArchives(local, remote);
    assert.equal(m.notes.find(n => n.id === 'n1').title, 'R');
    assert.ok(!m.notes.some(n => n.id === 'n2'), 'tombstone removes cloud-old n2');
    assert.equal(m.tasks[0].title, 'TL', 'local task newer');
    assert.equal(m.lists.length, 2);
    assert.equal(m.settings.theme, 'light', 'local savedAt newer → local settings win base');
    assert.ok(m.deleted.some(d => d.id === 'n2'));
  });

  it('settings follow newer savedAt (remote wins)', () => {
    const local = {
      notes: [], tasks: [], lists: [], deleted: [],
      settings: { theme: 'light' }, savedAt: 10,
    };
    const remote = {
      notes: [], tasks: [], lists: [], deleted: [],
      settings: { theme: 'dark', sort: 'created' }, savedAt: 99,
    };
    const m = mergeArchives(local, remote);
    assert.equal(m.settings.theme, 'dark');
    assert.equal(m.settings.sort, 'created');
  });

  it('restore-from-cloud style: sticky delete still applies', () => {
    /* 云端仍有条目，但本地墓碑 deletedAt 更晚 → 合并后条目消失（粘性删除）。 */
    const local = {
      notes: [],
      tasks: [],
      lists: [],
      deleted: [{ id: 'n1', kind: 'note', deletedAt: 200 }],
      settings: {},
      savedAt: 200,
    };
    const remote = {
      notes: [{ id: 'n1', updatedAt: 100, title: '云端残留' }],
      tasks: [],
      lists: [],
      deleted: [],
      settings: {},
      savedAt: 100,
    };
    const m = mergeArchives(local, remote);
    assert.equal(m.notes.length, 0);
    assert.ok(m.deleted.some(d => d.id === 'n1'));
  });
});
