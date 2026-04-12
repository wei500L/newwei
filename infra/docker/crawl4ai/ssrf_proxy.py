#!/usr/bin/env python3

import asyncio
import base64
import contextlib
import ipaddress
import json
import logging
import os
import socket
import ssl
from dataclasses import dataclass
from http import HTTPStatus
from typing import Optional
from urllib.parse import urlsplit, urlunsplit


LISTEN_HOST = os.getenv("CRAWL4AI_SSRF_PROXY_HOST", "127.0.0.1")
LISTEN_PORT = int(os.getenv("CRAWL4AI_SSRF_PROXY_PORT", "18080"))
HEADER_LIMIT = int(os.getenv("CRAWL4AI_SSRF_PROXY_HEADER_LIMIT", str(64 * 1024)))
CONNECT_TIMEOUT_SECONDS = float(
  os.getenv("CRAWL4AI_SSRF_PROXY_CONNECT_TIMEOUT_SECONDS", "15"),
)
AUTH_USER = "__modular_ssrf_proxy__"

BLOCKED_HOSTS = {
  "169.254.169.254",
  "169.254.170.2",
  "fd00:ec2::254",
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
  "instance-data",
}
BLOCKED_PATH_PREFIXES = (
  "/latest/meta-data",
  "/latest/user-data",
  "/latest/dynamic",
  "/computemetadata",
  "/metadata/instance",
  "/metadata/v1",
  "/openstack",
  "/opc/v1",
  "/opc/v2",
)

logger = logging.getLogger("crawl4ai-ssrf-proxy")


@dataclass(frozen=True)
class ProxyConfig:
  scheme: str
  host: str
  port: int
  username: Optional[str] = None
  password: Optional[str] = None


class ProxyRequestError(Exception):
  def __init__(self, status: int, message: str):
    super().__init__(message)
    self.status = status
    self.message = message


def normalize_hostname(hostname: str) -> str:
  return hostname.strip().lower().strip("[]")


def is_localhost_variation(hostname: str) -> bool:
  normalized = normalize_hostname(hostname)
  if normalized in {
    "localhost",
    "localhost.localdomain",
    "local",
    "127.0.0.1",
    "::1",
    "0.0.0.0",
    "0",
  }:
    return True
  if normalized.endswith(".localhost") or normalized.endswith(".local"):
    return True
  if normalized.startswith("0x7f") or normalized.startswith("0177."):
    return True
  if normalized.isdigit():
    value = int(normalized, 10)
    if value == 0 or 2130706433 <= value <= 2147483647:
      return True
  return False


def is_blocked_metadata_host(hostname: str) -> bool:
  normalized = normalize_hostname(hostname)
  if normalized in BLOCKED_HOSTS:
    return True
  return "metadata" in normalized or "instance-data" in normalized


def is_blocked_metadata_path(path: str) -> bool:
  normalized = (path or "/").lower()
  return any(normalized.startswith(prefix) for prefix in BLOCKED_PATH_PREFIXES)


def is_public_ip(address: str) -> bool:
  try:
    return ipaddress.ip_address(address).is_global
  except ValueError:
    return False


def parse_proxy_url(proxy_url: Optional[str]) -> Optional[ProxyConfig]:
  if not proxy_url:
    return None
  parsed = urlsplit(proxy_url)
  if parsed.scheme not in {"http", "https"}:
    raise ProxyRequestError(
      HTTPStatus.BAD_GATEWAY,
      f"Unsupported upstream proxy scheme: {parsed.scheme or 'unknown'}",
    )
  if not parsed.hostname or not parsed.port:
    raise ProxyRequestError(
      HTTPStatus.BAD_GATEWAY,
      "Upstream proxy URL must include a hostname and port",
    )
  return ProxyConfig(
    scheme=parsed.scheme,
    host=parsed.hostname,
    port=parsed.port,
    username=parsed.username,
    password=parsed.password,
  )


DEFAULT_HTTP_PROXY = parse_proxy_url(os.getenv("CRAWL4AI_HTTP_PROXY"))
DEFAULT_HTTPS_PROXY = parse_proxy_url(os.getenv("CRAWL4AI_HTTPS_PROXY"))


def parse_headers(lines: list[str]) -> dict[str, str]:
  headers: dict[str, str] = {}
  for line in lines:
    if not line:
      continue
    if ":" not in line:
      continue
    name, value = line.split(":", 1)
    headers[name.strip().lower()] = value.strip()
  return headers


