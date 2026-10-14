const Module = require('module'); const path = require('path').resolve(__dirname, '..') + '/';
const DB = {}; const SV = { __sv: 1 };
const clone = o => JSON.parse(JSON.stringify(o));
const applyUpd = (cur, d) => { const n = { ...cur }; for (const [k, v] of Object.entries(d)) { if (v && v.__union) n[k] = [...new Set([...(n[k] || []), ...v.__union])]; else n[k] = v; } return n; };
const docRef = p => ({
  path: p, id: p.split('/').pop(),
  async get() { const d = DB[p]; return { exists: d !== undefined, id: p.split('/').pop(), data: () => d === undefined ? undefined : clone(d) }; },
  async set(d, o) { DB[p] = (o && o.merge) ? applyUpd(DB[p] || {}, d) : applyUpd({}, d); },
  async update(d) { if (DB[p] === undefined) throw new Error('NOT_FOUND'); DB[p] = applyUpd(DB[p], d); },
  async delete() { delete DB[p]; }
});
function collRef(p) {
  return {
    where(f, op, v, conds = []) {
      const all = [...conds, [f, v]];
      return {
        where: (f2, op2, v2) => collRef(p).where(f2, op2, v2, all),
        async get() { const pre = p + '/'; const docs = Object.keys(DB).filter(k => k.startsWith(pre) && !k.slice(pre.length).includes('/') && all.every(([ff, vv]) => DB[k][ff] === vv)).map(k => ({ id: k.slice(pre.length), data: () => clone(DB[k]) })); return { docs, size: docs.length }; }
      };
    },
    async get() { const pre = p + '/'; const docs = Object.keys(DB).filter(k => k.startsWith(pre) && !k.slice(pre.length).includes('/')).map(k => ({ id: k.slice(pre.length), data: () => clone(DB[k]) })); return { docs, size: docs.length }; },
    async add(d) { const id = 'm' + Object.keys(DB).length; DB[p + '/' + id] = applyUpd({}, d); return { id }; }
  };
}
let txCounter = 0;
const fakeAdmin = {
  apps: [1], initializeApp() { }, credential: { cert: () => ({}) },
  auth: () => ({ verifyIdToken: async t => { if (!t.startsWith('uid:')) throw new Error('bad'); return { uid: t.slice(4) }; } }),
  firestore: Object.assign(() => ({
    doc: docRef, collection: collRef,
    async runTransaction(fn) {
      // محاكاة أقرب للحقيقي: الكتابات بتتأجّل لحد نجاح الدالة، ولو اترمى خطأ جوّاها كل الكتابات بتتلغي (rollback)
      const writes = [];
      const tx = {
        async get(ref) { return ref.get(); },
        set(ref, d, o) { writes.push(() => { DB[ref.path] = (o && o.merge) ? applyUpd(DB[ref.path] || {}, d) : applyUpd({}, d); }); },
        update(ref, d) { writes.push(() => { if (DB[ref.path] === undefined) throw new Error('NOT_FOUND'); DB[ref.path] = applyUpd(DB[ref.path], d); }); }
      };
      const out = await fn(tx); writes.forEach(w => w()); return out;
    }
  }), { FieldValue: { serverTimestamp: () => SV, arrayUnion: (...a) => ({ __union: a }) } })
};
const orig = Module._load;
Module._load = function (req, ...r) { if (req === 'firebase-admin') return fakeAdmin; return orig.call(this, req, ...r); };
const linkHandler = require(path + 'api/link-device.js');
const botHandler = require(path + 'api/bot.js');
const callLink = async (body, hdr = {}) => { let out; const res = { status(c) { out = { code: c }; return this; }, json(b) { out.body = b; return this; } }; await linkHandler({ method: 'POST', headers: hdr, body }, res); return out; };
const callBot = async (body, hdr = {}) => { let out; const res = { status(c) { out = { code: c }; return this; }, json(b) { out.body = b; return this; } }; await botHandler({ method: 'POST', headers: hdr, body }, res); return out; };
const U = u => ({ authorization: 'Bearer uid:' + u });
let pass = 0, fail = 0; const t = (n, c, x = '') => { (c ? pass++ : fail++); console.log((c ? 'PASS' : 'FAIL') + ' - ' + n + (c ? '' : '  ' + x)); };

