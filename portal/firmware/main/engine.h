#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
// asmltr Portal loader engine. See engine.c / PORTAL-PROTOCOL.md. The engine task owns both the
// heavy signature-verify (finalize) and step-DSL execution (run) — neither runs on the BLE task.
void engine_init(void);                               // create the engine task + command queue
bool engine_stage(const uint8_t *json, size_t len);   // copy a verified module (NUL-terminated); true if it fits
void engine_request_finalize(void);                   // enqueue: verify + stage the assembled envelope
const char *engine_run_staged(void);                  // enqueue: execute the staged module
void engine_submit_exec(uint8_t mode, const uint8_t *data, int len); // enqueue a driver command (1=HID script, 2=CDC)
bool engine_is_busy(void);
