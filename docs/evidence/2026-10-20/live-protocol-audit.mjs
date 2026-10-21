// Start the unchanged server first. node outputs/live-protocol-audit.mjs
import assert from 'node:assert/strict';
const url=process.env.WEREWOLF_URL||'ws://localhost:4184/signal';
const clients=[];
const trace=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,label,timeout=90000){
  const end=Date.now()+timeout;
  while(Date.now()<end){if(predicate())return;await delay(20);}
  throw new Error(`Timeout: ${label}`);
}
async function client(name){
  const ws=new WebSocket(url);
  const c={ws,name,messages:[],send(event,data={}){ws.send(JSON.stringify({event,data}));}};
  ws.addEventListener('message',event=>{
    const m=JSON.parse(event.data);c.messages.push(m);
    if(m.event==='room:joined'){c.join=m.data;c.room=m.data.room;}
    if(['room:state','game:phase','game:paused','game:resumed'].includes(m.event))c.room=m.data;
    if(m.event==='game:phase')trace.push({name,event:m.event,phase:m.data.phase,nightTurn:m.data.nightTurn});
    if(m.event==='game:result')c.result=m.data;
    if(m.event==='night:prompt'){
      const p=m.data,r=p.targetRole||p.role,others=p.players;
      const data=r==='seer'?{centerIndexes:[0,1]}:
        ['drunk','werewolf'].includes(r)?{centerIndex:0}:
        r==='troublemaker'?{targetId:others[0].id,secondTargetId:others[1].id}:{targetId:others[0].id};
      c.send('night:action',data);
    }
  });
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  clients.push(c);return c;
}
try{
  const host=await client('host');host.send('room:create',{name:'protocol-host'});
  await until(()=>host.join,'create');
  host.send('room:bots:add');
  await until(()=>host.room.players.length===4,'bots');
  for(let i=1;i<=3;i++){
    const c=await client(`peer${i}`);c.send('room:join',{name:`protocol-peer${i}`,code:host.room.code});
    await until(()=>c.join,`join ${i}`);c.send('player:ready',{ready:true});
  }
  await until(()=>host.room.players.length===7&&host.room.players.every(p=>p.ready||p.id===host.join.playerId),'ready');
  host.send('game:start');
  await until(()=>host.room.phase==='discussion','night to discussion');
  assert.ok(clients.every(c=>c.messages.filter(m=>m.event==='role:private').length===1));
  console.log('PASS: seven-player room, N+3 setup, private roles, automatic night actions, discussion');
  const peer=clients[1];
  peer.send('chat:send',{text:'protocol-chat-check'});
  await until(()=>clients.every(c=>c.messages.some(m=>m.event==='chat:message'&&m.data.text==='protocol-chat-check')),'chat');
  console.log('PASS: chat broadcast reaches all four network clients');
  const before=host.room.timerEndsAt;peer.send('discussion:extend');
  await until(()=>host.room.timerEndsAt>before+59000,'extension');
  peer.send('discussion:extend');
  await until(()=>peer.messages.some(m=>m.event==='error'&&m.data.message.includes('연장권')),'duplicate extension rejection');
  console.log('PASS: one extension per player');
  const dropped=clients[3], saved=dropped.join;
  dropped.ws.close();
  await until(()=>host.room.pauseAvailable,'disconnect status');
  assert.equal(host.room.phase,'discussion');
  host.send('game:pause');await until(()=>host.room.phase==='paused','pause');
  assert.equal(host.room.timerEndsAt,null);
  const replacement=await client('reconnected');
  replacement.send('room:reconnect',{code:saved.room.code,token:saved.token});
  await until(()=>replacement.join,'rejoin');
  assert.equal(replacement.join.playerId,saved.playerId);
  host.send('game:resume');await until(()=>host.room.phase==='discussion','resume');
  console.log('PASS: disconnect does not auto-pause; host pause/reconnect/resume preserves player identity');
  host.send('game:skip-phase');await until(()=>host.room.phase==='voting','voting');
  const humans=clients.filter(c=>c!==dropped);
  for(const c of humans){
    const target=host.room.players.find(p=>p.id!==c.join.playerId);
    c.send('vote:cast',{targetId:target.id});
  }
  await until(()=>host.result,'result',15000);
  await until(()=>humans.every(c=>c.result),'result broadcast');
  assert.equal(host.result.finalRoles.length,7);
  assert.ok(humans.every(c=>JSON.stringify(c.result)===JSON.stringify(host.result)));
  console.log('PASS: all votes resolve; identical seven-player result on every connected client');
  console.log(JSON.stringify({players:7,networkClients:4,bots:3,discussionSkippedUsingBuiltInTestControl:true,
    finalRoles:host.result.finalRoles.map(p=>({name:p.name,startRole:p.startRole,role:p.role,killed:p.killed})),
    phases:[...new Set(trace.map(t=>t.phase))]},null,2));
} finally{
  for(const c of clients)c.ws.close();
}
