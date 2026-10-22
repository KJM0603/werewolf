// Run: node --test tests/*.test.mjs
// Optional: WEREWOLF_REPO points to another checkout. Production sources are unchanged.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
const repo = process.env.WEREWOLF_REPO || fileURLToPath(new URL('../', import.meta.url));
const source = readFileSync(join(repo, 'server.mjs'), 'utf8')
  .split('const server = createServer(')[0].replace(/^import .*;\r?$/gm, '');
function fixture(roles, centerRoles = ['villager', 'villager', 'villager']) {
  const context = vm.createContext({ Buffer, process, join, randomBytes,
    setTimeout: (callback, ms) => ({ callback, ms }), clearTimeout() {} });
  vm.runInContext(`${source}
    globalThis.api={rooms,handle,beginNight,beginAction,applyNightAction,resolveVotes,
    roleForPlayer,timerExpired,publicRoom,startGame,defaultRoles,enterVoting,startDiscussion,closeSocket};`, context);
  const api = context.api;
  function socket(id) {
    const messages = [];
    return { room:'AUDIT', playerId:id, messages, socket:{
      end() {}, write(frame) {
        const n=frame[1]&127;
        messages.push(JSON.parse(frame.subarray(n<126?2:n===126?4:10).toString()));
      }
    }};
  }
  const players = new Map(roles.map((role,i) => {
    const id=`p${i}`; return [id,{id,name:id,token:`token-${id}`,ready:true,connected:true,socket:socket(id)}];
  }));
  const center = centerRoles.map((role,i)=>({id:`c${i}`,role,ownerId:null}));
  const room = { code:'AUDIT', hostId:'p0', players, phase:'night',
    cards:[...roles.map((role,i)=>({id:`card${i}`,role,ownerId:`p${i}`,copyRole:null})),...center],
    center, roles:[...roles,...centerRoles], startRoles:new Map(roles.map((r,i)=>[`p${i}`,r])),
    copyRoles:new Map(),actionDone:new Set(),actionActors:[],actionIndex:0,activeRole:null,actionPrompt:null,
    votes:new Map(),extensionUsed:new Set(),chat:[],discussionSeconds:600,votingSeconds:20,
    result:null,timer:null,timerEndsAt:null,remainingMs:0,hasTestBots:false };
  api.rooms.set(room.code,room);
  const messages=id=>players.get(id).socket.messages;
  const action=(role,id,data)=>{ api.beginAction(room,role);api.applyNightAction(room,id,data); };
  const vote=targets=>{room.votes=new Map(targets.map((id,i)=>[`p${i}`,id]));api.resolveVotes(room);return room.result;};
  const reconnect=id=>{const ws=socket(null);api.handle(ws,'room:reconnect',{code:room.code,token:`token-${id}`});return ws.messages;};
  return {...api,room,messages,action,vote,reconnect,context};
}
const winner=(result,id)=>result.winners.find(p=>p.id===id).win;
const results=(f,id)=>f.messages(id).filter(m=>m.event==='night:result');

for(const [role,data] of [
  ['seer',{centerIndexes:[0,1]}],
  ['robber',{targetId:'p2'}],
  ['troublemaker',{targetId:'p1',secondTargetId:'p2'}],
  ['drunk',{centerIndex:0}]
])test(`doppelganger copies ${role}, reconnects, and completes its immediate ability once`,()=>{
  const f=fixture(['doppelganger',role,'werewolf'],['tanner','villager','hunter']);
  f.beginAction(f.room,'doppelganger');const deadline=f.room.timerEndsAt;
  assert.equal(f.room.timer.ms,13000);
  f.applyNightAction(f.room,'p0',{targetId:'p1'});
  const restored=f.reconnect('p0');
  const prompt=restored.find(m=>m.event==='night:prompt').data;
  assert.equal(prompt.role,'doppelganger-copy');assert.equal(prompt.targetRole,role);
  f.applyNightAction(f.room,'p0',data);
  assert.equal(f.room.actionPrompt,null);assert.equal(f.room.timerEndsAt,deadline);
  assert.equal(f.room.actionDone.has('doppelganger:p0'),true);
  const knowledge=f.room.players.get('p0').knowledge.events;
  assert.equal(knowledge.filter(e=>e.event==='night:result').length,2);
  if(role==='seer')assert.deepEqual(knowledge.at(-1).data.roles,['무두장이','주민']);
  if(role==='robber')assert.equal(f.roleForPlayer(f.room,'p0'),'werewolf');
  if(role==='troublemaker'){assert.equal(f.roleForPlayer(f.room,'p1'),'werewolf');assert.equal(f.roleForPlayer(f.room,'p2'),'troublemaker');}
  if(role==='drunk')assert.equal(f.roleForPlayer(f.room,'p0'),'tanner');
  f.applyNightAction(f.room,'p0',data);
  assert.equal(knowledge.filter(e=>e.event==='night:result').length,2);
  f.beginAction(f.room,role);
  assert.ok(!f.room.actionActors.includes('p0'),'Do not repeat the copied ability in the normal role turn');
});
for(const role of ['werewolf','mason'])test(`copied ${role} receives its information in that role's turn`,()=>{
  const f=fixture(['doppelganger',role,'villager']);
  f.action('doppelganger','p0',{targetId:'p1'});
  assert.equal(f.room.actionPrompt,null);
  f.beginAction(f.room,role);
  assert.ok(f.messages('p0').some(m=>m.event==='night:info'&&m.data.role===role));
});
for(const role of ['villager','tanner','hunter'])test(`copied ${role} clearly finishes with no extra night action`,()=>{
  const f=fixture(['doppelganger',role,'werewolf']);
  f.action('doppelganger','p0',{targetId:'p1'});
  assert.equal(f.room.actionPrompt,null);assert.equal(f.roleForPlayer(f.room,'p0'),role);
  assert.match(results(f,'p0').at(-1).data.text,/추가로 수행할 행동이 없습니다/);
});
test('copied ability timeout explicitly ends the turn without changing the public deadline',()=>{
  const f=fixture(['doppelganger','robber','werewolf']);
  f.action('doppelganger','p0',{targetId:'p1'});
  f.timerExpired(f.room);
  assert.equal(f.roleForPlayer(f.room,'p0'),'robber');
  assert.ok(f.messages('p0').some(m=>m.event==='night:turn-ended'&&m.data.reason==='timeout'));
});

