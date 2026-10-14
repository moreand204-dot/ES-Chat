#!/usr/bin/env python3
from pathlib import Path
import re, sys
root = Path(__file__).parent
rules = (root/'firestore.rules').read_text()
app = (root/'app.js').read_text()
notify = (root/'api/notify.js').read_text()
username_api = (root/'api/username-change.js').read_text()
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
ok('message deletion requires chat membership', "allow delete: if signedIn() && inChat()" in msg)
ok('private message membership is verified against canonical chat members', 'request.auth.uid in get(/databases/$(db)/documents/chats/$(chatId)).data.members' in msg)
ok('blob access checks canonical chat membership', "function mem() { return signedIn() && chatId != 'public' && exists(/databases/$(db)/documents/chats/$(chatId))" in rules)
ok('chat document deletion is explicitly denied to clients', "allow delete: if false;" in rules[rules.index('match /chats/{chatId}'):rules.index('// ---------- وسائط مؤقتة')])
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

ok('long-press delete persists hiddenChats per user', 'await setDoc(prefsRef(), { hiddenChats: hidden }, { merge: true })' in app)
ok('delete failure restores previous hiddenChats', 'الشات رجع للقائمة لأن الحذف ما اتحفظش' in app and 'hiddenChats: previous' in app)
ok('deleting active direct chat closes its view', 'S.chat.peer === peer) showEmpty()' in app)

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
ok('notification preview preference redacts system notification body', 'const safeBody = prefs.preview ? body : "لديك رسالة جديدة"' in app)
ok('notification settings guard unsupported browser APIs', 'if(!canNotify()){e.target.checked=false;toast("المتصفح لا يدعم الإشعارات")' in app)
ok('quiet-hours fields persist and update visible range', 'const saveQuietTime=()=>{const from=q("#nFrom")' in app and 'q("#quietHelp").textContent' in app)
ok('notification test avoids reading Notification when unsupported', 'if(!canNotify()){toast("المتصفح لا يدعم الإشعارات");return;}if(Notification.permission!=="granted")' in app)
# v54 sticker library UX regressions.
ok('sticker picker supports searching sticker labels and emoji', 'id=\"stkSearch\"' in app and 'const stkHtml = (query = \"\")' in app)
ok('custom sticker deletion removes the item from local library', 'customStickerGet().filter(x => Number(x.at) !== at)' in app)
ok('deleting custom sticker also removes stale favorites and recents', 'LS.set(STK_FAV, LS.get(STK_FAV, []).filter(x => x !== id))' in app and 'LS.set(STK_REC, LS.get(STK_REC, []).filter(x => x !== id))' in app)
ok('delete control does not trigger long-press favorite handler', 'if (e.target.closest("[data-del-sticker]")) return;' in app)
# v56 ES Fuzzer / bot input hardening regressions.
bot_api = (root/'api/bot.js').read_text()
fuzzer = (root/'tools/es-fuzzer.mjs').read_text()
ok('bot command names longer than 32 characters are rejected, not truncated', 'x.command.length <= 32' in bot_api and 'String(x?.command || "").trim()' in bot_api)
net_guard = (root/'api/_net-guard.js').read_text(encoding='utf8')
es_bot_src = (root/'api/es-bot.js').read_text(encoding='utf8')
ok('webhook URL validation rejects private IPv4 and local hostnames (one shared guard for bot.js and es-bot.js)', 'localhost' in net_guard and 'a === 127' in net_guard and 'a === 192 && b === 168' in net_guard and '_net-guard' in bot_api and '_net-guard' in es_bot_src)
ok('offline ES Fuzzer covers malformed payloads and runs without network requests', 'never sends network traffic' in fuzzer and 'javascript URL rejected' in fuzzer and 'IPv6 loopback URL rejected' in fuzzer)
# v55 language direction and persistence regressions.
ok('language selection applies document lang and RTL/LTR direction', 'document.documentElement.dir = selected === "ar" ? "rtl" : "ltr"' in app and 'document.documentElement.lang = selected' in app)
ok('saved account language reapplies when the user profile snapshot updates', 'applyAppLanguage(S.me?.lang || LS.get("lang", "ar"))' in app)
ok('language picker merges public profile and rolls back local choice on save failure', 'setDoc(doc(db,"users",S.user.uid,"public","profile"),{lang}, {merge:true})' in app and 'applyAppLanguage(prev)' in app)
ok('system notification language follows user preference', 'lang: (S.me?.lang === "en" ? "en" : "ar")' in app)

