#!/usr/bin/env python3

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
import urllib.request
from copy import deepcopy
from typing import Any, Dict, List, Optional, Tuple

import yaml


def parse_env_bool(value: Optional[str], default: bool = False) -> bool:
  if value is None:
    return default
  normalized = value.strip().lower()
  if normalized in {"1", "true", "yes", "on"}:
    return True
  if normalized in {"0", "false", "no", "off"}:
    return False
  return default


def parse_csv(value: str) -> List[str]:
  return [entry.strip() for entry in value.split(",") if entry.strip()]


def parse_positive_int(value: str) -> Optional[int]:
  raw = value.strip()
  if not raw:
    return None
  try:
    parsed = int(raw, 10)
  except ValueError:
    return None
  return parsed if parsed > 0 else None


def parse_positive_int_any(value: Any) -> Optional[int]:
  if isinstance(value, bool):
    return None
  if isinstance(value, int):
    return value if value > 0 else None
  if isinstance(value, float):
    parsed = int(value)
    return parsed if parsed > 0 else None
  if isinstance(value, str):
    return parse_positive_int(value)
  return None


def parse_port_any(value: Any) -> Optional[int]:
  parsed = parse_positive_int_any(value)
  if parsed is None:
    return None
  if parsed < 1 or parsed > 65535:
    return None
  return parsed


def infer_plural_key_env(var_name: str) -> str:
  if var_name.endswith("_API_KEY"):
    return f"{var_name}S"
  return f"{var_name}S"


def normalize_key_list(raw: Any) -> List[str]:
  if not isinstance(raw, list):
    return []
  out: List[str] = []
  for entry in raw:
    if not isinstance(entry, str):
      continue
    trimmed = entry.strip()
    if not trimmed:
      continue
    out.append(trimmed)

  # De-duplicate but preserve order
  seen = set()
  unique: List[str] = []
  for entry in out:
    if entry in seen:
      continue
    seen.add(entry)
    unique.append(entry)
  return unique


def strip_bearer_prefix(value: str) -> str:
  trimmed = value.strip()
  if trimmed.lower().startswith("bearer "):
    return trimmed[7:].strip()
  return trimmed


def fingerprint_key(value: str) -> str:
  normalized = strip_bearer_prefix(value)
  if not normalized:
    return ""
  return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def build_internal_endpoint_candidates(api_base: str, path: str) -> List[str]:
  """
  Build compatibility candidates for internal API routes.

  - Preferred: /api/internal/litellm/* (Nest global prefix).
  - Fallback: /internal/litellm/* (deployments without global prefix).
  """
  base = api_base.rstrip("/")
  normalized_path = path.lstrip("/")
  candidates: List[str] = []
  if base.endswith("/api"):
    candidates.append(f"{base}/internal/litellm/{normalized_path}")
    base_without_api = base[: -len("/api")]
    if base_without_api:
      candidates.append(f"{base_without_api}/internal/litellm/{normalized_path}")
  else:
    candidates.append(f"{base}/api/internal/litellm/{normalized_path}")
    candidates.append(f"{base}/internal/litellm/{normalized_path}")

  unique: List[str] = []
  seen = set()
  for candidate in candidates:
    if candidate in seen:
      continue
    seen.add(candidate)
    unique.append(candidate)
  return unique


def fetch_openai_keys_from_api() -> List[str]:
  api_base = os.environ.get("LITELLM_CONFIG_API_BASE", "").strip()
  token = os.environ.get("LITELLM_CONFIG_INTERNAL_TOKEN", "").strip()
  if not api_base or not token:
    return []

  urls = build_internal_endpoint_candidates(api_base, "openai-keys")
  headers = {"Authorization": f"Bearer {token}"}

  # Best-effort retry loop (API might still be starting up).
  for attempt in range(12):
    for url in urls:
      try:
        req = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=5) as resp:
          body = resp.read().decode("utf-8")
        data = json.loads(body)
        return normalize_key_list(data.get("openaiApiKeys"))
      except Exception:
        continue
    if attempt >= 11:
      return []
    time.sleep(2)

  return []


