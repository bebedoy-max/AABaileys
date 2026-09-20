/**
 * wa-gateway-baileys
 *
 * Gateway WhatsApp berbasis Baileys yang meniru SEBAGIAN API WAHA, cukup untuk
 * dipakai aplikasi blast lewat menu Pengaturan Sistem > WA Gateway (URL + API key).
 * Keunggulan utama: mengirim pesan BERTOMBOL native (cta_url, quick_reply, cta_call,
 * cta_copy) yang tidak bisa dikirim WAHA engine GOWS.
 *
 * Endpoint yang tersedia (semua di bawah /api butuh header X-Api-Key):
 *   GET    /health
 *   GET    /api/sessions?all=true
 *   POST   /api/sessions                      { name }
 *   GET    /api/sessions/:name
 *   POST   /api/sessions/:name/start | /stop | /logout
 *   DELETE /api/sessions/:name
 *   GET    /api/:name/auth/qr?format=raw      -> { value }
 *   POST   /api/:name/auth/request-code       { phoneNumber } -> { code }
 *   POST   /api/sendText | sendImage | sendVideo | sendVoice | sendFile | sendButtons
 *   GET    /api/:name/profile
 *   PUT    /api/:name/profile/name            { name }
 *   PUT    /api/:name/profile/picture         { file: { mimetype, filename, data } }
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import P from 'pino';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  generateWAMessage,
  generateWAMessageFromContent,
  jidNormalizedUser,
  proto,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

/* ------------------------------ konfigurasi ------------------------------ */

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || '';
const DATA_DIR = process.env.DATA_DIR || './data';
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const REPORT_ENGINE = (process.env.REPORT_ENGINE || 'NOWEB').toUpperCase();
const BUTTON_BOT_NODE = (process.env.BUTTON_BOT_NODE ?? '1') === '1';
const BUTTON_WRAP = process.env.BUTTON_WRAP === '1';
const APP_INBOUND_URL = process.env.APP_INBOUND_URL || '';
const WA_CRON_SECRET = process.env.WA_CRON_SECRET || '';
const LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
// Berapa lama (ms) gateway menunggu kabar dari server WhatsApp setelah mengirim pesan.
// Penolakan server biasanya datang < 1 detik; tanda "diterima penerima" mempercepat balasan.
const ACK_WAIT_MS = Number(process.env.ACK_WAIT_MS || 3000);
// Perlindungan nomor: setelah WhatsApp menolak pesan (mis. kode 463 = dibatasi), pengiriman
// dari nomor itu ditahan. Setiap penolakan beruntun menggandakan waktu tahan (maks 24 jam).
const RESTRICT_COOLDOWN_MIN = Number(process.env.RESTRICT_COOLDOWN_MIN || 60);
const ERROR_STREAK_TRIP = Number(process.env.ERROR_STREAK_TRIP || 3);
// Perlindungan SSRF untuk file dari URL: tolak alamat internal (localhost, 10.x, 192.168.x, 169.254.x, dst).
// Kalau perlu mengizinkan host internal tertentu, isi daftar host dipisah koma. Contoh: "supabase-kong,minio".
const ALLOW_PRIVATE_MEDIA_HOSTS = new Set(
  (process.env.ALLOW_PRIVATE_MEDIA_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);
const MEDIA_MAX_BYTES = Number(process.env.MEDIA_MAX_MB || 25) * 1024 * 1024;

if (!API_KEY) {
  console.error('API_KEY wajib diisi (environment variable). Server dihentikan.');
  process.exit(1);
}

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
const logger = P({ level: LOG_LEVEL });

/* -------------------------------- utilitas -------------------------------- */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VALID_NAME = /^(?!\.+$)[\w.-]{1,100}$/;
const safeDirName = (name) => name.replace(/[^a-zA-Z0-9_.-]/g, '_');

/** "62812345:12@s.whatsapp.net" -> "62812345" */
const phoneOf = (jid) =>
  String(jid || '')
    .split('@')[0]
    .split(':')[0]
    .replace(/\D/g, '');

/** chatId gaya WAHA ("628xx@c.us") -> JID Baileys ("628xx@s.whatsapp.net"). */
function toJid(chatId) {
  const raw = String(chatId || '').trim();
  if (!raw) throw new HttpError(422, 'chatId wajib diisi');
  if (raw.endsWith('@c.us')) return `${raw.slice(0, -5)}@s.whatsapp.net`;
  if (raw.includes('@')) return raw;
  const digits = raw.replace(/\D/g, '');
  if (!digits) throw new HttpError(422, 'chatId tidak valid');
  return `${digits}@s.whatsapp.net`;
}

/* --------------------------------- sesi ---------------------------------- */

/**
 * Status mentah mengikuti WAHA: STOPPED | STARTING | SCAN_QR_CODE | WORKING | FAILED
 * @typedef {object} Sess
 */
const sessions = new Map();

let waVersionCache = { value: undefined, at: 0 };
async function getWaVersion() {
  if (Date.now() - waVersionCache.at < 3_600_000) return waVersionCache.value;
  try {
    const { version } = await fetchLatestBaileysVersion();
    waVersionCache = { value: version, at: Date.now() };
  } catch {
    // gagal ambil versi terbaru: pakai bawaan Baileys, coba lagi ~5 menit lagi
    waVersionCache = { value: undefined, at: Date.now() - 3_300_000 };
  }
  return waVersionCache.value;
}

function newSession(name, dir) {
  return {
    name,
    dir: dir || path.join(SESSIONS_DIR, safeDirName(name)),
    sock: null,
    rawStatus: 'STOPPED',
    qr: null,
    gen: 0, // penanda "generasi" socket; event dari socket lama diabaikan
    retry: 0,
    timer: null,
    lastUser: null,
    sent: new Map(), // cache pesan terkirim untuk getMessage (retry Baileys)
    verdicts: new Map(), // id pesan -> hasil dari server WhatsApp { ok, code|via }
    waiters: new Map(), // id pesan -> fungsi yang menunggu hasil
    errStreak: 0, // penolakan beruntun
    tripCount: 0, // berapa kali pengiriman ditahan berturut-turut
    restrictedUntil: 0, // epoch ms; > sekarang = pengiriman ditahan
    restrictReason: '',
  };
}

function createSession(name) {
  if (!VALID_NAME.test(name)) throw new HttpError(422, 'Nama sesi tidak valid');
  if (sessions.has(name)) throw new HttpError(422, `Session "${name}" already exists`);
  const s = newSession(name);
  fs.mkdirSync(s.dir, { recursive: true });
  fs.writeFileSync(path.join(s.dir, 'meta.json'), JSON.stringify({ name }));
  sessions.set(name, s);
  return s;
}

function getSession(name) {
  const s = sessions.get(String(name || ''));
  if (!s) throw new HttpError(404, `Session "${name}" does not exist`);
  return s;
}

function wipeAuth(s) {
  try {
    for (const f of fs.readdirSync(s.dir)) {
      if (f !== 'meta.json') fs.rmSync(path.join(s.dir, f), { recursive: true, force: true });
    }
  } catch (err) {
    logger.warn({ err, session: s.name }, 'gagal menghapus data auth');
  }
}

/* ------------------- hasil pengiriman & perlindungan nomor ------------------- */

const statePath = (s) => path.join(s.dir, 'state.json');

function saveState(s) {
  try {
    fs.writeFileSync(
      statePath(s),
      JSON.stringify({
        restrictedUntil: s.restrictedUntil,
        restrictReason: s.restrictReason,
        tripCount: s.tripCount,
      }),
    );
  } catch (err) {
    logger.warn({ err: err?.message, session: s.name }, 'gagal menyimpan state pembatasan');
  }
}

function loadState(s) {
  try {
    const j = JSON.parse(fs.readFileSync(statePath(s), 'utf8'));
    s.restrictedUntil = Number(j.restrictedUntil) || 0;
    s.restrictReason = String(j.restrictReason || '');
    s.tripCount = Number(j.tripCount) || 0;
  } catch {
    /* belum ada state */
  }
}

const isRestricted = (s) => s.restrictedUntil > Date.now();

const clockWib = (ms) =>
  new Date(ms).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });

