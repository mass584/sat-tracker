'use strict';
/*
 * Sat Tracker
 *  - 位置・タイミング計算: CelesTrak の TLE を SGP4 (satellite.js) で伝播して計算
 *  - 明るさ: 標準等級と位相角・距離・大気減光から見かけの等級を求める
 *  - 健全性チェック: wheretheiss.at の実測値と現在位置を照合（ISSのみ）
 */

// ============================================================
// 定数・ユーティリティ
// ============================================================
const EARTH_R = 6378.137;                 // km
const ISS_ID = '25544';
// CelesTrak の "visual" 群＝肉眼で見える明るさの人工天体（約157個）
const TLE_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=TLE';
const REF_URL = 'https://api.wheretheiss.at/v1/satellites/25544';   // 計算値の照合用（ISSのみ）
const TLE_CACHE_KEY = 'sat-tle-cache-v2';
const TLE_CACHE_MS = 6 * 3600 * 1000;
const OBS_KEY = 'sat-observer-v1';
const SAT_KEY = 'sat-selected-v1';

// よく知られた対象は日本語名と短縮ラベルを与え、選択肢の先頭に固定する
// jp: 選択肢に出す説明つきの名前 / full: 画面各所に出す呼称（和名＋略称）
const FEATURED = {
  '25544': { jp: '国際宇宙ステーション ISS',       full: '国際宇宙ステーション ISS',      note: '最も明るい（最大−4等）' },
  '48274': { jp: '中国宇宙ステーション 天和 CSS',  full: '中国宇宙ステーション 天和 CSS', note: 'ISSに次ぐ明るさ' },
  '20580': { jp: 'ハッブル宇宙望遠鏡 HST',         full: 'ハッブル宇宙望遠鏡 HST',        note: '低緯度地域から見やすい' },
  '27386': { jp: 'エンビサット（退役・大型）',      full: 'エンビサット ENVISAT',          note: '大型で明るいが姿勢制御なし' },
  '25994': { jp: 'テラ（地球観測衛星）',            full: 'テラ TERRA',                    note: '' },
  '27424': { jp: 'アクア（地球観測衛星）',          full: 'アクア AQUA',                   note: '' },
  '16908': { jp: 'あじさい（測地実験衛星）',        full: 'あじさい AJISAI',               note: '鏡面反射で閃光を放つ' },
  '39766': { jp: 'だいち2号 ALOS-2',               full: 'だいち2号 ALOS-2',              note: '' },
};
const FEATURED_ORDER = ['25544', '48274', '20580', '27386', '25994', '27424', '16908', '39766'];

// 標準等級（距離1000km・半分が照らされた状態での明るさ）。
// 観測者コミュニティで使われている概算値で、確度が高いのはISSくらい。
// ここに無い対象は等級を計算せず、幾何条件だけで可視判定する。
const STD_MAG = {
  '25544': -1.8,   // ISS
  '48274': -0.5,   // CSS 天和
  '20580': 1.5,    // ハッブル
  '27386': 1.7,    // エンビサット
  '25994': 2.4,    // テラ
  '27424': 2.4,    // アクア
  '16908': 2.5,    // あじさい（鏡面反射で瞬間的にこれより明るく光ることがある）
  '39766': 2.7,    // だいち2号
};

// 空の条件ごとの、肉眼で見える限界等級
const SKY_LIMITS = { city: 3.0, suburb: 4.5, dark: 5.5 };

// ネットワークが全滅したときの最終フォールバック（元期から離れるほど誤差が増える）
const FALLBACK_TLE = [{
  catnr: '25544',
  name: 'ISS (ZARYA)',
  line1: '1 25544U 98067A   26211.86173118  .00009023  00000+0  17005-3 0  9996',
  line2: '2 25544  51.6314  83.9591 0007096 355.3737   4.7185 15.49272805578527',
}];

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const $ = (id) => document.getElementById(id);

function normLonDeg(lon) {
  let l = ((lon + 180) % 360 + 360) % 360 - 180;
  return l;
}

function fmtLat(v) { return `${Math.abs(v).toFixed(3)}° ${v >= 0 ? 'N' : 'S'}`; }
function fmtLon(v) { return `${Math.abs(v).toFixed(3)}° ${v >= 0 ? 'E' : 'W'}`; }

// 「現在地」「選択地点」は選び方を表すだけで場所を特定しない。
// 地名として通用するラベルを持つかどうかを判定する
function isNamedPlace(obs) {
  const named = obs.kind ? obs.kind === 'preset' : !['現在地', '選択地点', ''].includes(obs.label || '');
  return named && !!obs.label;
}

// 保存した記録に出す地点表記。地名でなければ座標に置き換える
function obsPlaceLabel(obs) {
  if (isNamedPlace(obs)) return obs.label;
  return `${Math.abs(obs.lat).toFixed(2)}°${obs.lat >= 0 ? 'N' : 'S'} ` +
         `${Math.abs(obs.lon).toFixed(2)}°${obs.lon >= 0 ? 'E' : 'W'}`;
}

const COMPASS = ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東',
                 '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'];
function compass(azDeg) {
  const i = Math.round(((azDeg % 360) + 360) % 360 / 22.5) % 16;
  return COMPASS[i];
}