test('restart retains room, members and roles but clears all previous round state before a second game',()=>{
  const f=fixture(['werewolf','seer','robber']);const room=f.room;
  f.startGame(room);f.vote(['p1','p0','p0']);
  room.customRoles=true;room.copyRoles.set('p0','seer');room.actionDone.add('seer:p1');
  room.extensionUsed.add('p1');room.discussionSkipVotes=new Set(['p0']);room.discussionSeconds=660;
  room.players.get('p1').knowledge.events.push({event:'night:result',data:{text:'old secret'}});
  const identities=[...room.players.values()].map(p=>[p.id,p.token,p.socket]);const roles=[...room.roles];
  room.chat.push({id:'old',text:'이전 판 대화'});
  f.handle(room.players.get('p0').socket,'game:restart',{});
  assert.equal(f.rooms.get('AUDIT'),room);assert.equal(room.phase,'lobby');assert.equal(room.hostId,'p0');
  assert.deepEqual([...room.roles],roles);assert.equal(room.customRoles,true);
  assert.deepEqual([...room.players.values()].map(p=>[p.id,p.token,p.socket]),identities);
  for(const key of ['startRoles','copyRoles','votes','actionDone','extensionUsed','discussionSkipVotes'])assert.equal(room[key].size,0,key);
  for(const key of ['cards','center','actionActors','chat'])assert.equal(room[key].length,0,key);
  for(const key of ['result','timer','timerEndsAt','activeRole','actionPrompt','pauseReason'])assert.equal(room[key],null,key);
  assert.equal(room.discussionSeconds,600);assert.equal(room.remainingMs,0);
  assert.ok([...room.players.values()].every(p=>!p.ready&&!p.knowledge));
  const restored=f.reconnect('p1');assert.ok(restored.every(m=>!['role:private','night:result','night:prompt'].includes(m.event)));
  f.handle(room.players.get('p0').socket,'game:start',{});assert.equal(room.phase,'lobby');
  for(const id of ['p1','p2'])f.handle(room.players.get(id).socket,'player:ready',{ready:true});
  f.handle(room.players.get('p0').socket,'game:start',{});
  assert.equal(room.phase,'role_reveal');assert.equal(room.startRoles.size,3);assert.equal(room.code,'AUDIT');
  assert.ok([...room.players.values()].every(p=>p.knowledge.events.length===0));
});
test('restart rejects nonhosts, stale sockets, active games and duplicate requests',()=>{
  const f=fixture(['werewolf','seer','robber']);const ws=f.room.players.get('p0').socket;
  f.handle(ws,'game:restart',{});assert.equal(f.room.phase,'night');assert.equal(ws.messages.at(-1).event,'error');
  f.vote(['p1','p0','p0']);
  f.handle(f.room.players.get('p1').socket,'game:restart',{});assert.equal(f.room.phase,'result');
  f.handle({...ws},'game:restart',{});assert.equal(f.room.phase,'result');
  f.handle(ws,'game:restart',{});f.room.players.get('p1').ready=true;
  f.handle(ws,'game:restart',{});assert.equal(f.room.players.get('p1').ready,true);
});
test('result host can leave, successor restarts with bots and final human departure deletes room',()=>{
  const f=fixture(['werewolf','seer','robber','villager']);f.room.players.get('p1').isBot=true;
  f.room.hasTestBots=true;f.vote(['p1','p0','p0','p0']);const result=f.room.result;
  const oldHost=f.room.players.get('p0').socket;
  f.handle(oldHost,'room:leave',{});assert.equal(f.room.hostId,'p2');assert.equal(f.room.result,result);
  assert.equal(f.reconnect('p0').at(-1).event,'error');
  f.handle(f.room.players.get('p2').socket,'game:restart',{});
  assert.equal(f.room.phase,'lobby');assert.equal(f.room.roles.length,6);assert.equal(f.room.players.get('p1').ready,true);
  f.room.phase='result';
  for(const id of ['p2','p3'])f.handle(f.room.players.get(id).socket,'room:leave',{});
  assert.equal(f.rooms.has('AUDIT'),false);
});

test('lobby chat broadcasts and survives reconnect but clears for all clients on game start',()=>{
  const f=fixture(['villager','seer','robber']);f.room.phase='lobby';
  f.handle(f.room.players.get('p1').socket,'chat:send',{text:'  준비됐습니다  '});
  assert.equal(f.messages('p0').at(-1).event,'chat:message');
  assert.equal(f.messages('p0').at(-1).data.text,'준비됐습니다');
  assert.equal(f.messages('p2').at(-1).data.playerId,'p1');
  assert.equal(f.reconnect('p1').find(m=>m.event==='room:joined').data.room.chat[0].text,'준비됐습니다');
  f.startGame(f.room);
  assert.equal(f.publicRoom(f.room).chat.length,0);
  for(const id of ['p0','p1','p2'])assert.equal(f.messages(id).findLast(m=>m.event==='game:phase').data.chat.length,0);
  assert.equal(f.reconnect('p1').find(m=>m.event==='room:joined').data.room.chat.length,0);
  const count=f.room.chat.length;f.room.phase='night';
  f.handle(f.room.players.get('p0').socket,'chat:send',{text:'밤에는 전송 불가'});
  assert.equal(f.room.chat.length,count);
});
test('chat retains the latest 200 messages consistently in memory and reconnect snapshots',()=>{
  const f=fixture(['villager','seer','robber']);f.room.phase='lobby';
  for(let i=0;i<205;i++)f.handle(f.room.players.get('p0').socket,'chat:send',{text:`메시지 ${i}`});
  assert.equal(f.room.chat.length,200);
  assert.equal(f.publicRoom(f.room).chat[0].text,'메시지 5');
  assert.equal(f.publicRoom(f.room).chat.at(-1).text,'메시지 204');
  f.handle(f.room.players.get('p0').socket,'chat:send',{text:'   '});
  assert.equal(f.room.chat.at(-1).text,'메시지 204');
});

test('lobby leave removes membership and reconnect token, resizes roles, and permits creating another room',()=>{
  const f=fixture(['villager','seer','robber']);f.room.phase='lobby';f.room.customRoles=true;
  const ws=f.room.players.get('p1').socket;
  f.handle(ws,'room:leave',{});
  assert.equal(f.room.players.has('p1'),false);
  assert.equal(f.room.hostId,'p0');
  assert.equal(f.room.roles.length,5);assert.equal(f.room.customRoles,false);
  assert.equal(ws.room,null);assert.equal(ws.playerId,null);
  assert.equal(ws.messages.at(-1).event,'room:left');
  assert.equal(f.reconnect('p1').at(-1).event,'error');
  f.handle(ws,'room:create',{name:'New host'});
  assert.equal(ws.messages.at(-1).data.hostId,ws.playerId);
  assert.notEqual(ws.room,'AUDIT');
});
test('host leave transfers control to a connected human ahead of bots or disconnected humans',()=>{
  const f=fixture(Array(4).fill('villager'));f.room.phase='lobby';
  f.room.players.get('p1').isBot=true;f.room.players.get('p2').connected=false;
  f.handle(f.room.players.get('p0').socket,'room:leave',{});
  assert.equal(f.room.hostId,'p3');
  f.handle(f.room.players.get('p3').socket,'room:leave',{});
  assert.equal(f.room.hostId,'p2');
});
test('last human leaving deletes the room even when bots remain',()=>{
  const f=fixture(['villager','seer']);f.room.phase='lobby';f.room.players.get('p1').isBot=true;
  f.handle(f.room.players.get('p0').socket,'room:leave',{});
  assert.equal(f.rooms.has(f.room.code),false);
});
test('leave rejects an active game or obsolete socket without removing players',()=>{
  const f=fixture(['villager','seer','robber']);
  const ws=f.room.players.get('p0').socket;
  f.handle(ws,'room:leave',{});
  assert.equal(ws.messages.at(-1).event,'error');assert.equal(f.room.players.size,3);
  f.room.phase='lobby';f.room.players.get('p0').socket={};
  f.handle(ws,'room:leave',{});
  assert.equal(ws.messages.at(-1).event,'error');assert.equal(f.room.players.size,3);
});

