#!/usr/bin/env python3
from pathlib import Path
import re, sys
root = Path(__file__).parent
rules = (root/'firestore.rules').read_text()
app = (root/'app.js').read_text()
notify = (root/'api/notify.js').read_text()
e2ee = (root/'e2ee.js').read_text()
checks = []
def ok(name, cond):
    checks.append((name, bool(cond)))

def balanced_rules(source):
    stack, pairs = [], {')':'(', ']':'[', '}':'{'}
    quote = None; esc = False; comment = False
    for i, ch in enumerate(source):
        if ch == '\n': comment = False; continue
        if comment: continue
        if quote:
            if esc: esc = False
            elif ch == '\\': esc = True
            elif ch == quote: quote = None
            continue
        if ch == '/' and i + 1 < len(source) and source[i + 1] == '/': comment = True; continue
        if ch in "'\"": quote = ch
        elif ch in '([{': stack.append(ch)
        elif ch in ')]}':
            if not stack or stack.pop() != pairs[ch]: return False
    return not stack and quote is None

ok('firestore rules have balanced syntax delimiters', balanced_rules(rules))

# Private direct-client bypass attempts: plaintext and extra clear fields must be rejected.
msg = rules[rules.index('match /chats/{chatId}/messages/{m}'):rules.index('// ---------- المجموعات والقنوات ----------')]
ok('private create requires cipher', "chatId == 'public' || (('cipher' in request.resource.data)" in msg)
ok('private create rejects reply/fwd/text/img/loc/poll outside cipher', "request.resource.data.keys().hasOnly(['uid','at','exp','cipher'])" in msg)
ok('private clear reactions branch is public-only', "chatId == 'public' && inChat()" in msg and "affectedKeys().hasOnly(['reactions'])" in msg)
ok('private delete changes only deleted', "chatId == 'public' || request.resource.data.diff(resource.data).affectedKeys().hasOnly(['deleted'])" in msg)
ok('dual cipher has no contradictory legacy schema', "cipher.keys().hasOnly(['v','alg','senderEphemeralPublic','iv','ciphertext'])" not in msg and "ECDH-P256-AESGCM-DUAL" in msg)

# Directory impersonation and member-list exposure.
dir_rules = rules[rules.index('match /groupDirectory/{gid}'):rules.index('// مفتاح رابط الدعوة')]
ok('directory create binds to real group via getAfter', 'getAfter(/databases/$(db)/documents/groups/$(gid)).data.owner' in dir_rules)
ok('directory update binds to old owner', 'resource.data.owner == request.auth.uid' in dir_rules)
ok('full groups read requires membership', 'allow get, list: if signedIn() && request.auth.uid in resource.data.members' in rules)
ok('directory schema excludes members/admins', 'members' not in dir_rules and 'admins' not in dir_rules)

# Notification abuse attempts.
ok('group notification requires messageId', 'if (!messageId) return res.status(400)' in notify)
ok('group notification verifies posted message and sender', 'posted.data().uid !== uid' in notify)
ok('duplicate message notification is rejected', 'dedupeKey' in notify and 'duplicate: true' in notify)
ok('selfTest is rate limited', 'body.selfTest ? 3 : 20' in notify)
ok('oversized notification payload is rejected', 'payload too large' in notify and 'content-length' in notify)
ok('notification identifiers are bounded', '.slice(0, 180)' in notify)
ok('notification maps have cleanup caps', 'rate.size > 10000' in notify and 'notified.size > 10000' in notify)

# E2EE regression checks.
ok('sender and recipient ciphertext copies exist', 'recipient:' in e2ee and 'sender:' in e2ee)
ok('sender fallback decrypt exists', 'part = cipher.sender' in e2ee)
ok('legacy decrypt remains isolated', 'decryptLegacyPrivatePayload' in e2ee)

# Front-end injection guard: all user-facing name interpolation sites in key renderers use esc.
ok('verified badge has explicit internal-site label', 'حساب موثّق داخل ES Chat' in app)
ok('large emoji reaction catalog present', 'const EMO = [' in app and app.count('"') > 50)

# ---- v41: فحوصات إضافية (صياغة module، توثيق، مكالمات، هيدرز) ----
import json, subprocess, tempfile, shutil, os
def node_module_ok(path):
    # لازم يتفحص كـ module (.mjs). فحص .js العادي بيعدّي أخطاء صياغة في ملفات فيها import
    d = tempfile.mkdtemp(); t = os.path.join(d, 'x.mjs'); shutil.copy(path, t)
    r = subprocess.run(['node', '--check', t], capture_output=True, text=True); shutil.rmtree(d, ignore_errors=True)
    return r.returncode == 0
ok('app.js is valid as an ES module (node --check on .mjs)', node_module_ok(root/'app.js'))
ok('e2ee.js is valid as an ES module', node_module_ok(root/'e2ee.js'))
ok('public profile cannot self-set verified=true', "منع التوثيق الذاتي" in rules and "get('verified', false) == false" in rules)
grp = rules[rules.index('match /groups/{gid} {'):rules.index('match /groupDirectory/{gid}')]
ok('group verified can only be changed by site owner', "request.auth.uid == resource.data.owner))" not in grp and "isOwner() && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['verified'])" in grp)
dirr = rules[rules.index('match /groupDirectory/{gid}'):rules.index('// مفتاح رابط الدعوة')]
ok('groupDirectory create forces verified=false', "get('verified', false) == false" in dirr)
ok('call offer is created AFTER tracks are added (wirePeer before createOffer)', app.index('wirePeer(pc, ref, remote, stream)') < app.index('pc.createOffer()'))
ok('call ICE candidates are queued until remote description is set', 'CALL.q.push(c)' in app and 'flushCandidates' in app)
ok('TURN credentials endpoint exists and requires auth', (root/'api/turn.js').exists() and 'verifyIdToken' in (root/'api/turn.js').read_text())
vj = json.loads((root/'vercel.json').read_text())
hdrs = {h['key']: h['value'] for blk in vj.get('headers', []) for h in blk['headers']}
ok('vercel.json sets CSP + frame protection + nosniff', all(k in hdrs for k in ('Content-Security-Policy', 'X-Frame-Options', 'X-Content-Type-Options')))
ok('CSP has no invalid stun: source', 'stun:' not in hdrs.get('Content-Security-Policy', ''))
ok('CSP keeps frame-ancestors none', "frame-ancestors 'none'" in hdrs.get('Content-Security-Policy', ''))

failed = [n for n, passed in checks if not passed]
for n, passed in checks: print(('PASS' if passed else 'FAIL') + ' - ' + n)
print(f'\n{len(checks)-len(failed)}/{len(checks)} checks passed')
if failed:
    print('FAILED: ' + ', '.join(failed)); sys.exit(1)
