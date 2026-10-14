// اختبارات v77: حارس SSRF المشترك، تقديم ملفات البوت بأمان، وإصلاح XSS في thumb، وتوريث webhookSecret عند تغيير الرمز.
const Module = require('module'), fs = require('fs'), crypto = require('crypto'); const root = require('path').resolve(__dirname, '..') + '/';
const DB = {}; const clone = o => JSON.parse(JSON.stringify(o));
const applyUpd = (cur, d) => ({ ...cur, ...d });
const docRef = p => ({ path: p, id: p.split('/').pop(),
  async get() { const d = DB[p]; return { exists: d !== undefined, id: p.split('/').pop(), data: () => d === undefined ? undefined : clone(d) }; },
  async set(d, o) { DB[p] = (o && o.merge) ? applyUpd(DB[p] || {}, d) : applyUpd({}, d); },
  async update(d) { if (DB[p] === undefined) throw new Error('NOT_FOUND'); DB[p] = applyUpd(DB[p], d); },
  async delete() { delete DB[p]; } });
const collRef = p => ({
  async get() { const pre = p + '/'; const docs = Object.keys(DB).filter(k => k.startsWith(pre) && !k.slice(pre.length).includes('/')).map(k => ({ id: k.slice(pre.length), data: () => clone(DB[k]) })); return { docs, size: docs.length }; },
  where() { return collRef(p); }
});
const fakeAdmin = { apps: [1], initializeApp() { }, credential: { cert: () => ({}) },
  auth: () => ({ verifyIdToken: async t => { if (!t.startsWith('uid:')) throw new Error('bad'); return { uid: t.slice(4) }; } }),
  firestore: Object.assign(() => ({ doc: docRef, collection: collRef }), { FieldValue: { serverTimestamp: () => ({ __sv: 1 }), arrayUnion: (...a) => ({ __union: a }) } }) };
const orig = Module._load; Module._load = function (req, ...r) { if (req === 'firebase-admin') return fakeAdmin; return orig.call(this, req, ...r); };
const guard = require(root + 'api/_net-guard.js');
const fileHandler = require(root + 'api/es-bot-file.js');
const botHandler = require(root + 'api/bot.js');
let pass = 0, fail = 0; const t = (n, c, x = '') => { (c ? pass++ : fail++); console.log((c ? 'PASS' : 'FAIL') + ' - ' + n + (c ? '' : '  ' + x)); };