for (const n of [3,4,5,6,7,8,9,10]) test(`discussion requires a strict majority of ${n} humans`,()=>{
  const f=fixture(Array(n).fill('villager'));f.startDiscussion(f.room);
  const required=Math.floor(n/2)+1, timer=f.room.timer;
  for(let i=0;i<required-1;i++)f.handle(f.room.players.get(`p${i}`).socket,'discussion:skip-vote',{agree:true});
  assert.equal(f.room.phase,'discussion');assert.equal(f.room.timer,timer);
  assert.equal(f.publicRoom(f.room).discussionSkip.votes.length,required-1);
  f.handle(f.room.players.get(`p${required-1}`).socket,'discussion:skip-vote',{agree:true});
  assert.equal(f.room.phase,'voting');assert.equal(f.room.votes.size,0);
  const votingTimer=f.room.timer;
  f.handle(f.room.players.get('p0').socket,'discussion:skip-vote',{agree:true});
  assert.equal(f.room.timer,votingTimer,'Late requests must not restart voting');
});
test('discussion consent is idempotent, retractable, and excludes bots',()=>{
  const f=fixture(Array(5).fill('villager'));
  f.room.players.get('p3').isBot=true;f.room.players.get('p4').isBot=true;f.room.hasTestBots=true;
  f.startDiscussion(f.room);
  const ws=f.room.players.get('p1').socket;
  f.handle(ws,'discussion:skip-vote',{agree:true});
  f.handle(ws,'discussion:skip-vote',{agree:true});
  assert.equal(f.publicRoom(f.room).discussionSkip.votes.length,1);
  assert.equal(f.publicRoom(f.room).discussionSkip.required,2);
  f.handle(ws,'discussion:skip-vote',{agree:false});
  assert.equal(f.publicRoom(f.room).discussionSkip.votes.length,0);
  f.handle(f.room.players.get('p3').socket,'discussion:skip-vote',{agree:true});
  assert.equal(f.publicRoom(f.room).discussionSkip.votes.length,0);
  f.handle(ws,'discussion:skip-vote',{agree:'true'});
  assert.equal(f.publicRoom(f.room).discussionSkip.votes.length,0);
});
test('disconnect and reconnect preserve electorate and consent',()=>{
  const f=fixture(Array(4).fill('villager'));f.startDiscussion(f.room);
  f.handle(f.room.players.get('p1').socket,'discussion:skip-vote',{agree:true});
  f.closeSocket(f.room.players.get('p1').socket);
  assert.equal(f.publicRoom(f.room).discussionSkip.eligibleCount,4);
  const joined=f.reconnect('p1').find(m=>m.event==='room:joined');
  assert.deepEqual(joined.data.room.discussionSkip,{votes:['p1'],eligibleCount:4,required:3});
});
test('pause rejects consent but resume retains existing votes; a new discussion resets votes',()=>{
  const f=fixture(Array(3).fill('villager'));f.startDiscussion(f.room);
  f.handle(f.room.players.get('p0').socket,'discussion:skip-vote',{agree:true});
  f.room.players.get('p2').connected=false;
  f.handle(f.room.players.get('p0').socket,'game:pause',{});
  assert.equal(f.room.phase,'paused');
  f.handle(f.room.players.get('p1').socket,'discussion:skip-vote',{agree:true});
  assert.equal(f.publicRoom(f.room).discussionSkip.votes.length,1);
  f.handle(f.room.players.get('p0').socket,'game:resume',{});
  assert.equal(f.publicRoom(f.room).discussionSkip.votes.length,1);
  f.startDiscussion(f.room);
  assert.equal(f.publicRoom(f.room).discussionSkip.votes.length,0);
});
test('mixed human/bot rooms cannot bypass consent through the old host shortcut',()=>{
  const f=fixture(Array(4).fill('villager'));
  f.room.players.get('p3').isBot=true;f.room.hasTestBots=true;f.startDiscussion(f.room);
  const timer=f.room.timer;
  f.handle(f.room.players.get('p0').socket,'game:skip-phase',{phase:'discussion',nightTurn:null});
  assert.equal(f.room.phase,'discussion');assert.equal(f.room.timer,timer);
  assert.equal(f.publicRoom(f.room).discussionSkip.votes.length,1);
  f.handle(f.room.players.get('p1').socket,'discussion:skip-vote',{agree:true});
  assert.equal(f.room.phase,'voting');
});
test('a single human with bots can consent to end discussion',()=>{
  const f=fixture(Array(3).fill('villager'));
  f.room.players.get('p1').isBot=true;f.room.players.get('p2').isBot=true;
  f.startDiscussion(f.room);
  assert.equal(f.publicRoom(f.room).discussionSkip.required,1);
  f.handle(f.room.players.get('p0').socket,'discussion:skip-vote',{agree:true});
  assert.equal(f.room.phase,'voting');
});

for(let n=3;n<=10;n++) test(`PASS baseline: ${n} players receive N+3 unique cards`,()=>{
  const f=fixture(Array(n).fill('villager'));
  f.room.roles=f.defaultRoles(n);f.startGame(f.room);
  assert.equal(f.room.cards.length,n+3);assert.equal(f.room.center.length,3);
  assert.equal(new Set(f.room.cards.map(c=>c.id)).size,n+3);
  for(const id of f.room.players.keys())assert.equal(f.room.cards.filter(c=>c.ownerId===id).length,1);
});

test('recommended deck follows requested additions with zero villagers and paired Masons',()=>{
  const f=fixture(['villager']);
  const expected=['werewolf','seer','robber','troublemaker','drunk','insomniac'];
  for(let n=1;n<=3;n++)assert.deepEqual(Array.from(f.defaultRoles(n)),expected.slice(0,n+3));
  for(const [n,added] of [[4,'tanner'],[5,'werewolf'],[6,'hunter'],[7,'minion'],[8,'doppelganger']]) {
    expected.push(added);assert.deepEqual(Array.from(f.defaultRoles(n)),expected);
  }
  assert.deepEqual(Array.from(f.defaultRoles(9)),[...expected.slice(0,-1),'mason','mason']);
  assert.deepEqual(Array.from(f.defaultRoles(10)),[...expected,'mason','mason']);
  for(let n=1;n<=10;n++) {
    const roles=Array.from(f.defaultRoles(n));
    assert.equal(roles.length,n+3);assert.ok(!roles.includes('villager'));
    assert.ok([0,2].includes(roles.filter(r=>r==='mason').length));
    assert.ok(roles.filter(r=>r==='werewolf').length<=2);
    for(const role of new Set(roles.filter(r=>!['werewolf','mason'].includes(r))))assert.equal(roles.filter(r=>r===role).length,1);
  }
});

