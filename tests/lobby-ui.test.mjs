import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').split('setInterval(()=>')[0];
function fixture() {
  const sockets=[],timers=[],storage=new Map([['one-night-session','{"code":"OLD","token":"secret"}']]);
  class Socket {
    static OPEN=1;static CLOSED=3;
    constructor(){this.readyState=1;this.handlers={};this.sent=[];sockets.push(this);}
    addEventListener(event,callback){this.handlers[event]=callback;}
    send(data){this.sent.push(JSON.parse(data));}
    close(){this.readyState=3;this.handlers.close?.();}
  }
  const button={};
  const context=vm.createContext({
    document:{querySelector:selector=>selector==='#leave-lobby'?button:null},
    localStorage:{getItem:key=>storage.get(key)||null,removeItem:key=>storage.delete(key)},
    location:{protocol:'http:',host:'localhost'},WebSocket:Socket,
    setTimeout:callback=>{timers.push(callback);return callback;},
    clearTimeout:timer=>{const index=timers.indexOf(timer);if(index>=0)timers.splice(index,1);},
    MediaStream:class {constructor(tracks){this.tracks=tracks;}}
  });
  vm.runInContext(`${source}
    render=()=>{};notify=()=>{};
    globalThis.api={state,connect,leaveLobby:leaveRoom,restartGame,resultActions,handleMessage};`,context);
  const api=context.api;
  api.connect();api.state.room={code:'OLD',phase:'lobby'};
  api.state.playerId='p0';api.state.sessionToken='secret';
  return {...api,sockets,timers,storage,button};
}
test('leave waits for acknowledgement then clears session, media, and room state',()=>{
  const f=fixture();let stopped=0,closed=0;
  f.state.audioStream={getAudioTracks:()=>[],getTracks:()=>[{stop(){stopped++;}}]};
  f.state.peers.set('other',{close(){closed++;}});
  f.state.remoteStreams.set('other',{});f.state.privateRole='seer';f.state.chat=[{}];
  f.leaveLobby();f.leaveLobby();
  assert.equal(f.sockets[0].sent.length,1);assert.equal(f.sockets[0].sent[0].event,'room:leave');
  assert.equal(f.button.disabled,true);assert.ok(f.state.room);
  f.handleMessage('room:left',{});
  assert.equal(f.storage.size,0);assert.equal(f.state.room,null);assert.equal(f.state.ws,null);
  assert.equal(f.state.sessionToken,null);assert.equal(f.state.privateRole,null);
  assert.equal(f.state.peers.size,0);assert.equal(f.state.remoteStreams.size,0);
  assert.equal(f.state.chat.length,0);assert.equal(stopped,1);assert.equal(closed,1);
  assert.equal(f.timers.length,0);
  f.connect();assert.equal(f.sockets.length,2);
});
test('disconnected leave returns home and stale reconnect timers or messages cannot restore the room',()=>{
  const f=fixture(),old=f.sockets[0];
  old.close();assert.equal(f.timers.length,1);
  f.leaveLobby();assert.equal(f.state.room,null);assert.equal(f.storage.size,0);
  f.connect();const current=f.state.ws;
  f.timers[0]();
  old.handlers.message({data:JSON.stringify({event:'room:state',data:{code:'OLD'}})});
  old.handlers.close();
  assert.equal(f.sockets.length,2);assert.equal(f.state.ws,current);assert.equal(f.state.room,null);
});
test('connection loss while leaving returns home without automatically rejoining',()=>{
  const f=fixture();f.leaveLobby();f.sockets[0].close();
  assert.equal(f.state.room,null);assert.equal(f.storage.size,0);assert.equal(f.timers.length,0);
});
test('result exit uses server acknowledgement and cannot leave while a round is active',()=>{
  const f=fixture();f.state.room.phase='night';f.leaveLobby();assert.equal(f.sockets[0].sent.length,0);
  f.state.room.phase='result';f.leaveLobby();assert.equal(f.sockets[0].sent[0].event,'room:leave');
  f.handleMessage('room:left',{});assert.equal(f.state.room,null);assert.equal(f.storage.size,0);
});
test('silent restart response releases loading after timeout and permits retry',()=>{
  const f=fixture();f.state.room={phase:'result',hostId:'p0'};
  f.restartGame();f.restartGame();assert.equal(f.sockets[0].sent.length,1);
  assert.match(f.resultActions(),/id="restart-game" disabled/);
  assert.doesNotMatch(f.resultActions(),/id="leave-room" disabled/);
  f.timers.shift()();
  assert.doesNotMatch(f.resultActions(),/id="restart-game" disabled/);
  f.restartGame();assert.equal(f.sockets[0].sent.length,2);
});
test('main exit can interrupt a pending restart and no reply still returns home',()=>{
  const f=fixture();f.state.room={phase:'result',hostId:'p0'};
  f.restartGame();f.leaveLobby();
  assert.deepEqual(f.sockets[0].sent.map(m=>m.event),['game:restart','room:leave']);
  assert.equal(f.timers.length,1);
  f.timers.shift()();assert.equal(f.state.room,null);assert.equal(f.storage.size,0);
  assert.equal(f.state.ws,null);assert.equal(f.timers.length,0);
});
test('server rejecting a stale membership still permits local exit and clears its timeout',()=>{
  const f=fixture();f.state.room.phase='result';
  f.leaveLobby();f.handleMessage('error',{message:'먼저 방에 입장해 주세요.'});
  assert.equal(f.state.room,null);assert.equal(f.storage.size,0);assert.equal(f.timers.length,0);
});
