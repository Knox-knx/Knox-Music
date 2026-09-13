// KNOX Music AppImage GStreamer packaging gate (no dependencies).
//
// Usage:
//   node scripts/check-appimage-gst.mjs [path-to.AppImage]
//
// Background (production black-screen-on-playback, root-caused live):
// the AppImage bundles GStreamer's CORE libraries (WebKitGTK deps) but NO
// plugin directory. GStreamer 1.28 then searches a nonexistent AppDir path,
// finds ZERO plugins, and WebKit's `autoaudiosink` factory returns NULL at
// playback start → WebKitWebProcess SIGSEGV → permanent blank WebView.
// The Rust host now repairs this at startup (see src-tauri/src/gst_env.rs:
// ghost plugin path → host plugin dir), and THIS script proves every
// shipped AppImage is either (a) a consistent stack or (b) covered by that
// repair. Exits 0 when safe, 1 otherwise. Every line is ok/FAIL for CI logs.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARKER = 'knox-gst-plugin-path-repair-v1';
let failed = 0;
function ok(msg) { console.log(`ok ${msg}`); }
function fail(msg) { console.log(`FAIL ${msg}`); failed += 1; }

const argImage = process.argv[2];
const candidates = [
  argImage,
  'src-tauri/target/release/bundle/appimage/KNOX Music_1.0.0_amd64.AppImage',
].filter(Boolean);
const image = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!image) {
  fail(`no AppImage found (tried: ${candidates.join(', ')})`);
  process.exit(1);
}
ok(`AppImage under test: ${image}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knox-appimage-gst-'));
try {
  // List payload without a full extract: AppImage v2 embeds squashfs at an
  // offset (ELF runtime first). Ask the runtime for it (no FUSE needed),
  // fall back to scanning for the squashfs magic.
  let offset = null;
  try {
    const out = execFileSync(image, ['--appimage-offset'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const n = Number((out.match(/\d+/) || [])[0]);
    if (Number.isInteger(n) && n > 0) offset = n;
  } catch { /* fall through to magic scan */ }
  if (offset === null) {
    const fd = fs.openSync(image, 'r');
    const stat = fs.fstatSync(fd);
    const probeLen = Math.min(stat.size, 8 * 1024 * 1024);
    const buf = Buffer.alloc(probeLen);
    fs.readSync(fd, buf, 0, probeLen, 0);
    fs.closeSync(fd);
    const idx = buf.indexOf(Buffer.from('hsqs', 'ascii'));
    if (idx >= 0) offset = idx;
  }
  if (offset === null) {
    fail('could not locate squashfs payload in AppImage');
    process.exit(1);
  }
  ok(`squashfs payload at offset ${offset}`);
  let listing;
  try {
    listing = execFileSync('unsquashfs', ['-o', String(offset), '-l', image], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    fail(`unsquashfs -l failed: ${e.message.split('\n')[0]}`);
    process.exit(1);
  }
  const files = new Set(listing.split('\n').map((l) => l.trim()).filter(Boolean));

  const bundledGstCore = [...files].filter((f) => /(^|\/)usr\/lib\/libgst[a-z]+\-1\.0\.so/.test(f));
  const bundledPlugins = [...files].filter((f) => /gstreamer-1\.0\/[^/]+\.so(\.|$)/.test(f));
  // dist-info/doc dirs (libgstreamer1.0-0 docs) are not plugins — the regex
  // above only matches .so objects directly inside a gstreamer-1.0 dir.
  ok(`bundled GStreamer core libs: ${bundledGstCore.length}`);
  ok(`bundled GStreamer plugins: ${bundledPlugins.length}`);

  // Extract ONLY the host binary to check for the runtime repair marker.
  const binRel = [...files].find((f) => f === 'squashfs-root/usr/bin/knox-music' || /(^|\/)usr\/bin\/knox-music$/.test(f));
  if (!binRel) {
    fail('knox-music binary not found in AppImage listing');
  } else {
    const member = binRel.replace(/^squashfs-root\//, '');
    execFileSync('unsquashfs', ['-o', String(offset), '-f', '-d', tmp, image, member], { stdio: 'pipe' });
    const binPath = path.join(tmp, member);
    const bytes = fs.readFileSync(binPath);
    const needle = Buffer.from(MARKER, 'utf8');
    if (bytes.includes(needle)) ok(`runtime plugin-path repair present (${MARKER})`);
    else fail(`runtime plugin-path repair MISSING (${MARKER} not in knox-music)`);
  }

  const partialGst = bundledGstCore.length > 0 && bundledPlugins.length === 0;
  if (partialGst) {
    const bytes = (() => {
      try {
        const member = [...files].find((f) => /(^|\/)usr\/bin\/knox-music$/.test(f)).replace(/^squashfs-root\//, '');
        return fs.readFileSync(path.join(tmp, member));
      } catch { return Buffer.alloc(0); }
    })();
    if (bytes.includes(Buffer.from(MARKER, 'utf8'))) {
      ok('partial GStreamer bundle is covered by the runtime repair (host plugins will be used)');
    } else {
      fail('PARTIAL GStreamer bundle (core libs, zero plugins) with NO runtime repair — playback WILL crash the WebKitWebProcess (blank WebView)');
    }
  } else if (bundledPlugins.length > 0) {
    ok('complete GStreamer runtime bundled (core + plugins)');
  } else {
    ok('no bundled GStreamer — pure host stack (consistent by construction)');
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failed > 0) {
  console.log(`RESULT FAIL (${failed} check${failed === 1 ? '' : 's'} failed)`);
  process.exit(1);
}
console.log('RESULT ok (AppImage GStreamer packaging is playback-safe)');