test('new room, incremental human joins, AI additions, auto reset and leave use the recommended deck',()=>{
  const f=fixture(['villager']);
  const host={socket:{write(){},end(){}}};f.handle(host,'room:create',{name:'Host'});
  const room=f.rooms.get(host.room);
  assert.deepEqual(Array.from(room.roles),Array.from(f.defaultRoles(1)));
  for(let n=2;n<=5;n++) {
    f.handle({socket:{write(){},end(){}}},'room:join',{code:room.code,name:`Guest ${n}`});
    assert.deepEqual(Array.from(room.roles),Array.from(f.defaultRoles(n)));
  }
  for(let n=6;n<=10;n++) {
    f.handle(host,'room:bots:add',{count:1});
    assert.deepEqual(Array.from(room.roles),Array.from(f.defaultRoles(n)));
  }
  f.handle(host,'roles:set',{roles:['villager']});assert.equal(room.customRoles,true);
  f.handle(host,'roles:auto',{});
  assert.equal(room.customRoles,false);assert.deepEqual(Array.from(room.roles),Array.from(f.defaultRoles(10)));
  const guest=[...room.players.values()].find(p=>p.id!==room.hostId&&!p.isBot);
  f.handle(guest.socket,'room:leave',{});
  assert.deepEqual(Array.from(room.roles),Array.from(f.defaultRoles(9)));
});
test('PASS baseline: seer sees two distinct centers privately and cannot act twice',()=>{
  const f=fixture(['seer','werewolf','villager'],['drunk','tanner','robber']);
  f.action('seer','p0',{centerIndexes:[0,2]});
  assert.deepEqual(results(f,'p0')[0].data.roles,['주정뱅이','강도']);
  assert.equal(results(f,'p1').length,0);
  f.applyNightAction(f.room,'p0',{targetId:'p1'});assert.equal(results(f,'p0').length,1);
});
test('PASS baseline: seer cannot inspect a duplicate center',()=>{
  const f=fixture(['seer','werewolf','villager']);f.action('seer','p0',{centerIndexes:[0,0]});
  assert.equal(results(f,'p0').length,0);assert.equal(f.room.actionPrompt.playerId,'p0');
});
test('PASS baseline: robber swaps and sees new role; original owner still acts',()=>{
  const f=fixture(['robber','troublemaker','werewolf']);
  f.action('robber','p0',{targetId:'p1'});assert.equal(f.roleForPlayer(f.room,'p0'),'troublemaker');
  assert.equal(results(f,'p0')[0].data.currentRole,'troublemaker');
  f.timerExpired(f.room);
  assert.equal(f.room.actionPrompt.playerId,'p1');
});
test('PASS baseline: troublemaker cannot swap self',()=>{
  const f=fixture(['troublemaker','werewolf','villager']);f.action('troublemaker','p0',{targetId:'p0',secondTargetId:'p1'});
  assert.equal(f.roleForPlayer(f.room,'p0'),'troublemaker');assert.equal(results(f,'p0').length,0);
});
test('PASS baseline: drunk swaps without seeing the card and preserves ownership',()=>{
  const f=fixture(['drunk','werewolf','villager'],['tanner','seer','robber']);
  f.action('drunk','p0',{centerIndex:0});assert.equal(f.roleForPlayer(f.room,'p0'),'tanner');
  assert.equal(f.room.center[0].role,'drunk');assert.equal(results(f,'p0')[0].data.currentRole,undefined);
  assert.equal(f.room.cards.filter(c=>c.ownerId==='p0').length,1);
});
test('insomniac learns its exchanged card only after clicking, once and privately',()=>{
  const f=fixture(['insomniac','troublemaker','werewolf']);
  f.action('troublemaker','p1',{targetId:'p0',secondTargetId:'p2'});
  f.timerExpired(f.room);
  assert.ok(f.messages('p0').some(m=>m.event==='night:prompt'));
  assert.equal(results(f,'p0').length,0);
  const deadline=f.room.timerEndsAt;
  f.applyNightAction(f.room,'p2',{});
  assert.equal(results(f,'p2').length,0);
  f.applyNightAction(f.room,'p0',{});
  assert.equal(results(f,'p0')[0].data.currentRole,'werewolf');
  assert.deepEqual(results(f,'p0')[0].data.table.revealed,[{playerId:'p0',role:'werewolf'}]);
  assert.equal(f.room.timerEndsAt,deadline);
  f.applyNightAction(f.room,'p0',{});
  assert.equal(results(f,'p0').length,1);
  assert.equal(f.messages('p1').filter(m=>m.event==='night:result'&&m.data.currentRole).length,0);
});

test('copied insomniac checks only after the original full turn, then discussion begins',()=>{
  const f=fixture(['insomniac','doppelganger','werewolf']);
  f.action('doppelganger','p1',{targetId:'p0'});
  assert.match(results(f,'p1')[0].data.text,/맨 마지막/);
  f.beginAction(f.room,'insomniac');
  assert.ok(f.messages('p0').some(m=>m.event==='night:prompt'));
  assert.ok(!f.messages('p1').some(m=>m.event==='night:prompt'&&m.data.targetRole==='insomniac'));
  f.applyNightAction(f.room,'p1',{});assert.equal(results(f,'p1').length,1);
  assert.ok(!f.reconnect('p1').some(m=>m.event==='night:prompt'));
  const deadline=f.room.timerEndsAt;assert.equal(f.room.timer.ms,5000);
  f.applyNightAction(f.room,'p0',{});assert.equal(results(f,'p0').length,1);
  assert.equal(f.room.activeRole,'insomniac');assert.equal(f.room.timerEndsAt,deadline);
  f.timerExpired(f.room);
  assert.equal(f.room.activeRole,'doppelganger-insomniac');assert.equal(f.room.timer.ms,5000);
  const prompt=f.messages('p1').find(m=>m.event==='night:prompt'&&m.data.targetRole==='insomniac').data;
  assert.equal(prompt.role,'doppelganger-copy');assert.equal(prompt.nightTurn,'doppelganger-insomniac');
  f.applyNightAction(f.room,'p0',{});assert.equal(results(f,'p0').length,1);
  f.applyNightAction(f.room,'p1',{});assert.equal(results(f,'p1').at(-1).data.currentRole,'doppelganger');
  assert.equal(results(f,'p1').at(-1).data.table.nightTurn,'doppelganger-insomniac');
  f.applyNightAction(f.room,'p1',{});assert.equal(results(f,'p1').length,2);
  f.timerExpired(f.room);assert.equal(f.room.phase,'discussion');
});

for(const copied of [false,true])test(`insomniac reconnect and pause restore only its own pending turn (copied=${copied})`,()=>{
  const f=fixture(['insomniac','doppelganger','werewolf']);
  f.action('doppelganger','p1',{targetId:'p0'});
  const id=copied?'p1':'p0',other=copied?'p0':'p1';
  f.beginAction(f.room,'insomniac');if(copied)f.timerExpired(f.room);
  const restored=f.reconnect(id);
  assert.ok(restored.some(m=>m.event==='night:prompt'));
  assert.ok(!restored.some(m=>m.event==='night:result'&&m.data.title==='내 카드 확인'));
  assert.ok(!f.reconnect(other).some(m=>m.event==='night:prompt'));
  f.handle(f.room.players.get('p0').socket,'game:pause',{});
  f.applyNightAction(f.room,id,{});
  assert.ok(!results(f,id).some(m=>m.data.title==='내 카드 확인'));
  f.handle(f.room.players.get('p0').socket,'game:resume',{});
  assert.equal(f.messages(id).filter(m=>m.event==='night:prompt').length,2);
  f.applyNightAction(f.room,id,{});
  assert.equal(results(f,id).filter(m=>m.data.title==='내 카드 확인').length,1);
  assert.ok(!f.reconnect(id).some(m=>m.event==='night:prompt'));
});

test('copied insomniac timeout and late request never grant the unseen final card',()=>{
  const f=fixture(['doppelganger','insomniac','werewolf','troublemaker']);
  f.action('doppelganger','p0',{targetId:'p1'});
  f.action('troublemaker','p3',{targetId:'p0',secondTargetId:'p2'});
  f.beginAction(f.room,'insomniac');f.timerExpired(f.room);
  assert.equal(f.room.activeRole,'doppelganger-insomniac');
  f.timerExpired(f.room);f.applyNightAction(f.room,'p0',{});
  assert.ok(!results(f,'p0').some(m=>m.data.title==='내 카드 확인'));
  assert.ok(f.messages('p0').some(m=>m.event==='night:turn-ended'&&m.data.reason==='timeout'));
  assert.ok(!f.reconnect('p0').some(m=>m.event==='night:prompt'||m.data.title==='내 카드 확인'));
});