function fmtClock(d) {
  return d.toLocaleTimeString('ja-JP', { hour12: false });
}
function fmtHM(d) {
  return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function fmtDay(d) {
  return d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' });
}
function fmtDateTime(d) {
  return d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short',
                                     hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return rs ? `${m}分${rs}秒` : `${m}分`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return `${h}時間${rm}分`;
  return `${Math.floor(h / 24)}日${h % 24}時間`;
}
function toLocalInputValue(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 2点間の大円距離 (km)
function greatCircleKm(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * D2R, φ2 = lat2 * D2R;
  const dφ = (lat2 - lat1) * D2R, dλ = (lon2 - lon1) * D2R;
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ============================================================
// 太陽（低精度モデル：地図の昼夜と可視判定に十分な精度）
// ============================================================
function sunEci(date) {                    // 赤道座標系での太陽位置 (km)
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = ((280.460 + 0.9856474 * n) % 360) * D2R;
  const g = ((357.528 + 0.9856003 * n) % 360) * D2R;
  const lam = L + 1.915 * D2R * Math.sin(g) + 0.020 * D2R * Math.sin(2 * g);
  const eps = (23.439 - 0.0000004 * n) * D2R;
  const R = (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g)) * 149597870.7;
  return { x: R * Math.cos(lam), y: R * Math.cos(eps) * Math.sin(lam), z: R * Math.sin(eps) * Math.sin(lam) };
}

// 太陽直下点（緯度=赤緯, 経度）— ラジアン
function subsolar(date, gmst) {
  const s = sunEci(date);
  const r = Math.hypot(s.x, s.y, s.z);
  const dec = Math.asin(s.z / r);
  const lon = Math.atan2(s.y, s.x) - gmst;
  return { dec, lon: Math.atan2(Math.sin(lon), Math.cos(lon)) };
}

// 地表の任意点における太陽高度 (deg)
function sunElevationDeg(latDeg, lonDeg, sub) {
  const φ = latDeg * D2R, dλ = lonDeg * D2R - sub.lon;
  return Math.asin(clamp(Math.sin(φ) * Math.sin(sub.dec) +
                         Math.cos(φ) * Math.cos(sub.dec) * Math.cos(dλ), -1, 1)) * R2D;
}

// 衛星が太陽光を浴びているか（円筒影モデル）
function isSunlit(eci, date) {
  const s = sunEci(date);
  const sr = Math.hypot(s.x, s.y, s.z);
  const ux = s.x / sr, uy = s.y / sr, uz = s.z / sr;
  const d = eci.x * ux + eci.y * uy + eci.z * uz;
  if (d > 0) return true;                                   // 昼側にいる
  const r2 = eci.x ** 2 + eci.y ** 2 + eci.z ** 2;
  return Math.sqrt(Math.max(0, r2 - d * d)) > EARTH_R;      // 影の円筒の外か
}

// ============================================================
// 見かけの明るさ（等級）
// ============================================================
const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const sub3 = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const norm3 = (a) => Math.hypot(a.x, a.y, a.z);

// 大気減光に使う大気路程（Pickering の近似）
function airmass(elDeg) {
  const h = Math.max(elDeg, 0) * D2R;
  return 1 / (Math.sin(h) + 0.025 * Math.exp(-11 * Math.sin(h)));
}

// 見かけの等級。標準等級が分かっている対象のみ計算する（不明なら null）
//   mag = 標準等級 − 15.75 + 2.5·log10(距離² / 位相関数) + 大気減光
// 位相関数は太陽・衛星・観測者のなす角（位相角）から求める。
function apparentMagnitude(catnr, st, obsGd, elDeg, rangeKm) {
  const std = STD_MAG[String(catnr)];
  if (std === undefined) return null;

  const satEcf = satellite.eciToEcf(st.eci, st.gmst);
  const sunEcf = satellite.eciToEcf(sunEci(st.date), st.gmst);
  const obsEcf = satellite.geodeticToEcf(obsGd);

  const toSun = sub3(sunEcf, satEcf), toObs = sub3(obsEcf, satEcf);
  const cosPhase = clamp(dot3(toSun, toObs) / (norm3(toSun) * norm3(toObs)), -1, 1);
  const phaseFn = Math.max((1 + cosPhase) / 2, 1e-3);     // 満月型の単純な位相関数

  return std - 15.75 + 2.5 * Math.log10((rangeKm * rangeKm) / phaseFn)
             + 0.28 * (airmass(elDeg) - 1);               // 低空ほど暗くなる分
}

const fmtMag = (m) => `${m <= 0 ? '−' : ''}${Math.abs(m).toFixed(1)}等`;

// 等級から色を作る。透明度だけでは差が出ないので、色相・彩度・明度も動かす。
// 明るいものは白に近い黄、暗くなるほど彩度を落として沈ませる。
const MAG_STOPS = [
  { m: -2.0, h: 50, s: 100, l: 80 },   // −2等：ほぼ白い黄
  { m:  0.0, h: 40, s: 100, l: 66 },   //  0等：明るいオレンジ
  { m:  2.0, h: 30, s:  75, l: 52 },   //  2等：くすんだ橙
  { m:  3.5, h: 24, s:  40, l: 44 },   //  3.5等：茶色寄り
  { m:  5.0, h: 20, s:  14, l: 38 },   //  5等：ほぼ無彩色
];

function magHsl(m, alpha) {
  if (m === null || m === undefined) return `hsla(30, 35%, 52%, ${alpha})`;
  const v = clamp(m, MAG_STOPS[0].m, MAG_STOPS[MAG_STOPS.length - 1].m);
  let a = MAG_STOPS[0], b = MAG_STOPS[1];
  for (let i = 0; i < MAG_STOPS.length - 1; i++) {
    if (v >= MAG_STOPS[i].m && v <= MAG_STOPS[i + 1].m) { a = MAG_STOPS[i]; b = MAG_STOPS[i + 1]; break; }
  }
  const t = (v - a.m) / (b.m - a.m);
  const mix = (p, q) => Math.round(p + (q - p) * t);
  return `hsla(${mix(a.h, b.h)}, ${mix(a.s, b.s)}%, ${mix(a.l, b.l)}%, ${alpha})`;
}

// 可視カードの見た目。明るいものほど縦線を太く、光っているように見せる
function magStyles(m) {
  const bright = m !== null && m !== undefined && m <= 0.5;
  return {
    card: `border-left-color:${magHsl(m, 1)};border-left-width:${bright ? 5 : 3}px` +
          (bright ? `;box-shadow:inset 3px 0 12px -4px ${magHsl(m, .85)}` : ''),
    tag: `color:${magHsl(m, 1)};border-color:${magHsl(m, .55)};background:${magHsl(m, .14)}`,
  };
}

// ============================================================
// 軌道要素（TLE）
// ============================================================
let satrec = null;
let catalog = [];              // 追跡可能な衛星の一覧
let current = null;            // 選択中の衛星
let tleInfo = { source: '', epoch: null };

// TLE の準備完了を待つためのプロミス（読み込み前に予報ボタンを押されても正しく動くように）
let resolveTleReady;
const tleReady = new Promise((r) => { resolveTleReady = r; });

function tleEpoch(line1) {
  const yy = parseInt(line1.substring(18, 20), 10);
  const doy = parseFloat(line1.substring(20, 32));
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  return new Date(Date.UTC(year, 0, 1) + (doy - 1) * 86400000);
}

// 3行1組のTLEテキストを配列に分解する
function parseTleSet(text) {
  const lines = text.trim().split('\n').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].startsWith('1 ') || !lines[i + 1].startsWith('2 ')) continue;
    const line1 = lines[i], line2 = lines[i + 1];
    const name = (i > 0 && !lines[i - 1].startsWith('1 ') && !lines[i - 1].startsWith('2 '))
      ? lines[i - 1] : `NORAD ${line1.substring(2, 7).trim()}`;
    out.push({ catnr: String(parseInt(line1.substring(2, 7), 10)), name, line1, line2 });
  }
  return out;
}

function satLabel(sat) {
  const f = FEATURED[sat.catnr];
  return f ? f.jp : sat.name;
}
// 画面に出す衛星の呼称。略称だけにせず、和名を含めてそのまま表示する
function satName(sat) {
  const f = FEATURED[sat.catnr];
  return f ? f.full : sat.name;
}

// 保存済みデータからも引けるように、カタログ番号から呼称を求める
function satNameByCatnr(catnr, fallback) {
  const sat = catalog.find((s) => s.catnr === String(catnr));
  return sat ? satName(sat) : (fallback || `NORAD ${catnr}`);
}

// 選択中の衛星を切り替える
function selectSat(catnr, opts) {
  const sat = catalog.find((s) => s.catnr === String(catnr))
           || catalog.find((s) => s.catnr === ISS_ID) || catalog[0];
  if (!sat) return;
  current = sat;
  satrec = satellite.twoline2satrec(sat.line1, sat.line2);
  tleInfo.epoch = tleEpoch(sat.line1);
  try { localStorage.setItem(SAT_KEY, sat.catnr); } catch (_) { /* ignore */ }

  $('satSelect').value = sat.catnr;
  $('satNameCard').textContent = satName(sat);
  renderTleStatus();
  render();

  // すでに予報を出していれば、新しい対象で計算し直す
  if (!opts?.silent && state.passes) runPrediction();
}

