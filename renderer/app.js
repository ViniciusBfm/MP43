// `api` é exposto pelo preload (window.api).
const $ = (id) => document.getElementById(id);

const AUDIO = [['320', '320 kbps', 'HQ'], ['192', '192 kbps', ''], ['128', '128 kbps', '']];
const VIDEO = [2160, 1440, 1080, 720, 480, 360];
const VTAG = { 2160: '4K', 1440: '2K', 1080: 'HD', 720: 'HD' };
const ACTIVE = ['na fila', 'baixando', 'convertendo'];

let info = null;
let type = 'mp4';
let quality = null;
let settings = {};
const jobs = new Map();
let lastClip = '';
let picked = new Set(); // índices marcados da playlist
const batches = new Map(); // pasta da playlist -> quando foi adicionada (para o aviso de "concluída")

const show = (id, on = true) => $(id).classList.toggle('hidden', !on);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function alertMsg(text) {
  $('alert').textContent = text || '';
  show('alert', !!text);
}

function toast(text, kind = '', action) {
  const t = el('div', `toast ${kind}`, null);
  t.append(el('span', '', text));
  if (action) {
    const b = el('button', '', action.label);
    b.onclick = () => { action.run(); t.remove(); };
    t.append(b);
  }
  $('toasts').append(t);
  setTimeout(() => t.classList.add('out'), 4200);
  setTimeout(() => t.remove(), 4600);
}