test('copied insomniac remains the actor after its card moves and sees its final card',()=>{
  const f=fixture(['doppelganger','insomniac','werewolf','troublemaker']);
  f.action('doppelganger','p0',{targetId:'p1'});
  f.action('troublemaker','p3',{targetId:'p0',secondTargetId:'p2'});
  f.timerExpired(f.room);f.timerExpired(f.room);
  assert.equal(f.room.activeRole,'doppelganger-insomniac');
  assert.deepEqual(Array.from(f.room.actionActors),['p0']);
  f.applyNightAction(f.room,'p2',{});assert.equal(results(f,'p2').length,0);
  f.applyNightAction(f.room,'p0',{});
  assert.equal(results(f,'p0').at(-1).data.currentRole,'werewolf');
  assert.equal(f.roleForPlayer(f.room,'p2'),'insomniac');
});

test('copied insomniac announcement and duration depend only on the selected deck',()=>{
  for(const roles of [
    ['doppelganger','insomniac','werewolf'],
    ['doppelganger','werewolf','villager'],
    ['werewolf','villager','villager']
  ]) {
    const center=roles.includes('insomniac')?['seer','robber','villager']:roles.includes('doppelganger')?['insomniac','robber','villager']:['insomniac','doppelganger','villager'];
    const f=fixture(roles,center);f.beginNight(f.room);
    if(roles[0]==='doppelganger')f.applyNightAction(f.room,'p0',{targetId:'p1'});
    const turns=[];
    for(let i=0;i<16&&f.room.phase==='night';i++) {
      turns.push([f.room.activeRole,f.room.timer.ms]);f.timerExpired(f.room);
    }
    assert.deepEqual(turns.slice(-2),[['insomniac',5000],['doppelganger-insomniac',5000]]);
    assert.equal(f.room.phase,'discussion');
    assert.equal(f.messages('p0').filter(m=>m.event==='night:prompt'&&m.data.nightTurn==='doppelganger-insomniac').length,roles[1]==='insomniac'?1:0);
  }
  for(const roles of [['insomniac','werewolf','villager'],['doppelganger','werewolf','villager']]) {
    const f=fixture(roles);f.beginNight(f.room);
    while(f.room.phase==='night') {assert.notEqual(f.room.activeRole,'doppelganger-insomniac');f.timerExpired(f.room);}
  }
});

test('bot copied insomniac waits for the final turn and checks exactly once',()=>{
  const f=fixture(['doppelganger','insomniac','werewolf']);
  f.action('doppelganger','p0',{targetId:'p1'});f.room.players.get('p0').isBot=true;
  f.beginAction(f.room,'insomniac');assert.equal(results(f,'p0').length,1);
  f.timerExpired(f.room);assert.equal(results(f,'p0').length,2);
  assert.equal(results(f,'p0').at(-1).data.table.nightTurn,'doppelganger-insomniac');
  f.timerExpired(f.room);assert.equal(results(f,'p0').length,2);
});

test('insomniac timeout never grants the unseen card, including on reconnect',()=>{
  const f=fixture(['insomniac','werewolf','villager']);
  f.room.cards.find(c=>c.ownerId==='p0').role='seer';f.beginAction(f.room,'insomniac');
  f.timerExpired(f.room);f.applyNightAction(f.room,'p0',{});
  assert.equal(results(f,'p0').length,0);
  assert.ok(f.messages('p0').some(m=>m.event==='night:turn-ended'&&m.data.reason==='timeout'));
  assert.ok(!f.reconnect('p0').some(m=>m.data.currentRole||m.event==='night:prompt'));
});