(async () => {
  // ---- SSRF: الفحص الثابت ----
  const bad = ['http://example.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.1.2.3/x', 'https://192.168.1.1/x', 'https://172.16.0.1/x',
    'https://169.254.169.254/latest/meta-data/', 'https://100.64.0.1/x', 'https://[::1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://[::ffff:7f00:1]/x',
    'https://[fd00::1]/x', 'https://[fe80::1]/x', 'https://metadata.google.internal/x', 'https://intranet/x', 'https://printer.local/x', 'https://user:pw@example.com/x', 'https://0x7f.1/x', 'https://2130706433/x', 'https://[2002:7f00:1::]/x'];
  for (const u of bad) t('SSRF blocked: ' + u, !guard.validPublicHttpsUrl(u));
  const good = ['https://example.com/hook', 'https://fcbarcelona.com/hook', 'https://fdroid.org/h', 'https://api.my-bot.dev:8443/h', 'https://[2606:4700:4700::1111]/x', 'https://8.8.8.8/x'];
  for (const u of good) t('legit URL allowed: ' + u, guard.validPublicHttpsUrl(u));
  t('DNS guard: private literal IP rejected', (await guard.resolvesToPublicOnly('127.0.0.1')) === false && (await guard.resolvesToPublicOnly('::1')) === false);
  t('DNS guard: public literal IP accepted', (await guard.resolvesToPublicOnly('8.8.8.8')) === true);
  t('DNS guard: unresolvable name rejected (fail closed)', (await guard.resolvesToPublicOnly('definitely-not-real.invalid')) === false);

  // ---- تقديم ملفات البوت ----
  const mk = async (id, type, name, bytes = 'aGVsbG8=') => { const key = 'k'.repeat(40); DB['botFiles/' + id] = { botId: 'b', name, type, bytes: 5, parts: 1, status: 'ready', keyHash: crypto.createHash('sha256').update(key).digest('hex') }; DB['botFiles/' + id + '/parts/p0'] = { index: 0, data: bytes, bytes: 5 }; return { id, key }; };
  const get = async ({ id, key }) => { let out = { headers: {} }; const res = { setHeader(k, v) { if (/[^\x20-\x7e]/.test(String(v))) throw new TypeError('Invalid character in header content'); out.headers[k.toLowerCase()] = v; }, status(c) { out.code = c; return this; }, send(b) { out.body = b; return this; }, end() { return this; }, json() { return this; } }; await fileHandler({ method: 'GET', query: { file_id: id, key } }, res); return out; };
  let f = await get(await mk('a'.repeat(24), 'text/html', 'x.html'));
  t('HTML upload is NOT served inline (stored-XSS closed)', f.code === 200 && f.headers['content-type'] === 'application/octet-stream' && /^attachment/.test(f.headers['content-disposition']), JSON.stringify(f.headers));
  f = await get(await mk('b'.repeat(24), 'image/svg+xml', 'x.svg')); t('SVG is not served inline', /^attachment/.test(f.headers['content-disposition']));
  f = await get(await mk('c'.repeat(24), 'image/png', 'x.png')); t('PNG is still served inline', f.code === 200 && /^inline/.test(f.headers['content-disposition']) && f.headers['content-type'] === 'image/png');
  t('nosniff + sandbox CSP set on file responses', f.headers['x-content-type-options'] === 'nosniff' && /sandbox/.test(f.headers['content-security-policy']));
  f = await get(await mk('d'.repeat(24), 'application/pdf', 'تقرير الشهر.pdf')); t('Arabic file name no longer crashes the header (was a 500)', f.code === 200 && /filename\*=UTF-8''/.test(f.headers['content-disposition']), JSON.stringify(f));
  const noKey = await get({ id: 'a'.repeat(24), key: 'z'.repeat(40) }); t('wrong access key still gets 404', noKey.code === 404);

  // ---- تغيير الرمز لازم يحافظ على webhookSecret ----
  const call = async (body, hdr = {}) => { let out; const res = { status(c) { out = { code: c }; return this; }, json(b) { out.body = b; return this; } }; await botHandler({ method: 'POST', headers: hdr, body }, res); return out; };
  const U = u => ({ authorization: 'Bearer uid:' + u });
  let r = await call({ action: 'create', name: 'Hook Bot' }, U('o1')); const botId = r.body.bot.id;
  r = await call({ action: 'setwebhook', botId, url: 'https://example.com/h' }, U('o1')); const secret = r.body.secret; t('setwebhook returns a secret', !!secret);
  r = await call({ action: 'setwebhook', botId, url: 'https://169.254.169.254/latest' }, U('o1')); t('setwebhook refuses cloud-metadata address', r.code === 400);
  r = await call({ action: 'token', botId }, U('o1')); const newTok = r.body.token;
  const newHash = crypto.createHash('sha256').update(newTok).digest('hex');
  t('token rotation keeps the webhook secret (webhooks keep working)', DB['botSecrets/' + newHash] && DB['botSecrets/' + newHash].webhookSecret === secret, JSON.stringify(DB['botSecrets/' + newHash]));

  // ---- XSS في thumb (فحص ثابت على app.js) ----
  const app = fs.readFileSync(root + 'app.js', 'utf8');
  t('app.js no longer trusts the thumb prefix only', !app.includes('/^data:image\\//.test(md.thumb)'));
  const m = app.match(/md\.thumb\.length < 30000 && (\/\^data:image[^\n]*?\$\/)\.test\(md\.thumb\)/); t('app.js uses a strict base64 thumb pattern', !!m);
  if (m) {
    const re = eval(m[1]);
    t('thumb: normal jpeg data URL accepted', re.test('data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ=='));
    t('thumb: attribute-breakout payload rejected', !re.test('data:image/png;base64,AAAA");" onmouseover="alert(1)'));
    t('thumb: quote / paren / semicolon rejected', !re.test('data:image/png;base64,AA"A') && !re.test('data:image/png;base64,AA)A') && !re.test('data:image/png;base64,AA;A'));
    t('thumb: svg data URL rejected', !re.test('data:image/svg+xml;base64,PHN2Zz4='));
  }
  console.log(`\n${pass} passed, ${fail} failed`); if (fail) process.exitCode = 1;
})();
