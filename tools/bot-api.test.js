const Module = require('module'); const path=require('path').resolve(__dirname,'..')+'/';
const DB = {}; const SV = {__sv:1};
const clone = o => JSON.parse(JSON.stringify(o));
const applyUpd = (cur, d) => { const n = {...cur}; for (const [k,v] of Object.entries(d)) { if (v && v.__union) n[k] = [...new Set([...(n[k]||[]), ...v.__union])]; else n[k]=v; } return n; };
const docRef = p => ({ path:p, id:p.split('/').pop(),
  async get(){ const d=DB[p]; return { exists:d!==undefined, id:p.split('/').pop(), data:()=>d===undefined?undefined:clone(d) }; },
  async set(d,o){ DB[p] = (o&&o.merge)? applyUpd(DB[p]||{},d) : applyUpd({},d); },
  async update(d){ if(DB[p]===undefined) throw new Error('NOT_FOUND'); DB[p]=applyUpd(DB[p],d); } });
const fakeAdmin = { apps:[1], initializeApp(){}, credential:{cert:()=>({})},
  auth:()=>({ verifyIdToken: async t=>{ if(!t.startsWith('uid:')) throw new Error('bad'); return {uid:t.slice(4)}; } }),
  firestore: Object.assign(()=>({ doc:docRef, collection:p=>({ where:(f,op,v)=>({ async get(){ const pre=p+'/'; const docs=Object.keys(DB).filter(k=>k.startsWith(pre)&&!k.slice(pre.length).includes('/')&&DB[k][f]===v).map(k=>({id:k.slice(pre.length),data:()=>clone(DB[k])})); return {docs}; } }), async add(d){const id='m'+Object.keys(DB).length; DB[p+'/'+id]=applyUpd({},d); return {id};} }) }), { FieldValue:{ serverTimestamp:()=>SV, arrayUnion:(...a)=>({__union:a}) } }) };
const orig = Module._load;
Module._load = function(req,...r){ if(req==='firebase-admin') return fakeAdmin; return orig.call(this,req,...r); };
const handler = require(path+'api/bot.js');
const call = async (body, hdr={}) => { let out; const res={status(c){out={code:c};return this;},json(b){out.body=b;return this;}}; await handler({method:'POST',headers:hdr,body},res); return out; };
const U = u => ({authorization:'Bearer uid:'+u});
let pass=0, fail=0; const t=(n,c,x='')=>{ (c?pass++:fail++); console.log((c?'PASS':'FAIL')+' - '+n+(c?'':'  '+x)); };
(async()=>{
  let r = await call({action:'create',name:'Bot A'}); t('create requires auth', r.code===401);
  r = await call({action:'create',name:'x'},U('u1')); t('create rejects 1-char name', r.code===400);
  r = await call({action:'create',name:'Bot A'},U('u1')); t('create ok', r.code===201 && /^esb_live_/.test(r.body.token)); const A=r.body, bid=A.bot.id, tok1=A.token;
  t('raw token never stored', !JSON.stringify(DB).includes(tok1));
  r = await call({action:'setname',botId:bid,name:'Hack'},U('u2')); t("other user can't manage my bot", r.code===404);
  r = await call({action:'setname',botId:bid,name:'Nn',nameAr:'ن',nameEn:'Nn'},U('u1')); t('setname', r.code===200 && DB['bots/'+bid].nameAr==='ن');
  r = await call({action:'setcommands',botId:bid,commands:[{command:'/Start',ar:'ابدأ'},{command:'bad cmd',ar:'x'},{command:'a',ar:''}]},U('u1')); t('setcommands normalizes and drops invalid', r.body.count===1 && DB['bots/'+bid].commands[0].command==='start');
  r = await call({action:'setsettings',botId:bid,joinGroups:false,privacy:false,inline:true,inlineGeo:true},U('u1')); t('setsettings', r.body.settings.joinGroups===false && r.body.settings.inline===true);
  r = await call({action:'setwebhook',botId:bid,url:'http://x.com'},U('u1')); t('webhook http rejected', r.code===400);
  r = await call({action:'setwebhook',botId:bid,url:'https://127.0.0.1/x'},U('u1')); t('webhook loopback rejected', r.code===400);
  r = await call({action:'setwebhook',botId:bid,url:'https://example.com/h'},U('u1')); t('webhook https ok + secret', r.code===200 && r.body.secret);
  r = await call({action:'testwebhook',botId:bid},U('u1')); t('testwebhook is routed (not 401/unknown)', r.code!==401 && r.body.error!=='unknown action', JSON.stringify(r));
  r = await call({action:'me'},{'x-es-bot-token':tok1}); t('bot token works (me)', r.code===200 && r.body.bot.id===bid);
  r = await call({action:'token',botId:bid},U('u1')); const tok2=r.body.token; t('rotate gives new token', tok2 && tok2!==tok1);
  r = await call({action:'me'},{'x-es-bot-token':tok1}); t('old token revoked after rotate', r.code===401);
  r = await call({action:'disable',botId:bid},U('u1')); r = await call({action:'me'},{'x-es-bot-token':tok2}); t('disabled bot token rejected', r.code===401);
  r = await call({action:'enable',botId:bid},U('u1')); r = await call({action:'me'},{'x-es-bot-token':tok2}); t('enable restores token', r.code===200);
  r = await call({action:'deletebot',botId:bid},U('u1')); r = await call({action:'me'},{'x-es-bot-token':tok2}); t('deleted bot token rejected', r.code===401);
  r = await call({action:'enable',botId:bid},U('u1')); r = await call({action:'me'},{'x-es-bot-token':tok2}); t('DELETED bot cannot be resurrected via enable', r.code===401, 'status '+r.code);
  r = await call({action:'token',botId:bid},U('u1')); t('DELETED bot cannot get a new token', r.code===404, 'status '+r.code+' '+JSON.stringify(r.body).slice(0,60));
  let n=0; for(let i=0;i<30;i++){ const x=await call({action:'create',name:'Spam '+i},U('u3')); if(x.code===201) n++; } t('per-user bot cap exists (<=20)', n<=20, 'created '+n);
  console.log(`\n${pass} passed, ${fail} failed`);
})();
