const express = require("express");
const Database = require("better-sqlite3");
const db = new Database("data/monitor.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    method TEXT,
    path TEXT,
    status_code INTEGER,
    duration_ms INTEGER,
    timestamp INTEGER
  )
`);

try {
  db.exec(`ALTER TABLE requests ADD COLUMN service TEXT`);
} catch (e) {
  // column already exists, ignore
}

const app = express();
app.use(express.json());
app.use(express.static("public"));


const EXCLUDED_PATHS = ["/dashboard", "/stats", "/favicon.ico", "/dashboard.js", "/.well-known/appspecific/com.chrome.devtools.json"];

app.use((req, res, next) => {
  if (EXCLUDED_PATHS.includes(req.path)) {
    return next();
  }

  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    db.prepare(`
      INSERT INTO requests (method, path, status_code, duration_ms, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.method, req.path, res.statusCode, duration, Date.now());
  });

  next();
});

app.post("/collect", (req, res) => {
  const { method, path, status_code, duration_ms, service } = req.body;

  db.prepare(`
    INSERT INTO requests (method, path, status_code, duration_ms, timestamp, service)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(method, path, status_code, duration_ms, Date.now(), service);

  res.sendStatus(200);
});

app.get("/stats", (req, res) => {
  const total = db
    .prepare("SELECT COUNT(*) as count FROM requests")
    .get().count;
  const errors5xx = db
    .prepare("SELECT COUNT(*) as count FROM requests WHERE status_code >= 500")
    .get().count;
  const errors4xx = db
    .prepare(
      "SELECT COUNT(*) as count FROM requests WHERE status_code >= 400 AND status_code < 500",
    )
    .get().count;
  const durations = db
    .prepare("SELECT duration_ms FROM requests ORDER BY duration_ms ASC")
    .all()
    .map((row) => row.duration_ms);

  const p50 = percentile(durations, 50);
  const p95 = percentile(durations, 95);
  const p99 = percentile(durations, 99);

  function percentile(sortedArr, p) {
    if (sortedArr.length === 0) return 0;
    const index = Math.ceil((p / 100) * sortedArr.length) - 1;
    return sortedArr[index];
  }

  const endpoints = db.prepare(`
    SELECT
      service,
      path,
      COUNT(*) as total,
      SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) as errors5xx
    FROM requests
    GROUP BY service, path
  `).all();

  const endpointStats = endpoints.map((ep) => {
    const epDurations = db
      .prepare("SELECT duration_ms FROM requests WHERE path = ? AND service IS ? ORDER BY duration_ms ASC")
      .all(ep.path, ep.service)
      .map((row) => row.duration_ms);

    return {
      service: ep.service,
      path: ep.path,
      total: ep.total,
      errors5xx: ep.errors5xx,
      errorRate: ((ep.errors5xx / ep.total) * 100).toFixed(2) + "%",
      p50: percentile(epDurations, 50),
      p95: percentile(epDurations, 95),
    };
  });

  res.json({
    total,
    errors4xx,
    errors5xx,
    errorRate: total > 0 ? ((errors5xx / total) * 100).toFixed(2) + "%" : "0%",
    p50,
    p95,
    p99,
    endpoints: endpointStats,
  });
});

app.get("/dashboard", (req, res) => {
  res.sendFile(__dirname + "/public/dashboard.html");
});

app.listen(3000, () => {
  console.log("API running on http://localhost:3000");
});