function restrictedMessage(s) {
  return `Nomor pengirim dibatasi WhatsApp (${s.restrictReason || 'ditolak server'}); pengiriman dari nomor ini ditahan sampai ${clockWib(s.restrictedUntil)} WIB.`;
}

function resetRestriction(s) {
  s.restrictedUntil = 0;
  s.restrictReason = '';
  s.tripCount = 0;
  s.errStreak = 0;
}

/** Tahan pengiriman dari sesi ini. Waktu tahan menggandakan tiap kejadian beruntun. */
function tripRestriction(s, reason, minutesOverride) {
  s.tripCount += 1;
  const minutes =
    minutesOverride ?? Math.min(RESTRICT_COOLDOWN_MIN * 2 ** (s.tripCount - 1), 24 * 60);
  s.restrictedUntil = Date.now() + minutes * 60_000;
  s.restrictReason = reason;
  s.errStreak = 0;
  saveState(s);
  logger.warn({ session: s.name, reason, minutes }, 'pengiriman dari nomor ini ditahan');
}

// Status pesan Baileys: ERROR=0, PENDING=1, SERVER_ACK=2, DELIVERY_ACK=3, READ=4, PLAYED=5
const ST = { ERROR: 0, SERVER_ACK: 2, DELIVERY_ACK: 3 };

function statusNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = proto.WebMessageInfo?.Status?.[v];
    return typeof n === 'number' ? n : -1;
  }
  return -1;
}

/** Catat kabar status pesan keluar dari server WhatsApp (penolakan atau tanda diterima). */
function recordAck(s, update) {
  const key = update?.key;
  const status = update?.update?.status;
  if (!key?.fromMe || !key.id || status === undefined) return;

  const st = statusNumber(status);
  let verdict = null;
  if (st === ST.ERROR) {
    verdict = { ok: false, code: String(update.update.messageStubParameters?.[0] ?? '?') };
  } else if (st >= ST.SERVER_ACK) {
    verdict = { ok: true, via: st >= ST.DELIVERY_ACK ? 'delivered' : 'server' };
  }
  if (!verdict) return;

  s.verdicts.set(key.id, verdict);
  if (s.verdicts.size > 500) s.verdicts.delete(s.verdicts.keys().next().value);
  const waiter = s.waiters.get(key.id);
  if (waiter) waiter(verdict);
}

/** Tunggu hasil pesan: ditolak (gagal), diterima (sukses), atau habis waktu (dianggap terkirim). */
function awaitVerdict(s, id, ms) {
  const known = s.verdicts.get(id);
  if (known) return Promise.resolve(known);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      s.waiters.delete(id);
      resolve({ ok: true, via: 'timeout' });
    }, ms);
    s.waiters.set(id, (verdict) => {
      clearTimeout(timer);
      s.waiters.delete(id);
      resolve(verdict);
    });
  });
}

/** Perbarui penghitung penolakan dan tahan nomor bila perlu. */
function applyVerdict(s, verdict) {
  if (verdict.ok) {
    s.errStreak = 0;
    if (verdict.via === 'delivered') s.tripCount = 0;
    return;
  }
  s.errStreak += 1;
  logger.warn({ session: s.name, code: verdict.code, streak: s.errStreak }, 'pesan ditolak server WhatsApp');
  // 463 = pembatasan pengiriman ke kontak baru; jangan diulang-ulang.
  if (verdict.code === '463' || s.errStreak >= ERROR_STREAK_TRIP) {
    tripRestriction(s, `kode ${verdict.code}`);
  }
}

/** Hentikan socket + timer sesi. Event lama otomatis diabaikan (gen naik). */
function teardown(s) {
  s.gen += 1;
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  const sock = s.sock;
  s.sock = null;
  s.qr = null;
  if (sock) {
    try {
      sock.end(undefined);
    } catch {
      /* sudah tertutup */
    }
  }
}

async function connect(s) {
  teardown(s);
  const gen = s.gen;
  s.rawStatus = 'STARTING';

  let auth;
  try {
    auth = await useMultiFileAuthState(s.dir);
  } catch (err) {
    logger.error({ err, session: s.name }, 'gagal membaca data auth');
    if (gen === s.gen) s.rawStatus = 'FAILED';
    return;
  }
  if (gen !== s.gen) return; // dibatalkan (stop/start ulang)

  const version = await getWaVersion();
  if (gen !== s.gen) return;

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: auth.state,
    logger: logger.child({ session: s.name }),
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    getMessage: async (key) => s.sent.get(key.id),
  });
  s.sock = sock;

  sock.ev.on('creds.update', auth.saveCreds);
  sock.ev.on('connection.update', (update) => onConnection(s, sock, gen, update));
  sock.ev.on('messages.update', (updates) => {
    if (gen !== s.gen) return;
    for (const u of updates) recordAck(s, u);
  });
  sock.ev.on('messages.upsert', (payload) => {
    if (gen !== s.gen) return;
    onMessages(s, payload).catch((err) => logger.warn({ err }, 'gagal memproses pesan masuk'));
  });
}

function scheduleReconnect(s, delayMs) {
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = null;
    connect(s).catch((err) => logger.error({ err, session: s.name }, 'gagal menyambung ulang'));
  }, delayMs);
}

