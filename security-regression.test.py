#!/usr/bin/env python3
from pathlib import Path
import re, sys
root = Path(__file__).parent
rules = (root/'firestore.rules').read_text()
app = (root/'app.js').read_text()
notify = (root/'api/notify.js').read_text()
bot = (root/'api/bot.js').read_text()
e2ee = (root/'e2ee.js').read_text()
vercel = (root/'vercel.json').read_text()
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

# v23 — هجوم فعلي + إصلاحات 2026-10-09: كراش التشفير على حمولات كبيرة، وعدم وجود rate limit في api/bot.js، ومفيش security headers.
ok('b64 no longer spreads raw bytes into String.fromCharCode (stack-overflow DoS on large ciphertexts)',
   'String.fromCharCode(...new Uint8Array(a))' not in e2ee
   and 'String.fromCharCode(...bytes.subarray(' in e2ee)
ok('bot API create is rate limited per user', 'limited("create:" + u.uid' in bot)
ok('bot API manage actions are rate limited per user', 'limited("manage:" + u.uid' in bot)
ok('bot API token-authenticated actions are rate limited per bot', 'limited("bot:" + bot.id' in bot)
ok('bot API rate map has a cleanup cap (no unbounded memory growth)', 'rate.size > 10000' in bot)
ok('vercel.json sets a restrictive Content-Security-Policy', '"Content-Security-Policy"' in vercel and "frame-ancestors 'none'" in vercel)
ok('vercel.json blocks framing (clickjacking) via X-Frame-Options', '"X-Frame-Options", "value": "DENY"' in vercel)
ok('vercel.json sets Referrer-Policy', '"Referrer-Policy"' in vercel)
ok('vercel.json keeps Google Sign-In popup working (COOP same-origin-allow-popups, not same-origin)', 'same-origin-allow-popups' in vercel)

failed = [n for n, passed in checks if not passed]
for n, passed in checks: print(('PASS' if passed else 'FAIL') + ' - ' + n)
print(f'\n{len(checks)-len(failed)}/{len(checks)} checks passed')
if failed:
    print('FAILED: ' + ', '.join(failed)); sys.exit(1)
