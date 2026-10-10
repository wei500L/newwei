// 远端 smoke 使用的调用方切换检查。不是 vitest 用例。
// phase=shared：NestJS 与 vector-go 并行 upsert/search，并核对集合名与确定性 point ID。
// phase=go-only：NestJS 已停止后，调用方只指向 vector-go，仍能写入和查询。
const { createHash } = require('node:crypto');
const { VectorClient } = require('../../../packages/vector-client/dist/index.js');

const phase = process.argv[2];
const nestBase = process.env.VECTOR_NEST_URL;
const goBase = process.env.VECTOR_GO_URL;
const token = process.env.VECTOR_INTERNAL_TOKEN;
const qdrantUrl = process.env.QDRANT_URL;
const qdrantKey = process.env.QDRANT_API_KEY;
const model = 'pilot-embed';
const org = 'org-pilot';
const otherOrg = 'org-other';

const stableUuid = (value) => {
  const bytes = Buffer.from(createHash('sha256').update(value).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const call = async (base, path, body) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-token': token,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 保留原文，断言里会失败。
  }
  return { status: response.status, body: parsed };
};

const pointBody = (point) => ({
  orgId: org,
  embeddingModel: model,
  points: [point],
});

const assertUpsert = (label, result) => {
  if (result.status !== 201) {
    fail(`${label} upsert status ${result.status} body ${JSON.stringify(result.body)}`);
  }
  if (!result.body || result.body.upserted !== 1) {
    fail(`${label} upsert body ${JSON.stringify(result.body)}`);
  }
  if (!/^pilot_processed_[0-9a-f]{16}$/.test(result.body.collection)) {
    fail(`${label} collection ${result.body.collection}`);
  }
};

const readPoint = async (collection, id) => {
  const response = await fetch(`${qdrantUrl}/collections/${collection}/points/${id}`, {
    headers: { 'api-key': qdrantKey },
  });
  const text = await response.text();
  if (response.status !== 200) {
    fail(`qdrant point ${id} status ${response.status} body ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
};

const clientFor = (baseUrl) =>
  new VectorClient({ baseUrl, token, timeoutMs: 15_000, maxRetries: 0 });

const searchBothOrgs = async (base, label) => {
  const client = clientFor(base);
  const own = await client.search({
    orgId: org,
    embeddingModel: model,
    vector: [0.4, 0.5, 0.6],
    limit: 10,
  });
  const other = await client.search({
    orgId: otherOrg,
    embeddingModel: model,
    vector: [0.4, 0.5, 0.6],
    limit: 10,
  });
  if (!own.matches.some((match) => match.processedItemId === 'pilot-stable-item')) {
    fail(`${label} search missed pilot-stable-item: ${JSON.stringify(own)}`);
  }
  if (other.matches.length !== 0) {
    fail(`${label} cross-org search leaked: ${JSON.stringify(other.matches)}`);
  }
  if (own.collection !== other.collection) {
    fail(`${label} collection diverged ${own.collection} vs ${other.collection}`);
  }
  return own;
};

const shared = async () => {
  const point = {
    processedItemId: 'pilot-stable-item',
    itemMetaId: 'pilot-meta',
    createdAtMs: 1_700_000_000_123,
    vector: [0.4, 0.5, 0.6],
  };
  const [nestUp, goUp] = await Promise.all([
    call(nestBase, '/v1/upsert', pointBody(point)),
    call(goBase, '/v1/upsert', pointBody(point)),
  ]);
  assertUpsert('nestjs', nestUp);
  assertUpsert('vector-go', goUp);
  if (nestUp.body.collection !== goUp.body.collection) {
    fail(`collection mismatch nest=${nestUp.body.collection} go=${goUp.body.collection}`);
  }

  const id = stableUuid(`${model}:${point.processedItemId}`);
  const stored = await readPoint(nestUp.body.collection, id);
  const payload = stored.result && stored.result.payload;
  if (!payload || payload.processedItemId !== point.processedItemId || payload.orgId !== org) {
    fail(`deterministic point payload ${JSON.stringify(stored).slice(0, 400)}`);
  }

  const nestSearch = await searchBothOrgs(nestBase, 'nestjs');
  const goSearch = await searchBothOrgs(goBase, 'vector-go');
  if (nestSearch.collection !== goSearch.collection) {
    fail(`search collection mismatch ${nestSearch.collection} vs ${goSearch.collection}`);
  }
  const nestHit = nestSearch.matches.find((match) => match.processedItemId === point.processedItemId);
  const goHit = goSearch.matches.find((match) => match.processedItemId === point.processedItemId);
  if (!nestHit || !goHit || nestHit.itemMetaId !== goHit.itemMetaId || nestHit.createdAtMs !== goHit.createdAtMs) {
    fail(`search result mismatch ${JSON.stringify({ nestHit, goHit })}`);
  }
  console.log(JSON.stringify({
    phase: 'shared',
    status: { nest: nestUp.status, go: goUp.status },
    collection: nestUp.body.collection,
    pointId: id,
  }));
};

const goOnly = async () => {
  let nestDown = false;
  try {
    await fetch(`${nestBase}/healthz`);
  } catch {
    nestDown = true;
  }
  if (!nestDown) {
    const probe = await fetch(`${nestBase}/healthz`).catch(() => null);
    if (probe && probe.ok) {
      fail('nestjs vector is still accepting healthz');
    }
  }

  const point = {
    processedItemId: 'pilot-after-nest-stop',
    itemMetaId: 'pilot-meta-2',
    createdAtMs: 1_700_000_000_456,
    vector: [0.2, 0.2, 0.9],
  };
  const goUp = await call(goBase, '/v1/upsert', pointBody(point));
  assertUpsert('vector-go-after-stop', goUp);
  const id = stableUuid(`${model}:${point.processedItemId}`);
  const stored = await readPoint(goUp.body.collection, id);
  const payload = stored.result && stored.result.payload;
  if (!payload || payload.processedItemId !== point.processedItemId) {
    fail(`post-stop point payload ${JSON.stringify(stored).slice(0, 400)}`);
  }
  const client = clientFor(goBase);
  const own = await client.search({
    orgId: org,
    embeddingModel: model,
    vector: point.vector,
    limit: 10,
  });
  const other = await client.search({
    orgId: otherOrg,
    embeddingModel: model,
    vector: point.vector,
    limit: 10,
  });
  if (!own.matches.some((match) => match.processedItemId === point.processedItemId)) {
    fail(`post-stop search missed point: ${JSON.stringify(own)}`);
  }
  if (other.matches.length !== 0) {
    fail(`post-stop cross-org leak: ${JSON.stringify(other.matches)}`);
  }
  if (own.collection !== goUp.body.collection) {
    fail(`post-stop collection ${own.collection} vs ${goUp.body.collection}`);
  }
  console.log(JSON.stringify({
    phase: 'go-only',
    status: goUp.status,
    collection: goUp.body.collection,
    pointId: id,
  }));
};

const main = async () => {
  if (!nestBase || !goBase || !token || !qdrantUrl || !qdrantKey) {
    fail('missing VECTOR_NEST_URL, VECTOR_GO_URL, VECTOR_INTERNAL_TOKEN, QDRANT_URL, or QDRANT_API_KEY');
  }
  if (phase === 'shared') {
    await shared();
    return;
  }
  if (phase === 'go-only') {
    await goOnly();
    return;
  }
  fail(`unknown phase ${phase}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
