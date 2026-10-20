// Motor de downloads do MP43: mesma configuração do yt-dlp usada no site,
// com fila local, cancelamento e eventos de progresso.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');
const tools = require('./tools');

const VIDEO_QUALITIES = { best: null, 2160: 2160, 1440: 1440, 1080: 1080, 720: 720, 480: 480, 360: 360 };
const AUDIO_QUALITIES = { 320: '320K', 192: '192K', 128: '128K' };
const MAX_RUNNING = 3;
const ACTIVE = new Set(['na fila', 'baixando', 'convertendo']);

function commonArgs() {
  // --encoding utf-8: sem isso o Windows entrega títulos com acento/emoji corrompidos.
  return ['--ignore-config', '--encoding', 'utf-8', '--no-playlist', '--no-color'];
}

function requireYtdlp() {
  const exe = tools.get('ytdlp');
  if (!exe) throw new Error('O yt-dlp não está instalado. Abra as Configurações e clique em "Instalar componentes".');
  return exe;
}

function parseUrl(u) {
  try {
    const p = new URL(String(u || '').trim());
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.toString() : null;
  } catch {
    return null;
  }
}

// Nome de pasta seguro no Windows (usado para a pasta de cada playlist).
function safeFolder(name) {
  let s = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `_${s}`;
  return s || 'Playlist';
}

// Miniatura pequena (as listas mostram imagens de ~100px).
function smallThumb(e) {
  const list = (e.thumbnails || []).filter((t) => t.url).sort((a, b) => (a.width || 0) - (b.width || 0));
  return (list.find((t) => (t.width || 0) >= 120) || list[list.length - 1])?.url || e.thumbnail || null;
}

// Link de vídeo que também traz uma playlist (watch?v=...&list=...): oferece a playlist inteira.
function playlistOf(url) {
  try {
    const u = new URL(url);
    const list = u.searchParams.get('list');
    if (!list || !u.searchParams.get('v') || !/(^|\.)(youtube\.com|youtu\.be)$/i.test(u.hostname)) return null;
    return `https://www.youtube.com/playlist?list=${encodeURIComponent(list)}`;
  } catch {
    return null;
  }
}

function playlistInfo(url, j) {
  const entries = [];
  let skipped = 0;
  for (const e of j.entries || []) {
    const link = parseUrl(e.webpage_url || e.url);
    // O YouTube mantém vídeos removidos/privados na lista com esses títulos.
    if (!link || /^\[(private|deleted) video\]$/i.test(e.title || '')) { skipped++; continue; }
    entries.push({ url: link, title: e.title || link, duration: e.duration || null, thumbnail: smallThumb(e), uploader: e.uploader || e.channel || null });
  }
  if (!entries.length) throw new Error('Essa playlist está vazia ou todos os vídeos são privados.');
  const thumbs = (j.thumbnails || []).filter((t) => t.url);
  return {
    url,
    playlist: true,
    title: j.title || 'Playlist',
    folder: safeFolder(j.title),
    thumbnail: thumbs[thumbs.length - 1]?.url || entries[0].thumbnail,
    duration: entries.reduce((s, e) => s + (e.duration || 0), 0) || null,
    uploader: j.uploader || j.channel,
    site: j.extractor_key,
    heights: [],
    entries,
    skipped,
  };
}

function getInfo(rawUrl) {
  const url = parseUrl(rawUrl);
  if (!url) return Promise.reject(new Error('Cole um link válido (começando com http:// ou https://).'));
  const exe = requireYtdlp();
  return new Promise((resolve, reject) => {
    // --flat-playlist: numa playlist só lista os vídeos (rápido), sem abrir cada um.
    const proc = spawn(exe, [...commonArgs(), '--flat-playlist', '-J', '--no-warnings', '--', url], { windowsHide: true, env: tools.childEnv() });
    const timer = setTimeout(() => proc.kill(), 120 * 1000);
    const out = [];
    let err = '';
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => reject(new Error(`Não foi possível iniciar o yt-dlp: ${e.message}`)));
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const line = err.split('\n').find((l) => l.startsWith('ERROR')) || '';
        if (/Unsupported URL|no suitable extractor/i.test(line)) return reject(new Error('Esse site não é suportado.'));
        return reject(new Error((line || 'Não foi possível ler esse link.').replace(/^ERROR:\s*/, '').trim()));
      }
      let j;
      try {
        j = JSON.parse(Buffer.concat(out).toString('utf8'));
      } catch {
        return reject(new Error('Resposta inesperada do yt-dlp.'));
      }
      try {
        if (j._type === 'playlist') return resolve(playlistInfo(url, j));
        const heights = [...new Set((j.formats || []).map((f) => f.height).filter(Boolean))].sort((a, b) => b - a);
        resolve({
          url,
          title: j.title,
          thumbnail: j.thumbnail,
          duration: j.duration,
          uploader: j.uploader || j.channel,
          site: j.extractor_key,
          heights,
          playlistUrl: playlistOf(url),
        });
      } catch (err) {
        reject(err);
      }
    });
  });
}