function onConnection(s, sock, gen, { connection, lastDisconnect, qr }) {
  if (gen !== s.gen) return; // event dari socket lama

  if (qr) {
    s.qr = qr;
    s.rawStatus = 'SCAN_QR_CODE';
  }

  if (connection === 'open') {
    s.qr = null;
    s.retry = 0;
    s.rawStatus = 'WORKING';
    s.lastUser = sock.user || null;
    logger.warn({ session: s.name, me: phoneOf(sock.user?.id) }, 'sesi tersambung');
    return;
  }

  if (connection !== 'close') return;

  const code = lastDisconnect?.error?.output?.statusCode;
  s.qr = null;

  // Logout dari HP (Perangkat tertaut > Keluar): data auth tidak berlaku lagi.
  if (code === DisconnectReason.loggedOut) {
    logger.warn({ session: s.name }, 'sesi logout dari WhatsApp; data auth dihapus');
    teardown(s);
    wipeAuth(s);
    resetRestriction(s);
    s.lastUser = null;
    s.rawStatus = 'STOPPED';
    return;
  }

  // Akun ditolak WhatsApp (dibatasi/diblokir): jangan disambung ulang berulang-ulang.
  if (code === DisconnectReason.forbidden) {
    logger.warn({ session: s.name }, 'koneksi ditolak WhatsApp (403); pengiriman ditahan 24 jam');
    teardown(s);
    tripRestriction(s, 'koneksi ditolak WhatsApp (403)', 24 * 60);
    s.rawStatus = 'STOPPED';
    return;
  }

  // Sesi dipakai di tempat lain dengan kredensial yang sama.
  if (code === DisconnectReason.connectionReplaced) {
    logger.warn({ session: s.name }, 'sesi digantikan koneksi lain');
    teardown(s);
    s.rawStatus = 'FAILED';
    return;
  }

  const registered = Boolean(sock.authState?.creds?.registered);

  // Belum pernah dipasangkan dan QR kedaluwarsa: berhenti, jangan diulang terus.
  if (!registered && code !== DisconnectReason.restartRequired) {
    teardown(s);
    s.rawStatus = 'STOPPED';
    return;
  }

  // Putus sementara (atau restart wajib setelah pairing): sambung ulang.
  s.retry += 1;
  s.rawStatus = 'STARTING';
  const delay =
    code === DisconnectReason.restartRequired ? 300 : Math.min(30_000, 1000 * 2 ** Math.min(s.retry, 5));
  logger.warn({ session: s.name, code, delay }, 'koneksi putus, menyambung ulang');
  scheduleReconnect(s, delay);
}

/* ------------------------------ pesan masuk ------------------------------- */

function extractText(message) {
  const m = message?.ephemeralMessage?.message || message || {};
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.buttonsResponseMessage?.selectedDisplayText) return m.buttonsResponseMessage.selectedDisplayText;
  if (m.listResponseMessage?.title) return m.listResponseMessage.title;
  const params = m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (params) {
    try {
      const parsed = JSON.parse(params);
      return parsed.display_text || parsed.title || parsed.id || '';
    } catch {
      /* abaikan */
    }
  }
  return '';
}

