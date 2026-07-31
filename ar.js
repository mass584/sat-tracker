'use strict';
/*
 * ARビュー
 *  - 背面カメラの映像に、衛星の方向をリアルタイムで重ねる
 *  - 方位センサーが無い環境（PCなど）では方位盤モードにフォールバックする
 *
 * 座標系:
 *   端末座標  x=画面右, y=画面上, z=画面手前（カメラは -z 方向を向く）
 *   世界座標  X=東, Y=北, Z=天頂
 *   deviceorientation の (alpha,beta,gamma) から作る回転行列 R は
 *   「端末座標 → 世界座標」の変換。よって世界→端末は R の転置を使う。
 */

const AR_HFOV = 62 * D2R;              // 背面カメラの水平画角の想定値

const ar = {
  open: false,
  clip: null,
  stream: null,
  raf: 0,
  orient: null,        // { alpha, beta, gamma, absolute }
  heading: null,       // iOS の webkitCompassHeading（真北基準）
  northOffset: 0,      // 手動較正ぶん（度）
  calibMsg: '',        // 較正操作の結果メッセージ
  hasSensor: false,
  canvas: null,
  ctx: null,
};

// ============================================================
// 開閉
// ============================================================
function openAr(clip) {
  ar.clip = clip;
  ar.open = true;
  ar.calibMsg = '';
  ar.canvas = $('arCanvas');
  ar.ctx = ar.canvas.getContext('2d');
  $('arOverlay').hidden = false;
  $('arTitle').textContent = `${satNameByCatnr(clip.catnr, clip.sat)} — ${obsPlaceLabel(clip.obs)}`;
  document.body.classList.add('ar-open');

  // 描画を先に始める。カメラと方位センサーの許可待ちで
  // 画面が真っ暗のまま止まらないよう、いずれも待たない
  resizeAr();
  arLoop();
  requestOrientation();
  startCamera();
}

function closeAr() {
  ar.open = false;
  cancelAnimationFrame(ar.raf);
  if (ar.stream) { ar.stream.getTracks().forEach((t) => t.stop()); ar.stream = null; }
  $('arVideo').srcObject = null;
  $('arOverlay').hidden = true;
  document.body.classList.remove('ar-open');
  window.removeEventListener('deviceorientationabsolute', onOrient);
  window.removeEventListener('deviceorientation', onOrient);
}

async function startCamera() {
  const video = $('arVideo');
  try {
    ar.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } }, audio: false,
    });
    video.srcObject = ar.stream;
    await video.play();
    video.hidden = false;
  } catch (e) {
    // カメラが無い / 拒否された場合も、方位表示だけで使えるようにする
    video.hidden = true;
    console.warn('camera unavailable:', e);
  }
}

async function requestOrientation() {
  // iOS 13+ はユーザー操作起点での許可要求が必要
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      await DeviceOrientationEvent.requestPermission();
    }
  } catch (e) { console.warn('orientation permission:', e); }

  window.addEventListener('deviceorientationabsolute', onOrient, true);
  window.addEventListener('deviceorientation', onOrient, true);
}

function onOrient(e) {
  if (e.alpha === null && e.webkitCompassHeading === undefined) return;
  ar.hasSensor = true;
  ar.orient = { alpha: e.alpha || 0, beta: e.beta || 0, gamma: e.gamma || 0, absolute: !!e.absolute };
  if (typeof e.webkitCompassHeading === 'number') ar.heading = e.webkitCompassHeading;
}

function resizeAr() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth, h = window.innerHeight;
  ar.canvas.width = Math.round(w * dpr);
  ar.canvas.height = Math.round(h * dpr);
  ar.canvas.style.width = w + 'px';
  ar.canvas.style.height = h + 'px';
  ar.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ============================================================
// 姿勢の計算
// ============================================================
// W3C deviceorientation の回転行列（端末座標 → 世界座標, 行優先）
function orientationMatrix(alphaDeg, betaDeg, gammaDeg) {
  const a = alphaDeg * D2R, b = betaDeg * D2R, g = gammaDeg * D2R;
  const cA = Math.cos(a), sA = Math.sin(a);
  const cB = Math.cos(b), sB = Math.sin(b);
  const cG = Math.cos(g), sG = Math.sin(g);
  return [
    cA * cG - sA * sB * sG, -cB * sA, cA * sG + cG * sA * sB,
    cG * sA + cA * sB * sG,  cA * cB, sA * sG - cA * cG * sB,
    -cB * sG,                sB,      cB * cG,
  ];
}

