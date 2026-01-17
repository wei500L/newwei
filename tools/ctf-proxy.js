/* eslint-disable no-console */
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

// Simple reverse proxy so the OAuth redirect URI `http://localhost:9678/auth/callback`
// can complete against the upstream CTF service.
const UPSTREAM_ORIGIN = 'https://ctf.hotaruapi.top';
const LISTEN_PORT = 9678;
const LOCAL_ORIGIN = `http://localhost:${LISTEN_PORT}`;

function rewriteLocation(location) {
  if (!location) return location;

  // Rewrite absolute redirects back to our local origin so the browser stays on localhost.
  return location
    .replace(/^https:\/\/ctf\.hotaruapi\.top\b/i, LOCAL_ORIGIN)
    .replace(/^http:\/\/ctf\.hotaruapi\.top\b/i, LOCAL_ORIGIN);
}

function rewriteSetCookie(setCookie) {
  if (!setCookie) return setCookie;

  // We serve over plain HTTP on localhost, so Secure cookies won't be stored by the browser.
  // Also strip any Domain attribute so cookies stay host-only for localhost.
  return setCookie
    .replace(/;\s*secure/gi, '')
    .replace(/;\s*domain=[^;]+/gi, '');
}

const server = http.createServer((req, res) => {
  try {
    const upstreamUrl = new URL(req.url || '/', UPSTREAM_ORIGIN);

    const headers = { ...req.headers };
    headers.host = upstreamUrl.host;

    // Avoid upstream sending back compressed HTML if we ever need to inspect it later.
    // Not strictly required, but keeps responses predictable.
    delete headers['accept-encoding'];

    const upstreamReq = https.request(
      {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || 443,
        method: req.method,
        path: upstreamUrl.pathname + upstreamUrl.search,
        headers,
      },
      (upstreamRes) => {
        const outHeaders = { ...upstreamRes.headers };

        if (outHeaders.location) {
          outHeaders.location = rewriteLocation(outHeaders.location);
        }

        if (Array.isArray(outHeaders['set-cookie'])) {
          outHeaders['set-cookie'] = outHeaders['set-cookie'].map(rewriteSetCookie);
        } else if (typeof outHeaders['set-cookie'] === 'string') {
          outHeaders['set-cookie'] = rewriteSetCookie(outHeaders['set-cookie']);
        }

        res.writeHead(upstreamRes.statusCode || 502, outHeaders);
        upstreamRes.pipe(res);
      },
    );

    upstreamReq.on('error', (err) => {
      res.statusCode = 502;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(`Proxy upstream error: ${err.message}`);
    });

    req.pipe(upstreamReq);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end(`Proxy error: ${err.message}`);
  }
});

server.listen(LISTEN_PORT, () => {
  console.log(`[ctf-proxy] listening on ${LOCAL_ORIGIN} -> ${UPSTREAM_ORIGIN}`);
});