function fmtDur(s) {
  if (!s) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function fmtSize(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}

function busy(btn, on, label) {
  btn.disabled = on;
  if (on) {
    btn.dataset.html = btn.innerHTML;
    btn.replaceChildren(el('span', 'spinner'), document.createTextNode(label || ''));
  } else if (btn.dataset.html) {
    btn.innerHTML = btn.dataset.html;
  }
}

const isUrl = (t) => /^https?:\/\/\S+$/i.test(String(t || '').trim());

// ---------- busca e escolha de formato ----------
function renderChips() {
  const box = $('chips');
  box.replaceChildren();
  let opts;
  if (type === 'mp3') {
    opts = AUDIO;
  } else {
    const heights = info?.heights || [];
    const avail = heights.length ? VIDEO.filter((h) => heights.some((x) => x >= h)) : VIDEO;
    opts = (avail.length ? avail : [null]).map((h) => (h ? [String(h), `${h}p`, VTAG[h] || ''] : ['best', 'Melhor', '']));
  }
  const preferred = type === 'mp3' ? settings.audioQuality : settings.videoQuality;
  if (!opts.some((o) => o[0] === quality)) {
    quality = (opts.find((o) => o[0] === preferred) || opts.find((o) => o[0] === '720') || opts[0])[0];
  }
  for (const [v, label, tag] of opts) {
    const b = el('button', `chip${v === quality ? ' on' : ''}`, label);
    b.type = 'button';
    if (tag) b.append(' ', el('small', '', tag));
    b.onclick = () => { quality = v; renderChips(); show('added', false); };
    box.append(b);
  }
  updateDlLabel();
}

function updateDlLabel() {
  const fmt = type.toUpperCase();
  if (!info?.playlist) {
    $('dlLabel').textContent = `Baixar ${fmt}`;
    $('btnDownload').disabled = false;
    return;
  }
  const n = picked.size;
  $('dlLabel').textContent = n === info.entries.length ? `Baixar todos (${n}) em ${fmt}` : `Baixar ${n} em ${fmt}`;
  $('btnDownload').disabled = n === 0;
}

// ---------- playlist ----------
function renderPlaylist() {
  const list = $('plList');
  list.replaceChildren(...info.entries.map((e, i) => {
    const row = el('label', `pl-item${picked.has(i) ? '' : ' off'}`);
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = picked.has(i);
    cb.onchange = () => {
      if (cb.checked) picked.add(i); else picked.delete(i);
      row.classList.toggle('off', !cb.checked);
      syncPlaylistHead();
    };
    const th = el('img', 'th');
    th.alt = '';
    th.loading = 'lazy';
    if (e.thumbnail) th.src = e.thumbnail;
    th.onerror = () => { th.removeAttribute('src'); };
    const t = el('span', 't', e.title);
    t.title = e.title;
    row.append(cb, el('span', 'n', String(i + 1)), th, t, el('span', 'd', fmtDur(e.duration)));
    return row;
  }));
  syncPlaylistHead();
}

function syncPlaylistHead() {
  const total = info.entries.length;
  $('plCount').textContent = `${picked.size} de ${total} selecionados`;
  $('plAll').checked = picked.size === total;
  $('plAll').indeterminate = picked.size > 0 && picked.size < total;
  show('added', false);
  updateDlLabel();
}

$('plAll').onchange = () => {
  picked = $('plAll').checked ? new Set(info.entries.map((_, i) => i)) : new Set();
  renderPlaylist();
};

$('plHint').onclick = () => { if (info?.playlistUrl) search(info.playlistUrl); };

function setType(t) {
  type = t;
  $('seg').classList.toggle('mp3', t === 'mp3');
  $('seg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.type === t));
  show('added', false);
  renderChips();
}
$('seg').querySelectorAll('button').forEach((b) => { b.onclick = () => setType(b.dataset.type); });

async function search(url) {
  if (url != null) $('url').value = url;
  const value = $('url').value.trim();
  if (!value) { $('url').focus(); return; }
  alertMsg('');
  show('clipHint', false);
  busy($('btnInfo'), true, 'Buscando');
  try {
    const res = await api.info(value);
    if (!res.ok) throw new Error(res.error);
    info = res.info;
    $('thumb').src = info.thumbnail || '';
    $('title').textContent = info.title || 'Sem título';
    const pl = !!info.playlist;
    const count = pl ? `${info.entries.length} vídeo${info.entries.length > 1 ? 's' : ''}` : '';
    $('author').textContent = [info.uploader, count].filter(Boolean).join(' · ');
    $('site').textContent = pl ? 'Playlist' : info.site || '';
    $('dur').textContent = fmtDur(info.duration);
    show('dur', !!info.duration);
    show('site', pl || !!info.site);
    show('thumb', !!info.thumbnail);
    show('plBox', pl);
    show('plHint', !pl && !!info.playlistUrl);
    if (pl) {
      picked = new Set(info.entries.map((_, i) => i));
      $('plFolder').textContent = info.folder;
      $('plSkipped').textContent = info.skipped ? `${info.skipped} privado${info.skipped > 1 ? 's' : ''}/removido${info.skipped > 1 ? 's' : ''} ignorado${info.skipped > 1 ? 's' : ''}` : '';
      renderPlaylist();
    }
    quality = null;
    setType(settings.type === 'mp3' ? 'mp3' : 'mp4');
    show('result');
    show('platforms', false);
  } catch (err) {
    alertMsg(err.message);
  } finally {
    busy($('btnInfo'), false);
  }
}

$('form').addEventListener('submit', (e) => { e.preventDefault(); search(); });

$('btnPaste').onclick = async () => {
  const t = (await api.readClipboard()).trim();
  if (!t) { alertMsg('A área de transferência está vazia. Copie um link primeiro.'); return; }
  lastClip = t;
  search(t);
};

$('btnDownload').onclick = async () => {
  if (!info) return;
  let res;
  if (info.playlist) {
    const items = info.entries.filter((_, i) => picked.has(i));
    if (!items.length) return;
    batches.set(info.folder, Date.now());
    res = await api.addJobs({ items, type, quality, folder: info.folder });
    $('added').textContent = `✓ ${items.length} adicionado${items.length > 1 ? 's' : ''} aos downloads`;
  } else {
    res = await api.addJob({
      url: info.url, type, quality, title: info.title, thumbnail: info.thumbnail, duration: info.duration,
    });
    $('added').textContent = '✓ Adicionado aos downloads';
  }
  if (!res.ok) { alertMsg(res.error); return; }
  api.setSettings(type === 'mp3' ? { type, audioQuality: quality } : { type, videoQuality: quality }).then((s) => { settings = s; });
  show('added');
};

// ---------- link copiado / arrastado ----------
async function checkClipboard() {
  let t = '';
  try { t = (await api.readClipboard()).trim(); } catch { return; }
  if (!isUrl(t) || t === lastClip || t === $('url').value.trim() || t === info?.url) return;
  lastClip = t;
  const hint = $('clipHint');
  hint.replaceChildren(el('b', '', 'Link copiado detectado:'), el('span', '', t), el('b', '', 'Buscar →'));
  hint.onclick = () => search(t);
  show('clipHint');
}
api.onFocus(checkClipboard);

window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dropping');
  const t = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').split(/\r?\n/)[0].trim();
  if (isUrl(t)) search(t);
});

