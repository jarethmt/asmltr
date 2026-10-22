#pragma once
#include <stdint.h>
#include <stddef.h>
// asmltr Portal module loader. See module.c / PORTAL-PROTOCOL.md.
void module_init(void);
// Feed one `load` chunk ([flags][rsvd][seqBE(2)][data]) — called on the NimBLE host task; stays light.
// Returns a status line to notify, or NULL mid-transfer. On the LAST chunk it signals the engine task.
const char *module_load_chunk(const uint8_t *data, size_t len);
// Verify the assembled envelope's signature and stage it — runs on the ENGINE task (heavy crypto).
const char *module_finalize(void);
// `run` trigger — execute the staged (verified) module.
const char *module_run_staged(void);
