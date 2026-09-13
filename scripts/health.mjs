// KNOX Music local-service health check (no dependencies, stdlib fetch only).
//
// Usage:
//   npm run health                  # sidecar on 127.0.0.1:5000
//   npm run health -- --port 5001   # explicit sidecar port
//   PORT=5001 npm run health
//
// Checks the canonical contract against a running YouTube Music sidecar:
//   GET /health, GET /api/health, GET /api/search?q=alan walker,
//   GET /api/track/<first videoId>
// Exits 0 when every check passes, 1 otherwise. Never throws unstructured
// output — every line is `ok`/`FAIL` + detail for CI logs.

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.findIndex((a) => a === name || a.startsWith(name + '='));
  if (i >= 0) {
    const eq = args[i].indexOf('=');
    if (eq >= 0) return args[i].slice(eq + 1);
    return args[i + 1] ?? fallback;
  }
  return fallback;
}

const port = Number(arg('--port', process.env.PORT || process.env.YOUTUBEMUSIC_PORT || '5000')) || 5000;
const base = `http://127.0.0.1:${port}`;
let failed = 0;

async function get(path, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, { signal: controller.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    return { status: res.status, json, text: text.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const health = await get('/health', 5000);
check('GET /health', health.status === 200 && health.json?.ok === true, `HTTP ${health.status}`);
check(
  'health service name',
  health.json?.service === 'knox-youtube-music',
  String(health.json?.service ?? health.text),
);

const compat = await get('/api/health', 5000);
check('GET /api/health (compat)', compat.status === 200 && compat.json?.ok === true, `HTTP ${compat.status}`);

const corsRes = await (async () => {
  try {
    const res = await fetch(`${base}/api/health`, { headers: { Origin: 'http://localhost:5173' } });
    await res.text();
    return res.headers.get('access-control-allow-origin');
  } catch {
    return null;
  }
})();
check('CORS (loopback browser fetch)', corsRes === '*', String(corsRes));

const search = await get('/api/search?q=alan%20walker', 20000);
const results = Array.isArray(search.json?.results) ? search.json.results : null;
check('GET /api/search?q=alan walker', search.status === 200 && !!results && results.length > 0, `HTTP ${search.status}, ${results?.length ?? 0} results`);
const first = results?.[0];
check(
  'search result shape',
  !!first && typeof first.title === 'string' && first.title.trim().length > 0
    && typeof first.artist === 'string' && /^youtube-music:[A-Za-z0-9_-]{6,32}$/.test(first.id || ''),
  first ? `${first.id} — ${first.title} / ${first.artist}` : 'no results',
);

if (first?.videoId) {
  const track = await get(`/api/track/${encodeURIComponent(first.videoId)}`, 20000);
  const t = track.json?.track;
  check(
    `GET /api/track/${first.videoId}`,
    track.status === 200 && !!t && (t.duration ?? 0) > 0,
    t ? `duration=${t.duration}s title=${t.title}` : `HTTP ${track.status}`,
  );
} else {
  check('GET /api/track/<videoId>', false, 'no videoId from search');
}

const bad = await get('/api/search', 5000);
check('empty query → 400 INVALID_QUERY', bad.status === 400 && bad.json?.error?.code === 'INVALID_QUERY', `HTTP ${bad.status}`);

if (failed > 0) {
  console.log(`\n${failed} check(s) failed — is the sidecar running? (python3 services/youtubemusic/app.py --port ${port})`);
  process.exit(1);
}
console.log('\nall health checks passed');
