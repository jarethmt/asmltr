/* asmltr Portal — olm mesh bring-up. Reads provisioned config from NVS and (if present) joins
 * the mesh as a first-class olm client. No-op when unprovisioned. */
#pragma once
void portal_olm_start(void);