// ---------- lista de downloads ----------
const STATUS_TEXT = {
  'na fila': 'Na fila',
  baixando: 'Baixando',
  convertendo: 'Finalizando…',
  pronto: 'Pronto',
  erro: 'Erro',
  cancelado: 'Cancelado',
};

function qualityLabel(j) {
  if (j.type === 'mp3') return `MP3 · ${j.quality} kbps`;
  return `MP4 · ${j.quality === 'best' ? 'Melhor' : `${j.quality}p`}`;
}

function jobButton(label, onclick, primary) {
  const b = el('button', `job-btn${primary ? ' primary' : ''}`, label);
  b.type = 'button';
  b.onclick = onclick;
  return b;
}

function renderJob(j) {
  let card = document.querySelector(`.job[data-id="${j.id}"]`);
  if (!card) {
    card = el('div', 'job');
    card.dataset.id = j.id;
    const thumb = el('div', 'job-thumb');
    if (j.thumbnail) {
      const img = el('img');
      img.src = j.thumbnail;
      img.alt = '';
      img.onerror = () => img.remove();
      thumb.append(img);
    }
    thumb.append(el('span', 'fmt', j.type.toUpperCase()));
    const body = el('div', 'job-body');
    const x = el('button', 'job-x', '✕');
    x.type = 'button';
    x.title = 'Remover da lista';
    x.onclick = () => api.removeJob(j.id);
    card.append(thumb, body, x);
    // mais recentes primeiro
    $('jobs').prepend(card);
  }
  const body = card.querySelector('.job-body');
  const title = el('div', 'job-title', j.title || j.url);
  title.title = j.title || j.url;
  const meta = el('div', 'job-meta');
  const left = el('span', '', qualityLabel(j));
  let rightText = STATUS_TEXT[j.status] || j.status;
  if (j.status === 'baixando') rightText = `${j.percent.toFixed(0)}%${j.speed && j.speed !== 'Unknown B/s' ? ` · ${j.speed}` : ''}`;
  if (j.status === 'pronto' && j.size) rightText = `Pronto · ${fmtSize(j.size)}`;
  meta.append(left, el('span', `st-${j.status}`, rightText));
  const parts = [title, meta];

  if (ACTIVE.includes(j.status)) {
    const track = el('div', 'track');
    const fill = el('div', `fill${j.status !== 'baixando' ? ' indet' : ''}`);
    fill.style.width = `${j.percent}%`;
    track.append(fill);
    parts.push(track);
  }
  if (j.status === 'erro' && j.error) parts.push(el('div', 'job-err', j.error));

  const actions = el('div', 'job-actions');
  if (j.status === 'pronto') {
    actions.append(
      jobButton('▶ Abrir', async () => { const err = await api.openFile(j.file); if (err) toast(err, 'err'); }, true),
      jobButton('Mostrar na pasta', () => api.showFile(j.file)),
    );
  } else if (ACTIVE.includes(j.status)) {
    actions.append(jobButton('Cancelar', () => api.cancelJob(j.id)));
  } else {
    actions.append(jobButton('↻ Tentar de novo', () => api.retryJob(j.id)));
  }
  parts.push(actions);
  body.replaceChildren(...parts);
}

function updateCounts() {
  const all = [...jobs.values()];
  const active = all.filter((j) => ACTIVE.includes(j.status)).length;
  $('dlCount').textContent = active ? String(active) : '';
  show('jobsEmpty', all.length === 0);
  show('jobs', all.length > 0);
  document.title = active ? `MP43 · ${active} baixando` : 'MP43';
}

