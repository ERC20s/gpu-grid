// Request-body schemas for the scheduler. Every POST body is checked against
// one of these before anything is stored or matched: required fields, types,
// numeric ranges and maximum sizes (string lengths, array lengths). The whole
// body is additionally capped by MAX_REQUEST_SIZE_BYTES in index.js.
//
// A spec is {type, required, min, max} for numbers, {type, required,
// minLength, maxLength} for strings and {type, required, maxItems, items} for
// arrays. Fields a schema does not name are not checked here; host reports
// are trimmed to the named fields before they are stored (see pick()).

// Largest GPU memory figure accepted, in MB (1 TiB). Far above any card that
// exists, low enough that a made-up number cannot dominate ranking.
const MAX_MEMORY_MB = 1048576;
// Largest timestamp accepted: epoch milliseconds up to the year 2286. Seconds
// and milliseconds are both still accepted (see README, Ranking rule).
const MAX_TIMESTAMP = 1e13;
// Most entries accepted in one POST /hosts batch or one POST /match hosts array.
const MAX_HOSTS_PER_REQUEST = 1000;
// Most models a job may list in acceptable_gpu_models.
const MAX_ACCEPTABLE_MODELS = 64;

const HOST_SCHEMA = {
  id: {type: 'string', required: true, minLength: 1, maxLength: 256},
  model: {type: 'string', required: true, minLength: 1, maxLength: 128},
  vram_mb: {type: 'number', required: true, min: 0, max: MAX_MEMORY_MB},
  timestamp: {type: 'number', required: true, min: 0, max: MAX_TIMESTAMP},
  gpu_util_pct: {type: 'number', min: 0, max: 100},
  free_memory_mb: {type: 'number', min: 0, max: MAX_MEMORY_MB}
};

const JOB_SCHEMA = {
  required_min_vram_mb: {type: 'number', min: 0, max: MAX_MEMORY_MB},
  required_min_free_memory_mb: {type: 'number', min: 0, max: MAX_MEMORY_MB},
  max_util_pct: {type: 'number', min: 0, max: 100},
  acceptable_gpu_models: {
    type: 'array',
    maxItems: MAX_ACCEPTABLE_MODELS,
    items: {type: 'string', minLength: 1, maxLength: 128}
  }
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Check one value against one spec. Returns null or an error message.
function checkValue(value, spec, name) {
  if (spec.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max) {
      return `${name} must be a number between ${spec.min} and ${spec.max}`;
    }
    return null;
  }
  if (spec.type === 'string') {
    if (typeof value !== 'string' || value.length < spec.minLength || value.length > spec.maxLength) {
      return `${name} must be a string of ${spec.minLength}-${spec.maxLength} characters`;
    }
    return null;
  }
  if (spec.type === 'array') {
    if (!Array.isArray(value)) return `${name} must be an array`;
    if (value.length > spec.maxItems) return `${name} must have at most ${spec.maxItems} entries`;
    for (let i = 0; i < value.length; i++) {
      const err = checkValue(value[i], spec.items, `${name}[${i}]`);
      if (err) return err;
    }
    return null;
  }
  throw new Error(`unknown schema type ${spec.type}`);
}

// Check an object against a schema. prefix is prepended to field names in
// messages (e.g. "job."). Returns null or an error message.
function validateObject(obj, schema, prefix = '') {
  if (!isPlainObject(obj)) return 'expected object';
  for (const key of Object.keys(schema)) {
    const spec = schema[key];
    if (obj[key] === undefined) {
      if (spec.required) return `missing ${prefix}${key}`;
      continue;
    }
    const err = checkValue(obj[key], spec, prefix + key);
    if (err) return err;
  }
  return null;
}

// A copy of obj holding only the fields the schema names.
function pick(obj, schema) {
  const out = {};
  for (const key of Object.keys(schema)) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

module.exports = {
  HOST_SCHEMA,
  JOB_SCHEMA,
  MAX_MEMORY_MB,
  MAX_TIMESTAMP,
  MAX_HOSTS_PER_REQUEST,
  MAX_ACCEPTABLE_MODELS,
  isPlainObject,
  validateObject,
  pick
};
