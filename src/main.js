'use strict';

const { resolveOutcome, reachesChannel } = require('./outcomes.js');
const { parsePullRequest, collectChanges } = require('./changes.js');
const { deployMessage, releaseNotesMessage } = require('./messages.js');
const { createGitHub } = require('./github.js');
const { createSlack } = require('./slack.js');

function input(name) {
  return (process.env[`INPUT_${name.toUpperCase()}`] || '').trim();
}

// A warning never fails a deploy. In a dry run it fails the step, so CI
// notices a lookup that stopped working.
function warn(message) {
  console.log(`::warning::${message}`);
  if (input('dry_run') === 'true') process.exitCode = 1;
}

// Context makes the message richer but is never worth losing the message.
async function optional(what, read) {
  try {
    return await read();
  } catch (error) {
    warn(`Could not read ${what}: ${error.message}`);
    return null;
  }
}

async function run() {
  const env = process.env;
  const dryRun = input('dry_run') === 'true';
  const token = input('slack_token');
  const channel = input('channel');
  if (!dryRun && !(token && channel)) {
    warn('slack_token or channel is empty, skipping Slack notification');
    return;
  }

  const environment = input('environment').toLowerCase();
  const exitCode = input('exit_code');
  const outcome = resolveOutcome({ status: input('status'), exitCode, exitCodes: input('exit_codes') });
  if (!outcome) {
    warn(`Unknown status "${input('status')}", pass job.status`);
    return;
  }
  if (!reachesChannel(outcome, environment)) {
    console.log(`No Slack message for "${outcome.name}" on "${environment}".`);
    return;
  }

  const repo = env.GITHUB_REPOSITORY;
  const sha = env.GITHUB_SHA;
  const repoUrl = `${env.GITHUB_SERVER_URL}/${repo}`;
  const github = createGitHub({ apiUrl: env.GITHUB_API_URL, token: input('github_token'), repo });
  const post = createSlack({ token, channel, dryRun });

  const headMessage = await optional('the deployed commit', () => github.commitMessage(sha));

  const threadTs = await post(
    deployMessage({
      outcome,
      app: input('app'),
      environment,
      version: input('version'),
      repoUrl,
      sha,
      pullRequest: headMessage && parsePullRequest(headMessage),
      actor: env.GITHUB_ACTOR,
      runUrl: `${repoUrl}/actions/runs/${env.GITHUB_RUN_ID}`,
      exitCode,
    }),
  );
  console.log(`Slack message sent for "${outcome.name}" on "${environment}".`);
  if (!outcome.releaseNotes || input('release_notes') === 'false') return;

  const baseSha = await optional('the previous deploy', () =>
    github.previousDeploySha(
      {
        id: env.GITHUB_RUN_ID,
        attempt: env.GITHUB_RUN_ATTEMPT,
        number: Number(env.GITHUB_RUN_NUMBER),
        runnerName: env.RUNNER_NAME,
        // owner/repo/.github/workflows/deploy.yml@refs/heads/main
        workflowFile: env.GITHUB_WORKFLOW_REF.split('@')[0].split('/').pop(),
        branch: env.GITHUB_REF_NAME,
      },
      sha,
    ),
  );
  const commits = baseSha && (await optional('the commits since the previous deploy', () => github.commitsBetween(baseSha, sha)));
  if (!commits) return;

  const changes = collectChanges(commits, sha);
  await post(releaseNotesMessage({ changes, repoUrl, baseSha, headSha: sha }), threadTs);
  console.log(`Release notes sent: ${changes.length} changes since ${baseSha.slice(0, 7)}.`);
}

// A failed notification must never turn a deploy red.
run().catch((error) => warn(`Slack notification failed: ${error.message}`));