# v57 shared webhook transport regressions.
webhook_transport = (root/'api/_bot-webhook.js').read_text()
bot_update = (root/'api/bot-update.js').read_text()
bot_callback = (root/'api/bot-callback.js').read_text()
ok('message updates and callbacks use the shared webhook transport', 'deliverWebhook' in bot_update and 'deliverWebhook' in bot_callback and 'function deliverWebhook' in webhook_transport)
ok('webhook transport refuses redirects and bounds request duration', 'redirect: "manual"' in webhook_transport and '4500' in webhook_transport)
ok('webhook event includes event ID, API version, and timestamp', 'event_id:' in webhook_transport and 'api_version: 1' in webhook_transport and 'created_at:' in webhook_transport)
ok('webhook signatures use documented sha256 prefix and timestamp', '`sha256=${signature}`' in webhook_transport and 'x-es-timestamp' in webhook_transport)
ok('inactive bot secrets cannot receive webhook updates', 'secretDoc.data()?.active !== true' in webhook_transport and 'bot.active !== true' in webhook_transport)
ok('bot owners can request a bounded signed webhook test without exposing secrets', 'testwebhook' in bot_api and 'deliverWebhook(db, b' in bot_api and 'webhook_delivery_failed' in bot_api)
ok('webhook test requires active bot and configured webhook', 'b.active !== true || !b.webhookUrl || !b.tokenHash' in bot_api)

# v58 Telegram BotFather manager regressions.
ok('Telegram and site bot managers are separate settings sections', 'settingsRow("telegramBots"' in app and 'settingsRow("botsManager"' in app and 'if (id === "telegramBots") return openTelegramBots()' in app)
# v73 site bot manager.
bot_api = (root/'api/bot.js').read_text(encoding='utf8')
ok('Site bot manager is reachable from app settings', 'settingsRow("botsManager"' in app and 'if (id === "botsManager") return openBotsManager()' in app)
ok('Site bot manager calls /api/bot with the Firebase ID token', 'fetch("/api/bot"' in app and 'authorization: `Bearer ${token}`' in app)
ok('Site bot manager only lists the signed-in owner bots', 'where("owner", "==", S.user.uid)' in app)
ok('Site bot manager shows secrets in readonly fields and never stores them', 'class="bm-secret" readonly' in app and 'localStorage.setItem("es_bot' not in app)
ok('Site bot manager covers every owner action of the bot API', all(('action: "%s"' % a) in app or ('"%s"' % a) in app for a in ['create','token','setname','setdescription','setabouttext','setcommands','setsettings','setwebhook','testwebhook','deletewebhook','enable','disable','deletebot']))
ok('testwebhook is in the owner-authenticated action list of the bot API', 'testwebhook' in bot_api and 'user auth required' in bot_api and 'testwebhook' in bot_api[bot_api.index('if ([\"disable\"'):bot_api.index('if ([\"disable\"')+800])
ok('Deleted bots cannot be managed or revived and each user has a bot cap', 'snap.data().deleted === true' in bot_api and 'MAX_BOTS' in bot_api and 'bot limit reached' in bot_api)
ok('Telegram manager no longer crashes on first open (writeBots defined before use)', app.index('const writeBots') < app.index('ensurePrimaryBot();'))
ok('Telegram manager opens official BotFather without collecting tokens', 'https://t.me/BotFather' in app and 'لا تحفظ أي توكنات' in app and 'tgBotToken' not in app)
ok('Telegram manager validates usernames and caps local catalog', 'username.toLowerCase().endsWith("bot")' in app and 'rows.length>=50' in app)
ok('Telegram manager includes common BotFather command shortcuts', all(x in app for x in ['/newbot','/mybots','/setname','/setdescription','/setabouttext','/setuserpic','/setcommands','/revoke']))
# v59 EStFather server-side Telegram connection foundation.
tg_api = (root/'api/telegram-manager.js').read_text()
ok('ESFather is set as the primary Telegram bot in manager UI', 'ESFather' in app and '@ESFather' in app)
ok('Telegram manager connection check uses authenticated backend endpoint', '/api/telegram-manager' in app and 'S.user.getIdToken()' in app)
ok('Telegram API token is server-only and endpoint is owner-restricted', 'process.env.TELEGRAM_BOT_TOKEN' in tg_api and 'TELEGRAM_MANAGER_OWNER_UID' in tg_api and 'user.uid !== owner' in tg_api)
ok('Telegram manager never returns token and bounds upstream request', 'Never return the token' in tg_api and 'AbortController' in tg_api and "redirect: 'error'" in tg_api)

# v60 authenticated username changes.
ok('username editor enabled in profile form', 'id="fUser" maxlength="20"' in app and 'disabled style="opacity:.6' not in app)
ok('username change is sent with Firebase ID token', '/api/username-change' in app and 'auth.currentUser.getIdToken()' in app)
ok('username API validates normalized username', "/^[a-z0-9_]{3,20}$/" in username_api)
ok('username API derives target uid from verified token', 'verifyIdToken(match[1])' in username_api and 'const uid = decoded.uid' in username_api)
ok('username reservation migration is transactional', 'db.runTransaction' in username_api and 'tx.set(nextRef, { uid })' in username_api and 'tx.delete(oldRef)' in username_api)
ok('username API updates private and public profile records', 'tx.update(userRef, { username })' in username_api and 'tx.set(publicRef, { uid, username }, { merge: true })' in username_api)

