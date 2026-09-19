const express = require("express");
const Database = require("better-sqlite3");
const db = new Database("data/monitor.db");
const cron = require("node-cron");

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

db.exec(`
  CREATE TABLE IF NOT EXISTS known_paths (
    service TEXT,
    path TEXT,
    UNIQUE(service, path)
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

app.post("/register-service", (req, res) => {
  const { service, paths } = req.body;

  if (!service || !Array.isArray(paths)) {
    return res.status(400).json({ error: "service and paths[] required" });
  }

  const insert = db.prepare(`INSERT OR IGNORE INTO known_paths (service, path) VALUES (?, ?)`);
  paths.forEach(p => insert.run(service, p));

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
      SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) as errors5xx,
      SUM(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 ELSE 0 END) as errors4xx
    FROM requests
    GROUP BY service, path
  `).all();

  const knownPathsList = db.prepare(`SELECT service, path FROM known_paths`).all();

  function isPathKnown(service, path) {
    return knownPathsList.some(kp => {
      if (kp.service !== service) return false;
      if (kp.path === path) return true;
      if (kp.path.endsWith("/*")) {
        const prefix = kp.path.slice(0, -2);
        return path.startsWith(prefix + "/");
      }
      return false;
    });
  }

  const endpointStats = endpoints.map((ep) => {
    const epDurations = db
      .prepare("SELECT duration_ms FROM requests WHERE path = ? AND service IS ? ORDER BY duration_ms ASC")
      .all(ep.path, ep.service)
      .map((row) => row.duration_ms);

    const isKnown = isPathKnown(ep.service, ep.path);

    return {
      service: ep.service,
      path: ep.path,
      total: ep.total,
      errors4xx: ep.errors4xx,
      errors5xx: ep.errors5xx,
      errorRate: (((ep.errors4xx + ep.errors5xx) / ep.total) * 100).toFixed(2) + "%",
      p50: percentile(epDurations, 50),
      p95: percentile(epDurations, 95),
      known: isKnown,
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

function cleanupUnknown() {
  const cutoff = Date.now() - (2 * 24 * 60 * 60 * 1000); // 2 days ago

  const knownPathsList = db.prepare(`SELECT service, path FROM known_paths`).all();

  function isPathKnown(service, path) {
    return knownPathsList.some(kp => {
      if (kp.service !== service) return false;
      if (kp.path === path) return true;
      if (kp.path.endsWith("/*")) {
        const prefix = kp.path.slice(0, -2);
        return path.startsWith(prefix + "/");
      }
      return false;
    });
  }

  const allRows = db.prepare("SELECT id, service, path, timestamp FROM requests WHERE timestamp < ?").all(cutoff);

  let deleted = 0;
  const del = db.prepare("DELETE FROM requests WHERE id = ?");
  allRows.forEach(row => {
    if (!isPathKnown(row.service, row.path)) {
      del.run(row.id);
      deleted++;
    }
  });

  console.log(`[cleanup] Deleted ${deleted} old unknown rows.`);
  return deleted;
}

app.post("/cleanup-unknown", (req, res) => {
  const deleted = cleanupUnknown();
  res.json({ deleted });
});

app.get("/dashboard", (req, res) => {
  res.sendFile(__dirname + "/public/dashboard.html");
});

cron.schedule("0 3 * * *", () => {
  console.log("[cleanup] Running scheduled unknown-path cleanup...");
  cleanupUnknown();
});

app.listen(3000, () => {
  console.log("API running on http://localhost:3000");
});
