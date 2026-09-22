/* ============================================================
   简记 · 多端合并（纯函数，浏览器 / Node 双端可用）
   - 浏览器：挂载到全局 JianjiMerge.mergeCollection / mergeArchives
   - Node：  const { mergeCollection, mergeArchives } = require('./merge.js')
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JianjiMerge = factory();
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 同一 id：较新 updatedAt 胜出；墓碑若 deletedAt >= 条目 updatedAt 则删掉该条目。 */
  function mergeCollection(localArr, remoteArr, tombs, kind) {
    const map = new Map((localArr || []).map(x => [x.id, x]));
    let changed = 0;
    for (const r of (remoteArr || [])) {
      const l = map.get(r.id);
      if (!l) { map.set(r.id, r); changed++; }
      else if ((r.updatedAt || 0) > (l.updatedAt || 0)) { map.set(r.id, r); changed++; }
    }
    for (const [id, t] of tombs) {
      if (t.kind !== kind) continue;
      const x = map.get(id);
      if (x && (x.updatedAt || 0) <= (t.deletedAt || 0)) { map.delete(id); changed++; }
    }
    return { arr: [...map.values()], changed };
  }

  function mergeArchives(local, remote) {
    const tombs = new Map();
    for (const t of [...(local.deleted || []), ...(remote.deleted || [])]) {
      const cur = tombs.get(t.id);
      const tt = { ...t, kind: t.kind || 'note' };
      if (!cur || (tt.deletedAt || 0) >= (cur.deletedAt || 0)) tombs.set(t.id, tt);
    }
    const n = mergeCollection(local.notes, remote.notes, tombs, 'note');
    const k = mergeCollection(local.tasks, remote.tasks, tombs, 'task');
    const c = mergeCollection(local.lists, remote.lists, new Map(), 'list');

    const settings = (remote.savedAt || 0) > (local.savedAt || 0)
      ? { ...local.settings, ...(remote.settings || {}) }
      : { ...(remote.settings || {}), ...(local.settings || {}) };

    return {
      notes: n.arr, tasks: k.arr, lists: c.arr,
      deleted: [...tombs.values()], settings,
      changed: n.changed + k.changed + c.changed,
    };
  }

  return { mergeCollection, mergeArchives };
});