def b64url_decode(value: str) -> bytes:
  padding = "=" * ((4 - len(value) % 4) % 4)
  return base64.urlsafe_b64decode(f"{value}{padding}")


def decode_override_proxy(headers: dict[str, str]) -> Optional[ProxyConfig]:
  auth = headers.get("proxy-authorization")
  if not auth or not auth.lower().startswith("basic "):
    return None
  try:
    decoded = base64.b64decode(auth.split(" ", 1)[1]).decode("utf-8")
  except Exception as exc:  # pragma: no cover - defensive
    raise ProxyRequestError(
      HTTPStatus.BAD_REQUEST,
      f"Invalid proxy authorization header: {exc}",
    ) from exc

  username, _, password = decoded.partition(":")
  if username != AUTH_USER or not password:
    return None

  try:
    payload = json.loads(b64url_decode(password).decode("utf-8"))
  except Exception as exc:
    raise ProxyRequestError(
      HTTPStatus.BAD_REQUEST,
      f"Invalid SSRF proxy payload: {exc}",
    ) from exc

  if not isinstance(payload, dict):
    raise ProxyRequestError(
      HTTPStatus.BAD_REQUEST,
      "Invalid SSRF proxy payload shape",
    )

  server = payload.get("server")
  if not isinstance(server, str) or not server.strip():
    raise ProxyRequestError(
      HTTPStatus.BAD_REQUEST,
      "Invalid SSRF proxy upstream server",
    )

  parsed = parse_proxy_url(server.strip())
  return ProxyConfig(
    scheme=parsed.scheme,
    host=parsed.host,
    port=parsed.port,
    username=payload.get("username") if isinstance(payload.get("username"), str) else None,
    password=payload.get("password") if isinstance(payload.get("password"), str) else None,
  )


def resolve_upstream_proxy(
  request_scheme: str,
  headers: dict[str, str],
) -> Optional[ProxyConfig]:
  override = decode_override_proxy(headers)
  if override is not None:
    return override
  return DEFAULT_HTTPS_PROXY if request_scheme == "https" else DEFAULT_HTTP_PROXY


async def read_header_block(reader: asyncio.StreamReader) -> bytes:
  block = await reader.readuntil(b"\r\n\r\n")
  if len(block) > HEADER_LIMIT:
    raise ProxyRequestError(
      HTTPStatus.REQUEST_HEADER_FIELDS_TOO_LARGE,
      "Proxy header block exceeds limit",
    )
  return block


def parse_request_target(
  method: str,
  target: str,
  headers: dict[str, str],
) -> tuple[str, int, str, str]:
  if method == "CONNECT":
    if ":" not in target:
      raise ProxyRequestError(HTTPStatus.BAD_REQUEST, "CONNECT target must include host:port")
    host, port_text = target.rsplit(":", 1)
    try:
      port = int(port_text)
    except ValueError as exc:
      raise ProxyRequestError(HTTPStatus.BAD_REQUEST, "Invalid CONNECT port") from exc
    return host, port, "https", "/"

  if target.startswith(("http://", "https://")):
    parsed = urlsplit(target)
    if not parsed.hostname:
      raise ProxyRequestError(HTTPStatus.BAD_REQUEST, "Proxy target is missing a hostname")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    path = urlunsplit(("", "", parsed.path or "/", parsed.query, parsed.fragment))
    return parsed.hostname, port, parsed.scheme, path

  host_header = headers.get("host")
  if not host_header:
    raise ProxyRequestError(HTTPStatus.BAD_REQUEST, "Proxy request is missing Host header")
  parsed_host = urlsplit(f"http://{host_header}")
  host = parsed_host.hostname or host_header
  port = parsed_host.port or 80
  return host, port, "http", target or "/"


