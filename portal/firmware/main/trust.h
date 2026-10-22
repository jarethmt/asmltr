#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
// asmltr Portal trust anchor (pairing). See trust.c / PORTAL-PROTOCOL.md.
void trust_init(void);                              // load the paired anchor from NVS
bool trust_is_paired(void);
const uint8_t *trust_anchor(void);                  // 32-byte Ed25519 pubkey (valid when paired)
void trust_fingerprint_hex(char *out, size_t n);    // first 4 bytes as hex (8 chars + NUL); "" if unpaired
bool trust_pair(const uint8_t *key, size_t len);    // TOFU pair (32B key); 32 zero bytes = un-pair