def fetch_proxy_load_balancing_snapshot_from_api() -> Optional[Dict[str, Any]]:
  api_base = os.environ.get("LITELLM_CONFIG_API_BASE", "").strip()
  token = os.environ.get("LITELLM_CONFIG_INTERNAL_TOKEN", "").strip()
  if not api_base or not token:
    return None

  urls = build_internal_endpoint_candidates(api_base, "proxy-load-balancing")
  headers = {"Authorization": f"Bearer {token}"}

  for attempt in range(12):
    for url in urls:
      try:
        req = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=5) as resp:
          body = resp.read().decode("utf-8")
        data = json.loads(body)
        if not isinstance(data, dict):
          continue

        has_stored_config = bool(data.get("hasStoredConfig"))
        enabled = bool(data.get("enabled")) if has_stored_config else False
        openai_keys = normalize_key_list(data.get("openaiApiKeys"))
        anthropic_keys = normalize_key_list(data.get("anthropicApiKeys"))
        routing_strategy = data.get("routingStrategy")
        if not isinstance(routing_strategy, str) or not routing_strategy.strip():
          routing_strategy = "simple-shuffle"
        redis_host = data.get("redisHost")
        if not isinstance(redis_host, str) or not redis_host.strip():
          redis_host = "redis"
        redis_port = parse_port_any(data.get("redisPort")) or 6379
        redis_password = data.get("redisPassword")
        if not isinstance(redis_password, str):
          redis_password = ""
        deployment_rpm = parse_positive_int_any(data.get("deploymentRpm"))
        deployment_tpm = parse_positive_int_any(data.get("deploymentTpm"))

        return {
          "hasStoredConfig": has_stored_config,
          "enabled": enabled,
          "openaiApiKeys": openai_keys,
          "anthropicApiKeys": anthropic_keys,
          "routingStrategy": routing_strategy.strip(),
          "redisHost": redis_host.strip(),
          "redisPort": redis_port,
          "redisPassword": redis_password.strip(),
          "deploymentRpm": deployment_rpm,
          "deploymentTpm": deployment_tpm,
        }
      except Exception:
        continue
    if attempt >= 11:
      return None
    time.sleep(2)

  return None


def build_api_key_overrides() -> Dict[str, List[str]]:
  overrides: Dict[str, List[str]] = {}
  openai_keys = fetch_openai_keys_from_api()
  if openai_keys:
    overrides["OPENAI_API_KEY"] = openai_keys
  return overrides


def resolve_effective_openai_keys(api_key_overrides: Dict[str, List[str]]) -> List[str]:
  keys = api_key_overrides.get("OPENAI_API_KEY")
  if keys:
    return [strip_bearer_prefix(k) for k in keys if strip_bearer_prefix(k)]

  keys = parse_csv(os.environ.get("OPENAI_API_KEYS", ""))
  if keys:
    return [strip_bearer_prefix(k) for k in keys if strip_bearer_prefix(k)]

  single = strip_bearer_prefix(os.environ.get("OPENAI_API_KEY", ""))
  if single:
    return [single]

  return []


def report_applied_openai_key_fingerprints(source: str, fingerprints: List[str]) -> None:
  api_base = os.environ.get("LITELLM_CONFIG_API_BASE", "").strip()
  token = os.environ.get("LITELLM_CONFIG_INTERNAL_TOKEN", "").strip()
  if not api_base or not token:
    return

  urls = build_internal_endpoint_candidates(api_base, "openai-keys/applied")
  payload = json.dumps({"source": source, "keyFingerprints": fingerprints}).encode("utf-8")
  headers = {
    "Authorization": f"Bearer {token}",
    "Content-Type": "application/json",
  }

  for attempt in range(6):
    for url in urls:
      try:
        req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=5) as resp:
          resp.read()
        return
      except Exception:
        continue
    if attempt >= 5:
      return
    time.sleep(2)


def expand_model_entry(
  entry: Dict[str, Any],
  default_rpm: Optional[int],
  default_tpm: Optional[int],
  api_key_overrides: Dict[str, List[str]],
  allow_env_plural_fallback: bool = True,
) -> Tuple[List[Dict[str, Any]], bool]:
  params = entry.get("litellm_params")
  if not isinstance(params, dict):
    return [entry], False

  api_key = params.get("api_key")
  if not (isinstance(api_key, str) and api_key.startswith("os.environ/")):
    return [entry], False

  env_var = api_key[len("os.environ/") :]
  keys = api_key_overrides.get(env_var)
  if keys is None and allow_env_plural_fallback:
    plural_env = infer_plural_key_env(env_var)
    keys = parse_csv(os.environ.get(plural_env, ""))
  if not keys:
    return [entry], False

  if len(keys) == 1:
    next_entry = deepcopy(entry)
    next_params = next_entry.get("litellm_params")
    if not isinstance(next_params, dict):
      next_params = {}
    next_params["api_key"] = keys[0]
    if default_rpm is not None and "rpm" not in next_params:
      next_params["rpm"] = default_rpm
    if default_tpm is not None and "tpm" not in next_params:
      next_params["tpm"] = default_tpm
    next_entry["litellm_params"] = next_params
    return [next_entry], False

  expanded: List[Dict[str, Any]] = []
  for key in keys:
    next_entry = deepcopy(entry)
    next_params = next_entry.get("litellm_params")
    if not isinstance(next_params, dict):
      next_params = {}
    next_params["api_key"] = key
    if default_rpm is not None and "rpm" not in next_params:
      next_params["rpm"] = default_rpm
    if default_tpm is not None and "tpm" not in next_params:
      next_params["tpm"] = default_tpm
    next_entry["litellm_params"] = next_params
    expanded.append(next_entry)
  return expanded, True


