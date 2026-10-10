/**
 * Cross-instance GraphQL subscription smoke.
 *
 * Subscriber sockets connect to API B. Business triggers go to API A.
 * API B is started with BULLMQ_WORKERS_ENABLED=false, so alerts, analysis,
 * assistant, and item-pipeline jobs are consumed only by A. B still listens
 * to BullMQ QueueEvents for queueEvents.
 *
 * Usage:
 *   node graphql-subscription-multinode-smoke.cjs
 *   node graphql-subscription-multinode-smoke.cjs check-clients
 */
const fs = require("node:fs");
const WebSocket = require("ws");
const Redis = require("ioredis");
const { Queue } = require("bullmq");

const CHANNELS = ["gqlsub:alertEvents", "gqlsub:analysisEvents", "gqlsub:assistantEvents"];

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing env ${name}`);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function redisOptions() {
  return {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT || 6379),
    maxRetriesPerRequest: 1,
  };
}

async function checkClients() {
  const redis = new Redis(redisOptions());
  const deadline = Date.now() + 10_000;
  let leaked = [];
  try {
    while (Date.now() < deadline) {
      const list = String(await redis.call("CLIENT", "LIST"));
      leaked = list.split("\n").filter((line) => line.includes("name=modular-api:gql-"));
      if (leaked.length === 0) {
        console.log("graphql subscription redis connections released");
        return;
      }
      await sleep(500);
    }
    console.error(leaked.join("\n"));
    throw new Error("GraphQL subscription Redis connections still open after process shutdown");
  } finally {
    redis.disconnect();
  }
}

async function gql(base, token, query, variables) {
  const response = await fetch(`${base}/graphql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (!response.ok || body.errors) {
    throw new Error(`GraphQL ${response.status} ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.data;
}

async function login(base, email, password, orgId) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      ...(orgId ? { orgId } : {}),
    }),
  });
  const body = await response.json();
  if (!response.ok || body.mfaRequired || typeof body.accessToken !== "string") {
    throw new Error(`login failed ${response.status} ${JSON.stringify({ ...body, accessToken: undefined, refreshToken: undefined })}`);
  }
  if (!body.user || typeof body.user.orgId !== "string") {
    throw new Error("login response missing user.orgId");
  }
  return { token: body.accessToken, orgId: body.user.orgId };
}

function openSocket(url, token) {
  const buckets = {
    alertEvents: [],
    analysisEvents: [],
    assistantEvents: [],
    queueEvents: [],
  };
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, "graphql-transport-ws");
    const ids = [];
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error(`graphql-ws connection_ack timeout ${url}`));
    }, 10_000);

    const api = {
      buckets,
      subscribeAll() {
        const queries = {
          queueEvents: "subscription { queueEvents { event jobId data timestamp } }",
          alertEvents:
            "subscription { alertEvents { id triggeredAt severity status message metricValue changePercent ruleName metricSlug context } }",
          analysisEvents:
            "subscription { analysisEvents { id type status summary error createdAt } }",
          assistantEvents:
            "subscription { assistantEvents { id type status summary error createdAt } }",
        };
        let nextId = 1;
        for (const query of Object.values(queries)) {
          const id = String(nextId);
          nextId += 1;
          ids.push(id);
          ws.send(JSON.stringify({ id, type: "subscribe", payload: { query } }));
        }
      },
      completeAll() {
        for (const id of ids) {
          ws.send(JSON.stringify({ id, type: "complete" }));
        }
      },
      close() {
        ws.close();
      },
    };

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "connection_init",
        payload: { authorization: `Bearer ${token}` },
      }));
    });
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (message.type === "connection_ack") {
        clearTimeout(timeout);
        resolve(api);
        return;
      }
      if (message.type === "next" && message.payload && message.payload.data) {
        const data = message.payload.data;
        for (const field of Object.keys(buckets)) {
          if (data[field]) {
            buckets[field].push(data[field]);
          }
        }
        return;
      }
      if (message.type === "error" || message.type === "connection_error") {
        console.error("graphql-ws error", JSON.stringify(message.payload));
        if (message.type === "connection_error") {
          clearTimeout(timeout);
          reject(new Error(`connection_error ${JSON.stringify(message.payload)}`));
        }
      }
    });
    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function numsub(redis) {
  const raw = await redis.call("PUBSUB", "NUMSUB", ...CHANNELS);
  const counts = {};
  for (let index = 0; index < raw.length; index += 2) {
    counts[String(raw[index])] = Number(raw[index + 1]);
  }
  return counts;
}

async function waitUntil(label, timeoutMs, predicate, detail) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await sleep(100);
  }
  const extra = detail ? `\n${detail()}` : "";
  throw new Error(`${label} timed out${extra}`);
}

function assertUnique(items, keyFn, label) {
  const seen = new Set();
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) {
      throw new Error(`duplicate ${label} ${key} in ${JSON.stringify(items)}`);
    }
    seen.add(key);
  }
}

function countStatus(events, id, status, summaryIsNull) {
  return events.filter((event) => {
    if (event.id !== id || event.status !== status) {
      return false;
    }
    if (summaryIsNull === undefined) {
      return true;
    }
    const empty = event.summary == null || event.summary === "";
    return summaryIsNull ? empty : !empty;
  }).length;
}

async function assertLogContains(file, needle) {
  const deadline = Date.now() + 5_000;
  let text = "";
  while (Date.now() < deadline) {
    text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (text.includes(needle)) {
      return;
    }
    await sleep(200);
  }
  const tail = text.split("\n").slice(-30).join("\n");
  throw new Error(`log ${file} missing "${needle}"\n${tail}`);
}

async function main() {
  if (process.argv[2] === "check-clients") {
    await checkClients();
    return;
  }

  const apiA = required("API_A_BASE");
  const apiB = required("API_B_BASE");
  const email = required("SEED_ADMIN_EMAIL");
  const password = required("SEED_ADMIN_PASSWORD");
  const wsUrl = apiB.replace(/^http/, "ws") + "/graphql";
  const orgALogin = await login(apiA, email, password);
  const created = await gql(
    apiA,
    orgALogin.token,
    "mutation ($input: CreateOrgInput!) { createOrg(input: $input) { id slug } }",
    { input: { name: "GQL Sub Other", slug: "gql-sub-other" } },
  );
  const orgBLogin = await login(apiA, email, password, created.createOrg.id);
  if (orgBLogin.orgId === orgALogin.orgId) {
    throw new Error("second login did not switch org");
  }

  const subscriber = await openSocket(wsUrl, orgALogin.token);
  const otherOrg = await openSocket(wsUrl, orgBLogin.token);
  subscriber.subscribeAll();
  otherOrg.subscribeAll();

  const redis = new Redis(redisOptions());
  let queue;
  try {
    await waitUntil("redis channel subscribe", 10_000, async () => {
      const counts = await numsub(redis);
      return CHANNELS.every((channel) => counts[channel] >= 1);
    });

    const rule = await gql(
      apiA,
      orgALogin.token,
      "mutation ($input: UpsertAlertRuleInput!) { upsertAlertRule(input: $input) { id name } }",
      {
        input: {
          name: "gql-sub memory",
          metricProvider: "system_metric",
          metricSlug: "system.memory.usage_pct",
          operator: "gte",
          thresholdValue: 0,
          severity: "low",
          status: "active",
          cooldownSeconds: 3600,
          checkIntervalSec: 86400,
        },
      },
    );
    const analysis = await gql(
      apiA,
      orgALogin.token,
      "mutation ($input: CorrelationAnalysisInput!) { requestCorrelationAnalysis(input: $input) { id status type } }",
      {
        input: {
          indicatorName: "gql-sub",
          startDate: "2026-01-01",
          endDate: "2026-01-02",
          value: 1.5,
          changePercent: 0.25,
          newsSummaries: ["cross-instance"],
        },
      },
    );
    const assistant = await gql(
      apiA,
      orgALogin.token,
      "mutation ($input: AssistantQueryInput!) { requestAssistantQuery(input: $input) { id status type } }",
      { input: { message: "graphql subscription cross instance" } },
    );

    queue = new Queue("itemPipeline", {
      connection: {
        host: process.env.REDIS_HOST || "127.0.0.1",
        port: Number(process.env.REDIS_PORT || 6379),
        maxRetriesPerRequest: null,
      },
    });
    const job = await queue.add(
      "process-item",
      { orgId: orgALogin.orgId },
      { jobId: `gql-sub-smoke-${Date.now()}`, attempts: 1, removeOnComplete: true },
    );
    const jobId = String(job.id);
    await queue.close();
    queue = undefined;

    await waitUntil("cross-instance events", 25_000, async () => {
      const alerts = subscriber.buckets.alertEvents;
      const analyses = subscriber.buckets.analysisEvents;
      const assistants = subscriber.buckets.assistantEvents;
      const queues = subscriber.buckets.queueEvents;
      const alertHit = alerts.some((event) => event.ruleName === rule.upsertAlertRule.name);
      const analysisRunning = countStatus(analyses, analysis.requestCorrelationAnalysis.id, "running", true) >= 1;
      const analysisFailed = countStatus(analyses, analysis.requestCorrelationAnalysis.id, "failed") >= 1;
      const assistantRunning = countStatus(assistants, assistant.requestAssistantQuery.id, "running", true) >= 1;
      const assistantFailed = countStatus(assistants, assistant.requestAssistantQuery.id, "failed") >= 1;
      const queueFailed = queues.filter((event) => event.jobId === jobId && event.event === "FAILED").length >= 1;
      return alertHit && analysisRunning && analysisFailed && assistantRunning && assistantFailed && queueFailed;
    }, () => JSON.stringify({
      alerts: subscriber.buckets.alertEvents,
      analyses: subscriber.buckets.analysisEvents,
      assistants: subscriber.buckets.assistantEvents,
      queues: subscriber.buckets.queueEvents,
      otherOrg: otherOrg.buckets,
    }));
    await sleep(1500);

    const alerts = subscriber.buckets.alertEvents;
    const analyses = subscriber.buckets.analysisEvents;
    const assistants = subscriber.buckets.assistantEvents;
    const queues = subscriber.buckets.queueEvents;
    assertUnique(alerts, (event) => event.id, "alertEvents");
    const alert = alerts.find((event) => event.ruleName === "gql-sub memory");
    if (!alert) {
      throw new Error(`missing alert event ${JSON.stringify(alerts)}`);
    }
    if (alert.metricSlug !== "system.memory.usage_pct") {
      throw new Error(`unexpected metricSlug ${alert.metricSlug}`);
    }
    if (typeof alert.metricValue !== "number" || !Number.isFinite(alert.metricValue) || alert.metricValue < 0) {
      throw new Error(`unexpected metricValue ${alert.metricValue}`);
    }
    if (alert.changePercent !== null) {
      throw new Error(`changePercent should stay null, got ${JSON.stringify(alert.changePercent)}`);
    }
    if (!alert.context || typeof alert.context !== "object" || Array.isArray(alert.context)) {
      throw new Error(`context shape lost ${JSON.stringify(alert.context)}`);
    }
    if (typeof alert.context.totalBytes !== "number") {
      throw new Error(`context.totalBytes missing ${JSON.stringify(alert.context)}`);
    }
    if (Number.isNaN(Date.parse(alert.triggeredAt))) {
      throw new Error(`triggeredAt is not a date ${alert.triggeredAt}`);
    }

    const analysisId = analysis.requestCorrelationAnalysis.id;
    const assistantId = assistant.requestAssistantQuery.id;
    if (countStatus(analyses, analysisId, "running", true) !== 1) {
      throw new Error(`analysis running event count ${JSON.stringify(analyses)}`);
    }
    if (countStatus(analyses, analysisId, "failed") !== 1) {
      throw new Error(`analysis failed event count ${JSON.stringify(analyses)}`);
    }
    if (analyses.find((event) => event.id === analysisId && event.status === "running").type !== "correlation") {
      throw new Error(`analysis type ${JSON.stringify(analyses)}`);
    }
    if (countStatus(assistants, assistantId, "running", true) !== 1) {
      throw new Error(`assistant running event count ${JSON.stringify(assistants)}`);
    }
    if (countStatus(assistants, assistantId, "failed") !== 1) {
      throw new Error(`assistant failed event count ${JSON.stringify(assistants)}`);
    }
    if (assistants.find((event) => event.id === assistantId && event.status === "running").type !== "query") {
      throw new Error(`assistant type ${JSON.stringify(assistants)}`);
    }
    for (const event of [...analyses, ...assistants]) {
      if (Number.isNaN(Date.parse(event.createdAt))) {
        throw new Error(`createdAt is not a date ${event.createdAt}`);
      }
    }

    const failedQueue = queues.filter((event) => event.event === "FAILED");
    if (failedQueue.length !== 1 || failedQueue[0].jobId !== jobId) {
      throw new Error(`queue terminal events ${JSON.stringify(queues)}`);
    }
    if (!String(failedQueue[0].data || "").includes("rawItemId")) {
      throw new Error(`queue failure payload ${JSON.stringify(failedQueue[0])}`);
    }
    if (Number.isNaN(Date.parse(failedQueue[0].timestamp))) {
      throw new Error(`queue timestamp ${failedQueue[0].timestamp}`);
    }
    const foreignQueue = queues.filter((event) => event.jobId !== jobId);
    if (foreignQueue.length !== 0) {
      throw new Error(`unexpected queue events ${JSON.stringify(foreignQueue)}`);
    }

    const otherCounts = {
      alertEvents: otherOrg.buckets.alertEvents.length,
      analysisEvents: otherOrg.buckets.analysisEvents.length,
      assistantEvents: otherOrg.buckets.assistantEvents.length,
      queueEvents: otherOrg.buckets.queueEvents.length,
    };
    if (Object.values(otherCounts).some((count) => count !== 0)) {
      throw new Error(`other org received events ${JSON.stringify(otherCounts)}`);
    }

    subscriber.completeAll();
    otherOrg.completeAll();
    await waitUntil("redis channel unsubscribe", 5_000, async () => {
      const counts = await numsub(redis);
      return CHANNELS.every((channel) => counts[channel] === 0);
    });
    const afterUnsubscribe = await numsub(redis);

    await assertLogContains(required("API_B_LOG"), "BullMQ workers disabled on this process");
    await assertLogContains(required("API_A_LOG"), "Analysis job failed");
    await assertLogContains(required("API_A_LOG"), "Assistant job failed");
    await assertLogContains(required("API_A_LOG"), "Queue job failed");

    console.log(JSON.stringify({
      ok: true,
      subscriber: "B",
      publisher: "A",
      orgA: orgALogin.orgId,
      orgB: orgBLogin.orgId,
      alert: {
        id: alert.id,
        metricValue: alert.metricValue,
        changePercent: alert.changePercent,
        triggeredAt: alert.triggeredAt,
        contextKeys: Object.keys(alert.context),
        deliveries: alerts.length,
      },
      analysis: {
        id: analysisId,
        running: countStatus(analyses, analysisId, "running", true),
        failed: countStatus(analyses, analysisId, "failed"),
        boundary: "running publish is before the model call; failed publish is the model-unavailable branch. completed was not executed.",
      },
      assistant: {
        id: assistantId,
        running: countStatus(assistants, assistantId, "running", true),
        failed: countStatus(assistants, assistantId, "failed"),
        boundary: "running publish is before the model call; failed publish is the model-unavailable branch. completed was not executed.",
      },
      queue: {
        jobId,
        failed: failedQueue.length,
        ownership: "BullMQ QueueEvents on B, worker on A. Not republished through the GraphQL Redis bus.",
      },
      otherOrg: otherCounts,
      redisChannelsAfterUnsubscribe: afterUnsubscribe,
    }, null, 2));
  } finally {
    subscriber.completeAll();
    otherOrg.completeAll();
    subscriber.close();
    otherOrg.close();
    if (queue) {
      await queue.close();
    }
    redis.disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
