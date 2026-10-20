import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

const PORT = Number(process.env.PORT || 4173);
const ROOT = join(process.cwd(), 'public');
const rooms = new Map();
const sockets = new Set();
const CATALOGUE = [
  { id: 'werewolf', name: '늑대인간', emoji: '🐺', max: 2 },
  { id: 'seer', name: '예언자', emoji: '🔮', max: 1 },
  { id: 'robber', name: '강도', emoji: '🦝', max: 1 },
  { id: 'troublemaker', name: '말썽쟁이', emoji: '🃏', max: 1 },
  { id: 'drunk', name: '주정뱅이', emoji: '🍺', max: 1 },
  { id: 'insomniac', name: '불면증 환자', emoji: '🌙', max: 1 },
  { id: 'villager', name: '주민', emoji: '🧑‍🌾', max: 3 },
  { id: 'doppelganger', name: '도플갱어', emoji: '👥', max: 1 },
  { id: 'tanner', name: '무두장이', emoji: '🪓', max: 1 },
  { id: 'minion', name: '하수인', emoji: '🕴️', max: 1 },
  { id: 'mason', name: '프리메이슨', emoji: '🤝', max: 2 },
  { id: 'hunter', name: '사냥꾼', emoji: '🏹', max: 1 },
];
const ROLE_NAME = Object.fromEntries(CATALOGUE.map((role) => [role.id, role.name]));
const NIGHT_ORDER = ['doppelganger', 'werewolf', 'minion', 'mason', 'seer', 'robber', 'troublemaker', 'drunk', 'insomniac'];
const IMMEDIATE_COPY_ROLES = new Set(['seer', 'robber', 'troublemaker', 'drunk']);

function code() { return randomBytes(3).toString('hex').toUpperCase(); }
function token() { return randomBytes(24).toString('base64url'); }
function card(role) { return { id: token(), role, copyRole: null }; }
function defaultRoles(playerCount) {
  const roles = [];
  const add = (role, n = 1) => { for (let i = 0; i < n; i += 1) roles.push(role); };
  add('werewolf', playerCount >= 4 ? 2 : 1);
  add('seer'); add('robber');
  if (playerCount >= 4) add('troublemaker');
  if (playerCount >= 5) add('drunk');
  if (playerCount >= 6) add('doppelganger');
  if (playerCount >= 7) add('tanner');
  if (playerCount >= 8) add('minion');
  if (playerCount >= 9) add('insomniac');
  while (roles.length < playerCount + 3) add('villager');
  return roles.slice(0, playerCount + 3);
}

function fillRoleSlots(roles, target) {
  const filled = [...roles];
  for (const role of ['villager', 'werewolf', ...CATALOGUE.map((entry) => entry.id).filter((id) => id !== 'mason')]) {
    const max = CATALOGUE.find((entry) => entry.id === role).max;
    while (filled.length < target && filled.filter((id) => id === role).length < max) filled.push(role);
  }
  return filled;
}

function send(ws, event, data = {}) {
  if (!ws || ws.closed) return;
  const payload = Buffer.from(JSON.stringify({ event, data }));
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  try { ws.socket.write(Buffer.concat([header, payload])); } catch { closeSocket(ws); }
}

function closeSocket(ws) {
  if (ws.closed) return;
  ws.closed = true;
  sockets.delete(ws);
  try { ws.socket.end(); } catch { /* already closed */ }
  if (ws.room && ws.playerId) {
    const room = rooms.get(ws.room);
    const player = room?.players.get(ws.playerId);
    if (player && player.socket === ws) {
      player.socket = null;
      player.connected = false;
      player.disconnectedAt = Date.now();
      broadcast(room, 'room:state', publicRoom(room));
      if (room.phase !== 'lobby' && room.phase !== 'result') broadcast(room, 'game:pause-availability', { available: true });
    }
  }
}

function publicRoom(room) {
  const playerCount = room.players.size;
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, ready: p.ready, connected: p.connected, isBot: Boolean(p.isBot) })),
    roles: room.roles,
    roleTarget: playerCount + 3,
    customRoles: room.customRoles,
    hasTestBots: room.hasTestBots,
    timerEndsAt: room.timerEndsAt,
    remainingMs: room.remainingMs,
    pauseAvailable: [...room.players.values()].some((p) => !p.connected),
    pauseReason: room.pauseReason,
    votesSubmitted: room.votes.size,
    voteTarget: playerCount,
    result: room.result,
    chat: room.chat.slice(-40),
  };
}

