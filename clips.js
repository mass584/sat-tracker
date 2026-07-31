'use strict';
/*
 * 保存した観測チャンス（クリップ）
 *  - 「次の観測チャンスを探す」の「☆ 保存」で localStorage に保存し、ARビューの対象にする
 *  - 終わったものは既定で隠し、チェックで一覧の末尾に出す
 */

const CLIP_KEY = 'sat-clips-v1';
// どのカレンダーに追加するか（'google' | 'apple'）。初回に一度だけ聞いて覚える
const CAL_PREF_KEY = 'sat-calendar-v1';

// 終わった直後に消えると使いにくいので、この時間は「これから」の扱いのままにする
const PAST_BUFFER_MS = 30 * 60000;
// 過去ぶんを保持する期間（これを過ぎたら自動で捨てる）
const CLIP_RETENTION_MS = 7 * 86400000;
// カレンダーに入れる通知の前倒し時間（空の下へ出る支度がいるので少し早めに鳴らす）
const CAL_ALARM_MIN = 10;

let clips = [];
let showPastClips = false;      // 常にOFFで開く（保存はしない）

// ============================================================
// 保存・読み出し
// ============================================================
function loadClips() {
  try { clips = JSON.parse(localStorage.getItem(CLIP_KEY) || '[]'); } catch (_) { clips = []; }
  purgeClips();
}

function saveClips() {
  try { localStorage.setItem(CLIP_KEY, JSON.stringify(clips)); } catch (_) { /* ignore */ }
}

// 保持期間を過ぎたものは自動で消す
function purgeClips() {
  const before = clips.length;
  clips = clips.filter((c) => clipEndMs(c) > Date.now() - CLIP_RETENTION_MS);
  if (clips.length !== before) saveClips();
}

// 終了からバッファぶん経過したものを「過去」とみなす
function isPastClip(c) { return clipEndMs(c) < Date.now() - PAST_BUFFER_MS; }

function clipIdOf(catnr, riseMs) { return `${catnr}@${Math.round(riseMs)}`; }
function isClipped(catnr, riseMs) { return clips.some((c) => c.id === clipIdOf(catnr, riseMs)); }

// 計算結果のカードから保存する。すでに保存済みなら解除する（トグル）
function addClip(p, ctx) {
  const id = clipIdOf(ctx.catnr, p.riseMs);
  const idx = clips.findIndex((c) => c.id === id);
  if (idx >= 0) { clips.splice(idx, 1); saveClips(); renderClips(); return false; }

  clips.push({
    id,
    catnr: ctx.catnr,
    sat: ctx.sat,
    satName: ctx.name,
    obs: { lat: ctx.obs.lat, lon: ctx.obs.lon, label: ctx.obs.label || '' },
    riseMs: p.riseMs, maxMs: p.maxMs, setMs: p.setMs,
    riseAz: p.riseAz, maxAz: p.maxAz, setAz: p.setAz,
    maxEl: p.maxEl, range: p.range,
    visible: p.visible, visStart: p.visStart, visEnd: p.visEnd, visMaxEl: p.visMaxEl, mag: p.mag,
  });
  clips.sort((a, b) => a.riseMs - b.riseMs);
  saveClips();
  renderClips();
  pingClipsIcon();
  return true;
}

// 保存直後にヘッダーの★を光らせて、保存先がここであることに気付いてもらう
function pingClipsIcon() {
  const btn = $('btnClips');
  btn.classList.remove('ping');
  void btn.offsetWidth;               // アニメーションを連続保存でも毎回リスタートさせる
  btn.classList.add('ping');
  btn.addEventListener('animationend', () => btn.classList.remove('ping'), { once: true });
}

function removeClip(id) {
  clips = clips.filter((c) => c.id !== id);
  saveClips();
  renderClips();
  syncClipButtons();
}

// 観測の基準になる時刻（肉眼で見える区間があればその開始時刻）
function clipStartMs(c) { return c.visible && c.visStart ? c.visStart : c.riseMs; }
function clipEndMs(c) { return c.visible && c.visEnd ? c.visEnd : c.setMs; }

// ============================================================
// カレンダーへの追加
// ============================================================
/*
 * 使うカレンダーは初回に一度だけ選んでもらい、localStorage に覚える。
 *   Google … 予定の作成画面を開く
 *   Apple  … .ics を開く → 「カレンダーに追加」の画面が出る
 * 端末から推測しない（Macで普段Googleカレンダーを使う、のような組み合わせが普通にあるため）。
 *
 * 予定に観測地点（地名・座標）は入れない。Googleカレンダー側は予定の中身が
 * 外部へ渡るため、居場所を出さない方針（AGENTS.md）に合わせて両方から外している。
 */

