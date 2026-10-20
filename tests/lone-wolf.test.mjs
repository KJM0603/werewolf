import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

// Run the actual rule engine with captured WebSocket frames and controlled timers.
const serverSource = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  .split('const server = createServer(')[0].replace(/^import .*;\r?$/gm, '');

function fixture(startRoles = ['werewolf', 'villager', 'villager'], copiedWolf = false) {
  const context = vm.createContext({
    Buffer, process, join, randomBytes, setTimeout: (callback, ms) => ({ callback, ms }), clearTimeout() {},
  });
  vm.runInContext(`${serverSource}\nglobalThis.api = { beginAction, applyNightAction, timerExpired, botNightAction, publicRoom };`, context);
  const messages = startRoles.map(() => []);
  const players = new Map(startRoles.map((role, i) => [`p${i}`, {
    id: `p${i}`, name: `Player ${i}`, connected: true,
    socket: { socket: { write(frame) {
      const size = frame[1] & 127;
      messages[i].push(JSON.parse(frame.subarray(size < 126 ? 2 : size === 126 ? 4 : 10).toString()));
    } } },
  }]));
  const center = ['seer', 'drunk', 'tanner'].map(role => ({ role }));
  const room = {
    code: 'TEST', phase: 'night', players, hostId: 'p0', center,
    cards: [...startRoles.map((role, i) => ({ role, ownerId: `p${i}` })), ...center],
    roles: [...startRoles, ...center.map(c => c.role)],
    startRoles: new Map(startRoles.map((role, i) => [`p${i}`, role])),
    copyRoles: new Map(copiedWolf ? [['p1', 'werewolf']] : []),
    actionDone: new Set(), votes: new Map(), extensionUsed: new Set(), chat: [],
    discussionSeconds: 600,
  };
  context.api.beginAction(room, 'werewolf');
  return { ...context.api, room, messages };
}

function results(messages) { return messages.filter(m => m.event === 'night:result'); }

test('before selection, the lone wolf receives only card backs and no center identities', () => {
  const f = fixture();
  const info = f.messages[0].find(m => m.event === 'night:info').data;
  assert.deepEqual(info, { role: 'werewolf', others: [], loneWolf: true });
  const prompt = f.messages[0].find(m => m.event === 'night:prompt').data;
  assert.equal(prompt.targetRole, 'werewolf');
  assert.equal(prompt.centerCount, 3);
  assert.equal(results(f.messages[0]).length, 0);
  assert.ok(f.messages.flat().every(m => !('loneCenter' in m.data) && !('center' in m.data)));
  assert.ok(f.messages.slice(1).flat().every(m => !m.event.startsWith('night:')));
  assert.equal(f.room.timer.ms, 5000);
});

for (const [index, expected] of ['예언자', '주정뱅이', '무두장이'].entries()) {
  test(`selecting center ${index + 1} reveals only that card privately, once`, () => {
    const f = fixture();
    f.applyNightAction(f.room, 'p0', { centerIndex: index });
    assert.deepEqual(results(f.messages[0]).map(m => m.data), [
      { title: `중앙 카드 ${index + 1} 확인`, roles: [expected] },
    ]);
    assert.ok(f.messages.slice(1).every(m => results(m).length === 0));
    assert.equal(f.room.actionPrompt, null);
    assert.equal(f.room.phase, 'night');
    assert.equal(f.room.timer.ms, 5000); // Do not reset the public deadline after a selection.
    f.applyNightAction(f.room, 'p0', { centerIndex: (index + 1) % 3 });
    assert.equal(results(f.messages[0]).length, 1);
    f.timerExpired(f.room);
    assert.equal(f.room.activeRole, 'seer'); // Center roles must also be announced.
    while (f.room.phase === 'night') f.timerExpired(f.room);
    assert.equal(f.room.phase, 'discussion');
  });
}