// 現在の姿勢を表す回転行列。真北が取れない場合は手動較正ぶんを足す
function currentMatrix() {
  if (!ar.orient) return null;
  let alpha = ar.orient.alpha;
  if (ar.heading !== null) alpha = 360 - ar.heading;      // iOS: 真北基準に変換
  return orientationMatrix(alpha + ar.northOffset, ar.orient.beta, ar.orient.gamma);
}

// 方位・仰角(度) → 世界座標の単位ベクトル（東, 北, 天頂）
function azElToVec(azDeg, elDeg) {
  const az = azDeg * D2R, el = elDeg * D2R;
  return [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)];
}

// 世界座標のベクトルを端末座標へ（R の転置を掛ける）
function worldToDevice(R, v) {
  return [
    R[0] * v[0] + R[3] * v[1] + R[6] * v[2],
    R[1] * v[0] + R[4] * v[1] + R[7] * v[2],
    R[2] * v[0] + R[5] * v[1] + R[8] * v[2],
  ];
}

// 端末座標 → 画面座標。カメラは -z 方向を向く
function projectToScreen(vDev, w, h) {
  const sa = (screen.orientation?.angle || window.orientation || 0) * D2R;
  const x = vDev[0] * Math.cos(sa) + vDev[1] * Math.sin(sa);
  const y = -vDev[0] * Math.sin(sa) + vDev[1] * Math.cos(sa);
  const depth = -vDev[2];
  const f = (w / 2) / Math.tan(AR_HFOV / 2);
  return { x: w / 2 + f * x / depth, y: h / 2 - f * y / depth, front: depth > 0, sx: x, sy: y };
}

// 較正用の端末ヨー角。
// カメラ軸(-z)の方位は空にかざすと天頂付近で不安定になるため、
// 上を向けても水平に近いままの「画面右方向(端末x軸)」から向きを取り出す。
// 端末を横倒しにするとこの軸が立ってしまうので、その場合は null を返す。
function deviceYaw(R) {
  const east = R[0], north = R[3], up = R[6];        // 端末x軸を世界座標で表したもの
  if (Math.abs(up) > 0.85) return null;
  const az = Math.atan2(east, north) * R2D - 90;
  return ((az % 360) + 360) % 360;
}

// 端末が今どちらを向いているか（方位・仰角）
function devicePointing(R) {
  const e = -R[2], n = -R[5], u = -R[8];        // 端末の -z 軸を世界座標で表したもの
  let az = Math.atan2(e, n) * R2D;
  if (az < 0) az += 360;
  return { az, el: Math.asin(clamp(u, -1, 1)) * R2D };
}

// ============================================================
// 描画
// ============================================================
function arLoop() {
  if (!ar.open) return;
  drawAr();
  ar.raf = requestAnimationFrame(arLoop);
}

function drawAr() {
  const c = ar.ctx, w = window.innerWidth, h = window.innerHeight;
  if (ar.canvas.width !== Math.round(w * (window.devicePixelRatio || 1))) resizeAr();
  c.clearRect(0, 0, w, h);

  const now = new Date();
  const la = lookAnglesAt(ar.clip.obs, now, ar.clip.catnr);
  if (!la) { $('arInfo').textContent = '軌道を計算できません'; return; }

  const R = currentMatrix();
  if (R && ar.hasSensor) drawArTarget(c, w, h, la, R);
  else drawCompassFallback(c, w, h, la);

  drawArTrack(c, w, h, R);
  updateArInfo(la);
}

