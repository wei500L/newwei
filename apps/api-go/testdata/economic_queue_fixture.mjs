// BullMQ 5.63.2 interoperability fixture for the akshare-data queue.
//
// It is run by the Go integration test through Node's stdin with the process
// working directory set to the @modular/infra-scripts tool package, so the ESM
// import of `bullmq` (pinned 5.63.2) resolves from that fixture's locked
// dependency. The fixture is intentionally thin: it proves that the Node
// implementation and the Go producer/worker share the same Redis state machine,
// job options and MessagePack payloads.
//
// Modes (FIXTURE_MODE):
//   produce - Queue.add one manual-fetch job and exit.
//   consume - run one Worker, process the expected job and exit after it
//             completes. The returned value is {ok:true}.
//
// Environment:
//   BULLMQ_REDIS_HOST (127.0.0.1), BULLMQ_REDIS_PORT (6379), BULLMQ_REDIS_DB (0),
//   BULLMQ_REDIS_PASSWORD, BULLMQ_PREFIX (bull), BULLMQ_QUEUE (akshare-data),
//   FIXTURE_DATA (JSON job data), FIXTURE_JOB_ID, FIXTURE_TIMEOUT_MS (15000).

import { Queue, Worker } from "bullmq";

const mode = process.env.FIXTURE_MODE ?? "";
const prefix = process.env.BULLMQ_PREFIX ?? "bull";
const queueName = process.env.BULLMQ_QUEUE ?? "akshare-data";
const timeoutMs = Number(process.env.FIXTURE_TIMEOUT_MS ?? "15000");

const connection = {
  host: process.env.BULLMQ_REDIS_HOST ?? "127.0.0.1",
  port: Number(process.env.BULLMQ_REDIS_PORT ?? "6379"),
  db: Number(process.env.BULLMQ_REDIS_DB ?? "0"),
  maxRetriesPerRequest: null,
  ...(process.env.BULLMQ_REDIS_PASSWORD
    ? { password: process.env.BULLMQ_REDIS_PASSWORD }
    : {}),
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs),
    ),
  ]);
}

async function produce() {
  const dataText = process.env.FIXTURE_DATA;
  const jobId = process.env.FIXTURE_JOB_ID;
  if (!dataText) fail("FIXTURE_DATA is required for produce");
  if (!jobId) fail("FIXTURE_JOB_ID is required for produce");
  const queue = new Queue(queueName, {
    connection,
    prefix,
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: { age: 604800, count: 10000 },
    },
  });
  const job = await queue.add("manual-fetch", JSON.parse(dataText), {
    jobId,
    removeOnComplete: true,
    removeOnFail: { age: 604800, count: 10000 },
  });
  process.stdout.write(
    JSON.stringify({ mode, jobId: job.id, name: job.name, data: job.data }) + "\n",
  );
  await queue.close();
}

async function consume() {
  const expected = process.env.FIXTURE_JOB_ID;
  let seen = null;
  const worker = new Worker(
    queueName,
    async (job) => {
      seen = job.id;
      return { ok: true };
    },
    { connection, prefix, concurrency: 1 },
  );
  await withTimeout(
    new Promise((resolve, reject) => {
      worker.on("completed", (job) => {
        if (!expected || job.id === expected) resolve();
      });
      worker.on("failed", (job, err) => reject(new Error(`job failed: ${job?.id} ${err}`)));
      worker.on("error", (err) => reject(err));
    }),
    "consume",
  );
  process.stdout.write(JSON.stringify({ mode, jobId: seen, ok: true }) + "\n");
  await worker.close();
}

try {
  if (mode === "produce") {
    await produce();
  } else if (mode === "consume") {
    await consume();
  } else {
    fail(`unknown FIXTURE_MODE ${mode}`);
  }
} catch (error) {
  fail(error?.stack ?? String(error));
}