def ensure_safe_target(host: str, port: int, path: str) -> tuple[str, int]:
  hostname = normalize_hostname(host)
  if not hostname:
    raise ProxyRequestError(HTTPStatus.BAD_REQUEST, "Proxy target hostname is empty")
  if is_localhost_variation(hostname):
    raise ProxyRequestError(HTTPStatus.FORBIDDEN, f"Blocked localhost target: {hostname}")
  if is_blocked_metadata_host(hostname) or is_blocked_metadata_path(path):
    raise ProxyRequestError(HTTPStatus.FORBIDDEN, f"Blocked metadata target: {hostname}")

  try:
    address = ipaddress.ip_address(hostname)
  except ValueError:
    address = None

  if address is not None:
    if not address.is_global:
      raise ProxyRequestError(
        HTTPStatus.FORBIDDEN,
        f"Blocked non-public target IP: {hostname}",
      )
    return str(address), port

  addrinfo = socket.getaddrinfo(
    hostname,
    port,
    type=socket.SOCK_STREAM,
    proto=socket.IPPROTO_TCP,
  )
  resolved: list[tuple[str, int]] = []
  for family, _, _, _, sockaddr in addrinfo:
    if family == socket.AF_INET:
      address_text = sockaddr[0]
    elif family == socket.AF_INET6:
      address_text = sockaddr[0]
    else:
      continue
    if not is_public_ip(address_text):
      raise ProxyRequestError(
        HTTPStatus.FORBIDDEN,
        f"Blocked non-public DNS answer for {hostname}: {address_text}",
      )
    resolved.append((address_text, family))

  if not resolved:
    raise ProxyRequestError(
      HTTPStatus.BAD_GATEWAY,
      f"Unable to resolve a public address for {hostname}",
    )

  resolved.sort(key=lambda item: 0 if item[1] == socket.AF_INET else 1)
  return resolved[0][0], port


async def open_upstream_connection(proxy: ProxyConfig) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
  ssl_context = None
  server_hostname = None
  if proxy.scheme == "https":
    ssl_context = ssl.create_default_context()
    server_hostname = proxy.host
  return await asyncio.wait_for(
    asyncio.open_connection(
      proxy.host,
      proxy.port,
      ssl=ssl_context,
      server_hostname=server_hostname,
      limit=HEADER_LIMIT,
    ),
    timeout=CONNECT_TIMEOUT_SECONDS,
  )


def build_basic_auth(username: Optional[str], password: Optional[str]) -> Optional[str]:
  if not username:
    return None
  token = base64.b64encode(f"{username}:{password or ''}".encode("utf-8")).decode("ascii")
  return f"Basic {token}"


async def open_target_connection(
  target_host: str,
  target_port: int,
  original_authority: str,
  upstream_proxy: Optional[ProxyConfig],
) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
  if upstream_proxy is None:
    return await asyncio.wait_for(
      asyncio.open_connection(target_host, target_port, limit=HEADER_LIMIT),
      timeout=CONNECT_TIMEOUT_SECONDS,
    )

  reader, writer = await open_upstream_connection(upstream_proxy)
  connect_headers = [f"CONNECT {target_host}:{target_port} HTTP/1.1", f"Host: {original_authority}"]
  auth_header = build_basic_auth(upstream_proxy.username, upstream_proxy.password)
  if auth_header:
    connect_headers.append(f"Proxy-Authorization: {auth_header}")
  connect_headers.append("Connection: close")
  writer.write(("\r\n".join(connect_headers) + "\r\n\r\n").encode("latin-1"))
  await writer.drain()

  response = (await read_header_block(reader)).decode("latin-1")
  status_line = response.split("\r\n", 1)[0]
  try:
    _, status_code_text, _ = status_line.split(" ", 2)
    status_code = int(status_code_text)
  except ValueError as exc:
    writer.close()
    await writer.wait_closed()
    raise ProxyRequestError(
      HTTPStatus.BAD_GATEWAY,
      "Invalid response from upstream proxy",
    ) from exc
  if status_code != HTTPStatus.OK:
    writer.close()
    await writer.wait_closed()
    raise ProxyRequestError(
      HTTPStatus.BAD_GATEWAY,
      f"Upstream proxy CONNECT failed with HTTP {status_code}",
    )
  return reader, writer