test('bot insomniac completes its private check automatically',()=>{
  const f=fixture(['insomniac','werewolf','villager']);f.room.players.get('p0').isBot=true;
  f.beginAction(f.room,'insomniac');
  assert.equal(results(f,'p0')[0].data.currentRole,'insomniac');
  assert.ok(f.room.actionDone.has('insomniac:p0'));
});
test('public night deadlines do not change after early completion or a copied action',()=>{
  const f=fixture(['doppelganger','robber','werewolf']);
  f.beginAction(f.room,'doppelganger');
  const deadline=f.room.timerEndsAt, timer=f.room.timer;
  f.applyNightAction(f.room,'p0',{targetId:'p1'});
  assert.equal(f.room.timerEndsAt,deadline);assert.equal(f.room.timer,timer);
  f.applyNightAction(f.room,'p0',{targetId:'p2'});
  assert.equal(f.room.timerEndsAt,deadline);assert.equal(f.room.activeRole,'doppelganger');
  assert.equal(f.room.actionPrompt,null);
  const count=results(f,'p0').length;
  f.applyNightAction(f.room,'p0',{targetId:'p1'});
  assert.equal(results(f,'p0').length,count);
});
test('resume resends a private prompt to an actor who reconnected while paused',()=>{
  const f=fixture(['seer','werewolf','villager']);
  f.beginAction(f.room,'seer');
  f.handle(f.room.players.get('p0').socket,'game:pause',{});
  const received=f.reconnect('p0');
  assert.ok(!received.some(m=>m.event==='night:prompt'));
  f.handle(f.room.players.get('p0').socket,'game:resume',{});
  assert.ok(received.some(m=>m.event==='night:prompt'&&m.data.targetRole==='seer'));
  assert.ok(!f.messages('p1').some(m=>m.event==='night:prompt'));
});
test('robber sees a doppelganger card without learning its copied role',()=>{
  const f=fixture(['doppelganger','werewolf','robber']);
  f.action('doppelganger','p0',{targetId:'p1'});
  f.action('robber','p2',{targetId:'p0'});
  assert.equal(results(f,'p2')[0].data.currentRole,'doppelganger');
  assert.equal(f.roleForPlayer(f.room,'p2'),'werewolf');
});
test('PASS baseline: masons identify each other privately',()=>{
  const f=fixture(['mason','mason','villager']);f.beginAction(f.room,'mason');
  assert.deepEqual(f.messages('p0').find(m=>m.event==='night:info').data.others,['p1']);
  assert.equal(f.messages('p2').filter(m=>m.event==='night:info').length,0);
});
for(const role of ['werewolf','mason']) {
  for(const count of [1,2])test(`${role} privately grants exactly its waking participants' cards (${count})`,()=>{
    const f=fixture([role,count===2?role:'villager','villager']);
    // An earlier copied robber may have moved a card. Waking companions do not
    // learn that hidden change; they identify the original waking role only.
    f.room.cards.find(c=>c.ownerId==='p0').role='tanner';
    f.beginAction(f.room,role);
    const info=f.messages('p0').find(m=>m.event==='night:info').data;
    assert.deepEqual(info.table.revealed,Array.from({length:count},(_,i)=>({playerId:`p${i}`,role,awakening:true})));
    assert.ok(!JSON.stringify(info.table).includes('tanner'));
    assert.ok(!JSON.stringify(f.publicRoom(f.room)).includes('revealed'));
    assert.equal(f.messages('p2').filter(m=>m.event==='night:info').length,0);
  });
  test(`copied ${role} joins the same private waking-card group`,()=>{
    const f=fixture(['doppelganger',role,role,'villager']);f.room.copyRoles.set('p0',role);
    f.beginAction(f.room,role);
    for(const id of ['p0','p1','p2']){
      const info=f.messages(id).find(m=>m.event==='night:info').data;
      assert.deepEqual(info.table.revealed.map(c=>c.playerId),['p0','p1','p2']);
      assert.ok(info.table.revealed.every(c=>c.role===role&&c.awakening));
    }
    assert.equal(f.messages('p3').filter(m=>m.event==='night:info').length,0);
  });
}
test('PASS baseline: minion knows wolves but wolves do not learn minion',()=>{
  const f=fixture(['minion','werewolf','werewolf']);f.beginAction(f.room,'minion');
  assert.deepEqual(f.messages('p0').find(m=>m.event==='night:info').data.wolves,['p1','p2']);
  assert.equal(f.messages('p1').filter(m=>m.event==='night:info').length,0);
  assert.deepEqual(f.messages('p0').find(m=>m.event==='night:info').data.table.revealed,
    ['p1','p2'].map(playerId=>({playerId,role:'werewolf',awakening:true})));
});
for(const copied of [false,true])test(`minion card grant uses waking wolves and is private (copied=${copied})`,()=>{
  const f=fixture(copied?['doppelganger','minion','werewolf']:['minion','doppelganger','werewolf']);
  if(!copied)f.room.copyRoles.set('p1','werewolf');
  f.room.cards.find(c=>c.ownerId==='p2').role='tanner';
  if(copied)f.action('doppelganger','p0',{targetId:'p1'});else f.beginAction(f.room,'minion');
  const info=f.messages('p0').find(m=>m.event==='night:info').data;
  assert.deepEqual(info.table.revealed.map(c=>c.playerId),copied?['p2']:['p1','p2']);
  assert.ok(info.table.revealed.every(c=>c.role==='werewolf'&&c.awakening));
  assert.equal(info.nightTurn,copied?'doppelganger':'minion');
  assert.ok(!JSON.stringify(f.publicRoom(f.room)).includes('revealed'));
  assert.equal(f.messages('p2').filter(m=>m.event==='night:info').length,0);
});
test('minion does not reveal center wolves when no wolves wake up',()=>{
  const f=fixture(['minion','villager','seer'],['werewolf','werewolf','robber']);
  f.beginAction(f.room,'minion');
  const info=f.messages('p0').find(m=>m.event==='night:info').data;
  assert.deepEqual(info.wolves,[]);assert.deepEqual(info.table.revealed,[]);
});
for(const [name,votes,killed] of [
  ['3 versus 2: runner-up survives',['p1','p0','p0','p0','p1'],['p0']],
  ['3 versus 3 versus 2: only tied leaders die',['p1','p0','p0','p0','p1','p1','p2','p2'],['p0','p1']],
  ['2 versus 2 versus 1: both leaders die',['p1','p0','p0','p1','p2'],['p0','p1']],
  ['all one vote: no deaths',['p1','p2','p0'],[]],
  ['no votes: no deaths',[null,null,null],[]]
])test(`vote deaths: ${name}`,()=>{
  const f=fixture(Array(votes.length).fill('villager'));
  const result=f.vote(votes);
  assert.deepEqual(Array.from(result.killed).sort(),killed);
  for(const player of result.finalRoles){
    assert.equal(player.killed,killed.includes(player.id));
    assert.equal(player.deathReason,killed.includes(player.id)?'vote':null);
  }
});
test('a dead hunter kills its target even below the leading vote count, with a separate cause',()=>{
  const f=fixture(['hunter','villager','villager','villager','villager']);
  const result=f.vote(['p1','p0','p0','p0','p1']);
  assert.equal(result.finalRoles[0].votes,3);assert.equal(result.finalRoles[0].deathReason,'vote');
  assert.equal(result.finalRoles[1].votes,2);assert.equal(result.finalRoles[1].deathReason,'hunter');
  assert.deepEqual(Array.from(result.killed).sort(),['p0','p1']);
});
test('a hunter below the highest vote count survives and does not kill its target',()=>{
  const f=fixture(['villager','hunter','villager','villager','villager','villager']);
  const result=f.vote(['p1','p2','p0','p0','p0','p1']);
  assert.deepEqual(Array.from(result.killed),['p0']);
  assert.equal(result.finalRoles[1].votes,2);
  assert.equal(result.finalRoles[1].deathReason,null);assert.equal(result.finalRoles[2].killed,false);
});

for(const isBot of [false,true])test(`${isBot?'AI':'human'} hunter vote submission automatically kills its target on leading votes`,()=>{
  const f=fixture(['hunter','werewolf','villager']);f.room.players.get('p0').isBot=isBot;
  f.enterVoting(f.room);
  for(const [voter,target] of [['p0','p1'],['p1','p0'],['p2','p0']])f.handle(f.room.players.get(voter).socket,'vote:cast',{targetId:target});
  assert.equal(f.room.phase,'vote_reveal');f.timerExpired(f.room);
  assert.deepEqual(Array.from(f.room.result.killed),['p0','p1']);
  assert.equal(f.room.result.finalRoles[1].deathReason,'hunter');
  assert.equal(f.room.result.villageWin,true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.room.result.hunterActions)),[{hunterId:'p0',targetId:'p1'}]);
  assert.ok(f.messages('p0').some(m=>m.event==='game:result'&&m.data.hunterActions[0].targetId==='p1'));
});

test('hunter tied for most votes kills its one-vote target',()=>{
  const f=fixture(['hunter','villager','werewolf','villager','villager']);
  const result=f.vote(['p2','p0','p1','p0','p1']);
  assert.deepEqual(Array.from(result.killed).sort(),['p0','p1','p2']);
  assert.equal(result.finalRoles[2].votes,1);assert.equal(result.finalRoles[2].deathReason,'hunter');
});

test('hunter with no submitted vote dies without a target and records why',()=>{
  const f=fixture(['hunter','werewolf','villager']);f.enterVoting(f.room);
  for(const id of ['p1','p2'])f.handle(f.room.players.get(id).socket,'vote:cast',{targetId:'p0'});
  f.timerExpired(f.room);f.timerExpired(f.room);
  assert.deepEqual(Array.from(f.room.result.killed),['p0']);
  assert.equal(f.room.result.hunterActions[0].targetId,null);
});

test('all-one-vote hunter survives without triggering an ability',()=>{
  const f=fixture(['hunter','werewolf','villager']);const result=f.vote(['p1','p2','p0']);
  assert.equal(result.killed.length,0);assert.equal(result.hunterActions.length,0);
});

test('swapped hunter ability belongs to the final card holder, not the starting hunter',()=>{
  const f=fixture(['hunter','robber','werewolf']);f.action('robber','p1',{targetId:'p0'});
  const result=f.vote(['p1','p2','p1']);
  assert.equal(result.finalRoles[0].role,'robber');assert.equal(result.finalRoles[1].role,'hunter');
  assert.deepEqual(Array.from(result.killed),['p1','p2']);assert.equal(result.hunterActions[0].hunterId,'p1');
});

test('doppelganger that copied hunter uses its own vote when killed',()=>{
  const f=fixture(['doppelganger','hunter','werewolf']);f.action('doppelganger','p0',{targetId:'p1'});
  const result=f.vote(['p2','p0','p0']);
  assert.deepEqual(Array.from(result.killed),['p0','p2']);assert.equal(result.hunterActions[0].hunterId,'p0');
});

