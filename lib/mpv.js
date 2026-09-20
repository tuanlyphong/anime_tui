import net from 'node:net';
import { EventEmitter } from 'node:events';

class MpvClient extends EventEmitter {
  constructor(socket, timeoutMs) {
    super();
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    let buffer = '';
    const onData = chunk => {
      buffer += chunk;
      let newline;
      while (!this.closed && (newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let reply;
        try {
          reply = JSON.parse(line);
          if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new Error('Expected object');
        } catch {
          this.disconnect(new Error('Invalid mpv JSON protocol message'));
          return;
        }
        if (Object.hasOwn(reply, 'request_id')) {
          const pending = this.pending.get(reply.request_id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(reply.request_id);
            if (reply.error && reply.error !== 'success') pending.reject(new Error(`mpv: ${reply.error}`));
            else pending.resolve(reply.data);
          }
        }
        if (typeof reply.event === 'string') this.emit(reply.event, reply);
      }
    };
    const onError = error => this.disconnect(error);
    const onEnd = () => this.disconnect(new Error('mpv IPC disconnected'));
    const onClose = () => {
      this.disconnect(new Error('mpv IPC disconnected'));
      buffer = '';
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
    };
    socket.setEncoding('utf8');
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);
    socket.once('close', onClose);
  }

  command(args) {
    if (this.closed) return Promise.reject(new Error('mpv IPC is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let message;
      try {
        if (!Array.isArray(args)) throw new TypeError('mpv command must be an array');
        message = JSON.stringify({ command: args, request_id: id }) + '\n';
      } catch (error) {
        reject(error);
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mpv command ${id} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(message, error => {
        if (error) this.disconnect(error);
      });
    });
  }

  disconnect(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.socket.destroy();
    this.emit('disconnect', error);
  }

  close() {
    this.disconnect(new Error('mpv IPC is closed'));
  }
}

// timeoutMs bounds initial connection and each command independently.
export function connectMpv(socketPath, { timeoutMs = 5000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new TypeError('timeoutMs must be finite and positive'));
  }
  return new Promise((resolve, reject) => {
    let socket;
    let retry;
    let settled = false;
    const deadline = setTimeout(() => finish(new Error('mpv IPC connection timed out')), timeoutMs);
    const finish = (error, client) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(retry);
      if (error) {
        socket?.destroy();
        reject(error);
      } else resolve(client);
    };
    const attempt = () => {
      if (settled) return;
      try {
        socket = net.createConnection(socketPath);
      } catch (error) {
        finish(error);
        return;
      }
      const current = socket;
      const onConnect = () => {
        current.off('error', onError);
        if (settled) return current.destroy();
        finish(null, new MpvClient(current, timeoutMs));
      };
      const onError = error => {
        current.off('connect', onConnect);
        current.destroy();
        if (settled) return;
        if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') retry = setTimeout(attempt, 25);
        else finish(error);
      };
      current.once('connect', onConnect);
      current.once('error', onError);
      current.once('close', () => {
        current.off('connect', onConnect);
        current.off('error', onError);
      });
    };
    attempt();
  });
}
