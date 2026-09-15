// 本地图片生成工具的自测：用 mock 绘图服务验证「工具开关 / 生成 / 轮询 / 取图 / 发送 / 冷却」。
// 不碰真实 QQ、真实模型。
//
// 运行：node test/image-gen-test.mjs
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// DATA_DIR 在 config.js 导入时就会求值，所以必须先设好环境变量再动态 import。
process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-imgtest-'));

const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/config.js');
const { buildToolDefs } = await import('../src/tools.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1x1 透明 PNG
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

/** mock 绘图服务：只实现契约里的三个接口 */
function createMockDrawingService() {
  const state = { jobs: new Map(), nextId: 0, polls: 0, generates: 0, failNext: false, slowNext: false };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (code, obj) => {
      const body = Buffer.from(JSON.stringify(obj));
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': body.length });
      res.end(body);
    };
    if (req.method === 'POST' && url.pathname === '/api/v1/generate') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      state.generates += 1;
      const jobId = `job${++state.nextId}`;
      state.jobs.set(jobId, { prompt: body.prompt, size: body.size, steps: body.steps, polls: 0 });
      return json(202, { job_id: jobId, position: 0, ready_eta: 0 });
    }
    const jobMatch = url.pathname.match(/^\/api\/v1\/job\/([A-Za-z0-9_-]+)$/);
    if (jobMatch) {
      const job = state.jobs.get(jobMatch[1]);
      if (!job) return json(404, { error: 'not_found' });
      job.polls += 1;
      state.polls += 1;
      if (state.failNext) return json(200, { job_id: jobMatch[1], status: 'failed', error: '显存不足' });
      if (state.slowNext && job.polls < 3) return json(200, { job_id: jobMatch[1], status: 'running', progress: 0.3 });
      return json(200, {
        job_id: jobMatch[1], status: 'done', progress: 1, elapsed: 4.5, seed: 20260915,
        image_url: `/api/v1/image/${jobMatch[1]}.png`
      });
    }
    const imgMatch = url.pathname.match(/^\/api\/v1\/image\/([A-Za-z0-9_-]+)\.png$/);
    if (imgMatch) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': TINY_PNG.length });
      return res.end(TINY_PNG);
    }
    return json(404, { error: 'no_such_route' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.port = server.address().port;
      state.close = () => new Promise((r) => server.close(r));
      resolve(state);
    });
  });
}

function makeCtx() {
  const sent = [];
  return {
    sent,
    chatKey: 'group:123',
    session: { id: 'sess-test' },
    store: { appendSelf() {}, activeMembers: () => [], recent: () => [] },
    emit() {},
    sender: {
      async sendTextBatch(chatKey, messages) {
        sent.push({ kind: 'text', messages });
        return { sent: messages.map((t) => ({ text: t, messageId: 1 })), failed: [] };
      },
      async sendImage(chatKey, source, options) {
        sent.push({ kind: 'image', source, options });
        return { message_id: 2 };
      }
    }
  };
}

const mock = await createMockDrawingService();
const baseCfg = () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.imageGen = {
    enabled: true,
    serviceUrl: `http://127.0.0.1:${mock.port}`,
    timeoutMs: 20000,
    defaultSize: 512,
    defaultSteps: 20,
    cooldownMs: 60000,
    maxPromptChars: 600
  };
  return cfg;
};
const findTool = (defs) => defs.find((d) => d.name === 'generate_image');

// ── 1. 未启用时不暴露给模型 ──
{
  const cfg = baseCfg();
  cfg.imageGen.enabled = false;
  setRuntimeConfig(cfg);
  assert.ok(!findTool(buildToolDefs()), 'imageGen.enabled=false 时不应暴露 generate_image');
}

// ── 2. 启用后出现，且参数结构正确 ──
setRuntimeConfig(baseCfg());
const defs = buildToolDefs();
const tool = findTool(defs);
assert.ok(tool, 'imageGen.enabled=true 时应暴露 generate_image');
assert.strictEqual(tool.parameters.required[0], 'prompt', 'prompt 必填');
assert.ok(tool.description.includes('danbooru'), '工具描述必须要求模型写英文 danbooru 标签');
assert.ok(tool.description.includes('不要直接传中文'), '工具描述必须明确禁止直接传中文');