/** Teruskan balasan masuk ke aplikasi (dipakai fitur Anti Ban: STOP / BERHENTI). */
async function onMessages(s, { messages, type }) {
  if (type !== 'notify' || !APP_INBOUND_URL || !WA_CRON_SECRET) return;

  for (const m of messages) {
    if (m.key.fromMe || !m.message) continue;
    const jid = m.key.remoteJid || '';
    if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue;

    const text = extractText(m.message);
    if (!text) continue;

    // Akun yang memakai LID: butuh nomor telepon asli. Baileys 7 menyediakannya di remoteJidAlt.
    const pnJid = jid.endsWith('@lid') ? m.key.remoteJidAlt || '' : jid;
    const from = phoneOf(pnJid);
    if (!from) {
      logger.warn({ jid }, 'balasan masuk dilewati: nomor telepon tidak diketahui (LID)');
      continue;
    }

    try {
      await fetch(APP_INBOUND_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-wa-secret': WA_CRON_SECRET },
        body: JSON.stringify({ session_id: s.name, from, text }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      logger.warn({ err: err?.message }, 'gagal meneruskan balasan masuk ke aplikasi');
    }
  }
}

/* ------------------------------ pengiriman -------------------------------- */

function remember(s, sent) {
  if (!sent?.key?.id || !sent.message) return;
  s.sent.set(sent.key.id, sent.message);
  if (s.sent.size > 300) s.sent.delete(s.sent.keys().next().value);
}

function sniffMime(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  const head4 = buf.subarray(0, 4).toString('latin1');
  if (head4 === '\x89PNG') return 'image/png';
  if (head4.startsWith('GIF')) return 'image/gif';
  if (head4 === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/* ------------------- perlindungan SSRF untuk file dari URL ------------------- */

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, termasuk metadata cloud
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224 // multicast/reserved
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^(fc|fd|fe[89ab])/.test(v); // unique-local dan link-local
  }
  return true; // bukan IP valid: anggap tidak aman
}

/** Hanya izinkan http(s) ke alamat publik. Melempar HttpError bila tidak aman. */
async function assertPublicUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new HttpError(422, 'URL file tidak valid');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new HttpError(422, 'URL file harus http atau https');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (ALLOW_PRIVATE_MEDIA_HOSTS.has(host)) return;

  let addrs;
  if (net.isIP(host)) {
    addrs = [{ address: host }];
  } else {
    try {
      addrs = await dns.lookup(host, { all: true });
    } catch {
      throw new HttpError(422, 'Host file tidak dapat ditemukan');
    }
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new HttpError(422, 'URL file mengarah ke alamat internal dan ditolak');
  }
}

async function readLimited(res, maxBytes) {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) throw new HttpError(422, 'File terlalu besar');
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) throw new HttpError(422, 'File terlalu besar');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Muat file dari { url } atau { data (base64) } seperti format WAHA. */
async function loadFile(file) {
  if (!file || typeof file !== 'object') throw new HttpError(422, 'file wajib diisi');
  let buffer;
  let headerMime = null;

  if (file.data) {
    buffer = Buffer.from(String(file.data), 'base64');
    if (buffer.length > MEDIA_MAX_BYTES) throw new HttpError(422, 'File terlalu besar');
  } else if (file.url) {
    let url = String(file.url);
    let res;
    try {
      for (let hop = 0; hop <= 3; hop += 1) {
        await assertPublicUrl(url);
        res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const next = res.headers.get('location');
          if (!next) break;
          url = new URL(next, url).toString(); // diperiksa ulang di putaran berikutnya
          continue;
        }
        break;
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(422, `Gagal mengunduh file: ${err?.message || err}`);
    }
    if (!res || !res.ok) throw new HttpError(422, `Gagal mengunduh file (HTTP ${res?.status ?? '?'})`);
    buffer = await readLimited(res, MEDIA_MAX_BYTES);
    headerMime = res.headers.get('content-type')?.split(';')[0] || null;
  } else {
    throw new HttpError(422, 'file.url atau file.data wajib diisi');
  }

  if (!buffer.length) throw new HttpError(422, 'File kosong');
  return {
    buffer,
    mimetype: sniffMime(buffer) || file.mimetype || headerMime || 'application/octet-stream',
    filename: file.filename || 'file',
  };
}

/** Sesi harus WORKING; kalau tidak, pesan belum terkirim sama sekali (aman diulang aplikasi). */
function target(body) {
  const s = getSession(body?.session);
  if (isRestricted(s)) throw new HttpError(503, restrictedMessage(s));
  if (s.rawStatus !== 'WORKING' || !s.sock) {
    throw new HttpError(422, 'Session status is not as expected');
  }
  return { s, sock: s.sock, jid: toJid(body?.chatId) };
}

/**
 * Putus koneksi di tengah pengiriman = hasil pengiriman TIDAK DIKETAHUI.
 * Dibalas 463 supaya aplikasi tidak mengulang pesan yang sama (mencegah pesan ganda).
 */
