const admin = require('firebase-admin');
function init() {
  if (admin.apps.length) return;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('Firebase service account is not configured');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const send = (res, status, body) => res.status(status).json(body);
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  if (Number(req.headers['content-length'] || 0) > 2048) return send(res, 413, { error: 'payload_too_large' });
  const match = /^Bearer\s+(.+)$/.exec(req.headers.authorization || '');
  if (!match) return send(res, 401, { error: 'auth_required' });
  let username;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    username = String(body.username || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return send(res, 400, { error: 'invalid_username' });
    init();
    const decoded = await admin.auth().verifyIdToken(match[1]);
    const uid = decoded.uid;
    const db = admin.firestore();
    const outcome = await db.runTransaction(async tx => {
      const userRef = db.doc(`users/${uid}`);
      const nextRef = db.doc(`usernames/${username}`);
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new Error('user_missing');
      const oldUsername = String(userSnap.get('username') || '').toLowerCase();
      if (oldUsername === username) return { unchanged: true };
      const nextSnap = await tx.get(nextRef);
      if (nextSnap.exists && nextSnap.get('uid') !== uid) throw new Error('username_taken');
      const oldRef = oldUsername ? db.doc(`usernames/${oldUsername}`) : null;
      const oldSnap = oldRef ? await tx.get(oldRef) : null;
      const publicRef = db.doc(`users/${uid}/public/profile`);
      tx.set(nextRef, { uid });
      if (oldSnap && oldSnap.exists && oldSnap.get('uid') === uid) tx.delete(oldRef);
      tx.update(userRef, { username });
      tx.set(publicRef, { uid, username }, { merge: true });
      return { unchanged: false };
    });
    return send(res, 200, { ok: true, username, unchanged: !!outcome.unchanged });
  } catch (e) {
    if (e && e.message === 'username_taken') return send(res, 409, { error: 'username_taken' });
    if (e && e.message === 'user_missing') return send(res, 404, { error: 'user_not_found' });
    if (e && (e.code === 'auth/id-token-expired' || e.code === 'auth/argument-error' || e.code === 'auth/invalid-id-token')) return send(res, 401, { error: 'invalid_auth' });
    console.error('username-change failure', e && e.message ? e.message : 'unknown');
    return send(res, 500, { error: 'server_error' });
  }
};