async def stream_bytes(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
  try:
    while True:
      chunk = await reader.read(65536)
      if not chunk:
        break
      writer.write(chunk)
      await writer.drain()
  finally:
    with contextlib.suppress(Exception):
      writer.close()


async def tunnel(
  left_reader: asyncio.StreamReader,
  left_writer: asyncio.StreamWriter,
  right_reader: asyncio.StreamReader,
  right_writer: asyncio.StreamWriter,
) -> None:
  left_to_right = asyncio.create_task(stream_bytes(left_reader, right_writer))
  right_to_left = asyncio.create_task(stream_bytes(right_reader, left_writer))
  done, pending = await asyncio.wait(
    {left_to_right, right_to_left},
    return_when=asyncio.FIRST_COMPLETED,
  )
  for task in pending:
    task.cancel()
  await asyncio.gather(*done, return_exceptions=True)
  await asyncio.gather(*pending, return_exceptions=True)


async def forward_content_length_body(
  reader: asyncio.StreamReader,
  writer: asyncio.StreamWriter,
  headers: dict[str, str],
) -> None:
  content_length = headers.get("content-length")
  if not content_length:
    return
  try:
    remaining = int(content_length)
  except ValueError as exc:
    raise ProxyRequestError(HTTPStatus.BAD_REQUEST, "Invalid Content-Length header") from exc
  while remaining > 0:
    chunk = await reader.read(min(65536, remaining))
    if not chunk:
      raise ProxyRequestError(HTTPStatus.BAD_REQUEST, "Unexpected EOF while reading request body")
    writer.write(chunk)
    await writer.drain()
    remaining -= len(chunk)


async def forward_chunked_body(
  reader: asyncio.StreamReader,
  writer: asyncio.StreamWriter,
) -> None:
  while True:
    chunk_header = await reader.readuntil(b"\r\n")
    if len(chunk_header) > HEADER_LIMIT:
      raise ProxyRequestError(
        HTTPStatus.REQUEST_HEADER_FIELDS_TOO_LARGE,
        "Chunk header exceeds limit",
      )
    writer.write(chunk_header)
    await writer.drain()

    size_text = chunk_header[:-2].split(b";", 1)[0].strip()
    try:
      chunk_size = int(size_text, 16)
    except ValueError as exc:
      raise ProxyRequestError(
        HTTPStatus.BAD_REQUEST,
        "Invalid chunk size in request body",
      ) from exc

    remaining = chunk_size + 2
    while remaining > 0:
      chunk = await reader.read(min(65536, remaining))
      if not chunk:
        raise ProxyRequestError(
          HTTPStatus.BAD_REQUEST,
          "Unexpected EOF while reading chunked request body",
        )
      writer.write(chunk)
      await writer.drain()
      remaining -= len(chunk)

    if chunk_size == 0:
      while True:
        trailer_line = await reader.readuntil(b"\r\n")
        if len(trailer_line) > HEADER_LIMIT:
          raise ProxyRequestError(
            HTTPStatus.REQUEST_HEADER_FIELDS_TOO_LARGE,
            "Chunk trailer exceeds limit",
          )
        writer.write(trailer_line)
        await writer.drain()
        if trailer_line == b"\r\n":
          return


async def forward_request_body(
  reader: asyncio.StreamReader,
  writer: asyncio.StreamWriter,
  headers: dict[str, str],
) -> None:
  transfer_encoding = headers.get("transfer-encoding", "")
  encoding_tokens = [
    token.strip().lower() for token in transfer_encoding.split(",") if token.strip()
  ]
  if encoding_tokens:
    if "chunked" not in encoding_tokens:
      raise ProxyRequestError(
        HTTPStatus.NOT_IMPLEMENTED,
        "Unsupported Transfer-Encoding for proxy request body",
      )
    await forward_chunked_body(reader, writer)
    return
  await forward_content_length_body(reader, writer, headers)


def rewrite_request_headers(
  original_headers: dict[str, str],
  authority: str,
) -> list[str]:
  has_transfer_encoding = bool(original_headers.get("transfer-encoding"))
  rewritten: list[str] = [f"Host: {authority}", "Connection: close"]
  for name, value in original_headers.items():
    if name in {"host", "proxy-authorization", "proxy-connection", "connection"}:
      continue
    if has_transfer_encoding and name == "content-length":
      continue
    rewritten.append(f"{name}: {value}")
  return rewritten


async def handle_connect(
  client_reader: asyncio.StreamReader,
  client_writer: asyncio.StreamWriter,
  host: str,
  port: int,
  headers: dict[str, str],
) -> None:
  target_ip, target_port = ensure_safe_target(host, port, "/")
  authority = f"{host}:{port}"
  upstream_proxy = resolve_upstream_proxy("https", headers)
  upstream_reader, upstream_writer = await open_target_connection(
    target_ip,
    target_port,
    authority,
    upstream_proxy,
  )
  client_writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
  await client_writer.drain()
  await tunnel(client_reader, client_writer, upstream_reader, upstream_writer)


async def relay_response(
  reader: asyncio.StreamReader,
  writer: asyncio.StreamWriter,
) -> None:
  while True:
    chunk = await reader.read(65536)
    if not chunk:
      break
    writer.write(chunk)
    await writer.drain()


async def handle_http_request(
  client_reader: asyncio.StreamReader,
  client_writer: asyncio.StreamWriter,
  method: str,
  target: str,
  version: str,
  headers: dict[str, str],
) -> None:
  host, port, scheme, path = parse_request_target(method, target, headers)
  target_ip, target_port = ensure_safe_target(host, port, path)
  authority_host = f"[{host}]" if ":" in host and not host.startswith("[") else host
  authority = f"{authority_host}:{port}" if port not in {80, 443} else authority_host
  upstream_proxy = resolve_upstream_proxy(scheme, headers)

  if upstream_proxy is None:
    upstream_reader, upstream_writer = await asyncio.wait_for(
      asyncio.open_connection(target_ip, target_port, limit=HEADER_LIMIT),
      timeout=CONNECT_TIMEOUT_SECONDS,
    )
    request_target = path
    proxy_auth_header = None
  else:
    upstream_reader, upstream_writer = await open_upstream_connection(upstream_proxy)
    target_netloc = f"[{target_ip}]:{target_port}" if ":" in target_ip else f"{target_ip}:{target_port}"
    absolute_target = f"{scheme}://{target_netloc}{path if path.startswith('/') else f'/{path}'}"
    request_target = absolute_target
    proxy_auth_header = build_basic_auth(upstream_proxy.username, upstream_proxy.password)

  header_lines = rewrite_request_headers(headers, authority)
  if proxy_auth_header:
    header_lines.append(f"Proxy-Authorization: {proxy_auth_header}")

  request_bytes = (
    f"{method} {request_target} {version}\r\n" + "\r\n".join(header_lines) + "\r\n\r\n"
  ).encode("latin-1")
  upstream_writer.write(request_bytes)
  await upstream_writer.drain()
  await forward_request_body(client_reader, upstream_writer, headers)
  await relay_response(upstream_reader, client_writer)
  upstream_writer.close()
  await upstream_writer.wait_closed()


async def send_error(
  writer: asyncio.StreamWriter,
  status: int,
  message: str,
) -> None:
  reason = HTTPStatus(status).phrase if status in HTTPStatus._value2member_map_ else "Proxy Error"
  body = message.encode("utf-8", errors="replace")
  response = (
    f"HTTP/1.1 {status} {reason}\r\n"
    "Connection: close\r\n"
    "Content-Type: text/plain; charset=utf-8\r\n"
    f"Content-Length: {len(body)}\r\n\r\n"
  ).encode("latin-1")
  writer.write(response + body)
  await writer.drain()


async def handle_client(
  reader: asyncio.StreamReader,
  writer: asyncio.StreamWriter,
) -> None:
  peer = writer.get_extra_info("peername")
  try:
    block = await read_header_block(reader)
    text = block.decode("latin-1")
    request_line, *raw_header_lines = text.split("\r\n")
    method, target, version = request_line.split(" ", 2)
    headers = parse_headers(raw_header_lines)

    if method.upper() == "CONNECT":
      host, port, _, _ = parse_request_target("CONNECT", target, headers)
      await handle_connect(reader, writer, host, port, headers)
    else:
      await handle_http_request(reader, writer, method.upper(), target, version, headers)
  except asyncio.IncompleteReadError:
    logger.warning("client disconnected before proxy request completed", extra={"peer": peer})
  except ProxyRequestError as exc:
    logger.warning("proxy blocked request: %s", exc.message, extra={"peer": peer})
    await send_error(writer, int(exc.status), exc.message)
  except Exception as exc:  # pragma: no cover - defensive
    logger.exception("proxy request failed", extra={"peer": peer})
    await send_error(writer, int(HTTPStatus.BAD_GATEWAY), str(exc))
  finally:
    writer.close()
    await writer.wait_closed()


async def main() -> None:
  logging.basicConfig(
    level=os.getenv("CRAWL4AI_SSRF_PROXY_LOG_LEVEL", "INFO"),
    format="[crawl4ai-ssrf-proxy] %(levelname)s %(message)s",
  )
  server = await asyncio.start_server(
    handle_client,
    host=LISTEN_HOST,
    port=LISTEN_PORT,
    limit=HEADER_LIMIT,
  )
  sockets = ", ".join(str(sock.getsockname()) for sock in server.sockets or [])
  logger.info("listening on %s", sockets)
  async with server:
    await server.serve_forever()


if __name__ == "__main__":
  asyncio.run(main())
