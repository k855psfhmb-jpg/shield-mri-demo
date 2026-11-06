/* SHIELD: offline precomputed case package reader. No network or inference. */
(function (global) {
  'use strict';
  const MAX_FILE_BYTES = 35 * 1024 * 1024;
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const MAX_IMAGES = 150;
  const MAX_DIMENSION = 8192;
  const MAX_PIXELS = 16 * 1024 * 1024;
  const MAX_TOTAL_PIXELS = 192 * 1024 * 1024;
  const IDS = Object.freeze(['CASE-01', 'CASE-02', 'CASE-03']);
  const CATEGORIES = Object.freeze(['典型肝癌', '小肝癌', '良性病灶']);
  const PHASES = Object.freeze(['AP', 'PVP', 'DP']);
  const REPORT_KEYS = Object.freeze(['exam', 'examNo', 'sex', 'age', 'examDate', 'examRegion', 'examMethod', 'findings', 'keySigns', 'diagnosis', 'recommendation', 'doctor', 'date', 'reviewer', 'reviewDate']);
  const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function fail(message) { throw new Error('病例包无效：' + message); }
  function obj(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(name + '应为对象');
    return value;
  }
  function keysAllowed(value, allowed, name) {
    const extra = Object.keys(value).find(key => !allowed.includes(key));
    if (extra !== undefined) fail(name + '包含不支持的字段“' + extra.slice(0, 80) + '”，请核对字段名称');
  }
  function list(value, name, max) {
    if (!Array.isArray(value) || value.length > max) fail(name + '应为数组，且最多 ' + max + ' 项');
    return value;
  }
  function str(value, name, max, optional) {
    if (optional && (value === undefined || value === null)) return '';
    if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) fail(name + '应为不超过 ' + max + ' 字的文本');
    return value;
  }
  function id(value, name) {
    if (typeof value !== 'string' || !identifier.test(value)) fail(name + '只能包含字母、数字、点、下划线和连字符');
    return value;
  }
  function n01(v, name) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) fail(name + '须为 0 至 1 的数字');
    return v;
  }
  const CRC_TABLE = (() => { const table = new Uint32Array(256); for (let n=0;n<256;n++) { let c=n; for(let k=0;k<8;k++) c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1); table[n]=c>>>0; } return table; })();
  function pngCrc(raw,start,length) { let crc=0xffffffff; for(let i=start;i<start+length;i++) crc=CRC_TABLE[(crc^raw.charCodeAt(i))&255]^(crc>>>8); return (crc^0xffffffff)>>>0; }
  function imageData(data) {
    if (typeof data !== 'string' || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 40) fail('图像大小超出限制');
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
    if (!match || match[2].length % 4 !== 0) fail('图像必须为 PNG、JPEG 或 WebP 的 base64 data URL');
    let raw;
    try { raw = atob(match[2]); } catch (_) { fail('图像 base64 编码错误'); }
    if (!raw.length || raw.length > MAX_IMAGE_BYTES) fail('图像大小超出限制');
    const b = i => raw.charCodeAt(i);
    const valid = match[1] === 'png' ? raw.length >= 8 && [137,80,78,71,13,10,26,10].every((v,i) => b(i) === v)
      : match[1] === 'jpeg' ? raw.length >= 4 && b(0) === 255 && b(1) === 216 && b(2) === 255
      : raw.length >= 12 && raw.slice(0,4) === 'RIFF' && raw.slice(8,12) === 'WEBP';
    if (!valid) fail('图像内容与声明的格式不符');
    if (match[1] === 'jpeg') {
      let pos = 2, ended = false;
      while (pos < raw.length) {
        pos = raw.indexOf('\xff', pos); if (pos < 0) break;
        while (pos < raw.length && b(pos) === 255) pos++;
        if (pos >= raw.length) break;
        const marker = b(pos++);
        if (marker === 0xd9) { ended = true; break; }
        if (marker === 0x00 || marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (pos + 2 > raw.length) fail('JPEG 图像数据不完整');
        const size = b(pos)*256 + b(pos+1);
        if (size < 2 || pos + size > raw.length) fail('JPEG 图像数据不完整');
        if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
          if (size < 8) fail('JPEG 图像尺寸信息不完整');
          const h=b(pos+3)*256+b(pos+4),w=b(pos+5)*256+b(pos+6);
          if (!w || !h || w>MAX_DIMENSION || h>MAX_DIMENSION || w*h>MAX_PIXELS) fail('图片尺寸过大或无效');
        }
        if (marker === 0xe1 && size >= 8 && raw.slice(pos+2,pos+8).toLowerCase() === 'exif\x00\x00') fail('图片包含 EXIF 元数据，请先校正像素方向并移除 EXIF');
        pos += size;
      }
      if (!ended) fail('JPEG 图像数据不完整');
    }
    if (match[1] === 'png') {
      let pos = 8, sawHeader = false, sawData = false, sawEnd = false;
      while (pos + 12 <= raw.length) {
        const len = b(pos) * 16777216 + b(pos+1) * 65536 + b(pos+2) * 256 + b(pos+3);
        if (len > raw.length - pos - 12) fail('PNG 数据块不完整');
        const kind = raw.slice(pos+4, pos+8);
        if (!sawHeader) { if (kind !== 'IHDR' || len !== 13) fail('PNG 头无效'); const w=b(pos+8)*16777216+b(pos+9)*65536+b(pos+10)*256+b(pos+11),h=b(pos+12)*16777216+b(pos+13)*65536+b(pos+14)*256+b(pos+15); if (!w || !h || w>MAX_DIMENSION || h>MAX_DIMENSION || w*h>MAX_PIXELS) fail('图片尺寸过大或无效'); sawHeader = true; }
        if (kind === 'acTL' || kind === 'fcTL' || kind === 'fdAT') fail('不支持 APNG 动画，请使用静态图片');
        if (kind === 'eXIf') fail('图片包含 EXIF 元数据，请先校正像素方向并移除 EXIF');
        if (kind === 'IDAT') sawData = true;
        const crcPos=pos+8+len, stored=(b(crcPos)*16777216+b(crcPos+1)*65536+b(crcPos+2)*256+b(crcPos+3))>>>0;
        if (pngCrc(raw,pos+4,len+4)!==stored) fail('PNG 数据校验失败，请重新导出图片');
        pos += 12 + len;
        if (kind === 'IEND') { if (len !== 0 || pos !== raw.length) fail('PNG 结束标记无效'); sawEnd = true; break; }
      }
      if (!sawHeader || !sawData || !sawEnd) fail('PNG 内容不完整');
    }
    if (match[1] === 'webp') {
      const size = b(4) + b(5)*256 + b(6)*65536 + b(7)*16777216;
      if (size + 8 !== raw.length) fail('WebP 文件长度不一致');
      let pos = 12;
      while (pos + 8 <= raw.length) {
        const kind = raw.slice(pos,pos+4), len = b(pos+4) + b(pos+5)*256 + b(pos+6)*65536 + b(pos+7)*16777216;
        if (len > raw.length - pos - 8) fail('WebP 数据块不完整');
        if (kind === 'ANIM' || kind === 'ANMF' || (kind === 'VP8X' && len >= 1 && (b(pos+8) & 2))) fail('不支持动画 WebP，请使用静态图片');
        if (kind === 'VP8X' && len >= 10) {
          const w=1+b(pos+12)+b(pos+13)*256+b(pos+14)*65536,h=1+b(pos+15)+b(pos+16)*256+b(pos+17)*65536;
          if (w>MAX_DIMENSION || h>MAX_DIMENSION || w*h>MAX_PIXELS) fail('图片尺寸过大或无效');
        }
        if (kind === 'EXIF' || (kind === 'VP8X' && len >= 1 && (b(pos+8) & 8))) fail('图片包含 EXIF 元数据，请先校正像素方向并移除 EXIF');
        pos += 8 + len + (len % 2);
      }
      if (pos !== raw.length) fail('WebP 数据块不完整');
    }
    return data;
  }
  function blankCase(caseId) {
    const index = IDS.indexOf(caseId);
    if (index < 0) fail('未知病例编号');
    return {schemaVersion: 1, packId: null, caseId: caseId, displayName: '病例 0' + (index + 1), category: CATEGORIES[index],
      sequences: [], phases: [], lesions: [], findings: [], renderedResults: [], report: {}, loaded: false};
  }
  function validate(input, expectedCaseId) {
    if (!IDS.includes(expectedCaseId)) fail('请先选择 CASE-01、CASE-02 或 CASE-03');
    const value = obj(input, '病例包');
    keysAllowed(value, ['schemaVersion','packId','caseId','sequences','phases','lesions','findings','renderedResults','report'], '病例包');
    if (value.schemaVersion !== 1) fail('仅支持 schemaVersion 1');
    if (value.caseId !== expectedCaseId) fail('病例包编号与当前选择不一致，请核对后重新选择');
    if (typeof value.packId !== 'string' || !uuid.test(value.packId)) fail('packId 必须为稳定的 UUID');
    const result = blankCase(expectedCaseId);
    result.loaded = true;
    result.packId = value.packId.toLowerCase();
    const allImages = new Map();
    let count = 0;
    function images(items, owner) {
      const seenSlices = new Set();
      return list(items, owner + '的 images', MAX_IMAGES).map((item, i) => {
        obj(item, owner + '图像'); keysAllowed(item, ['imageId','slice','data','sha256'], owner + '图像');
        const imageId = id(item.imageId, 'imageId');
        if (allImages.has(imageId)) fail('imageId 重复：' + imageId);
        if (!Number.isSafeInteger(item.slice) || item.slice < 0 || item.slice > 1000000) fail('slice 须为 0 到 1000000 的整数');
        if (seenSlices.has(item.slice)) fail(owner + '中 slice 重复');
        seenSlices.add(item.slice);
        if (++count > MAX_IMAGES) fail('图像总数超过 ' + MAX_IMAGES);
        const sha256 = item.sha256 == null ? null : item.sha256;
        if (sha256 !== null && (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256))) fail('图像 sha256 必须是 64 位十六进制字符');
        const image = {imageId: imageId, slice: item.slice, data: imageData(item.data), sha256: sha256 && sha256.toLowerCase()};
        allImages.set(imageId, {owner: owner, slice: item.slice, sha256: image.sha256});
        return image;
      });
    }
    const sequenceIds = new Set();
    result.sequences = list(value.sequences, 'sequences', 20).map((s) => {
      obj(s, '序列'); keysAllowed(s, ['id','label','images'], '序列'); const sequenceId = id(s.id, '序列 id');
      if (sequenceIds.has(sequenceId)) fail('序列 id 重复：' + sequenceId); sequenceIds.add(sequenceId);
      return {id: sequenceId, label: str(s.label, '序列名称', 80, false), images: images(s.images, '序列 ' + sequenceId)};
    });
    const phaseIds = new Set();
    result.phases = list(value.phases, 'phases', 3).map((p) => {
      obj(p, '期相'); keysAllowed(p, ['id','images'], '期相'); if (!PHASES.includes(p.id) || phaseIds.has(p.id)) fail('期相 id 必须为不重复的 AP、PVP 或 DP'); phaseIds.add(p.id);
      return {id: p.id, images: images(p.images, '期相 ' + p.id)};
    });
    const baseImageIds = new Set(allImages.keys());
    const lesionIds = new Set();
    result.lesions = list(value.lesions, 'lesions', 100).map((lesion) => {
      obj(lesion, '病灶'); keysAllowed(lesion, ['id','location','sizeMm','classification','annotations'], '病灶'); const lesionId = id(lesion.id, '病灶 id');
      if (lesionIds.has(lesionId)) fail('病灶 id 重复：' + lesionId); lesionIds.add(lesionId);
      let sizeMm = lesion.sizeMm;
      if (sizeMm === undefined || sizeMm === null) sizeMm = null;
      else if (typeof sizeMm !== 'number' || !Number.isFinite(sizeMm) || sizeMm <= 0 || sizeMm > 1000) fail('sizeMm 应为合理的正数或 null');
      const seen = new Set();
      const annotations = list(lesion.annotations, 'annotations', MAX_IMAGES).map((a) => {
        obj(a, '标注'); keysAllowed(a, ['imageId','box','contours'], '标注'); const imageId = id(a.imageId, '标注 imageId');
        if (!allImages.has(imageId)) fail('标注引用不存在的影像：' + imageId);
        if (seen.has(imageId)) fail('同一病灶在同一影像上只能有一项标注'); seen.add(imageId);
        let box = null;
        if (a.box !== undefined && a.box !== null) {
          if (!Array.isArray(a.box) || a.box.length !== 4) fail('box 须为 [x1,y1,x2,y2]');
          box = a.box.map(v => n01(v, 'box 坐标'));
          if (box[0] >= box[2] || box[1] >= box[3]) fail('box 左上坐标须小于右下坐标');
        }
        const contours = list(a.contours === undefined ? [] : a.contours, 'contours', 50).map(poly => {
          const points = list(poly, '轮廓', 5000); if (points.length < 3) fail('轮廓至少 3 个点');
          return points.map(point => { if (!Array.isArray(point) || point.length !== 2) fail('轮廓点须为 [x,y]'); return [n01(point[0], 'x'), n01(point[1], 'y')]; });
        });
        if (!box && !contours.length) fail('标注须包含定位框或轮廓');
        return {imageId, box, contours};
      });
      const classification = lesion.classification == null ? null : lesion.classification;
      if (![null, 'benign', 'malignant'].includes(classification)) fail('病灶 classification 须为 benign、malignant 或 null');
      return {id: lesionId, location: str(lesion.location, '病灶位置', 200, true), sizeMm, classification, annotations};
    });
    const findingIds = new Set();
    result.findings = list(value.findings, 'findings', 100).map(f => {
      obj(f, '征象'); keysAllowed(f, ['id','name','value','evidenceImageIds','lesionId'], '征象');
      const findingId = f.id == null || f.id === '' ? null : id(f.id, '征象 id');
      if (findingId !== null && findingIds.has(findingId)) fail('征象 id 重复：' + findingId);
      if (findingId !== null) findingIds.add(findingId);
      if (![null, 'present', 'absent', 'uncertain'].includes(f.value)) fail('征象 value 须为 present、absent、uncertain 或 null');
      const evidenceImageIds = list(f.evidenceImageIds, 'evidenceImageIds', MAX_IMAGES).map(imageId => {
        id(imageId, '证据影像 id'); if (!allImages.has(imageId)) fail('证据引用不存在的影像：' + imageId); return imageId;
      });
      let lesionId = f.lesionId == null ? null : id(f.lesionId, '征象所属病灶 id');
      if (lesionId !== null && !lesionIds.has(lesionId)) fail('征象引用不存在的病灶：' + lesionId);
      return {id: findingId, name: str(f.name, '征象名称', 100, false), value: f.value, evidenceImageIds, lesionId};
    });
    const resultIds = new Set();
    result.renderedResults = list(value.renderedResults === undefined ? [] : value.renderedResults, 'renderedResults', MAX_IMAGES).map(r => {
      obj(r, '预绘制结果'); keysAllowed(r, ['id','stage','displayBaseImageId','displayBaseSha256','lesionId','findingId','image'], '预绘制结果');
      const resultId = id(r.id, '预绘制结果 id');
      if (resultIds.has(resultId)) fail('预绘制结果 id 重复：' + resultId);
      resultIds.add(resultId);
      if (!['detection', 'finding'].includes(r.stage)) fail('预绘制结果 stage 必须为 detection 或 finding');
      const displayBaseImageId = id(r.displayBaseImageId, '预绘制结果底图 id');
      if (!baseImageIds.has(displayBaseImageId)) fail('预绘制结果底图必须引用本病例的非增强序列或虚拟期相图像');
      if (typeof r.displayBaseSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(r.displayBaseSha256)) fail('预绘制结果底图摘要必须为 64 位十六进制字符');
      const displayBaseSha256 = r.displayBaseSha256.toLowerCase();
      const declaredBaseSha256 = allImages.get(displayBaseImageId).sha256;
      if (declaredBaseSha256 && declaredBaseSha256 !== displayBaseSha256) fail('预绘制结果底图摘要与底图声明不一致');
      const lesionId = r.lesionId === null ? null : id(r.lesionId, '预绘制结果病灶 id');
      if (r.stage === 'detection') {
        if (lesionId === null || !lesionIds.has(lesionId)) fail('病灶检出结果必须关联已有病灶');
        if (r.findingId !== null) fail('病灶检出结果的 findingId 必须为 null');
      } else {
        const findingId = id(r.findingId, '预绘制结果征象 id');
        const finding = result.findings.find(f => f.id === findingId);
        if (!finding) fail('预绘制征象结果必须关联已有 id 的征象');
        if (finding.lesionId !== lesionId) fail('预绘制结果病灶与关联征象的病灶不一致');
      }
      const image = images([r.image], '预绘制结果 ' + resultId)[0];
      if (image.slice !== allImages.get(displayBaseImageId).slice) fail('预绘制结果切片编号必须与底图一致');
      return {id: resultId, stage: r.stage, displayBaseImageId, displayBaseSha256, lesionId, findingId: r.stage === 'detection' ? null : r.findingId, image};
    });
    const report = obj(value.report, 'report'); result.report = {};
    keysAllowed(report, REPORT_KEYS, 'report');
    REPORT_KEYS.forEach(k => { result.report[k] = str(report[k], 'report.' + k, 100000, true); });
    return result;
  }
  // JSON.parse silently keeps the last duplicate key. Scan the already-valid
  // source as well, so an ambiguous clinical field is never silently replaced.
  function parseJson(text) {
    if (typeof text !== 'string' || !text.length || text.length > MAX_FILE_BYTES) fail('文件为空或超过大小限制');
    // Reject pathological nesting before JSON.parse allocates the object graph.
    // Strings are skipped, including quotes escaped by an odd number of slashes.
    let pre = 0, depth = 0;
    while (pre < text.length) {
      const c = text[pre];
      if (c === '"') {
        const start = pre++;
        for (;;) {
          const q = text.indexOf('"', pre);
          if (q < 0) { pre = text.length; break; }
          let slash = q - 1;
          while (slash >= start && text[slash] === '\\') slash--;
          pre = q + 1;
          if ((q - slash - 1) % 2 === 0) break;
        }
      } else {
        if (c === '{' || c === '[') {
          if (++depth > 64) fail('JSON 嵌套层级超过 64 层');
        } else if (c === '}' || c === ']') depth--;
        pre++;
      }
    }
    let data;
    try { data = JSON.parse(text); } catch (_) { fail('JSON 格式错误'); }
    let cursor = 0;
    function white() { while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\n' || text[cursor] === '\r' || text[cursor] === '\t')) cursor++; }
    function stringToken(decode) {
      const start = cursor++;
      while (cursor < text.length) {
        const q = text.indexOf('"', cursor);
        if (q < 0) fail('JSON 格式错误');
        let slash = q - 1;
        while (slash >= start && text[slash] === '\\') slash--;
        if ((q - slash - 1) % 2 === 0) {
          cursor = q + 1;
          return decode ? JSON.parse(text.slice(start, cursor)) : null;
        }
        cursor = q + 1;
      }
      fail('JSON 格式错误');
    }
    function value(depth) {
      white(); const c = text[cursor];
      if (c === '{' || c === '[') {
        if (depth >= 64) fail('JSON 嵌套层级超过 64 层');
        if (c === '{') {
          cursor++; white(); const keys = new Set();
          if (text[cursor] === '}') { cursor++; return; }
          for (;;) {
            white(); const key = stringToken(true);
            if (keys.has(key)) fail('JSON 包含重复字段，请检查文件');
            keys.add(key); white(); cursor++; // Colon is known valid from JSON.parse.
            value(depth + 1); white();
            if (text[cursor] === '}') { cursor++; return; }
            cursor++; // Comma is known valid from JSON.parse.
          }
        }
        cursor++; white();
        if (text[cursor] === ']') { cursor++; return; }
        for (;;) {
          value(depth + 1); white();
          if (text[cursor] === ']') { cursor++; return; }
          cursor++;
        }
      }
      if (c === '"') { stringToken(false); return; }
      while (cursor < text.length && !',]} \n\r\t'.includes(text[cursor])) cursor++;
    }
    value(0);
    return data;
  }
  function parse(text, expectedCaseId) {
    return validate(parseJson(text), expectedCaseId);
  }
  async function verifyIntegrity(caseData) {
    const images = caseData.sequences.flatMap(s => s.images).concat(caseData.phases.flatMap(p => p.images), (caseData.renderedResults || []).map(r => r.image));
    const required = images.filter(image => image.sha256);
    const rendered = caseData.renderedResults || [];
    if ((required.length || rendered.length) && (!global.crypto || !global.crypto.subtle)) fail('当前浏览器不支持 SHA-256，无法校验病例包');
    const lookup = new Map(images.map(image => [image.imageId, image]));
    const cache = new Map();
    async function digestImage(image) {
      if (cache.has(image.imageId)) return cache.get(image.imageId);
      const raw = atob(image.data.slice(image.data.indexOf(',') + 1));
      const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
      const hash = await global.crypto.subtle.digest('SHA-256', bytes);
      const actual = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
      cache.set(image.imageId, actual);
      return actual;
    }
    for (const image of required) {
      if (await digestImage(image) !== image.sha256) fail('影像 SHA-256 校验失败：' + image.imageId);
    }
    for (const item of rendered) {
      const image = lookup.get(item.displayBaseImageId);
      if (!image || await digestImage(image) !== item.displayBaseSha256) fail('预绘制结果底图内容摘要不匹配：' + item.id);
    }
    return {checked: required.length, total: images.length, baseReferencesChecked: rendered.length, status: !images.length || !required.length ? 'not_provided' : required.length === images.length ? 'verified' : 'partial'};
  }
  async function verifyImages(caseData) {
    const images = caseData.sequences.flatMap(s => s.images).concat(caseData.phases.flatMap(p => p.images), (caseData.renderedResults || []).map(r => r.image));
    if (images.length && typeof global.Image !== 'function') fail('当前浏览器无法验证图片，请使用新版 Edge 或 Chrome');
    let totalPixels = 0;
    for (const image of images) {
      await new Promise((resolve, reject) => {
        const img = new global.Image();
        const timer = global.setTimeout(() => finish('图片解码超时：' + image.imageId), 10000);
        function finish(message) {
          global.clearTimeout(timer); img.onload = null; img.onerror = null; img.removeAttribute('src');
          if (message) reject(new Error('病例包无效：' + message)); else resolve();
        }
        img.onload = () => {
          const w=img.naturalWidth,h=img.naturalHeight;
          if (!w || !h || w>MAX_DIMENSION || h>MAX_DIMENSION || w*h>MAX_PIXELS) { finish('图片尺寸过大或无效：' + image.imageId); return; }
          totalPixels += w*h; if (totalPixels>MAX_TOTAL_PIXELS) { finish('病例图片总像素超过演示上限，请减少图片数量或调整尺寸'); return; }
          try {
            const canvas=global.document.createElement('canvas'); canvas.width=32; canvas.height=32;
            const ctx=canvas.getContext('2d'); if(!ctx) { finish('浏览器无法检查图片：' + image.imageId); return; }
            ctx.drawImage(img,0,0,32,32); const pixels=ctx.getImageData(0,0,32,32).data;
            let visible=false; for(let i=3;i<pixels.length;i+=4) if(pixels[i]!==0){visible=true;break;}
            if(!visible) { finish('图片完全透明或不可显示：' + image.imageId); return; }
            finish(null);
          } catch (_) { finish('图片无法读取：' + image.imageId); }
        };
        img.onerror = () => finish('图片无法解码：' + image.imageId);
        img.src = image.data;
      });
    }
  }
  function decodeJsonBytes(bytes) {
    if (typeof global.TextDecoder !== 'function') fail('当前浏览器无法读取病例包，请使用新版 Edge 或 Chrome');
    try { return new global.TextDecoder('utf-8', {fatal:true}).decode(bytes); }
    catch (_) { fail('病例包不是有效 UTF-8 编码，请以 UTF-8 重新保存'); }
  }
  async function loadFile(file, expectedCaseId) {
    if (!file || typeof file.arrayBuffer !== 'function' || !Number.isSafeInteger(file.size)) fail('请选择 JSON 病例包文件');
    if (file.size <= 0 || file.size > MAX_FILE_BYTES) fail('文件为空或超过 35 MiB');
    if (!global.crypto || !global.crypto.subtle || typeof global.TextDecoder !== 'function') fail('当前浏览器无法读取并计算病例包指纹，请使用新版 Edge 或 Chrome');
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength !== file.size) fail('文件读取长度变化，请重新选择病例包');
    const result = parse(decodeJsonBytes(bytes), expectedCaseId);
    result.integrity = await verifyIntegrity(result);
    await verifyImages(result);
    const digest = await global.crypto.subtle.digest('SHA-256', bytes);
    result.fingerprint = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    return result;
  }
  global.ShieldCaseData = Object.freeze({caseIds: IDS, phases: PHASES, maxFileBytes: MAX_FILE_BYTES,
    emptyCases: () => IDS.map(blankCase), blankCase, validate, parseJson, parse, decodeJsonBytes, verifyIntegrity, verifyImages, loadFile});
})(window);
