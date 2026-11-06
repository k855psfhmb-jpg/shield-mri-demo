/* SHIELD viewer: precomputed local image display; no image processing or inference. */
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const styleId = 'shield-viewer-style-v1';
  function ensureStyle() {
    if (document.getElementById(styleId)) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      .shield-image-viewport {overflow:hidden; isolation:isolate;}
      .shield-image-viewport .shield-media {position:relative;display:inline-block;max-width:100%;max-height:330px;line-height:0;transform-origin:center;}
      .shield-image-viewport .shield-image {display:block;width:auto;height:auto;max-width:100%;max-height:330px;object-fit:contain;}
      .shield-image-viewport .shield-overlay {position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;}
      .shield-image-viewport .shield-overlay rect, .shield-image-viewport .shield-overlay polygon {vector-effect:non-scaling-stroke;fill:none;stroke-width:2;}
      .shield-image-viewport .shield-overlay rect {stroke:#ffca72;}
      .shield-image-viewport .shield-overlay polygon {stroke:#4ee9d0;}
      .shield-image-viewport .viewport-label,.shield-image-viewport .viewport-corner {z-index:2;pointer-events:none;text-shadow:0 1px 3px #000;background:#09131ebd;border-radius:3px;padding:3px 5px;}
      .shield-image-viewport .shield-image-error {color:#e8bb78;font-size:12px;line-height:1.5;text-align:center;padding:16px;}
      @media(max-width:700px){.shield-image-viewport .shield-media,.shield-image-viewport .shield-image{max-height:300px;}}
    `;
    document.head.appendChild(style);
  }
  function svgElement(name, attributes) {
    const element = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  }
  const coordinate = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  function drawAnnotations(svg, imageId, annotations, showBox, showContour) {
    for (const a of Array.isArray(annotations) ? annotations : []) {
      if (!a || a.imageId !== imageId) continue;
      if (showBox && Array.isArray(a.box) && a.box.length === 4 && a.box.every(coordinate)) {
        const [x1, y1, x2, y2] = a.box;
        if (x2 > x1 && y2 > y1) svg.appendChild(svgElement('rect', {x:x1,y:y1,width:x2-x1,height:y2-y1}));
      }
      if (showContour && Array.isArray(a.contours)) {
        for (const contour of a.contours) {
          if (!Array.isArray(contour) || contour.length < 3 || !contour.every(p => Array.isArray(p) && p.length === 2 && p.every(coordinate))) continue;
          svg.appendChild(svgElement('polygon', {points:contour.map(p => p.join(',')).join(' ')}));
        }
      }
    }
  }
  function create(opts) {
    opts = opts && typeof opts === 'object' ? opts : {};
    ensureStyle();
    const root = document.createElement('div');
    root.className = 'viewport shield-image-viewport';
    const label = document.createElement('div');
    label.className = 'viewport-label';
    label.textContent = typeof opts.label === 'string' ? opts.label : '影像';
    root.appendChild(label);
    const corner = document.createElement('span');
    corner.className = 'viewport-corner';
    const image = opts.image;
    corner.textContent = image && Number.isFinite(image.slice) ? '切片 ' + String(image.slice) : '— / —';
    root.appendChild(corner);
    function showMissing(message, detail, error) {
      const container = document.createElement('div');
      container.className = error ? 'shield-image-error' : 'placeholder';
      if (!error) {
        const icon = document.createElement('div'); icon.className = 'placeholder-icon'; icon.textContent = '＋'; container.appendChild(icon);
      }
      const title = document.createElement('b'); title.textContent = message; container.appendChild(title);
      const note = document.createElement('span'); note.textContent = detail; container.appendChild(note);
      root.appendChild(container);
    }
    if (!image) {
      showMissing('影像待补充', '此处为预留展示区域', false);
      return root;
    }
    if (typeof image.imageId !== 'string' || typeof image.data !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(image.data)) {
      showMissing('影像加载失败', '仅支持病例包内有效的 PNG、JPEG 或 WebP 图片', true);
      return root;
    }
    const wrap = document.createElement('div');
    wrap.className = 'shield-media';
    const numericZoom = Number(opts.zoom);
    const zoom = Number.isFinite(numericZoom) ? Math.min(3, Math.max(1, numericZoom)) : 1;
    // Translate the common image/SVG wrapper so geometry remains registered.
    const pan = opts.pan && typeof opts.pan === 'object' ? opts.pan : {x:0,y:0};
    if (!Number.isFinite(pan.x)) pan.x = 0;
    if (!Number.isFinite(pan.y)) pan.y = 0;
    if (zoom === 1) { pan.x = 0; pan.y = 0; }
    let drag = null;
    function updateTransform() {
      const width = wrap.offsetWidth, height = wrap.offsetHeight;
      const boundX = Math.max(0, (width * zoom - root.clientWidth) / 2);
      const boundY = Math.max(0, (height * zoom - root.clientHeight) / 2);
      pan.x = Math.max(-boundX, Math.min(boundX, pan.x));
      pan.y = Math.max(-boundY, Math.min(boundY, pan.y));
      wrap.style.transform = 'translate(' + pan.x + 'px,' + pan.y + 'px) scale(' + zoom + ')';
    }
    wrap.style.transform = 'scale(' + zoom + ')';
    const img = document.createElement('img');
    img.className = 'shield-image';
    img.draggable = false;
    img.alt = label.textContent + '（病例包预置图片' + (zoom > 1 ? '；可拖动查看，双击复位位置' : '') + '）';
    img.onload = function () {
      if (!img.naturalWidth || !img.naturalHeight) { img.onerror(); return; }
      const overlay = svgElement('svg', {viewBox:'0 0 1 1',preserveAspectRatio:'none','aria-hidden':'true'});
      overlay.classList.add('shield-overlay');
      drawAnnotations(overlay, image.imageId, opts.annotations, !!opts.showBox, !!opts.showContour);
      wrap.appendChild(overlay);
      updateTransform();
      if (zoom > 1) {
        wrap.style.touchAction = 'none';
        wrap.style.cursor = 'grab';
        wrap.title = '拖动查看；双击复位位置';
        wrap.addEventListener('pointerdown', event => {
          if (event.pointerType === 'mouse' && event.button !== 0) return;
          event.preventDefault();
          if (root.tabIndex >= 0) root.focus({preventScroll:true});
          drag = {id:event.pointerId, x:event.clientX, y:event.clientY, panX:pan.x, panY:pan.y};
          try { wrap.setPointerCapture(event.pointerId); } catch (_) {}
          wrap.style.cursor = 'grabbing';
        });
        wrap.addEventListener('pointermove', event => {
          if (!drag || drag.id !== event.pointerId) return;
          pan.x = drag.panX + event.clientX - drag.x;
          pan.y = drag.panY + event.clientY - drag.y;
          updateTransform();
        });
        function endDrag(event) {
          if (!drag || drag.id !== event.pointerId) return;
          drag = null;
          wrap.style.cursor = 'grab';
          try { if (wrap.hasPointerCapture(event.pointerId)) wrap.releasePointerCapture(event.pointerId); } catch (_) {}
        }
        wrap.addEventListener('pointerup', endDrag);
        wrap.addEventListener('pointercancel', endDrag);
        wrap.addEventListener('lostpointercapture', endDrag);
        wrap.addEventListener('dblclick', event => { event.preventDefault(); pan.x = 0; pan.y = 0; updateTransform(); });
      }
    };
    img.onerror = function () {
      wrap.remove();
      showMissing('影像加载失败', '请检查该病例包中的图片', true);
    };
    wrap.appendChild(img);
    root.appendChild(wrap);
    img.src = image.data;
    return root;
  }
  window.ShieldViewer = Object.freeze({create});
})();
