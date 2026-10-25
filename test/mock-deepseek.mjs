/**
 * 模拟 DeepSeek /chat/completions 接口，用于本地自测（不消耗额度）。
 */
import http from 'node:http';

export class MockDeepSeek {
  constructor({ port = 18081, apiKey = 'test-key' } = {}) {
    this.port = port;
    this.apiKey = apiKey;
    this.requests = [];
    this.server = http.createServer((req, res) => this.#handle(req, res));
  }

  #json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  #handle(req, res) {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      this.#json(res, 404, { error: { message: 'not found' } });
      return;
    }
    if (this.apiKey && req.headers.authorization !== `Bearer ${this.apiKey}`) {
      this.#json(res, 401, { error: { message: 'invalid api key' } });
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        this.#json(res, 400, { error: { message: 'bad json' } });
        return;
      }
      this.requests.push(body);
      const messages = body.messages ?? [];
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      // 便于断言：回包里带上收到的消息条数
      let content = `【mock】收到「${lastUser}」，共 ${messages.length} 条消息`;
      if (/长文/.test(lastUser)) {
        content = '第一段。'.repeat(400); // 1600 字，触发分条
      }
      this.#json(res, 200, {
        id: 'mock-' + this.requests.length,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model ?? 'deepseek-chat',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });
    });
  }

  async start() {
    await new Promise((res, rej) => {
      this.server.once('error', rej);
      this.server.listen(this.port, '127.0.0.1', res);
    });
    return this;
  }

  async close() {
    await new Promise((r) => this.server.close(r));
  }
}
