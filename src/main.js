'use strict';

const lib = require('./lib.js');

const MAX_COMPARE_PAGES = 40; // 100 commits each
const MAX_BASELINE_CANDIDATES = 15;

function input(name) {
  return (process.env[`INPUT_${name.toUpperCase()}`] || '').trim();
}

function warn(message) {
  console.log(`::warning::${message}`);
}

function createGitHub({ apiUrl, token }) {
  return async function github(path) {
    const response = await fetch(`${apiUrl}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'deploy-notify',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`GitHub ${path} answered ${response.status}`);
    return response.json();
  };
}

async function postToSlack({ token, channel, message, threadTs, dryRun }) {
  const payload = {
    channel,
    ...message,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    unfurl_links: false,
    unfurl_media: false,
  };
  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return 'dry-run';
  }
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json();
  if (!body.ok) throw new Error(`Slack chat.postMessage failed: ${body.error}`);
  return body.ts;
}

// The job this step runs in, found by its runner. Gives the job's display
// name (to find the same job in earlier runs) and the step that failed.
async function findCurrentJob(github, { repo, runId, attempt, runnerName }) {
  const { jobs } = await github(`/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`);
  const running = jobs.filter((job) => job.status === 'in_progress');
  return running.find((job) => job.runner_name === runnerName) || (running.length === 1 ? running[0] : null);
}

// The commit of the last run in which this same job succeeded, on this branch.
// Matching the job (not the run) keeps other targets of a shared workflow,
// such as a demo deploy from main, out of the baseline.
async function findPreviousDeploySha(github, { repo, workflowFile, branch, runNumber, sha, jobName }) {
  const { workflow_runs: runs } = await github(
    `/repos/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=${MAX_BASELINE_CANDIDATES}`,
  );
  for (const run of runs) {
    // Earlier runs only: a deploy queued behind this one may already be listed.
    if (run.run_number >= runNumber || run.head_sha === sha) continue;
    if (!jobName) {
      if (run.conclusion === 'success') return run.head_sha;
      continue;
    }
    const { jobs } = await github(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
    if (jobs.some((job) => job.name === jobName && job.conclusion === 'success')) return run.head_sha;
  }
  return null;
}

async function fetchCommitRange(github, { repo, baseSha, headSha }) {
  const commits = [];
  for (let page = 1; page <= MAX_COMPARE_PAGES; page += 1) {
    const data = await github(`/repos/${repo}/compare/${baseSha}...${headSha}?per_page=100&page=${page}`);
    commits.push(...data.commits);
    if (data.commits.length < 100 || commits.length >= data.total_commits) break;
  }
  return commits;
}

async function run() {
  const env = process.env;
  const dryRun = input('dry_run') === 'true';
  const token = input('slack_token');
  const channel = input('channel');
  if (!dryRun && (!token || !channel)) {
    warn('slack_token or channel is empty, skipping Slack notification');
    return;
  }

  const repo = env.GITHUB_REPOSITORY;
  const sha = env.GITHUB_SHA;
  const repoUrl = `${env.GITHUB_SERVER_URL}/${repo}`;
  const runUrl = `${repoUrl}/actions/runs/${env.GITHUB_RUN_ID}`;
  const post = (message, threadTs) => postToSlack({ token, channel, message, threadTs, dryRun });

  const message = input('message');
  if (message) {
    await post(lib.customMessage({ message, runUrl }));
    return;
  }

  const environment = input('environment').toLowerCase();
  const exitCode = input('exit_code');
  const outcome = lib.resolveOutcome({ status: input('status'), exitCode, exitCodes: input('exit_codes') });
  if (!lib.shouldNotify({ outcome, environment })) {
    console.log(`No Slack message for outcome "${outcome}" on "${environment}".`);
    return;
  }

  const github = createGitHub({ apiUrl: env.GITHUB_API_URL, token: input('github_token') });
  const attempt = async (label, task) => {
    try {
      return await task();
    } catch (error) {
      warn(`${label}: ${error.message}`);
      return null;
    }
  };

  const job = await attempt('Could not read the current job', () =>
    findCurrentJob(github, { repo, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT || '1', runnerName: env.RUNNER_NAME }),
  );
  const headCommit = await attempt('Could not read the deployed commit', () => github(`/repos/${repo}/commits/${sha}`));
  const pullRequest = headCommit ? lib.parsePullRequest(headCommit.commit.message) : null;
  const failedStep = job && job.steps ? (job.steps.find((step) => step.conclusion === 'failure') || {}).name : null;

  const ts = await post(
    lib.deployMessage({
      outcome,
      app: input('app'),
      environment,
      version: input('version'),
      repoUrl,
      sha,
      pullRequest,
      actor: env.GITHUB_ACTOR,
      runUrl,
      failedStep,
      exitCode: exitCode && exitCode !== '0' ? exitCode : '',
    }),
  );
  console.log(`Slack message sent (${ts}).`);
  if (outcome !== 'success') return;

  // Release notes go into the thread, so the channel stays one line per deploy.
  const workflowFile = /\/\.github\/workflows\/([^@]+)@/.exec(env.GITHUB_WORKFLOW_REF || '');
  const baseSha =
    input('previous_sha') ||
    (workflowFile &&
      (await attempt('Could not find the previous deploy', () =>
        findPreviousDeploySha(github, {
          repo,
          workflowFile: workflowFile[1],
          branch: env.GITHUB_REF_NAME,
          runNumber: Number(env.GITHUB_RUN_NUMBER),
          sha,
          jobName: job ? job.name : null,
        }),
      )));
  if (!baseSha) {
    warn('No previous successful deploy found, skipping release notes');
    return;
  }
  const commits = await attempt('Could not read the commit range', () => fetchCommitRange(github, { repo, baseSha, headSha: sha }));
  if (!commits) return;
  const changes = lib.collectChanges(commits, sha);
  await post(lib.releaseNotesMessage({ changes, repoUrl, baseSha, headSha: sha }), ts);
  console.log(`Release notes sent (${changes.length} changes since ${baseSha.slice(0, 7)}).`);
}

// Best effort: a failed notification must never turn a deploy red.
run().catch((error) => warn(`Slack notification failed (non-critical): ${error.message}`));
