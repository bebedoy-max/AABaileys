# wa-gateway-baileys

Gateway WhatsApp berbasis **Baileys** yang meniru sebagian API **WAHA**, supaya aplikasi blast kamu
bisa memakainya lewat menu **Pengaturan Sistem > WA Gateway** (URL + API key) tanpa mengubah kode aplikasi.

Keunggulan utamanya: bisa mengirim **pesan bertombol native** (tombol link, balas, telepon, salin kode)
yang tidak bisa dikirim WAHA engine GOWS.

> **Status:** sudah terpakai untuk pengiriman tombol nyata. Logika pemantauan hasil pengiriman dan
> penahanan nomor (lihat bagian "Arti Berhasil dan perlindungan nomor") diuji secara lokal, belum
> dibuktikan terhadap penolakan asli dari WhatsApp. Cek log setelah pengiriman pertama.

## Ringkasan strategi

- WAHA lama di `wg.aawb.web.id` **tidak diubah dan tidak dihapus**. Gateway ini dipasang sebagai
  aplikasi BARU di Coolify dengan subdomain baru (contoh `wb.aawb.web.id`).
- Pindah gateway = mengganti URL + API key di menu pengaturan aplikasi. Kembali ke WAHA = mengembalikan
  URL + API key lama (sesi di WAHA tetap utuh).
- Setiap perangkat harus dipasangkan ulang (scan QR / kode) di gateway baru, karena sesi WhatsApp
  tersimpan di server gateway, bukan di database aplikasi.
- Satu nomor WhatsApp maksimal 4 perangkat tertaut. Nomor yang masih tertaut ke WAHA memakai 1 slot,
  ditambah 1 slot untuk gateway baru.

## Yang dibutuhkan

1. Akun GitHub (repo pribadi tidak masalah) untuk menyimpan kode ini.
2. Subdomain baru yang diarahkan ke IP VPS (A record), misalnya `wb.aawb.web.id`.
3. Akses ke Coolify di VPS.

## Deploy di Coolify

Nama menu di Coolify bisa sedikit berbeda antar versi.

1. Buat repo GitHub baru, lalu unggah SELURUH isi folder ini (`Dockerfile`, `package.json`, folder `src`, dst.).
2. Di Coolify: **Project > Environment > + New Resource > Private/Public Repository** (sesuai repo kamu),
   pilih repo tersebut.
3. **Build Pack: Dockerfile**. **Port yang diekspos: 3000**.
4. **Domains**: isi `https://wb.aawb.web.id` (subdomain barumu). Coolify akan mengurus HTTPS.
5. **Environment Variables**: isi seperti tabel di bawah. `API_KEY` wajib.
6. **Persistent Storage**: tambahkan volume dengan **Destination Path `/data`**.
   Ini WAJIB. Tanpa volume, semua sesi WhatsApp hilang setiap kali di-redeploy dan harus pair ulang.
7. Klik **Deploy**.

### Environment variables

| Nama | Wajib | Keterangan |
|---|---|---|
| `API_KEY` | ya | Kunci rahasia (panjang dan acak). Diisi juga di aplikasi. |
| `DATA_DIR` | tidak | Default `/data` di Docker. Harus sama dengan path volume. |
| `REPORT_ENGINE` | tidak | Biarkan `NOWEB`. Aplikasi hanya mengirim gambar + tombol sekaligus bila engine dilaporkan NOWEB. |
| `BUTTON_BOT_NODE` | tidak | `1` (default) = konfigurasi yang terbukti tampil di uji kamu, tapi ada label "AI". Set `0` jika uji `NOBOT=1` membuktikan tombol tetap tampil. |
| `BUTTON_WRAP` | tidak | `1` = bungkus pesan dengan `viewOnceMessage`. Hanya bila tombol tidak tampil. |
| `APP_INBOUND_URL` | tidak | `https://DOMAIN-APLIKASI/api/public/wa/inbound`, untuk meneruskan balasan STOP/BERHENTI (fitur Anti Ban). |
| `WA_CRON_SECRET` | tidak | Samakan dengan `WA_CRON_SECRET` di aplikasi. Wajib bila `APP_INBOUND_URL` diisi. |
| `LOG_LEVEL` | tidak | `warn` (default). Pakai `info` atau `debug` saat mencari masalah. |
| `ACK_WAIT_MS` | tidak | Berapa lama gateway menunggu kabar server WhatsApp setelah mengirim. Default `3000`. |
| `RESTRICT_COOLDOWN_MIN` | tidak | Lama nomor ditahan setelah ditolak WhatsApp. Default `60` menit, menggandakan tiap kejadian beruntun (maks 24 jam). |
| `ERROR_STREAK_TRIP` | tidak | Jumlah penolakan beruntun (selain kode 463) sebelum nomor ditahan. Default `3`. |
| `ALLOW_PRIVATE_MEDIA_HOSTS` | tidak | Daftar host internal (dipisah koma) yang boleh diambil filenya. Default kosong: URL file ke localhost/10.x/192.168.x/169.254.x ditolak (perlindungan SSRF). |
| `MEDIA_MAX_MB` | tidak | Ukuran maksimal file media (MB). Default `25`. |