// カレンダーからアプリへ戻れるようにURLを添える。
// file:// で開いているときは他の端末から辿れないので付けない
function appUrl() {
  return /^https?:$/.test(location.protocol) ? location.origin + location.pathname : '';
}

// 予定から辿ったときに、その記録を開いた状態で見せるためのリンク
const CLIP_HASH = '#clip=';
function clipPermalink(c) {
  const base = appUrl();
  return base ? `${base}${CLIP_HASH}${encodeURIComponent(c.id)}` : '';
}

/*
 * #clip=... 付きで開かれたら、保存ダイアログをその記録までスクロールした状態で出す。
 * 記録は localStorage にしかないので、保存した端末以外で開くと見つからない。
 * そのときは通常の画面のまま出す（エラーを出しても利用者にできることがない）。
 */
function openClipFromHash() {
  if (!location.hash.startsWith(CLIP_HASH)) return;
  const id = decodeURIComponent(location.hash.slice(CLIP_HASH.length));
  const c = clips.find((x) => x.id === id);
  if (!c) return;

  showPastClips = isPastClip(c);      // 終わった記録は既定で隠れているので出す
  renderClips();
  const dlg = $('clipsDialog');
  if (!dlg.open) dlg.showModal();     // 開いたまま踏まれることがある（showModalの二重呼びは例外）

  const li = $('clipList').querySelector(`[data-clip-id="${id}"]`);
  if (!li) return;
  li.scrollIntoView({ block: 'center' });
  li.classList.add('clip-focus');     // どれのことか分かるように一度だけ光らせる
}

const CAL_NAMES = { google: 'Google カレンダー', apple: 'Apple カレンダー' };

function calPref() {
  const v = (() => { try { return localStorage.getItem(CAL_PREF_KEY); } catch (_) { return null; } })();
  return CAL_NAMES[v] ? v : null;         // 未選択・壊れた値は「未設定」に倒す
}

function setCalPref(v) {
  try { localStorage.setItem(CAL_PREF_KEY, v); } catch (_) { /* ignore */ }
  renderCalPref();
}

// 選択済みのときだけ、保存ダイアログの下に現在の設定と変更手段を出す
function renderCalPref() {
  const row = $('calPrefRow');
  const v = calPref();
  row.hidden = !v;
  if (v) $('calPrefName').textContent = CAL_NAMES[v];
}

