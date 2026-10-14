// حارس الشبكة المشترك: بيمنع الـ webhooks/الروابط من الإشارة لعناوين داخلية (SSRF).
// بيتستخدم في bot.js و es-bot.js و _bot-webhook.js بدل نسخ متفرقة من نفس الفحص.
const dns = require("dns").promises;
const net = require("net");

function isPrivateIPv4(ip) {
  const p = String(ip).split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) ||
    (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
function isPrivateIPv6(ip) {
  const h = String(ip).toLowerCase();
  const mapped = h.match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (mapped) {
    if (mapped[1]) return isPrivateIPv4(mapped[1]);
    const hi = parseInt(mapped[2], 16), lo = parseInt(mapped[3], 16);
    return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  // قائمة سماح: بس العناوين العامة 2000::/3، ومستثني منها التوثيق (2001:db8) و6to4 (2002) وTeredo (2001::/32)
  const g = h.split(":").map(x => parseInt(x || "0", 16));
  const first = g[0] || 0, second = g[1] || 0;
  if ((first & 0xe000) !== 0x2000) return true;
  if (first === 0x2002) return true;
  if (first === 0x2001 && (second === 0x0db8 || second === 0x0000)) return true;
  return false;
}
const isPrivateIp = ip => { const v = net.isIP(String(ip)); return v === 4 ? isPrivateIPv4(ip) : v === 6 ? isPrivateIPv6(ip) : true; };

// فحص ثابت للرابط (من غير DNS): https فقط، من غير بيانات دخول، ومش عنوان داخلي ولا اسم داخلي.
function validPublicHttpsUrl(value) {
  try {
    const u = new URL(String(value || ""));
    if (u.protocol !== "https:" || u.username || u.password) return false;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!host || host.length > 253) return false;
    if (net.isIP(host)) return !isPrivateIp(host);
    if (host === "localhost" || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) return false;
    if (!host.includes(".")) return false; // اسم من مقطع واحد = شبكة داخلية غالبًا
    return true;
  } catch { return false; }
}

// فحص وقت الإرسال: الاسم لازم يتحلّل لعناوين عامة بس (بيقفل حالة اسم عام بيشاور على IP داخلي).
async function resolvesToPublicOnly(hostname, timeoutMs = 2500) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIP(h)) return !isPrivateIp(h);
  let timer;
  try {
    const rows = await Promise.race([
      dns.lookup(h, { all: true, verbatim: true }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("dns_timeout")), timeoutMs); })
    ]);
    return rows.length > 0 && rows.every(r => !isPrivateIp(r.address));
  } catch { return false; } finally { clearTimeout(timer); }
}

module.exports = { isPrivateIp, validPublicHttpsUrl, resolvesToPublicOnly };