function buildSatSelect() {
  const sel = $('satSelect');
  sel.innerHTML = '';
  // 選べるのは「主な対象」だけ。visual群の残りは名前解決のためにカタログには残す
  for (const id of FEATURED_ORDER) {
    const s = catalog.find((x) => x.catnr === id);
    if (!s) continue;
    const o = document.createElement('option');
    o.value = s.catnr;
    o.textContent = satLabel(s);
    o.title = `NORAD ${s.catnr}${FEATURED[s.catnr].note ? ' — ' + FEATURED[s.catnr].note : ''}`;
    sel.appendChild(o);
  }
}

function renderTleStatus() {
  if (!tleInfo.epoch) return;
  const ageDays = (Date.now() - tleInfo.epoch.getTime()) / 86400000;
  const stale = Math.abs(ageDays) > 5;
  const age = Math.abs(ageDays) < 1
    ? `${Math.round(Math.abs(ageDays) * 24)}時間前`
    : `${Math.abs(ageDays).toFixed(1)}日前`;

  const ref = refCheckRow();

  // 元期が古い、または実測とのずれが大きいときだけアイコンを警告色にする
  const icon = $('btnInfo');
  const warn = stale || !!(ref && ref.err);
  icon.classList.toggle('err', warn);
  icon.title = stale ? `技術情報（TLEの元期が${age}と古くなっています）`
             : (ref && ref.err) ? `技術情報（実測とのずれが大きくなっています）`
             : '技術情報';

  const rows = [
    ['追跡対象', current ? `${satLabel(current)}（NORAD ${current.catnr}）` : '–'],
    ['軌道要素', tleInfo.source],
    ['元期', `${tleInfo.epoch.toLocaleString('ja-JP', { hour12: false })}（${age}）`],
    ['周回周期', `${orbitPeriodMin().toFixed(1)} 分`],
    ['伝播モデル', 'SGP4 / satellite.js v5'],
  ];
  if (ref) rows.push(['実測との照合', `<span class="${ref.err ? 'err' : 'ok'}">${ref.text}</span>`]);
  $('infoBody').innerHTML = rows.map(([k, v]) =>
    `<div><dt>${k}</dt><dd class="${k === '元期' && stale ? 'err' : ''}">${v}</dd></div>`).join('');
}

function useCatalog(list, source) {
  catalog = list;
  tleInfo.source = source;
  buildSatSelect();
  let want = ISS_ID;
  try { want = localStorage.getItem(SAT_KEY) || ISS_ID; } catch (_) { /* ignore */ }
  if (!FEATURED[want]) want = ISS_ID;          // 選択肢に無いものが保存されていた場合
  selectSat(want, { silent: true });
  resolveTleReady();
}

async function loadTle() {
  const cached = () => { try { return JSON.parse(localStorage.getItem(TLE_CACHE_KEY) || 'null'); } catch (_) { return null; } };

  // 1) キャッシュ（6時間以内なら再利用）
  const c = cached();
  if (c && Date.now() - c.fetchedAt < TLE_CACHE_MS && c.list?.length) {
    useCatalog(c.list, 'CelesTrak visual (キャッシュ)');
    return;
  }

  // 2) CelesTrak から取得
  try {
    const res = await fetch(TLE_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const list = parseTleSet(await res.text());
    if (!list.length) throw new Error('TLE parse');
    try { localStorage.setItem(TLE_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), list })); } catch (_) { /* 容量超過は無視 */ }
    useCatalog(list, 'CelesTrak visual');
    return;
  } catch (e) {
    console.warn('TLE fetch failed:', e);
  }

  // 3) 期限切れキャッシュ → 内蔵TLE
  if (c?.list?.length) { useCatalog(c.list, 'CelesTrak visual (期限切れキャッシュ)'); return; }
  useCatalog(FALLBACK_TLE, '内蔵の予備データ（取得失敗・ISSのみ）');
  $('tleStatus').classList.add('err');
}

// ============================================================
// 伝播
// ============================================================
// 選択中以外の衛星も計算できるよう satrec をキャッシュする
const satrecCache = {};
function satrecFor(catnr) {
  if (!catnr || (current && String(catnr) === current.catnr)) return satrec;
  const key = String(catnr);
  if (!satrecCache[key]) {
    const sat = catalog.find((s) => s.catnr === key);
    if (!sat) return null;
    satrecCache[key] = satellite.twoline2satrec(sat.line1, sat.line2);
  }
  return satrecCache[key];
}

// 観測地点から見た指定衛星の方位・仰角・距離（ARビューから使う）
function lookAnglesAt(obs, date, catnr) {
  const st = stateAt(date, satrecFor(catnr));
  if (!st) return null;
  const obsGd = { longitude: obs.lon * D2R, latitude: obs.lat * D2R, height: 0 };
  const la = satellite.ecfToLookAngles(obsGd, satellite.eciToEcf(st.eci, st.gmst));
  return { az: la.azimuth * R2D, el: la.elevation * R2D, range: la.rangeSat, st };
}

function stateAt(date, rec) {
  const use = rec || satrec;
  if (!use) return null;
  let pv;
  try { pv = satellite.propagate(use, date); } catch (_) { return null; }
  if (!pv || !pv.position) return null;
  const gmst = satellite.gstime(date);
  const gd = satellite.eciToGeodetic(pv.position, gmst);
  return {
    date, gmst,
    lat: satellite.degreesLat(gd.latitude),
    lon: satellite.degreesLong(gd.longitude),
    alt: gd.height,
    eci: pv.position,
    vel: pv.velocity,
  };
}

// 平均運動（rad/分）から周回周期を求める
function orbitPeriodMin() {
  return satrec && satrec.no ? (2 * Math.PI) / satrec.no : 93;
}

function groundTrack(centerDate, minutesBack, minutesFwd, stepSec) {
  const pts = [];
  const t0 = centerDate.getTime();
  for (let m = -minutesBack * 60; m <= minutesFwd * 60; m += stepSec) {
    const st = stateAt(new Date(t0 + m * 1000));
    if (st) pts.push({ t: m, lat: st.lat, lon: st.lon });
  }
  return pts;
}

// ============================================================
// アプリ状態
// ============================================================
const state = {
  live: true,
  playing: false,
  speed: 60,
  baseMs: Date.now(),
  offsetMin: 0,
  observer: null,          // { lat, lon, label }
  refSample: null,         // 照合用APIの直近レスポンス
  refError: null,
  passes: null,
};

function currentDate() { return new Date(state.baseMs + state.offsetMin * 60000); }

// ============================================================
// 地図描画
// ============================================================
const MAP_REPEAT = [-360, 0, 360];

const canvas = $('map');
const ctx = canvas.getContext('2d');
let W = 0, H = 0;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.parentElement.clientWidth;
  const cssH = Math.round(cssW / 2);
  canvas.style.height = cssH + 'px';
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  W = cssW; H = cssH;
}