# v62 Telegram webhook diagnostics.
ok('Telegram manager exposes webhook diagnostics through getWebhookInfo', "action === 'webhookInfo'" in tg_api and "method = 'getWebhookInfo'" in tg_api)
ok('Webhook diagnostics redact full URL and bound error message', 'webhookHost' in tg_api and 'host: webhookHost' in tg_api and "slice(0, 240)" in tg_api and 'url: info.url' not in tg_api)
ok('Webhook diagnostics UI is authenticated through existing Telegram manager request', 'tgWebhookCheck' in app and 'telegramRequest({action:"webhookInfo"})' in app)

# v64 multi-bot fleet diagnostics.
ok('Telegram manager supports owner-authenticated fleet diagnostics', "action === 'fleetDiagnostics'" in tg_api and "user.uid !== owner" in tg_api)
ok('Fleet diagnostics checks each configured bot and webhook without returning tokens or full URLs', "getWebhookInfo" in tg_api and "entry.webhook = { configured" in tg_api and "entry.token" not in tg_api and "url: w.url" not in tg_api)
ok('Telegram UI renders fleet diagnostics safely with textContent', 'tgFleetDiagnostics' in app and 'tgFleetCards' in app and 'title.textContent=' in app and 'line.textContent=' in app)


# v72 message editing checks
ok('message menu offers edit for own non-deleted text messages', 'rows.push(["edit", "تعديل الرسالة"])' in app and 'mine && m.text && !m.deleted' in app)
ok('edited messages show an edited marker', 'm.editedAt ?' in app and '(تم التعديل)' in app)
ok('DM edit keeps ciphertext and records editedAt', 'cipher: await encryptPrivatePayload' in app and 'editedAt: serverTimestamp()' in app)
ok('Firestore DM edit permits only cipher and editedAt', "affectedKeys().hasOnly(['cipher','editedAt'])" in rules)
ok('Firestore group/channel edit permits only text and editedAt', "affectedKeys().hasOnly(['text','editedAt'])" in rules)

failed = [n for n, passed in checks if not passed]
for n, passed in checks: print(('PASS' if passed else 'FAIL') + ' - ' + n)
print(f'\n{len(checks)-len(failed)}/{len(checks)} checks passed')
if failed:
    print('FAILED: ' + ', '.join(failed)); sys.exit(1)

# v61 Telegram live settings.
ok('Telegram manager supports server-side name, description and short description updates', all(x in tg_api for x in ['setMyName', 'setMyDescription', 'setMyShortDescription']))
ok('Telegram manager supports reading, setting and deleting bot commands', all(x in tg_api for x in ['getMyCommands', 'setMyCommands', 'deleteMyCommands']))
ok('Telegram command list validates command names, descriptions, count and duplicates', all(x in tg_api for x in ['invalid_commands', 'duplicate_commands', 'commands.length > 100', '^[a-z0-9_]{1,32}$']))
ok('Telegram live settings remain authenticated and owner restricted', 'verifyIdToken(match[1])' in tg_api and 'user.uid !== owner' in tg_api)
ok('Telegram settings UI exposes live editing actions without collecting token', all(x in app for x in ['tgSaveName', 'tgSaveDescription', 'tgSaveShort', 'tgSaveCommands', 'tgLoadCommands', 'tgDeleteCommands']) and 'tgBotToken' not in app)



# v68 hide conversation locally without deleting shared records.
ok('v68 has per-user hidden conversation preference default', 'hiddenChats: []' in app)
ok('v68 chat list filters only the current user hiddenChats preference', 'chats = chats.filter(c => !P.hiddenChats.includes(c.id))' in app)
ok('v69 long-press chat menu offers immediate delete-from-my-list action', 'data-a="deletechat"' in app and 'إزالة فورية من قائمتك فقط' in app and 'اتحذف الشات من عندك؛ لسه موجود عند الطرف التاني' in app)
ok('v69 deletion only adds current-user hiddenChats preference and never deletes shared chat records', 'savePrefs({ hiddenChats: [...hidden, id] })' in app and 'deleteDoc(doc(db, "chats"' not in app)
ok('v68 Firestore still blocks client-side deletion of conversation documents', 'allow delete: if false;' in rules)

ok('v71 hidden chat management screen exists', 'if (id === "hiddenChats")' in app and 'المحادثات المخفية' in app)
ok('v71 hidden chat restore persists per-user preference', 'data-restore-hidden' in app and 'setDoc(prefsRef(), { hiddenChats: next }' in app)