test('invalid selection and another player cannot reveal a card or consume the turn', () => {
  const f = fixture();
  for (const data of [{}, { centerIndex: null }, { centerIndex: '1' }, { centerIndex: -1 },
    { centerIndex: 3 }, { centerIndex: 0.5 }, { centerIndexes: [0, 1] },
    { centerIndex: 0, centerIndexes: [0, 1] }]) {
    f.applyNightAction(f.room, 'p0', data);
  }
  f.applyNightAction(f.room, 'p1', { centerIndex: 0 });
  assert.equal(results(f.messages.flat()).length, 0);
  assert.equal(f.room.actionPrompt.playerId, 'p0');
  assert.equal(f.room.actionDone.size, 0);
});

for (const roles of [['werewolf', 'werewolf', 'villager'], ['werewolf', 'doppelganger', 'villager']]) {
  test(`multiple waking wolves have no center-card permission: ${roles.join(', ')}`, () => {
    const f = fixture(roles, roles.includes('doppelganger'));
    assert.equal(f.room.actionPrompt, null);
    assert.ok(f.messages.flat().every(m => m.event !== 'night:prompt'));
    for (const id of ['p0', 'p1']) f.applyNightAction(f.room, id, { centerIndex: 1 });
    assert.equal(results(f.messages.flat()).length, 0);
    assert.equal(f.messages[0].find(m => m.event === 'night:info').data.loneWolf, false);
  });
}

test('timeout reveals nothing; an AI lone wolf chooses exactly one valid index', () => {
  const timedOut = fixture();
  timedOut.timerExpired(timedOut.room);
  assert.equal(results(timedOut.messages.flat()).length, 0);
  assert.equal(timedOut.room.activeRole, 'seer');
  while (timedOut.room.phase === 'night') timedOut.timerExpired(timedOut.room);
  assert.equal(timedOut.room.phase, 'discussion');
  const bot = fixture();
  const action = bot.botNightAction(bot.room, 'p0');
  assert.deepEqual(Object.keys(action), ['centerIndex']);
  assert.ok(Number.isInteger(action.centerIndex) && action.centerIndex >= 0 && action.centerIndex < 3);
  bot.applyNightAction(bot.room, 'p0', action);
  assert.equal(results(bot.messages[0])[0].data.roles.length, 1);
});

test('UI selects a single back, replaces its selection, and submits only its index', () => {
  const buttons = [0, 1, 2].map(index => ({
    dataset: { center: String(index) },
    addEventListener(event, callback) { this.click = callback; },
  }));
  const sent = [];
  const context = vm.createContext({
    document: {
      querySelector: () => null,
      querySelectorAll: selector => selector === '[data-center]' ? buttons : [],
    },
    WebSocket: { OPEN: 1 },
  });
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').split('setInterval(()=>')[0];
  vm.runInContext(`${source}
    render = () => {}; notify = () => {};
    globalThis.api = { state, bindGameEvents, nightPanel, submitNight };`, context);
  const { state, bindGameEvents, nightPanel, submitNight } = context.api;
  state.room = { phase: 'night', nightTurn: 'werewolf' };
  state.prompt = { role: 'werewolf', targetRole: 'werewolf', centerCount: 3 };
  state.ws = { readyState: 1, send: data => sent.push(JSON.parse(data)) };
  assert.equal((nightPanel().match(/data-center=/g) || []).length, 3);
  assert.match(nightPanel(), /id="submit-night" disabled/);
  bindGameEvents();
  buttons[0].click();
  buttons[2].click();
  assert.deepEqual(Array.from(state.selectedCenter), [2]);
  assert.doesNotMatch(nightPanel(), /id="submit-night" disabled/);
  submitNight();
  assert.deepEqual(sent, [{ event: 'night:action', data: { centerIndex: 2 } }]);
  assert.equal(state.prompt.role, 'werewolf', 'Keep the action until the server confirms it');
  assert.match(nightPanel(), /id="submit-night" disabled/);
  submitNight();
  assert.equal(sent.length, 1, 'Do not double-submit while awaiting confirmation');
});
