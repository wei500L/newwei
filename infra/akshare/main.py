from __future__ import annotations

import datetime as dt
import inspect
import math
from typing import Any

import akshare as ak
import pandas as pd
import numpy as np
from fastapi import FastAPI, HTTPException, Request

app = FastAPI(title="Akshare Gateway", version="0.1.0")


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


def _coerce_value(value: Any) -> Any:
    if not isinstance(value, str):
        return value

    lowered = value.lower()
    if lowered == "null":
        return None
    if lowered == "true":
        return True
    if lowered == "false":
        return False

    return value


def _sanitize_for_json(value: Any) -> Any:
    if value is None:
        return None

    if isinstance(value, (str, bool, int)):
        return value

    if isinstance(value, (float, np.floating)):
        as_float = float(value)
        return as_float if math.isfinite(as_float) else None

    if isinstance(value, np.integer):
        return int(value)

    if isinstance(value, np.bool_):
        return bool(value)

    try:
        is_na = pd.isna(value)
        if isinstance(is_na, (bool, np.bool_)) and is_na:
            return None
    except Exception:
        pass

    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()

    if isinstance(value, (pd.Timestamp, pd.Timedelta)):
        try:
            return value.isoformat()
        except Exception:
            return str(value)

    if isinstance(value, np.datetime64):
        try:
            return pd.to_datetime(value).isoformat()
        except Exception:
            return str(value)

    if isinstance(value, pd.DataFrame):
        records = value.to_dict(orient="records")
        return [_sanitize_for_json(record) for record in records]

    if isinstance(value, pd.Series):
        data = value.to_dict()
        return _sanitize_for_json(data)

    if isinstance(value, dict):
        return {str(k): _sanitize_for_json(v) for k, v in value.items()}

    if isinstance(value, (list, tuple, set)):
        return [_sanitize_for_json(v) for v in value]

    if hasattr(value, "tolist") and callable(value.tolist):
        try:
            return _sanitize_for_json(value.tolist())
        except Exception:
            pass

    if hasattr(value, "item") and callable(value.item):
        try:
            return _sanitize_for_json(value.item())
        except Exception:
            pass

    return str(value)


def _get_callable(name: str):
    if not name.isidentifier():
        raise HTTPException(status_code=400, detail="Invalid function name")

    if name.startswith("_"):
        raise HTTPException(status_code=400, detail="Invalid function name")

    fn = getattr(ak, name, None)
    if fn is None or not callable(fn):
        raise HTTPException(status_code=404, detail=f"Akshare function not found: {name}")

    return fn


def _split_params_by_signature(fn: Any, params: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    try:
        signature = inspect.signature(fn)
    except Exception:
        return params, {}

    parameters = signature.parameters.values()
    if any(param.kind == inspect.Parameter.VAR_KEYWORD for param in parameters):
        return params, {}

    allowed_kw = {
        param.name
        for param in parameters
        if param.kind in (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY)
    }
    kept = {k: v for k, v in params.items() if k in allowed_kw}
    extra = {k: v for k, v in params.items() if k not in allowed_kw}
    return kept, extra


def _filter_frame_by_first_matching_column(
    frame: pd.DataFrame, symbol: str, columns: tuple[str, ...]
) -> list[dict[str, Any]]:
    normalized = str(symbol).strip()
    if not normalized:
        return _sanitize_for_json(frame)

    for column in columns:
        if column in frame.columns:
            filtered = frame[frame[column].astype(str) == normalized]
            if not filtered.empty:
                return _sanitize_for_json(filtered)
    return []


def _apply_compat_params(function_name: str, params: dict[str, Any]) -> dict[str, Any]:
    if function_name == "futures_zh_spot":
        if "subscribe_list" in params and "symbol" not in params:
            params = {**params, "symbol": params["subscribe_list"]}
        params.pop("subscribe_list", None)

    if function_name == "stock_zh_a_spot_em":
        symbol = params.pop("symbol", None) or params.pop("code", None)
        if symbol is not None:
            params["__filter_symbol"] = symbol

    return params


def _filter_stock_spot_frame(frame: pd.DataFrame, symbol: str) -> list[dict[str, Any]]:
    normalized = str(symbol).upper().strip()
    normalized = normalized.removeprefix("SH").removeprefix("SZ").removeprefix("BJ")
    normalized = normalized.removeprefix("SHSE").removeprefix("SZSE")

    for column in ("代码", "code", "symbol", "股票代码"):
        if column in frame.columns:
            filtered = frame[frame[column].astype(str) == normalized]
            if not filtered.empty:
                return _sanitize_for_json(filtered)

    for column in ("代码", "code", "symbol", "股票代码"):
        if column in frame.columns:
            filtered = frame[frame[column].astype(str).str.contains(normalized, na=False)]
            if not filtered.empty:
                return _sanitize_for_json(filtered)

    return []


@app.api_route("/{function_name}", methods=["GET", "POST"])
async def call_function(function_name: str, request: Request):
    fn = _get_callable(function_name)

    params: dict[str, Any] = {k: _coerce_value(v) for k, v in dict(request.query_params).items()}
    if request.method == "POST":
        try:
            body = await request.json()
        except Exception:
            body = None
        if isinstance(body, dict):
            params.update({k: _coerce_value(v) for k, v in body.items()})

    try:
        params = _apply_compat_params(function_name, params)
        filter_symbol = params.pop("__filter_symbol", None)

        call_params, extra_params = _split_params_by_signature(fn, params)
        result = fn(**call_params)

        if isinstance(result, pd.DataFrame):
            filter_value = extra_params.get("symbol") or extra_params.get("pair")
            if filter_value:
                if function_name in ("fx_spot_quote", "fx_pair_quote"):
                    filtered = _filter_frame_by_first_matching_column(result, str(filter_value), ("货币对", "pair", "symbol"))
                    if filtered:
                        return filtered
                    raise HTTPException(status_code=404, detail=f"symbol not found: {filter_value}")
                if function_name == "crypto_js_spot":
                    filtered = _filter_frame_by_first_matching_column(result, str(filter_value), ("交易品种", "symbol"))
                    if filtered:
                        return filtered
                    raise HTTPException(status_code=404, detail=f"symbol not found: {filter_value}")

        if function_name == "stock_zh_a_spot_em" and filter_symbol:
            if not isinstance(result, pd.DataFrame):
                raise HTTPException(status_code=500, detail="stock_zh_a_spot_em returned non-DataFrame")
            filtered = _filter_stock_spot_frame(result, str(filter_symbol))
            if not filtered:
                raise HTTPException(status_code=404, detail=f"symbol not found: {filter_symbol}")
            return filtered
    except TypeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    try:
        return _sanitize_for_json(result)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Response serialization failed: {exc}") from exc
