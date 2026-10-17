import { createHash, createPublicKey, publicEncrypt, constants } from "node:crypto";
import { connect, type Socket } from "node:net";

const LOCK_TIMEOUT_SECONDS = 10;
const CLIENT_PROTOCOL_41 = 0x00000200;
const CLIENT_SECURE_CONNECTION = 0x00008000;
const CLIENT_PLUGIN_AUTH = 0x00080000;
const CLIENT_CONNECT_WITH_DB = 0x00000008;
const CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA = 0x00200000;
const CLIENT_LONG_PASSWORD = 0x00000001;
const CLIENT_TRANSACTIONS = 0x00002000;

const CLIENT_CAPABILITIES =
  CLIENT_LONG_PASSWORD |
  CLIENT_PROTOCOL_41 |
  CLIENT_SECURE_CONNECTION |
  CLIENT_PLUGIN_AUTH |
  CLIENT_CONNECT_WITH_DB |
  CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA |
  CLIENT_TRANSACTIONS;

export class SituationMonitorLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SituationMonitorLockError";
  }
}

// 与 apps/api-go/internal/contentsubscriptions/store.go 的 subscriptionLockName 相同。
export function situationMonitorUserLockName(orgId: string, userId: string): string {
  const raw = `ucs:${orgId}:${userId}`;
  if ([...raw].length <= 64) {
    return raw;
  }
  const digest = createHash("sha256")
    .update(`${orgId}\u0000${userId}`, "utf8")
    .digest("hex");
  return `ucs:${digest.slice(0, 60)}`;
}

interface MysqlTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

interface LockSession {
  query(sql: string): Promise<Record<string, string | null>[]>;
  close(): Promise<void>;
}

export async function withSituationMonitorUserLock<T>(
  databaseURL: string,
  orgId: string,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return await withMysqlSessionLock(databaseURL, situationMonitorUserLockName(orgId, userId), fn);
}

// withMysqlSessionLock 在一条专用 MySQL 连接上持有 GET_LOCK(name, 10)，
// 回调完成后 RELEASE_LOCK。名字必须是已算好的会话锁名（≤64 字符）。
// 调用方负责保证不同逻辑互不串名；这把锁不放进 Prisma 事务。
export async function withMysqlSessionLock<T>(
  databaseURL: string,
  lockName: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!databaseURL.trim()) {
    throw new SituationMonitorLockError("content subscription lock not acquired");
  }
  const session = await openMysqlLockSession(databaseURL);
  let held = false;
  try {
    const rows = await session.query(
      `SELECT GET_LOCK(${sqlString(lockName)}, ${LOCK_TIMEOUT_SECONDS}) AS acquired`,
    );
    const acquired = rows[0]?.acquired;
    held = acquired === "1";
    if (!held) {
      throw new SituationMonitorLockError("content subscription lock not acquired");
    }
    try {
      return await fn();
    } finally {
      try {
        await session.query(`SELECT RELEASE_LOCK(${sqlString(lockName)})`);
      } catch {
        // 连接关闭时 MySQL 会释放这把会话锁。
      }
    }
  } finally {
    await session.close();
  }
}

function copyBuffer(value: Uint8Array) {
  const out = Buffer.alloc(value.byteLength);
  out.set(value);
  return out;
}

function sqlString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function parseMysqlURL(raw: string): MysqlTarget {
  const parsed = new URL(raw);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!parsed.hostname || !database || !parsed.username) {
    throw new SituationMonitorLockError("content subscription lock not acquired");
  }
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
  };
}

function openMysqlLockSession(databaseURL: string): Promise<LockSession> {
  const target = parseMysqlURL(databaseURL);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: target.host, port: target.port });
    const session = new MysqlLockSession(socket);
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(20_000);
    socket.once("timeout", () => {
      fail(new SituationMonitorLockError("content subscription lock not acquired"));
    });
    socket.once("error", (error: Error) => {
      fail(error);
    });
    socket.once("connect", () => {
      session
        .handshake(target)
        .then(() => resolve(session))
        .catch(fail);
    });
  });
}