## Cek server sudah hidup

```bash
curl https://wb.aawb.web.id/health
# {"ok":true,"sessions":0}

curl -H "X-Api-Key: KUNCI_KAMU" https://wb.aawb.web.id/api/sessions
# []
```

## Pindah gateway (bertahap)

1. Di aplikasi: **Pengaturan Sistem > WA Gateway**. Isi URL gateway baru dan API key baru, klik **Simpan**,
   lalu **Uji koneksi**. Harus berhasil.
   Catatan: pengaturan ini berlaku untuk SEMUA pengguna sekaligus. Lakukan di waktu sepi, atau pakai salinan aplikasi untuk uji.
2. Buka halaman **Perangkat**, pasangkan SATU perangkat uji (QR atau kode). Tunggu sampai berstatus tersambung.
3. Buat kampanye kecil dengan tombol CTA, kirim ke satu nomor uji. Cek di HP: tombol tampil?
4. Coba juga kampanye dengan gambar + tombol.
5. Kalau semuanya baik, pasangkan perangkat lainnya.

### Kembali ke WAHA (rollback)

Kembalikan URL `https://wg.aawb.web.id` dan API key WAHA lama di menu pengaturan, lalu simpan.
Sesi di WAHA tidak tersentuh, jadi perangkat lama langsung tersambung lagi.

## API yang didukung

`GET /health`, `GET/POST /api/sessions`, `GET/DELETE /api/sessions/:name`,
`POST /api/sessions/:name/start|stop|logout`, `GET /api/:name/auth/qr`, `POST /api/:name/auth/request-code`,
`POST /api/sendText|sendImage|sendVideo|sendVoice|sendFile|sendButtons`,
`GET /api/:name/profile`, `PUT /api/:name/profile/name|picture`.

Tipe tombol pada `/api/sendButtons`: `url`, `reply`, `call`, `copy` (maksimal 3 tombol per pesan).

## Arti "Berhasil" dan perlindungan nomor

Setelah mengirim, gateway menunggu kabar dari server WhatsApp (maksimal `ACK_WAIT_MS`):

- **Ditolak server** (mis. nomor dibatasi): dibalas error, jadi di aplikasi tercatat gagal dan tidak
  dihitung sebagai terkirim. Keterangannya berisi kode penolakan.
- **Ada tanda diterima penerima**: langsung dibalas sukses.
- **Tidak ada kabar apa pun**: dianggap sukses (penerima bisa saja sedang offline). Jadi "Berhasil"
  berarti "tidak ditolak WhatsApp", belum jaminan pesan sudah dibaca.

**Penahanan nomor.** Kode penolakan `463` (pembatasan pengiriman) atau `ERROR_STREAK_TRIP` penolakan
beruntun membuat nomor itu ditahan selama `RESTRICT_COOLDOWN_MIN` menit (menggandakan tiap kali, maks 24 jam;
koneksi yang ditolak WhatsApp dengan kode 403 ditahan 24 jam). Selama ditahan:

- perangkat dilaporkan terputus ke aplikasi, sehingga aplikasi berhenti membagikan pesan ke nomor itu;
- alasan dan jam berakhirnya tampil sebagai keterangan error di aplikasi;
- status ini tersimpan di `/data`, jadi tetap berlaku setelah redeploy.

Hapus penahanan manual (hanya jika WhatsApp sudah mencabut pembatasan):

```bash
curl -X POST -H "X-Api-Key: KUNCI_KAMU" https://wb.aawb.web.id/api/sessions/ID_SESI/clear-restriction
```

## Batasan yang perlu diketahui

- **Belum diuji live.** Uji bertahap seperti di atas.
- **Passkey (WebAuthn)** tidak didukung (khusus WAHA GOWS). Pairing lewat QR dan kode tetap berfungsi.
- **Voice note** harus sudah berformat OGG/OPUS. Tidak ada konversi otomatis.
- **Video note** (`asNote`), grup, dan fitur lain WAHA yang tidak disebut di atas tidak tersedia.
- **Balasan masuk dari akun berbasis LID** hanya diteruskan bila WhatsApp menyertakan nomor teleponnya.
- **List dan kombinasi 3 tombol campuran** tampil di HP, tetapi WhatsApp Web/Desktop menampilkan
  "This message couldn't load". Untuk CTA kampanye, satu tombol link paling aman.
- **Risiko akun.** Pesan interaktif lewat Baileys ke akun WhatsApp biasa adalah cara tidak resmi.
  WhatsApp dapat membatasi atau memblokir nomor, terutama untuk blast massal. Mulai dari nomor cadangan
  dan volume kecil.
- Data sesi WhatsApp (`/data`) sangat sensitif. Jangan dibagikan dan jangan di-commit ke Git.

## Menjalankan lokal (opsional)

```bash
npm install
API_KEY=rahasia DATA_DIR=./data npm start
```