for(const [name,roles,votes,expected] of [
  ['wolf killed',['werewolf','villager','seer'],['p1','p0','p0'],[false,true,true]],
  ['wolf survives',['werewolf','villager','seer'],['p1','p2','p1'],[true,false,false]],
  ['no wolf no death',['villager','seer','robber'],['p1','p2','p0'],[true,true,true]],
  ['no wolf villager killed',['villager','seer','robber'],['p1','p0','p0'],[false,false,false]],
  ['tanner blocks wolf win',['tanner','werewolf','villager'],['p1','p0','p0'],[true,false,false]],
  ['minion survives without wolf',['minion','villager','seer'],['p1','p2','p1'],[true,false,false]],
  ['minion dies without wolf',['minion','villager','seer'],['p1','p0','p0'],[false,false,false]],
  ['hunter kills wolf',['hunter','werewolf','villager'],['p1','p0','p0'],[true,false,true]],
  ['wolf and tanner tie',['werewolf','tanner','villager','seer'],['p1','p0','p1','p0'],[false,true,true,true]]
]) test(`PASS baseline: victory ${name}`,()=>{
  const f=fixture(roles);const result=f.vote(votes);assert.deepEqual(Array.from(result.winners,w=>w.win),expected);
});
test('PASS baseline: nonhost cannot pause; paused votes and actions are rejected',()=>{
  const f=fixture(['robber','werewolf','villager']);f.beginAction(f.room,'robber');
  f.handle(f.room.players.get('p1').socket,'game:pause',{});assert.equal(f.room.phase,'night');
  f.handle(f.room.players.get('p0').socket,'game:pause',{});assert.equal(f.room.phase,'paused');
  f.handle(f.room.players.get('p0').socket,'night:action',{targetId:'p1'});
  f.handle(f.room.players.get('p1').socket,'vote:cast',{targetId:'p0'});
  assert.equal(f.room.votes.size,0);assert.equal(f.roleForPlayer(f.room,'p0'),'robber');
  f.handle(f.room.players.get('p0').socket,'game:resume',{});assert.equal(f.room.phase,'night');
});
test('PASS baseline: votes are secret before result and duplicate votes cannot change target',()=>{
  const f=fixture(['villager','werewolf','seer']);f.enterVoting(f.room);
  f.handle(f.room.players.get('p0').socket,'vote:cast',{targetId:'p1'});
  f.handle(f.room.players.get('p0').socket,'vote:cast',{targetId:'p2'});
  assert.equal(f.room.votes.get('p0'),'p1');assert.equal(f.publicRoom(f.room).result,null);
  assert.equal(f.publicRoom(f.room).votes,undefined);
});
test('BUG-1: reconnect must not reveal a drunk player new secret card',()=>{
  const f=fixture(['drunk','werewolf','villager'],['tanner','seer','robber']);
  f.action('drunk','p0',{centerIndex:0});
  const received=f.reconnect('p0').find(m=>m.event==='role:private');
  assert.equal(received.data.role,'drunk','Must restore last known role, not hidden final card');
});
test('BUG-2: doppelganger who robs a wolf must win as final wolf',()=>{
  const f=fixture(['doppelganger','robber','werewolf']);
  f.action('doppelganger','p0',{targetId:'p1'});
  f.applyNightAction(f.room,'p0',{targetId:'p2'});
  assert.equal(f.roleForPlayer(f.room,'p0'),'werewolf');
  const result=f.vote(['p1','p2','p1']);
  assert.equal(result.wolfTeamWin,true);
  assert.equal(winner(result,'p0'),true,'Final wolf must win with wolf team');
});
test('BUG-3: exchanging doppelganger wolf away must switch original player to village team',()=>{
  const f=fixture(['doppelganger','werewolf','troublemaker','villager']);
  f.action('doppelganger','p0',{targetId:'p1'});
  f.action('troublemaker','p2',{targetId:'p0',secondTargetId:'p3'});
  assert.equal(f.roleForPlayer(f.room,'p0'),'villager');
  const result=f.vote(['p1','p0','p1','p0']);
  assert.equal(result.villageWin,true);
  assert.equal(winner(result,'p0'),true,'Final villager must win with village team');
});
test('BUG-4: copied minion must receive wolf information in doppelganger phase',()=>{
  const f=fixture(['doppelganger','minion','werewolf']);
  f.action('doppelganger','p0',{targetId:'p1'});
  assert.ok(f.messages('p0').some(m=>m.event==='night:info'&&m.data.wolves?.includes('p2')),
    'Copied minion should know wolves before normal werewolf phase');
});

