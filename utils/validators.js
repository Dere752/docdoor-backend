// ═══ Shared validators ═══

/**
 * Validate a Turkish national ID number (TC Kimlik No) using its
 * official checksum algorithm.
 *
 * Rules:
 *  - exactly 11 digits, first digit is not 0
 *  - 10th digit  = ((d1+d3+d5+d7+d9)*7 - (d2+d4+d6+d8)) mod 10
 *  - 11th digit  = (sum of first 10 digits) mod 10
 *
 * @param {string} tc
 * @returns {boolean}
 */
function validateTCKimlik(tc) {
  if (!tc || tc.length !== 11 || tc[0] === '0') return false;
  const d = tc.split('').map(Number);
  if (d.some(x => isNaN(x))) return false;
  const c10 = ((d[0] + d[2] + d[4] + d[6] + d[8]) * 7 - (d[1] + d[3] + d[5] + d[7])) % 10;
  if (((c10 % 10) + 10) % 10 !== d[9]) return false;
  if (d.slice(0, 10).reduce((a, b) => a + b, 0) % 10 !== d[10]) return false;
  return true;
}

module.exports = { validateTCKimlik };
