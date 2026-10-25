#!/usr/bin/env node
/**
 * qq-bridge —— 把 QQ 群 / 私聊接到 DeepSeek 的 OneBot v11 客户端（正向 WebSocket）
 *
 * 零第三方依赖，要求 Node.js >= 22（内置 WebSocket / fetch）。
 * 协议端推荐 NapCatQQ（见 README.md）。
 *
 * 用法：
 *   node bot.mjs                     # 读取同目录 config.json
 *   node bot.mjs --config ./x.json   # 指定配置
 *
 * 环境变量优先于配置文件：
 *   DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_MODEL
 *   ONEBOT_WS_URL / ONEBOT_ACCESS_TOKEN
 *   SILICONFLOW_API_KEY / SPEECH_API_KEY / IMAGE_API_KEY
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STARTED_AT = Date.now();
const VERSION = '1.0.0';

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

const DEFAULTS = {
  onebot: {
    url: 'ws://127.0.0.1:3001',
    accessToken: '',
    reconnectMinMs: 3000,
    reconnectMaxMs: 60000,
    apiTimeoutMs: 15000,
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.7,
    maxTokens: 800,
    timeoutMs: 60000,
    maxRetries: 2,
    systemPrompt:
      '你是一个 QQ 群里的 AI 助手，说话简洁、友好、口语化。' +
      '群聊场景下不要使用 Markdown 表格和长代码块，回答尽量控制在 300 字以内。',
  },
  trigger: {
    at: true,                       // @机器人 触发
    replyToBot: true,               // 引用/回复机器人的消息触发
    prefixes: ['/ai', 'ai:', 'AI:'], // 文字前缀触发
    requireAtInGroup: false,        // true = 群里只认 @，忽略前缀
  },
  reply: {
    quote: false,     // 是否以“引用回复”形式发出
    atUser: true,     // 回复时 @ 提问者
    maxChars: 1200,   // 单条上限，超长自动分条
    maxParts: 3,      // 最多分几条
  },
  policy: {
    allowedGroups: [],    // 为空 = 所有群；否则仅这些群号生效
    blockedUsers: [],     // 拉黑 QQ 号
    contextScope: 'user', // 'user' = 群内每人独立上下文；'group' = 整群共享
    maxContextTurns: 6,   // 保留几轮对话
    contextTtlMinutes: 60,// 上下文闲置多久后自动丢弃
    cooldownSeconds: 2,   // 同一用户两次请求最小间隔
    maxInputChars: 2000,  // 单次提问长度上限
    allowPrivate: false,  // 是否响应私聊
  },
  log: { level: 'info', file: 'logs/bot.log', rotateBytes: 5 * 1024 * 1024 },

  // 媒体文件怎么交给协议端：
  //   file   = 落到本地临时文件，用 file:/// 路径（机器人跟 NapCat 同机时最省流量）
  //   base64 = 直接内联进消息段（跨机器可用，但大图会撑大 WebSocket 帧）
  media: {
    tempDir: 'tmp',
    transport: 'file',
    maxBytes: 8 * 1024 * 1024,
  },

  // 语音：TTS 把回答念出来；ASR 把群友语音转成文字（硅基流动，OpenAI 兼容）
  speech: {
    enabled: false,
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    ttsModel: 'FunAudioLLM/CosyVoice2-0.5B',
    voice: 'FunAudioLLM/CosyVoice2-0.5B:anna',
    speed: 1.0,
    maxChars: 300,        // 超过这个长度就不念了，直接发文字
    replyMode: 'on-voice-input', // on-voice-input = 收到语音才用语音回；always = 总是语音回
    asrModel: 'FunAudioLLM/SenseVoiceSmall',
  },

  // 画图：/draw 提示词
  image: {
    enabled: false,
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: '',           // 留空则复用 speech.apiKey
    model: 'Kwai-Kolors/Kolors',
    size: '1024x1024',
    steps: 20,
    guidance: 7.5,
    negativePrompt: '',
    prefixes: ['/draw', '/画', '画图'],
    timeoutMs: 120000,
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

function loadConfig() {
  const argv = process.argv.slice(2);
  const cfgIdx = argv.indexOf('--config');
  const explicit = cfgIdx >= 0 ? argv[cfgIdx + 1] : null;
  const candidates = explicit
    ? [path.resolve(ROOT, explicit)]
    : [path.join(ROOT, 'config.json'), path.join(ROOT, 'config.example.json')];

  let raw = {};
  let used = null;
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        used = file;
        break;
      } catch (e) {
        console.error(`配置文件 ${file} 解析失败：${e.message}`);
        process.exit(1);
      }
    }
  }
  if (!used) {
    console.error(`找不到配置文件：${candidates.join(' 或 ')}`);
    process.exit(1);
  }

  const cfg = deepMerge(DEFAULTS, raw);
  if (used.endsWith('config.example.json')) {
    console.warn('[warn] 正在使用 config.example.json，建议复制为 config.json 后修改');
  }

  const env = process.env;
  if (env.DEEPSEEK_API_KEY) cfg.deepseek.apiKey = env.DEEPSEEK_API_KEY;
  if (env.DEEPSEEK_BASE_URL) cfg.deepseek.baseUrl = env.DEEPSEEK_BASE_URL;
  if (env.DEEPSEEK_MODEL) cfg.deepseek.model = env.DEEPSEEK_MODEL;
  if (env.ONEBOT_WS_URL) cfg.onebot.url = env.ONEBOT_WS_URL;
  if (env.ONEBOT_ACCESS_TOKEN !== undefined) cfg.onebot.accessToken = env.ONEBOT_ACCESS_TOKEN;
  if (env.SILICONFLOW_API_KEY) {
    if (!cfg.speech.apiKey) cfg.speech.apiKey = env.SILICONFLOW_API_KEY;
    if (!cfg.image.apiKey) cfg.image.apiKey = env.SILICONFLOW_API_KEY;
  }
  if (env.SPEECH_API_KEY) cfg.speech.apiKey = env.SPEECH_API_KEY;
  if (env.IMAGE_API_KEY) cfg.image.apiKey = env.IMAGE_API_KEY;

  if (!cfg.deepseek.apiKey || /^(sk-)?(your|填写|这里|在这|在此)/i.test(cfg.deepseek.apiKey)) {
    console.error(
      '\n[错误] 没有可用的 DeepSeek API Key。\n' +
        '  1) 打开 https://platform.deepseek.com/api_keys 创建 Key（sk- 开头）\n' +
        '  2) 写进 config.json 的 deepseek.apiKey，或设置环境变量 DEEPSEEK_API_KEY\n',
    );
    process.exit(2);
  }

  // 语音/画图是可选能力：没配 Key 就自动关掉，不影响文字对话
  const usableKey = (k) => !!k && !/^(sk-)?(your|填写|这里|在这|在此)/i.test(String(k));
  if (!cfg.image.apiKey) cfg.image.apiKey = cfg.speech.apiKey;
  if (cfg.speech.enabled && !usableKey(cfg.speech.apiKey)) {
    console.warn('[warn] speech.enabled=true 但没有可用的 apiKey，语音与语音识别已关闭');
    cfg.speech.enabled = false;
  }
  if (cfg.image.enabled && !usableKey(cfg.image.apiKey)) {
    console.warn('[warn] image.enabled=true 但没有可用的 apiKey，画图已关闭');
    cfg.image.enabled = false;
  }

  return { cfg, configPath: used };
}

/* ------------------------------------------------------------------ */
/* 日志                                                                */
/* ------------------------------------------------------------------ */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(cfg) {
  const min = LEVELS[cfg.log.level] ?? LEVELS.info;
  const file = path.resolve(ROOT, cfg.log.file);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    /* 日志目录不可用就只输出控制台 */
  }

  const rotate = () => {
    try {
      if (fs.statSync(file).size > cfg.log.rotateBytes) {
        fs.renameSync(file, `${file}.1`);
      }
    } catch {
      /* 文件不存在等忽略 */
    }
  };
  let sinceRotate = 0;

  const write = (level, args) => {
    if (LEVELS[level] < min) return;
    const ts = new Date().toLocaleString('zh-CN', { hour12: false });
    const body = args
      .map((a) => (a instanceof Error ? (a.stack ?? String(a)) : typeof a === 'string' ? a : safeJson(a)))
      .join(' ');
    const line = `[${ts}] [${level.toUpperCase()}] ${body}`;
    (level === 'error' ? console.error : console.log)(line);
    try {
      fs.appendFileSync(file, line + '\n');
      if (++sinceRotate > 200) {
        sinceRotate = 0;
        rotate();
      }
    } catch {
      /* 忽略写日志失败 */
    }
  };

  return {
    debug: (...a) => write('debug', a),
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
  };
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* OneBot v11 客户端                                                   */
/* ------------------------------------------------------------------ */

