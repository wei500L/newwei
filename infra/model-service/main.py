import os
import time
from typing import Any, Dict, List, Literal, Optional, Tuple

import numpy as np
import pandas as pd
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from scipy.stats import norm
from statsmodels.tsa.holtwinters import ExponentialSmoothing
from statsmodels.tsa.statespace.sarimax import SARIMAX


class SeriesPoint(BaseModel):
    timestamp: str
    value: float


class ModelSpec(BaseModel):
    kind: Literal["arima", "ets"] = "arima"
    order: Optional[Tuple[int, int, int]] = None
    seasonal_order: Optional[Tuple[int, int, int, int]] = None
    seasonal_period: Optional[int] = None
    trend: Optional[str] = None


class ForecastHoldoutLastRequest(BaseModel):
    series: List[SeriesPoint] = Field(min_length=3)
    confidence_level: float = Field(default=0.95, ge=0.5, lt=1.0)
    model: ModelSpec = Field(default_factory=ModelSpec)
    request_id: Optional[str] = None


class ForecastPoint(BaseModel):
    timestamp: str
    expected: float
    lower: float
    upper: float
    sigma: float


class ForecastHoldoutLastResponse(BaseModel):
    model: ModelSpec
    forecast: ForecastPoint
    diagnostics: Dict[str, Any]


app = FastAPI()


def _require_internal_token(x_internal_token: Optional[str]) -> None:
    configured = os.environ.get("MODEL_SERVICE_INTERNAL_TOKEN", "").strip()
    if not configured:
        return
    if not x_internal_token or x_internal_token.strip() != configured:
        raise HTTPException(status_code=401, detail="Unauthorized")


def _to_series(points: List[SeriesPoint]) -> List[SeriesPoint]:
    cleaned: List[SeriesPoint] = []
    for point in points:
        value = float(point.value)
        if not np.isfinite(value):
            continue
        cleaned.append(point)

    if not cleaned:
        raise HTTPException(status_code=422, detail="Series is empty after filtering invalid values")

    def key(p: SeriesPoint) -> pd.Timestamp:
        parsed = pd.to_datetime(p.timestamp, errors="coerce", utc=True)
        if pd.isna(parsed):
            raise HTTPException(status_code=422, detail=f"Invalid timestamp: {p.timestamp}")
        return parsed

    cleaned.sort(key=key)
    return cleaned


def _z_for_confidence(confidence_level: float) -> float:
    return float(norm.ppf(0.5 + confidence_level / 2.0))


@app.get("/healthz")
def healthz() -> Dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/forecast/holdout_last", response_model=ForecastHoldoutLastResponse)
def forecast_holdout_last(
    request: ForecastHoldoutLastRequest, x_internal_token: Optional[str] = Header(default=None)
) -> ForecastHoldoutLastResponse:
    _require_internal_token(x_internal_token)
    start_ms = time.time_ns() // 1_000_000

    series = _to_series(request.series)
    if len(series) < 3:
        raise HTTPException(status_code=422, detail="Series too short")

    timestamps = [p.timestamp for p in series]
    values = np.asarray([float(p.value) for p in series], dtype=np.float64)
    target_timestamp = timestamps[-1]

    train = values[:-1]
    if request.model.kind == "arima" and len(train) < 20:
        raise HTTPException(status_code=422, detail="ARIMA requires at least 20 training points")
    if request.model.kind == "ets" and len(train) < 10:
        raise HTTPException(status_code=422, detail="ETS requires at least 10 training points")

    confidence_level = float(request.confidence_level)
    alpha = 1.0 - confidence_level
    z = _z_for_confidence(confidence_level)

    try:
        if request.model.kind == "arima":
            order = request.model.order or (1, 1, 1)
            seasonal_order = request.model.seasonal_order
            if seasonal_order is None:
                if request.model.seasonal_period and request.model.seasonal_period > 1:
                    seasonal_order = (1, 0, 1, int(request.model.seasonal_period))
                else:
                    seasonal_order = (0, 0, 0, 0)
            trend = request.model.trend or "c"
            model = SARIMAX(
                train,
                order=order,
                seasonal_order=seasonal_order,
                trend=trend,
                enforce_stationarity=False,
                enforce_invertibility=False,
            )
            fit = model.fit(disp=False)
            pred = fit.get_forecast(steps=1)
            frame = pred.summary_frame(alpha=alpha)
            expected = float(frame["mean"].iloc[0])
            lower = float(frame["mean_ci_lower"].iloc[0])
            upper = float(frame["mean_ci_upper"].iloc[0])
            mean_se = float(frame["mean_se"].iloc[0]) if "mean_se" in frame else float("nan")
            sigma = mean_se if np.isfinite(mean_se) and mean_se > 0 else float("nan")
            if not np.isfinite(sigma) or sigma <= 0:
                sigma = float(max(1e-12, (upper - lower) / (2.0 * z))) if z > 0 else float("nan")
            if not np.isfinite(sigma) or sigma <= 0:
                resid = getattr(fit, "resid", None)
                resid_std = float(np.std(resid, ddof=1)) if resid is not None and len(resid) > 1 else float("nan")
                sigma = resid_std if np.isfinite(resid_std) and resid_std > 0 else 1.0
            diagnostics: Dict[str, Any] = {
                "n_total": int(len(values)),
                "n_train": int(len(train)),
                "order": list(order),
                "seasonal_order": list(seasonal_order),
                "trend": trend,
            }
        else:
            seasonal_period = int(request.model.seasonal_period) if request.model.seasonal_period else 0
            use_seasonal = seasonal_period > 1 and len(train) >= max(2 * seasonal_period, 10)
            seasonal = "add" if use_seasonal else None
            trend = request.model.trend or "add"
            model = ExponentialSmoothing(
                train,
                trend=trend,
                seasonal=seasonal,
                seasonal_periods=seasonal_period if use_seasonal else None,
            )
            fit = model.fit(optimized=True)
            expected = float(fit.forecast(1)[0])
            resid = getattr(fit, "resid", None)
            resid_std = float(np.std(resid, ddof=1)) if resid is not None and len(resid) > 1 else float("nan")
            sigma = resid_std if np.isfinite(resid_std) and resid_std > 0 else 1.0
            lower = float(expected - z * sigma) if z > 0 else expected
            upper = float(expected + z * sigma) if z > 0 else expected
            diagnostics = {
                "n_total": int(len(values)),
                "n_train": int(len(train)),
                "seasonal_period": seasonal_period if use_seasonal else 0,
                "trend": trend,
                "seasonal": seasonal or "none",
            }

        end_ms = time.time_ns() // 1_000_000
        diagnostics.update(
            {
                "fit_ms": int(end_ms - start_ms),
                "confidence_level": confidence_level,
                "request_id": request.request_id,
            }
        )

        return ForecastHoldoutLastResponse(
            model=request.model,
            forecast=ForecastPoint(
                timestamp=target_timestamp, expected=expected, lower=lower, upper=upper, sigma=float(sigma)
            ),
            diagnostics=diagnostics,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Forecast failed: {exc}") from exc

