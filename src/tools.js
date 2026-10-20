// Programas externos usados pelo MP43: yt-dlp (download), FFmpeg/ffprobe (junção
// de vídeo e MP3) e Deno (desafios de JavaScript do YouTube).
//
// Todos vão embutidos no instalador (pasta vendor). O yt-dlp é copiado para a pasta
// do usuário na primeira execução, porque precisa se atualizar com frequência
// ("yt-dlp -U") e a pasta do programa pode não ser gravável.
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');

let vendorDir = null;
let userBin = null;
let paths = {};
let sources = {};

function init(opts) {
  vendorDir = opts.vendorDir;
  userBin = opts.userBin;
}

function exists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// Plano B (versão de desenvolvimento sem vendor): programa instalado no sistema.
function findOnSystem(name) {
  try {
    const out = execFileSync('where.exe', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const first = out.split(/\r?\n/).find(Boolean);
    if (first) return first.trim();
  } catch { /* não está no PATH */ }
  const linked = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', `${name}.exe`);
  return exists(linked) ? linked : null;
}

function run(exe, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || '') });
    });
  });
}

async function version(exe, args) {
  const r = await run(exe, args);
  return r.ok ? r.out.split(/\r?\n/)[0].trim() : null;
}

// yt-dlp: usa a cópia do usuário; cria ou substitui quando a embutida for mais nova
// (ex.: depois de instalar uma versão nova do MP43).
async function prepareYtdlp() {
  const bundled = vendorDir && path.join(vendorDir, 'yt-dlp.exe');
  const userCopy = userBin && path.join(userBin, 'yt-dlp.exe');
  if (bundled && exists(bundled) && userCopy) {
    const bundledVer = await version(bundled, ['--version']);
    const userVer = exists(userCopy) ? await version(userCopy, ['--version']) : null;
    if (!userVer || (bundledVer && bundledVer > userVer)) {
      fs.mkdirSync(userBin, { recursive: true });
      fs.copyFileSync(bundled, userCopy);
    }
    return { exe: userCopy, source: 'app' };
  }
  if (userCopy && exists(userCopy)) return { exe: userCopy, source: 'app' };
  const sys = findOnSystem('yt-dlp');
  return { exe: sys, source: sys ? 'sistema' : null };
}

function locate(bundledRel, name) {
  const bundled = vendorDir && path.join(vendorDir, bundledRel);
  if (bundled && exists(bundled)) return { exe: bundled, source: 'app' };
  const sys = findOnSystem(name);
  return { exe: sys, source: sys ? 'sistema' : null };
}

const LABELS = { ytdlp: 'yt-dlp', ffmpeg: 'FFmpeg', deno: 'Deno' };

async function detect() {
  const found = {
    ytdlp: await prepareYtdlp(),
    ffmpeg: locate(path.join('ffmpeg', 'ffmpeg.exe'), 'ffmpeg'),
    deno: locate('deno.exe', 'deno'),
  };
  paths = {};
  sources = {};
  const status = [];
  for (const [key, { exe, source }] of Object.entries(found)) {
    paths[key] = exe;
    sources[key] = source;
    let ver = null;
    if (exe) {
      ver = await version(exe, key === 'ffmpeg' ? ['-version'] : ['--version']);
      if (ver && key === 'ffmpeg') ver = ver.replace(/^ffmpeg version (\S+).*/, '$1');
      if (ver && key === 'deno') ver = ver.replace(/^deno (\S+).*/, '$1');
    }
    status.push({ key, label: LABELS[key], required: key !== 'deno', found: !!exe, path: exe, version: ver, source });
  }
  return status;
}

const get = (key) => paths[key] || null;

// Ambiente dos processos filhos: o yt-dlp procura o Deno no PATH.
function childEnv() {
  const env = { ...process.env };
  if (paths.deno) env.PATH = path.dirname(paths.deno) + path.delimiter + (process.env.PATH || '');
  return env;
}

// Atualiza o yt-dlp com o próprio atualizador dele.
function updateYtdlp(onLine) {
  const exe = paths.ytdlp;
  if (!exe) return Promise.reject(new Error('O yt-dlp não foi encontrado. Reinstale o MP43.'));
  if (sources.ytdlp !== 'app') {
    return Promise.reject(new Error('Este yt-dlp é do sistema; atualize-o com: winget upgrade yt-dlp.yt-dlp'));
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, ['-U'], { windowsHide: true, env: childEnv() });
    let out = '';
    const feed = (d) => {
      const text = d.toString('utf8');
      out += text;
      text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((l) => onLine?.(l));
    };
    proc.stdout.on('data', feed);
    proc.stderr.on('data', feed);
    proc.on('error', (e) => reject(new Error(`Não foi possível executar o yt-dlp: ${e.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve({ upToDate: /up to date|atualizado/i.test(out) });
      else reject(new Error((out.split('\n').reverse().find((l) => /ERROR/.test(l)) || 'A atualização falhou.').replace(/^ERROR:\s*/, '').trim()));
    });
  });
}

module.exports = { init, detect, get, childEnv, updateYtdlp };
