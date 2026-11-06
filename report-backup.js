/* Local report-only backup. Never uploads or stores content. */
(function (global) {
  'use strict';
  const KIND = 'shield-report-backup';
  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_FIELD = 100000;
  const FIELDS = Object.freeze(['exam','examNo','sex','age','examDate','examRegion','examMethod','findings','keySigns','diagnosis','recommendation','doctor','date','reviewer','reviewDate']);
  const CASE_IDS = new Set(['CASE-01','CASE-02','CASE-03']);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function fail(reason) { throw new Error('报告备份无效：' + reason); }
  function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + '应为对象');
    return value;
  }
  function keysAllowed(value, allowed, label) {
    if (Object.keys(value).some(key => !allowed.includes(key))) fail(label + '包含不支持的字段');
  }
  function identity(caseId, packId, fingerprint) {
    if (!CASE_IDS.has(caseId)) fail('病例编号不正确');
    if (packId !== null && (typeof packId !== 'string' || !UUID.test(packId))) fail('病例包编号不正确');
    if (fingerprint !== null && (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint))) fail('病例包内容指纹不正确');
    if ((packId === null) !== (fingerprint === null)) fail('病例包编号与内容指纹不一致');
    return {caseId, packId: packId === null ? null : packId.toLowerCase(), fingerprint};
  }
  function normalizeReport(value) {
    object(value, '报告');
    keysAllowed(value, FIELDS, '报告');
    const report = {};
    for (const key of FIELDS) {
      const v = Object.prototype.hasOwnProperty.call(value, key) ? value[key] : '';
      if (typeof v !== 'string' || v.length > MAX_FIELD) fail('报告字段必须为规定长度内的文本');
      report[key] = v;
    }
    return report;
  }
  function makeBackup(input) {
    object(input, '请求');
    keysAllowed(input, ['caseId','packId','fingerprint','report'], '请求');
    const id = identity(input.caseId, input.packId, input.fingerprint);
    return {kind: KIND, schemaVersion: 2, caseId: id.caseId, packId: id.packId, fingerprint: id.fingerprint, report: normalizeReport(input.report)};
  }
  function backupIdentity(value) {
    object(value, '备份');
    keysAllowed(value, ['kind','schemaVersion','caseId','packId','fingerprint','report'], '备份');
    if (value.kind !== KIND) fail('文件类型不受支持');
    if (!Object.prototype.hasOwnProperty.call(value, 'fingerprint')) fail('旧版备份缺少病例包内容指纹，不能自动恢复');
    if (value.schemaVersion !== 2) fail('文件版本不受支持');
    return identity(value.caseId, value.packId, value.fingerprint);
  }
  function currentIdentity(expected) {
    object(expected, '当前病例');
    keysAllowed(expected, ['caseId','packId','fingerprint'], '当前病例');
    return identity(expected.caseId, expected.packId, expected.fingerprint);
  }
  function verify(value, expected) {
    const actual = backupIdentity(value);
    const current = currentIdentity(expected);
    if (actual.caseId !== current.caseId || actual.packId !== current.packId || actual.fingerprint !== current.fingerprint) fail('病例、病例包编号或内容指纹不一致，不能恢复');
    return normalizeReport(value.report);
  }
  async function parseFile(file) {
    if (!file || typeof file.arrayBuffer !== 'function' || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_BYTES) fail('请选择不超过 2 MiB 的报告备份 JSON 文件');
    let bytes;
    try { bytes = await file.arrayBuffer(); } catch (_) { fail('读取文件失败'); }
    if (!bytes || bytes.byteLength !== file.size) fail('文件读取长度变化，请重新选择备份');
    if (typeof global.TextDecoder !== 'function') fail('当前浏览器无法读取 UTF-8 备份，请使用新版 Edge 或 Chrome');
    let content;
    try { content = new global.TextDecoder('utf-8', {fatal:true}).decode(bytes); } catch (_) { fail('文件不是有效 UTF-8 编码，请核对备份'); }
    if (content.length > MAX_BYTES) fail('文件内容过大');
    let value;
    try { if (!global.ShieldCaseData || typeof global.ShieldCaseData.parseJson !== 'function') fail('病例格式校验组件缺失'); value = global.ShieldCaseData.parseJson(content); } catch (error) { if (error && /重复字段/.test(error.message)) fail('JSON 包含重复字段'); fail('JSON 格式错误或校验组件缺失'); }
    return value;
  }
  async function readFile(file, expected) {
    return verify(await parseFile(file), expected);
  }
  async function inspectForMigration(file, expected) {
    const value = await parseFile(file);
    const actual = backupIdentity(value);
    const current = currentIdentity(expected);
    if (actual.packId === null || current.packId === null) fail('迁移需要已载入且有内容指纹的病例包');
    if (actual.caseId !== current.caseId || actual.packId !== current.packId) fail('病例或病例包编号不一致，不能迁移');
    if (actual.fingerprint === current.fingerprint) fail('病例包指纹相同，请使用普通恢复');
    return {report: normalizeReport(value.report), sourceFingerprint: actual.fingerprint,
      targetFingerprint: current.fingerprint, caseId: current.caseId, packId: current.packId};
  }
  function exportBackup(input) {
    const backup = makeBackup(input);
    const text = JSON.stringify(backup, null, 2);
    const blob = new Blob([text], {type:'application/json;charset=utf-8'});
    if (blob.size > MAX_BYTES) fail('报告内容超过 2 MiB');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'SHIELD-' + backup.caseId + '-report.json';
    link.hidden = true;
    document.body.appendChild(link);
    try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  global.ShieldReportBackup = Object.freeze({export: exportBackup, readFile, inspectForMigration});
})(window);