// iPadOSはUAがMacを名乗るのでタッチの有無も見る。
// Apple を選んだあと、iOSかどうかで .ics の渡し方だけ変える
function isIosDevice() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) ||
         (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

// 予定の表題と本文は、どちらのカレンダーでも同じ内容にする
function calTitle(c) {
  const name = satNameByCatnr(c.catnr, c.sat);
  return c.visible
    ? `🛰 ${name} が見える（${compass(c.maxAz)}の空・最大仰角${c.maxEl.toFixed(0)}°）`
    : `🛰 ${name} が通過（肉眼では見えない条件）`;
}

function calDetails(c) {
  const start = clipStartMs(c), end = clipEndMs(c);
  const lines = [
    `${fmtHM(new Date(start))}–${fmtHM(new Date(end))} に ${compass(c.riseAz)} から ${compass(c.setAz)} へ動きます。`,
    '',
    `最大仰角: ${c.maxEl.toFixed(0)}°（${compass(c.maxAz)}）`,
    c.visible
      ? `明るさ: ${c.mag !== null && c.mag !== undefined ? fmtMag(c.mag) : '肉眼で見える見込み'}`
      : '肉眼では見えない条件です（方角と時刻の目安として）',
  ];
  const url = clipPermalink(c);
  if (url) lines.push('', 'アプリで見る（ARで方向を追えます）:', url);
  return lines.join('\n');
}

// iCalendar の日時表記（UTC）: 20260731T101500Z
function icsUtc(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// 値の中の記号は仕様上そのままでは置けない（改行は \n の2文字で表す）
function icsEscape(s) {
  return String(s).replace(/([\\;,])/g, '\\$1').replace(/\n/g, '\\n');
}

// 1行75オクテットまで。折り返しは行頭に空白を置いて続ける。
// 日本語は1文字3オクテットなので、文字数ではなくバイト数で数える
function icsFold(line) {
  const enc = new TextEncoder();
  let out = '', len = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (len + n > 73) { out += '\r\n '; len = 1; }   // 継続行の先頭空白ぶんを1で数える
    out += ch;
    len += n;
  }
  return out;
}

function buildIcs(c) {
  const name = satNameByCatnr(c.catnr, c.sat);
  const url = clipPermalink(c);
  const rows = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Sat Tracker//JA',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${c.id.replace('@', '-')}@sat-tracker.local`,
    `DTSTAMP:${icsUtc(Date.now())}`,
    `DTSTART:${icsUtc(clipStartMs(c))}`,
    `DTEND:${icsUtc(clipEndMs(c))}`,
    `SUMMARY:${icsEscape(calTitle(c))}`,
    `DESCRIPTION:${icsEscape(calDetails(c))}`,
    ...(url ? [`URL:${url}`] : []),
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `TRIGGER:-PT${CAL_ALARM_MIN}M`,
    `DESCRIPTION:${icsEscape(`まもなく ${name} が通ります`)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return rows.map(icsFold).join('\r\n') + '\r\n';
}

// Googleカレンダーの予定作成画面。開いた先で「保存」を押すだけで入る
function googleCalendarUrl(c) {
  const q = new URLSearchParams({
    action: 'TEMPLATE',
    text: calTitle(c),
    dates: `${icsUtc(clipStartMs(c))}/${icsUtc(clipEndMs(c))}`,
    details: calDetails(c),
  });
  return `https://calendar.google.com/calendar/render?${q}`;
}

// 未選択なら先に聞く。選んだらそのまま続きを実行する
function addToCalendar(c) {
  const pref = calPref();
  if (!pref) { askCalPref(c); return; }
  if (pref === 'google') { window.open(googleCalendarUrl(c), '_blank', 'noopener'); return; }
  openIcs(c);
}

// 選択ダイアログ。clip を渡すと、選んだあとその予定の追加まで続ける
function askCalPref(c) {
  const dlg = $('calDialog');
  dlg.querySelectorAll('[data-cal-pref]').forEach((b) => {
    b.onclick = () => {
      setCalPref(b.dataset.calPref);
      dlg.close();
      if (c) addToCalendar(c);
    };
  });
  dlg.showModal();
}

function openIcs(c) {
  // .ics を開くとカレンダーが受け取る。
  // iOSはダウンロード指定にするとファイルアプリ経由になってしまうので、
  // そのまま開かせて「カレンダーに追加」の画面を出す
  const blob = new Blob([buildIcs(c)], { type: 'text/calendar;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  if (!isIosDevice()) {
    const d = new Date(clipStartMs(c));
    const p = (n) => String(n).padStart(2, '0');
    a.download = `sat-${c.catnr}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
                 `-${p(d.getHours())}${p(d.getMinutes())}.ics`;
  }
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 読み込みが終わる前に解放するとiOSでファイルが空になるので少し待つ
  setTimeout(() => URL.revokeObjectURL(href), 10000);
}

// ============================================================
// 天気予報（Open-Meteo）
// ============================================================
/*
 * 保存した記録の座標・時刻から雲量を取り出して表示する。
 * これは観測地点の座標を外部（Open-Meteo）へ送る唯一の機能なので、
 * localStorageなどには持ち回さず一覧を開くたびに取り直す（送信先はREADME参照）。
 */
const WEATHER_FORECAST_MAX_DAYS = 16;   // Open-Meteo無料予報の上限。これより先は予報自体が無い
const WEATHER_CACHE_MS = 15 * 60000;    // 同じ地点に短時間で何度も投げないための保持時間

const weatherCache = new Map();   // key: "lat,lon"(丸め) -> { ts, hours: Map<hourMs, {cloud, code}> }

function weatherKey(lat, lon) { return `${lat.toFixed(2)},${lon.toFixed(2)}`; }

async function fetchWeatherSeries(lat, lon) {
  const key = weatherKey(lat, lon);
  const cached = weatherCache.get(key);
  if (cached && Date.now() - cached.ts < WEATHER_CACHE_MS) return cached.hours;

  const q = new URLSearchParams({
    latitude: lat.toFixed(2),
    longitude: lon.toFixed(2),
    hourly: 'cloudcover,weathercode',
    forecast_days: String(WEATHER_FORECAST_MAX_DAYS),
    timezone: 'UTC',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`);
  if (!res.ok) throw new Error(`weather ${res.status}`);
  const data = await res.json();

  const hours = new Map();
  const times = data.hourly?.time || [];
  const clouds = data.hourly?.cloudcover || [];
  const codes = data.hourly?.weathercode || [];
  // timezone=UTCで取っているので、末尾にZを補えばそのままDate.parseできる
  times.forEach((t, i) => hours.set(Date.parse(`${t}Z`), { cloud: clouds[i], code: codes[i] }));

  weatherCache.set(key, { ts: Date.now(), hours });
  return hours;
}

// WMO天気コードを表示用の絵文字に簡略化する
function weatherIcon(code) {
  if (code === 0) return '☀️';
  if (code <= 3) return '⛅';
  if (code === 45 || code === 48) return '🌫';
  if (code >= 51 && code <= 67) return '🌧';
  if (code >= 71 && code <= 77) return '🌨';
  if (code >= 80 && code <= 82) return '🌦';
  if (code >= 85 && code <= 86) return '🌨';
  if (code >= 95) return '⛈';
  return '☁️';
}

function weatherLabel(hourData) {
  if (!hourData || hourData.cloud === null || hourData.cloud === undefined) return '';
  return `${weatherIcon(hourData.code)} 雲量${Math.round(hourData.cloud)}%`;
}

// 観測開始時刻に最も近い1時間ぶんの予報を拾う（通過は数分なので時間単位で十分）
function lookupWeather(hours, startMs) {
  return hours.get(Math.round(startMs / 3600000) * 3600000);
}

// 一覧を描画したあとに非同期で埋める。座標を丸めて地点ごとにまとめ、
// 同じ地点への重複リクエストを避ける
async function loadClipWeather(list) {
  const targets = list.filter((c) => !isPastClip(c) &&
    clipStartMs(c) <= Date.now() + WEATHER_FORECAST_MAX_DAYS * 86400000);
  if (!targets.length) return;

  const byKey = new Map();
  targets.forEach((c) => {
    const key = weatherKey(c.obs.lat, c.obs.lon);
    if (!byKey.has(key)) byKey.set(key, { lat: c.obs.lat, lon: c.obs.lon, clips: [] });
    byKey.get(key).clips.push(c);
  });

  await Promise.all([...byKey.values()].map(async ({ lat, lon, clips: group }) => {
    let hours;
    try { hours = await fetchWeatherSeries(lat, lon); }
    catch (_) { return; }   // 天気は付加情報なので、取得に失敗しても一覧自体は出す

    group.forEach((c) => {
      const label = weatherLabel(lookupWeather(hours, clipStartMs(c)));
      if (!label) return;
      const el = document.querySelector(`[data-weather="${c.id}"]`);
      if (el) { el.textContent = label; el.hidden = false; }
    });
  }));
}

// ============================================================
// 表示
// ============================================================
function renderClips() {
  const box = $('clipList');
  purgeClips();
  renderClipBadge();
  renderCalPref();

  const upcoming = clips.filter((c) => !isPastClip(c)).sort((a, b) => clipStartMs(a) - clipStartMs(b));
  const past = clips.filter(isPastClip).sort((a, b) => clipStartMs(b) - clipStartMs(a));

  // 過去ぶんがあるときだけチェックボックスを出す
  const row = $('showPastRow');
  row.hidden = !past.length;
  $('showPastClips').checked = showPastClips;
  row.querySelector('span')?.remove();
  if (past.length) {
    const n = document.createElement('span');
    n.className = 'chk-count';
    n.textContent = `（${past.length}件）`;
    row.appendChild(n);
  }

  // 過ぎたものは末尾にまとめる
  const list = showPastClips ? upcoming.concat(past) : upcoming;

  if (!list.length) {
    box.innerHTML = past.length
      ? '<p class="empty">これから見えるタイミングの保存はありません。過去の記録は下のチェックで表示できます。</p>'
      : '<p class="empty">「次の観測チャンスを探す」の「☆ 保存」で追加すると、ARビューで探せるようになります。</p>';
    return;
  }

  box.innerHTML = `<ul class="clip-items">${list.map((c) => {
    const start = clipStartMs(c), end = clipEndMs(c);
    const done = isPastClip(c);
    const ms = magStyles(c.mag);
    const tag = c.visible
      ? `<span class="pass-tag vis" style="${ms.tag}">${c.mag !== null && c.mag !== undefined ? fmtMag(c.mag) : '肉眼可'}</span>`
      : '<span class="pass-tag">肉眼では見えない条件</span>';
    return `<li class="clip ${c.visible ? 'vis' : ''} ${done ? 'done' : ''}" data-clip-id="${c.id}"${c.visible ? ` style="${ms.card}"` : ''}>
      <div class="clip-head">
        <span class="clip-sat">${satNameByCatnr(c.catnr, c.sat)}</span>
        <span class="clip-eta" data-eta="${Math.round(start)}">–</span>
      </div>
      <div class="clip-when">${fmtDay(new Date(start))} ${fmtHM(new Date(start))}–${fmtHM(new Date(end))}</div>
      <div class="clip-meta">
        <button class="clip-place" data-obs="${c.id}" title="この地点を観測地点にする">${obsPlaceLabel(c.obs)}</button> · 最大仰角 <b>${c.maxEl.toFixed(0)}°</b>（${compass(c.maxAz)}）
        · ${compass(c.riseAz)} から ${compass(c.setAz)} へ
      </div>
      ${tag}
      ${!done && start <= Date.now() + WEATHER_FORECAST_MAX_DAYS * 86400000
        ? `<div class="clip-weather" data-weather="${c.id}" hidden></div>` : ''}
      <div class="clip-actions">
        ${done ? '' : `<button class="btn btn-sm btn-ar" data-ar="${c.id}">📷 ARで探す</button>
        <button class="btn btn-sm btn-cal" data-cal="${c.id}">📅 カレンダーに追加</button>`}
        <button class="btn btn-sm btn-del" data-del="${c.id}">削除</button>
      </div>
    </li>`;
  }).join('')}</ul>`;

  box.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => removeClip(b.dataset.del)));
  // 記録の地点を押したら、その座標を観測地点として地図に反映する
  box.querySelectorAll('[data-obs]').forEach((b) =>
    b.addEventListener('click', () => {
      const c = clips.find((x) => x.id === b.dataset.obs);
      if (!c) return;
      // 地名でないラベル（「現在地」など）は引き継がず、座標だけを反映する
      const named = isNamedPlace(c.obs);
      setObserver({ lat: c.obs.lat, lon: c.obs.lon,
                    label: named ? c.obs.label : '', kind: named ? 'preset' : 'map' });
      // 反映先の地図を見せるため、閉じたうえで先頭まで戻す
      $('clipsDialog').close();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }));
  box.querySelectorAll('[data-ar]').forEach((b) =>
    b.addEventListener('click', () => {
      const c = clips.find((x) => x.id === b.dataset.ar);
      if (!c) return;
      $('clipsDialog').close();      // モーダルはARビューより手前に出るため閉じる
      openAr(c);
    }));
  box.querySelectorAll('[data-cal]').forEach((b) =>
    b.addEventListener('click', () => {
      const c = clips.find((x) => x.id === b.dataset.cal);
      if (c) addToCalendar(c);
    }));

  updateClipEtas();
  loadClipWeather(list);   // 非同期。取得でき次第プレースホルダーを埋める
}

