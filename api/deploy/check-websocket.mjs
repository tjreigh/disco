import WebSocket from 'ws';

const baseUrl = process.argv[2];
if (!baseUrl) {
  console.error('usage: node check-websocket.mjs https://api.example.com');
  process.exit(1);
}

const socketUrl = new URL('/multiplayer/socket', baseUrl);
socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';

await new Promise((resolve, reject) => {
  const socket = new WebSocket(socketUrl);
  const timeout = setTimeout(() => {
    socket.terminate();
    reject(new Error(`timed out connecting to ${socketUrl}`));
  }, 5_000);

  socket.once('open', () => {
    clearTimeout(timeout);
    socket.close(1000, 'Smoke test complete');
    resolve();
  });
  socket.once('error', error => {
    clearTimeout(timeout);
    reject(error);
  });
});

console.log('ok /multiplayer/socket');