api.onJob((j) => {
  const prev = jobs.get(j.id);
  jobs.set(j.id, j);
  renderJob(j);
  updateCounts();
  if (prev && prev.status !== j.status) {
    if (j.folder && batches.has(j.folder)) { batchDone(j.folder); return; }
    if (j.status === 'pronto') toast(`Pronto: ${j.fileName}`, 'ok', { label: 'Abrir', run: () => api.openFile(j.file) });
    if (j.status === 'erro') toast('Um download falhou. Veja os detalhes na lista.', 'err');
  }
});

// Playlist: um aviso só quando todos os vídeos terminarem, em vez de um por vídeo.
function batchDone(folder) {
  const since = batches.get(folder);
  const mine = [...jobs.values()].filter((x) => x.folder === folder && x.created >= since);
  if (!mine.length || mine.some((x) => ACTIVE.includes(x.status))) return;
  batches.delete(folder);
  const ok = mine.filter((x) => x.status === 'pronto');
  const failed = mine.filter((x) => x.status === 'erro').length;
  const text = `Playlist "${folder}": ${ok.length} de ${mine.length} baixados${failed ? ` · ${failed} com erro` : ''}`;
  toast(text, failed ? 'err' : 'ok', ok.length ? { label: 'Abrir pasta', run: () => api.showFile(ok[0].file) } : null);
}

api.onJobRemoved((id) => {
  jobs.delete(id);
  document.querySelector(`.job[data-id="${id}"]`)?.remove();
  updateCounts();
});

$('btnClear').onclick = () => api.clearJobs();
$('btnFolder').onclick = () => api.showFile(null);

// ---------- configurações / componentes ----------
function renderTools(status) {
  const list = $('toolList');
  list.replaceChildren(...status.map((t) => {
    const row = el('div', `tool${t.found ? '' : ' missing'}`);
    row.append(el('span', 'dot'), el('b', '', t.label),
      el('span', '', t.found ? (t.version || 'instalado') : (t.required ? 'não encontrado (obrigatório)' : 'não encontrado (recomendado)')));
    if (t.found) row.append(el('span', 'src', t.source === 'app' ? 'incluído no MP43' : 'do sistema'));
    row.title = t.path || '';
    return row;
  }));
  const missing = status.filter((t) => t.required && !t.found).map((t) => t.label);
  show('toolsBanner', missing.length > 0);
  $('toolsBannerText').textContent = missing.length ? `Não encontrei: ${missing.join(', ')}. Reinstale o MP43 para restaurá-los.` : '';
}

function openSettings() {
  $('outDir').textContent = settings.outDir;
  show('settings');
}

$('btnSettings').onclick = openSettings;
$('btnCloseSettings').onclick = () => show('settings', false);
$('settings').addEventListener('click', (e) => { if (e.target.id === 'settings') show('settings', false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') show('settings', false); });
$('btnChooseFolder').onclick = async () => {
  settings = await api.chooseFolder();
  $('outDir').textContent = settings.outDir;
};

async function updateTools() {
  const btn = $('btnInstall');
  const log = $('installLog');
  log.textContent = '';
  show('installLog');
  busy(btn, true, 'Atualizando…');
  try {
    const res = await api.updateTools();
    renderTools(res.status);
    if (!res.ok) {
      log.textContent += `${res.error}\n`;
      toast(res.error, 'err');
    } else {
      toast(res.upToDate ? 'O yt-dlp já está na versão mais recente.' : 'yt-dlp atualizado!', 'ok');
    }
  } finally {
    busy(btn, false);
  }
}

api.onToolsLog((line) => {
  const log = $('installLog');
  log.textContent += `${line}\n`;
  log.scrollTop = log.scrollHeight;
});
$('btnInstall').onclick = updateTools;
$('btnLicenses').onclick = () => api.openLicenses();

// ---------- início ----------
(async function init() {
  settings = await api.getSettings();
  for (const j of (await api.listJobs()).reverse()) {
    jobs.set(j.id, j);
    renderJob(j);
  }
  updateCounts();
  api.detectTools().then(renderTools);
  $('url').focus();
  checkClipboard();
})();