def expand_guardrails(
  guardrails: Any,
  api_key_overrides: Dict[str, List[str]],
  allow_env_plural_fallback: bool = True,
) -> Tuple[List[Dict[str, Any]], bool]:
  if not isinstance(guardrails, list):
    return [], False

  expanded_any = False
  out: List[Dict[str, Any]] = []

  for entry in guardrails:
    if not isinstance(entry, dict):
      continue

    guardrail_name = entry.get("guardrail_name")
    params = entry.get("litellm_params")
    if not (isinstance(guardrail_name, str) and guardrail_name.strip()):
      out.append(entry)
      continue
    if not isinstance(params, dict):
      out.append(entry)
      continue

    api_key = params.get("api_key")
    if not (isinstance(api_key, str) and api_key.startswith("os.environ/")):
      out.append(entry)
      continue

    env_var = api_key[len("os.environ/") :]
    keys = api_key_overrides.get(env_var)
    if keys is None and allow_env_plural_fallback:
      plural_env = infer_plural_key_env(env_var)
      keys = parse_csv(os.environ.get(plural_env, ""))

    if not keys:
      out.append(entry)
      continue

    for index, key in enumerate(keys):
      next_entry = deepcopy(entry)
      next_params = next_entry.get("litellm_params")
      if not isinstance(next_params, dict):
        next_params = {}
      next_params["api_key"] = key
      next_entry["litellm_params"] = next_params
      if index > 0:
        next_entry["guardrail_name"] = f"{guardrail_name}-{index + 1}"
      out.append(next_entry)

    expanded_any = expanded_any or len(keys) > 1

  return out, expanded_any


