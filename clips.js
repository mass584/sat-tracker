'use strict';
/*
 * 保存したタイミング（クリップ）
 *  - 「次に見えるタイミングを探す」の「☆ 保存」で localStorage に保存し、ARビューの対象にする
 *  - 終わったものは既定で隠し、チェックで一覧の末尾に出す
 */

const CLIP_KEY = 'sat-clips-v1';

// 終わった直後に消えると使いにくいので、この時間は「これから」の扱いのままにする
const PAST_BUFFER_MS = 30 * 60000;
// 過去ぶんを保持する期間（これを過ぎたら自動で捨てる）
const CLIP_RETENTION_MS = 7 * 86400000;

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
  return true;
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
// 表示
// ============================================================
function renderClips() {
  const box = $('clipList');
  purgeClips();
  renderClipBadge();

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
      : '<p class="empty">「次に見えるタイミングを探す」の「☆ 保存」で追加すると、ARビューで探せるようになります。</p>';
    return;
  }

  box.innerHTML = `<ul class="clip-items">${list.map((c) => {
    const start = clipStartMs(c), end = clipEndMs(c);
    const done = isPastClip(c);
    const ms = magStyles(c.mag);
    const tag = c.visible
      ? `<span class="pass-tag vis" style="${ms.tag}">${c.mag !== null && c.mag !== undefined ? fmtMag(c.mag) : '肉眼可'}</span>`
      : '<span class="pass-tag">肉眼では見えない条件</span>';
    return `<li class="clip ${c.visible ? 'vis' : ''} ${done ? 'done' : ''}"${c.visible ? ` style="${ms.card}"` : ''}>
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
      <div class="clip-actions">
        ${done ? '' : `<button class="btn btn-sm btn-ar" data-ar="${c.id}">📷 ARで探す</button>`}
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

  updateClipEtas();
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
  btn.title = n ? `保存したタイミング（${n}件）` : '保存したタイミング';
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

  // 旧バージョンが通知用に登録した Service Worker が残っていれば掃除する
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.getRegistrations()
      .then((rs) => rs.forEach((r) => r.unregister()))
      .catch(() => { /* ignore */ });
  }

  setInterval(updateClipEtas, 1000);
}
