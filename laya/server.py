"""
Local Laya inference server (no extra deps — stdlib http.server).

Loads Laya once on the GPU (Router, preload=True, device=cuda) and exposes:
    POST /predict   {snake, food, direction, size} -> {ok, direction, confidence, latencyMs, usage, cost}
    GET  /health

Run:  set USE_TF=0 && .venv\\Scripts\\python.exe server.py
"""
import json
import time
import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

import laya
from laya import Router

PORT = int(__import__("os").environ.get("LAYA_PORT", "8000"))
DEVICE = __import__("os").environ.get("LAYA_DEVICE", "cuda")

print(f"[laya] loading checkpoints on {DEVICE} ...", flush=True)
ROUTER = Router(preload=True, device=DEVICE)
print("[laya] ready", flush=True)

DIRS = {"up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0)}
NAME = {v: k for k, v in DIRS.items()}


def legal_moves(snake, dx, dy, size):
    """Same logic as the Node server: non-reversing, non-fatal moves."""
    head = snake[0]
    body = set(snake[:-1])
    safe = []
    for name, (nx, ny) in DIRS.items():
        if nx == -dx and ny == -dy:
            continue  # never reverse into the neck
        x, y = head[0] + nx, head[1] + ny
        if x < 0 or y < 0 or x >= size or y >= size:
            continue  # wall
        if (x, y) in body:
            continue  # self
        safe.append(name)
    return safe


def build_grid(snake, food, size):
    rows = []
    for y in range(size):
        row = ""
        for x in range(size):
            if food == (x, y):
                row += "F"
            elif snake[0] == (x, y):
                row += "H"
            elif (x, y) in snake:
                row += "#"
            else:
                row += "."
        rows.append(row)
    return "\n".join(rows)


CRITERIA = {
    "up": "Move the head up one row (row index decreases)",
    "down": "Move the head down one row (row index increases)",
    "left": "Move the head left one column (column index decreases)",
    "right": "Move the head right one column (column index increases)",
}


def predict(body):
    snake = [(s["x"], s["y"]) for s in body["snake"]]
    food = (body["food"]["x"], body["food"]["y"])
    direction = body["direction"]
    size = body["size"]
    dx, dy = DIRS[direction]

    safe = legal_moves(snake, dx, dy, size)
    if len(safe) == 0:
        return {"ok": True, "doomed": True, "direction": NAME[(dx, dy)], "safeMoves": [], "usage": None, "cost": 0.0}
    if len(safe) == 1:
        return {"ok": True, "forced": True, "direction": safe[0], "safeMoves": safe,
                "usage": {"input_tokens": 0, "output_tokens": 0}, "cost": 0.0, "latencyMs": 0.0}

    grid = build_grid(snake, food, size)
    state = {
        "size": size,
        "direction": direction,
        "grid": grid,
        "legend": {".": "empty", "#": "snake body", "H": "snake head", "F": "food"},
    }
    questions = {
        "move": {
            "type": "choice",
            "instructions": (
                "You are playing Snake on a `size`x`size` grid. `grid` shows the board row by row: "
                "'.' is empty, '#' is the snake body, 'H' is the head, 'F' is the food. "
                "`direction` is the current heading. The options below are the only legal moves. "
                "Pick the one that best steers the head toward the food."
            ),
            "criteria": {n: CRITERIA[n] for n in safe},
        }
    }

    t0 = time.perf_counter()
    res = ROUTER.predict(state, questions)
    lat = (time.perf_counter() - t0) * 1000.0
    ans = res.get("answers", {}).get("move", {})
    choice = ans.get("choice")
    if choice not in safe:
        choice = safe[0]  # fallback to first legal move if the model picks something invalid
    return {
        "ok": True,
        "direction": choice,
        "confidence": ans.get("confidence"),
        "safeMoves": safe,
        "latencyMs": round(lat * 10) / 10,
        "usage": None,   # local model: no token billing
        "cost": 0.0,    # self-hosted -> free
        "routing": res.get("routing"),
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "device": DEVICE})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/predict":
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or "{}")
            self._send(200, predict(body))
        except Exception as e:
            self._send(500, {"ok": False, "error": str(e)})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, *a):
        pass  # quiet


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[laya] serving on http://127.0.0.1:{PORT}", flush=True)
    server.serve_forever()