// 衛星の方向をカメラ映像に重ねる
function drawArTarget(c, w, h, la, R) {
  const p = projectToScreen(worldToDevice(R, azElToVec(la.az, la.el)), w, h);
  const above = la.el >= 0;

  if (p.front && p.x > -200 && p.x < w + 200 && p.y > -200 && p.y < h + 200) {
    c.save();
    c.strokeStyle = above ? '#ffb454' : 'rgba(143,160,196,.7)';
    c.lineWidth = 2.5;
    c.shadowColor = above ? 'rgba(255,180,84,.9)' : 'transparent';
    c.shadowBlur = 14;
    c.beginPath(); c.arc(p.x, p.y, 26, 0, 2 * Math.PI); c.stroke();
    c.beginPath(); c.arc(p.x, p.y, 4, 0, 2 * Math.PI); c.fillStyle = c.strokeStyle; c.fill();
    c.setLineDash([4, 5]);
    c.beginPath(); c.arc(p.x, p.y, 44, 0, 2 * Math.PI); c.stroke();
    c.restore();

    c.fillStyle = above ? '#ffb454' : 'rgba(143,160,196,.9)';
    c.font = '600 13px -apple-system, sans-serif';
    c.textAlign = 'center';
    c.fillText(satNameByCatnr(ar.clip.catnr, ar.clip.sat), p.x, p.y - 54);
    c.fillText(above ? `仰角 ${la.el.toFixed(0)}°` : '地平線の下', p.x, p.y + 66);
    c.textAlign = 'start';
  } else {
    drawOffscreenArrow(c, w, h, p);
  }

  // 画面中央の照準と、端末が向いている方位
  const dp = devicePointing(R);
  c.save();
  c.strokeStyle = 'rgba(255,255,255,.35)';
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(w / 2 - 14, h / 2); c.lineTo(w / 2 + 14, h / 2);
  c.moveTo(w / 2, h / 2 - 14); c.lineTo(w / 2, h / 2 + 14);
  c.stroke();
  c.restore();
  c.fillStyle = 'rgba(255,255,255,.6)';
  c.font = '500 11px -apple-system, sans-serif';
  c.textAlign = 'center';
  c.fillText(`向き ${compass(dp.az)} ${dp.az.toFixed(0)}° / 仰角 ${dp.el.toFixed(0)}°`, w / 2, h / 2 + 34);
  c.textAlign = 'start';
}

// 画面外にいるときは、どちらへ向ければよいか矢印で示す
function drawOffscreenArrow(c, w, h, p) {
  let dx = p.sx, dy = p.sy;
  if (!p.front) { dx = -dx; dy = -dy; }
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = -dy / len;
  const r = Math.min(w, h) * 0.3;
  const x = w / 2 + ux * r, y = h / 2 + uy * r;
  const ang = Math.atan2(uy, ux);

  c.save();
  c.translate(x, y);
  c.rotate(ang);
  c.fillStyle = '#4dd0ff';
  c.shadowColor = 'rgba(77,208,255,.8)';
  c.shadowBlur = 12;
  c.beginPath();
  c.moveTo(26, 0); c.lineTo(-14, 15); c.lineTo(-6, 0); c.lineTo(-14, -15);
  c.closePath(); c.fill();
  c.restore();

  c.fillStyle = '#4dd0ff';
  c.font = '600 13px -apple-system, sans-serif';
  c.textAlign = 'center';
  c.fillText(p.front ? 'この方向へ' : '振り返ってください', w / 2, h / 2 - r - 16);
  c.textAlign = 'start';
}

// 通過の経路全体を点線で重ねる（今から前後に沿って描く）
function drawArTrack(c, w, h, R) {
  if (!R || !ar.hasSensor) return;
  const from = clipStartMs(ar.clip), to = clipEndMs(ar.clip);
  const step = Math.max(10000, (to - from) / 40);
  c.save();
  c.fillStyle = 'rgba(77,208,255,.55)';
  for (let t = from; t <= to; t += step) {
    const la = lookAnglesAt(ar.clip.obs, new Date(t), ar.clip.catnr);
    if (!la || la.el < 0) continue;
    const p = projectToScreen(worldToDevice(R, azElToVec(la.az, la.el)), w, h);
    if (!p.front) continue;
    c.beginPath(); c.arc(p.x, p.y, 2.5, 0, 2 * Math.PI); c.fill();
  }
  c.restore();
}

