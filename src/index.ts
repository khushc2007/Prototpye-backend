import express, { Request, Response } from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
app.use(cors());
app.use(express.json());

/* ===============================
   TYPES
================================ */
type SensorReading = {
  ph: number;
  turbidity: number;
  tds: number;
  timestamp: number;
};

type PumpId = "A" | "B" | "C";

type PumpState = {
  [K in PumpId]: boolean;
};

/* ===============================
   STATE
================================ */
let latestReading: SensorReading | null = null;

let pumpState: PumpState = {
  A: false,
  B: false,
  C: false,
};

// Pending command for ESP32 to poll
let pendingPumpCommand: { pump: PumpId; on: boolean } | null = null;

/* ===============================
   HTTP SERVER + WEBSOCKET
================================ */
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(data: object) {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

wss.on("connection", (ws) => {
  // Send current state immediately on connect
  ws.send(JSON.stringify({
    type: "init",
    reading: latestReading,
    pumps: pumpState,
  }));
});

/* ===============================
   ROUTES
================================ */
app.get("/", (_req, res) => {
  res.send("Water IQ — lightweight prototype backend");
});

// ── ESP32 pushes sensor data here ──
app.post("/ingest", (req: Request, res: Response) => {
  const { ph, turbidity, tds } = req.body;

  if (typeof ph !== "number" || typeof turbidity !== "number" || typeof tds !== "number") {
    return res.status(400).json({ error: "Invalid sensor data. Expecting: ph, turbidity, tds as numbers." });
  }

  latestReading = { ph, turbidity, tds, timestamp: Date.now() };

  // Push to all connected frontend clients
  broadcast({ type: "reading", reading: latestReading });

  res.json({ status: "ok" });
});

// ── Frontend fetches latest reading (fallback for non-WS clients) ──
app.get("/reading", (_req, res) => {
  if (!latestReading) return res.status(404).json({ error: "No reading yet" });
  res.json(latestReading);
});

// ── Frontend sends pump command ──
app.post("/pump/:id", (req: Request, res: Response) => {
  const pump = req.params.id.toUpperCase() as PumpId;
  const { on } = req.body;

  if (!["A", "B", "C"].includes(pump)) {
    return res.status(400).json({ error: "Invalid pump. Use A, B, or C." });
  }
  if (typeof on !== "boolean") {
    return res.status(400).json({ error: "Missing 'on' boolean in body." });
  }

  pumpState[pump] = on;
  pendingPumpCommand = { pump, on };

  // Push updated pump state to all frontend clients
  broadcast({ type: "pumps", pumps: pumpState });

  res.json({ status: "ok", pump, on });
});

// ── Frontend fetches current pump states ──
app.get("/pumps", (_req, res) => {
  res.json(pumpState);
});

// ── ESP32 polls this to receive pump commands ──
app.get("/pump/command", (_req, res) => {
  if (!pendingPumpCommand) return res.json({ command: null });
  const cmd = pendingPumpCommand;
  pendingPumpCommand = null; // clear after delivery
  res.json({ command: cmd });
});

/* ===============================
   SERVER
================================ */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Water IQ backend running on port ${PORT}`);
});