function classifySendError(err) {
  if (err instanceof HttpError) return err;
  const msg = String(err?.message || err);
  const code = err?.output?.statusCode;
  if (/connection closed|timed out|not open|stream errored|websocket/i.test(msg) || code === 428 || code === 408) {
    return new HttpError(463, 'websocket disconnected before message send returned response');
  }
  return new HttpError(500, msg);
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Bungkus handler pengiriman: cek sesi, jalankan, simpan cache, balas { id }. */
function sendRoute(handler) {
  return wrap(async (req, res) => {
    const ctx = target(req.body);
    let sent;
    try {
      sent = await handler(ctx, req.body);
    } catch (err) {
      throw classifySendError(err);
    }
    remember(ctx.s, sent);

    // "Berhasil" hanya jika server WhatsApp tidak menolak pesan itu.
    const id = sent?.key?.id ?? null;
    const verdict = id ? await awaitVerdict(ctx.s, id, ACK_WAIT_MS) : { ok: true, via: 'noid' };
    applyVerdict(ctx.s, verdict);
    if (!verdict.ok) {
      const suffix = isRestricted(ctx.s) ? ` ${restrictedMessage(ctx.s)}` : '';
      throw new HttpError(503, `Pesan ditolak server WhatsApp (kode ${verdict.code}).${suffix}`);
    }
    res.json({ id, key: sent?.key ?? null, delivery: verdict.via });
  });
}

const optionalText = (v) => String(v ?? '').trim() || undefined;

/* ------------------------------ pesan bertombol --------------------------- */

/** Tombol gaya WAHA -> tombol native flow WhatsApp. */
function toNativeButton(b, index) {
  const text = String(b?.text ?? '').trim();
  if (!text) return null;

  switch (b.type) {
    case 'url': {
      const url = String(b.url ?? '').trim();
      if (!url) return null;
      return {
        name: 'cta_url',
        buttonParamsJson: JSON.stringify({ display_text: text, url, merchant_url: url }),
      };
    }
    case 'reply':
      return {
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({ display_text: text, id: String(b.id || `qr_${index + 1}`) }),
      };
    case 'call': {
      const phone = String(b.phoneNumber ?? '').trim();
      if (!phone) return null;
      return {
        name: 'cta_call',
        buttonParamsJson: JSON.stringify({ display_text: text, phone_number: phone }),
      };
    }
    case 'copy': {
      const code = String(b.copyCode ?? '').trim();
      if (!code) return null;
      return {
        name: 'cta_copy',
        buttonParamsJson: JSON.stringify({ display_text: text, copy_code: code }),
      };
    }
    default:
      return null;
  }
}

function buttonNodes() {
  const nodes = [
    {
      tag: 'biz',
      attrs: {},
      content: [
        {
          tag: 'interactive',
          attrs: { type: 'native_flow', v: '1' },
          content: [{ tag: 'native_flow', attrs: { name: 'mixed', v: '9' } }],
        },
      ],
    },
  ];
  if (BUTTON_BOT_NODE) nodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
  return nodes;
}

/* --------------------------------- HTTP ----------------------------------- */

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '60mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, sessions: sessions.size }));

// Semua /api butuh X-Api-Key.
app.use('/api', (req, res, next) => {
  const given = Buffer.from(String(req.get('x-api-key') || ''));
  const expected = Buffer.from(API_KEY);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.status(401).json({ statusCode: 401, message: 'Unauthorized' });
  }
  return next();
});

function sessionPayload(s) {
  const user = s.sock?.user || s.lastUser;
  const phone = user ? phoneOf(user.id) : '';
  const held = isRestricted(s);
  return {
    name: s.name,
    // Saat ditahan, dilaporkan STOPPED agar aplikasi berhenti membagikan pesan ke nomor ini.
    status: held ? 'STOPPED' : s.rawStatus,
    ...(held
      ? { restriction: { reason: s.restrictReason, until: new Date(s.restrictedUntil).toISOString() } }
      : {}),
    config: {},
    // Aplikasi hanya mengirim gambar + tombol sekaligus jika engine = NOWEB.
    engine: { engine: REPORT_ENGINE },
    me: phone ? { id: `${phone}@c.us`, pushName: user?.name || null } : null,
  };
}

/* --- sesi --- */

app.get('/api/sessions', (_req, res) => res.json([...sessions.values()].map(sessionPayload)));

app.post(
  '/api/sessions',
  wrap(async (req, res) => {
    const s = createSession(String(req.body?.name || '').trim());
    res.status(201).json(sessionPayload(s));
  }),
);

app.get(
  '/api/sessions/:name',
  wrap(async (req, res) => res.json(sessionPayload(getSession(req.params.name)))),
);

app.post(
  '/api/sessions/:name/start',
  wrap(async (req, res) => {
    const s = getSession(req.params.name);
    // Nomor sedang ditahan: jangan disambung ulang. Alasannya ikut tampil di aplikasi.
    if (isRestricted(s)) throw new HttpError(503, restrictedMessage(s));
    if (!['STARTING', 'SCAN_QR_CODE', 'WORKING'].includes(s.rawStatus)) {
      connect(s).catch((err) => logger.error({ err, session: s.name }, 'gagal memulai sesi'));
    }
    res.status(201).json(sessionPayload(s));
  }),
);

app.post(
  '/api/sessions/:name/stop',
  wrap(async (req, res) => {
    const s = getSession(req.params.name);
    // Saat ditahan, koneksi dibiarkan (tidak diputus-sambung berulang oleh pemulihan otomatis aplikasi).
    if (!isRestricted(s)) {
      teardown(s);
      s.rawStatus = 'STOPPED';
    }
    res.status(201).json(sessionPayload(s));
  }),
);

// Hapus status "ditahan" secara manual (mis. setelah pembatasan WhatsApp dicabut).
app.post(
  '/api/sessions/:name/clear-restriction',
  wrap(async (req, res) => {
    const s = getSession(req.params.name);
    resetRestriction(s);
    saveState(s);
    res.json(sessionPayload(s));
  }),
);

