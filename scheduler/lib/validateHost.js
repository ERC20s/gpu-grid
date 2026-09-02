// Validation and normalisation for host reports posted to POST /hosts.
//
// The matcher (lib/matcher.js) silently drops any host whose vram_mb is not a
// number, so a report that stores fine can still be invisible to every match.
// validateHost() rejects those reports at ingest instead, and coerces numeric
// strings ("40960") so existing host agents keep working.

const REQUIRED_STRINGS = ['id', 'model'];
const REQUIRED_NUMBERS = ['vram_mb', 'timestamp'];
const OPTIONAL_NUMBERS = ['gpu_util_pct', 'free_memory_mb'];

function fail(field, message) {
  return { ok: false, field, message };
}

// Accepts a finite number, or a string that is entirely a finite number.
// Returns undefined when the value cannot be read as a number.
function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function validateHost(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('body', 'expected a host object');
  }

  // Preserve any extra fields the agent sends; only the known ones are normalised.
  const host = Object.assign({}, raw);

  for (const key of REQUIRED_STRINGS) {
    const value = raw[key];
    if (value === undefined || value === null) return fail(key, `missing ${key}`);
    if (typeof value !== 'string') return fail(key, `${key} must be a string`);
    const trimmed = value.trim();
    if (trimmed === '') return fail(key, `${key} must not be empty`);
    host[key] = trimmed;
  }

  for (const key of REQUIRED_NUMBERS) {
    const value = raw[key];
    if (value === undefined || value === null) return fail(key, `missing ${key}`);
    const n = toFiniteNumber(value);
    if (n === undefined) return fail(key, `${key} must be a finite number`);
    host[key] = n;
  }

  if (host.vram_mb < 0) return fail('vram_mb', 'vram_mb must not be negative');

  for (const key of OPTIONAL_NUMBERS) {
    const value = raw[key];
    if (value === undefined || value === null) {
      delete host[key];
      continue;
    }
    const n = toFiniteNumber(value);
    if (n === undefined) return fail(key, `${key} must be a finite number`);
    host[key] = n;
  }

  if (host.gpu_util_pct !== undefined && (host.gpu_util_pct < 0 || host.gpu_util_pct > 100)) {
    return fail('gpu_util_pct', 'gpu_util_pct must be between 0 and 100');
  }
  if (host.free_memory_mb !== undefined && host.free_memory_mb < 0) {
    return fail('free_memory_mb', 'free_memory_mb must not be negative');
  }

  return { ok: true, host };
}

module.exports = { validateHost };
