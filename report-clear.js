/* Clear only SHIELD report records for the current browser origin. */
(function (global) {
  'use strict';
  const PREFIXES = Object.freeze([
    'shield-report-v4-',
    'shield-report-v3-',
    'shield-demo-report-v2-case-',
    'shield-demo-report-v1-case-'
  ]);
  function isReportKey(key) {
    return typeof key === 'string' && PREFIXES.some(prefix => key.startsWith(prefix));
  }
  function reportKeys(storage) {
    const keys = [];
    for (let i = 0, length = storage.length; i < length; i++) {
      const key = storage.key(i);
      if (isReportKey(key)) keys.push(key);
    }
    return keys;
  }
  function clearAll() {
    let storage, keys;
    try {
      storage = global.localStorage;
      if (!storage) throw new Error('unavailable');
      keys = reportKeys(storage);
    } catch (_) {
      throw new Error('无法读取本机报告存储，未执行清除。');
    }
    let count = 0;
    try {
      for (const key of keys) {
        storage.removeItem(key);
        if (storage.getItem(key) !== null) throw new Error('remove failed');
        count++;
      }
      if (reportKeys(storage).length) throw new Error('reports remain');
    } catch (_) {
      throw new Error('本机报告未能全部清除，部分内容可能已删除；请关闭其他标签页后检查并重试。');
    }
    return count;
  }
  global.ShieldReportClear = Object.freeze({clearAll});
})(window);
