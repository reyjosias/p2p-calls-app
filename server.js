const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const clients = new Map(); // id -> { socket, name }

function broadcastUsers() {
  const list = Array.from(clients.entries()).map(([id, c]) => [id, c.name]);
  clients.forEach(c => send(c.socket, { type: 'users', list }));
}

function send(socket, data) {
  const json = Buffer.from(JSON.stringify(data));
  const len = json.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, json]));
}

function parse(buffer) {
  const second = buffer[1];
  let len = second & 0x7f;
  let offset = 2;
  if (len === 126) {
    len = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    len = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  const mask = buffer.slice(offset, offset + 4);
  offset += 4;
  const payload = buffer.slice(offset, offset + len);
  for (let i = 0; i < payload.length; i++) {
    payload[i] ^= mask[i % 4];
  }
  return payload.toString();
}

function handleMessage(id, msg) {
  let data;
  try { data = JSON.parse(msg); } catch { return; }
  const client = clients.get(id);
  if (!client) return;
  switch (data.type) {
    case 'register':
      client.name = data.name;
      broadcastUsers();
      break;
    case 'send-message':
      clients.forEach(c => send(c.socket, { type: 'message', from: client.name, text: data.text }));
      break;
    case 'call-user': {
      const target = clients.get(data.to);
      if (target) send(target.socket, { type: 'call-made', from: id, offer: data.offer });
      break;
    }
    case 'make-answer': {
      const target = clients.get(data.to);
      if (target) send(target.socket, { type: 'answer-made', from: id, answer: data.answer });
      break;
    }
    case 'end-call': {
      const target = clients.get(data.to);
      if (target) send(target.socket, { type: 'call-ended', from: id });
      break;
    }
  }
}

const server = http.createServer((req, res) => {
  const file = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(__dirname, 'public', file);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.end('HTTP/1.1 400 Bad Request');
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n' +
      '\r\n'
  );
  const id = Math.random().toString(36).slice(2);
  clients.set(id, { socket, name: '' });
  send(socket, { type: 'welcome', id });
  socket.on('data', (buf) => handleMessage(id, parse(buf)));
  socket.on('end', () => {
    clients.delete(id);
    broadcastUsers();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server running on port ' + PORT));