// 方位センサーが使えない環境向けの方位盤
function drawCompassFallback(c, w, h, la) {
  const cx = w / 2, cy = h / 2 - 20, r = Math.min(w, h) * 0.3;

  c.save();
  c.strokeStyle = 'rgba(143,160,196,.5)';
  c.lineWidth = 1.5;
  c.beginPath(); c.arc(cx, cy, r, 0, 2 * Math.PI); c.stroke();

  c.fillStyle = 'rgba(232,238,252,.8)';
  c.font = '600 13px -apple-system, sans-serif';
  c.textAlign = 'center';
  for (const [label, deg] of [['北', 0], ['東', 90], ['南', 180], ['西', 270]]) {
    const a = (deg - 90) * D2R;
    c.fillText(label, cx + Math.cos(a) * (r + 18), cy + Math.sin(a) * (r + 18) + 5);
  }

  // 仰角は中心からの距離で表す（中心=天頂, 円周=地平線）
  const a = (la.az - 90) * D2R;
  const rr = r * (1 - clamp(la.el, 0, 90) / 90);
  const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;

  c.strokeStyle = 'rgba(77,208,255,.35)';
  c.setLineDash([4, 4]);
  c.beginPath(); c.moveTo(cx, cy); c.lineTo(x, y); c.stroke();
  c.setLineDash([]);

  c.fillStyle = la.el >= 0 ? '#ffb454' : 'rgba(143,160,196,.6)';
  c.shadowColor = 'rgba(255,180,84,.9)';
  c.shadowBlur = la.el >= 0 ? 14 : 0;
  c.beginPath(); c.arc(x, y, 9, 0, 2 * Math.PI); c.fill();
  c.shadowBlur = 0;

  c.fillStyle = 'rgba(232,238,252,.9)';
  c.font = '600 12px -apple-system, sans-serif';
  c.fillText(`${ar.clip.sat} ${compass(la.az)} 仰角 ${la.el.toFixed(0)}°`, x, y - 18);
  c.font = '500 11px -apple-system, sans-serif';
  c.fillStyle = 'rgba(143,160,196,.9)';
  c.fillText('中心が天頂、円周が地平線', cx, cy + r + 42);
  c.textAlign = 'start';
  c.restore();
}

function updateArInfo(la) {
  const now = Date.now();
  const from = clipStartMs(ar.clip), to = clipEndMs(ar.clip);
  let phase;
  if (now < from) phase = `観測開始まで ${fmtDuration(from - now)}`;
  else if (now <= to) phase = `観測中（あと ${fmtDuration(to - now)}）`;
  else phase = 'この観測タイミングは終了しました';

  $('arInfo').innerHTML =
    `<b>${compass(la.az)} 方位 ${la.az.toFixed(0)}° / 仰角 ${la.el.toFixed(0)}°</b>` +
    ` · 距離 ${Math.round(la.range).toLocaleString('ja-JP')} km<br>${phase}`;

  const warn = $('arWarn');
  const auto = ar.heading !== null || ar.orient?.absolute;
  if (ar.calibMsg) {
    warn.textContent = ar.calibMsg;
  } else if (!ar.hasSensor) {
    warn.textContent = 'この端末では方位センサーを利用できないため、方位盤で表示しています。スマートフォンで開くとカメラに重ねて表示します。';
  } else if (!auto) {
    warn.textContent = '方位の絶対値が取得できていません。端末を地平線の方向・北へ向けて「北を合わせる」を押してください。';
  } else if (ar.northOffset !== 0) {
    warn.textContent = `この端末は真北を自動取得できています（手動補正 ${ar.northOffset.toFixed(0)}° が入っています。ずれる場合は「補正リセット」を）。`;
  } else {
    warn.textContent = '';
  }

  $('arCalibReset').hidden = ar.northOffset === 0;
}

// ============================================================
// 起動
// ============================================================
function initAr() {
  $('arClose').addEventListener('click', closeAr);
  $('arCalib').addEventListener('click', () => {
    const R = currentMatrix();
    if (!R) { ar.calibMsg = '方位センサーが使えないため較正できません。'; return; }
    const yaw = deviceYaw(R);
    if (yaw === null) {
      ar.calibMsg = '端末を横倒しにせず、縦に構えたまま北へ向けて押してください。';
      return;
    }
    // 今まさに北を向いているとみなす。方位は alpha の増加に対して減る向きなので足す
    ar.northOffset = (((ar.northOffset + yaw) % 360) + 360) % 360;
    ar.calibMsg = `北を補正しました（補正量 ${ar.northOffset.toFixed(0)}°）。ずれていたら向け直して押し直せます。`;
  });

  $('arCalibReset').addEventListener('click', () => {
    ar.northOffset = 0;
    ar.calibMsg = '補正を取り消し、センサーの値をそのまま使う状態に戻しました。';
  });
  window.addEventListener('resize', () => { if (ar.open) resizeAr(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ar.open) closeAr(); });
}
