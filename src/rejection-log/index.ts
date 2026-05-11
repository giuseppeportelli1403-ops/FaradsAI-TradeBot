// src/rejection-log/ — categorised rejection logging across all 4 layers
// (scanner, analyst, executor, post-approval). One taxonomy, one writer,
// one daily digest.

export {
  REJECTION_CATEGORIES,
  type RejectionCategory,
  type RejectionLayer,
  isFailClosed,
} from './categories.js';
export { recordRejection, type RecordRejectionInput } from './record.js';
export { buildDailyDigest, type DigestPayload } from './digest.js';