function friendlyError(job, code) {
  const all = job.log.join('\n');
  if (/Sign in to confirm|confirm you.re not a bot/i.test(all)) return 'O YouTube pediu verificação. Tente de novo mais tarde ou atualize os componentes.';
  if (/Private video/i.test(all)) return 'Esse vídeo é privado.';
  if (/No space left/i.test(all)) return 'Não há espaço suficiente no disco.';
  const errLine = [...job.log].reverse().find((l) => l.startsWith('ERROR'));
  if (errLine) return errLine.replace(/^ERROR:\s*/, '');
  return code === 0 ? 'O download terminou, mas o arquivo não foi encontrado.' : `O download falhou (código ${code}).`;
}

// Plano B: o nome do arquivo sempre termina com "[id].ext", então dá para achá-lo pelo id do vídeo.
function findById(dir, videoId, type) {
  if (!videoId) return null;
  const ext = type === 'mp3' ? '.mp3' : '.mp4';
  try {
    const name = fs.readdirSync(dir).find((n) => n.endsWith(`[${videoId}]${ext}`));
    return name ? path.join(dir, name) : null;
  } catch {
    return null;
  }
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  // yt-dlp abre o ffmpeg como filho; /T encerra a árvore toda.
  execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
}

class Downloader extends EventEmitter {
  constructor(getOutDir) {
    super();
    this.getOutDir = getOutDir;
    this.jobs = new Map();
    this.procs = new Map();
  }

  public(job) {
    const { log, ...rest } = job;
    return { ...rest, fileName: job.file ? path.basename(job.file) : null };
  }

  emitJob(job) {
    this.emit('update', this.public(job));
  }

  // folder: subpasta dentro da pasta de downloads (o nome da playlist).
  add({ url, type, quality, title, thumbnail, duration, folder }) {
    const clean = parseUrl(url);
    if (!clean) throw new Error('Link inválido.');
    if (type !== 'mp4' && type !== 'mp3') throw new Error('Formato inválido.');
    folder = folder ? safeFolder(folder) : null;
    const job = {
      id: crypto.randomBytes(8).toString('hex'),
      url: clean, type, quality: String(quality || (type === 'mp3' ? '320' : 'best')),
      title: title || clean, thumbnail: thumbnail || null, duration: duration || null, folder,
      outDir: folder ? path.join(this.getOutDir(), folder) : this.getOutDir(), created: this.nextCreated(),
      status: 'na fila', percent: 0, speed: '', eta: '', file: null, error: null, log: [],
    };
    this.jobs.set(job.id, job);
    this.emitJob(job);
    this.pump();
    return this.public(job);
  }

  // Horários únicos: uma playlist entra toda no mesmo milissegundo e a fila precisa manter a ordem.
  nextCreated() {
    this.lastCreated = Math.max(Date.now(), (this.lastCreated || 0) + 1);
    return this.lastCreated;
  }