// 画面中央に来る経度は -panLon。既定は日本付近（東経140度）を中心にする
const DEFAULT_PAN_LON = -140;
let panLon = DEFAULT_PAN_LON;         // 地図の横スクロール量（度）。経度は周期的なので剰余で扱う
const px = (lon) => (lon + 180 + panLon) / 360 * W;
const py = (lat) => (90 - lat) / 180 * H;
// 点で置くもの（マーカーやラベル）は画面内へ折り返す
const pxw = (lon) => { const x = px(lon) % W; return x < 0 ? x + W : x; };

// 経度の折り返しを解消した配列にする（描画時に ±360 ずらして3回描く）
function unwrap(points) {
  const out = [];
  let shift = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) {
      const d = points[i].lon - points[i - 1].lon;
      if (d > 180) shift -= 360;
      else if (d < -180) shift += 360;
    }
    out.push({ lat: points[i].lat, lon: points[i].lon + shift });
  }
  return out;
}

function tracePath(pts, offset) {
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x = px(pts[i].lon + offset), y = py(pts[i].lat);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
}

function drawPolyline(pts, style, width, dash) {
  const u = unwrap(pts);
  ctx.save();
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.setLineDash(dash || []);
  for (const off of MAP_REPEAT) { tracePath(u, off); ctx.stroke(); }
  ctx.restore();
}