app.post(
  '/api/sessions/:name/logout',
  wrap(async (req, res) => {
    const s = getSession(req.params.name);
    if (s.sock && s.rawStatus === 'WORKING') {
      try {
        await s.sock.logout();
      } catch (err) {
        logger.warn({ err: err?.message, session: s.name }, 'logout ke WhatsApp gagal, data lokal tetap dihapus');
      }
    }
    teardown(s);
    wipeAuth(s);
    resetRestriction(s);
    s.lastUser = null;
    s.rawStatus = 'STOPPED';
    res.status(201).json(sessionPayload(s));
  }),
);

app.delete(
  '/api/sessions/:name',
  wrap(async (req, res) => {
    const s = getSession(req.params.name);
    teardown(s);
    sessions.delete(s.name);
    fs.rmSync(s.dir, { recursive: true, force: true });
    res.json({ ok: true });
  }),
);

/* --- autentikasi / pairing --- */

app.get(
  '/api/:name/auth/qr',
  wrap(async (req, res) => {
    const s = getSession(req.params.name);
    if (s.rawStatus !== 'SCAN_QR_CODE' || !s.qr) {
      throw new HttpError(422, 'Session is not in SCAN_QR_CODE status');
    }
    res.json({ value: s.qr });
  }),
);

app.post(
  '/api/:name/auth/request-code',
  wrap(async (req, res) => {
    const s = getSession(req.params.name);
    const phone = String(req.body?.phoneNumber || '').replace(/\D/g, '');
    if (phone.length < 8) throw new HttpError(422, 'phoneNumber tidak valid');
    if (s.rawStatus !== 'SCAN_QR_CODE' || !s.sock) {
      throw new HttpError(422, 'Session is not in SCAN_QR_CODE status');
    }
    if (s.sock.authState?.creds?.registered) throw new HttpError(422, 'Sesi sudah terdaftar');

    try {
      const code = await s.sock.requestPairingCode(phone);
      res.json({ code });
    } catch (err) {
      const message = err?.message || 'Gagal meminta kode pairing';
      throw new HttpError(/rate|429|too many/i.test(message) ? 429 : 500, message);
    }
  }),
);

// Passkey (WebAuthn) hanya ada di WAHA GOWS; tidak didukung di sini.
app.all(/^\/api\/[^/]+\/auth\/passkey/, (_req, res) =>
  res.status(501).json({ statusCode: 501, message: 'Not implemented by this gateway' }),
);

/* --- kirim pesan --- */

app.post(
  '/api/sendText',
  sendRoute(({ sock, jid }, body) => sock.sendMessage(jid, { text: String(body.text ?? '') })),
);

app.post(
  '/api/sendImage',
  sendRoute(async ({ sock, jid }, body) => {
    const f = await loadFile(body.file);
    return sock.sendMessage(jid, { image: f.buffer, mimetype: f.mimetype, caption: optionalText(body.caption) });
  }),
);

app.post(
  '/api/sendVideo',
  sendRoute(async ({ sock, jid }, body) => {
    const f = await loadFile(body.file);
    const mimetype = f.mimetype.startsWith('video/') ? f.mimetype : 'video/mp4';
    return sock.sendMessage(jid, { video: f.buffer, mimetype, caption: optionalText(body.caption) });
  }),
);

app.post(
  '/api/sendVoice',
  sendRoute(async ({ sock, jid }, body) => {
    const f = await loadFile(body.file);
    // Catatan: WhatsApp hanya memutar voice note berformat OGG/OPUS. Tidak ada konversi otomatis di sini.
    const mimetype = f.mimetype.startsWith('audio/') ? f.mimetype : 'audio/ogg; codecs=opus';
    return sock.sendMessage(jid, { audio: f.buffer, mimetype, ptt: true });
  }),
);

app.post(
  '/api/sendFile',
  sendRoute(async ({ sock, jid }, body) => {
    const f = await loadFile(body.file);
    return sock.sendMessage(jid, {
      document: f.buffer,
      mimetype: f.mimetype,
      fileName: f.filename,
      caption: optionalText(body.caption),
    });
  }),
);

