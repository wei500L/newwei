// BullMQ 5.63.2 interoperability fixture for the situation-monitor Telegram
// poll scheduler.
//
// The Go integration test runs this through Node's stdin from apps/api so the
// ESM import of `bullmq` resolves from the locked workspace dependency. It
// proves that Node can read the JobScheduler and jobs api-go writes, and that
// api-go can remove a scheduler Node writes.
//
// Modes (FIXTURE_MODE):
//   inspect - print queue.getJobSchedulers() and the pending jobs.
//   upsert  - queue.upsertJobScheduler("telegram-poll:scheduler", {every}, ...).
//   remove  - queue.removeJobScheduler("telegram-poll:scheduler").
//   encrypt - AES-256-GCM encrypt FIXTURE_PLAINTEXT with FIXTURE_KEY_HEX and
//             print the system-settings:v1 envelope (the NestJS algorithm).
//   decrypt - decrypt FIXTURE_ENVELOPE with FIXTURE_KEY_HEX and print the
//             plaintext, so api-go's ciphertext is verified by NestJS's own
//             node:crypto implementation.
//
// Environment: BULLMQ_REDIS_HOST/PORT/DB/PASSWORD, BULLMQ_QUEUE,
// FIXTURE_EVERY, FIXTURE_PLAINTEXT, FIXTURE_KEY_HEX, FIXTURE_ENVELOPE.

import { Queue } from "bullmq";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function settingsKey() {
  const raw = (process.env.FIXTURE_KEY_HEX ?? "").trim();
  if (raw.length !== 64) {
    fail("FIXTURE_KEY_HEX must be 64 hex characters");
  }
  return Buffer.from(raw, "hex");
}

function encryptSecret() {
  const plain = process.env.FIXTURE_PLAINTEXT ?? "";
  const key = settingsKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  process.stdout.write(
    JSON.stringify({
      __enc: "system-settings:v1",
      alg: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      data: data.toString("base64"),
    }) + "\n",
  );
}

function decryptSecret() {
  const envelope = JSON.parse(process.env.FIXTURE_ENVELOPE ?? "{}");
  if (
    envelope.__enc !== "system-settings:v1" ||
    envelope.alg !== "aes-256-gcm"
  ) {
    fail("FIXTURE_ENVELOPE is not a system-settings:v1 envelope");
  }
  const key = settingsKey();
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
  process.stdout.write(JSON.stringify({ plaintext: plain }) + "\n");
}

const mode = process.env.FIXTURE_MODE ?? "";
const queueName = process.env.BULLMQ_QUEUE ?? "situationMonitorSignals";
const connection = {
  host: process.env.BULLMQ_REDIS_HOST ?? "127.0.0.1",
  port: Number(process.env.BULLMQ_REDIS_PORT ?? "6379"),
  db: Number(process.env.BULLMQ_REDIS_DB ?? "0"),
  ...(process.env.BULLMQ_REDIS_PASSWORD
    ? { password: process.env.BULLMQ_REDIS_PASSWORD }
    : {}),
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (mode === "encrypt") {
  encryptSecret();
  process.exit(0);
}
if (mode === "decrypt") {
  decryptSecret();
  process.exit(0);
}

const queue = new Queue(queueName, {
  connection,
  defaultJobOptions: {
    removeOnFail: { age: 604800, count: 10000 },
  },
});

try {
  if (mode === "inspect") {
    const schedulers = await queue.getJobSchedulers(0, -1, true);
    const jobs = await queue.getJobs(["wait", "paused", "prioritized", "delayed"], 0, -1, true);
    const pending = [];
    for (const job of jobs) {
      if (!job) continue;
      pending.push({
        id: job.id,
        name: job.name,
        data: job.data,
        opts: job.opts,
      });
    }
    process.stdout.write(
      JSON.stringify({
        schedulers: schedulers.map((scheduler) => ({
          key: scheduler.key,
          name: scheduler.name,
          every: scheduler.every,
          next: scheduler.next,
          template: scheduler.template,
        })),
        jobs: pending,
      }) + "\n",
    );
  } else if (mode === "upsert") {
    const every = Number(process.env.FIXTURE_EVERY ?? "45000");
    await queue.upsertJobScheduler(
      "telegram-poll:scheduler",
      { every },
      {
        name: "telegram-poll",
        data: { type: "poll", source: "telegram" },
        opts: {
          removeOnComplete: true,
          removeOnFail: { age: 604800, count: 10000 },
        },
      },
    );
    process.stdout.write(JSON.stringify({ ok: true, every }) + "\n");
  } else if (mode === "remove") {
    await queue.removeJobScheduler("telegram-poll:scheduler");
    process.stdout.write(JSON.stringify({ ok: true }) + "\n");
  } else {
    fail(`unknown FIXTURE_MODE ${mode}`);
  }
} catch (error) {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await queue.close();
}
