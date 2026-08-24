'use strict';

function sendPolicyFromConfig(cfg) {
  return (cfg && cfg.approval_policy) || 'always_draft';
}

module.exports = { sendPolicyFromConfig };
