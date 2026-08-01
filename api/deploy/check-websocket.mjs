import WebSocket from 'ws';
import {
  MULTIPLAYER_PROTOCOL_VERSION,
  SCORE_RACE_MODE_ID,
  SCORE_RACE_MODE_VERSION,
  SCORE_RACE_RULES_VERSION,
} from '../dist/shared/multiplayer-contracts.js';

const baseUrl = process.argv[2];
if (!baseUrl) {
  console.error('usage: node check-websocket.mjs https://api.example.com');
  process.exit(1);
}

const socketUrl = new URL('/multiplayer/socket', baseUrl);
socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';

const admissionResponse = await fetch(new URL('/multiplayer/rooms', baseUrl), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
    mode: {
      id: SCORE_RACE_MODE_ID,
      version: SCORE_RACE_MODE_VERSION,
      rules: {
        id: SCORE_RACE_MODE_ID,
        version: SCORE_RACE_RULES_VERSION,
      },
    },
  }),
});
if (!admissionResponse.ok) {
  const responseBody = await admissionResponse.text();
  throw new Error(
    `multiplayer admission failed with ${admissionResponse.status}: ${responseBody}`,
  );
}
const admission = await admissionResponse.json();

await new Promise((resolve, reject) => {
  const socket = new WebSocket(socketUrl);
  const timeout = setTimeout(() => {
    socket.terminate();
    reject(new Error(`timed out connecting to ${socketUrl}`));
  }, 5_000);

  socket.once('open', () => {
    socket.send(JSON.stringify({
      type: 'authenticate-room',
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: admission.roomId,
      playerId: admission.playerId,
      reconnectCredential: admission.reconnectCredential,
    }));
  });
  socket.once('message', raw => {
    clearTimeout(timeout);
    const message = JSON.parse(raw.toString());
    if (message.type !== 'room-state') {
      socket.terminate();
      reject(new Error(`unexpected multiplayer response: ${raw.toString()}`));
      return;
    }
    socket.close(1000, 'Smoke test complete');
    resolve();
  });
  socket.once('error', error => {
    clearTimeout(timeout);
    reject(error);
  });
});

console.log('ok /multiplayer/socket');