test('copied minion knows its copy target but minions never receive each other as companions',()=>{
  const f=fixture(['doppelganger','minion','werewolf','villager']);
  f.action('doppelganger','p0',{targetId:'p1'});
  assert.deepEqual(results(f,'p0')[0].data.table.revealed,[{playerId:'p1',role:'minion'}]);
  const copyInfo=f.messages('p0').filter(m=>m.event==='night:info');
  assert.equal(copyInfo.length,1);assert.deepEqual(copyInfo[0].data.wolves,['p2']);
  assert.deepEqual(copyInfo[0].data.table.revealed,[{playerId:'p2',role:'werewolf',awakening:true}]);
  for(const id of ['p1','p2','p3'])assert.ok(!f.messages(id).some(m=>['night:info','night:result','night:prompt'].includes(m.event)));
  f.timerExpired(f.room);f.timerExpired(f.room);
  assert.equal(f.room.activeRole,'minion');
  assert.deepEqual(f.messages('p1').find(m=>m.event==='night:info').data.table.revealed,[{playerId:'p2',role:'werewolf',awakening:true}]);
  assert.equal(f.messages('p0').filter(m=>m.event==='night:info').length,1);
  assert.ok(!f.messages('p2').some(m=>m.event==='night:info'&&m.data.role==='minion'));
});
test('BUG-5: observing a doppelganger card must reveal card identity, not hidden copy choice',()=>{
  const f=fixture(['doppelganger','werewolf','seer']);
  f.action('doppelganger','p0',{targetId:'p1'});f.action('seer','p2',{targetId:'p0'});
  assert.match(results(f,'p2')[0].data.text,/도플갱어/);
});
test('BUG-6: reconnect must restore previously granted private seer result',()=>{
  const f=fixture(['seer','werewolf','villager'],['tanner','drunk','robber']);
  f.action('seer','p0',{centerIndexes:[0,1]});
  const restored=f.reconnect('p0');
  assert.ok(restored.some(m=>m.event==='night:result'&&m.data.roles?.includes('무두장이')),
    'Seer knowledge is lost on refresh');
});
test('BUG-7: selected roles in center must not be discoverable from omitted public night turns',()=>{
  const f=fixture(['werewolf','villager','villager'],['seer','robber','troublemaker']);
  f.beginNight(f.room);
  for(let i=0;i<12&&f.room.phase==='night';i++)f.timerExpired(f.room);
  const turns=f.messages('p1').filter(m=>m.event==='game:phase'&&m.data.phase==='night').map(m=>m.data.nightTurn);
  assert.ok(turns.includes('seer'),'Public phase skips seer and proves seer is in center');
});
test('PASS documented MVP variation: copied drunk timeout is treated as no action',()=>{
  const f=fixture(['doppelganger','drunk','werewolf'],['tanner','seer','robber']);
  f.action('doppelganger','p0',{targetId:'p1'});f.timerExpired(f.room);
  assert.equal(f.roleForPlayer(f.room,'p0'),'drunk');
});
test('BUG-9: pausing then resuming must restore the active browser action controls',()=>{
  const clientSource=readFileSync(join(repo,'public/app.js'),'utf8').split('setInterval(()=>')[0];
  const context=vm.createContext({document:{querySelector:()=>null},localStorage:{setItem(){}},setTimeout(){},clearTimeout(){}});
  vm.runInContext(`${clientSource}
    render=()=>{};notify=()=>{};syncPeers=()=>{};syncMediaToPhase=()=>{};
    globalThis.api={state,handleMessage};`,context);
  const {state,handleMessage}=context.api;
  state.room={phase:'night',nightTurn:'seer'};
  state.prompt={role:'seer',targetRole:'seer',players:[]};
  handleMessage('game:paused',{phase:'paused',nightTurn:null});
  handleMessage('game:resumed',{phase:'night',nightTurn:'seer'});
  assert.ok(state.prompt,'Pause discards prompt and resume never sends it again');
});
test('private history is replayed once per reconnect and remains readable during discussion',()=>{
  const f=fixture(['seer','werewolf','villager'],['tanner','drunk','robber']);
  f.action('seer','p0',{centerIndexes:[0,1]});
  const clientSource=readFileSync(join(repo,'public/app.js'),'utf8').split('setInterval(()=>')[0];
  const context=vm.createContext({document:{querySelector:()=>null},localStorage:{setItem(){}},setTimeout(){},clearTimeout(){}});
  vm.runInContext(`${clientSource}
    render=()=>{};notify=()=>{};syncPeers=()=>{};syncMediaToPhase=()=>{};
    globalThis.api={state,handleMessage,privateNotes};`,context);
  const {state,handleMessage,privateNotes}=context.api;
  for(let i=0;i<2;i++){
    const received=f.reconnect('p0');
    for(const m of received)handleMessage(m.event,m.data);
    assert.equal(state.privateResults.length,1);
    assert.match(privateNotes(),/무두장이/);
    assert.match(privateNotes(),/주정뱅이/);
  }
  assert.ok(!JSON.stringify(f.publicRoom(f.room)).includes('knowledge'));
  assert.equal(results(f,'p1').length,0);
});
test('copied minion gets no duplicate information during normal minion phase',()=>{
  const f=fixture(['doppelganger','minion','werewolf']);
  f.action('doppelganger','p0',{targetId:'p1'});
  f.beginAction(f.room,'minion');
  assert.equal(f.messages('p0').filter(m=>m.event==='night:info').length,1);
  assert.equal(f.messages('p1').filter(m=>m.event==='night:info').length,1);
});
test('host can add multiple bot batches up to ten players with distinct names and N+3 cards',()=>{
  const f=fixture(['villager']);f.room.phase='lobby';f.room.roles=f.defaultRoles(1);
  const host=f.room.players.get('p0').socket;
  for(const count of [2,3,4])f.handle(host,'room:bots:add',{count});
  assert.equal(f.room.players.size,10);assert.equal(f.room.roles.length,13);
  assert.equal(new Set([...f.room.players.values()].map(p=>p.name)).size,10);
  const cards=JSON.stringify(f.room.roles);
  f.handle(host,'room:bots:add',{count:1});
  assert.equal(f.room.players.size,10);assert.equal(JSON.stringify(f.room.roles),cards);
});
test('bot addition rejects invalid counts, nonhosts and started games without partial changes',()=>{
  const f=fixture(['villager','villager','villager']);f.room.phase='lobby';
  const host=f.room.players.get('p0').socket;
  for(const count of [0,-1,1.5,'2',8])f.handle(host,'room:bots:add',{count});
  f.handle(f.room.players.get('p1').socket,'room:bots:add',{count:1});
  assert.equal(f.room.players.size,3);
  f.room.phase='night';f.handle(host,'room:bots:add',{count:1});
  assert.equal(f.room.players.size,3);
});
test('night skip completes bot copied actions and arrives at discussion in one request',()=>{
  const f=fixture(['robber','doppelganger','werewolf'],['seer','drunk','troublemaker']);
  f.room.hasTestBots=true;f.room.players.get('p1').isBot=true;
  vm.runInContext('Math.random = () => 0;',f.context);
  f.beginNight(f.room);
  const original=f.room.cards.find(c=>c.ownerId==='p1');
  const request={phase:'night',nightTurn:'doppelganger'};
  f.handle(f.room.players.get('p0').socket,'game:skip-phase',request);
  assert.equal(f.room.phase,'discussion');
  assert.equal(f.room.copyRoles.get('p1'),'robber');
  assert.equal(results(f,'p1').length,2);
  assert.equal(original.ownerId,'p0');
  f.handle(f.room.players.get('p0').socket,'game:skip-phase',request);
  assert.equal(f.room.phase,'discussion','Repeated stale click must not skip discussion too');
});
test('voting skip preserves human votes, completes bot votes and leaves only humans unvoted',()=>{
  const f=fixture(['villager','werewolf','seer','robber']);
  f.room.hasTestBots=true;f.room.players.get('p1').isBot=true;f.room.players.get('p2').isBot=true;
  f.enterVoting(f.room);f.room.votes.set('p0','p1');
  f.handle(f.room.players.get('p0').socket,'game:skip-phase',{phase:'voting',nightTurn:null});
  assert.equal(f.room.phase,'result');assert.equal(f.room.votes.get('p0'),'p1');
  for(const id of ['p1','p2'])assert.ok(f.room.votes.get(id)&&f.room.votes.get(id)!==id);
  assert.equal(f.room.votes.get('p3'),null);
});
test('skip is unavailable without bots, to nonhosts, and during pause',()=>{
  const f=fixture(['villager','werewolf','seer']);f.beginNight(f.room);
  f.handle(f.room.players.get('p0').socket,'game:skip-phase',{});
  assert.equal(f.room.phase,'night');
  f.room.hasTestBots=true;
  f.handle(f.room.players.get('p1').socket,'game:skip-phase',{});
  assert.equal(f.room.phase,'night');
  f.handle(f.room.players.get('p0').socket,'game:pause',{});
  f.handle(f.room.players.get('p0').socket,'game:skip-phase',{});
  assert.equal(f.room.phase,'paused');
});

for(const [role,input,expected] of [
  ['seer',{targetId:'p1'},{revealed:[{playerId:'p1',role:'hunter'}]}],
  ['seer',{centerIndexes:[2,0]},{revealed:[{centerIndex:2,role:'tanner'},{centerIndex:0,role:'werewolf'}]}],
  ['robber',{targetId:'p1'},{revealed:[{playerId:'p0',role:'hunter'}],swapped:[{playerId:'p0'},{playerId:'p1'}]}],
  ['troublemaker',{targetId:'p1',secondTargetId:'p2'},{swapped:[{playerId:'p1'},{playerId:'p2'}]}],
  ['drunk',{centerIndex:0},{swapped:[{playerId:'p0'},{centerIndex:0}]}],
  ['doppelganger',{targetId:'p1'},{revealed:[{playerId:'p1',role:'hunter'}]}]
])test('private table feedback respects '+role+' visibility: '+JSON.stringify(input),()=>{
  const f=fixture([role,'hunter','villager'],['werewolf','seer','tanner']);
  f.action(role,'p0',input);
  assert.deepEqual(results(f,'p0').at(-1).data.table,expected);
  for(const id of ['p1','p2'])assert.ok(f.messages(id).every(m=>!m.data.table));
  assert.ok(!JSON.stringify(f.publicRoom(f.room)).includes('revealed'));
  const replay=f.reconnect('p0').find(m=>m.event==='night:result');
  assert.deepEqual(replay.data.table,expected);assert.equal(replay.data.replay,true);
});