function drawBackground() {
  ctx.fillStyle = '#0a1120';
  ctx.fillRect(0, 0, W, H);

  // 経緯線
  ctx.strokeStyle = 'rgba(90,120,170,.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const off of MAP_REPEAT) {
    for (let lon = -180; lon < 180; lon += 30) { ctx.moveTo(px(lon + off), 0); ctx.lineTo(px(lon + off), H); }
  }
  for (let lat = -60; lat <= 60; lat += 30) { ctx.moveTo(0, py(lat)); ctx.lineTo(W, py(lat)); }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(90,120,170,.28)';
  ctx.beginPath();
  ctx.moveTo(0, py(0)); ctx.lineTo(W, py(0));
  ctx.stroke();

  // 陸地（経度は周期的なので、前後にもう1枚ずつ描いて継ぎ目をなくす）
  ctx.fillStyle = '#1c2c46';
  ctx.strokeStyle = '#31486e';
  ctx.lineWidth = 0.6;
  for (const off of MAP_REPEAT) {
    for (const ring of window.WORLD_LAND) {
      ctx.beginPath();
      for (let i = 0; i < ring.length; i++) {
        const x = px(ring[i][0] + off), y = py(ring[i][1]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
}

// 太陽高度 h(rad) の等高度線の緯度を、指定経度差について解く
function terminatorLat(hRad, dec, dLon) {
  const A = Math.sin(dec), B = Math.cos(dec) * Math.cos(dLon);
  const R = Math.hypot(A, B);
  const s = Math.sin(hRad) / R;
  if (Math.abs(s) > 1) return null;                 // その子午線上に交点なし
  const phi = Math.atan2(B, A);
  for (const cand of [Math.asin(s) - phi, Math.PI - Math.asin(s) - phi]) {
    const lat = Math.atan2(Math.sin(cand), Math.cos(cand));   // [-π, π] に正規化
    if (lat >= -Math.PI / 2 - 1e-9 && lat <= Math.PI / 2 + 1e-9) return lat * R2D;
  }
  return null;
}

// 太陽高度が hDeg 未満の領域を塗る
function fillDarkerThan(sub, hDeg, fill) {
  let dec = sub.dec;
  if (Math.abs(dec) < 0.1 * D2R) dec = (dec >= 0 ? 1 : -1) * 0.1 * D2R;   // 分点付近の特異点回避
  const darkPole = dec > 0 ? -90 : 90;
  const litPole = -darkPole;
  const h = hDeg * D2R;
  const step = 2;

  const bound = [];
  for (let lon = -180; lon <= 180; lon += step) {
    let lat = terminatorLat(h, dec, lon * D2R - sub.lon);
    if (lat === null) {
      // 交点が無い＝この子午線は全て明るいか全て暗い
      const elAtMax = sunElevationDeg(dec * R2D, lon, sub);
      lat = elAtMax < hDeg ? litPole : darkPole;
    }
    bound.push({ lon, lat });
  }

  ctx.save();
  ctx.fillStyle = fill;
  for (const off of MAP_REPEAT) {
    ctx.beginPath();
    ctx.moveTo(px(bound[0].lon + off), py(bound[0].lat));
    for (const b of bound) ctx.lineTo(px(b.lon + off), py(b.lat));
    ctx.lineTo(px(180 + off), py(darkPole));
    ctx.lineTo(px(-180 + off), py(darkPole));
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawFootprint(lat, lon, altKm) {
  const theta = Math.acos(EARTH_R / (EARTH_R + altKm));       // 地平線までの中心角
  const φ0 = lat * D2R, λ0 = lon * D2R;
  const pts = [];
  for (let b = 0; b <= 360; b += 3) {
    const br = b * D2R;
    const φ = Math.asin(Math.sin(φ0) * Math.cos(theta) + Math.cos(φ0) * Math.sin(theta) * Math.cos(br));
    const λ = λ0 + Math.atan2(Math.sin(br) * Math.sin(theta) * Math.cos(φ0),
                              Math.cos(theta) - Math.sin(φ0) * Math.sin(φ));
    pts.push({ lat: φ * R2D, lon: normLonDeg(λ * R2D) });
  }
  const u = unwrap(pts);
  ctx.save();
  ctx.fillStyle = 'rgba(77,208,255,.10)';
  ctx.strokeStyle = 'rgba(77,208,255,.45)';
  ctx.lineWidth = 1;
  for (const off of MAP_REPEAT) { tracePath(u, off); ctx.closePath(); ctx.fill(); ctx.stroke(); }
  ctx.restore();
}

// マーカーの脇にラベルを置く（右端に近い場合は左側へ反転）
function drawLabel(x, y, text, color, font, offX, offY) {
  ctx.font = font;
  const w = ctx.measureText(text).width;
  let tx = x + offX;
  if (tx + w > W - 4) tx = x - offX - w;
  ctx.fillStyle = color;
  ctx.fillText(text, tx, y + offY);
}

// 地図上の緯度経度に、背景から浮くようにラベルを置く
function drawMapLabel(lat, lon, text, color, align, dy) {
  const x = pxw(normLonDeg(lon)), y = py(lat) + (dy || 0);
  ctx.save();
  ctx.font = '600 10.5px -apple-system, sans-serif';
  ctx.shadowColor = 'rgba(4,8,20,.95)';
  ctx.shadowBlur = 5;
  ctx.fillStyle = color;
  if (align === 'center') {
    ctx.textAlign = 'center';
    ctx.fillText(text, x, y + 14);
  } else {
    const w = ctx.measureText(text).width;
    ctx.fillText(text, x + w + 10 > W ? x - w - 8 : x + 8, y - 6);
  }
  ctx.restore();
}

function drawSubsolar(sub) {
  const x = pxw(sub.lon * R2D), y = py(sub.dec * R2D);
  ctx.save();
  ctx.shadowColor = 'rgba(255,214,102,.9)';
  ctx.shadowBlur = 10;
  ctx.fillStyle = 'rgba(255,214,102,.9)';
  ctx.beginPath(); ctx.arc(x, y, 3.5, 0, 2 * Math.PI); ctx.fill();
  ctx.restore();
  drawLabel(x, y, '太陽直下点', 'rgba(255,214,102,.8)', '500 10px -apple-system, sans-serif', 8, 3);
}

function drawIss(lat, lon, sunlit) {
  const x = pxw(lon), y = py(lat);
  ctx.save();
  ctx.shadowColor = sunlit ? 'rgba(255,200,90,.9)' : 'rgba(120,170,255,.8)';
  ctx.shadowBlur = 14;
  ctx.fillStyle = sunlit ? '#ffd166' : '#9fc2ff';
  ctx.beginPath(); ctx.arc(x, y, 5, 0, 2 * Math.PI); ctx.fill();
  ctx.restore();

  ctx.strokeStyle = 'rgba(255,255,255,.85)';
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(x, y, 9, 0, 2 * Math.PI); ctx.stroke();

  drawLabel(x, y, current ? satName(current) : '衛星', 'rgba(232,238,252,.9)',
            '600 11px -apple-system, sans-serif', 13, 4);
}

function drawObserver(obs) {
  const x = pxw(obs.lon), y = py(obs.lat);
  ctx.save();
  ctx.strokeStyle = '#5ce08a';
  ctx.fillStyle = 'rgba(92,224,138,.25)';
  ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.arc(x, y, 5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 9, y); ctx.lineTo(x + 9, y);
  ctx.moveTo(x, y - 9); ctx.lineTo(x, y + 9);
  ctx.stroke();
  ctx.restore();
  drawLabel(x, y, obs.label || '観測地点', '#5ce08a', '600 11px -apple-system, sans-serif', 12, -8);
}

function drawMap(st) {
  drawBackground();

  const sub = subsolar(st.date, st.gmst);
  fillDarkerThan(sub, 0, 'rgba(4,8,20,.55)');      // 夜
  fillDarkerThan(sub, -12, 'rgba(4,8,20,.35)');    // 天文薄明より暗い側を少し濃く

  drawSubsolar(sub);

  // 軌跡は前後あわせて1周回分（周期は衛星ごとに異なる）
  const half = orbitPeriodMin() / 2;
  const track = groundTrack(st.date, half, half, 30);
  const past = track.filter((p) => p.t <= 0);
  const future = track.filter((p) => p.t >= 0);
  drawPolyline(past, 'rgba(74,111,160,.9)', 1.6);
  drawPolyline(future, 'rgba(77,208,255,.95)', 1.8, [6, 4]);

  drawFootprint(st.lat, st.lon, st.alt);

  // 凡例を置く代わりに、地図上の要素へ直接ラベルを添える
  // 極軌道では軌跡の両端が近づくので、上下にずらして重ならないようにする
  if (past.length) drawMapLabel(past[0].lat, past[0].lon, '過去の軌跡', 'rgba(140,175,220,.95)', null, 16);
  if (future.length) {
    const f = future[future.length - 1];
    drawMapLabel(f.lat, f.lon, '未来の軌跡', 'rgba(77,208,255,.95)', null, -8);
  }
  const footEdge = Math.acos(EARTH_R / (EARTH_R + st.alt)) * R2D;
  drawMapLabel(clamp(st.lat - footEdge, -88, 88), st.lon, '可視円', 'rgba(77,208,255,.75)', 'center');
  if (state.observer) drawObserver(state.observer);
  drawIss(st.lat, st.lon, isSunlit(st.eci, st.date));
}

// 陸か海かの判定（Natural Earth 110m の陸ポリゴンに対する内外判定）
function isOverLand(lat, lon) {
  for (const ring of window.WORLD_LAND) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (Math.abs(xi - xj) > 180) continue;               // 日付変更線をまたぐ辺は無視
      if ((yi > lat) !== (yj > lat) &&
          lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

// ============================================================
// ステータス表示
// ============================================================
function lookAngles(obs, st) {
  const obsGd = { longitude: obs.lon * D2R, latitude: obs.lat * D2R, height: 0 };
  const ecf = satellite.eciToEcf(st.eci, st.gmst);
  const la = satellite.ecfToLookAngles(obsGd, ecf);
  return { az: la.azimuth * R2D, el: la.elevation * R2D, range: la.rangeSat };
}

function renderStatus(st) {
  $('sLat').textContent = fmtLat(st.lat);
  $('sLon').textContent = fmtLon(st.lon);
  $('sAlt').textContent = `${st.alt.toFixed(1)} km`;
  const v = Math.hypot(st.vel.x, st.vel.y, st.vel.z) * 3600;
  $('sVel').textContent = `${Math.round(v).toLocaleString('ja-JP')} km/h`;
  $('sPlace').textContent = isOverLand(st.lat, st.lon) ? '陸上' : '海上';

  const sub = subsolar(st.date, st.gmst);
  const sunlit = isSunlit(st.eci, st.date);
  const groundSun = sunElevationDeg(st.lat, st.lon, sub);
  $('sSun').textContent = sunlit ? '☀ 日照中' : '🌑 地球の影';
  $('sSun').title = `直下点の太陽高度 ${groundSun.toFixed(1)}°`;
}

function renderClock(d) {
  $('clockLocal').textContent = `${d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' })}  ${fmtClock(d)}`;

  const off = state.offsetMin * 60000 + (state.baseMs - Date.now());
  const lab = $('offsetLabel');
  if (Math.abs(off) < 2000) lab.textContent = state.live ? '現在時刻' : '現在時刻とほぼ同じ';
  else lab.textContent = off > 0 ? `今から ${fmtDuration(off)} 後` : `今から ${fmtDuration(-off)} 前`;
}

// ============================================================
// 計算値の健全性チェック（実測APIとの照合）
// ============================================================
async function pollReference() {
  if (current && current.catnr !== ISS_ID) return;      // 照合できるのはISSだけ
  try {
    const res = await fetch(REF_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    state.refSample = { lat: j.latitude, lon: j.longitude, fetchedAt: Date.now() };
    state.refError = null;
  } catch (e) {
    state.refSample = null;
    state.refError = e.message || String(e);
  }
  renderTleStatus();
}

// 計算値の健全性チェックの結果。技術情報ダイアログに1行として出す（ISS選択時のみ）
function refCheckRow() {
  if (!current || current.catnr !== ISS_ID) return null;
  if (state.refError) return { text: `接続できません（${state.refError}）`, err: true };
  const r = state.refSample;
  if (!r) return null;
  const calc = stateAt(new Date(r.fetchedAt));
  if (!calc) return null;
  const d = greatCircleKm(r.lat, r.lon, calc.lat, calc.lon);
  return {
    text: `wheretheiss.at と 差 ${d.toFixed(1)} km${d < 30 ? '（健全）' : '（TLEが古い可能性）'}`,
    err: d >= 30,
  };
}

// ============================================================
// パス予報
// ============================================================
function elevationAtMs(obsGd, ms) {
  const d = new Date(ms);
  const st = stateAt(d);
  if (!st) return null;
  const ecf = satellite.eciToEcf(st.eci, st.gmst);
  return satellite.ecfToLookAngles(obsGd, ecf).elevation * R2D;
}

function detailAtMs(obsGd, ms) {
  const d = new Date(ms);
  const st = stateAt(d);
  const ecf = satellite.eciToEcf(st.eci, st.gmst);
  const la = satellite.ecfToLookAngles(obsGd, ecf);
  return { st, az: la.azimuth * R2D, el: la.elevation * R2D, range: la.rangeSat };
}

// 仰角0°を横切る時刻を二分法で詰める
function refineCrossing(obsGd, aMs, bMs) {
  let lo = aMs, hi = bMs;
  const elLo = elevationAtMs(obsGd, lo);
  for (let i = 0; i < 20 && hi - lo > 250; i++) {
    const mid = (lo + hi) / 2;
    const e = elevationAtMs(obsGd, mid);
    if ((elLo < 0) === (e < 0)) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function predictPasses(obs, startMs, days, minElDeg, magLimit) {
  const catnr = current ? current.catnr : null;
  const obsGd = { longitude: obs.lon * D2R, latitude: obs.lat * D2R, height: (obs.alt || 0) / 1000 };
  const endMs = startMs + days * 86400000;
  const step = 20000;
  const passes = [];
  let prevEl = elevationAtMs(obsGd, startMs);
  let riseMs = prevEl >= 0 ? startMs : null;

  for (let t = startMs + step; t <= endMs; t += step) {
    const el = elevationAtMs(obsGd, t);
    if (el === null) continue;
    if (prevEl < 0 && el >= 0) {
      riseMs = refineCrossing(obsGd, t - step, t);
    } else if (prevEl >= 0 && el < 0 && riseMs !== null) {
      const setMs = refineCrossing(obsGd, t - step, t);
      const p = buildPass(obsGd, riseMs, setMs, catnr, magLimit);
      if (p && p.maxEl >= minElDeg) passes.push(p);
      riseMs = null;
    }
    prevEl = el;
  }
  return passes;
}

function buildPass(obsGd, riseMs, setMs, catnr, magLimit) {
  // 最大仰角を三分探索（1パス内で仰角は単峰）
  let lo = riseMs, hi = setMs;
  for (let i = 0; i < 40 && hi - lo > 500; i++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (elevationAtMs(obsGd, m1) < elevationAtMs(obsGd, m2)) lo = m1; else hi = m2;
  }
  const maxMs = (lo + hi) / 2;

  const rise = detailAtMs(obsGd, riseMs);
  const max = detailAtMs(obsGd, maxMs);
  const set = detailAtMs(obsGd, setMs);
  if (!rise || !max || !set) return null;

  // 可視区間の条件：
  //   ① 衛星が日照中  ② 観測地の太陽高度 < −6°（市民薄明より暗い）
  //   ③ 地平線より上  ④ 見かけの等級が空の条件の限界より明るい（等級不明の対象は①〜③のみ）
  const obsLat = obsGd.latitude * R2D, obsLon = obsGd.longitude * R2D;
  let visStart = null, visEnd = null, visMaxEl = 0, bestMag = null;
  let dimmedOut = false;                       // 等級が足りず弾かれた瞬間があったか
  for (let t = riseMs; t <= setMs; t += 10000) {
    const d = new Date(t);
    const st = stateAt(d);
    if (!st) continue;
    const sub = subsolar(d, st.gmst);
    if (!isSunlit(st.eci, d)) continue;
    if (sunElevationDeg(obsLat, obsLon, sub) >= -6) continue;
    const la = satellite.ecfToLookAngles(obsGd, satellite.eciToEcf(st.eci, st.gmst));
    const el = la.elevation * R2D;
    if (el < 0) continue;

    const mag = apparentMagnitude(catnr, st, obsGd, el, la.rangeSat);
    if (mag !== null && mag > magLimit) { dimmedOut = true; continue; }

    if (visStart === null) visStart = t;
    visEnd = t;
    visMaxEl = Math.max(visMaxEl, el);
    if (mag !== null && (bestMag === null || mag < bestMag)) bestMag = mag;
  }

  const sub = subsolar(new Date(maxMs), max.st.gmst);
  const obsSunEl = sunElevationDeg(obsLat, obsLon, sub);
  let reason = '';
  if (visStart === null) {
    reason = dimmedOut ? '暗すぎて肉眼では見えない'
           : obsSunEl >= -6 ? '昼間（空が明るい）'
           : '衛星が地球の影の中';
  }

  return {
    riseMs, maxMs, setMs,
    riseAz: rise.az, maxAz: max.az, setAz: set.az,
    maxEl: max.el,
    range: max.range,
    durationMs: setMs - riseMs,
    visible: visStart !== null,
    visStart, visEnd, visMaxEl, mag: bestMag, reason,
  };
}

const PASS_PAGE = 3;          // 初期表示件数。「さらに表示」を押したら残り全部を出す
let passShown = PASS_PAGE;
let lastArgs = null;          // 「さらに表示」で再描画するための元データ

// keepCount: ページ送りによる再描画（表示件数を維持する）
function renderPasses(passes, obs, opts, keepCount) {
  const box = $('passResult');
  if (!keepCount) passShown = PASS_PAGE;
  let shown = opts.onlyVisible ? passes.filter((p) => p.visible) : passes;

  if (!shown.length) {
    box.innerHTML = opts.onlyVisible
      ? `<p class="empty"><b>${satName(current)}</b> は今後${opts.days}日間に肉眼で見えるタイミングがありません` +
        `（この期間の通過はすべて昼間か、衛星が地球の影に入るタイミングです）。` +
        `検索期間を延ばすか、別の衛星を試してみてください。</p>`
      : `<p class="empty">${opts.days}日以内に仰角 ${opts.minEl}° 以上の通過はありません。` +
        `最低仰角を下げるか、検索期間を延ばしてみてください。</p>`;
    return;
  }

  const now = Date.now();
  const total = shown.length;
  const page = shown.slice(0, passShown);
  const rest = total - page.length;

  const head = `<p class="pass-summary">${obs.label ? obs.label + ' · ' : ''}` +
    `今後${opts.days}日間で <b>${total}回</b>` +
    `${opts.onlyVisible ? '（肉眼で見えるもののみ）' : `（最低仰角 ${opts.minEl}° 以上）`}</p>`;

  const items = page.map((p, i) => {
    // 見出しには「見えている時間帯」を出す（肉眼で見えない場合は地平線上にいる時間帯）
    const from = p.visible ? p.visStart : p.riseMs;
    const to = p.visible ? p.visEnd : p.setMs;
    const eta = p.riseMs > now ? `約${fmtDuration(p.riseMs - now)}後` : '通過中';
    // 明るいものほど縦線を太く濃くする
    const ms = magStyles(p.mag);
    const edge = p.visible ? ` style="${ms.card}"` : '';
    const visTag = p.visible
      ? `<span class="pass-tag vis" style="${ms.tag}">` +
        `${p.mag !== null && p.mag !== undefined ? fmtMag(p.mag) : '肉眼可'}</span>`
      : `<span class="pass-tag">${p.reason}</span>`;
    return `<li class="pass ${p.visible ? 'vis' : ''} ${i === 0 ? 'next' : ''}" data-rise="${Math.round(p.riseMs)}"${edge}>
      <div class="pass-when">
        <span class="pass-date">${fmtDay(new Date(from))} ${fmtHM(new Date(from))}–${fmtHM(new Date(to))}</span>
        <span class="pass-eta" data-pass-eta="${Math.round(p.riseMs)}">${eta}</span>
      </div>
      <div class="pass-meta">
        最大仰角 <b>${p.maxEl.toFixed(1)}°</b>（${compass(p.maxAz)}）<br>
        ${compass(p.riseAz)}の空から昇り ${compass(p.setAz)}へ
      </div>
      <div class="pass-foot">
        ${visTag}
        <span class="pass-links">
          <button class="pass-clip" data-clip="${i}" title="保存してARビューの対象にする">☆ 保存</button>
          <button class="pass-goto" data-goto="${Math.round(p.maxMs)}">地図で見る →</button>
        </span>
      </div>
    </li>`;
  }).join('');

  const more = rest > 0
    ? `<button id="btnMorePasses" class="btn btn-more">さらに未来の結果も表示（残り ${rest}件）</button>`
    : '';
  box.innerHTML = head + `<ul class="pass-list">${items}</ul>` + more;

  lastRendered = { passes: page, obs, catnr: current.catnr, sat: satName(current), name: current.name };
  lastArgs = { passes, obs, opts };

  if (rest > 0) {
    $('btnMorePasses').addEventListener('click', () => {
      passShown = Infinity;                 // 一度押したら残りをすべて出す
      renderPasses(lastArgs.passes, lastArgs.obs, lastArgs.opts, true);
    });
  }

  box.querySelectorAll('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setBase(parseInt(btn.dataset.goto, 10));
      revealMap();
    });
  });
  box.querySelectorAll('[data-clip]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = lastRendered.passes[parseInt(btn.dataset.clip, 10)];
      const added = addClip(p, lastRendered);
      btn.textContent = added ? '★ 保存済み' : '☆ 保存';
      btn.classList.toggle('saved', added);
    });
  });
  syncClipButtons();
}

// 通過が迫ったカードを強調する。開いたままでも表示が古くならないよう毎秒見直す
const SOON_MS = 60 * 60000;                 // 1時間前から「まもなく」扱い
function updatePassEtas() {
  const now = Date.now();
  document.querySelectorAll('.pass[data-rise]').forEach((li) => {
    const rise = parseInt(li.dataset.rise, 10);
    const eta = li.querySelector('[data-pass-eta]');
    if (eta) eta.textContent = rise > now ? `約${fmtDuration(rise - now)}後` : '通過中';
    const soon = rise - now < SOON_MS;
    li.classList.toggle('soon', soon);
    if (eta) eta.classList.toggle('soon', soon);
  });
}

// 地図が画面にほとんど入っていなければスクロールして見せる。
// 幅の狭い端末では地図と計算結果が縦に並ぶため、時刻を移動しても変化が見えないことへの対策
function revealMap() {
  const el = document.querySelector('.map-wrap');
  if (!el) return;
  const r = el.getBoundingClientRect();
  const shown = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
  if (shown < Math.min(r.height, window.innerHeight) * 0.6) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// 保存ボタンから参照するため、直近に描画したパスを保持する
let lastRendered = null;

function syncClipButtons() {
  if (!lastRendered) return;
  document.querySelectorAll('[data-clip]').forEach((btn) => {
    const p = lastRendered.passes[parseInt(btn.dataset.clip, 10)];
    const saved = isClipped(lastRendered.catnr, p.riseMs);
    btn.textContent = saved ? '★ 保存済み' : '☆ 保存';
    btn.classList.toggle('saved', saved);
  });
}

function runPrediction() {
  if (!state.observer) {
    $('passResult').innerHTML = '<p class="empty">観測地点が未設定です。「現在地を使う」か主要都市の選択、' +
      'または地図のクリックで指定してください。</p>';
    return;
  }

  const sky = $('skyLimit').value;
  const opts = {
    minEl: parseFloat($('minEl').value),
    days: parseInt($('days').value, 10),
    onlyVisible: $('onlyVisible').checked,
    sky,
    magLimit: SKY_LIMITS[sky],
  };
  const btn = $('btnPredict');
  btn.disabled = true;
  $('passResult').innerHTML = '<p class="working">計算中…</p>';

  // 描画を先に反映させてから重い計算に入る（軌道要素の取得完了も待つ）
  tleReady.then(() => setTimeout(() => {
    const t0 = performance.now();
    const passes = predictPasses(state.observer, Date.now(), opts.days, opts.minEl, opts.magLimit);
    state.passes = passes;
    renderPasses(passes, state.observer, opts);
    btn.disabled = false;
    console.log(`予報計算 ${Math.round(performance.now() - t0)}ms / ${passes.length}件`);
  }, 30));
}

// ============================================================
// 観測地点
// ============================================================
const PRESETS = [
  ['東京', 35.6812, 139.7671], ['札幌', 43.0621, 141.3544], ['仙台', 38.2682, 140.8694],
  ['名古屋', 35.1815, 136.9066], ['大阪', 34.6937, 135.5023], ['広島', 34.3853, 132.4553],
  ['福岡', 33.5904, 130.4017], ['那覇', 26.2124, 127.6809], ['ニューヨーク', 40.7128, -74.0060],
  ['ロンドン', 51.5074, -0.1278], ['シドニー', -33.8688, 151.2093],
];

function setObserver(obs) {
  state.observer = obs;
  renderObserver();
  try { localStorage.setItem(OBS_KEY, JSON.stringify(obs)); } catch (_) { /* ignore */ }
  render();
}

// 観測地点は表示のみ。設定は現在地・都市プリセット・地図クリックから行う
function renderObserver() {
  const el = $('obsCoords');
  const o = state.observer;
  if (!o) { el.textContent = '観測地点が未設定です'; el.classList.add('unset'); return; }
  el.classList.remove('unset');
  el.textContent = (o.label ? `${o.label}　` : '') + `${fmtLat(o.lat)} / ${fmtLon(o.lon)}`;
}

// ============================================================
// 時刻コントロール
// ============================================================
// 早送りボタンの表示。アイコンとラベルを別要素にしているのでまとめて更新する
// （スマホではラベルを隠してアイコンだけにするため）
function setPlayButton(playing) {
  const b = $('btnPlay');
  b.querySelector('.btn-icon').textContent = playing ? '⏸' : '⏩';
  b.querySelector('.btn-label').textContent = playing ? '停止' : '早送り';
  b.title = playing ? '停止' : '早送り';
}

function setLive(on) {
  state.live = on;
  if (on) {
    state.playing = false;
    state.offsetMin = 0;
    $('timeSlider').value = 0;
  }
  $('btnLive').classList.toggle('is-on', on);
  setPlayButton(state.playing);
}

function setBase(ms) {
  setLive(false);
  state.playing = false;
  state.baseMs = ms;
  state.offsetMin = 0;
  $('timeSlider').value = 0;
  setPlayButton(false);
  syncBaseInput(true);
  render();
}

function syncBaseInput(force) {
  const inp = $('baseTime');
  if (!force && document.activeElement === inp) return;
  inp.value = toLocalInputValue(new Date(state.baseMs));
}

function bindControls() {
  $('satSelect').addEventListener('change', (e) => selectSat(e.target.value));
  $('btnInfo').addEventListener('click', () => { renderTleStatus(); $('infoDialog').showModal(); });

  $('btnLive').addEventListener('click', () => { setLive(!state.live); render(); });

  $('btnPlay').addEventListener('click', () => {
    state.playing = !state.playing;
    if (state.playing) { state.live = false; $('btnLive').classList.remove('is-on'); }
    setPlayButton(state.playing);
  });

  $('speed').addEventListener('change', (e) => { state.speed = parseFloat(e.target.value); });

  $('timeSlider').addEventListener('input', (e) => {
    if (state.live) { state.live = false; $('btnLive').classList.remove('is-on'); }
    state.offsetMin = parseFloat(e.target.value);
    render();
  });

  document.querySelectorAll('[data-jump]').forEach((b) => {
    b.addEventListener('click', () => {
      const v = b.dataset.jump;
      if (v === 'now') { setLive(true); state.baseMs = Date.now(); syncBaseInput(true); }
      else { setBase(currentDate().getTime() + parseInt(v, 10) * 60000); }
      render();
    });
  });

  $('baseTime').addEventListener('change', (e) => {
    const ms = new Date(e.target.value).getTime();
    if (isFinite(ms)) setBase(ms);
  });

  // 地図：ドラッグで横スクロール（経度は周期的なので端で折り返す）、
  // 動かさずに離したときだけ観測地点の設定として扱う
  let drag = null;
  const lonAt = (clientX) => {
    const r = canvas.getBoundingClientRect();
    return normLonDeg((clientX - r.left) / r.width * 360 - 180 - panLon);
  };

  // 2本指以降は無視する。マルチタッチで横スクロールが暴れたり、
  // 指を離した拍子に観測地点が設定されたりするのを防ぐ
  canvas.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary) { drag = null; canvas.classList.remove('dragging'); return; }
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, lastX: e.clientX, moved: 0 };
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const r = canvas.getBoundingClientRect();
    const dx = e.clientX - drag.lastX;
    drag.lastX = e.clientX;
    drag.moved += Math.abs(dx);
    panLon = (panLon + dx / r.width * 360) % 360;
    canvas.classList.add('dragging');
    $('btnMapReset').hidden = Math.abs(panLon - DEFAULT_PAN_LON) < 0.5;
    render();
  });

  canvas.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const wasDrag = drag.moved > 4;
    drag = null;
    canvas.classList.remove('dragging');
    if (wasDrag) return;
    const r = canvas.getBoundingClientRect();
    setObserver({
      lat: 90 - (e.clientY - r.top) / r.height * 180,
      lon: lonAt(e.clientX),
      label: '選択地点', kind: 'map',
    });
  });

  canvas.addEventListener('pointercancel', () => { drag = null; canvas.classList.remove('dragging'); });

  $('btnMapReset').addEventListener('click', () => {
    panLon = DEFAULT_PAN_LON;
    $('btnMapReset').hidden = true;
    render();
  });

  const sel = $('preset');
  PRESETS.forEach(([name, lat, lon], i) => {
    const o = document.createElement('option');
    o.value = String(i); o.textContent = name;
    sel.appendChild(o);
  });
  sel.addEventListener('change', (e) => {
    if (e.target.value === '') return;
    const [name, lat, lon] = PRESETS[parseInt(e.target.value, 10)];
    setObserver({ lat, lon, label: name, kind: 'preset' });
    e.target.value = '';
  });

  const useCurrentLocation = (btn, label) => {
    if (!navigator.geolocation) {
      $('passResult').innerHTML = '<p class="empty">このブラウザは位置情報に対応していません。都市を選ぶか、地図をクリックして指定してください。</p>';
      return;
    }
    const original = btn.textContent;
    btn.textContent = '…';
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        btn.textContent = original;
        btn.disabled = false;
        setObserver({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: '現在地', kind: 'geo' });
      },
      (err) => {
        btn.textContent = original;
        btn.disabled = false;
        $('passResult').innerHTML = `<p class="empty">現在地を取得できませんでした（${err.message}）。` +
          `位置情報は https もしくは localhost でのみ利用できます。都市の選択や地図クリックでも指定できます。</p>`;
      },
      { enableHighAccuracy: false, timeout: 10000 }
    );
  };
  $('btnGeo').addEventListener('click', (e) => useCurrentLocation(e.currentTarget));
  $('btnMapGeo').addEventListener('click', (e) => useCurrentLocation(e.currentTarget));

  $('btnTimeMore').addEventListener('click', (e) => {
    const open = $('timeMore').classList.toggle('open');
    e.currentTarget.setAttribute('aria-expanded', String(open));
    e.currentTarget.textContent = open ? '− 細かい時刻操作' : '＋ 細かい時刻操作';
  });

  $('btnPredict').addEventListener('click', runPrediction);

  window.addEventListener('resize', () => { resizeCanvas(); render(); });
}

