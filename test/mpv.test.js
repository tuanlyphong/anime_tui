import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connectMpv } from '../lib/mpv.js';

async function fixture(t, onConnection, listen = true) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mpv-test-'));
  const socketPath = path.join(dir, 'ipc');
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    onConnection(socket);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  if (listen) {
    server.listen(socketPath);
    await once(server, 'listening');
  }
  return { socketPath, server };
}

function requests(socket, callback) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      callback(JSON.parse(line));
    }
  });
}

test('matches out-of-order replies across split/coalesced frames and forwards named events', async t => {
  const received = [];
  const { socketPath } = await fixture(t, socket => requests(socket, request => {
    received.push(request);
    if (received.length !== 2) return;
    const frames = [
      { request_id: received[1].request_id, error: 'success', data: 1420 },
      { event: 'property-change', name: 'time-pos', data: 754 },
      { request_id: received[0].request_id, error: 'success', data: 754 },
      { event: 'end-file', reason: 'eof' },
    ].map(frame => JSON.stringify(frame) + '\n').join('');
    socket.write(frames.slice(0, 13));
    setImmediate(() => socket.write(frames.slice(13)));
  }));
  const client = await connectMpv(socketPath);
  t.after(() => client.close());
  const property = once(client, 'property-change');
  const end = once(client, 'end-file');
  assert.deepEqual(await Promise.all([
    client.command(['get_property', 'time-pos']),
    client.command(['get_property', 'duration']),
  ]), [754, 1420]);
  assert.deepEqual(received.map(item => item.command), [
    ['get_property', 'time-pos'], ['get_property', 'duration'],
  ]);
  assert.notEqual(received[0].request_id, received[1].request_id);
  assert.equal((await property)[0].data, 754);
  assert.equal((await end)[0].reason, 'eof');
});

test('mpv reply errors reject only the matching command', async t => {
  const { socketPath } = await fixture(t, socket => requests(socket, request => {
    socket.write(JSON.stringify({ request_id: request.request_id, error: 'property unavailable' }) + '\n');
  }));
  const client = await connectMpv(socketPath);
  t.after(() => client.close());
  await assert.rejects(client.command(['get_property', 'missing']), /property unavailable/);
});

test('disconnect rejects pending commands and is emitted once', async t => {
  const { socketPath } = await fixture(t, socket => requests(socket, () => socket.end()));
  const client = await connectMpv(socketPath);
  let disconnects = 0;
  client.on('disconnect', () => disconnects++);
  await assert.rejects(client.command(['get_property', 'time-pos']), /disconnect|closed/i);
  client.close();
  await assert.rejects(client.command(['stop']), /disconnect|closed/i);
  assert.equal(disconnects, 1);
});

test('close rejects pending commands promptly and is idempotent', async t => {
  const { socketPath } = await fixture(t, () => {});
  const client = await connectMpv(socketPath);
  const pending = assert.rejects(client.command(['stop']), /closed/i);
  client.close();
  client.close();
  await pending;
});

test('commands time out without preventing subsequent replies', async t => {
  const { socketPath } = await fixture(t, socket => requests(socket, request => {
    if (request.command[0] === 'answered') {
      socket.write(JSON.stringify({ request_id: request.request_id, error: 'success', data: 42 }) + '\n');
    }
  }));
  const client = await connectMpv(socketPath, { timeoutMs: 60 });
  t.after(() => client.close());
  await assert.rejects(client.command(['ignored']), /timed out|timeout/i);
  assert.equal(await client.command(['answered']), 42);
});

test('retries a socket that does not exist yet', async t => {
  const { socketPath, server } = await fixture(t, () => {}, false);
  const connecting = connectMpv(socketPath, { timeoutMs: 1000 });
  await delay(60);
  server.listen(socketPath);
  await once(server, 'listening');
  const client = await connecting;
  client.close();
});

test('missing socket connection is bounded', async t => {
  const { socketPath } = await fixture(t, () => {}, false);
  const started = Date.now();
  await assert.rejects(connectMpv(socketPath, { timeoutMs: 70 }), /timed out|timeout/i);
  assert.ok(Date.now() - started < 1000);
});

test('invalid JSON disconnects and rejects pending commands', async t => {
  const { socketPath } = await fixture(t, socket => requests(socket, () => socket.write('not json\n')));
  const client = await connectMpv(socketPath);
  t.after(() => client.close());
  await assert.rejects(client.command(['stop']), /JSON|protocol/i);
});