def build_router_settings(
  enabled: bool,
  strategy_override: Optional[str] = None,
  redis_host_override: Optional[str] = None,
  redis_port_override: Optional[int] = None,
  redis_password_override: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
  if not enabled:
    return None

  strategy = (
    strategy_override.strip()
    if isinstance(strategy_override, str)
    else os.environ.get("LITELLM_ROUTING_STRATEGY", "").strip()
  ) or "simple-shuffle"
  router: Dict[str, Any] = {"routing_strategy": strategy}

  redis_host = (
    redis_host_override.strip()
    if isinstance(redis_host_override, str)
    else os.environ.get("LITELLM_REDIS_HOST", "").strip()
  )
  if redis_host:
    router["redis_host"] = redis_host
    redis_port = (
      redis_port_override
      if isinstance(redis_port_override, int) and redis_port_override > 0
      else parse_positive_int(os.environ.get("LITELLM_REDIS_PORT", "6379")) or 6379
    )
    router["redis_port"] = redis_port
    redis_password = (
      redis_password_override.strip()
      if isinstance(redis_password_override, str)
      else os.environ.get("LITELLM_REDIS_PASSWORD", "").strip()
    )
    if redis_password:
      router["redis_password"] = redis_password

  return router


def main() -> None:
  parser = argparse.ArgumentParser(
    description="Generate LiteLLM Proxy YAML config with optional multi-deployment load balancing."
  )
  parser.add_argument("--input", required=True, help="Path to base config YAML (read-only).")
  parser.add_argument("--output", required=True, help="Path to write generated config YAML.")
  args = parser.parse_args()

  with open(args.input, "r", encoding="utf-8") as f:
    base_cfg = yaml.safe_load(f) or {}

  model_list = base_cfg.get("model_list")
  if not isinstance(model_list, list):
    model_list = []

  proxy_lb_snapshot = fetch_proxy_load_balancing_snapshot_from_api()

  api_key_overrides: Dict[str, List[str]] = {}
  default_rpm: Optional[int] = None
  default_tpm: Optional[int] = None
  strict_db_mode = proxy_lb_snapshot is not None
  proxy_lb_enabled = False
  allow_env_plural_fallback = True
  openai_key_source = "none"
  router_settings: Optional[Dict[str, Any]] = None

  if proxy_lb_snapshot is not None:
    allow_env_plural_fallback = False
    has_stored_config = bool(proxy_lb_snapshot.get("hasStoredConfig"))
    proxy_lb_enabled = bool(proxy_lb_snapshot.get("enabled")) if has_stored_config else False
    db_openai_keys = normalize_key_list(proxy_lb_snapshot.get("openaiApiKeys"))
    db_anthropic_keys = normalize_key_list(proxy_lb_snapshot.get("anthropicApiKeys"))

    if proxy_lb_enabled:
      if db_openai_keys:
        api_key_overrides["OPENAI_API_KEY"] = db_openai_keys
      if db_anthropic_keys:
        api_key_overrides["ANTHROPIC_API_KEY"] = db_anthropic_keys
      default_rpm = parse_positive_int_any(proxy_lb_snapshot.get("deploymentRpm"))
      default_tpm = parse_positive_int_any(proxy_lb_snapshot.get("deploymentTpm"))
      router_settings = build_router_settings(
        True,
        str(proxy_lb_snapshot.get("routingStrategy", "simple-shuffle")),
        str(proxy_lb_snapshot.get("redisHost", "redis")),
        parse_port_any(proxy_lb_snapshot.get("redisPort")) or 6379,
        str(proxy_lb_snapshot.get("redisPassword", "")),
      )
    else:
      # Strict DB mode: when LB is disabled (or config absent), keep runtime single-key
      # behavior for base model/guardrails but do not enable multi-deployment expansion.
      if db_openai_keys:
        api_key_overrides["OPENAI_API_KEY"] = [db_openai_keys[0]]
      if db_anthropic_keys:
        api_key_overrides["ANTHROPIC_API_KEY"] = [db_anthropic_keys[0]]

    if db_openai_keys:
      openai_key_source = "db"
  else:
    # Backward-compatible fallback when internal settings endpoint is unavailable.
    api_key_overrides = build_api_key_overrides()
    default_rpm = parse_positive_int(os.environ.get("LITELLM_DEPLOYMENT_RPM", ""))
    default_tpm = parse_positive_int(os.environ.get("LITELLM_DEPLOYMENT_TPM", ""))
    if api_key_overrides.get("OPENAI_API_KEY"):
      openai_key_source = "db"

  effective_openai_keys = resolve_effective_openai_keys(api_key_overrides)
  if openai_key_source == "none" and effective_openai_keys:
    openai_key_source = "env"
  openai_key_fingerprints: List[str] = []
  seen_fingerprints = set()
  for key in effective_openai_keys:
    fp = fingerprint_key(key)
    if not fp or fp in seen_fingerprints:
      continue
    seen_fingerprints.add(fp)
    openai_key_fingerprints.append(fp)

  expanded_any = False
  expanded_model_list: List[Dict[str, Any]] = []
  for entry in model_list:
    if not isinstance(entry, dict):
      continue
    expanded, did_expand = expand_model_entry(
      entry,
      default_rpm,
      default_tpm,
      api_key_overrides,
      allow_env_plural_fallback=allow_env_plural_fallback,
    )
    expanded_model_list.extend(expanded)
    expanded_any = expanded_any or did_expand

  out_cfg: Dict[str, Any] = deepcopy(base_cfg)
  out_cfg["model_list"] = expanded_model_list

  guardrails_cfg = base_cfg.get("guardrails")
  assistant_guardrails_enabled = parse_env_bool(
    os.environ.get("ASSISTANT_GUARDRAILS_ENABLED"),
    default=True,
  )
  guardrails_allowed = assistant_guardrails_enabled and bool(effective_openai_keys)
  if guardrails_cfg is not None and guardrails_allowed:
    expanded_guardrails, did_expand_guardrails = expand_guardrails(
      guardrails_cfg,
      api_key_overrides,
      allow_env_plural_fallback=allow_env_plural_fallback,
    )
    if expanded_guardrails:
      out_cfg["guardrails"] = expanded_guardrails
      expanded_any = expanded_any or did_expand_guardrails
  else:
    out_cfg.pop("guardrails", None)

  if strict_db_mode:
    router_enabled = proxy_lb_enabled and expanded_any
    if router_enabled and router_settings is None:
      router_settings = build_router_settings(True)
    if not router_enabled:
      router_settings = None
  else:
    router_enabled = expanded_any or bool(os.environ.get("LITELLM_REDIS_HOST")) or bool(
      os.environ.get("LITELLM_ROUTING_STRATEGY")
    )
    router_settings = build_router_settings(router_enabled)
  if router_settings is not None:
    out_cfg["router_settings"] = router_settings

  with open(args.output, "w", encoding="utf-8") as f:
    yaml.safe_dump(out_cfg, f, sort_keys=False)

  report_applied_openai_key_fingerprints(openai_key_source, openai_key_fingerprints)


if __name__ == "__main__":
  main()
