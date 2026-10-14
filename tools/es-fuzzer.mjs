#!/usr/bin/env node
/**
 * ES Fuzzer v56 — offline, deterministic contract checks for ES Chat bot payloads.
 * This tool never sends network traffic, touches Firebase, or attacks a live service.
 * Run: node tools/es-fuzzer.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiBot = fs.readFileSync(path.join(root, 'api/bot.js'), 'utf8');
const apiCallback = fs.readFileSync(path.join(root, 'api/bot-callback.js'), 'utf8');
const apiGuard = fs.readFileSync(path.join(root, 'api/_net-guard.js'), 'utf8');
const apiEsBot = fs.readFileSync(path.join(root, 'api/es-bot.js'), 'utf8');
const checks = [];
const check = (name, pass, detail = '') => checks.push({ name, pass: Boolean(pass), detail });
const cleanText = (value, max) => String(value || '').trim().slice(0, max);
const safeCommands = value => {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).map(x => ({
    command: String(x?.command || '').trim().replace(/^\//, '').toLowerCase(),
    ar: cleanText(x?.ar || x?.descriptionAr, 120),
    en: cleanText(x?.en || x?.descriptionEn, 120)
  })).filter(x => x.command.length <= 32 && /^[a-z0-9_]{1,32}$/.test(x.command) && (x.ar || x.en));
};
const safeButtons = value => {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map(x => {
    let url = '';
    try { const u = new URL(String(x?.url || '')); const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, ''); const ip = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/); let privateIp = false; if (ip) { const [a,b,c,d] = ip.slice(1).map(Number); privateIp = [a,b,c,d].some(n => n > 255) || a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224; } if (u.protocol === 'https:' && !u.username && !u.password && host !== 'localhost' && !host.endsWith('.localhost') && !host.endsWith('.local') && host !== '::1' && host !== '::' && !host.startsWith('fe80:') && !host.startsWith('fc') && !host.startsWith('fd') && !privateIp) url = u.href.slice(0, 500); } catch {}
    return { ar: cleanText(x?.ar || x?.textAr || x?.text, 40), en: cleanText(x?.en || x?.textEn || x?.text, 40), url, callback: cleanText(x?.callback, 128) };
  }).filter(x => (x.ar || x.en) && (x.url || x.callback));
};

// Structural contract checks: confirm the production handler keeps the guards the fuzzer models.
check('bot API only accepts POST', /if\s*\(req\.method\s*!==\s*"POST"\)/.test(apiBot));
check('bot API caps incoming Content-Length', /content-length[\s\S]{0,100}20000/.test(apiBot));
check('bot management requires verified user token', /verifyIdToken\(m\[1\]\)/.test(apiBot));
check('bot token is stored/checked by hash', /botSecrets\/\$\{hash\(raw\)\}/.test(apiBot) && /tokenHash !== hash\(raw\)/.test(apiBot));
check('command payload is capped to 50 items', /value\.slice\(0, 50\)/.test(apiBot));
check('button payload is capped to 8 items', /value\.slice\(0, 8\)/.test(apiBot));
check('overlong command names are rejected rather than truncated into valid commands', /x\.command\.length <= 32/.test(apiBot));
check('webhooks reject private IPv4 ranges and local hostnames (shared guard used by BOTH bot APIs)', /host === \"localhost\"/.test(apiGuard) && /a === 127/.test(apiGuard) && /a === 192 && b === 168/.test(apiGuard) && /_net-guard/.test(apiBot) && /_net-guard/.test(apiEsBot));
check('callback requires group membership', /gd\.members \|\| \[\]\)\.includes\(u\.uid\)/.test(apiCallback));
check('callback data is length-limited', /String\(body\.data \|\| ""\)\.slice\(0, 128\)/.test(apiCallback));

// Deterministic offline input mutations. These only exercise local normalization helpers.
const commandsCases = [
  { name: 'valid command retained', input: [{ command: '/Help', ar: 'مساعدة' }], expect: 1 },
  { name: 'invalid punctuation command rejected', input: [{ command: 'help;drop', en: 'help' }], expect: 0 },
  { name: 'command length over limit clipped then validated', input: [{ command: 'a'.repeat(80), en: 'x' }], expect: 0 },
  { name: 'empty description rejected', input: [{ command: 'start', en: '   ' }], expect: 0 },
  { name: 'non-array commands rejected', input: { command: 'start', en: 'start' }, expect: 0 },
  { name: 'oversized list capped at 50', input: Array.from({ length: 120 }, (_, i) => ({ command: `cmd_${i}`, en: 'ok' })), expect: 50 },
  { name: 'Unicode and emoji do not crash normalization', input: [{ command: 'hello', ar: 'أهلًا 👋🌙' }], expect: 1 }
];
for (const t of commandsCases) {
  let actual = -1, error = '';
  try { actual = safeCommands(t.input).length; } catch (e) { error = e.message; }
  check(`commands: ${t.name}`, !error && actual === t.expect, error || `expected ${t.expect}, got ${actual}`);
}
const buttonCases = [
  { name: 'HTTPS button accepted', input: [{ text: 'Open', url: 'https://example.com' }], expect: 1 },
  { name: 'HTTP URL rejected', input: [{ text: 'Open', url: 'http://example.com' }], expect: 0 },
  { name: 'javascript URL rejected', input: [{ text: 'Run', url: 'javascript:alert(1)' }], expect: 0 },
  { name: 'local loopback URL rejected', input: [{ text: 'Local', url: 'https://127.0.0.1/admin' }], expect: 0 },
  { name: 'private LAN URL rejected', input: [{ text: 'LAN', url: 'https://192.168.1.10/admin' }], expect: 0 },
  { name: 'IPv6 loopback URL rejected', input: [{ text: 'IPv6', url: 'https://[::1]/admin' }], expect: 0 },
  { name: 'URL credentials rejected', input: [{ text: 'Creds', url: 'https://user:pass@example.com' }], expect: 0 },
  { name: 'button without URL or callback rejected', input: [{ text: 'No action' }], expect: 0 },
  { name: 'button array capped at 8', input: Array.from({ length: 20 }, (_, i) => ({ text: `B${i}`, callback: `cb${i}` })), expect: 8 },
  { name: 'oversized callback clipped to 128', input: [{ text: 'Click', callback: 'x'.repeat(500) }], expect: 1, verify: b => b[0].callback.length === 128 },
  { name: 'malformed URL does not crash', input: [{ text: 'Bad', url: 'https://[broken' }], expect: 0 }
];
for (const t of buttonCases) {
  let actual = [], error = '';
  try { actual = safeButtons(t.input); } catch (e) { error = e.message; }
  check(`buttons: ${t.name}`, !error && actual.length === t.expect && (!t.verify || t.verify(actual)), error || `expected ${t.expect}, got ${actual.length}`);
}

const failed = checks.filter(x => !x.pass);
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} - ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
console.log(`\nES Fuzzer v56: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exitCode = 1;