app.post(
  '/api/sendButtons',
  sendRoute(async ({ sock, jid }, body) => {
    const buttons = (Array.isArray(body.buttons) ? body.buttons : [])
      .slice(0, 3)
      .map(toNativeButton)
      .filter(Boolean);
    if (!buttons.length) throw new HttpError(422, 'buttons kosong atau tidak valid');

    let header = { hasMediaAttachment: false };
    if (body.headerImage) {
      const f = await loadFile(body.headerImage);
      const media = await generateWAMessage(
        jid,
        { image: f.buffer, mimetype: f.mimetype },
        { userJid: sock.user.id, upload: sock.waUploadToServer },
      );
      if (!media?.message?.imageMessage) throw new HttpError(500, 'Gagal mengunggah gambar header');
      header = { hasMediaAttachment: true, imageMessage: media.message.imageMessage };
    } else if (optionalText(body.header)) {
      header = { title: optionalText(body.header), hasMediaAttachment: false };
    }

    const footerText = optionalText(body.footer);
    const interactive = proto.Message.InteractiveMessage.create({
      header,
      body: { text: String(body.body ?? '') },
      ...(footerText ? { footer: { text: footerText } } : {}),
      nativeFlowMessage: { buttons },
    });

    const content = BUTTON_WRAP
      ? {
          viewOnceMessage: {
            message: {
              messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
              interactiveMessage: interactive,
            },
          },
        }
      : { interactiveMessage: interactive };

    const msg = generateWAMessageFromContent(jid, content, { userJid: sock.user.id });
    await sock.relayMessage(jid, msg.message, { messageId: msg.key.id, additionalNodes: buttonNodes() });
    return msg;
  }),
);

/* --- profil WhatsApp --- */

function workingSession(name) {
  const s = getSession(name);
  if (s.rawStatus !== 'WORKING' || !s.sock?.user) {
    throw new HttpError(422, 'Session status is not as expected');
  }
  return s;
}

app.get(
  '/api/:name/profile',
  wrap(async (req, res) => {
    const s = workingSession(req.params.name);
    const jid = jidNormalizedUser(s.sock.user.id);
    let picture = null;
    try {
      picture = (await s.sock.profilePictureUrl(jid, 'image')) || null;
    } catch {
      /* belum ada foto profil / disembunyikan */
    }
    res.json({ id: `${phoneOf(jid)}@c.us`, name: s.sock.user.name || null, picture });
  }),
);

app.put(
  '/api/:name/profile/name',
  wrap(async (req, res) => {
    const s = workingSession(req.params.name);
    const name = String(req.body?.name ?? '').trim();
    if (!name) throw new HttpError(422, 'name wajib diisi');
    await s.sock.updateProfileName(name);
    res.json({ ok: true });
  }),
);

app.put(
  '/api/:name/profile/picture',
  wrap(async (req, res) => {
    const s = workingSession(req.params.name);
    const f = await loadFile(req.body?.file);
    await s.sock.updateProfilePicture(jidNormalizedUser(s.sock.user.id), f.buffer);
    res.json({ ok: true });
  }),
);

/* --- penutup --- */

app.use((_req, res) => res.status(404).json({ statusCode: 404, message: 'Not Found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  if (status >= 500 && status !== 503) logger.error({ err }, 'permintaan gagal');
  res.status(status).json({ statusCode: status, message: err?.message || 'Internal error' });
});

/* --------------------------------- start ---------------------------------- */

process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
process.on('uncaughtException', (err) => logger.error({ err }, 'uncaughtException'));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

async function boot() {
  // Muat semua sesi yang tersimpan; yang sudah terpasang disambungkan otomatis (berjeda).
  for (const entry of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(SESSIONS_DIR, entry.name);

    let name = entry.name;
    try {
      name = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).name || name;
    } catch {
      /* pakai nama folder */
    }
    if (!VALID_NAME.test(name)) continue;

    const s = newSession(name, dir);
    loadState(s);
    sessions.set(name, s);

    let registered = false;
    try {
      registered = Boolean(JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8')).registered);
    } catch {
      /* belum ada kredensial */
    }
    if (registered && isRestricted(s)) {
      console.log(`sesi ${name} sedang ditahan sampai ${clockWib(s.restrictedUntil)} WIB (${s.restrictReason}); tidak disambungkan otomatis`);
    } else if (registered) {
      connect(s).catch((err) => logger.error({ err, session: name }, 'gagal auto-start sesi'));
      await sleep(500);
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `wa-gateway-baileys aktif di :${PORT} | sesi dimuat: ${sessions.size} | engine dilaporkan: ${REPORT_ENGINE} | ` +
        `bot-node: ${BUTTON_BOT_NODE ? 'ya' : 'tidak'} | wrap: ${BUTTON_WRAP ? 'ya' : 'tidak'} | ` +
        `inbound: ${APP_INBOUND_URL && WA_CRON_SECRET ? 'aktif' : 'nonaktif'} | ` +
        `tunggu-ack: ${ACK_WAIT_MS}ms | tahan-nomor: ${RESTRICT_COOLDOWN_MIN}mnt`,
    );
  });
}

boot().catch((err) => {
  console.error('Gagal memulai gateway:', err);
  process.exit(1);
});
