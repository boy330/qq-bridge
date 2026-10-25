/**
 * 极简 OneBot v11 协议端（仅供本地端到端自测，不用于生产）
 * 实现：HTTP Upgrade + RFC6455 文本帧、send_group_msg / get_login_info。
 */
import http from 'node:http';
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

/** 从缓冲区里尽量多地解析帧，返回 [消息数组, 剩余缓冲] */
function decodeFrames(buf) {
  const out = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (p + 2 > buf.length) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (p + 8 > buf.length) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    let maskKey = null;
    if (masked) {
      if (p + 4 > buf.length) break;
      maskKey = buf.subarray(p, p + 4);
      p += 4;
    }
    if (p + len > buf.length) break;
    let payload = Buffer.from(buf.subarray(p, p + len));
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }
    out.push({ fin, opcode, payload });
    off = p + len;
  }
  return [out, buf.subarray(off)];
}

export class MockOneBot {
  constructor({ port = 18080, token = '', selfId = 10001, nickname = '测试机器人' } = {}) {
    this.port = port;
    this.token = token;
    this.selfId = selfId;
    this.nickname = nickname;
    this.sockets = new Set();
    this.sent = [];
    this.actions = [];
    this.connections = 0;
    this.nextMessageId = 1000;
    this.server = http.createServer((req, res) => {
      res.writeHead(404).end();
    });
    this.server.on('upgrade', (req, socket) => this.#upgrade(req, socket));
  }

  #upgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (this.token) {
      const auth = req.headers['authorization'] ?? '';
      const url = new URL(req.url, 'http://localhost');
      const q = url.searchParams.get('access_token') ?? '';
      const ok = auth === `Bearer ${this.token}` || q === this.token;
      if (!ok) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return;
      }
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    this.sockets.add(socket);
    this.connections += 1;

    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const [frames, rest] = decodeFrames(buf);
      buf = rest;
      for (const f of frames) {
        if (f.opcode === 0x8) {
          socket.end();
        } else if (f.opcode === 0x9) {
          socket.write(encodeFrame(f.payload, 0xa));
        } else if (f.opcode === 0x1) {
          this.#onText(f.payload.toString('utf8'));
        }
      }
    });
    socket.on('error', () => this.sockets.delete(socket));
    socket.on('close', () => this.sockets.delete(socket));
  }

  #onText(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const { action, params = {}, echo } = msg;
    this.actions.push({ action, params });
    let data = {};
    if (action === 'get_login_info') {
      data = { user_id: this.selfId, nickname: this.nickname };
    } else if (action === 'send_group_msg' || action === 'send_private_msg') {
      data = { message_id: this.nextMessageId++ };
      this.sent.push({ action, params, data });
    } else if (action === 'get_group_list') {
      data = [{ group_id: 123456, group_name: '测试群' }];
    } else if (action === 'get_status') {
      data = { online: true, good: true };
    }
    this.#send(echo === undefined ? {} : { status: 'ok', retcode: 0, data, echo });
  }

  #send(obj) {
    const frame = encodeFrame(JSON.stringify(obj));
    for (const s of this.sockets) {
      if (!s.destroyed) s.write(frame);
    }
  }

  /** 向机器人推送一个事件 */
  pushEvent(ev) {
    this.#send({ ...ev, self_id: ev.self_id ?? this.selfId, time: Math.floor(Date.now() / 1000) });
  }

  /** 构造群消息事件 */
  groupMessage({ groupId = 123456, userId = 222, messageId = 1, message, plainText = '' } = {}) {
    return {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: messageId,
      group_id: groupId,
      user_id: userId,
      raw_message: plainText,
      message,
      font: 0,
      sender: { user_id: userId, nickname: '测试用户', card: '', role: 'member' },
    };
  }

  async start() {
    await new Promise((res, rej) => {
      this.server.once('error', rej);
      this.server.listen(this.port, '127.0.0.1', res);
    });
    return this;
  }

  async waitForConnection(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (this.sockets.size === 0) {
      if (Date.now() > deadline) throw new Error('等待机器人连接超时');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async waitForSent(count, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (this.sent.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`等待第 ${count} 条发送超时（当前 ${this.sent.length} 条）`);
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    return this.sent[count - 1];
  }

  async close() {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise((r) => this.server.close(r));
  }
}
