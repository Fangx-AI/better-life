import { createHash } from 'node:crypto';

const DAY = 86400000;
const day = time => new Date(time).toISOString().slice(0, 10);

// Only committed financial facts are read here; no operation writes orders,
// payment events or entitlements. The caller isolates failures from payment ACKs.
// Durable state contains only high-entropy order hashes and integer checkpoints,
// never accounts, checkout URLs, credentials, question or answer bodies.
export function createPaymentAnalytics({ db, store, enabled = false, now = Date.now, batchSize = 100, minScanIntervalMs = 5000 } = {}) {
  if (!db?.prepare || !db?.exec || !store?.recordServer || typeof now !== 'function') throw new Error('支付统计需要已准备的本站数据库与统计存储。');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000 || !Number.isInteger(minScanIntervalMs) || minScanIntervalMs < 0 || minScanIntervalMs > 3600000) throw new Error('支付统计补偿批次配置无效。');
  const retentionDays = store.retentionDays ?? 90;
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 366) throw new Error('支付统计保留天数无效。');
  db.exec(`CREATE TABLE IF NOT EXISTS analytics_payment_dedup(event_hash TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS analytics_payment_scan(id INTEGER PRIMARY KEY CHECK(id=1),cursor_rowid INTEGER NOT NULL,cycle_high_water INTEGER NOT NULL,last_scan_at INTEGER);
    INSERT OR IGNORE INTO analytics_payment_scan(id,cursor_rowid,cycle_high_water,last_scan_at) VALUES(1,0,0,NULL);`);

  function eligible(order) {
    const time = now();
    return order && ['paid', 'refunded'].includes(order.status) && ['member-month', 'member-year'].includes(order.plan_id) &&
      typeof order.id === 'string' && Number.isSafeInteger(order.paid_at) && order.paid_at >= 0 && order.paid_at <= time &&
      day(order.paid_at) >= day(time - (retentionDays - 1) * DAY);
  }
  function recordMetadata(order) {
    if (!eligible(order)) return false;
    const key = createHash('sha256').update(`better-life:paid:${order.id}`).digest('hex');
    db.exec('BEGIN IMMEDIATE');
    try {
      const inserted = db.prepare('INSERT OR IGNORE INTO analytics_payment_dedup(event_hash) VALUES(?)').run(key).changes;
      if (inserted && store.recordServer('payment_confirmed', { plan: order.plan_id }, order.paid_at) !== true) throw new Error('支付统计未接收，稍后安全补偿。');
      db.exec('COMMIT'); return Boolean(inserted);
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function record(order) {
    if (!enabled || typeof order?.id !== 'string') return false;
    // The callback object is only an ID hint: forged/noncommitted status, plan or
    // timestamps cannot create analytics. Never read the financial/private body.
    return recordMetadata(db.prepare('SELECT id,plan_id,paid_at,status FROM orders WHERE id=?').get(order.id));
  }
  record.reconcile = () => {
    const result = { enabled: Boolean(enabled), scanned: 0, recorded: 0, skipped: 0, failed: 0, complete: false, throttled: false };
    if (!enabled) return result;
    const time = now(), checkpoint = db.prepare('SELECT cursor_rowid,cycle_high_water,last_scan_at FROM analytics_payment_scan WHERE id=1').get();
    if (checkpoint.last_scan_at !== null && time >= checkpoint.last_scan_at && time - checkpoint.last_scan_at < minScanIntervalMs) return { ...result, throttled: true };
    let cursor = checkpoint.cursor_rowid, highWater = checkpoint.cycle_high_water;
    if (cursor >= highWater) {
      cursor = 0;
      highWater = db.prepare('SELECT COALESCE(MAX(rowid),0) AS value FROM orders').get().value;
    }
    // Freeze the cycle's high-water mark. Continuous new orders cannot postpone
    // revisiting an old pending row that became paid after it was first scanned.
    db.prepare('UPDATE analytics_payment_scan SET cursor_rowid=?,cycle_high_water=?,last_scan_at=? WHERE id=1').run(cursor, highWater, time);
    const rows = db.prepare('SELECT rowid AS scan_rowid,id,plan_id,paid_at,status FROM orders WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?').all(cursor, highWater, batchSize);
    for (const row of rows) {
      result.scanned++;
      try { if (recordMetadata(row)) result.recorded++; else result.skipped++; }
      catch { result.failed++; break; } // Retry this row next time; never stamp a failed aggregate.
      cursor = row.scan_rowid;
      db.prepare('UPDATE analytics_payment_scan SET cursor_rowid=? WHERE id=1').run(cursor);
    }
    if (!result.failed && rows.length < batchSize) {
      cursor = highWater; // Also finish cycles with deleted/gapped rowids.
      db.prepare('UPDATE analytics_payment_scan SET cursor_rowid=? WHERE id=1').run(cursor);
    }
    result.complete = cursor >= highWater;
    return result;
  };
  return record;
}