class OneBotClient {
  constructor({ url, accessToken, log, apiTimeoutMs, onEvent, onReady, onDown }) {
    this.url = url;
    this.accessToken = accessToken;
    this.log = log;
    this.apiTimeoutMs = apiTimeoutMs;
    this.onEvent = onEvent;
    this.onReady = onReady;
    this.onDown = onDown;

    this.ws = null;
    this.pending = new Map();
    this.seq = 0;
    this.closed = false;
    this.retry = 0;
    this.connectedAt = 0;
  }

  start() {
    this.#connect();
  }

  #connect() {
    if (this.closed) return;
    let ws;
    try {
      // Node 内置 WebSocket 不会发送 options.headers，改用 OneBot 规范的 ?access_token= 查询参数
      let url = this.url;
      if (this.accessToken) {
        const u = new URL(url);
        u.searchParams.set('access_token', this.accessToken);
        url = u.toString();
      }
      ws = new WebSocket(url);
    } catch (e) {
      this.log.error(`建连失败：${e.message}`);
      return this.#scheduleReconnect();
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.retry = 0;
      this.connectedAt = Date.now();
      this.log.info(`已连接到 OneBot 协议端 ${this.url}`);
      this.onReady?.();
    });

    ws.addEventListener('message', (ev) => this.#onMessage(ev.data));

    ws.addEventListener('error', (ev) => {
      const msg = ev?.message ?? ev?.error?.message ?? 'WebSocket 错误';
      // NapCat 未启动时这里会频繁报错，交给 close 统一重连
      this.log.debug(`WS 错误：${msg}`);
    });

    ws.addEventListener('close', (ev) => {
      this.log.warn(`连接断开（code=${ev.code}），准备重连`);
      this.#rejectAll(new Error('连接已断开'));
      this.onDown?.();
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    if (this.closed) return;
    const base = Math.min(
      this.cfgMaxMs ?? 60000,
      Math.max(1000, (this.retryBaseMs ?? 3000) * 2 ** Math.min(this.retry, 5)),
    );
    const delay = base + Math.floor(Math.random() * 500);
    this.retry += 1;
    setTimeout(() => this.#connect(), delay);
  }

  setReconnectRange(minMs, maxMs) {
    this.retryBaseMs = minMs;
    this.cfgMaxMs = maxMs;
  }

  #onMessage(raw) {
    let data;
    try {
      data = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
    } catch {
      this.log.debug('收到无法解析的消息，已忽略');
      return;
    }
    if (data && data.echo !== undefined && this.pending.has(data.echo)) {
      const { resolve, reject, timer } = this.pending.get(data.echo);
      this.pending.delete(data.echo);
      clearTimeout(timer);
      if (data.status === 'failed' || (data.retcode !== undefined && data.retcode !== 0)) {
        reject(new Error(`API ${data.retcode ?? ''} ${data.msg ?? data.wording ?? '调用失败'}`));
      } else {
        resolve(data.data);
      }
      return;
    }
    if (data && data.post_type) {
      try {
        this.onEvent?.(data);
      } catch (e) {
        this.log.error('事件处理异常：', e);
      }
    }
  }

  call(action, params = {}, timeoutMs = this.apiTimeoutMs) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('尚未连接到协议端'));
    }
    const echo = `dsh_${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`调用 ${action} 超时`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ action, params, echo }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(e);
      }
    });
  }

  #rejectAll(err) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  close() {
    this.closed = true;
    this.#rejectAll(new Error('客户端已关闭'));
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  get online() {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

/* ------------------------------------------------------------------ */
/* 文本工具                                                            */
/* ------------------------------------------------------------------ */

/** 把 OneBot 消息段数组压成纯文本，非文字段用占位符代替 */
function segmentsToText(segments) {
  const parts = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text':
        parts.push(d.text ?? '');
        break;
      case 'at':
        parts.push(d.qq === 'all' ? '@全体成员' : `@${d.qq ?? ''}`);
        break;
      case 'image':
        parts.push('[图片]');
        break;
      case 'face':
        parts.push('[表情]');
        break;
      case 'record':
        parts.push('[语音]');
        break;
      case 'video':
        parts.push('[视频]');
        break;
      case 'file':
        parts.push(`[文件${d.name ? ':' + d.name : ''}]`);
        break;
      case 'reply':
        break;
      case 'forward':
        parts.push('[合并转发]');
        break;
      case 'json':
      case 'xml':
        parts.push('[卡片消息]');
        break;
      default:
        break;
    }
  }
  return parts.join('');
}

/** 按行/长度切分长回复 */
function splitMessage(text, limit, maxParts) {
  const parts = [];
  let rest = text.trim();
  while (rest.length > limit && parts.length < maxParts) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.4) cut = rest.lastIndexOf('。', limit);
    if (cut < limit * 0.4) cut = limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.slice(0, maxParts);
}

/* ------------------------------------------------------------------ */
/* DeepSeek                                                            */
/* ------------------------------------------------------------------ */

class DeepSeekError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'DeepSeekError';
    this.status = status;
    this.retryable = retryable;
  }
}

async function chatCompletion(cfg, messages, log) {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  let lastErr = null;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    if (attempt > 0) {
      const wait = 1000 * 2 ** (attempt - 1);
      log.warn(`第 ${attempt} 次重试（${wait}ms 后）：${lastErr?.message}`);
      await sleep(wait);
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          temperature: cfg.temperature,
          max_tokens: cfg.maxTokens,
          stream: false,
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const retryable = res.status === 429 || res.status >= 500;
        throw new DeepSeekError(`HTTP ${res.status} ${body.slice(0, 200)}`, {
          status: res.status,
          retryable,
        });
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new DeepSeekError('模型返回了空内容', { retryable: true });
      }
      log.debug(`token 用量：${safeJson(data.usage ?? {})}`);
      return content.trim();
    } catch (e) {
      lastErr = e;
      const isTimeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      const isNet = e instanceof TypeError;
      if (!(e instanceof DeepSeekError)) {
        if (!isTimeout && !isNet) throw e;
        lastErr = new DeepSeekError(isTimeout ? '请求超时' : `网络错误：${e.message}`, {
          retryable: true,
        });
      } else if (!e.retryable) {
        throw e;
      }
    }
  }
  throw lastErr ?? new Error('调用失败');
}

/* ------------------------------------------------------------------ */
/* 可选能力：语音识别 / 语音合成 / 生图                                  */
/* ------------------------------------------------------------------ */

/** 带 429/5xx 重试的 JSON POST */
async function postJson(url, { apiKey, body, timeoutMs = 60000, log }) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(1500);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 200);
        const err = new Error(`HTTP ${res.status} ${text}`);
        err.status = res.status;
        err.retryable = res.status === 429 || res.status >= 500;
        throw err;
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (!e.retryable) throw e;
      log?.warn(`接口重试（${url}）：${e.message}`);
    }
  }
  throw lastErr;
}

/** 语音转文字（OpenAI 兼容 /audio/transcriptions） */
async function transcribeAudio(cfg, audio, filename, log) {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions';
  const form = new FormData();
  form.append('file', new Blob([audio]), filename || 'voice.mp3');
  form.append('model', cfg.asrModel);

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    throw new Error(`ASR HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  const json = await res.json();
  const text = String(json?.text ?? json?.result ?? '').trim();
  if (!text) throw new Error('ASR 返回空文本');
  log.debug(`语音识别结果：${text}`);
  return text;
}

