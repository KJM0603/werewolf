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
    roleForPlayer,timerExpired,publicRoom,startGame,defaultRoles,enterVoting};`, context);
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
  return {...api,room,messages,action,vote,reconnect};
}
const winner=(result,id)=>result.winners.find(p=>p.id===id).win;
const results=(f,id)=>f.messages(id).filter(m=>m.event==='night:result');

for(let n=3;n<=10;n++) test(`PASS baseline: ${n} players receive N+3 unique cards`,()=>{
  const f=fixture(Array(n).fill('villager'));
  f.room.roles=f.defaultRoles(n);f.startGame(f.room);
  assert.equal(f.room.cards.length,n+3);assert.equal(f.room.center.length,3);
  assert.equal(new Set(f.room.cards.map(c=>c.id)).size,n+3);
  for(const id of f.room.players.keys())assert.equal(f.room.cards.filter(c=>c.ownerId===id).length,1);
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
test('PASS baseline: insomniac sees current card',()=>{
  const f=fixture(['insomniac','troublemaker','werewolf']);
  f.action('troublemaker','p1',{targetId:'p0',secondTargetId:'p2'});
  f.timerExpired(f.room);
  assert.equal(f.messages('p0').find(m=>m.event==='night:info').data.currentRole,'werewolf');
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
test('PASS baseline: minion knows wolves but wolves do not learn minion',()=>{
  const f=fixture(['minion','werewolf','werewolf']);f.beginAction(f.room,'minion');
  assert.deepEqual(f.messages('p0').find(m=>m.event==='night:info').data.wolves,['p1','p2']);
  assert.equal(f.messages('p1').filter(m=>m.event==='night:info').length,0);
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
