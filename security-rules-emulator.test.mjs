import fs from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, writeBatch } from 'firebase/firestore';

const rules = fs.readFileSync(new URL('./firestore.rules', import.meta.url), 'utf8');
const env = await initializeTestEnvironment({
  projectId: 'demo-es-chat',
  firestore: { host: '127.0.0.1', port: 8080, rules }
});
const owner = env.authenticatedContext('owner', { email: 'moreand458@gmail.com', email_verified: true }).firestore();
const member = env.authenticatedContext('member', { email: 'member@example.com', email_verified: true }).firestore();
const outsider = env.authenticatedContext('outsider', { email: 'outsider@example.com', email_verified: true }).firestore();
const group = { kind:'group', name:'Test', desc:'', photo:'', owner:'owner', admins:['owner'], members:['owner','member'], public:false, joinOpen:false, handle:'', createdAt:1 };
let batchSeed;
await env.withSecurityRulesDisabled(async c => { batchSeed = c.firestore();
await setDoc(doc(batchSeed, ...'groups/g1'.split('/')), group);
await setDoc(doc(batchSeed, ...'groupDirectory/g1'.split('/')), {kind:'group',name:'Test',desc:'',photo:'',owner:'owner',public:false,verified:false,joinOpen:false,handle:'',createdAt:1});
await setDoc(doc(batchSeed, ...'groups/g1/messages/m1'.split('/')), { uid:'owner', text:'secret', at:1 });
await setDoc(doc(batchSeed, ...'chats/owner_member'.split('/')), { members:['owner','member'] });
await setDoc(doc(batchSeed, ...'chats/owner_member/messages/old'.split('/')), { uid:'owner', cipher:{v:2,alg:'ECDH-P256-AESGCM-DUAL',recipient:{senderEphemeralPublic:{kty:'EC'},iv:'1234567890123456',ciphertext:'x'},sender:{senderIdentityPublic:{kty:'EC'},iv:'1234567890123456',ciphertext:'x'}},at:1 });
});

const results=[];
async function t(name, fn, shouldPass) { try { await (shouldPass ? assertSucceeds(fn()) : assertFails(fn())); results.push(`${shouldPass?'PASS':'PASS'} - ${name}`); } catch (e) { results.push(`FAIL - ${name}: ${e.message}`); } }
await t('outsider cannot read full private group', () => getDoc(doc(outsider, ...'groups/g1'.split('/'))), false);
await t('member can read full group', () => getDoc(doc(member, ...'groups/g1'.split('/'))), true);
await t('outsider cannot read group messages', () => getDoc(doc(outsider, ...'groups/g1/messages/m1'.split('/'))), false);
await t('outsider may read non-sensitive directory only', () => getDoc(doc(outsider, ...'groupDirectory/g1'.split('/'))), true);
await t('private plaintext message is rejected', () => setDoc(doc(member, ...'chats/owner_member/messages/plain'.split('/')), {uid:'member', text:'leak', at:1}), false);
const dual = {uid:'member',at:1,cipher:{v:2,alg:'ECDH-P256-AESGCM-DUAL',recipient:{senderEphemeralPublic:{kty:'EC'},iv:'1234567890123456',ciphertext:'x'},sender:{senderIdentityPublic:{kty:'EC'},iv:'1234567890123456',ciphertext:'x'}}};
await t('valid dual ciphertext is accepted', () => setDoc(doc(member, ...'chats/owner_member/messages/dual'.split('/')), dual), true);
await t('clear reaction update in private is rejected', () => updateDoc(doc(member, ...'chats/owner_member/messages/old'.split('/')), {reactions:{member:'🔥'}}), false);
await t('fake directory cannot be created without real group', () => setDoc(doc(outsider, ...'groupDirectory/fake'.split('/')), {kind:'channel',name:'Fake',desc:'',photo:'',owner:'outsider',public:true,verified:false,joinOpen:true,handle:'fake',createdAt:1}), false);
const b = writeBatch(owner); b.set(doc(owner, ...'groups/g2'.split('/')), {...group, owner:'owner', members:['owner']}); b.set(doc(owner, ...'groupDirectory/g2'.split('/')), {kind:'group',name:'G2',desc:'',photo:'',owner:'owner',public:false,verified:false,joinOpen:true,handle:'',createdAt:1});
await t('real group and directory batch is accepted', () => b.commit(), true);
console.log(results.join('\n'));
console.log(`${results.filter(x=>x.startsWith('PASS')).length}/${results.length} emulator tests passed`);
await env.cleanup();
if (results.some(x=>x.startsWith('FAIL'))) process.exit(1);
