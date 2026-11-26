'use strict';

// What a deploy job can end as, and everything that follows from it.
// `everywhere: false` keeps the outcome out of the channel unless it happened
// on production: the channel wants production deploys and every failure.
// Release notes follow a deploy that went live.
const OUTCOMES = {
  success: { emoji: '🚀', phrase: ' deployed', everywhere: false, failed: false, releaseNotes: true },
  cancelled: { emoji: '🚫', phrase: ': Deploy abgebrochen', everywhere: false, failed: false },
  failure: { emoji: '❌', phrase: ': Deploy fehlgeschlagen', everywhere: true, failed: true },
  aborted: { emoji: '⚠️', phrase: ': Deploy vor dem Start abgebrochen', everywhere: true, failed: true },
  rolled_back: { emoji: '⚠️', phrase: ': Deploy fehlgeschlagen, zurückgerollt', everywhere: true, failed: true },
  rollback_failed: { emoji: '🚨', phrase: ': Deploy und Rollback fehlgeschlagen', everywhere: true, failed: true },
};

// Exit codes of moto's deploy-remote.sh. Read only when the caller opts in
// with exit_codes=deploy-remote; rsync, for one, uses 10 and 11 differently.
const DEPLOY_REMOTE_EXIT_CODES = { 1: 'aborted', 10: 'rolled_back', 11: 'rollback_failed' };

// `status` is GitHub's job.status: success, failure or cancelled. Anything
// else is a caller's mistake and has no outcome.
function resolveOutcome({ status, exitCode, exitCodes }) {
  const fromExitCode = exitCodes === 'deploy-remote' ? DEPLOY_REMOTE_EXIT_CODES[exitCode] : undefined;
  const name = status === 'failure' && fromExitCode ? fromExitCode : status;
  return Object.hasOwn(OUTCOMES, name) ? { name, ...OUTCOMES[name] } : null;
}

function reachesChannel(outcome, environment) {
  return outcome.everywhere || environment === 'production';
}

module.exports = { resolveOutcome, reachesChannel };
