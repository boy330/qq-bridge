/**
 * 端到端自测：不连真 QQ、不花 API 额度。
 * 跑法：node test/e2e.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockOneBot } from './mock-onebot.mjs';
import { MockDeepSeek } from './mock-deepseek.mjs';
import { MockMedia } from './mock-media.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const NODE = process.execPath;
const WS_PORT = 18080;
const API_PORT = 18081;
const MEDIA_PORT = 18083;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  \u2717 ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeConfig(name, extra = {}) {
  const cfg = {
    onebot: { url: `ws://127.0.0.1:${WS_PORT}`, accessToken: '', reconnectMinMs: 500, reconnectMaxMs: 2000 },
    deepseek: { baseUrl: `http://127.0.0.1:${API_PORT}`, apiKey: 'test-key', model: 'deepseek-chat', timeoutMs: 5000 },
    trigger: { at: true, replyToBot: true, prefixes: ['/ai'], requireAtInGroup: false },
    reply: { quote: false, atUser: true, maxChars: 1200, maxParts: 3 },
    policy: { cooldownSeconds: 0, allowedGroups: [], allowPrivate: false, maxContextTurns: 6 },
    media: { tempDir: 'test/tmp', transport: 'base64', maxBytes: 8 * 1024 * 1024 },
    speech: {
      enabled: true,
      baseUrl: `http://127.0.0.1:${MEDIA_PORT}`,
      apiKey: 'test-key',
      ttsModel: 'mock-tts',
      voice: 'mock-voice',
      speed: 1,
      maxChars: 300,
      replyMode: 'on-voice-input',
      asrModel: 'mock-asr',
    },
    image: {
      enabled: true,
      baseUrl: `http://127.0.0.1:${MEDIA_PORT}`,
      apiKey: 'test-key',
      model: 'mock-image',
      size: '512x512',
      steps: 4,
      guidance: 3,
      negativePrompt: '',
      prefixes: ['/draw'],
      timeoutMs: 15000,
    },
    log: { level: 'info', file: `test/.${name}.log` },
    ...extra,
  };
  const file = path.join(HERE, `.${name}.json`);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}

function spawnBot(configPath) {
  // 沙箱环境不允许管道捕获子进程输出，改用 ignore，日志从机器人自己的日志文件读
  const logFile = path.join(HERE, `.${path.basename(configPath, '.json').replace(/^\./, '')}.log`);
  const child = spawn(NODE, [path.join(ROOT, 'bot.mjs'), '--config', configPath], {
    cwd: ROOT,
    env: { ...process.env, DEEPSEEK_API_KEY: 'test-key' },
    stdio: 'ignore',
  });
  child.logFile = logFile;
  child.output = () => {
    try {
      return fs.readFileSync(logFile, 'utf8');
    } catch {
      return '(无日志)';
    }
  };
  return child;
}

async function stopBot(child) {
  if (!child || child.killed) return;
  child.kill();
  await new Promise((r) => child.once('exit', r));
}

function textsOf(sentItem) {
  return (sentItem?.params?.message ?? [])
    .filter((s) => s.type === 'text')
    .map((s) => s.data.text)
    .join('');
}

function segmentsOf(sentItem) {
  return sentItem?.params?.message ?? [];
}

async function main() {
  const onebot = await new MockOneBot({ port: WS_PORT, token: '' }).start();
  const api = await new MockDeepSeek({ port: API_PORT, apiKey: 'test-key' }).start();
  const media = await new MockMedia({ port: MEDIA_PORT, apiKey: 'test-key' }).start();
  const cfgPath = writeConfig('main');
  let bot = spawnBot(cfgPath);

  try {
    await onebot.waitForConnection(10000);
    console.log('\n[1] @机器人 触发');
    let before = onebot.sent.length;
    onebot.pushEvent(
      onebot.groupMessage({
        messageId: 1,
        message: [
          { type: 'at', data: { qq: '10001' } },
          { type: 'text', data: { text: ' 你好' } },
        ],
        plainText: '@测试机器人 你好',
      }),
    );
    const r1 = await onebot.waitForSent(before + 1, 10000);
    check('收到回复', textsOf(r1).includes('mock'), textsOf(r1));
    check('回复 @ 了提问者', segmentsOf(r1).some((s) => s.type === 'at' && s.data.qq === '222'));
    check('发到了正确的群', String(r1.params.group_id) === '123456', String(r1.params.group_id));
    check('模型收到了 2 条消息（system+user）', api.requests.at(-1)?.messages?.length === 2);

    console.log('\n[2] 前缀触发 + 上下文累积');
    before = onebot.sent.length;
    onebot.pushEvent(
      onebot.groupMessage({
        messageId: 2,
        message: [{ type: 'text', data: { text: '/ai 第二问' } }],
        plainText: '/ai 第二问',
      }),
    );
    const r2 = await onebot.waitForSent(before + 1, 10000);
    check('前缀触发有回复', textsOf(r2).includes('第二问'), textsOf(r2));
    check('上下文带上了上一轮（4 条消息）', api.requests.at(-1)?.messages?.length === 4, String(api.requests.at(-1)?.messages?.length));
    check('前缀已从问题里剥掉', !JSON.stringify(api.requests.at(-1)?.messages).includes('/ai 第二问'));

    console.log('\n[3] 未触发消息不该回复');
    before = onebot.sent.length;
    onebot.pushEvent(
      onebot.groupMessage({ messageId: 3, message: [{ type: 'text', data: { text: '今天天气不错' } }] }),
    );
    await sleep(1200);
    check('普通群聊无回复', onebot.sent.length === before, `多发了 ${onebot.sent.length - before} 条`);

    console.log('\n[4] 指令：重置上下文');
    before = onebot.sent.length;
    onebot.pushEvent(
      onebot.groupMessage({ messageId: 4, message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 重置' } }] }),
    );
    const r4 = await onebot.waitForSent(before + 1, 10000);
    check('重置有确认回复', textsOf(r4).includes('上下文'), textsOf(r4));

    console.log('\n[5] 重置后不再带旧上下文');
    before = onebot.sent.length;
    onebot.pushEvent(
      onebot.groupMessage({ messageId: 5, message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 新话题' } }] }),
    );
    await onebot.waitForSent(before + 1, 10000);
    check('重置后首轮只有 2 条消息', api.requests.at(-1)?.messages?.length === 2, String(api.requests.at(-1)?.messages?.length));

    console.log('\n[6] 指令：状态');
    before = onebot.sent.length;
    onebot.pushEvent(
      onebot.groupMessage({ messageId: 6, message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 状态' } }] }),
    );
    const r6 = await onebot.waitForSent(before + 1, 10000);
    check('状态含模型名', textsOf(r6).includes('deepseek-chat'), textsOf(r6));

    console.log('\n[7] 超长回复自动分条');
    before = onebot.sent.length;
    onebot.pushEvent(
      onebot.groupMessage({ messageId: 7, message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 长文' } }] }),
    );
    await onebot.waitForSent(before + 2, 10000);
    check('长回复被拆成多条', onebot.sent.length - before >= 2, `拆成 ${onebot.sent.length - before} 条`);
    check('每批都不超过 1200 字', onebot.sent.slice(before).every((s) => textsOf(s).length <= 1260));

    console.log('\n[8] 群白名单');
    await stopBot(bot);
    const cfg2 = writeConfig('allow', { policy: { cooldownSeconds: 0, allowedGroups: [999], allowPrivate: false } });
    bot = spawnBot(cfg2);
    await sleep(600);
    await onebot.waitForConnection(10000);
    const n0 = onebot.sent.length;
    onebot.pushEvent(
      onebot.groupMessage({ groupId: 123456, messageId: 8, message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 不在白名单' } }] }),
    );
    await sleep(900);
    check('非白名单群不回复', onebot.sent.length === n0, `多发了 ${onebot.sent.length - n0} 条`);
    onebot.pushEvent(
      onebot.groupMessage({ groupId: 999, messageId: 9, message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 在白名单' } }] }),
    );
    const r8 = await onebot.waitForSent(n0 + 1, 10000);
    check('白名单群正常回复', textsOf(r8).includes('mock'), textsOf(r8));

    console.log('\n[9] Access Token 鉴权');
    await stopBot(bot);
    const tokenBot = new MockOneBot({ port: 18082, token: 'secret-token' });
    await tokenBot.start();
    const cfg3 = writeConfig('token', {
      onebot: { url: 'ws://127.0.0.1:18082', accessToken: 'secret-token', reconnectMinMs: 500, reconnectMaxMs: 2000 },
      policy: { cooldownSeconds: 0, allowedGroups: [], allowPrivate: false },
    });
    bot = spawnBot(cfg3);
    await tokenBot.waitForConnection(10000);
    tokenBot.pushEvent(
      tokenBot.groupMessage({
        messageId: 11,
        message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 带token' } }],
      }),
    );
    const r9 = await tokenBot.waitForSent(1, 10000);
    check('带 Bearer Token 也能连上并回复', textsOf(r9).includes('mock'), textsOf(r9));
    await tokenBot.close();

    // 后面几条用例回到主配置
    await stopBot(bot);
    bot = spawnBot(cfgPath);
    await onebot.waitForConnection(10000);

    console.log('\n[10] 画图指令');
    before = onebot.sent.length;
    onebot.pushEvent(
      onebot.groupMessage({
        messageId: 12,
        message: [
          { type: 'at', data: { qq: '10001' } },
          { type: 'text', data: { text: ' /draw 一只戴墨镜的橘猫' } },
        ],
      }),
    );
    await onebot.waitForSent(before + 2, 20000);
    const drawMsgs = onebot.sent.slice(before);
    const imgSeg = drawMsgs.flatMap((s) => segmentsOf(s)).find((x) => x.type === 'image');
    check('返回了图片段', !!imgSeg);
    check('图片以 base64 方式发送', String(imgSeg?.data?.file ?? '').startsWith('base64://'), String(imgSeg?.data?.file ?? '').slice(0, 20));
    check(
      '提示词正确传给生图接口',
      media.requests.image.at(-1)?.prompt === '一只戴墨镜的橘猫',
      String(media.requests.image.at(-1)?.prompt),
    );

    console.log('\n[11] 语音提问 → 转写 → 语音回复');
    before = onebot.sent.length;
    onebot.pushEvent(
      onebot.groupMessage({
        messageId: 13,
        message: [
          { type: 'at', data: { qq: '10001' } },
          { type: 'text', data: { text: ' ' } },
          { type: 'record', data: { file: 'abc.amr', url: `http://127.0.0.1:${MEDIA_PORT}/voice.mp3` } },
        ],
      }),
    );
    const r11 = await onebot.waitForSent(before + 1, 20000);
    check(
      '语音被转写后送进模型',
      String(api.requests.at(-1)?.messages?.at(-1)?.content ?? '').includes('今天天气怎么样'),
      String(api.requests.at(-1)?.messages?.at(-1)?.content ?? ''),
    );
    check('用语音段回复', segmentsOf(r11).some((x) => x.type === 'record'));
    check('TTS 收到的正是模型回答', String(media.requests.tts.at(-1)?.input ?? '').includes('今天天气怎么样'));

    console.log('\n[12] /voice 切换语音回复');
    before = onebot.sent.length;
    onebot.pushEvent(
      onebot.groupMessage({
        messageId: 14,
        message: [
          { type: 'at', data: { qq: '10001' } },
          { type: 'text', data: { text: ' /voice' } },
        ],
      }),
    );
    const r12 = await onebot.waitForSent(before + 1, 10000);
    check('/voice 有确认回复', textsOf(r12).includes('语音'), textsOf(r12));

    before = onebot.sent.length;
    onebot.pushEvent(
      onebot.groupMessage({
        messageId: 15,
        message: [
          { type: 'at', data: { qq: '10001' } },
          { type: 'text', data: { text: ' 再说一句' } },
        ],
      }),
    );
    const r13 = await onebot.waitForSent(before + 1, 20000);
    check('纯文字提问也回语音', segmentsOf(r13).some((x) => x.type === 'record'));
  } catch (e) {
    failed += 1;
    failures.push('异常：' + e.message);
    console.log('\n  ✗ 测试中断：' + e.message);
    console.log(bot?.output?.() ?? '');
  } finally {
    await stopBot(bot);
    await onebot.close();
    await api.close();
    await media.close();
    try {
      fs.rmSync(path.join(HERE, 'tmp'), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    for (const f of fs.readdirSync(HERE)) {
      if (f.startsWith('.') && (f.endsWith('.json') || f.endsWith('.log'))) {
        try {
          fs.rmSync(path.join(HERE, f));
        } catch {
          /* ignore */
        }
      }
    }
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed) {
    console.log('失败项：\n - ' + failures.join('\n - '));
    process.exit(1);
  }
}

main();