// ============================================================
// メインループ
// ============================================================
function render() {
  if (!satrec) return;
  const d = currentDate();
  const st = stateAt(d);
  renderClock(d);
  if (!st) {
    drawBackground();
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,138,107,.95)';
    ctx.font = '600 13px -apple-system, sans-serif';
    ctx.fillText('この時刻の軌道を計算できません（元期から離れすぎているか、軌道が崩壊しています）', W / 2, H / 2);
    ctx.restore();
    return;
  }
  drawMap(st);
  renderStatus(st);
}

let lastFrame = performance.now();
function loop(now) {
  const dt = now - lastFrame;
  lastFrame = now;

  if (state.live) state.baseMs = Date.now();
  else if (state.playing) state.baseMs += dt * state.speed;

  if (state.live || state.playing) {
    syncBaseInput(false);
    render();
  }
  requestAnimationFrame(loop);
}

// ============================================================
// 起動
// ============================================================
async function init() {
  resizeCanvas();
  bindControls();
  renderTleStatus();
  initClips();       // clips.js / ar.js の関数はこの時点で読み込み済み
  initAr();

  try {
    const saved = JSON.parse(localStorage.getItem(OBS_KEY) || 'null');
    if (saved && isFinite(saved.lat) && isFinite(saved.lon)) state.observer = saved;
  } catch (_) { /* ignore */ }

  renderObserver();
  syncBaseInput(true);
  await loadTle();
  render();

  pollReference();
  setInterval(pollReference, 30000);
  setInterval(updatePassEtas, 1000);
  setInterval(renderTleStatus, 60000);
  requestAnimationFrame(loop);
}

// 全スクリプトの解析が終わってから起動する（clips.js / ar.js を参照するため）
document.addEventListener('DOMContentLoaded', init);