class MysqlLockSession implements LockSession {
  private readonly socket: Socket;
  private buffer = Buffer.alloc(0);
  private seq = 0;
  private scramble = Buffer.alloc(0);
  private waiters: ((chunk: Buffer) => void)[] = [];

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      const pending = this.waiters;
      this.waiters = [];
      for (const waiter of pending) {
        waiter(this.buffer);
      }
    });
  }

  async handshake(target: MysqlTarget): Promise<void> {
    this.seq = 0;
    const greeting = await this.readPacket();
    if (greeting[0] === 0xff) {
      throw new SituationMonitorLockError(mysqlError(greeting));
    }
    const parsed = parseGreeting(greeting);
    this.scramble = copyBuffer(parsed.scramble);
    const auth = authResponse(target.password, parsed.plugin, parsed.scramble);
    const response = buildHandshakeResponse(target, parsed.plugin, auth);
    await this.writePacket(response);
    await this.finishAuth(target.password, parsed.plugin);
  }

  async query(sql: string): Promise<Record<string, string | null>[]> {
    this.seq = 0;
    await this.writePacket(Buffer.concat([Buffer.from([0x03]), Buffer.from(sql, "utf8")]));
    return await this.readRows();
  }

  close(): Promise<void> {
    this.socket.destroy();
    return Promise.resolve();
  }

  private async finishAuth(password: string, plugin: string): Promise<void> {
    const packet = await this.readPacket();
    if (packet[0] === 0x00) {
      return;
    }
    if (packet[0] === 0xff) {
      throw new SituationMonitorLockError(mysqlError(packet));
    }
    if (packet[0] === 0xfe) {
      const switched = parseAuthSwitch(packet);
      this.scramble = switched.scramble.length > 0 ? copyBuffer(switched.scramble) : this.scramble;
      await this.writePacket(authResponse(password, switched.plugin, this.scramble));
      await this.finishAuth(password, switched.plugin);
      return;
    }
    if (packet[0] === 0x01 && packet[1] === 0x03) {
      const ok = await this.readPacket();
      if (ok[0] === 0xff) {
        throw new SituationMonitorLockError(mysqlError(ok));
      }
      return;
    }
    if (packet[0] === 0x01 && packet[1] === 0x04) {
      await this.writePacket(Buffer.from([0x02]));
      const keyPacket = await this.readPacket();
      const pemStart = keyPacket.indexOf(Buffer.from("-----BEGIN"));
      const pem = (pemStart >= 0 ? keyPacket.subarray(pemStart) : keyPacket.subarray(1)).toString("utf8");
      const encrypted = encryptPassword(password, this.scramble, pem);
      await this.writePacket(encrypted);
      const ok = await this.readPacket();
      if (ok[0] === 0xff) {
        throw new SituationMonitorLockError(mysqlError(ok));
      }
      return;
    }
    throw new SituationMonitorLockError(`unexpected mysql auth packet for ${plugin}`);
  }

  private async readRows(): Promise<Record<string, string | null>[]> {
    const first = await this.readPacket();
    if (first[0] === 0xff) {
      throw new SituationMonitorLockError(mysqlError(first));
    }
    if (first[0] === 0x00 || (first[0] === 0xfe && first.length < 9)) {
      return [];
    }
    const columnCount = readLenenc(first, 0).value ?? 0;
    const names: string[] = [];
    for (let index = 0; index < columnCount; index += 1) {
      names.push(columnName(await this.readPacket()));
    }
    const headerEof = await this.readPacket();
    if (headerEof[0] === 0xff) {
      throw new SituationMonitorLockError(mysqlError(headerEof));
    }
    const rows: Record<string, string | null>[] = [];
    for (;;) {
      const row = await this.readPacket();
      if (row[0] === 0xff) {
        throw new SituationMonitorLockError(mysqlError(row));
      }
      if (row[0] === 0xfe && row.length < 9) {
        break;
      }
      rows.push(parseTextRow(row, names));
    }
    return rows;
  }

  private writePacket(payload: Buffer): Promise<void> {
    const header = Buffer.alloc(4);
    header.writeUIntLE(payload.length, 0, 3);
    header[3] = this.seq & 0xff;
    this.seq = (this.seq + 1) & 0xff;
    return new Promise((resolve, reject) => {
      this.socket.write(Buffer.concat([header, payload]), (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async readPacket(): Promise<Buffer> {
    const header = await this.readExact(4);
    const length = (header[0] ?? 0) | ((header[1] ?? 0) << 8) | ((header[2] ?? 0) << 16);
    this.seq = ((header[3] ?? 0) + 1) & 0xff;
    if (length === 0) {
      return Buffer.alloc(0);
    }
    return await this.readExact(length);
  }

  private readExact(length: number): Promise<Buffer> {
    return new Promise((resolve) => {
      const take = () => {
        if (this.buffer.length < length) {
          this.waiters.push(() => take());
          return;
        }
        const out = this.buffer.subarray(0, length);
        this.buffer = this.buffer.subarray(length);
        resolve(Buffer.from(out));
      };
      take();
    });
  }
}

function parseGreeting(packet: Buffer): { plugin: string; scramble: Buffer } {
  let offset = 1;
  while (offset < packet.length && packet[offset] !== 0) {
    offset += 1;
  }
  offset += 1;
  offset += 4;
  const part1 = packet.subarray(offset, offset + 8);
  offset += 9;
  const capabilityLower = packet.readUInt16LE(offset);
  offset += 2;
  let capability = capabilityLower;
  let plugin = "mysql_native_password";
  let part2 = Buffer.alloc(0);
  if (offset < packet.length) {
    offset += 1;
    offset += 2;
    const capabilityUpper = packet.readUInt16LE(offset);
    offset += 2;
    capability = capabilityLower | (capabilityUpper << 16);
    const authLen = packet[offset] ?? 0;
    offset += 1;
    offset += 10;
    const rest = Math.max(13, authLen - 8);
    part2 = copyBuffer(packet.subarray(offset, Math.min(packet.length, offset + rest)));
    offset += part2.length;
    if ((capability & CLIENT_PLUGIN_AUTH) !== 0) {
      const start = offset;
      while (offset < packet.length && packet[offset] !== 0) {
        offset += 1;
      }
      plugin = packet.subarray(start, offset).toString("utf8") || plugin;
    }
  }
  const scramble = Buffer.concat([part1, part2]);
  const nul = scramble.indexOf(0);
  return { plugin, scramble: nul >= 0 ? copyBuffer(scramble.subarray(0, nul)) : scramble };
}

function parseAuthSwitch(packet: Buffer): { plugin: string; scramble: Buffer } {
  let offset = 1;
  const start = offset;
  while (offset < packet.length && packet[offset] !== 0) {
    offset += 1;
  }
  const plugin = packet.subarray(start, offset).toString("utf8");
  offset += 1;
  const scramble = packet.subarray(offset);
  const nul = scramble.indexOf(0);
  return {
    plugin,
    scramble: copyBuffer(nul >= 0 ? scramble.subarray(0, nul) : scramble),
  };
}

function buildHandshakeResponse(target: MysqlTarget, plugin: string, auth: Buffer): Buffer {
  const user = Buffer.from(`${target.user}\u0000`, "utf8");
  const database = Buffer.from(`${target.database}\u0000`, "utf8");
  const pluginName = Buffer.from(`${plugin}\u0000`, "utf8");
  const head = Buffer.alloc(4 + 4 + 1 + 23);
  head.writeUInt32LE(CLIENT_CAPABILITIES, 0);
  head.writeUInt32LE(0x00ffffff, 4);
  head[8] = 45;
  const authLen = Buffer.from(writeLenenc(auth.length));
  return Buffer.concat([head, user, authLen, auth, database, pluginName]);
}

function authResponse(password: string, plugin: string, scramble: Buffer): Buffer {
  if (!password) {
    return Buffer.alloc(0);
  }
  if (plugin === "caching_sha2_password") {
    return scrambleSha256(password, scramble);
  }
  return scrambleNative(password, scramble);
}

function scrambleSha256(password: string, seed: Buffer): Buffer {
  const hash1 = createHash("sha256").update(password, "utf8").digest();
  const hash2 = createHash("sha256").update(hash1).digest();
  const mixed = createHash("sha256").update(Buffer.concat([hash2, seed])).digest();
  const out = Buffer.from(hash1);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = (out[index] ?? 0) ^ (mixed[index] ?? 0);
  }
  return out;
}

function scrambleNative(password: string, seed: Buffer): Buffer {
  const stage1 = createHash("sha1").update(password, "utf8").digest();
  const stage2 = createHash("sha1").update(stage1).digest();
  const stage3 = createHash("sha1").update(Buffer.concat([seed, stage2])).digest();
  const out = Buffer.from(stage1);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = (out[index] ?? 0) ^ (stage3[index] ?? 0);
  }
  return out;
}

function encryptPassword(password: string, seed: Buffer, pem: string): Buffer {
  const plain = Buffer.from(`${password}\u0000`, "utf8");
  for (let index = 0; index < plain.length; index += 1) {
    plain[index] = (plain[index] ?? 0) ^ (seed[index % seed.length] ?? 0);
  }
  return publicEncrypt(
    {
      key: createPublicKey(pem),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha1",
    },
    plain,
  );
}

function writeLenenc(value: number): number[] {
  if (value < 251) {
    return [value];
  }
  return [0xfc, value & 0xff, (value >> 8) & 0xff];
}

function readLenenc(packet: Buffer, offset: number): { value: number | null; next: number } {
  const first = packet[offset] ?? 0;
  if (first < 251) {
    return { value: first, next: offset + 1 };
  }
  if (first === 0xfb) {
    return { value: null, next: offset + 1 };
  }
  if (first === 0xfc) {
    return { value: packet.readUInt16LE(offset + 1), next: offset + 3 };
  }
  if (first === 0xfd) {
    return { value: packet.readUIntLE(offset + 1, 3), next: offset + 4 };
  }
  return { value: Number(packet.readBigUInt64LE(offset + 1)), next: offset + 9 };
}

function readLenencString(packet: Buffer, offset: number): { value: Buffer; next: number } {
  const length = readLenenc(packet, offset);
  if (length.value === null) {
    return { value: Buffer.alloc(0), next: length.next };
  }
  const end = length.next + length.value;
  return { value: packet.subarray(length.next, end), next: end };
}

function columnName(packet: Buffer): string {
  let offset = 0;
  for (let index = 0; index < 4; index += 1) {
    offset = readLenencString(packet, offset).next;
  }
  return readLenencString(packet, offset).value.toString("utf8");
}

function parseTextRow(packet: Buffer, names: string[]): Record<string, string | null> {
  const row: Record<string, string | null> = {};
  let offset = 0;
  for (const name of names) {
    if ((packet[offset] ?? 0) === 0xfb) {
      row[name] = null;
      offset += 1;
      continue;
    }
    const field = readLenencString(packet, offset);
    row[name] = field.value.toString("utf8");
    offset = field.next;
  }
  return row;
}

function mysqlError(packet: Buffer): string {
  const message = packet.subarray(packet[3] === 0x23 ? 9 : 3).toString("utf8");
  return message || "mysql error";
}
