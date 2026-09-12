const Database = require('better-sqlite3');
const db = new Database('data/monitor.db');

const total = db.prepare('SELECT COUNT(*) as count FROM requests').get().count;
const errors5xx = db.prepare('SELECT COUNT(*) as count FROM requests WHERE status_code >= 500').get().count;
const errors4xx = db.prepare('SELECT COUNT(*) as count FROM requests WHERE status_code >= 400 AND status_code < 500').get().count;
const durations = db.prepare('SELECT duration_ms FROM requests ORDER BY duration_ms ASC').all().map(row => row.duration_ms);

function percentile(sortedArr, p) {
  const index = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[index];
}

console.log('Total requests:', total);
console.log('4xx:', errors4xx);
console.log('5xx:', errors5xx);
console.log('Error rate:', ((errors5xx / total) * 100).toFixed(2) + '%');
console.log('P50:', percentile(durations, 50), 'ms');
console.log('P95:', percentile(durations, 95), 'ms');
console.log('P99:', percentile(durations, 99), 'ms');