// ── 3. 参数校验 ──
{
  const ctx = makeCtx();
  const r = await tool.execute(ctx, { prompt: '   ' });
  assert.ok(r.isError && r.content.includes('不能为空'), '空 prompt 应报错');
  const r2 = await tool.execute(makeCtx(), { prompt: 'x'.repeat(700) });
  assert.ok(r2.isError && r2.content.includes('过长'), '超长 prompt 应报错');
}

// ── 4. 正常生成：请求参数、取图、发送 ──
{
  const ctx = makeCtx();
  const t0 = Date.now();
  const r = await tool.execute(ctx, { prompt: '1girl, cherry blossoms', size: 768, steps: 24, caption: '给你画了' });
  const cost = Date.now() - t0;
  assert.ok(!r.isError, `生成不应失败：${r.content}`);
  const payload = JSON.parse(r.content);
  assert.strictEqual(payload.sent, true, '结果应标记已发送');
  assert.strictEqual(payload.elapsedSeconds, 4.5, '应回传耗时');

  const req = [...mock.jobs.values()][0];
  assert.strictEqual(req.prompt, '1girl, cherry blossoms', 'prompt 应原样传给绘图服务');
  assert.strictEqual(req.size, 768, 'size 应透传');
  assert.strictEqual(req.steps, 24, 'steps 应透传');

  assert.strictEqual(ctx.sent.length, 2, '应先发文字再发图');
  assert.strictEqual(ctx.sent[0].kind, 'text');
  assert.strictEqual(ctx.sent[0].messages[0], '给你画了', 'caption 应作为文字先发');
  assert.strictEqual(ctx.sent[1].kind, 'image');
  assert.ok(ctx.sent[1].source.startsWith('data:image/png;base64,'), '应以 data URL 发送图片');
  assert.ok(ctx.sent[1].source.length > 50, 'data URL 应含真实图片字节');
  assert.ok(ctx.sent[1].options.label.includes('1girl'), '留档文字应带上 prompt 便于下一轮看到');
  assert.ok(cost < 10000, `轮询不应拖太久（实际 ${cost}ms）`);
}

// ── 5. 冷却：同一会话第二次应被挡 ──
{
  const ctx = makeCtx();
  const r = await tool.execute(ctx, { prompt: '1girl, second' });
  assert.ok(r.isError && r.content.includes('刚生成过'), '冷却期内应拒绝');
  assert.strictEqual(ctx.sent.length, 0, '被拒绝时不应发出任何消息');
}

// ── 6. 换一个会话不受冷却影响 ──
{
  const ctx = makeCtx();
  ctx.chatKey = 'group:456';
  const r = await tool.execute(ctx, { prompt: '1girl, other chat' });
  assert.ok(!r.isError, `另一个会话应当能生成：${r.content}`);
}

// ── 7. 绘图服务返回失败 → 工具报错且不发图 ──
{
  const cfg = baseCfg();
  cfg.imageGen.cooldownMs = 0;
  setRuntimeConfig(cfg);
  mock.failNext = true;
  const ctx = makeCtx();
  ctx.chatKey = 'group:789';
  const r = await tool.execute(ctx, { prompt: '1girl, will fail' });
  assert.ok(r.isError && r.content.includes('显存不足'), `应把服务端错误带回来：${r.content}`);
  assert.strictEqual(ctx.sent.length, 0, '失败时不应发图');
  mock.failNext = false;
}

// ── 8. 服务连不上 → 明确报错，不是抛异常 ──
{
  const cfg = baseCfg();
  cfg.imageGen.cooldownMs = 0;
  cfg.imageGen.serviceUrl = 'http://127.0.0.1:1';   // 必定连不上
  setRuntimeConfig(cfg);
  const ctx = makeCtx();
  ctx.chatKey = 'group:999';
  const r = await tool.execute(ctx, { prompt: '1girl, no service' });
  assert.ok(r.isError && r.content.includes('连接绘图服务失败'), `应给出可读的失败原因：${r.content}`);
}

await mock.close();
console.log('✓ 本地图片生成工具自测全部通过');