// ヘッダーのアイコンに保存件数を出す
function renderClipBadge() {
  const btn = $('btnClips');
  const n = clips.filter((c) => !isPastClip(c)).length;   // これから見えるものだけ数える
  btn.classList.toggle('has-clips', n > 0);
  btn.textContent = n ? '★' : '☆';
  if (n) {
    const badge = document.createElement('span');
    badge.className = 'clip-badge';
    badge.textContent = String(n);
    btn.appendChild(badge);
  }
  btn.title = n ? `保存した観測チャンス（${n}件）` : '保存した観測チャンス';
}

function updateClipEtas() {
  const now = Date.now();
  document.querySelectorAll('[data-eta]').forEach((el) => {
    const t = parseInt(el.dataset.eta, 10);
    const c = clips.find((x) => Math.round(clipStartMs(x)) === t);
    if (c && now >= clipStartMs(c) && now <= clipEndMs(c)) {
      el.textContent = '観測中';
      el.classList.add('now');
    } else if (t > now) {
      el.textContent = `${fmtDuration(t - now)}後`;
      el.classList.remove('now');
    } else {
      el.textContent = '終了';
      el.classList.remove('now');
    }
  });
}

// ============================================================
// 起動
// ============================================================
function initClips() {
  loadClips();
  renderClips();

  $('btnClips').addEventListener('click', () => {
    showPastClips = false;                 // 開くたびに既定へ戻す
    renderClips();
    $('clipsDialog').showModal();
  });

  $('showPastClips').addEventListener('change', (e) => {
    showPastClips = e.target.checked;
    renderClips();
  });

  // 追加先の変更。clip を渡さないので、選んでも予定の追加までは進まない
  $('calPrefChange').addEventListener('click', () => askCalPref(null));

  // 旧バージョンが通知用に登録した Service Worker が残っていれば掃除する
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.getRegistrations()
      .then((rs) => rs.forEach((r) => r.unregister()))
      .catch(() => { /* ignore */ });
  }

  setInterval(updateClipEtas, 1000);

  openClipFromHash();      // カレンダーの予定から辿ってきた場合
  // アプリを開いたままリンクを踏むとページは読み直されないので、ハッシュだけでも拾う
  window.addEventListener('hashchange', openClipFromHash);
}
