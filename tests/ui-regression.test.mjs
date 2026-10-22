import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').split('setInterval(()=>')[0];
function ui(document={querySelector:()=>null}) {
  const context=vm.createContext({document,setTimeout(){},clearTimeout(){},WebSocket:{OPEN:1}});
  vm.runInContext(`${source}\nglobalThis.api={state,handleMessage,resultPanel,resultSummary,roleCard,bindGameEvents,bindChatEvents,chatPanel,nightPanel,nightTable,selectNightCard,nightSelectionReady,submitNight,render,toggleMobileDiscussion,syncDiscussionViewport,updateMobileDiscussionControls};`,context);
  return {...context.api,context};
}
function result(roles,wins,killed=[]) {
  return {finalRoles:roles.map((role,i)=>({id:`p${i}`,name:`P${i}`,role,startRole:role,votes:killed.includes(`p${i}`)?2:0,killed:killed.includes(`p${i}`)})),
    winners:wins.map((win,i)=>({id:`p${i}`,win})),killed,center:['늑대인간','늑대인간','주민'],
    villageWin:false,wolfTeamWin:false,minionWin:false};
}

test('result splash and details offer restart for host and exit for every player',()=>{
  const f=ui();f.state.playerId='p0';f.state.room={phase:'result',hostId:'p0',result:result(['villager'],[true])};
  for(const complete of [false,true]){
    f.state.resultSplashComplete=complete;
    assert.match(f.resultPanel(),/id="restart-game"/);assert.match(f.resultPanel(),/id="leave-room"/);
    f.state.room.hostId='p1';assert.doesNotMatch(f.resultPanel(),/id="restart-game"/);
    assert.match(f.resultPanel(),/방장이 다시 하기를/);f.state.room.hostId='p0';
  }
});
test('result buttons bind exit and restart, prevent duplicate requests and allow retry on errors',()=>{
  const handlers={},sent=[];
  const f=ui({querySelector:id=>['#home-button','#leave-room','#restart-game'].includes(id)?{addEventListener:(_,fn)=>handlers[id]=fn}:null,querySelectorAll:()=>[]});
  vm.runInContext('render=()=>{};notify=()=>{};',f.context);
  f.state.playerId='p0';f.state.room={phase:'result',hostId:'p0',players:[]};
  f.state.ws={readyState:1,send:raw=>sent.push(JSON.parse(raw))};f.bindGameEvents();
  handlers['#restart-game']();handlers['#restart-game']();assert.equal(sent.length,1);assert.equal(sent[0].event,'game:restart');
  f.handleMessage('error',{});handlers['#restart-game']();assert.equal(sent.length,2);
  f.handleMessage('error',{});handlers['#home-button']();handlers['#leave-room']();
  assert.equal(sent.length,3);assert.equal(sent[2].event,'room:leave');
});
test('returning to the same lobby clears private round data and invalidates old result splash callback',()=>{
  const f=ui();vm.runInContext('render=()=>{};notify=()=>{};syncPeers=()=>{};syncMediaToPhase=()=>{};saveSession=()=>{};',f.context);
  Object.assign(f.state,{room:{phase:'result'},privateRole:'seer',privateResults:[{text:'old secret'}],selectedTarget:'p1',selectedCenter:[0],resultSplashComplete:false,resultSplashId:4});
  f.handleMessage('room:state',{code:'SAME',phase:'lobby',hostId:'p0'});
  assert.equal(f.state.privateRole,null);assert.equal(f.state.privateResults.length,0);assert.equal(f.state.selectedTarget,null);
  assert.equal(f.state.selectedCenter.length,0);assert.equal(f.state.resultSplashComplete,true);assert.equal(f.state.resultSplashId,5);
});

test('round reset synchronizes displayed chat with server and reconnect never restores previous messages',()=>{
  const f=ui();vm.runInContext('render=()=>{};notify=()=>{};syncPeers=()=>{};syncMediaToPhase=()=>{};saveSession=()=>{};',f.context);
  Object.assign(f.state,{room:{code:'SAME',phase:'result'},chat:[{text:'지난 판의 대화'}]});
  for(const [event,data] of [
    ['room:state',{code:'SAME',phase:'lobby',chat:[]}],
    ['game:phase',{code:'SAME',phase:'role_reveal',chat:[]}]
  ]){
    f.handleMessage(event,data);assert.equal(f.state.chat.length,0);assert.doesNotMatch(f.chatPanel(),/지난 판|대기실 대화/);
    f.handleMessage('chat:message',{id:'new',playerId:'p1',text:'대기실 대화'});
  }
  f.handleMessage('room:joined',{room:{code:'SAME',phase:'discussion',chat:[{id:'current',text:'이번 판 대화'}]},playerId:'p0'});
  assert.equal(f.state.chat.length,1);assert.match(f.chatPanel(),/이번 판 대화/);assert.doesNotMatch(f.chatPanel(),/지난 판|대기실 대화/);
});

test('failed human vote send retains hunter target and never reports success',()=>{
  let submit;const notices=[],sent=[];
  const f=ui({querySelector:id=>id==='#submit-vote'?{addEventListener:(_,fn)=>submit=fn}:null,querySelectorAll:()=>[]});
  f.context.recordNotice=text=>notices.push(text);f.context.recordSend=data=>sent.push(data);
  vm.runInContext('render=()=>{};notify=recordNotice;send=()=>false;',f.context);
  f.state.room={phase:'voting'};f.state.privateRole='hunter';f.state.selectedTarget='p1';f.bindGameEvents();
  submit();assert.equal(f.state.selectedTarget,'p1');assert.equal(notices.length,0);
  vm.runInContext('send=(event,data)=>{recordSend({event,data});return true;};',f.context);
  submit();assert.equal(sent[0].event,'vote:cast');assert.equal(sent[0].data.targetId,'p1');
  assert.equal(f.state.selectedTarget,null);assert.match(notices[0],/전송/);
});

test('hunter role guide is private and result shows automatic target or missing vote',()=>{
  const f=ui();f.state.privateRole='hunter';f.state.privateVisible=true;
  assert.match(f.roleCard(),/투표한 대상도 자동으로 사망/);
  f.state.privateVisible=false;assert.doesNotMatch(f.roleCard(),/사냥꾼|투표한 대상/);
  const data=result(['hunter','werewolf','villager'],[true,false,true],['p0','p1']);
  data.finalRoles[1].name='<늑대>';data.hunterActions=[{hunterId:'p0',targetId:'p1'}];
  f.state.room={phase:'result',result:data};f.state.resultSplashComplete=true;
  assert.match(f.resultPanel(),/&lt;늑대&gt;님에게 자동 발동/);
  data.hunterActions[0].targetId=null;assert.match(f.resultPanel(),/투표 미제출로 추가 사망 대상이 없습니다/);
});
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
  assert.match(html,/id="submit-night" disabled/);
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

function mobileDiscussion() {
  const shell={dataset:{},style:{values:{},setProperty(key,value){this.values[key]=value;}}};
  const button={setAttribute(key,value){this[key]=value;}};
  const input={value:'작성 중인 의견',selectionStart:4,blur(){}};
  const rows=[];
  const box={scrollTop:120,scrollHeight:1600,clientHeight:300,append(row){rows.push(row);},querySelectorAll(){return rows;}};
  const video={srcObject:{id:'ongoing-stream'}};
  const nodes={'.discussion-shell':shell,'#mobile-chat-toggle':button,'#chat-input':input,'#chat-box':box,'#video-p0':video};
  const f=ui({querySelector:selector=>nodes[selector]||null,
    createElement:()=>({append(){}}),createTextNode:text=>({text})});
  f.context.matchMedia=()=>({matches:true});
  vm.runInContext('render=()=>{throw new Error("View switch must retain mounted media and chat");};',f.context);
  f.state.room={phase:'discussion'};f.state.playerId='p0';
  return {...f,shell,button,input,box,video};
}

test('mobile starts with video, counts hidden incoming messages, and retains draft and history on round trips',()=>{
  const f=mobileDiscussion();f.updateMobileDiscussionControls();
  assert.equal(f.shell.dataset.mobileView,'video');
  f.handleMessage('chat:message',{playerId:'p1',name:'다른 참가자',text:'제 의견입니다.'});
  assert.equal(f.button.textContent,'채팅 (1)');
  f.handleMessage('chat:message',{playerId:'p0',name:'나',text:'제 메시지'});
  assert.equal(f.button.textContent,'채팅 (1)');
  f.toggleMobileDiscussion();
  assert.equal(f.shell.dataset.mobileView,'chat');assert.equal(f.button['aria-pressed'],'true');
  f.box.scrollTop=120;
  f.toggleMobileDiscussion();
  assert.equal(f.shell.dataset.mobileView,'video');assert.equal(f.button.textContent,'채팅');
  // Hidden elements have zero layout dimensions. Receiving there must not erase the saved reading position.
  f.box.scrollHeight=0;f.box.clientHeight=0;f.box.scrollTop=0;
  f.handleMessage('chat:message',{playerId:'p2',name:'참가자',text:'추가 의견'});
  f.box.scrollHeight=1700;f.box.clientHeight=300;
  f.toggleMobileDiscussion();
  assert.equal(f.box.scrollTop,120);assert.equal(f.button.textContent,'영상으로');
  assert.equal(f.input.value,'작성 중인 의견');assert.equal(f.input.selectionStart,4);
  assert.equal(f.video.srcObject.id,'ongoing-stream');
  f.handleMessage('chat:message',{playerId:'p1',name:'참가자',text:'읽는 중 수신'});
  assert.equal(f.button.textContent,'영상으로');
});

test('mobile keyboard viewport changes resize the shell without replacing draft or playing media',()=>{
  const f=mobileDiscussion();f.toggleMobileDiscussion();
  f.context.visualViewport={height:400,offsetTop:24};
  f.syncDiscussionViewport();
  assert.equal(f.shell.style.values['--discussion-viewport-height'],'400px');
  assert.equal(f.shell.style.values['--discussion-viewport-top'],'24px');
  assert.equal(f.shell.dataset.mobileView,'chat');
  assert.equal(f.input.value,'작성 중인 의견');assert.equal(f.video.srcObject.id,'ongoing-stream');
});

test('desktop ignores mobile switch and mobile chat closes when voting begins',()=>{
  const f=mobileDiscussion();
  f.context.matchMedia=()=>({matches:false});
  f.toggleMobileDiscussion();f.updateMobileDiscussionControls();
  assert.equal(f.shell.dataset.mobileView,'video');
  f.context.matchMedia=()=>({matches:true});f.toggleMobileDiscussion();
  vm.runInContext('saveSession=()=>{};syncPeers=()=>{};syncMediaToPhase=()=>{};render=()=>{};notify=()=>{};',f.context);
  f.handleMessage('game:phase',{phase:'voting',hostId:'p0'});
  f.updateMobileDiscussionControls();
  assert.equal(f.shell.dataset.mobileView,'video');
  f.toggleMobileDiscussion();assert.equal(f.shell.dataset.mobileView,'video');
});

function tableFixture(role='seer',count=10) {
  const f=ui({querySelector:()=>null,querySelectorAll:()=>[]});
  vm.runInContext('render=()=>{};notify=()=>{};saveSession=()=>{};syncPeers=()=>{};syncMediaToPhase=()=>{};',f.context);
  f.state.playerId='p0';f.state.room={phase:'night',nightTurn:role,players:Array.from({length:count},(_,i)=>({id:'p'+i,name:'참가자 '+i}))};
  f.state.prompt={role,targetRole:role,players:f.state.room.players.slice(1),centerCount:3};
  const sent=[];f.state.ws={readyState:1,send:message=>sent.push(JSON.parse(message))};
  return {...f,sent};
}
test('insomniac sees the granted own card, while replay keeps the table face down',()=>{
  const f=tableFixture('insomniac');f.state.prompt=null;
  f.handleMessage('night:info',{role:'insomniac',currentRole:'werewolf'});
  assert.match(f.nightTable(),/내 자리 · 확인 당시 늑대인간/);
  f.handleMessage('room:state',{...f.state.room,nightTurn:'seer'});
  f.handleMessage('night:info',{role:'insomniac',currentRole:'werewolf',replay:true});
  assert.doesNotMatch(f.nightTable(),/table-card-face/);
});
for(const role of ['werewolf','mason'])test(`${role} flips only granted waking cards and keeps them through the public turn update`,()=>{
  const f=tableFixture(role,5);f.state.room.nightTurn='doppelganger';f.state.prompt=null;
  const data={role,others:['참가자 1'],table:{revealed:[{playerId:'p0',role,awakening:true},{playerId:'p1',role,awakening:true}]}};
  f.handleMessage('night:info',data);
  f.handleMessage('room:state',{...f.state.room,nightTurn:role});
  const html=f.nightTable();assert.equal((html.match(/table-card-face/g)||[]).length,2);
  assert.match(html,new RegExp('내 자리 · 깨어난 역할 '+(role==='werewolf'?'늑대인간':'프리메이슨')));
  assert.doesNotMatch(html,/<button[^>]*data-night-player="p2"[^>]*>\s*<span class="table-card-face"/);
  f.handleMessage('game:paused',{...f.state.room,phase:'paused',nightTurn:null});
  f.handleMessage('game:resumed',{...f.state.room,phase:'night',nightTurn:role});
  assert.equal((f.nightTable().match(/table-card-face/g)||[]).length,2);
  f.handleMessage('room:state',{...f.state.room,nightTurn:'seer'});
  assert.doesNotMatch(f.nightTable(),/table-card-face/);
  f.handleMessage('night:info',{...data,replay:true});assert.doesNotMatch(f.nightTable(),/table-card-face/);
});
test('lone wolf retains its own card through the prompt, then reveals just one center with it',()=>{
  const f=tableFixture('werewolf',3);f.state.room.nightTurn='doppelganger';f.state.prompt=null;
  const own={playerId:'p0',role:'werewolf',awakening:true};
  f.handleMessage('night:info',{role:'werewolf',loneWolf:true,table:{revealed:[own]}});
  f.handleMessage('night:prompt',{role:'werewolf',targetRole:'werewolf',players:f.state.room.players.slice(1),centerCount:3});
  f.handleMessage('room:state',{...f.state.room,nightTurn:'werewolf'});
  assert.equal((f.nightTable().match(/table-card-face/g)||[]).length,1);
  f.selectNightCard('center',1);f.submitNight();
  f.handleMessage('night:result',{table:{revealed:[own,{centerIndex:1,role:'seer'}]}});
  assert.equal((f.nightTable().match(/table-card-face/g)||[]).length,2);
  assert.match(f.nightTable(),/내 자리 · 깨어난 역할 늑대인간/);
  assert.match(f.nightTable(),/중앙 카드 2 · 확인 당시 예언자/);
});
test('insomniac reveal survives the actual info-before-phase message order',()=>{
  const f=tableFixture('insomniac');f.state.room.nightTurn='drunk';f.state.prompt=null;
  f.handleMessage('night:info',{role:'insomniac',currentRole:'werewolf'});
  f.handleMessage('room:state',{...f.state.room,nightTurn:'insomniac'});
  assert.equal((f.nightTable().match(/table-card-face/g)||[]).length,1);
  assert.match(f.nightTable(),/내 자리 · 확인 당시 늑대인간/);
  f.handleMessage('game:phase',{...f.state.room,phase:'discussion',nightTurn:null});
  assert.doesNotMatch(f.nightTable(),/table-card-face/);
});
for(const copied of [false,true])test(`insomniac closeup hides its face until own-card click and permits retry (copied=${copied})`,()=>{
  const f=tableFixture('insomniac',3);f.state.privateRole=copied?'doppelganger':'insomniac';
  f.state.prompt=null;f.state.room.nightTurn='drunk';
  const prompt={role:copied?'doppelganger-copy':'insomniac',targetRole:'insomniac',players:[],centerCount:0};
  f.handleMessage('night:prompt',prompt);
  f.handleMessage('room:state',{...f.state.room,nightTurn:'insomniac'});
  assert.match(f.nightTable(),/insomniac-seat/);
  assert.doesNotMatch(f.nightTable(),/table-card-face/);
  assert.doesNotMatch(f.nightPanel(),/id="submit-night"|확인한 내 역할:/);
  f.selectNightCard('player','p1');f.selectNightCard('center',0);assert.equal(f.sent.length,0);
  f.selectNightCard('player','p0');f.selectNightCard('player','p0');assert.equal(f.sent.length,1);
  assert.deepEqual(f.sent[0],{event:'night:action',data:{}});
  assert.doesNotMatch(f.nightTable(),/table-card-face/);
  f.handleMessage('error',{message:'retry'});f.selectNightCard('player','p0');assert.equal(f.sent.length,2);
  const result={title:'내 카드 확인',currentRole:'werewolf',table:{closeup:true,nightTurn:'insomniac',revealed:[{playerId:'p0',role:'werewolf'}]}};
  f.handleMessage('night:result',result);f.handleMessage('night:turn-ended',{reason:'completed'});
  assert.match(f.nightTable(),/insomniac-seat/);assert.match(f.nightTable(),/내 자리 · 확인 당시 늑대인간/);
  assert.equal(f.state.privateRole,'werewolf');
  f.handleMessage('game:phase',{...f.state.room,phase:'discussion',nightTurn:null});
  assert.doesNotMatch(f.nightTable(),/insomniac-seat|table-card-face/);
  f.handleMessage('night:result',{...result,replay:true});assert.doesNotMatch(f.nightTable(),/insomniac-seat|table-card-face/);
});
test('insomniac cannot reveal while paused or after timeout and failed transport is retryable',()=>{
  const f=tableFixture('insomniac',3);
  f.state.room.phase='paused';f.selectNightCard('player','p0');assert.equal(f.sent.length,0);
  f.state.room.phase='night';f.state.ws.readyState=3;f.selectNightCard('player','p0');
  assert.equal(f.nightSelectionReady(),true);assert.equal(f.sent.length,0);
  f.handleMessage('night:turn-ended',{reason:'timeout'});f.selectNightCard('player','p0');
  assert.equal(f.sent.length,0);assert.doesNotMatch(f.nightTable(),/insomniac-seat|table-card-face/);
});
for(const nightTurn of ['minion','doppelganger'])test(`minion flips only wolf positions during ${nightTurn} and hides them next turn`,()=>{
  const f=tableFixture(nightTurn,3);f.state.prompt=null;f.state.room.nightTurn='werewolf';
  const data={role:'minion',nightTurn,wolves:['참가자 1','참가자 2'],table:{revealed:['p1','p2'].map(playerId=>({playerId,role:'werewolf',awakening:true}))}};
  f.handleMessage('night:info',data);f.handleMessage('room:state',{...f.state.room,nightTurn});
  assert.equal((f.nightTable().match(/table-card-face/g)||[]).length,2);
  assert.doesNotMatch(f.nightTable(),/내 자리 · 깨어난 역할/);
  f.handleMessage('game:phase',{...f.state.room,nightTurn:'mason'});assert.doesNotMatch(f.nightTable(),/table-card-face/);
  f.handleMessage('night:info',{...data,replay:true});assert.doesNotMatch(f.nightTable(),/table-card-face/);
});
test('table seer changes between player and center selections without ambiguous submissions',()=>{
  const f=tableFixture();assert.equal(f.nightSelectionReady(),false);
  f.selectNightCard('player','p1');assert.equal(f.nightSelectionReady(),true);
  f.selectNightCard('center',0);assert.equal(f.state.selectedTarget,null);assert.equal(f.nightSelectionReady(),false);
  f.selectNightCard('center',2);assert.equal(f.nightSelectionReady(),true);
  f.selectNightCard('player','p2');assert.equal(f.state.selectedCenter.length,0);
  f.selectNightCard('player','p2');assert.equal(f.nightSelectionReady(),false);
  f.selectNightCard('center',2);f.selectNightCard('center',1);f.submitNight();
  assert.deepEqual(f.sent,[{event:'night:action',data:{targetId:null,centerIndexes:[2,1]}}]);
  f.selectNightCard('center',0);assert.deepEqual(Array.from(f.state.selectedCenter),[2,1]);
  f.submitNight();assert.equal(f.sent.length,1);
});
test('table troublemaker requires two other players, supports deselection, and blocks paused or expired turns',()=>{
  const f=tableFixture('troublemaker');f.selectNightCard('player','p0');assert.equal(f.state.selectedTarget,null);
  f.selectNightCard('player','unknown');assert.equal(f.state.selectedTarget,null);
  f.selectNightCard('player','p1');assert.equal(f.nightSelectionReady(),false);
  f.selectNightCard('player','p2');assert.equal(f.nightSelectionReady(),true);
  f.selectNightCard('player','p1');assert.equal(f.state.selectedTarget,'p2');assert.equal(f.nightSelectionReady(),false);
  f.selectNightCard('player','p3');f.state.room.phase='paused';f.submitNight();assert.equal(f.sent.length,0);
  f.state.room.phase='night';f.handleMessage('night:turn-ended',{reason:'timeout'});f.submitNight();assert.equal(f.sent.length,0);
  assert.equal(f.state.prompt,null);assert.doesNotMatch(f.nightPanel(),/id="submit-night"/);
});
test('table shows only server-granted faces and hides snapshots on replay or next turn',()=>{
  const f=tableFixture();
  assert.equal((f.nightTable().match(/data-night-player=/g)||[]).length,10);
  assert.equal((f.nightTable().match(/data-center=/g)||[]).length,3);
  assert.doesNotMatch(f.nightTable(),/table-card-face/);
  const data={title:'중앙 확인',table:{revealed:[{centerIndex:2,role:'hunter'}]}};
  f.handleMessage('night:result',data);
  assert.equal((f.nightTable().match(/table-card-face/g)||[]).length,1);assert.match(f.nightTable(),/확인 당시 사냥꾼/);
  f.handleMessage('room:state',{...f.state.room,nightTurn:'robber'});assert.doesNotMatch(f.nightTable(),/table-card-face/);
  f.handleMessage('night:result',{...data,replay:true});assert.doesNotMatch(f.nightTable(),/table-card-face/);
});
test('blind exchanges animate backs without revealing any roles',()=>{
  const f=tableFixture('drunk');f.selectNightCard('center',1);f.submitNight();
  assert.deepEqual(f.sent,[{event:'night:action',data:{centerIndex:1}}]);
  f.handleMessage('night:result',{title:'역할 교환',table:{swapped:[{playerId:'p0'},{centerIndex:1}]}});
  assert.equal((f.nightTable().match(/flying-card/g)||[]).length,2);
  assert.doesNotMatch(f.nightTable(),/table-card-face/);
});
test('copied role card interaction remains usable through errors and subsequent ability',()=>{
  const f=tableFixture('doppelganger',3);f.selectNightCard('player','p1');f.submitNight();
  f.handleMessage('night:result',{currentRole:'robber',table:{revealed:[{playerId:'p1',role:'robber'}]}});
  f.handleMessage('night:prompt',{role:'doppelganger-copy',targetRole:'robber',players:f.state.room.players.slice(1),centerCount:3});
  f.selectNightCard('player','p2');f.submitNight();f.handleMessage('error',{message:'retry'});
  assert.equal(f.nightSelectionReady(),true);assert.equal(f.state.selectedTarget,'p2');f.submitNight();
  assert.equal(f.sent.length,3);assert.equal(f.sent.at(-1).data.targetId,'p2');
});
