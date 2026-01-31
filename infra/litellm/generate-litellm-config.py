#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.request
from copy import deepcopy
from typing import Any, Dict, List, Optional, Tuple

import yaml


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


def fetch_openai_keys_from_api() -> List[str]:
  api_base = os.environ.get("LITELLM_CONFIG_API_BASE", "").strip()
  token = os.environ.get("LITELLM_CONFIG_INTERNAL_TOKEN", "").strip()
  if not api_base or not token:
    return []

  url = api_base.rstrip("/") + "/internal/litellm/openai-keys"
  headers = {"Authorization": f"Bearer {token}"}

  # Best-effort retry loop (API might still be starting up).
  for attempt in range(12):
    try:
      req = urllib.request.Request(url, headers=headers, method="GET")
      with urllib.request.urlopen(req, timeout=5) as resp:
        body = resp.read().decode("utf-8")
      data = json.loads(body)
      return normalize_key_list(data.get("openaiApiKeys"))
    except Exception:
      if attempt >= 11:
        return []
      time.sleep(2)

  return []


def build_api_key_overrides() -> Dict[str, List[str]]:
  overrides: Dict[str, List[str]] = {}
  openai_keys = fetch_openai_keys_from_api()
  if openai_keys:
    overrides["OPENAI_API_KEY"] = openai_keys
  return overrides


def expand_model_entry(
  entry: Dict[str, Any],
  default_rpm: Optional[int],
  default_tpm: Optional[int],
  api_key_overrides: Dict[str, List[str]],
) -> Tuple[List[Dict[str, Any]], bool]:
  params = entry.get("litellm_params")
  if not isinstance(params, dict):
    return [entry], False

  api_key = params.get("api_key")
  if not (isinstance(api_key, str) and api_key.startswith("os.environ/")):
    return [entry], False

  env_var = api_key[len("os.environ/") :]
  keys = api_key_overrides.get(env_var)
  if keys is None:
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
    if keys is None:
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


def build_router_settings(enabled: bool) -> Optional[Dict[str, Any]]:
  if not enabled:
    return None

  strategy = os.environ.get("LITELLM_ROUTING_STRATEGY", "").strip() or "simple-shuffle"
  router: Dict[str, Any] = {"routing_strategy": strategy}

  redis_host = os.environ.get("LITELLM_REDIS_HOST", "").strip()
  if redis_host:
    router["redis_host"] = redis_host
    redis_port = parse_positive_int(os.environ.get("LITELLM_REDIS_PORT", "6379")) or 6379
    router["redis_port"] = redis_port
    redis_password = os.environ.get("LITELLM_REDIS_PASSWORD", "").strip()
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

  api_key_overrides = build_api_key_overrides()

  default_rpm = parse_positive_int(os.environ.get("LITELLM_DEPLOYMENT_RPM", ""))
  default_tpm = parse_positive_int(os.environ.get("LITELLM_DEPLOYMENT_TPM", ""))

  expanded_any = False
  expanded_model_list: List[Dict[str, Any]] = []
  for entry in model_list:
    if not isinstance(entry, dict):
      continue
    expanded, did_expand = expand_model_entry(entry, default_rpm, default_tpm, api_key_overrides)
    expanded_model_list.extend(expanded)
    expanded_any = expanded_any or did_expand

  out_cfg: Dict[str, Any] = deepcopy(base_cfg)
  out_cfg["model_list"] = expanded_model_list

  guardrails_cfg = base_cfg.get("guardrails")
  if guardrails_cfg is not None:
    expanded_guardrails, did_expand_guardrails = expand_guardrails(guardrails_cfg, api_key_overrides)
    if expanded_guardrails:
      out_cfg["guardrails"] = expanded_guardrails
      expanded_any = expanded_any or did_expand_guardrails

  router_enabled = expanded_any or bool(os.environ.get("LITELLM_REDIS_HOST")) or bool(
    os.environ.get("LITELLM_ROUTING_STRATEGY")
  )
  router_settings = build_router_settings(router_enabled)
  if router_settings is not None:
    out_cfg["router_settings"] = router_settings

  with open(args.output, "w", encoding="utf-8") as f:
    yaml.safe_dump(out_cfg, f, sort_keys=False)


if __name__ == "__main__":
  main()
