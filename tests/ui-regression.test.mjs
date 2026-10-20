import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').split('setInterval(()=>')[0];
function ui(document={querySelector:()=>null}) {
  const context=vm.createContext({document,setTimeout(){},clearTimeout(){},WebSocket:{OPEN:1}});
  vm.runInContext(`${source}\nglobalThis.api={state,handleMessage,resultPanel,resultSummary,bindGameEvents,render};`,context);
  return {...context.api,context};
}
function result(roles,wins,killed=[]) {
  return {finalRoles:roles.map((role,i)=>({id:`p${i}`,name:`P${i}`,role,startRole:role,votes:killed.includes(`p${i}`)?2:0,killed:killed.includes(`p${i}`)})),
    winners:wins.map((win,i)=>({id:`p${i}`,win})),killed,center:['늑대인간','늑대인간','주민'],
    villageWin:false,wolfTeamWin:false,minionWin:false};
}
for(const [name,data,expected] of [
  ['all wolves in center and villager killed',result(['villager','seer','robber'],[false,false,false],['p0']),'승리한 사람이 없습니다'],
  ['no wolves and no death',{...result(['villager','seer','robber'],[true,true,true]),villageWin:true},'마을 팀 승리!'],
  ['wolf victory',{...result(['werewolf','minion','seer'],[true,true,false],['p2']),wolfTeamWin:true},'늑대인간 팀 승리!'],
  ['tanner and minion victory',{...result(['tanner','minion','seer'],[true,true,false],['p0']),minionWin:true},'하수인 · 무두장이 승리!'],
  ['village and tanner victory',{...result(['tanner','werewolf','seer'],[true,false,true],['p0','p1']),villageWin:true},'마을 팀 · 무두장이 승리!']
])test(`splash and result agree: ${name}`,()=>{
  const f=ui();f.state.room={phase:'result',result:data};
  f.state.resultSplashComplete=false;assert.ok(f.resultPanel().includes(`<h2>${expected}</h2>`));
  f.state.resultSplashComplete=true;assert.ok(f.resultPanel().includes(`<h2 class="section-title">${expected}</h2>`));
});
test('incoming chat appends only a message; input, video, selection and private notes are untouched',()=>{
  const rows=[];
  const input={value:'작성 중인 한글',selectionStart:4,selectionEnd:4};
  const video={srcObject:{id:'stream'}}, notes={open:true};
  const box={scrollHeight:100,scrollTop:90,clientHeight:20,append(row){rows.push(row);},querySelectorAll(){return rows;}};
  const nodes={'#chat-box':box,'#chat-input':input,'#private-notes':notes,'#video-p0':video};
  const f=ui({querySelector:selector=>nodes[selector]||null,
    createElement:tag=>({tag,children:[],append(...children){this.children.push(...children);}}),
    createTextNode:text=>({text})});
  vm.runInContext('render=()=>{throw new Error("Full render during chat");};',f.context);
  f.state.room={phase:'discussion'};f.state.playerId='p0';
  f.handleMessage('chat:message',{id:'m1',playerId:'p1',name:'<other>',text:'<script>alert(1)</script>'});
  assert.equal(rows.length,1);assert.equal(rows[0].children[0].textContent,'<other>');
  assert.equal(rows[0].children[1].text,'<script>alert(1)</script>');
  assert.equal(input.value,'작성 중인 한글');assert.equal(input.selectionStart,4);
  assert.equal(video.srcObject.id,'stream');assert.equal(notes.open,true);
});
test('failed chat send preserves the unsent draft',()=>{
  let submit;
  const input={value:'재전송할 내용',focus(){}};
  const form={addEventListener(event,callback){submit=callback;}};
  const f=ui({querySelector:selector=>selector==='#chat-form'?form:selector==='#chat-input'?input:null,querySelectorAll:()=>[]});
  vm.runInContext('send=()=>false;',f.context);f.state.room={phase:'discussion'};
  f.bindGameEvents();submit({preventDefault(){}});
  assert.equal(input.value,'재전송할 내용');
});
