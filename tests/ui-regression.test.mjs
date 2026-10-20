import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').split('setInterval(()=>')[0];
function ui(document={querySelector:()=>null}) {
  const context=vm.createContext({document,setTimeout(){},clearTimeout(){},WebSocket:{OPEN:1}});
  vm.runInContext(`${source}\nglobalThis.api={state,handleMessage,resultPanel,resultSummary,bindGameEvents,bindChatEvents,chatPanel,nightPanel,submitNight,render};`,context);
  return {...context.api,context};
}
function result(roles,wins,killed=[]) {
  return {finalRoles:roles.map((role,i)=>({id:`p${i}`,name:`P${i}`,role,startRole:role,votes:killed.includes(`p${i}`)?2:0,killed:killed.includes(`p${i}`)})),
    winners:wins.map((win,i)=>({id:`p${i}`,win})),killed,center:['늑대인간','늑대인간','주민'],
    villageWin:false,wolfTeamWin:false,minionWin:false};
}
test('copied ability stays available after a failed send or server rejection and can be retried',()=>{
  const f=ui();const sent=[];
  vm.runInContext('render=()=>{};notify=()=>{};send=()=>false;',f.context);
  f.state.room={phase:'night',nightTurn:'doppelganger'};
  const prompt={role:'doppelganger-copy',targetRole:'robber',players:[{id:'p1',name:'대상'}]};
  f.state.prompt=prompt;f.state.selectedTarget='p1';
  f.submitNight();assert.equal(f.state.prompt,prompt);
  assert.doesNotMatch(f.nightPanel(),/id="submit-night" disabled/);
  f.context.record=data=>sent.push(data);
  vm.runInContext('send=(event,data)=>{record(data);return true;};',f.context);
  f.submitNight();f.submitNight();assert.equal(sent.length,1);
  f.handleMessage('error',{message:'다시 선택해 주세요.'});
  assert.equal(f.state.prompt,prompt);f.submitNight();assert.equal(sent.length,2);
  f.handleMessage('night:result',{title:'역할 교환',currentRole:'werewolf'});
  assert.equal(f.state.prompt,null);assert.equal(f.state.privateRole,'werewolf');
});
test('copy result followed by a new action displays the copied controls above role cards and results',()=>{
  const f=ui();
  vm.runInContext('render=()=>{};notify=()=>{};',f.context);
  f.state.room={phase:'night',nightTurn:'doppelganger'};
  f.handleMessage('night:result',{title:'복사한 역할',currentRole:'seer'});
  f.handleMessage('night:prompt',{role:'doppelganger-copy',targetRole:'seer',players:[]});
  const html=f.nightPanel();
  assert.match(html,/예언자 능력을 지금 사용하세요/);
  assert.ok(html.indexOf('id="submit-night"')<html.indexOf('class="night-result"'));
  assert.ok(html.indexOf('id="submit-night"')<html.indexOf('id="role-card"'));
  assert.doesNotMatch(html,/id="submit-night" disabled/);
});
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
test('result distinguishes surviving losers from vote and hunter deaths',()=>{
  const f=ui(),data=result(['villager','hunter','seer'],[false,false,false],['p1','p2']);
  data.finalRoles[1].deathReason='vote';data.finalRoles[2].deathReason='hunter';
  f.state.room={phase:'result',result:data};f.state.resultSplashComplete=true;
  const html=f.resultPanel();
  assert.ok(html.includes('생존</span>'));
  assert.ok(html.includes('최다 득표로 사망'));
  assert.ok(html.includes('사냥꾼의 지목으로 사망'));
  assert.equal((html.match(/class="lose-label">패배/g)||[]).length,3);
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

test('chat resizing updates layout without rerendering, losing drafts, or moving a history reader',()=>{
  let resize;const styles=[];
  const slider={addEventListener(event,callback){resize=callback;}};
  const box={scrollHeight:1600,scrollTop:240,clientHeight:200};
  const input={value:'작성 중입니다',selectionStart:3};
  const panel={style:{setProperty:(key,value)=>styles.push([key,value])}};
  const nodes={'#chat-height':slider,'#chat-box':box,'#chat-input':input,'.chat-panel':panel,'.discussion-dock':panel};
  const f=ui({querySelector:selector=>nodes[selector]||null});
  vm.runInContext('render=()=>{throw new Error("Resize must not rerender");};',f.context);
  f.state.room={phase:'lobby',chat:[]};
  f.bindChatEvents();resize({target:{value:'520'}});
  assert.deepEqual(styles,[['--chat-height','520px'],['--chat-height','520px']]);
  assert.equal(box.scrollTop,240);assert.equal(input.value,'작성 중입니다');assert.equal(input.selectionStart,3);
  assert.ok(f.chatPanel().includes('value="520"'));
  assert.ok(!f.chatPanel().includes('private-notes'));
  f.state.room.phase='discussion';
  assert.ok(f.chatPanel().includes('value="520"'));
  assert.ok(f.chatPanel().includes('private-notes'));
});
test('room rerenders preserve history position and draft selection',()=>{
  const oldBox={scrollTop:120,scrollHeight:1800,clientHeight:200};
  const newBox={scrollTop:1600,scrollHeight:1800,clientHeight:200};
  const oldInput={value:'작성 중',selectionStart:1,selectionEnd:2};
  const newInput={focus(){},setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}};
  const nodes={'#chat-box':oldBox,'#chat-input':oldInput};
  const f=ui({querySelector:selector=>nodes[selector]||null,activeElement:{id:'chat-input'}});
  f.context.swap=()=>{nodes['#chat-box']=newBox;nodes['#chat-input']=newInput;};
  vm.runInContext('gameView=()=>swap();',f.context);f.state.room={phase:'lobby'};
  f.render();
  assert.equal(newBox.scrollTop,120);assert.equal(newInput.value,'작성 중');
  assert.equal(newInput.selectionStart,1);assert.equal(newInput.selectionEnd,2);
});

test('discussion consent updates only its controls, leaving chat and video mounted',()=>{
  const button={disabled:true,setAttribute(key,value){this[key]=value;}},count={};
  const input={value:'아직 설명 중입니다.'};
  const nodes={'#discussion-skip-vote':button,'#discussion-skip-count':count,'#chat-input':input};
  const f=ui({querySelector:selector=>nodes[selector]||null});
  vm.runInContext('render=()=>{throw new Error("Full render during consent update");};',f.context);
  f.state.playerId='p0';f.state.room={phase:'discussion'};
  f.handleMessage('discussion:skip-state',{votes:['p0'],eligibleCount:4,required:3});
  assert.equal(button.textContent,'토론 종료 동의 취소');
  assert.equal(button['aria-pressed'],'true');assert.equal(button.disabled,false);
  assert.equal(count.textContent,'동의 1/4명 · 3명 필요');
  assert.equal(input.value,'아직 설명 중입니다.');
});
