# Laya local inference server

This serves the **Laya** snake in the web app. It loads Laya once on the GPU and exposes a tiny HTTP API that the Node server proxies to.

## Requirements

- Python 3.10+
- an NVIDIA GPU (tested on RTX 3060 12 GB) with a recent driver
- PyTorch with CUDA, and the `laya` SDK

## Setup

```bash
python -m venv .venv
# Windows:
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cu126
.venv\Scripts\python.exe -m pip install numpy laya
```

## Run

```bash
# Windows:
set USE_TF=0 && .venv\Scripts\python.exe server.py
```

`USE_TF=0` avoids a TensorFlow/abseil deadlock in `transformers` (per the Laya model card). The server listens on `http://127.0.0.1:8000`.

The Node app calls it at `http://127.0.0.1:8000/predict` by default; override with `LAYA_URL` in the project `.env`.

## Endpoints

- `GET /health` -> `{ok, device}`
- `POST /predict` `{snake, food, direction, size}` -> `{ok, direction, confidence, latencyMs, usage, cost}` (usage null, cost 0 — self-hosted is free)
