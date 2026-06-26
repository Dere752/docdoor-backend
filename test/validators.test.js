const { test } = require('node:test');
const assert = require('node:assert');
const { validateTCKimlik } = require('../utils/validators');

test('validateTCKimlik accepts valid national IDs', () => {
  // Numbers that satisfy the official TC Kimlik checksum.
  assert.strictEqual(validateTCKimlik('10000000146'), true);
  assert.strictEqual(validateTCKimlik('11111111110'), true);
});

test('validateTCKimlik rejects a number with a wrong checksum', () => {
  assert.strictEqual(validateTCKimlik('12345678901'), false);
});

test('validateTCKimlik rejects an ID starting with 0', () => {
  assert.strictEqual(validateTCKimlik('00000000000'), false);
});

test('validateTCKimlik rejects wrong-length input', () => {
  assert.strictEqual(validateTCKimlik('123'), false);
  assert.strictEqual(validateTCKimlik('123456789012'), false);
});

test('validateTCKimlik rejects non-numeric input', () => {
  assert.strictEqual(validateTCKimlik('1234567890a'), false);
});

test('validateTCKimlik rejects empty / nullish input', () => {
  assert.strictEqual(validateTCKimlik(''), false);
  assert.strictEqual(validateTCKimlik(null), false);
  assert.strictEqual(validateTCKimlik(undefined), false);
});
