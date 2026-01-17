/* eslint-disable no-console */
'use strict';

const crypto = require('crypto');

const BASE_URL = process.env.CTF_BASE_URL || 'https://ctf.hotaruapi.top';
const COOKIE = process.env.CTF_COOKIE || process.env.COOKIE || '';

// Start slightly below 2s and adapt if the server complains "Too fast".
// This helps maximize the number of rounds we can complete before session expiry.
const INITIAL_DELAY_MS = Number.parseInt(process.env.CTF_DELAY_MS || '1500', 10);
// Upper bound to avoid infinite loops if the remote behavior changes.
const MAX_ROUNDS = Number.parseInt(process.env.CTF_MAX_ROUNDS || '320', 10);

if (!COOKIE) {
  console.error('Missing cookie. Set CTF_COOKIE (or COOKIE) env var.');
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function evaluateRpn(expr) {
  const stack = [];
  const tokens = String(expr).trim().split(/\s+/);

  for (const tok of tokens) {
    if (!tok) continue;

    if (/^-?\d+$/.test(tok)) {
      stack.push(Number(tok));
      continue;
    }

    const b = stack.pop();
    const a = stack.pop();
    if (a === undefined || b === undefined) {
      throw new Error(`Bad RPN expression (stack underflow): ${expr}`);
    }

    switch (tok) {
      case '+':
        stack.push(a + b);
        break;
      case '-':
        stack.push(a - b);
        break;
      case '*':
        stack.push(a * b);
        break;
      case '/':
        // Likely all-positive inputs, but keep deterministic integer division.
        stack.push(Math.trunc(a / b));
        break;
      default:
        throw new Error(`Unknown RPN operator "${tok}" in: ${expr}`);
    }
  }

  if (stack.length !== 1) {
    throw new Error(`Bad RPN expression (stack not singular): ${expr}`);
  }

  return stack[0];
}

async function api(path, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      cookie: COOKIE,
      'accept-encoding': 'identity',
      ...headers,
    },
    body,
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return { res, data };
}

async function main() {
  const { data: user, res: userRes } = await api('/api/user');
  if (!userRes.ok) {
    console.error('Failed to load user. Are cookies valid?');
    console.error(`HTTP ${userRes.status}`, user);
    process.exit(1);
  }

  const claimKey = sha256Hex(`claim_${user.id}`).slice(0, 16);
  console.log(`[ctf] user=${user.username} id=${user.id} claimKey=${claimKey}`);

  let roundsSolved = 0;
  while (true) {
    let delayMs = INITIAL_DELAY_MS;
    let sessionSolved = 0;

    const { data: init, res: initRes } = await api('/api/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!initRes.ok || !init?.token) {
      console.error('Init failed:', initRes.status, init);
      process.exit(1);
    }

    const token = init.token;

    // First call: ask for the challenge.
    await sleep(delayMs);
    let { data, res } = await api('/api/claim', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-token': token,
        'x-claim-key': claimKey,
      },
      body: JSON.stringify({ interactionTime: 4000 }),
    });

    for (let i = 0; i < MAX_ROUNDS; i++) {
      if (res.ok) {
        console.log('[ctf] claim success:', data);
        return;
      }

      const err = data?.error;
      if (err === 'Too fast') {
        delayMs = Math.min(delayMs + 150, 2500);
        console.log(`[ctf] server says Too fast; bump delay -> ${delayMs}ms`);
        await sleep(delayMs);
        ({ data, res } = await api('/api/claim', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-session-token': token,
            'x-claim-key': claimKey,
          },
          body: JSON.stringify({ interactionTime: 4000 }),
        }));
        continue;
      }

      if (err === 'Session expired') {
        console.log(`[ctf] session expired after ${sessionSolved} solves; restarting...`);
        break; // Restart outer loop: re-init.
      }
      if (err === 'Challenge expired') {
        console.log(`[ctf] challenge expired after ${sessionSolved} solves; restarting...`);
        break; // Restart whole flow.
      }

      if (err !== 'Verification required' || typeof data?.data?.q !== 'string') {
        console.error('[ctf] unexpected response:', res.status, data);
        process.exit(1);
      }

      const q = data.data.q;
      const ans = evaluateRpn(q);
      roundsSolved++;
      sessionSolved++;
      if (roundsSolved % 10 === 0) {
        console.log(`[ctf] #${roundsSolved} ${q} = ${ans}`);
      }

      await sleep(delayMs);
      ({ data, res } = await api('/api/claim', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-session-token': token,
          'x-claim-key': claimKey,
        },
        body: JSON.stringify({ interactionTime: 4000, verification: ans }),
      }));
    }

    console.log('[ctf] restarting flow (max rounds reached or expired).');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