function broadcast(room, event, data) {
  const payload = data ?? publicRoom(room);
  for (const p of room.players.values()) if (p.socket) send(p.socket, event, payload);
}

function privateSend(room, playerId, event, data) {
  const p = room.players.get(playerId);
  if (p?.socket) send(p.socket, event, data);
}

function roleForPlayer(room, playerId) {
  const owned = room.cards.find((c) => c.ownerId === playerId);
  return owned ? owned.role === 'doppelganger' ? (owned.copyRole || 'doppelganger') : owned.role : null;
}

function playerCard(room, playerId) { return room.cards.find((c) => c.ownerId === playerId); }
function actorIds(room, role) { return [...room.players.keys()].filter((id) => room.startRoles.get(id) === role || role !== 'minion' && room.startRoles.get(id) === 'doppelganger' && room.copyRoles.get(id) === role && !IMMEDIATE_COPY_ROLES.has(role)); }

function setTimer(room, ms) {
  clearTimeout(room.timer);
  room.remainingMs = ms;
  room.timerEndsAt = Date.now() + ms;
  room.timer = setTimeout(() => timerExpired(room), ms);
  broadcast(room, 'room:state', publicRoom(room));
}

function clearTimer(room) { clearTimeout(room.timer); room.timer = null; }

function startDiscussion(room) {
  room.phase = 'discussion'; room.activeRole = null; room.actionPrompt = null;
  room.actionActors = []; room.actionIndex = 0;
  setTimer(room, (room.hasTestBots ? 35 : room.discussionSeconds) * 1000);
  broadcast(room, 'game:phase', publicRoom(room));
}

function randomChoice(items) { return items[Math.floor(Math.random() * items.length)]; }

function botNightAction(room, playerId) {
  const prompt = room.actionPrompt;
  const role = prompt?.targetRole || prompt?.role;
  const others = [...room.players.keys()].filter((id) => id !== playerId);
  if (role === 'seer' && Math.random() < 0.5) {
    return { centerIndexes: [0, 1, 2].sort(() => Math.random() - 0.5).slice(0, 2) };
  }
  if (role === 'troublemaker') {
    const targets = [...others].sort(() => Math.random() - 0.5).slice(0, 2);
    return { targetId: targets[0], secondTargetId: targets[1] };
  }
  if (role === 'drunk') return { centerIndex: Math.floor(Math.random() * 3) };
  if (['doppelganger', 'seer', 'robber'].includes(role)) return { targetId: randomChoice(others) };
  return {};
}

function scheduleBotNightAction(room, playerId) {
  if (!room.players.get(playerId)?.isBot) return;
  setTimeout(() => {
    if (room.phase !== 'night' || room.actionPrompt?.playerId !== playerId) return;
    applyNightAction(room, playerId, botNightAction(room, playerId));
    broadcast(room, 'room:state', publicRoom(room));
  }, 900);
}

function scheduleBotVotes(room) {
  [...room.players.values()].filter((player) => player.isBot).forEach((bot, index) => setTimeout(() => {
    if (room.phase !== 'voting' || room.votes.has(bot.id)) return;
    const wolfTeam = new Set([...room.players.keys()].filter((id) => ['werewolf', 'minion'].includes(room.startRoles.get(id))));
    const candidates = [...room.players.keys()].filter((id) => id !== bot.id && (!wolfTeam.has(bot.id) || !wolfTeam.has(id)));
    room.votes.set(bot.id, candidates.length ? randomChoice(candidates) : null);
    broadcast(room, 'room:state', publicRoom(room));
  }, 700 * (index + 1)));
}

function enterVoting(room) {
  room.phase = 'voting'; room.votes = new Map();
  setTimer(room, (room.hasTestBots ? 35 : room.votingSeconds) * 1000);
  broadcast(room, 'game:phase', publicRoom(room));
  if (room.hasTestBots) scheduleBotVotes(room);
}