/** 文字转语音（OpenAI 兼容 /audio/speech），返回 mp3 字节 */
async function synthesizeSpeech(cfg, text, log) {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/audio/speech';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.ttsModel,
      input: text,
      voice: cfg.voice,
      response_format: 'mp3',
      speed: cfg.speed,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    throw new Error(`TTS HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('TTS 返回空音频');
  log.debug(`TTS 生成 ${buf.length} 字节`);
  return buf;
}

/** 生图（OpenAI 兼容 /images/generations），返回图片字节 */
async function generateImage(cfg, prompt, log) {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/images/generations';
  const payload = {
    model: cfg.model,
    prompt,
    image_size: cfg.size,
    batch_size: 1,
    num_inference_steps: cfg.steps,
    guidance_scale: cfg.guidance,
  };
  if (cfg.negativePrompt) payload.negative_prompt = cfg.negativePrompt;

  const json = await postJson(url, { apiKey: cfg.apiKey, body: payload, timeoutMs: cfg.timeoutMs, log });
  const item = json?.images?.[0] ?? json?.data?.[0];
  if (!item) throw new Error('生图接口没有返回图片');
  if (item.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (!item.url) throw new Error('生图接口没有返回图片地址');

  const res = await fetch(item.url, { signal: AbortSignal.timeout(cfg.timeoutMs) });
  if (!res.ok) throw new Error(`下载图片失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('下载到的图片为空');
  log.debug(`生图完成 ${buf.length} 字节`);
  return buf;
}

/** 绝对路径 -> OneBot 能认的 file:/// 形式 */
function toFileUri(absPath) {
  return 'file:///' + absPath.replace(/\\/g, '/').replace(/^\/+/, '');
}

/* ------------------------------------------------------------------ */
/* 机器人                                                              */
/* ------------------------------------------------------------------ */

class Bot {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.selfId = null;
    this.nickname = '';
    this.histories = new Map(); // key -> { messages: [], lastUsed: ts }
    this.cooldowns = new Map(); // userId -> ts
    this.voiceChats = new Map(); // 会话 key -> 是否用语音回复
    this.queues = new Map();    // groupId -> Promise
    this.sentIds = new Set();   // 机器人发出消息的 message_id，用于“引用触发”
    this.sentOrder = [];
    this.stats = { handled: 0, replies: 0, errors: 0 };

    this.client = new OneBotClient({
      url: cfg.onebot.url,
      accessToken: cfg.onebot.accessToken,
      apiTimeoutMs: cfg.onebot.apiTimeoutMs,
      log,
      onEvent: (ev) => this.#onEvent(ev),
      onReady: () => this.#onReady(),
      onDown: () => {},
    });
    this.client.setReconnectRange(cfg.onebot.reconnectMinMs, cfg.onebot.reconnectMaxMs);
  }

  start() {
    this.log.info(`qq-bridge v${VERSION} 启动，模型=${this.cfg.deepseek.model}`);
    if (this.cfg.speech.enabled) {
      this.log.info(`语音：开（TTS ${this.cfg.speech.ttsModel} / ASR ${this.cfg.speech.asrModel}）`);
    }
    if (this.cfg.image.enabled) this.log.info(`画图：开（${this.cfg.image.model}）`);
    this.client.start();
    this.gcTimer = setInterval(() => this.#gc(), 60_000);
    this.gcTimer.unref?.();
  }

  stop() {
    clearInterval(this.gcTimer);
    this.client.close();
  }

  async #onReady() {
    try {
      const info = await this.client.call('get_login_info');
      if (info?.user_id) {
        this.selfId = String(info.user_id);
        this.nickname = info.nickname ?? '';
        this.log.info(`登录账号：${this.nickname}（${this.selfId}）`);
      }
    } catch (e) {
      this.log.warn(`获取登录信息失败（不影响使用）：${e.message}`);
    }
  }

  /* --------------------------- 事件入口 --------------------------- */

  #onEvent(ev) {
    if (ev.post_type === 'meta_event') {
      if (ev.meta_event_type === 'lifecycle') this.log.debug(`生命周期：${ev.sub_type}`);
      return;
    }
    if (ev.self_id && !this.selfId) this.selfId = String(ev.self_id);
    if (ev.post_type !== 'message') return;

    const isGroup = ev.message_type === 'group';
    if (!isGroup && !this.cfg.policy.allowPrivate) return;
    if (!isGroup && this.cfg.policy.allowPrivate) {
      /* 私聊也走同一套逻辑，key 用 p:userId */
    }

    if (this.selfId && String(ev.user_id) === this.selfId) return; // 自己的消息

    const groupId = isGroup ? String(ev.group_id) : null;
    if (isGroup) {
      const allow = this.cfg.policy.allowedGroups.map(String);
      if (allow.length && !allow.includes(groupId)) {
        this.log.debug(`群 ${groupId} 不在白名单，忽略`);
        return;
      }
    }

    const userId = String(ev.user_id);
    if (this.cfg.policy.blockedUsers.map(String).includes(userId)) return;

    const parsed = this.#parseTrigger(ev);
    if (!parsed.triggered) return;

    this.stats.handled += 1;
    this.log.info(
      `[${isGroup ? '群' + groupId : '私聊'}] ${ev.sender?.card || ev.sender?.nickname || userId}: ${parsed.text || '(空)'}`,
    );

    const queueKey = isGroup ? `g:${groupId}` : `p:${userId}`;
    this.#enqueue(queueKey, () => this.#handle(ev, parsed, { isGroup, groupId, userId }));
  }

  #enqueue(key, task) {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(task, task).catch((e) => {
      this.log.error('任务异常：', e);
    });
    this.queues.set(key, next);
    next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
  }

  #parseTrigger(ev) {
    const selfId = this.selfId;
    const cfg = this.cfg.trigger;
    let mentioned = false;
    let quotedBot = false;
    const textParts = [];
    const voiceFiles = [];

    for (const seg of Array.isArray(ev.message) ? ev.message : []) {
      const d = seg?.data ?? {};
      if (seg?.type === 'at') {
        if (selfId && String(d.qq) === selfId) mentioned = true;
        else textParts.push(d.qq === 'all' ? '@全体成员' : `@${d.qq ?? ''}`);
      } else if (seg?.type === 'reply') {
        if (this.sentIds.has(String(d.id))) quotedBot = true;
      } else if (seg?.type === 'text') {
        textParts.push(d.text ?? '');
      } else if (seg?.type === 'image') {
        textParts.push('[图片]');
      } else if (seg?.type === 'face') {
        textParts.push('[表情]');
      } else if (seg?.type === 'record') {
        textParts.push('[语音]');
        voiceFiles.push({ file: d.file, url: d.url, path: d.path });
      } else if (seg?.type === 'forward') {
        textParts.push('[合并转发]');
      } else if (seg?.type === 'file') {
        textParts.push('[文件]');
      }
    }

    let text = textParts.join('').trim();
    let prefixed = false;
    for (const p of cfg.prefixes ?? []) {
      if (p && text.toLowerCase().startsWith(String(p).toLowerCase())) {
        text = text.slice(String(p).length).trim();
        prefixed = true;
        break;
      }
    }

    const atOn = cfg.at !== false && mentioned;
    const quoteOn = cfg.replyToBot !== false && quotedBot;
    const prefixOn = !cfg.requireAtInGroup && prefixed;

    return {
      triggered: atOn || quoteOn || prefixOn,
      text,
      mentioned,
      quotedBot,
      prefixed,
      voiceFiles,
      hadVoice: voiceFiles.length > 0,
    };
  }

  /* --------------------------- 主处理 ----------------------------- */

  async #handle(ev, parsed, ctx) {
    const { isGroup, groupId, userId } = ctx;
    let text = parsed.text;

    // 整条消息只有语音：先转写成文字再当提问
    if (parsed.voiceFiles.length && !text.replace(/\[语音\]/g, '').trim()) text = '';
    if (!text && parsed.voiceFiles.length) {
      if (!this.cfg.speech.enabled) {
        await this.#send(ctx, ev, '语音识别没启用，先打字问我吧。');
        return;
      }
      const spoken = await this.#transcribeVoice(parsed.voiceFiles[0], ctx, ev);
      if (spoken === null) return;
      text = spoken;
    }

    if (!text) {
      await this.#send(ctx, ev, this.#helpText());
      return;
    }
    if (text.length > this.cfg.policy.maxInputChars) {
      await this.#send(ctx, ev, `内容太长了（${text.length} 字），请控制在 ${this.cfg.policy.maxInputChars} 字以内。`);
      return;
    }

    // 指令
    const cmd = text.toLowerCase();
    if (['重置', '清空', 'reset', '/reset', '清除上下文'].includes(cmd)) {
      this.histories.delete(this.#historyKey(ctx));
      await this.#send(ctx, ev, '好的，本轮对话上下文已清空。');
      return;
    }
    if (['帮助', 'help', '/help', '?', '？'].includes(cmd)) {
      await this.#send(ctx, ev, this.#helpText());
      return;
    }
    if (['/voice', '!voice'].includes(cmd)) {
      if (!this.cfg.speech.enabled) {
        await this.#send(ctx, ev, '语音功能没启用（缺少语音服务 Key）。');
        return;
      }
      const vk = this.#historyKey(ctx);
      const on = !this.voiceChats.get(vk);
      if (on) this.voiceChats.set(vk, true);
      else this.voiceChats.delete(vk);
      await this.#send(ctx, ev, on ? '好的，之后我用语音回你。' : '好的，之后我用文字回你。');
      return;
    }
    if (['状态', 'status', '/status'].includes(cmd)) {
      const h = this.histories.get(this.#historyKey(ctx));
      const up = Math.floor((Date.now() - STARTED_AT) / 1000);
      await this.#send(
        ctx,
        ev,
        `模型：${this.cfg.deepseek.model}\n` +
          `上下文：${h ? Math.floor(h.messages.length / 2) : 0} 轮\n` +
          `已处理：${this.stats.handled} 条，回复 ${this.stats.replies} 条\n` +
          `在线时长：${Math.floor(up / 3600)} 小时 ${Math.floor((up % 3600) / 60)} 分`,
      );
      return;
    }

    // 冷却
    const cd = this.cfg.policy.cooldownSeconds * 1000;
    const last = this.cooldowns.get(userId) ?? 0;
    if (cd > 0 && Date.now() - last < cd) {
      this.log.debug(`用户 ${userId} 触发冷却，忽略`);
      return;
    }
    this.cooldowns.set(userId, Date.now());

    // 画图指令：/draw 一只戴墨镜的橘猫
    if (this.cfg.image.enabled) {
      const prompt = this.#matchImagePrompt(text);
      if (prompt !== null) {
        await this.#handleDraw(prompt, ctx, ev);
        return;
      }
    }

    // 组装消息
    const key = this.#historyKey(ctx);
    const entry = this.histories.get(key) ?? { messages: [], lastUsed: 0 };
    const history = entry.messages.slice(-this.cfg.policy.maxContextTurns * 2);
    const messages = [
      { role: 'system', content: this.cfg.deepseek.systemPrompt },
      ...history,
      { role: 'user', content: text },
    ];

    try {
      const answer = await chatCompletion(this.cfg.deepseek, messages, this.log);

      entry.messages = [...history, { role: 'user', content: text }, { role: 'assistant', content: answer }].slice(
        -this.cfg.policy.maxContextTurns * 2,
      );
      entry.lastUsed = Date.now();
      this.histories.set(key, entry);
      this.stats.replies += 1;

      // 该用语音回吗？—— 收到语音、会话开了 /voice、或配置成总是语音
      const wantVoice =
        this.cfg.speech.enabled &&
        (this.cfg.speech.replyMode === 'always' || parsed.hadVoice || this.voiceChats.get(key));
      if (wantVoice && answer.length <= this.cfg.speech.maxChars) {
        try {
          const audio = await synthesizeSpeech(this.cfg.speech, answer, this.log);
          if (await this.#sendMedia(ctx, 'record', audio, 'mp3')) return;
        } catch (e) {
          this.log.warn(`语音合成失败，回落为文字：${e.message}`);
        }
      }

      for (const part of splitMessage(answer, this.cfg.reply.maxChars, this.cfg.reply.maxParts)) {
        await this.#send(ctx, ev, part);
      }
    } catch (e) {
      this.stats.errors += 1;
      this.log.error(`请求模型失败：${e.message}`);
      if (e.status === 401 || e.status === 403) {
        await this.#send(ctx, ev, '机器人配置的 API Key 无效，请联系管理员。');
      } else if (e.status === 402) {
        await this.#send(ctx, ev, 'AI 额度不足，请联系管理员充值。');
      } else if (e.status === 429) {
        await this.#send(ctx, ev, '请求太频繁了，稍等一下再问我吧。');
      } else {
        await this.#send(ctx, ev, '模型暂时不可用，请稍后再试。');
      }
    }
  }

  /** 取语音文件并转写；失败时已发提示，返回 null */
  async #transcribeVoice(seg, ctx, ev) {
    let buf = null;
    try {
      if (seg.url && /^https?:/i.test(seg.url)) {
        const res = await fetch(seg.url, { signal: AbortSignal.timeout(30000) });
        if (res.ok) buf = Buffer.from(await res.arrayBuffer());
      }
      if ((!buf || !buf.length) && seg.file) {
        const res = await this.client.call('get_record', { file: seg.file, out_format: 'mp3' });
        const local = res?.file ?? res?.path;
        if (res?.base64) buf = Buffer.from(res.base64, 'base64');
        else if (local && fs.existsSync(local)) buf = fs.readFileSync(local);
      }
    } catch (e) {
      this.log.warn(`取语音文件失败：${e.message}`);
    }

    if (!buf || !buf.length) {
      await this.#send(ctx, ev, '没能取到这条语音，麻烦打字或重发一次。');
      return null;
    }
    try {
      return await transcribeAudio(this.cfg.speech, buf, 'voice.mp3', this.log);
    } catch (e) {
      this.log.error(`语音识别失败：${e.message}`);
      await this.#send(ctx, ev, '语音识别失败了，直接打字问我吧。');
      return null;
    }
  }

  /** 命中画图前缀则返回提示词，否则 null */
  #matchImagePrompt(text) {
    const lower = text.toLowerCase();
    for (const p of this.cfg.image.prefixes ?? []) {
      const key = String(p).toLowerCase();
      if (key && lower.startsWith(key)) return text.slice(key.length).trim();
    }
    return null;
  }

  async #handleDraw(prompt, ctx, ev) {
    if (!prompt) {
      await this.#send(ctx, ev, '想画什么？这样发：/draw 一只戴墨镜的橘猫');
      return;
    }
    if (prompt.length > 500) {
      await this.#send(ctx, ev, '提示词太长了，控制在 500 字以内。');
      return;
    }
    this.log.info(`生图：${prompt}`);
    await this.#send(ctx, ev, '正在画，稍等…');
    try {
      const img = await generateImage(this.cfg.image, prompt, this.log);
      if (!(await this.#sendMedia(ctx, 'image', img, 'png'))) {
        await this.#send(ctx, ev, '图画好了，但发送失败。');
      }
    } catch (e) {
      this.log.error(`生图失败：${e.message}`);
      await this.#send(ctx, ev, '画图失败了，稍后再试。');
    }
  }

  /** 发送图片/语音段；先按配置的传输方式，失败自动换另一种 */
  async #sendMedia(ctx, kind, buf, ext) {
    if (buf.length > this.cfg.media.maxBytes) {
      this.log.warn(`媒体文件过大（${buf.length} 字节），放弃发送`);
      return false;
    }
    const order = this.cfg.media.transport === 'base64' ? ['base64', 'file'] : ['file', 'base64'];

    for (const mode of order) {
      let cleanup = null;
      try {
        let file;
        if (mode === 'file') {
          const dir = path.resolve(ROOT, this.cfg.media.tempDir);
          fs.mkdirSync(dir, { recursive: true });
          const abs = path.join(
            dir,
            `${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`,
          );
          fs.writeFileSync(abs, buf);
          file = toFileUri(abs);
          cleanup = () => {
            try {
              fs.unlinkSync(abs);
            } catch {
              /* ignore */
            }
          };
        } else {
          file = 'base64://' + buf.toString('base64');
        }

        const message = [];
        if (ctx.isGroup && this.selfId !== ctx.userId) {
          message.push({ type: 'at', data: { qq: ctx.userId } });
          message.push({ type: 'text', data: { text: ' ' } });
        }
        message.push({ type: kind, data: { file } });

        const action = ctx.isGroup ? 'send_group_msg' : 'send_private_msg';
        const params = ctx.isGroup
          ? { group_id: Number(ctx.groupId), message }
          : { user_id: Number(ctx.userId), message };

        const res = await this.client.call(action, params, 60000);
        const id = res?.message_id;
        if (id !== undefined) {
          this.sentIds.add(String(id));
          this.sentOrder.push(String(id));
          if (this.sentOrder.length > 500) this.sentIds.delete(this.sentOrder.shift());
        }
        return true;
      } catch (e) {
        this.log.warn(`发送${kind === 'record' ? '语音' : '图片'}失败（${mode}）：${e.message}`);
      } finally {
        cleanup?.();
      }
    }
    return false;
  }

  #historyKey(ctx) {
    const scope = this.cfg.policy.contextScope === 'group' ? 'g' : `u:${ctx.userId}`;
    return ctx.isGroup ? `g:${ctx.groupId}:${scope}` : `p:${ctx.userId}`;
  }

  async #send(ctx, ev, text) {
    const { quote, atUser } = this.cfg.reply;
    const self = this.selfId;
    const message = [];
    if (quote && ev.message_id !== undefined) {
      message.push({ type: 'reply', data: { id: String(ev.message_id) } });
    }
    if (atUser && ctx.isGroup && self !== ctx.userId) {
      message.push({ type: 'at', data: { qq: ctx.userId } });
      message.push({ type: 'text', data: { text: ' ' } });
    }
    message.push({ type: 'text', data: { text } });

    const action = ctx.isGroup ? 'send_group_msg' : 'send_private_msg';
    const params = ctx.isGroup
      ? { group_id: Number(ctx.groupId), message }
      : { user_id: Number(ctx.userId), message };

    try {
      const res = await this.client.call(action, params);
      const id = res?.message_id;
      if (id !== undefined) {
        this.sentIds.add(String(id));
        this.sentOrder.push(String(id));
        if (this.sentOrder.length > 500) {
          const drop = this.sentOrder.shift();
          this.sentIds.delete(drop);
        }
      }
    } catch (e) {
      this.log.error(`发送消息失败：${e.message}`);
    }
  }

  #helpText() {
    const p = this.cfg.trigger.prefixes?.[0] ?? '/ai';
    const lines = [
      '我是接入 DeepSeek 的群助手，这样叫我：',
      '  @我 你的问题',
      `  ${p} 你的问题`,
      '  引用我的消息继续追问',
    ];
    if (this.cfg.image.enabled) lines.push('  /draw 一只戴墨镜的橘猫   ← 直接画图');
    if (this.cfg.speech.enabled) lines.push('  直接发语音给我也行；/voice 切换语音回复');
    lines.push('', '指令：重置（清空上下文）、状态、帮助');
    return lines.join('\n');
  }

  #gc() {
    const ttl = this.cfg.policy.contextTtlMinutes * 60_000;
    const now = Date.now();
    for (const [k, v] of this.histories) {
      if (now - v.lastUsed > ttl) this.histories.delete(k);
    }
    for (const [k, ts] of this.cooldowns) {
      if (now - ts > 600_000) this.cooldowns.delete(k);
    }
    // 清理一小时前的临时媒体文件（发送成功一般已删，这里兜底残留）
    try {
      const dir = path.resolve(ROOT, this.cfg.media.tempDir);
      for (const name of fs.readdirSync(dir)) {
        const abs = path.join(dir, name);
        try {
          if (now - fs.statSync(abs).mtimeMs > 3_600_000) fs.unlinkSync(abs);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* 目录不存在 */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

const { cfg, configPath } = loadConfig();
const log = createLogger(cfg);
log.info(`配置：${configPath}`);

const bot = new Bot(cfg, log);
bot.start();

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (stopping) process.exit(0);
    stopping = true;
    log.info('收到退出信号，正在关闭…');
    bot.stop();
    setTimeout(() => process.exit(0), 300);
  });
}

process.on('unhandledRejection', (e) => log.error('未处理的 Promise 异常：', e));
process.on('uncaughtException', (e) => log.error('未捕获异常：', e));