(async () => {
  // جهّز بوت حقيقي عن طريق api/bot.js
  let r = await callBot({ action: 'create', name: 'Support Bot' }, U('botOwner')); const botTok = r.body.token, botId = r.body.bot.id;

  r = await callLink({ action: 'create' }); t('create requires owner auth', r.code === 401);
  r = await callLink({ action: 'create' }, U('alice')); t('create ok', r.code === 201 && /^[A-Z0-9]{8}$/.test(r.body.code));
  const reqId = r.body.requestId, code = r.body.code;
  t('qrPayload matches code', r.body.qrPayload === `esclink:${reqId}.${code}`);

  r = await callLink({ action: 'confirm', requestId: reqId, code: 'WRONGCOD' }, { 'x-es-bot-token': botTok }); t('wrong code rejected', r.code === 400 && r.body.error === 'bad_code');
  r = await callLink({ action: 'confirm', requestId: reqId, code }, {}); t('confirm requires bot token', r.code === 401);
  r = await callLink({ action: 'confirm', requestId: reqId, code }, { 'x-es-bot-token': botTok }); t('confirm ok', r.code === 200 && r.body.deviceId);
  const deviceId = r.body.deviceId;

  r = await callLink({ action: 'confirm', requestId: reqId, code }, { 'x-es-bot-token': botTok }); t('code cannot be reused', r.code === 400 && r.body.error === 'already_used');

  r = await callLink({ action: 'status', requestId: reqId }, U('alice')); t('status reflects confirmed device', r.body.status === 'confirmed' && r.body.device.botId === botId);
  r = await callLink({ action: 'status', requestId: reqId }, U('mallory')); t("other user can't poll someone else's request", r.code === 404);

  t('linkedDevices doc created', DB[`users/alice/linkedDevices/${deviceId}`] && DB[`users/alice/linkedDevices/${deviceId}`].status === 'active');
  t('bot linkedAccounts back-reference created', !!DB[`bots/${botId}/linkedAccounts/alice`]);

  // تجربة تأثير الربط فعليًا على addToGroup في bot.js
  DB['groups/g1'] = { owner: 'alice', admins: [], members: [] };
  r = await callBot({ action: 'addToGroup', groupId: 'g1', admin: true }, { 'x-es-bot-token': botTok });
  t('linked bot can add itself to a group owned by the linking account', r.code === 200, JSON.stringify(r));

  DB['groups/g2'] = { owner: 'mallory', admins: [], members: [] };
  r = await callBot({ action: 'addToGroup', groupId: 'g2', admin: true }, { 'x-es-bot-token': botTok });
  t('bot cannot add itself to a group whose owner never linked it', r.code === 403);

  r = await callLink({ action: 'revoke', deviceId }, U('alice'));
  t('revoke ok', r.code === 200);
  t('linkedDevices doc marked revoked', DB[`users/alice/linkedDevices/${deviceId}`].status === 'revoked');
  t('bot linkedAccounts back-reference removed', DB[`bots/${botId}/linkedAccounts/alice`] === undefined);

  r = await callBot({ action: 'addToGroup', groupId: 'g1', admin: true }, { 'x-es-bot-token': botTok });
  t('revoked bot loses group authority', r.code === 403);

  // استنزاف محاولات الكود الخاطئ
  r = await callLink({ action: 'create' }, U('bob')); const bobReq = r.body.requestId;
  for (let i = 0; i < 8; i++) await callLink({ action: 'confirm', requestId: bobReq, code: 'XXXXXXXX' }, { 'x-es-bot-token': botTok });
  r = await callLink({ action: 'confirm', requestId: bobReq, code: 'XXXXXXXX' }, { 'x-es-bot-token': botTok });
  t('confirm attempts are rate-limited', r.code === 400 && r.body.error === 'too_many_attempts');

  // حد عدد الطلبات المعلّقة لكل مستخدم
  let created = 0;
  for (let i = 0; i < 8; i++) { const x = await callLink({ action: 'create' }, U('carol')); if (x.code === 201) created++; }
  t('pending link-request cap exists (<=5)', created <= 5, 'created ' + created);

  // ---------- اختبارات v77 ----------
  // (1) عدّاد المحاولات الغلط لازم يتحفظ فعلًا (المحاكاة بقت بترجع للخلف عند الـ throw زي Firestore)
  r = await callLink({ action: 'create' }, U('dave')); const daveReq = r.body.requestId;
  await callLink({ action: 'confirm', requestId: daveReq, code: 'XXXXXXXX' }, { 'x-es-bot-token': botTok });
  t('wrong-code attempt counter is really persisted', (DB[`linkRequests/${daveReq}`] || {}).attempts === 1, JSON.stringify(DB[`linkRequests/${daveReq}`]));

  // (2) توكن Firebase غلط = 401 مش 500
  r = await callLink({ action: 'create' }, { authorization: 'Bearer not-a-real-token' }); t('invalid Firebase token gives 401 (not 500)', r.code === 401, r.code);
  r = await callBot({ action: 'disable', botId }, { authorization: 'Bearer garbage' }); t('bot.js: invalid Firebase token gives 401', r.code === 401, r.code);

  // (3) المشرف العادي ما يقدرش يرقّي بوت لمشرف (تخطّي قاعدة "المالك بس يعيّن مشرفين")
  r = await callLink({ action: 'create' }, U('adm')); const aReq = r.body.requestId, aCode = r.body.code;
  await callLink({ action: 'confirm', requestId: aReq, code: aCode }, { 'x-es-bot-token': botTok });
  DB['groups/g3'] = { owner: 'someoneElse', admins: ['adm'], members: ['someoneElse', 'adm'], kind: 'group' };
  r = await callBot({ action: 'addToGroup', groupId: 'g3', admin: true }, { 'x-es-bot-token': botTok });
  t('plain admin CANNOT make a linked bot an admin', r.code === 403, JSON.stringify(r));
  r = await callBot({ action: 'addToGroup', groupId: 'g3' }, { 'x-es-bot-token': botTok });
  t('plain admin can still add a linked bot as a normal member', r.code === 200, JSON.stringify(r));
  t('bot was NOT added to admins', !(DB['groups/g3'].admins || []).some(x => String(x).startsWith('bot_')));

  // (4) البوت الممنوع / الجروب الممتلئ / حد مشرفين القناة
  const botUid = (DB[`bots/${botId}`] || {}).botUid;
  DB['groups/g4'] = { owner: 'adm', admins: [], members: ['adm'], banned: [botUid], kind: 'group' };
  r = await callBot({ action: 'addToGroup', groupId: 'g4' }, { 'x-es-bot-token': botTok }); t('banned bot cannot rejoin through the API', r.code === 403, JSON.stringify(r));
  DB['groups/g5'] = { owner: 'adm', admins: [], members: Array.from({ length: 256 }, (_, i) => 'u' + i), kind: 'group' };
  r = await callBot({ action: 'addToGroup', groupId: 'g5' }, { 'x-es-bot-token': botTok }); t('full group (256) is respected', r.code === 403, JSON.stringify(r));
  DB['groups/g6'] = { owner: 'adm', admins: Array.from({ length: 15 }, (_, i) => 'a' + i), members: ['adm'], kind: 'channel' };
  r = await callBot({ action: 'addToGroup', groupId: 'g6', admin: true }, { 'x-es-bot-token': botTok }); t('channel admin cap (15) is respected', r.code === 403, JSON.stringify(r));

  // (5) إعادة ربط نفس البوت: الجهاز القديم يتلغي، وإلغاءه ما يكسرش الربط الجديد
  r = await callLink({ action: 'create' }, U('erin')); const e1 = r.body;
  r = await callLink({ action: 'confirm', requestId: e1.requestId, code: e1.code }, { 'x-es-bot-token': botTok }); const dev1 = r.body.deviceId;
  r = await callLink({ action: 'create' }, U('erin')); const e2 = r.body;
  r = await callLink({ action: 'confirm', requestId: e2.requestId, code: e2.code }, { 'x-es-bot-token': botTok }); const dev2 = r.body.deviceId;
  t('re-link revokes the older device card', DB[`users/erin/linkedDevices/${dev1}`].status === 'revoked' && DB[`users/erin/linkedDevices/${dev2}`].status === 'active');
  await callLink({ action: 'revoke', deviceId: dev1 }, U('erin'));
  t('revoking the stale device does not break the newer link', !!DB[`bots/${botId}/linkedAccounts/erin`] && DB[`bots/${botId}/linkedAccounts/erin`].deviceId === dev2);
  r = await callLink({ action: 'revoke', deviceId: dev1 }, U('erin')); t('revoking twice is harmless (idempotent)', r.code === 200);

  // (6) حذف البوت بيمسح أثره من الأجهزة المرتبطة
  r = await callBot({ action: 'deletebot', botId }, U('botOwner')); t('deletebot ok', r.code === 200, JSON.stringify(r));
  t('deleted bot no longer appears as an active linked device', DB[`users/erin/linkedDevices/${dev2}`].status === 'revoked' && DB[`bots/${botId}/linkedAccounts/erin`] === undefined);

  // (7) حد الطلبات المعلّقة بيتحسب على المعلّق بس (مش على تاريخ المستخدم كله)
  for (let i = 0; i < 5; i++) await callLink({ action: 'create' }, U('frank'));
  Object.keys(DB).filter(k => k.startsWith('linkRequests/') && DB[k].owner === 'frank').forEach(k => { DB[k].status = 'confirmed'; });
  r = await callLink({ action: 'create' }, U('frank')); t('old confirmed requests do not count against the pending cap', r.code === 201, r.code);

  console.log(`\n${pass} passed, ${fail} failed`); if (fail) process.exitCode = 1;
})();