function beginAction(room, role) {
  room.activeRole = role;
  room.actionActors = actorIds(room, role).filter((id) => !room.actionDone.has(`${role}:${id}`));
  room.actionIndex = 0;
  room.actionPrompt = null;
  const active = room.actionActors[0];

  if (role === 'werewolf') {
    const wolves = actorIds(room, 'werewolf');
    for (const id of room.actionActors) {
      const others = wolves.filter((other) => other !== id).map((other) => room.players.get(other)?.name);
      const loneCenter = wolves.length === 1 ? [room.center[0].role, room.center[1].role, room.center[2].role] : null;
      privateSend(room, id, 'night:info', { role, others, loneCenter });
      room.actionDone.add(`${role}:${id}`);
    }
    return nextAction(room);
  }
  if (role === 'minion') {
    const wolves = actorIds(room, 'werewolf').map((id) => room.players.get(id)?.name);
    for (const id of room.actionActors) { privateSend(room, id, 'night:info', { role, wolves }); room.actionDone.add(`${role}:${id}`); }
    return nextAction(room);
  }
  if (role === 'mason') {
    const masons = actorIds(room, 'mason');
    for (const id of room.actionActors) {
      const others = masons.filter((other) => other !== id).map((other) => room.players.get(other)?.name);
      privateSend(room, id, 'night:info', { role, others });
      room.actionDone.add(`${role}:${id}`);
    }
    return nextAction(room);
  }
  if (role === 'insomniac') {
    for (const id of room.actionActors) { privateSend(room, id, 'night:info', { role, currentRole: roleForPlayer(room, id) }); room.actionDone.add(`${role}:${id}`); }
    return nextAction(room);
  }
  if (!active) return nextAction(room);
  const ownRole = room.startRoles.get(active) === 'doppelganger' && room.copyRoles.get(active) === role ? 'doppelganger-copy' : role;
  room.actionPrompt = { playerId: active, role: ownRole };
  privateSend(room, active, 'night:prompt', { role: ownRole, targetRole: role, players: [...room.players.values()].filter((p) => p.id !== active).map(({ id, name }) => ({ id, name })), centerCount: room.center.length });
  setTimer(room, 25000);
  scheduleBotNightAction(room, active);
  broadcast(room, 'game:phase', publicRoom(room));
}

function nextAction(room) {
  clearTimer(room);
  const currentRoleIndex = NIGHT_ORDER.indexOf(room.activeRole);
  for (let i = currentRoleIndex + 1; i < NIGHT_ORDER.length; i += 1) {
    const nextRole = NIGHT_ORDER[i];
    if (actorIds(room, nextRole).some((id) => !room.actionDone.has(`${nextRole}:${id}`))) return beginAction(room, nextRole);
  }
  startDiscussion(room);
}

function completeActor(room, playerId) {
  const role = room.activeRole;
  room.actionDone.add(`${role}:${playerId}`);
  room.actionIndex += 1;
  const nextPlayer = room.actionActors[room.actionIndex];
  if (nextPlayer) {
    const promptRole = room.startRoles.get(nextPlayer) === 'doppelganger' ? 'doppelganger-copy' : role;
    room.actionPrompt = { playerId: nextPlayer, role: promptRole };
    privateSend(room, nextPlayer, 'night:prompt', { role: promptRole, targetRole: role, players: [...room.players.values()].filter((p) => p.id !== nextPlayer).map(({ id, name }) => ({ id, name })), centerCount: room.center.length });
    setTimer(room, 25000);
    scheduleBotNightAction(room, nextPlayer);
    broadcast(room, 'game:phase', publicRoom(room));
  } else nextAction(room);
}

function beginNight(room) {
  room.phase = 'night'; room.actionDone = new Set(); room.copyRoles = new Map();
  room.activeRole = null; room.actionActors = []; room.actionIndex = 0;
  const first = NIGHT_ORDER.find((role) => actorIds(room, role).length > 0);
  if (first) beginAction(room, first); else startDiscussion(room);
}

