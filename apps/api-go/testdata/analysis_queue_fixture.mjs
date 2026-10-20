// BullMQ 5.63.2 interoperability fixture for the analysis queue.
//
// It is run by the Go integration test through Node's stdin so the ESM import
// of `bullmq` resolves from the locked workspace dependency. The fixture is
// intentionally thin: it proves that the Node implementation and the Go runner
// share the same Redis state machine, job options and MessagePack payloads.
//
// Modes (FIXTURE_MODE):
//   produce - Queue.add one job with the payload/options below and exit.
//   consume - run one Worker, process the expected job and exit after it
//             completes. The returned value is {ok:true}.
//   inspect - print the job state/counts for the given job id.
//
// Environment:
//   BULLMQ_REDIS_HOST (127.0.0.1), BULLMQ_REDIS_PORT (6379), BULLMQ_REDIS_DB (0),
//   BULLMQ_REDIS_PASSWORD, BULLMQ_PREFIX (bull), BULLMQ_QUEUE (analysis),
//   FIXTURE_PAYLOAD (JSON), FIXTURE_JOB_ID, FIXTURE_ATTEMPTS (3),
//   FIXTURE_TIMEOUT_MS (15000).

import { Queue, Worker } from "bullmq";

const mode = process.env.FIXTURE_MODE ?? "";
const prefix = process.env.BULLMQ_PREFIX ?? "bull";
const queueName = process.env.BULLMQ_QUEUE ?? "analysis";
const timeoutMs = Number(process.env.FIXTURE_TIMEOUT_MS ?? "15000");

const connection = {
  host: process.env.BULLMQ_REDIS_HOST ?? "127.0.0.1",
  port: Number(process.env.BULLMQ_REDIS_PORT ?? "6379"),
  db: Number(process.env.BULLMQ_REDIS_DB ?? "0"),
  // A Worker blocking connection requires maxRetriesPerRequest=null in BullMQ.
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
  const payloadText = process.env.FIXTURE_PAYLOAD;
  if (!payloadText) {
    fail("FIXTURE_PAYLOAD is required for produce");
  }
  const payload = JSON.parse(payloadText);
  const jobId = process.env.FIXTURE_JOB_ID;
  if (!jobId) {
    fail("FIXTURE_JOB_ID is required for produce");
  }
  const attempts = Number(process.env.FIXTURE_ATTEMPTS ?? "3");
  const queue = new Queue(queueName, {
    connection,
    prefix,
    defaultJobOptions: {
      removeOnFail: { age: 604800, count: 10000 },
    },
  });
  const job = await queue.add(payload.type, payload, {
    jobId,
    removeOnComplete: true,
    attempts,
  });
  process.stdout.write(
    JSON.stringify({ mode, jobId: job.id, name: job.name, data: job.data }) + "\n",
  );
  await queue.close();
}

async function consume() {
  const expectedJobId = process.env.FIXTURE_JOB_ID;
  const worker = new Worker(
    queueName,
    async (job) => {
      if (expectedJobId && job.id !== expectedJobId) {
        throw new Error(`unexpected job id ${job.id}, expected ${expectedJobId}`);
      }
      if (!job.data || typeof job.data.analysisId !== "string") {
        throw new Error("job payload has no analysisId");
      }
      return { ok: true };
    },
    { connection, prefix, concurrency: 1 },
  );

  const result = await withTimeout(
    new Promise((resolve, reject) => {
      worker.on("completed", (job, value) => {
        resolve({ mode, jobId: job.id, data: job.data, value });
      });
      worker.on("failed", (job, error) => {
        reject(new Error(`job ${job?.id} failed: ${error?.message}`));
      });
      worker.on("error", (error) => reject(error));
    }),
    "consume",
  );
  process.stdout.write(JSON.stringify(result) + "\n");
  await worker.close();
}

async function inspect() {
  const jobId = process.env.FIXTURE_JOB_ID;
  if (!jobId) {
    fail("FIXTURE_JOB_ID is required for inspect");
  }
  const queue = new Queue(queueName, { connection, prefix });
  const job = await queue.getJob(jobId);
  const counts = await queue.getJobCounts(
    "wait",
    "active",
    "completed",
    "failed",
    "delayed",
    "paused",
  );
  const state = job ? await job.getState() : null;
  process.stdout.write(
    JSON.stringify({ mode, jobId, found: Boolean(job), state, counts }) + "\n",
  );
  await queue.close();
}

try {
  if (mode === "produce") {
    await produce();
  } else if (mode === "consume") {
    await consume();
  } else if (mode === "inspect") {
    await inspect();
  } else {
    fail(`unknown FIXTURE_MODE ${mode}`);
  }
  process.exitCode = 0;
} catch (error) {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
}
