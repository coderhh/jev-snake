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
    hx, hy = snake[0]
    fx, fy = food
    state = (
        f"Snake on a {size}x{size} grid. Row 0 is the top; column 0 is the left.\n"
        f"Head H is at row {hy}, column {hx}. Current heading: {direction}.\n"
        f"Food F is at row {fy}, column {fx}.\n"
        f"Board ('.' empty, '#' body, 'H' head, 'F' food):\n{grid}\n"
        f"Pick the legal move that takes the head one step closer to the food."
    )
    questions = {
        "move": {
            "type": "choice",
            "instructions": (
                "You are playing Snake. `state` gives the head and food coordinates and the board. "
                "The options below are the only legal moves. Pick the one that moves the head "
                "one step closer to the food (reducing row or column distance to it)."
            ),
            "criteria": {n: CRITERIA[n] for n in safe},
        }
    }

    t0 = time.perf_counter()
    res = ROUTER.predict(state, questions)
    lat = (time.perf_counter() - t0) * 1000.0
    ans = res.get("answers", {}).get("move", {})
    laya_choice = ans.get("choice")

    # --- code steering assist ---
    # Laya's base checkpoint is poor at this spatial task and tends to hug walls.
    # Let Laya drive when its choice reduces distance to the food; otherwise fall
    # back to the safe move that minimizes distance (greedy), and flag it as an assist.
    head = snake[0]
    fx, fy = food

    def dist_after(name):
        dx, dy = DIRS[name]
        nx, ny = head[0] + dx, head[1] + dy
        return abs(nx - fx) + abs(ny - fy)

    best = min(safe, key=dist_after) if safe else None
    assist = False
    if laya_choice in safe and dist_after(laya_choice) <= dist_after(best):
        choice = laya_choice  # Laya is heading toward the food -> trust it
    else:
        choice = best  # code assist: steer toward the food
        assist = True

    return {
        "ok": True,
        "direction": choice,
        "confidence": ans.get("confidence"),
        "assist": assist,
        "safeMoves": safe,
        "latencyMs": round(lat * 10) / 10,
        "usage": None,   # local model: no token billing
        "cost": 0.0,    # self-hosted -> free
        "routing": res.get("routing"),
    }


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.1 + TCP_NODELAY avoids the ~40ms Nagle/delayed-ACK stall on small
    # JSON responses that otherwise dominates per-call latency.
    protocol_version = "HTTP/1.1"

    def setup(self):
        import socket as _socket
        self.request.setsockopt(_socket.IPPROTO_TCP, _socket.TCP_NODELAY, 1)
        super().setup()

    def _send(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        self.wfile.flush()

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
