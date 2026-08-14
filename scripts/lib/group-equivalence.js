'use strict';

const crypto = require('crypto');
const { stableStringify } = require('./pack-content-fingerprint');

// Per ADR 0005 + issue 017 grill consensus: group equivalence is relaxed from
// "all observable textures' full-fingerprint concatenation hash" to a STATIC rule:
// the set of evidence surfaces is fixed (the three anchor surfaces that SBI always
// uses for hash-based instant matching) and the canonical observable representation
// per surface is the perceptual dhash (integer, no floating-point noise).
//
// Two packs are in the same group iff their diamond_sword / ender_pearl / splash_potion
// dhashes all match. Differences only in food / widget / HUD surfaces no longer split
// groups (those surfaces are secondary, not "the surfaces actually used by the query").
//
// This is deliberately not per-query: the surface set and the per-surface canonical key
// are fixed and untuned, satisfying the grill's "static rule" constraint.

const OBSERVABLE_GROUP_SURFACES = ['diamond_sword', 'ender_pearl', 'splash_potion'];

function surfaceDhash(packData, key) {
  const surf = packData[key];
  if (!surf || typeof surf.dhash !== 'string') return null;
  return surf.dhash;
}

function computeGroupKey(packData) {
  const record = {};
  for (const key of OBSERVABLE_GROUP_SURFACES) {
    record[key] = surfaceDhash(packData, key);
  }
  const digest = crypto.createHash('sha256').update(stableStringify(record)).digest('hex');
  return `g:${digest}`;
}

module.exports = {
  OBSERVABLE_GROUP_SURFACES,
  surfaceDhash,
  computeGroupKey,
};
