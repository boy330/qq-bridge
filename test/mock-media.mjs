/**
 * 模拟硅基流动的语音 / 生图接口（OpenAI 兼容路径），用于本地自测。
 *   POST /audio/transcriptions   -> { text }
 *   POST /audio/speech           -> mp3 字节
 *   POST /images/generations     -> { images: [{ url }] }
 *   GET  /img.png                -> 1x1 PNG
 *   GET  /voice.mp3              -> 假音频
 */
import http from 'node:http';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const MP3 = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00fake-mp3-payload', 'binary');

export class MockMedia {
  constructor({ port = 18083, apiKey = 'test-key', transcript = '今天天气怎么样' } = {}) {
    this.port = port;
    this.apiKey = apiKey;
    this.transcript = transcript;
    this.requests = { asr: [], tts: [], image: [] };
    this.server = http.createServer((req, res) => this.#handle(req, res));
  }

  #json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  #bytes(res, type, buf) {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length });
    res.end(buf);
  }

  #handle(req, res) {
    const url = req.url.split('?')[0];

    if (req.method === 'GET' && url === '/img.png') return this.#bytes(res, 'image/png', PNG);
    if (req.method === 'GET' && url === '/voice.mp3') return this.#bytes(res, 'audio/mpeg', MP3);

    if (this.apiKey && req.headers.authorization !== `Bearer ${this.apiKey}`) {
      return this.#json(res, 401, { error: { message: 'invalid api key' } });
    }

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);

      if (req.method === 'POST' && url === '/audio/transcriptions') {
        this.requests.asr.push({ size: raw.length, contentType: req.headers['content-type'] ?? '' });
        return this.#json(res, 200, { text: this.transcript });
      }

      if (req.method === 'POST' && url === '/audio/speech') {
        let body = {};
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          /* ignore */
        }
        this.requests.tts.push(body);
        return this.#bytes(res, 'audio/mpeg', MP3);
      }

      if (req.method === 'POST' && url === '/images/generations') {
        let body = {};
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          /* ignore */
        }
        this.requests.image.push(body);
        return this.#json(res, 200, {
          images: [{ url: `http://127.0.0.1:${this.port}/img.png` }],
          timings: { inference: 1 },
          seed: 42,
        });
      }

      this.#json(res, 404, { error: { message: 'not found' } });
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
