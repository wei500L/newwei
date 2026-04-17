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

try:
    from bertopic import BERTopic
    from hdbscan import HDBSCAN
    from umap import UMAP
except Exception:  # pragma: no cover - import failures are surfaced at runtime.
    BERTopic = None
    HDBSCAN = None
    UMAP = None


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


class TopicClusteringDocument(BaseModel):
    id: str = Field(min_length=1)
    text: str = Field(min_length=1)
    embedding: List[float] = Field(min_length=2)


class TopicClusteringRequest(BaseModel):
    documents: List[TopicClusteringDocument] = Field(min_length=2)
    min_topic_size: int = Field(default=4, ge=2, le=100)
    request_id: Optional[str] = None


class TopicCluster(BaseModel):
    topic_id: int
    item_ids: List[str]
    representative_id: str
    keywords: List[str] = Field(default_factory=list)


class TopicClusteringResponse(BaseModel):
    clusters: List[TopicCluster]
    outlier_ids: List[str]
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


def _to_embedding_matrix(documents: List[TopicClusteringDocument]) -> np.ndarray:
    if not documents:
        raise HTTPException(status_code=422, detail="No documents supplied")
    dimensions = len(documents[0].embedding)
    if dimensions < 2:
        raise HTTPException(status_code=422, detail="Embedding dimension must be >= 2")
    matrix: List[List[float]] = []
    for document in documents:
        if len(document.embedding) != dimensions:
            raise HTTPException(status_code=422, detail="Embedding dimensions must match")
        row = [float(value) for value in document.embedding]
        if not np.isfinite(np.asarray(row, dtype=np.float32)).all():
            raise HTTPException(status_code=422, detail=f"Embedding contains invalid values for {document.id}")
        matrix.append(row)
    return np.asarray(matrix, dtype=np.float32)


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    denominator = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denominator <= 0:
        return 0.0
    return float(np.dot(a, b) / denominator)


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


@app.post("/v1/topic-model/bertopic/cluster", response_model=TopicClusteringResponse)
def cluster_topics(
    request: TopicClusteringRequest, x_internal_token: Optional[str] = Header(default=None)
) -> TopicClusteringResponse:
    _require_internal_token(x_internal_token)
    if BERTopic is None or HDBSCAN is None or UMAP is None:
        raise HTTPException(status_code=503, detail="BERTopic dependencies are unavailable")

    started_at_ms = time.time_ns() // 1_000_000
    documents = request.documents
    if len(documents) < 2:
        raise HTTPException(status_code=422, detail="At least two documents are required")

    try:
        texts = [document.text.strip() for document in documents]
        if any(not text for text in texts):
            raise HTTPException(status_code=422, detail="Document text cannot be empty")

        embeddings = _to_embedding_matrix(documents)
        min_topic_size = max(2, min(int(request.min_topic_size), len(documents)))
        min_cluster_size = max(2, min(min_topic_size, len(documents)))
        min_samples = max(1, min(5, min_cluster_size - 1))
        n_neighbors = max(2, min(10, len(documents) - 1))
        n_components = max(2, min(5, embeddings.shape[1] - 1, len(documents) - 1))

        topic_model = BERTopic(
            embedding_model=None,
            calculate_probabilities=False,
            low_memory=True,
            verbose=False,
            umap_model=UMAP(
                n_neighbors=n_neighbors,
                n_components=n_components,
                min_dist=0.0,
                metric="cosine",
                low_memory=True,
                random_state=42,
            ),
            hdbscan_model=HDBSCAN(
                min_cluster_size=min_cluster_size,
                min_samples=min_samples,
                metric="euclidean",
                prediction_data=False,
            ),
            min_topic_size=min_topic_size,
        )
        topic_ids, _ = topic_model.fit_transform(texts, embeddings=embeddings)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"BERTopic clustering failed: {exc}") from exc

    cluster_indexes: Dict[int, List[int]] = {}
    outlier_ids: List[str] = []
    for index, topic_id in enumerate(topic_ids):
        if int(topic_id) < 0:
            outlier_ids.append(documents[index].id)
            continue
        cluster_indexes.setdefault(int(topic_id), []).append(index)

    clusters: List[TopicCluster] = []
    for topic_id, member_indexes in sorted(
        cluster_indexes.items(), key=lambda entry: (-len(entry[1]), entry[0])
    ):
        member_ids = [documents[index].id for index in member_indexes]
        member_embeddings = embeddings[member_indexes]
        centroid = member_embeddings.mean(axis=0)
        best_index = member_indexes[0]
        best_score = -1.0
        for index in member_indexes:
            score = _cosine_similarity(embeddings[index], centroid)
            if score > best_score:
                best_score = score
                best_index = index

        keywords: List[str] = []
        raw_keywords = topic_model.get_topic(topic_id) or []
        for keyword, _score in raw_keywords[:5]:
            if isinstance(keyword, str) and keyword:
                keywords.append(keyword)

        clusters.append(
            TopicCluster(
                topic_id=topic_id,
                item_ids=member_ids,
                representative_id=documents[best_index].id,
                keywords=keywords,
            )
        )

    finished_at_ms = time.time_ns() // 1_000_000
    return TopicClusteringResponse(
        clusters=clusters,
        outlier_ids=outlier_ids,
        diagnostics={
            "document_count": len(documents),
            "cluster_count": len(clusters),
            "outlier_count": len(outlier_ids),
            "embedding_dimensions": int(embeddings.shape[1]),
            "min_topic_size": min_topic_size,
            "fit_ms": int(finished_at_ms - started_at_ms),
            "request_id": request.request_id,
        },
    )