function startGame(room) {
  if (room.players.size < 3 && !room.hasTestBots) return;
  const n = room.players.size;
  if (room.roles.length !== n + 3) return;
  const deck = room.roles.map((r) => card(r));
  for (let i = deck.length - 1; i > 0; i -= 1) { const j = randomBytes(4).readUInt32BE() % (i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  room.cards = deck;
  room.startRoles = new Map();
  const players = [...room.players.values()];
  players.forEach((p, i) => { deck[i].ownerId = p.id; room.startRoles.set(p.id, deck[i].role); privateSend(room, p.id, 'role:private', { role: deck[i].role, name: ROLE_NAME[deck[i].role] }); });
  room.center = deck.slice(n);
  room.votes = new Map(); room.result = null;
  room.phase = 'role_reveal';
  broadcast(room, 'game:phase', publicRoom(room));
  setTimer(room, 10000);
}

function currentActors(room) { return room.actionActors; }

function applyNightAction(room, playerId, data) {
  if (room.phase !== 'night' || room.actionPrompt?.playerId !== playerId) return send(room.players.get(playerId)?.socket, 'error', { message: '현재 차례가 아닙니다.' });
  const prompt = room.actionPrompt;
  const actingAs = prompt.role;
  const target = (id) => room.players.has(id) && id !== playerId;
  const swap = (a, b) => { const ac = playerCard(room, a); const bc = playerCard(room, b); if (!ac || !bc) return false; ac.ownerId = b; bc.ownerId = a; return true; };

  if (actingAs === 'doppelganger') {
    if (!target(data.targetId)) return send(room.players.get(playerId)?.socket, 'error', { message: '대상을 선택해 주세요.' });
    const copied = roleForPlayer(room, data.targetId);
    const own = playerCard(room, playerId);
    own.copyRole = copied;
    room.copyRoles.set(playerId, copied);
    privateSend(room, playerId, 'night:result', { title: '복사한 역할', text: `${room.players.get(data.targetId).name}님의 역할은 ${ROLE_NAME[copied] || copied}입니다. 해당 역할을 복사했습니다.` });
  } else if (actingAs === 'seer' || actingAs === 'doppelganger-copy' && ['seer'].includes(prompt.targetRole)) {
    if (data.centerIndexes?.length === 2) {
      const roles = data.centerIndexes.map((i) => room.center[i]?.role).filter(Boolean);
      if (roles.length !== 2) return send(room.players.get(playerId)?.socket, 'error', { message: '중앙 카드 두 장을 선택해 주세요.' });
      privateSend(room, playerId, 'night:result', { title: '중앙 카드 확인', roles: roles.map((r) => ROLE_NAME[r]) });
    } else if (target(data.targetId)) privateSend(room, playerId, 'night:result', { title: '플레이어 확인', text: `${room.players.get(data.targetId).name}님의 역할은 ${ROLE_NAME[roleForPlayer(room, data.targetId)]}입니다.` });
    else return send(room.players.get(playerId)?.socket, 'error', { message: '플레이어 한 명 또는 중앙 카드 두 장을 선택해 주세요.' });
  } else if (actingAs === 'robber' || actingAs === 'doppelganger-copy' && prompt.targetRole === 'robber') {
    if (!target(data.targetId) || !swap(playerId, data.targetId)) return send(room.players.get(playerId)?.socket, 'error', { message: '바꿀 플레이어를 선택해 주세요.' });
    privateSend(room, playerId, 'night:result', { title: '역할 교환', text: `새 역할은 ${ROLE_NAME[roleForPlayer(room, playerId)]}입니다.` });
  } else if (actingAs === 'troublemaker' || actingAs === 'doppelganger-copy' && prompt.targetRole === 'troublemaker') {
    if (!target(data.targetId) || !target(data.secondTargetId) || data.targetId === data.secondTargetId || !swap(data.targetId, data.secondTargetId)) return send(room.players.get(playerId)?.socket, 'error', { message: '서로 다른 플레이어 두 명을 골라 주세요.' });
    privateSend(room, playerId, 'night:result', { title: '역할 교환', text: '두 플레이어의 역할을 서로 바꿨습니다.' });
  } else if (actingAs === 'drunk' || actingAs === 'doppelganger-copy' && prompt.targetRole === 'drunk') {
    const index = Number(data.centerIndex); const own = playerCard(room, playerId); const center = room.center[index];
    if (!Number.isInteger(index) || !center || !own) return send(room.players.get(playerId)?.socket, 'error', { message: '중앙 카드 한 장을 선택해 주세요.' });
    own.ownerId = null; center.ownerId = playerId; room.center[index] = own;
    privateSend(room, playerId, 'night:result', { title: '역할 교환', text: '중앙 카드와 역할을 바꿨습니다. 새 역할은 공개되지 않습니다.' });
  } else {
    privateSend(room, playerId, 'night:result', { title: '밤 행동 완료', text: '행동을 완료했습니다.' });
  }

  // Doppelgangers that copy immediate-action roles resolve their copied action now.
  if (actingAs === 'doppelganger' && IMMEDIATE_COPY_ROLES.has(room.copyRoles.get(playerId))) {
    const copiedRole = room.copyRoles.get(playerId);
    room.actionPrompt = { playerId, role: 'doppelganger-copy', targetRole: copiedRole };
    privateSend(room, playerId, 'night:prompt', { role: 'doppelganger-copy', targetRole: copiedRole, players: [...room.players.values()].filter((p) => p.id !== playerId).map(({ id, name }) => ({ id, name })), centerCount: room.center.length });
    setTimer(room, 25000); scheduleBotNightAction(room, playerId); broadcast(room, 'game:phase', publicRoom(room)); return;
  }
  if (actingAs === 'doppelganger' && room.copyRoles.get(playerId) === 'minion') {
    const wolves = actorIds(room, 'werewolf').map((id) => room.players.get(id)?.name);
    privateSend(room, playerId, 'night:info', { role: 'minion', wolves });
    completeActor(room, playerId);
    return;
  }
  completeActor(room, playerId);
}

function resolveVotes(room) {
  clearTimer(room); room.phase = 'result';
  const counts = new Map();
  for (const targetId of room.votes.values()) if (targetId) counts.set(targetId, (counts.get(targetId) || 0) + 1);
  const max = Math.max(0, ...counts.values());
  const killedSet = new Set(max > 1 ? [...counts.entries()].filter(([, count]) => count === max).map(([id]) => id) : []);
  for (const id of [...killedSet]) {
    if (roleForPlayer(room, id) === 'hunter') {
      const targetId = room.votes.get(id);
      if (targetId && room.players.has(targetId)) killedSet.add(targetId);
    }
  }
  const killed = [...killedSet];
  const finalRoles = [...room.players.values()].map((p) => ({ id: p.id, name: p.name, startRole: room.startRoles.get(p.id), role: roleForPlayer(room, p.id), votes: counts.get(p.id) || 0, killed: killedSet.has(p.id) }));
  const wolvesExist = finalRoles.some((p) => p.role === 'werewolf');
  const wolfKilled = finalRoles.some((p) => p.role === 'werewolf' && p.killed);
  const tannerKilled = finalRoles.some((p) => p.role === 'tanner' && p.killed);
  const villageWin = wolfKilled || (!wolvesExist && killed.length === 0);
  const wolfTeamWin = wolvesExist && !wolfKilled && !tannerKilled;
  const minionSoloWin = (minionId) => !wolvesExist && finalRoles.some((p) => p.id === minionId && p.role === 'minion' && !p.killed) && finalRoles.some((p) => p.id !== minionId && p.killed);
  const minionWin = finalRoles.some((p) => p.role === 'minion' && minionSoloWin(p.id));
  const winners = finalRoles.map((p) => ({ id: p.id, win: p.role === 'tanner' ? p.killed : p.role === 'werewolf' ? wolfTeamWin : p.role === 'minion' ? wolfTeamWin || minionSoloWin(p.id) : villageWin }));
  // A copied role keeps its win condition even if it is not physically a role card.
  for (const p of finalRoles) {
    if (room.startRoles.get(p.id) === 'doppelganger' && room.copyRoles.has(p.id)) {
      const copied = room.copyRoles.get(p.id);
      const win = copied === 'tanner' ? p.killed : copied === 'werewolf' ? wolfTeamWin : copied === 'minion' ? wolfTeamWin || minionSoloWin(p.id) : villageWin;
      const entry = winners.find((w) => w.id === p.id); if (entry) entry.win = win;
    }
  }
  room.result = { finalRoles, killed, winners, villageWin, wolfTeamWin, minionWin, center: room.center.map((c) => ROLE_NAME[c.role]) };
  broadcast(room, 'game:result', room.result); broadcast(room, 'room:state', publicRoom(room));
}

function timerExpired(room) {
  room.timer = null; room.timerEndsAt = null; room.remainingMs = 0;
  if (room.phase === 'role_reveal') beginNight(room);
  else if (room.phase === 'night') {
    const active = room.actionPrompt?.playerId;
    if (active) completeActor(room, active);
    else nextAction(room);
  } else if (room.phase === 'discussion') enterVoting(room);
  else if (room.phase === 'voting') resolveVotes(room);
}

function roomFor(ws) { return ws.room ? rooms.get(ws.room) : null; }

function emitError(ws, message) { send(ws, 'error', { message }); }

function handle(ws, event, data) {
  const room = roomFor(ws);
  if (event === 'room:create') {
    if (ws.playerId) return emitError(ws, '이미 방에 입장해 있습니다.');
    let roomCode; do { roomCode = code(); } while (rooms.has(roomCode));
    const id = token(); const sessionToken = token();
    const newRoom = { code: roomCode, hostId: id, players: new Map(), roles: defaultRoles(1), customRoles: false, hasTestBots: false, phase: 'lobby', cards: [], center: [], startRoles: new Map(), copyRoles: new Map(), votes: new Map(), chat: [], discussionSeconds: 150, votingSeconds: 45, timer: null, timerEndsAt: null, remainingMs: 0, actionDone: new Set(), actionActors: [], actionIndex: 0, activeRole: null, actionPrompt: null, result: null, pauseReason: null };
    newRoom.players.set(id, { id, token: sessionToken, name: String(data.name || '플레이어').slice(0, 16), ready: false, connected: true, socket: ws });
    rooms.set(roomCode, newRoom); ws.room = roomCode; ws.playerId = id;
    send(ws, 'room:joined', { room: publicRoom(newRoom), playerId: id, token: sessionToken, isHost: true });
    broadcast(newRoom, 'room:state', publicRoom(newRoom)); return;
  }
  if (event === 'room:bots:add') {
    if (!room || ws.playerId !== room.hostId || room.phase !== 'lobby') return emitError(ws, '대기실 방장만 AI 참가자를 추가할 수 있습니다.');
    if (room.players.size !== 1 || [...room.players.values()].some((p) => p.isBot)) return emitError(ws, '혼자 만든 방에서만 AI 3명을 추가할 수 있습니다.');
    for (const name of ['AI · 달빛', 'AI · 별빛', 'AI · 새벽']) {
      const id = `bot-${token()}`;
      room.players.set(id, { id, token: null, name, ready: true, connected: true, socket: null, isBot: true });
    }
    room.hasTestBots = true;
    room.roles = room.customRoles ? fillRoleSlots(room.roles, room.players.size + 3) : defaultRoles(room.players.size);
    broadcast(room, 'room:state', publicRoom(room)); return;
  }
  if (event === 'room:join') {
    if (ws.playerId) return emitError(ws, '이미 방에 입장해 있습니다.');
    const targetRoom = rooms.get(String(data.code || '').toUpperCase());
    if (!targetRoom) return emitError(ws, '방을 찾을 수 없습니다.');
    if (targetRoom.phase !== 'lobby') return emitError(ws, '이미 게임이 시작된 방입니다.');
    if (targetRoom.players.size >= 10) return emitError(ws, '방 인원이 가득 찼습니다.');
    const id = token(); const sessionToken = token();
    targetRoom.players.set(id, { id, token: sessionToken, name: String(data.name || '플레이어').slice(0, 16), ready: false, connected: true, socket: ws });
    ws.room = targetRoom.code; ws.playerId = id;
    if (!targetRoom.customRoles) targetRoom.roles = defaultRoles(targetRoom.players.size);
    send(ws, 'room:joined', { room: publicRoom(targetRoom), playerId: id, token: sessionToken, isHost: false });
    broadcast(targetRoom, 'room:state', publicRoom(targetRoom)); return;
  }
  if (event === 'room:reconnect') {
    const targetRoom = rooms.get(String(data.code || '').toUpperCase());
    const player = targetRoom && [...targetRoom.players.values()].find((p) => p.token === data.token);
    if (!player) return emitError(ws, '재접속 정보를 찾을 수 없습니다.');
    if (player.socket) closeSocket(player.socket);
    player.socket = ws; player.connected = true; player.disconnectedAt = null; ws.room = targetRoom.code; ws.playerId = player.id;
    send(ws, 'room:joined', { room: publicRoom(targetRoom), playerId: player.id, token: player.token, isHost: player.id === targetRoom.hostId });
    if (targetRoom.phase === 'role_reveal' || targetRoom.phase !== 'lobby' && targetRoom.startRoles.has(player.id)) {
      const role = targetRoom.startRoles.get(player.id);
      send(ws, 'role:private', { role, name: ROLE_NAME[role] });
    }
    if (targetRoom.phase === 'night' && targetRoom.actionPrompt?.playerId === player.id) {
      const prompt = targetRoom.actionPrompt;
      send(ws, 'night:prompt', { role: prompt.role, targetRole: prompt.targetRole || prompt.role, players: [...targetRoom.players.values()].filter((p) => p.id !== player.id).map(({ id, name }) => ({ id, name })), centerCount: targetRoom.center.length });
    }
    broadcast(targetRoom, 'room:state', publicRoom(targetRoom)); return;
  }
  if (!room || !ws.playerId || !room.players.has(ws.playerId)) return emitError(ws, '먼저 방에 입장해 주세요.');
  const player = room.players.get(ws.playerId);

  if (event.startsWith('webrtc:')) {
    const recipient = room.players.get(data.to);
    if (recipient?.socket) send(recipient.socket, event, { from: ws.playerId, payload: data.payload });
    return;
  }
  if (event === 'player:ready' && room.phase === 'lobby') {
    player.ready = Boolean(data.ready); broadcast(room, 'room:state', publicRoom(room)); return;
  }
  if (event === 'roles:set' && ws.playerId === room.hostId && room.phase === 'lobby') {
    const roles = Array.isArray(data.roles) ? data.roles.filter((r) => ROLE_NAME[r]) : [];
    if (roles.length > room.players.size + 3) return emitError(ws, `역할 카드는 참가 인원 + 중앙 카드 3장, 총 ${room.players.size + 3}장을 넘길 수 없습니다.`);
    const counts = new Map(); for (const role of roles) counts.set(role, (counts.get(role) || 0) + 1);
    if ([...counts].some(([role, count]) => count > CATALOGUE.find((r) => r.id === role).max)) return emitError(ws, '선택할 수 있는 역할 수를 초과했습니다.');
    if ((counts.get('mason') || 0) % 2 !== 0) return emitError(ws, '프리메이슨은 반드시 두 장을 한 쌍으로 선택해야 합니다.');
    room.roles = roles; room.customRoles = true; broadcast(room, 'room:state', publicRoom(room)); return;
  }
  if (event === 'roles:adjust' && ws.playerId === room.hostId && room.phase === 'lobby') {
    const role = String(data.role || ''); const delta = Number(data.delta);
    const expectedStep = role === 'mason' ? 2 : 1;
    if (!ROLE_NAME[role] || ![-expectedStep, expectedStep].includes(delta)) return emitError(ws, '역할 변경 요청을 확인해 주세요.');
    const count = room.roles.filter((id) => id === role).length;
    if (delta < 0) {
      if (count < expectedStep) return emitError(ws, '선택된 역할 카드가 부족합니다.');
      for (let i = 0; i < expectedStep; i += 1) room.roles.splice(room.roles.lastIndexOf(role), 1);
    } else {
      if (room.roles.length + expectedStep > room.players.size + 3) return emitError(ws, `먼저 ${expectedStep}장의 카드 자리를 만들어 주세요.`);
      if (count >= CATALOGUE.find((entry) => entry.id === role).max) return emitError(ws, '이 역할은 더 추가할 수 없습니다.');
      for (let i = 0; i < expectedStep; i += 1) room.roles.push(role);
    }
    room.customRoles = true; broadcast(room, 'room:state', publicRoom(room)); return;
  }
  if (event === 'roles:auto' && ws.playerId === room.hostId && room.phase === 'lobby') {
    room.roles = defaultRoles(room.players.size); room.customRoles = false; broadcast(room, 'room:state', publicRoom(room)); return;
  }
  if (event === 'game:start' && ws.playerId === room.hostId && room.phase === 'lobby') {
    if (room.players.size < 3) return emitError(ws, '최소 3명이 모여야 시작할 수 있습니다.');
    if ([...room.players.values()].some((p) => !p.ready && p.id !== room.hostId)) return emitError(ws, '모든 참가자가 준비해야 시작할 수 있습니다.');
    if (room.roles.length !== room.players.size + 3) return emitError(ws, '인원에 맞는 역할 구성을 확인해 주세요.');
    startGame(room); return;
  }
  if (event === 'night:action') { applyNightAction(room, ws.playerId, data); broadcast(room, 'room:state', publicRoom(room)); return; }
  if (event === 'vote:cast' && room.phase === 'voting') {
    if (room.votes.has(ws.playerId)) return emitError(ws, '이미 투표하셨습니다.');
    const targetId = data.targetId === null ? null : room.players.has(data.targetId) && data.targetId !== ws.playerId ? data.targetId : null;
    room.votes.set(ws.playerId, targetId); broadcast(room, 'room:state', publicRoom(room));
    if (room.votes.size === room.players.size) resolveVotes(room); return;
  }
  if (event === 'chat:send' && ['discussion', 'voting'].includes(room.phase)) {
    const text = String(data.text || '').trim().slice(0, 300); if (!text) return;
    room.chat.push({ id: token(), playerId: player.id, name: player.name, text, at: Date.now() });
    broadcast(room, 'chat:message', room.chat.at(-1)); return;
  }
  if (event === 'game:pause' && ws.playerId === room.hostId && room.phase !== 'lobby' && room.phase !== 'result' && room.phase !== 'paused') {
    room.remainingMs = room.timerEndsAt ? Math.max(0, room.timerEndsAt - Date.now()) : room.remainingMs; clearTimer(room); room.timerEndsAt = null;
    room.pauseReason = '참가자의 연결이 끊겼습니다.'; room.previousPhase = room.phase; room.phase = 'paused';
    broadcast(room, 'game:paused', publicRoom(room)); return;
  }
  if (event === 'game:resume' && ws.playerId === room.hostId && room.phase === 'paused') {
    room.phase = room.previousPhase; room.pauseReason = null;
    if (room.remainingMs > 0) setTimer(room, room.remainingMs);
    broadcast(room, 'game:resumed', publicRoom(room)); broadcast(room, 'room:state', publicRoom(room)); return;
  }
}

function parseFrames(ws, chunk) {
  ws.buffer = Buffer.concat([ws.buffer, chunk]);
  while (ws.buffer.length >= 2) {
    const first = ws.buffer[0]; const second = ws.buffer[1];
    let length = second & 0x7f; let offset = 2;
    if (length === 126) { if (ws.buffer.length < 4) return; length = ws.buffer.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (ws.buffer.length < 10) return; length = Number(ws.buffer.readBigUInt64BE(2)); offset = 10; }
    const masked = Boolean(second & 0x80); const maskOffset = offset;
    if (masked) offset += 4;
    if (ws.buffer.length < offset + length) return;
    let payload = ws.buffer.subarray(offset, offset + length);
    if (masked) { payload = Buffer.from(payload); const mask = ws.buffer.subarray(maskOffset, maskOffset + 4); for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]; }
    ws.buffer = ws.buffer.subarray(offset + length);
    const opcode = first & 0x0f;
    if (opcode === 8) { closeSocket(ws); return; }
    if (opcode === 9) { try { ws.socket.write(Buffer.from([0x8a, 0])); } catch { closeSocket(ws); } continue; }
    if (opcode !== 1) continue;
    try { const message = JSON.parse(payload.toString('utf8')); handle(ws, message.event, message.data || {}); }
    catch (error) { emitError(ws, error instanceof Error ? error.message : '요청을 처리할 수 없습니다.'); }
  }
}

const server = createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = normalize(join(ROOT, requested));
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('Not found'); return; }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(res);
});

server.on('upgrade', (req, socket) => {
  if (req.url !== '/signal' || !req.headers['sec-websocket-key']) { socket.destroy(); return; }
  const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const ws = { socket, buffer: Buffer.alloc(0), closed: false, room: null, playerId: null };
  sockets.add(ws);
  socket.on('data', (chunk) => parseFrames(ws, chunk));
  socket.on('error', () => closeSocket(ws));
  socket.on('close', () => closeSocket(ws));
});

server.listen(PORT, () => console.log(`One Night Werewolf running at http://localhost:${PORT}`));