  retry(id) {
    const old = this.jobs.get(id);
    if (!old) throw new Error('Download não encontrado.');
    this.jobs.delete(id);
    this.emit('removed', id);
    return this.add(old);
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job || !ACTIVE.has(job.status)) return;
    job.cancelled = true;
    const proc = this.procs.get(id);
    if (proc) killTree(proc);
    else {
      job.status = 'cancelado';
      this.emitJob(job);
    }
  }

  remove(id) {
    const job = this.jobs.get(id);
    if (job && ACTIVE.has(job.status)) this.cancel(id);
    this.jobs.delete(id);
    this.emit('removed', id);
  }

  activeCount() {
    return [...this.jobs.values()].filter((j) => ACTIVE.has(j.status)).length;
  }

  cancelAll() {
    for (const id of this.jobs.keys()) this.cancel(id);
  }

  pump() {
    const running = [...this.jobs.values()].filter((j) => j.status === 'baixando' || j.status === 'convertendo').length;
    const next = [...this.jobs.values()].filter((j) => j.status === 'na fila').sort((a, b) => a.created - b.created);
    for (const job of next.slice(0, Math.max(0, MAX_RUNNING - running))) this.start(job);
  }

  start(job) {
    let exe;
    try {
      exe = requireYtdlp();
    } catch (err) {
      job.status = 'erro';
      job.error = err.message;
      this.emitJob(job);
      return;
    }
    fs.mkdirSync(job.outDir, { recursive: true });
    const args = [...commonArgs(), '--newline', '--windows-filenames', '-P', job.outDir, '-o', '%(title).120B [%(id)s].%(ext)s'];
    const ffmpeg = tools.get('ffmpeg');
    if (ffmpeg) args.push('--ffmpeg-location', path.dirname(ffmpeg));
    args.push('--progress-template', 'download:PROG|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s');
    args.push('--print', 'after_move:VID|%(id)s');
    args.push('--print', 'after_move:FILE|%(filepath)s');
    if (job.type === 'mp3') {
      args.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', AUDIO_QUALITIES[job.quality] || '320K',
        '--embed-thumbnail', '--embed-metadata');
    } else {
      const h = VIDEO_QUALITIES[job.quality];
      // Prefere H.264 + AAC para o MP4 abrir em qualquer player do Windows/celular.
      args.push('-S', `${h ? `res:${h},` : ''}vcodec:h264,acodec:aac`, '--merge-output-format', 'mp4',
        '--remux-video', 'mp4', '--embed-metadata');
    }
    args.push('--', job.url);

    job.status = 'baixando';
    job.percent = 0;
    job.log = [];
    this.emitJob(job);

    const proc = spawn(exe, args, { windowsHide: true, env: tools.childEnv() });
    this.procs.set(job.id, proc);
    let lastEmit = 0;
    const onLine = (raw) => {
      const line = raw.trim();
      if (!line) return;
      if (line.startsWith('PROG|')) {
        const [, pct, speed, eta] = line.split('|');
        job.percent = Math.max(job.percent, parseFloat(pct) || 0);
        job.speed = (speed || '').trim();
        job.eta = (eta || '').trim();
      } else if (line.startsWith('VID|')) {
        job.videoId = line.slice(4).trim();
      } else if (line.startsWith('FILE|')) {
        job.file = line.slice(5).trim();
      } else {
        if (/\[(ExtractAudio|Merger|VideoRemuxer|EmbedThumbnail|Metadata)\]/.test(line)) job.status = 'convertendo';
        job.log.push(line);
        if (job.log.length > 40) job.log.shift();
      }
      const now = Date.now();
      if (now - lastEmit > 250) {
        lastEmit = now;
        this.emitJob(job);
      }
    };
    const buf = { out: '', err: '' };
    const feed = (key) => (chunk) => {
      buf[key] += chunk.toString('utf8');
      const parts = buf[key].split(/\r?\n/);
      buf[key] = parts.pop();
      parts.forEach(onLine);
    };
    proc.stdout.on('data', feed('out'));
    proc.stderr.on('data', feed('err'));
    proc.on('error', (e) => job.log.push(`ERROR: ${e.message}`));
    proc.on('close', (code) => {
      this.procs.delete(job.id);
      onLine(buf.out);
      onLine(buf.err);
      if (!this.jobs.has(job.id)) { this.pump(); return; }
      if (job.cancelled) {
        job.status = 'cancelado';
      } else {
        if (code === 0 && !(job.file && fs.existsSync(job.file))) job.file = findById(job.outDir, job.videoId, job.type);
        if (code === 0 && job.file) {
          job.status = 'pronto';
          job.percent = 100;
          job.size = fs.statSync(job.file).size;
        } else {
          job.status = 'erro';
          job.error = friendlyError(job, code);
        }
      }
      job.finished = Date.now();
      this.emitJob(job);
      this.emit('finished', this.public(job));
      this.pump();
    });
  }

  // Restaura o histórico salvo (somente itens finalizados).
  load(items) {
    for (const it of items) {
      if (ACTIVE.has(it.status)) continue;
      this.jobs.set(it.id, { ...it, log: [] });
    }
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => b.created - a.created).map((j) => this.public(j));
  }

  history() {
    return this.list().filter((j) => !ACTIVE.has(j.status)).slice(0, 200);
  }
}

module.exports = { Downloader, getInfo };
